// Drives the post-action wait (tools/postwait.ts) over CDP, and the
// `--snapshot` option of the interactive commands (docs/08 §5). Runs inside
// the command's tab job (Tabs.run), so the command timeout bounds it and a
// dialog that opens meanwhile fails the command as before (the action itself
// already happened). Reads: Page.frameStartedNavigating /
// frameRequestedNavigation / frameNavigated (navigation started),
// Page.loadEventFired / frameStoppedLoading (finished), dialog openings; the
// DOM check is a page-side MutationObserver (observes, changes nothing).

import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { Tab } from "../browser/targets.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";
import { networkMultiplier } from "./emulatespec.ts";
import { deadline, initialState, postWaitConfig, report, stableDomExpression, step, type PostWaitConfig, type PostWaitEvent, type PostWaitReport } from "./postwait.ts";
import { Waker } from "./wait.ts";

/** Which post-wait event a CDP event of the tab's own session is, if any. */
export function classify(e: CdpEvent, mainFrameId: string): PostWaitEvent | null {
  const p = e.params;
  switch (e.method) {
    case "Page.frameStartedNavigating": {
      if (str(p, "frameId") !== mainFrameId) return null;
      const kind = str(p, "navigationType");
      return kind === "sameDocument" || kind === "historySameDocument" ? null : { type: "nav-started" };
    }
    case "Page.frameRequestedNavigation":
      return str(p, "frameId") === mainFrameId ? { type: "nav-started" } : null;
    case "Page.frameNavigated": {
      const f = isRecord(p["frame"]) ? p["frame"] : null;
      return f !== null && str(f, "parentId") === null ? { type: "nav-started" } : null;
    }
    case "Page.loadEventFired":
      return { type: "nav-finished" };
    case "Page.frameStoppedLoading":
      return str(p, "frameId") === mainFrameId ? { type: "nav-finished" } : null;
    case "Page.javascriptDialogOpening":
      return { type: "dialog" };
  }
  return null;
}

/** The tab's wait numbers under its emulation (CPU / network throttling). */
export function configOf(tab: Tab): PostWaitConfig {
  return postWaitConfig(tab.emulation.cpuThrottlingRate ?? 1, networkMultiplier(tab.emulation.networkConditions));
}

/**
 * Run `action`, then wait as WaitForHelper.waitForEventsAfterAction does.
 * `skip` (--no-wait) runs the action alone and reports null.
 */
export async function withPostWait<T>(t: Transport, tab: Tab, skip: boolean, action: () => Promise<T>, opts: { navigationDone?: boolean } = {}): Promise<{ result: T; wait: PostWaitReport | null }> {
  if (skip) return { result: await action(), wait: null };
  const cfg = configOf(tab);
  const started = Date.now();
  let s = initialState(started);
  const queue: PostWaitEvent[] = [];
  const waker = new Waker();
  let dialogSeen: () => void = () => undefined;
  const dialog = new Promise<false>((resolve) => {
    dialogSeen = () => resolve(false);
  });
  const off = t.onEvent((e) => {
    if (e.sessionId !== tab.sessionId) return;
    const ev = classify(e, tab.targetId);
    if (ev === null) return;
    queue.push(ev);
    if (ev.type === "dialog") dialogSeen();
    waker.wake();
  });
  try {
    const result = await action();
    const drain = () => {
      for (let ev = queue.shift(); ev !== undefined; ev = queue.shift()) s = step(s, ev, Date.now(), cfg);
    };
    drain();
    // navigate / go / reload already waited for the new document: only the DOM part is left.
    if (opts.navigationDone === true && s.phase === "action") s = step(step(s, { type: "nav-started" }, Date.now(), cfg), { type: "nav-finished" }, Date.now(), cfg);
    s = step(s, { type: "action-done" }, Date.now(), cfg);
    for (;;) {
      drain();
      if (s.phase === "done") break;
      if (s.phase === "dom") {
        // A dialog pauses the renderer: the check would hang until its CDP timeout.
        const quiet = await Promise.race([domQuiet(t, tab, cfg), dialog]);
        drain();
        s = step(s, { type: quiet ? "dom-quiet" : "dom-timeout" }, Date.now(), cfg);
        continue;
      }
      const at = deadline(s, cfg);
      if (at !== null) await waker.sleep(at - Date.now());
      drain();
      s = step(s, { type: "tick" }, Date.now(), cfg);
    }
    return { result, wait: report(s, started, Date.now()) };
  } finally {
    off();
  }
}

/** true: the DOM was quiet for quietMs; false: it kept changing, the check failed, or a dialog opened. */
async function domQuiet(t: Transport, tab: Tab, cfg: PostWaitConfig): Promise<boolean> {
  return t
    .send("Runtime.evaluate", { expression: stableDomExpression(cfg.quietMs, cfg.domTimeoutMs), awaitPromise: true, returnByValue: true }, tab.sessionId, cfg.domTimeoutMs + 1000)
    .then((r) => {
      const res = isRecord(r["result"]) ? r["result"] : {};
      return res["value"] === true;
    })
    .catch((e: unknown) => {
      log.info("post-action wait: DOM check failed", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
      return false;
    });
}
