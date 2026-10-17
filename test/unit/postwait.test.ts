// The post-action wait (docs/08 §5; after chrome-devtools-mcp WaitForHelper):
// the pure state machine, the CDP event classification, and the driver
// against a scripted fake transport.

import { describe, expect, test } from "bun:test";
import { deadline, initialState, postWaitConfig, report, stableDomExpression, step, type PostWaitEvent, type PostWaitState } from "../../src/daemon/tools/postwait.ts";
import { classify, withPostWait } from "../../src/daemon/tools/settle.ts";
import type { Tab } from "../../src/daemon/browser/targets.ts";
import { RefTable } from "../../src/daemon/browser/refs.ts";
import type { CdpEvent, Transport } from "../../src/daemon/transport/types.ts";

const cfg = postWaitConfig();

/** Feed events at given times; returns the final state. */
function play(events: Array<[number, PostWaitEvent]>): PostWaitState {
  let s = initialState(0);
  for (const [at, ev] of events) s = step(s, ev, at, cfg);
  return s;
}

describe("post-action wait: the state machine", () => {
  test("numbers: WaitForHelper's 100 / 3000 / 100 / 3000 ms, scaled by CPU rate and network multiplier", () => {
    expect(postWaitConfig()).toEqual({ expectNavMs: 100, navTimeoutMs: 3000, quietMs: 100, domTimeoutMs: 3000 });
    expect(postWaitConfig(4, 10)).toEqual({ expectNavMs: 400, navTimeoutMs: 30000, quietMs: 400, domTimeoutMs: 12000 });
    expect(postWaitConfig(0.5, Number.NaN)).toEqual(postWaitConfig());
  });

  test("no navigation: expect-nav for 100 ms, then the DOM check, then done", () => {
    let s = step(initialState(0), { type: "action-done" }, 10, cfg);
    expect(s.phase).toBe("expect-nav");
    expect(deadline(s, cfg)).toBe(110);
    s = step(s, { type: "tick" }, 50, cfg);
    expect(s.phase).toBe("expect-nav"); // an early tick changes nothing
    s = step(s, { type: "tick" }, 110, cfg);
    expect(s.phase).toBe("dom");
    expect(deadline(s, cfg)).toBeNull();
    s = step(s, { type: "dom-quiet" }, 230, cfg);
    expect(s).toMatchObject({ phase: "done", navStarted: false, domQuiet: true, timedOut: [] });
    expect(report(s, 0, 230)).toEqual({ navigated: false, domQuiet: true, dialog: false, timedOut: [], ms: 230 });
  });

  test("a navigation started during the action and finished: straight to the DOM check", () => {
    const s = play([
      [5, { type: "nav-started" }],
      [40, { type: "nav-finished" }],
      [41, { type: "action-done" }],
    ]);
    expect(s).toMatchObject({ phase: "dom", navStarted: true, navFinished: true });
  });

  test("a navigation that starts after the action: wait for it to finish, then the DOM", () => {
    const s = play([
      [10, { type: "action-done" }],
      [60, { type: "nav-started" }],
      [500, { type: "tick" }],
      [900, { type: "nav-finished" }],
      [1100, { type: "dom-quiet" }],
    ]);
    expect(s).toMatchObject({ phase: "done", navStarted: true, navFinished: true, domQuiet: true, timedOut: [] });
  });

  test("a navigation that never finishes times out after 3000 ms and the DOM is still checked", () => {
    let s = play([
      [0, { type: "nav-started" }],
      [10, { type: "action-done" }],
    ]);
    expect(s.phase).toBe("navigating");
    expect(deadline(s, cfg)).toBe(3010);
    s = step(s, { type: "tick" }, 3010, cfg);
    expect(s).toMatchObject({ phase: "dom", timedOut: ["navigation"] });
    s = step(s, { type: "dom-timeout" }, 6010, cfg);
    expect(s).toMatchObject({ phase: "done", domQuiet: false, timedOut: ["navigation", "dom"] });
  });

  test("a load finishing before any navigation started is not ours; a dialog ends everything", () => {
    expect(play([[1, { type: "nav-finished" }], [2, { type: "action-done" }]])).toMatchObject({ phase: "expect-nav", navFinished: false });
    for (const at of ["action", "expect-nav", "navigating", "dom"] as const) {
      const pre: Array<[number, PostWaitEvent]> =
        at === "action" ? [] : at === "expect-nav" ? [[1, { type: "action-done" }]] : at === "navigating" ? [[0, { type: "nav-started" }], [1, { type: "action-done" }]] : [[1, { type: "action-done" }], [200, { type: "tick" }]];
      const s = play([...pre, [300, { type: "dialog" }]]);
      expect([at, s.phase, s.dialog]).toEqual([at, "done", true]);
    }
    const done = play([[1, { type: "dialog" }]]);
    expect(step(done, { type: "nav-started" }, 2, cfg)).toBe(done);
  });

  test("the page-side check only observes (MutationObserver, timers) and is bounded", () => {
    const e = stableDomExpression(100, 3000);
    expect(e).toContain("new MutationObserver");
    expect(e).toContain("setTimeout(() => finish(false), 3000)");
    expect(e).toContain("setTimeout(() => finish(true), 100)");
    expect(e).not.toMatch(/dispatchEvent|\.click\(|innerHTML\s*=|textContent\s*=/);
    expect(stableDomExpression(0.2, 0)).toContain("finish(false), 1)");
  });
});

describe("post-action wait: CDP events", () => {
  const ev = (method: string, params: Record<string, unknown>): CdpEvent => ({ method, params, sessionId: "S1" });
  test("only the tab's main frame counts; same-document navigations do not", () => {
    expect(classify(ev("Page.frameStartedNavigating", { frameId: "T1", navigationType: "differentDocument" }), "T1")).toEqual({ type: "nav-started" });
    expect(classify(ev("Page.frameStartedNavigating", { frameId: "T1", navigationType: "sameDocument" }), "T1")).toBeNull();
    expect(classify(ev("Page.frameStartedNavigating", { frameId: "T1", navigationType: "historySameDocument" }), "T1")).toBeNull();
    expect(classify(ev("Page.frameStartedNavigating", { frameId: "F9", navigationType: "differentDocument" }), "T1")).toBeNull();
    expect(classify(ev("Page.frameRequestedNavigation", { frameId: "T1" }), "T1")).toEqual({ type: "nav-started" });
    expect(classify(ev("Page.frameNavigated", { frame: { id: "T1" } }), "T1")).toEqual({ type: "nav-started" });
    expect(classify(ev("Page.frameNavigated", { frame: { id: "F2", parentId: "T1" } }), "T1")).toBeNull();
    expect(classify(ev("Page.loadEventFired", {}), "T1")).toEqual({ type: "nav-finished" });
    expect(classify(ev("Page.frameStoppedLoading", { frameId: "T1" }), "T1")).toEqual({ type: "nav-finished" });
    expect(classify(ev("Page.frameStoppedLoading", { frameId: "F2" }), "T1")).toBeNull();
    expect(classify(ev("Page.javascriptDialogOpening", { type: "alert" }), "T1")).toEqual({ type: "dialog" });
    expect(classify(ev("Network.requestWillBeSent", {}), "T1")).toBeNull();
    expect(classify(ev("Page.frameStartedNavigating", { frameId: 5 }), "T1")).toBeNull();
  });
});

function fakeTab(emulation: Tab["emulation"] = {}): Tab {
  return {
    id: "t1",
    targetId: "T1",
    sessionId: "S1",
    session: "s",
    owned: true,
    reason: "ai-opened",
    opener: null,
    url: "about:blank",
    title: "",
    navType: null,
    navEpoch: 0,
    pendingNavType: null,
    loading: false,
    refs: new RefTable(),
    dialog: null,
    queue: Promise.resolve(),
    closed: false,
    dialogWaiters: new Set(),
    pointer: null,
    emulation,
  };
}

/** A transport that answers the DOM check after `domMs` with `quiet`, and lets the test emit events. */
function fakeTransport(o: { domMs: number; quiet: boolean }) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const evaluations: string[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        evaluations.push(String(params?.["expression"] ?? ""));
        await Bun.sleep(o.domMs);
        return { result: { type: "boolean", value: o.quiet } };
      }
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: () => Promise.reject(new Error("unused")),
    detach: async () => undefined,
    waitAttached: () => Promise.reject(new Error("unused")),
    targets: () => [],
  };
  const emit = (method: string, params: Record<string, unknown>, sessionId = "S1") => {
    for (const fn of [...listeners]) fn({ method, params, sessionId });
  };
  return { t, emit, evaluations, listeners };
}

describe("post-action wait: the driver", () => {
  test("--no-wait: the action alone, no listener, no DOM check", async () => {
    const f = fakeTransport({ domMs: 0, quiet: true });
    const r = await withPostWait(f.t, fakeTab(), true, async () => 42);
    expect(r).toEqual({ result: 42, wait: null });
    expect(f.evaluations).toEqual([]);
  });

  test("a navigation the action starts is waited for, then the DOM; the listener is removed", async () => {
    const f = fakeTransport({ domMs: 10, quiet: true });
    const t0 = Date.now();
    const r = await withPostWait(f.t, fakeTab(), false, async () => {
      setTimeout(() => f.emit("Page.frameRequestedNavigation", { frameId: "T1" }), 30);
      setTimeout(() => f.emit("Page.frameStartedNavigating", { frameId: "OTHER", navigationType: "differentDocument" }, "S2"), 40);
      setTimeout(() => f.emit("Page.loadEventFired", {}), 250);
      return "clicked";
    });
    expect(r.result).toBe("clicked");
    expect(r.wait).toMatchObject({ navigated: true, domQuiet: true, dialog: false, timedOut: [] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(f.evaluations).toHaveLength(1);
    expect(f.listeners.size).toBe(0);
  });

  test("no navigation: about 100 ms of looking, then the DOM check", async () => {
    const f = fakeTransport({ domMs: 5, quiet: false });
    const t0 = Date.now();
    const r = await withPostWait(f.t, fakeTab(), false, async () => undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(r.wait).toMatchObject({ navigated: false, domQuiet: false, timedOut: ["dom"] });
  });

  test("emulated CPU throttling stretches the windows; navigation/finish already done (navigate) skips straight to the DOM", async () => {
    const f = fakeTransport({ domMs: 0, quiet: true });
    const t0 = Date.now();
    await withPostWait(f.t, fakeTab({ cpuThrottlingRate: 3 }), false, async () => undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(f.evaluations[0]).toContain("finish(true), 300)");
    const g = fakeTransport({ domMs: 0, quiet: true });
    const t1 = Date.now();
    const r = await withPostWait(g.t, fakeTab(), false, async () => "ready", { navigationDone: true });
    expect(Date.now() - t1).toBeLessThan(90);
    expect(r.wait).toMatchObject({ navigated: true, domQuiet: true });
  });

  test("a dialog during the DOM check ends the wait at once", async () => {
    const f = fakeTransport({ domMs: 5000, quiet: true });
    const t0 = Date.now();
    const r = await withPostWait(f.t, fakeTab(), false, async () => {
      setTimeout(() => f.emit("Page.javascriptDialogOpening", { type: "alert" }), 200);
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.wait).toMatchObject({ dialog: true });
  });

  test("an action that throws: the error goes through and nothing keeps listening", async () => {
    const f = fakeTransport({ domMs: 0, quiet: true });
    await expect(withPostWait(f.t, fakeTab(), false, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(f.listeners.size).toBe(0);
  });
});
