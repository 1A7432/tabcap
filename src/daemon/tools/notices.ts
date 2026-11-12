// docs/04 §53.5 (11-12): what a page said while an action ran. Element UI's
// el-message (role=alert) is gone ~3 s later and form errors (no role) change
// before the next snapshot, so click / fill / type / press / select watch the
// root document from the start of the command until its wait ends: elements
// added (or shown by a style / class / hidden change) that are alerts, status
// or live-region content (`alert` / `status` / `live`), and other short new
// text (`text`, at most 120 chars, kept only when the command added at most 20
// such elements: a large page change is not a notice). Texts are captured when
// they appear (they may be gone by the end). Observe-only, in tabcap's
// isolated world; a part that cannot be set up is simply not watched.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { docIdentity } from "../browser/doc.ts";
import type { Tab } from "../browser/targets.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";

export type Notice = { kind: "alert" | "status" | "live" | "text"; text: string };

export const MAX_NOTICES = 10;
export const MAX_TEXT_NOTICES = 20;
export const NOTICE_TEXT_MAX = 120;

const GROUP = "tabcap-notices";

const WATCH_FN = `function (maxText) {
  const doc = document;
  const st = { seen: [], texts: 0 };
  const n = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const LIVE = "[role=alert], [role=status], [role=log], [aria-live]:not([aria-live=off])";
  const shown = (el) => { const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility !== "visible") return false; const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const kindOf = (el) => {
    const live = el.closest(LIVE);
    if (!live) return null;
    const role = live.getAttribute("role");
    return role === "alert" ? "alert" : role === "status" ? "status" : "live";
  };
  const look = (el) => {
    if (!el || el.nodeType !== 1 || el.closest("script, style, template, noscript")) return;
    const lives = [el, ...el.querySelectorAll(LIVE)].filter((x) => x.matches(LIVE) || x === el);
    let any = false;
    for (const x of lives) {
      const k = kindOf(x);
      if (k === null) continue;
      const cs = getComputedStyle(x);
      if (cs.display === "none") continue;
      const text = n(x.innerText || x.textContent);
      if (text !== "") { st.seen.push({ kind: k, text: text.slice(0, 300) }); any = true; }
    }
    if (any) return;
    if (!shown(el)) return;
    const text = n(el.innerText);
    if (text === "" || text.length > maxText) return;
    st.texts++;
    st.seen.push({ kind: "text", text });
  };
  st.obs = new MutationObserver((records) => {
    for (const r of records) {
      if (st.seen.length > 400) return;
      if (r.type === "childList") { for (const x of r.addedNodes) look(x.nodeType === 3 ? x.parentElement : x); }
      else if (r.type === "attributes") look(r.target);
      else if (r.type === "characterData" && r.target.parentElement && r.target.parentElement.closest(LIVE)) look(r.target.parentElement);
    }
  });
  st.obs.observe(doc.documentElement || doc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden"] });
  st.read = () => { st.obs.takeRecords(); st.obs.disconnect(); return { seen: st.seen, texts: st.texts }; };
  return st;
}`;

/** Pure: the notices of what the watch saw: live kinds always, `text` only when few; deduplicated, at most MAX_NOTICES. */
export function noticesOf(seen: readonly Notice[], textCount: number, scrub: (s: string) => string = (s) => s): Notice[] {
  const out: Notice[] = [];
  const keys = new Set<string>();
  const live = seen.filter((x) => x.kind !== "text");
  const texts = textCount <= MAX_TEXT_NOTICES ? seen.filter((x) => x.kind === "text") : [];
  for (const x of [...live, ...texts]) {
    const text = scrub(x.text.replace(/\s+/g, " ").trim()).slice(0, x.kind === "text" ? NOTICE_TEXT_MAX : 300);
    if (text === "") continue;
    // A text already reported as an alert / status is not repeated as text.
    if (x.kind === "text" && out.some((o) => o.text === text)) continue;
    const key = `${x.kind}\n${text}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({ kind: x.kind, text });
    if (out.length >= MAX_NOTICES) break;
  }
  return out;
}

const parseSeen = (v: unknown): { seen: Notice[]; texts: number } => {
  const r = isRecord(v) ? v : {};
  const seen = Array.isArray(r["seen"])
    ? r["seen"].filter(isRecord).flatMap((x): Notice[] => {
        const kind = x["kind"];
        const text = str(x, "text");
        return (kind === "alert" || kind === "status" || kind === "live" || kind === "text") && text !== null ? [{ kind, text }] : [];
      })
    : [];
  return { seen, texts: typeof r["texts"] === "number" ? r["texts"] : 0 };
};

export type NoticeWatch = { stop: () => Promise<Notice[]> };

/** Start watching the tab's root document; never throws (an unwatched command just has no notices). */
export async function watchNotices(d: Daemon, t: Transport, tab: Tab): Promise<NoticeWatch> {
  let doc: FrameDoc | null = null;
  let id: string | null = null;
  try {
    doc = rootDoc(tab, await docIdentity(t, tab));
    const fdoc = doc;
    id = await inWorld(t, tab, fdoc, async (ctx) => {
      const r = await t.send("Runtime.callFunctionOn", { functionDeclaration: WATCH_FN, executionContextId: ctx, arguments: [{ value: NOTICE_TEXT_MAX }], returnByValue: false, objectGroup: GROUP }, fdoc.sessionId, 5000);
      const res = isRecord(r["result"]) ? r["result"] : null;
      return res === null || isRecord(r["exceptionDetails"]) ? null : str(res, "objectId");
    });
  } catch (e) {
    log.info("notices: watch not set up", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
  }
  return {
    stop: async () => {
      if (id === null || doc === null) return [];
      const r = await t.send("Runtime.callFunctionOn", { objectId: id, functionDeclaration: "function () { return this.read(); }", returnByValue: true }, doc.sessionId, 3000).catch(() => null);
      await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, doc.sessionId, 3000).catch(() => undefined);
      // A navigation took the document (and the watch) away: nothing to report.
      const v = r !== null && isRecord(r["result"]) ? r["result"]["value"] : null;
      const { seen, texts } = parseSeen(v);
      return noticesOf(seen, texts, (s) => d.secrets.scrub(s));
    },
  };
}

/** Run an action with a notice watch around it: `notices` joins its answer when there are any. */
export async function withNotices<T extends Record<string, unknown>>(d: Daemon, t: Transport, tab: Tab, run: () => Promise<T>): Promise<T & { notices?: Notice[] }> {
  const w = await watchNotices(d, t, tab);
  let out: T;
  try {
    out = await run();
  } catch (e) {
    const n = await w.stop().catch((): Notice[] => []);
    // A refusal that carries the action's answer (select's not-selected) gets the notices too.
    if (n.length > 0 && e instanceof TabcapError && isRecord(e.extra["result"])) e.extra["result"] = { ...e.extra["result"], notices: n };
    throw e;
  }
  const notices = await w.stop();
  return notices.length > 0 ? { ...out, notices } : out;
}
