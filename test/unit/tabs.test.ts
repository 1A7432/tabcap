import { describe, expect, test } from "bun:test";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import type { AttachHook, AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";

/** Just enough transport for Tabs: createTarget / closeTarget, and a way to fire attach hooks. */
function fakeTransport() {
  const hooks = new Set<AttachHook>();
  const sent: string[] = [];
  let n = 0;
  const target = (targetId: string, openerId: string | null): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params) => {
      sent.push(`${method} ${typeof params?.["targetId"] === "string" ? params["targetId"] : ""}`.trim());
      return method === "Target.createTarget" ? { targetId: `T${++n}` } : {};
    },
    onEvent: (_fn: (e: CdpEvent) => void) => () => undefined,
    onAttach: (h) => {
      hooks.add(h);
      return () => hooks.delete(h);
    },
    onDetach: () => () => undefined,
    attach: async (id) => target(id, null),
    detach: async () => undefined,
    waitAttached: async (id) => target(id, null),
    targets: () => [],
  };
  const popup = async (targetId: string, openerId: string) => {
    for (const h of hooks) await h(target(targetId, openerId));
  };
  return { t, sent, popup };
}

describe("tabs: --tab, tab use, popup ownership (docs/04 §16)", () => {
  test("a popup of an owned tab is owned, keeps the current tab, and closes with the session", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    const t1 = await tabs.createTab("s");
    await f.popup("P1", t1.targetId);
    const [a, b] = tabs.sessionTabs("s");
    expect(a?.id).toBe("t1");
    expect(b).toMatchObject({ id: "t2", owned: true, reason: "popup", opener: "t1", session: "s" });
    expect(tabs.session("s")?.current).toBe("t1");
    // popup of the popup: still owned
    await f.popup("P2", "P1");
    expect(tabs.sessionTabs("s").map((x) => [x.id, x.owned, x.opener])).toEqual([
      ["t1", true, null],
      ["t2", true, "t1"],
      ["t3", true, "t2"],
    ]);
    const r = await tabs.dropSession("s");
    expect(r).toEqual({ closed: ["t1", "t2", "t3"], released: [] });
    expect(f.sent.filter((x) => x.startsWith("Target.closeTarget"))).toEqual(["Target.closeTarget T1", "Target.closeTarget P1", "Target.closeTarget P2"]);
  });

  test("a popup whose opener is a borrowed (not owned) tab stays borrowed and is released", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    const t1 = await tabs.createTab("s");
    await f.popup("P1", t1.targetId);
    const t2 = tabs.pick("s", "t2");
    t2.owned = false; // stand-in for a tab the session borrowed
    await f.popup("P2", "P1");
    expect(tabs.pick("s", "t3")).toMatchObject({ owned: false, opener: "t2" });
    const r = await tabs.dropSession("s");
    expect(r).toEqual({ closed: ["t1"], released: ["t2", "t3"] });
  });

  test("pick: current tab by default, --tab only within the session; use switches current", async () => {
    const f = fakeTransport();
    const tabs = new Tabs(f.t, false);
    await tabs.createTab("s");
    await f.popup("P1", "T1");
    await tabs.createTab("other");
    expect(tabs.pick("s", null).id).toBe("t1");
    expect(tabs.pick("s", "t2").id).toBe("t2");
    expect(() => tabs.pick("s", "t3")).toThrow(/not an open tab of session "s"/);
    expect(() => tabs.pick("s", "t9")).toThrow(/not an open tab/);
    expect(tabs.use("s", "t2").id).toBe("t2");
    expect(tabs.pick("s", null).id).toBe("t2");
    expect(() => tabs.use("s", "t3")).toThrow(/not an open tab/);
    const t2 = tabs.pick("s", "t2");
    tabs.markClosed(t2);
    expect(() => tabs.pick("s", "t2")).toThrow(/not an open tab/);
  });
});
