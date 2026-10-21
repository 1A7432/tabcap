// 0.7.3: the current tab closes (tab close, crash, target destroyed, detach)
// and the session falls back by itself (docs/04 §16, CHANGELOG 0.7.3): among
// the session's open owned tabs the most recently current one, else the last
// opened; borrowed tabs never; none left → current is null and the no-tab
// error names the closed tab. Tabs runs on a fake transport that can fire the
// target events Chrome sends.

import { describe, expect, test } from "bun:test";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import type { AttachHook, AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";

function fakeTransport() {
  const hooks = new Set<AttachHook>();
  const events = new Set<(e: CdpEvent) => void>();
  const detaches = new Set<(t: AttachedTarget) => void>();
  let n = 0;
  const target = (targetId: string, openerId: string | null): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method) => (method === "Target.createTarget" ? { targetId: `T${++n}` } : {}),
    onEvent: (fn) => {
      events.add(fn);
      return () => events.delete(fn);
    },
    onAttach: (h) => {
      hooks.add(h);
      return () => hooks.delete(h);
    },
    onDetach: (fn) => {
      detaches.add(fn);
      return () => detaches.delete(fn);
    },
    attach: async (id) => target(id, null),
    detach: async () => undefined,
    waitAttached: async (id) => target(id, null),
    targets: () => [],
  };
  return {
    t,
    /** A page the tab with target `openerId` opened (window.open). */
    popup: async (targetId: string, openerId: string) => {
      for (const h of hooks) await h(target(targetId, openerId));
    },
    /** A browser-level Target event about one target. */
    targetEvent: (method: "Target.targetCrashed" | "Target.targetDestroyed", targetId: string) => {
      for (const fn of events) fn({ method, params: { targetId }, sessionId: null });
    },
    /** The auto-attacher lost the target's session. */
    detached: (targetId: string) => {
      for (const fn of detaches) fn(target(targetId, null));
    },
  };
}

/** Three owned tabs t1 t2 t3 in session "s"; creating each made it current, so t3 is current. */
async function three() {
  const f = fakeTransport();
  const tabs = new Tabs(f.t, false);
  const t1 = await tabs.createTab("s");
  const t2 = await tabs.createTab("s");
  const t3 = await tabs.createTab("s");
  return { f, tabs, t1, t2, t3 };
}

const current = (tabs: Tabs): string | null => tabs.session("s")?.current ?? null;

describe("closing the current tab: the fallback (0.7.3, docs/04 §16)", () => {
  test("the most recently current open owned tab wins over the last opened", async () => {
    const { tabs, t2 } = await three();
    tabs.use("s", "t1");
    tabs.use("s", "t2"); // current t2; before it t1; t3 was current before that
    await tabs.closeTab(t2);
    expect(current(tabs)).toBe("t1");
    expect(tabs.pick("s", null).id).toBe("t1");
  });

  test("closing a tab that is not current leaves the current tab alone", async () => {
    const { tabs, t1 } = await three();
    await tabs.closeTab(t1);
    expect(current(tabs)).toBe("t3");
  });

  test("when none of the recently current tabs is open: the last opened owned tab", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    const t1 = await tabs.createTab("s");
    // popups are owned (their opener is owned) but never became current
    await f.popup("P1", t1.targetId);
    await f.popup("P2", t1.targetId);
    expect(current(tabs)).toBe("t1");
    await tabs.closeTab(t1);
    expect(current(tabs)).toBe("t3");
  });

  test("borrowed tabs are never the fallback, even when they were current more recently", async () => {
    const { tabs, t2, t3 } = await three();
    t2.owned = false; // stand-in for a tab the session borrowed (as in tabs.test.ts)
    tabs.use("s", "t1");
    tabs.use("s", "t2");
    tabs.use("s", "t3"); // recently current: t3, t2 (borrowed), t1
    await tabs.closeTab(t3);
    expect(current(tabs)).toBe("t1");
  });

  test("only borrowed tabs left: current is null, the no-tab error names the closed tab", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    const t1 = await tabs.createTab("s");
    const t2 = await tabs.createTab("s");
    t1.owned = false; // borrowed, and current before t2
    await tabs.closeTab(t2);
    expect(current(tabs)).toBeNull();
    expect(tabs.sessionTabs("s").map((x) => x.id)).toEqual(["t1"]);
    expect(() => tabs.pick("s", null)).toThrow('session "s" tab t2 was closed');
  });

  test("closing the last owned tab: current is null", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    const t1 = await tabs.createTab("s");
    await tabs.closeTab(t1);
    expect(current(tabs)).toBeNull();
    expect(tabs.sessionTabs("s")).toEqual([]);
    expect(() => tabs.pick("s", null)).toThrow('session "s" tab t1 was closed');
  });

  test("closing again walks further back through the tabs that were current", async () => {
    const { tabs, t1, t3 } = await three();
    await tabs.createTab("s"); // t4: the last opened
    tabs.use("s", "t2");
    tabs.use("s", "t1");
    tabs.use("s", "t3"); // recently current: t3, t1, t2, t4
    await tabs.closeTab(t3);
    expect(current(tabs)).toBe("t1");
    await tabs.closeTab(t1);
    expect(current(tabs)).toBe("t2");
  });

  for (const how of ["Target.targetCrashed", "Target.targetDestroyed", "detach"] as const) {
    test(`a tab gone by ${how} falls back the same way`, async () => {
      const { f, tabs, t2 } = await three();
      tabs.use("s", "t1");
      tabs.use("s", "t2");
      if (how === "detach") f.detached(t2.targetId);
      else f.targetEvent(how, t2.targetId);
      const gone: Tab = t2;
      expect(gone.closed).toBe(true);
      expect(current(tabs)).toBe("t1");
    });
  }
});
