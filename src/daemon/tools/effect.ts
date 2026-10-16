// Click effect (0.6-D, docs/04 §17): after a default (DOM) `click`, did the
// page do anything? A DOM click (`el.click()`, isTrusted:false) on an element
// whose handler only reacts to trusted input "succeeds" without effect (a
// sidebar sub-menu, a table cell in the owner's real-project test, 10-16).
// From just before the click until the post-action wait ends, three things are
// watched, observe-only:
//   - DOM: a MutationObserver over the target's document, made in tabcap's
//     isolated world (the page cannot see or disturb it), plus the target's own
//     control state (checked / value / selectedIndex / open), which a click can
//     change without a DOM mutation;
//   - navigation: Page frame navigation events of the tab's session and of the
//     target's document's session (cross-document or same-document);
//   - request: Network.requestWillBeSent on those sessions. Without a recording
//     Network is switched on for the tab's session for the watch only (the
//     same ref-counted switch as `wait --idle`, tools/wait.ts);
//   - popup (0.6-R): a new page target whose opener is the clicked tab
//     (Target.targetCreated / attachedToTarget at the browser level; window.open,
//     target=_blank). Tabs registers it into the opener's session (reason
//     "popup"); the output names that tab.
// The output gets `effect` = "popup" when a popup opened (it outranks the
// others: the opener's own DOM change from the same handler is always seen
// first, and the new tab is what the caller must act on), else the first of
// the other three observed, or "none" with a `note` suggesting `--trusted`.
// The exit code never changes.

import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";
import { docIdentity } from "./snapshot.ts";
import { netOff, netOn } from "./wait.ts";

export type Effect = "none" | "dom" | "navigation" | "request" | "popup";

/** A page the click opened: the session's tab id (null: not registered in time) and its URL when known. */
export type PopupSeen = { at: number; tab: string | null; url: string | null };

/** When each kind of effect was first seen (ms, wall clock), or null; the first popup the click opened, or null. */
export type EffectSeen = { dom: number | null; navigation: number | null; request: number | null; popup: PopupSeen | null };

/** What classifyEffect adds to the click output. */
export type EffectFields = { effect: Effect; note?: string; popup?: { tab: string | null; url?: string } };

export const NO_EFFECT_NOTE =
  "the DOM click changed nothing within the post-action wait (no DOM mutation, no navigation, no request); the element may only react to trusted input: try `tabcap click <ref> --trusted`";

/** The note of a popup effect: where to go next (never --trusted: the click worked). */
export function popupNote(tab: string | null): string {
  return tab === null
    ? "the click opened a new tab (popup) that has not joined the session yet; run `tabcap tab list`, then use `--tab <id>` or `tabcap tab select <id>`"
    : `the click opened a new tab ${tab} (popup) in this session; the current tab is unchanged: use \`--tab ${tab}\` or \`tabcap tab select ${tab}\``;
}

/**
 * Pure: "popup" when the click opened a page (it outranks the rest), else the
 * first effect observed (ties: dom, navigation, request), else none with the
 * --trusted note. A popup URL that is empty or still about:blank is left out.
 */
export function classifyEffect(seen: EffectSeen): EffectFields {
  if (seen.popup !== null) {
    const url = seen.popup.url;
    const known = url !== null && url !== "" && url !== "about:blank";
    return { effect: "popup", popup: { tab: seen.popup.tab, ...(known ? { url } : {}) }, note: popupNote(seen.popup.tab) };
  }
  const order: Array<[Exclude<Effect, "none">, number | null]> = [
    ["dom", seen.dom],
    ["navigation", seen.navigation],
    ["request", seen.request],
  ];
  let best: [Exclude<Effect, "none">, number] | null = null;
  for (const [k, at] of order) {
    if (at === null || !Number.isFinite(at)) continue;
    if (best === null || at < best[1]) best = [k, at];
  }
  return best === null ? { effect: "none", note: NO_EFFECT_NOTE } : { effect: best[0] };
}

/** Navigation events (any frame of the watched sessions; same-document ones too). */
export function isNavigationEvent(e: Pick<CdpEvent, "method" | "params">): boolean {
  switch (e.method) {
    case "Page.frameRequestedNavigation":
    case "Page.frameStartedNavigating":
    case "Page.frameNavigated":
    case "Page.navigatedWithinDocument":
      return true;
  }
  return false;
}

/**
 * The target id of a page the event says was opened by `openerTargetId`
 * (Target.targetCreated / Target.attachedToTarget, browser level), else null.
 */
export function popupTargetOf(e: Pick<CdpEvent, "method" | "params" | "sessionId">, openerTargetId: string): string | null {
  if (e.sessionId !== null) return null;
  if (e.method !== "Target.targetCreated" && e.method !== "Target.attachedToTarget") return null;
  const info = isRecord(e.params["targetInfo"]) ? e.params["targetInfo"] : null;
  if (info === null || str(info, "type") !== "page" || str(info, "openerId") !== openerTargetId) return null;
  return str(info, "targetId");
}

/** How long `stop` waits for a seen popup to be registered as a session tab (attach setup runs first). */
export const POPUP_REGISTER_MS = 2000;

/** A request worth counting: anything but data: URLs (inline images and the like). */
export function isRequestEvent(e: Pick<CdpEvent, "method" | "params">): boolean {
  if (e.method !== "Network.requestWillBeSent") return false;
  const req = isRecord(e.params["request"]) ? e.params["request"] : {};
  return !(str(req, "url") ?? "").startsWith("data:");
}

const GROUP = "tabcap-effect";

// Runs on the target element in the isolated world: observe its document, remember its control state.
const WATCH_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const doc = (el && el.ownerDocument) || document;
  const state = (x) => x ? [x.checked, x.value, x.selectedIndex, x.open].map((v) => (v === undefined ? null : v)) : null;
  const st = { first: null, before: JSON.stringify(state(el)), el };
  st.obs = new MutationObserver(() => { if (st.first === null) st.first = Date.now(); });
  st.obs.observe(doc.documentElement || doc, { subtree: true, childList: true, attributes: true, characterData: true });
  st.read = () => {
    st.obs.takeRecords().length > 0 && st.first === null && (st.first = Date.now());
    st.obs.disconnect();
    return { first: st.first, changed: JSON.stringify(state(st.el)) !== st.before };
  };
  return st;
}`;
const READ_FN = "function () { return this.read(); }";

export type EffectWatch = { stop: (skipDom: boolean) => Promise<EffectSeen> };

/**
 * Start watching before a DOM click on `backendNodeId` (its document is owned
 * by `sessionId`; `frame` null: the root document). Never throws: a part that
 * cannot be set up is simply not watched.
 */
export async function watchEffect(
  d: Daemon,
  t: Transport,
  tabs: Pick<Tabs, "byTarget">,
  tab: Tab,
  node: { backendNodeId: number; sessionId: string; frame: { frameId: string; loaderId: string } | null },
): Promise<EffectWatch> {
  const started = Date.now();
  const seen: EffectSeen = { dom: null, navigation: null, request: null, popup: null };
  const sessions = new Set([tab.sessionId, node.sessionId]);
  let popupTarget: string | null = null;
  const off = t.onEvent((e) => {
    if (popupTarget === null) {
      const id = popupTargetOf(e, tab.targetId);
      if (id !== null) {
        popupTarget = id;
        seen.popup = { at: Date.now(), tab: null, url: null };
        return;
      }
    }
    if (e.sessionId === null || !sessions.has(e.sessionId)) return;
    if (seen.navigation === null && isNavigationEvent(e)) seen.navigation = Date.now();
    else if (seen.request === null && isRequestEvent(e)) seen.request = Date.now();
  });
  // Network events need Network on; a recording has it on already.
  let held = false;
  if (!d.recorders.has(tab.session)) {
    try {
      await netOn(t, tab.sessionId);
      held = true;
    } catch (e) {
      log.info("click effect: Network.enable failed, requests not watched", { tab: tab.id, error: String(e) });
    }
  }
  let doc: FrameDoc | null = null;
  let watchId: string | null = null;
  try {
    doc = node.frame === null ? rootDoc(tab, await docIdentity(t, tab)) : { frameId: node.frame.frameId, loaderId: node.frame.loaderId, url: "", sessionId: node.sessionId };
    const fdoc = doc;
    watchId = await inWorld(t, tab, fdoc, async (ctx) => {
      const r = await t.send("DOM.resolveNode", { backendNodeId: node.backendNodeId, executionContextId: ctx, objectGroup: GROUP }, fdoc.sessionId, 5000);
      const obj = isRecord(r["object"]) ? r["object"] : null;
      const objectId = obj === null ? null : str(obj, "objectId");
      if (objectId === null) return null;
      const w = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: WATCH_FN, returnByValue: false, objectGroup: GROUP }, fdoc.sessionId, 5000);
      const res = isRecord(w["result"]) ? w["result"] : null;
      return res === null || isRecord(w["exceptionDetails"]) ? null : str(res, "objectId");
    });
  } catch (e) {
    log.info("click effect: DOM watch not set up", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
  }
  return {
    stop: async (skipDom: boolean) => {
      off();
      if (watchId !== null && doc !== null && !skipDom) {
        // A navigation took the document (and the watch) away: the navigation is the effect then.
        const r = await t.send("Runtime.callFunctionOn", { objectId: watchId, functionDeclaration: READ_FN, returnByValue: true }, doc.sessionId, 3000).catch(() => null);
        const v = r !== null && isRecord(r["result"]) && isRecord(r["result"]["value"]) ? r["result"]["value"] : null;
        if (v !== null) {
          const first = num(v, "first");
          if (first !== null) seen.dom = first;
          else if (v["changed"] === true) seen.dom = started;
        }
      }
      if (doc !== null) await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, doc.sessionId, 3000).catch(() => undefined);
      if (held) await netOff(d, t, tab).catch(() => undefined);
      if (popupTarget !== null && seen.popup !== null) {
        // Tabs registers the popup in an attach hook, which may still be running.
        const end = Date.now() + POPUP_REGISTER_MS;
        let pop = tabs.byTarget(popupTarget);
        while (pop === undefined && Date.now() < end) {
          await Bun.sleep(50);
          pop = tabs.byTarget(popupTarget);
        }
        if (pop !== undefined) seen.popup = { at: seen.popup.at, tab: pop.id, url: pop.url };
      }
      return seen;
    },
  };
}
