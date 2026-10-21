// tabcap html <ref | --css selector> [--inner | --text | --attrs] [--max-chars 4000] (0.5-F)
// One element's markup: outerHTML (default), innerHTML, textContent, or its
// attributes as an object. Read in tabcap's isolated world (the page's own
// scripts never run, and cannot see the read); frame refs (`f2/e7`) read in
// their frame's document. The text is secret-scrubbed before it is cut, so a
// cut never leaves half a secret. Nothing is written to the bundle besides
// the daemon's usual `cmd` events.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { inWorld, rootDoc } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import { optBool, optNum, optStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { callResult, docIdentity, resolveRef, settle } from "../browser/doc.ts";

export const HTML_MAX_CHARS = 4000;
const MAX_ATTRS = 200;
/** Extra chars read past --max-chars so a secret straddling the cut is still replaced whole. */
const SCRUB_MARGIN = 1024;

type Mode = "outer" | "inner" | "text" | "attrs";

// `this` is the element. Returns {tag, total, value} or {tag, attrs, count}.
const READ_FN = `function (mode, max) {
  const el = this;
  const tag = el && el.nodeType === 1 ? el.localName : el ? String(el.nodeName).toLowerCase() : "?";
  if (mode === "attrs") {
    const attrs = {};
    const list = el && el.attributes ? Array.from(el.attributes) : [];
    for (const a of list.slice(0, ${MAX_ATTRS})) attrs[a.name] = String(a.value).slice(0, max);
    return { tag, attrs, count: list.length };
  }
  let full = "";
  if (mode === "text") full = el.textContent || "";
  else if (el.nodeType === 1) full = mode === "inner" ? el.innerHTML : el.outerHTML;
  else full = el.textContent || "";
  return { tag, total: full.length, value: full.slice(0, max) };
}`;

const CSS_FN = `function (sel, mode, max) {
  const l = document.querySelectorAll(sel);
  if (l.length === 0) return { matched: 0 };
  const r = (${READ_FN}).call(l[0], mode, max);
  r.matched = l.length;
  return r;
}`;

function modeOf(a: Args): Mode {
  const picked = ([
    ["inner", "inner"],
    ["text", "textContent"],
    ["attrs", "attrs"],
  ] as const)
    .filter(([, key]) => optBool(a, key))
    .map(([m]) => m);
  if (picked.length > 1) throw new TabcapError("usage", "give one of --inner, --text and --attrs", "e.g. tabcap html e12 --text");
  return picked[0] ?? "outer";
}

/** Scrub, then cut to `max` chars (never splitting a surrogate pair). */
function cutScrubbed(scrub: (s: string) => string, s: string, max: number): { text: string; cut: boolean } {
  const clean = scrub(s);
  if (clean.length <= max) return { text: clean, cut: false };
  let end = max;
  const c = clean.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { text: clean.slice(0, end), cut: true };
}

/** The page's answer (untrusted shape) → the envelope fields. */
export function htmlFields(v: unknown, mode: Mode, max: number, scrub: (s: string) => string): Record<string, unknown> {
  const r = isRecord(v) ? v : {};
  const tag = str(r, "tag") ?? "?";
  if (mode === "attrs") {
    const raw = isRecord(r["attrs"]) ? r["attrs"] : {};
    const attrs: Record<string, string> = {};
    let cut = false;
    for (const [k, x] of Object.entries(raw)) {
      if (typeof x !== "string") continue;
      const c = cutScrubbed(scrub, x, max);
      cut ||= c.cut;
      attrs[scrub(k)] = c.text;
    }
    const count = num(r, "count") ?? Object.keys(attrs).length;
    const truncated = cut || count > Object.keys(attrs).length;
    return {
      tag,
      mode,
      count,
      truncated,
      attrs,
      ...(truncated ? { note: `attribute values are cut at ${max} chars and at most ${MAX_ATTRS} attributes are listed; raise --max-chars, or use --outer` } : {}),
    };
  }
  const total = num(r, "total") ?? 0;
  const c = cutScrubbed(scrub, str(r, "value") ?? "", max);
  const truncated = c.cut || total > max + SCRUB_MARGIN;
  const key = mode === "text" ? "text" : "html";
  return {
    tag,
    mode,
    chars: total,
    truncated,
    [key]: c.text,
    ...(truncated ? { note: `cut at ${max} of ${total} chars; raise --max-chars (max 1000000), pick an inner element (\`snapshot --ref <ref> --depth 1\`), or use --text / --attrs` } : {}),
  };
}

export async function html(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = optStr(a, "ref");
  const css = optStr(a, "css");
  const hasRef = ref !== null && ref !== "";
  const hasCss = css !== null && css !== "";
  if (hasRef === hasCss) throw new TabcapError("usage", hasRef ? "give either a ref or --css, not both" : "missing ref or --css", "Usage: tabcap html <ref> or tabcap html --css <selector> [--inner | --text | --attrs] [--max-chars 4000]");
  const mode = modeOf(a);
  const max = Math.max(1, Math.min(Math.floor(optNum(a, "maxChars") ?? HTML_MAX_CHARS), 1_000_000));
  const scrub = (s: string) => d.secrets.scrub(s);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      await settle(tab, 10_000);
      if (hasRef && ref !== null) {
        const node = await resolveRef(t, tab, ref, { isolated: true });
        const r = await t.send("Runtime.callFunctionOn", { objectId: node.objectId, functionDeclaration: READ_FN, arguments: [{ value: mode }, { value: max + SCRUB_MARGIN }], returnByValue: true }, node.sessionId, 10_000);
        return { tab: tab.id, url: tab.url, ref, ...(node.frame === null ? {} : { frame: node.frame.path }), ...htmlFields(callResult(r), mode, max, scrub) };
      }
      const doc = await docIdentity(t, tab);
      const sel = css ?? "";
      const r = await inWorld(t, tab, rootDoc(tab, doc), (ctx) =>
        t.send("Runtime.callFunctionOn", { functionDeclaration: CSS_FN, executionContextId: ctx, arguments: [{ value: sel }, { value: mode }, { value: max + SCRUB_MARGIN }], returnByValue: true }, tab.sessionId, 10_000),
      );
      const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
      if (ex !== null) {
        const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
        const why = (str(exc, "description") ?? str(ex, "text") ?? "exception").split("\n")[0] ?? "";
        throw new TabcapError("usage", `--css ${sel.slice(0, 200)}: ${why.slice(0, 300)}`, "Give a CSS selector document.querySelectorAll accepts, e.g. --css 'table#t tr'.");
      }
      const v = callResult(r);
      const matched = isRecord(v) ? (num(v, "matched") ?? 0) : 0;
      if (matched === 0) throw new TabcapError("not-found", `no element matches ${sel.slice(0, 200)} in ${doc.url.slice(0, 300)}`, "Check the selector with `tabcap snapshot --css <selector>`; --css reads the root document (use a frame ref such as f2/e7 for an element in a frame).");
      return {
        tab: tab.id,
        url: doc.url,
        selector: sel,
        matched,
        ...htmlFields(v, mode, max, scrub),
        ...(matched > 1 ? { first: `the first of ${matched} matches; refine the selector or use a ref from \`snapshot --css\`` } : {}),
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
