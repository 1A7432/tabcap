// docs/04 §52.1–52.2: command windows per tab, external navigations, `tab-changed`.
// Tabs runs on a fake transport whose CDP events the test pushes; the event order
// is the one measured on CfT 157 (spike 11-12): another client's Page.navigate
// starts with Page.frameStartedNavigating, a page's own navigation sends
// Page.frameRequestedNavigation first.

import { describe, expect, test } from "bun:test";
import { isExternalStart, Tabs, windowCovers } from "../../src/daemon/browser/targets.ts";
import { changeField, decideChange, tabChangedError } from "../../src/daemon/tools/drift.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";

function fake() {
  let n = 0;
  const listeners = new Set<(e: CdpEvent) => void>();
  const attached = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method) => (method === "Target.createTarget" ? { targetId: `T${++n}` } : {}),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => attached(id),
    detach: async () => undefined,
    waitAttached: async (id) => attached(id),
    targets: () => [],
  };
  const tabs = new Tabs(t, false);
  const emit = (targetId: string, method: string, params: Record<string, unknown>) => {
    for (const fn of [...listeners]) fn({ method, params, sessionId: `S-${targetId}` });
  };
  /** A navigation of the tab's root frame, as CDP reports it. */
  const nav = (targetId: string, url: string, o: { page?: boolean; type?: string } = {}) => {
    if (o.page === true) emit(targetId, "Page.frameRequestedNavigation", { frameId: targetId, reason: "scriptInitiated", url });
    emit(targetId, "Page.frameStartedNavigating", { frameId: targetId, url, loaderId: "L", navigationType: o.type ?? "differentDocument" });
    emit(targetId, "Page.frameNavigated", { frame: { id: targetId, url, loaderId: "L" } });
  };
  return { tabs, nav, emit };
}

describe("windowCovers", () => {
  const tab = { id: "t1", session: "a" };
  test("its own tab, a tab that joined after it began; never another session's", () => {
    expect(windowCovers({ session: "a", tab: "t1", started: 100 }, tab, 0)).toBe(true);
    expect(windowCovers({ session: "a", tab: "t2", started: 100 }, tab, 0)).toBe(false);
    expect(windowCovers({ session: "a", tab: "t2", started: 100 }, tab, 150)).toBe(true);
    expect(windowCovers({ session: "a", tab: null, started: 100 }, tab, 50)).toBe(false);
    expect(windowCovers({ session: "a", tab: null, started: 100 }, tab, 100)).toBe(false);
    expect(windowCovers({ session: "a", tab: null, started: 100 }, tab, 101)).toBe(true);
    expect(windowCovers({ session: "b", tab: "t1", started: 100 }, tab, 0)).toBe(false);
  });
});

describe("isExternalStart", () => {
  const base = { pageRequested: false, covered: false, waiting: false, navigationType: "differentDocument" };
  test("nobody of the session and not the page: external", () => {
    expect(isExternalStart(base)).toBe(true);
    for (const navigationType of ["historyDifferentDocument", "reload", "reloadBypassingCache", "restore", "restoreWithPost"]) expect(isExternalStart({ ...base, navigationType })).toBe(true);
  });
  test("the page asked, a window covers the tab, the session waits for the human, a same-document navigation: not external", () => {
    expect(isExternalStart({ ...base, pageRequested: true })).toBe(false);
    expect(isExternalStart({ ...base, covered: true })).toBe(false);
    expect(isExternalStart({ ...base, waiting: true })).toBe(false);
    for (const navigationType of ["sameDocument", "historySameDocument", ""]) expect(isExternalStart({ ...base, navigationType })).toBe(false);
  });
});

describe("Tabs: external navigations", () => {
  test("another client's navigation with no window on the tab: changed {from, to}, external until a command acts on the tab", async () => {
    const { tabs, nav } = fake();
    const tab = await tabs.createTab("a");
    nav(tab.targetId, "http://x/a", { page: true });
    expect(tabs.changedOf(tab.id)).toBeNull();
    nav(tab.targetId, "http://y/b");
    expect(tabs.changedOf(tab.id)).toMatchObject({ from: "http://x/a", to: "http://y/b", by: "external" });
    expect(tabs.external(tab.id)).toBe(true);
    // A page-made navigation inside the external epoch keeps it (the epoch ends with a command on the tab).
    nav(tab.targetId, "http://y/login", { page: true });
    expect(tabs.external(tab.id)).toBe(true);
    const w = tabs.openWindow("a", tab.id);
    expect(tabs.external(tab.id)).toBe(false);
    expect(tabs.changedOf(tab.id)?.to).toBe("http://y/b");
    tabs.closeWindow(w);
    tabs.acknowledge(tab.id);
    expect(tabs.changedOf(tab.id)).toBeNull();
  });

  test("11-11: a command on another tab of the session does not cover this one", async () => {
    const { tabs, nav } = fake();
    const t1 = await tabs.createTab("a");
    const t2 = await tabs.createTab("a");
    nav(t1.targetId, "http://x/a", { page: true });
    const w = tabs.openWindow("a", t2.id);
    nav(t1.targetId, "http://y/b");
    tabs.closeWindow(w);
    expect(tabs.changedOf(t1.id)?.to).toBe("http://y/b");
    expect(tabs.changedOf(t2.id)).toBeNull();
  });

  test("a window on the tab, a tab opened inside a window, a waiting session, the page's own navigation: no change", async () => {
    const { tabs, nav } = fake();
    const t1 = await tabs.createTab("a");
    let w = tabs.openWindow("a", t1.id);
    nav(t1.targetId, "http://x/a");
    tabs.closeWindow(w);
    expect(tabs.changedOf(t1.id)).toBeNull();

    w = tabs.openWindow("a", t1.id);
    const t2 = await tabs.createTab("a"); // navigate --new-tab: joins during the window
    nav(t2.targetId, "http://x/new");
    tabs.closeWindow(w);
    expect(tabs.changedOf(t2.id)).toBeNull();

    tabs.waitingOf = (s) => s === "a";
    nav(t1.targetId, "http://x/human");
    expect(tabs.changedOf(t1.id)).toBeNull();
    tabs.waitingOf = () => false;

    nav(t1.targetId, "http://x/self", { page: true });
    nav(t1.targetId, "http://x/again", { page: true, type: "reload" });
    expect(tabs.changedOf(t1.id)).toBeNull();
    expect(tabs.external(t1.id)).toBe(false);
  });

  test("a window of another session never covers; a closed tab forgets its change", async () => {
    const { tabs, nav } = fake();
    const t1 = await tabs.createTab("a");
    const w = tabs.openWindow("b", null);
    nav(t1.targetId, "http://y/b");
    tabs.closeWindow(w);
    expect(tabs.changedOf(t1.id)).not.toBeNull();
    tabs.markClosed(t1);
    expect(tabs.changedOf(t1.id)).toBeNull();
  });

  test("child-frame navigations are not the tab's", async () => {
    const { tabs, emit } = fake();
    const t1 = await tabs.createTab("a");
    emit(t1.targetId, "Page.frameStartedNavigating", { frameId: "CHILD", url: "http://ads/x", loaderId: "L2", navigationType: "differentDocument" });
    emit(t1.targetId, "Page.frameNavigated", { frame: { id: "CHILD", parentId: t1.targetId, url: "http://ads/x" } });
    expect(tabs.changedOf(t1.id)).toBeNull();
  });
});

describe("decideChange and the tab-changed error", () => {
  const c = { at: Date.UTC(2026, 10, 11, 5, 52, 6), from: "http://x/a", to: "http://y/b?q='1'", by: "external" as const };
  test("page-acting commands are refused; navigate and tab select acknowledge; read-only commands pass", () => {
    for (const a of ["click", "fill", "type", "press", "evaluate", "go", "reload", "fetch", "upload", "hover"]) expect(decideChange(a, c, true)).toBe("refuse");
    expect(decideChange("navigate", c, true)).toBe("acknowledge");
    expect(decideChange("tab.use", c, true)).toBe("acknowledge");
    for (const a of ["snapshot", "screenshot", "html", "outline", "find", "net.list", "tabs", "wait"]) expect(decideChange(a, c, true)).toBe("pass");
    expect(decideChange("click", null, true)).toBe("pass");
    expect(decideChange("navigate", c, false)).toBe("pass");
  });
  test("the error names the tab, both URLs and the time; next recovers in place", () => {
    const e = tabChangedError("t22", c);
    expect(e.code).toBe("tab-changed");
    expect(e.extra).toEqual({ tab: "t22", changed: { at: "2026-11-11T05:52:06.000Z", from: "http://x/a", to: "http://y/b?q='1'", by: "external" } });
    expect(e.next).toContain("tabcap tab select t22");
    expect(e.next).toContain("tabcap navigate http://x/a --tab t22");
    expect(e.next).not.toMatch(/tab new|new tab|--new-tab/);
    expect(changeField(c).at).toBe("2026-11-11T05:52:06.000Z");
  });
});
