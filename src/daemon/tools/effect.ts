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
// Popup window (0.6-U, a real-site re-test 10-17: the click's request was seen,
// the popup target came after the wait and the answer said "request" with no
// popup): the popup is looked for until the watch returns, not until the
// post-action wait ends. After the wait one grace of at most POPUP_REGISTER_MS
// follows: with a popup seen, until it is registered as a session tab (as
// before); with none seen, only while a request the watch saw is still in
// flight or finished less than POPUP_SETTLE_MS ago (a handler that opens the
// popup from the response), so a click without such a request is not slowed.
// A popup is also taken from the session's tab list: a tab whose opener is the
// clicked tab that was not there when the watch started.

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

/** The grace after the post-action wait (0.6-U: one budget for a popup to show up and to be registered as a session tab). */
export const POPUP_REGISTER_MS = 2000;
/** With no popup seen, the grace lasts while a watched request is in flight or ended less than this ago. */
export const POPUP_SETTLE_MS = 300;

/**
 * Pure (0.6-U): may the grace after the post-action wait end now? `popup`:
 * null none seen, else whether it is registered; `inflight` watched requests
 * not finished; `lastEnd` when the last one finished (ms) or null; `requests`
 * false skips the request part (a dialog is open: the page's script is paused).
 */
export function popupGraceOver(s: { now: number; deadline: number; popup: { registered: boolean } | null; inflight: number; lastEnd: number | null; requests: boolean }): boolean {
  if (s.now >= s.deadline) return true;
  if (s.popup !== null) return s.popup.registered;
  if (!s.requests) return true;
  if (s.inflight > 0) return false;
  return s.lastEnd === null || s.now - s.lastEnd >= POPUP_SETTLE_MS;
}

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
/** Popup tabs of `opener` in the session's tab list (0.6-U: a popup the target events did not name is still found). */
function popupTabsOf(tabs: Pick<Tabs, "tabs">, opener: Tab): Tab[] {
  return [...tabs.tabs.values()].filter((x) => !x.closed && x.reason === "popup" && x.opener === opener.id && x.session === opener.session);
}

export async function watchEffect(
  d: Daemon,
  t: Transport,
  tabs: Pick<Tabs, "byTarget" | "tabs">,
  tab: Tab,
  node: { backendNodeId: number; sessionId: string; frame: { frameId: string; loaderId: string } | null },
): Promise<EffectWatch> {
  const started = Date.now();
  const seen: EffectSeen = { dom: null, navigation: null, request: null, popup: null };
  const sessions = new Set([tab.sessionId, node.sessionId]);
  const popupsBefore = new Set(popupTabsOf(tabs, tab).map((x) => x.id));
  let popupTarget: string | null = null;
  // Requests the watch saw start and not yet finish (0.6-U grace), and when the last one finished.
  const inflight = new Set<string>();
  let lastEnd: number | null = null;
  // Set when the post-action wait has ended: DOM / navigation / request are judged over the wait only (as in
  // 0.6-D), and a request that starts later does not lengthen the grace.
  let waitOver = false;
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
    const rid = str(e.params, "requestId");
    if (e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") {
      if (rid !== null && inflight.delete(`${e.sessionId}\n${rid}`)) lastEnd = Date.now();
      return;
    }
    if (waitOver) return;
    if (isRequestEvent(e)) {
      if (rid !== null) inflight.add(`${e.sessionId}\n${rid}`);
      if (seen.request === null) seen.request = Date.now();
    } else if (seen.navigation === null && isNavigationEvent(e)) seen.navigation = Date.now();
  });
  /** A popup tab registered since the watch started that the target events did not name. */
  const newPopupTab = (): Tab | undefined => popupTabsOf(tabs, tab).find((x) => !popupsBefore.has(x.id));
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
      // 0.6-U: the event listener stays on until the watch returns (popups and request ends).
      waitOver = true;
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
      // The grace (0.6-U): one budget for a popup to show up (only while a watched request may still open one)
      // and to be registered (Tabs registers it in an attach hook, which may still be running).
      const deadline = Date.now() + POPUP_REGISTER_MS;
      let pop: Tab | undefined;
      for (;;) {
        pop = popupTarget === null ? newPopupTab() : (tabs.byTarget(popupTarget) ?? newPopupTab());
        if (pop !== undefined && seen.popup === null) seen.popup = { at: Date.now(), tab: null, url: null };
        const state = { now: Date.now(), deadline, popup: seen.popup === null ? null : { registered: pop !== undefined }, inflight: inflight.size, lastEnd, requests: !skipDom };
        if (popupGraceOver(state)) break;
        await Bun.sleep(50);
      }
      off();
      if (held) await netOff(d, t, tab).catch(() => undefined);
      if (pop !== undefined && seen.popup !== null) seen.popup = { at: seen.popup.at, tab: pop.id, url: pop.url };
      return seen;
    },
  };
}
