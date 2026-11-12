// docs/04 §51: `tab adopt`. Tabs runs on a fake transport whose Target.getTargets
// is the list of page targets the browser reports.

import { describe, expect, test } from "bun:test";
import { adoptContextOk, Tabs } from "../../src/daemon/browser/targets.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import type { AttachedTarget, Transport } from "../../src/daemon/transport/types.ts";

type Info = { targetId: string; type?: string; url?: string; title?: string; browserContextId?: string };

function fake(infos: Info[]) {
  const sent: string[] = [];
  let n = 0;
  const attached = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: infos.find((x) => x.targetId === targetId)?.url ?? "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method) => {
      sent.push(method);
      if (method === "Target.getTargets") return { targetInfos: infos.map((x) => ({ type: "page", url: "", title: "", ...x })) };
      if (method === "Target.createTarget") {
        const targetId = `AAAA0000CREATED${++n}`;
        infos.push({ targetId, url: "about:blank" });
        return { targetId };
      }
      return {};
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => attached(id),
    detach: async () => undefined,
    waitAttached: async (id) => attached(id),
    targets: () => [],
  };
  return { tabs: new Tabs(t, false), sent };
}

const HUMAN = "3F2A91C4D5E6F70811223344AABBCCDD";
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof TabcapError ? e.code : "other";
  }
};

describe("tab list --all: others", () => {
  test("page targets of no session, lower-case; no DevTools, extension or non-page targets; the session's own are not others", async () => {
    const { tabs } = fake([
      { targetId: HUMAN, url: "http://x/a", title: "A" },
      { targetId: "DEV0", url: "devtools://devtools/bundled/inspector.html" },
      { targetId: "EXT0", url: "chrome-extension://abc/panel.html" },
      { targetId: "WORK", type: "service_worker", url: "http://x/sw.js" },
    ]);
    await tabs.createTab("a");
    expect(await tabs.others("a")).toEqual([{ target: HUMAN.toLowerCase(), url: "http://x/a", title: "A", held: null }]);
  });
});

describe("tab adopt", () => {
  test("borrowed, the session's current tab, never owned; no focus call", async () => {
    const { tabs, sent } = fake([{ targetId: HUMAN, url: "http://x/a" }]);
    const { tab, already } = await tabs.adopt("a", HUMAN.slice(0, 8).toLowerCase());
    expect(already).toBe(false);
    expect(tab).toMatchObject({ session: "a", owned: false, reason: "borrowed", opener: null, url: "http://x/a" });
    expect(tabs.session("a")?.current).toBe(tab.id);
    expect(sent.filter((m) => m === "Target.activateTarget" || m === "Page.bringToFront")).toEqual([]);
    expect(await tabs.others("a")).toEqual([]);
  });

  test("a prefix is case-insensitive; too short is usage; unknown is not-found; a failed adopt creates no session", async () => {
    const { tabs } = fake([{ targetId: HUMAN }]);
    expect(await code(tabs.adopt("a", "3f2a91c"))).toBe("usage");
    expect(await code(tabs.adopt("a", "deadbeef"))).toBe("not-found");
    expect(tabs.session("a")).toBeUndefined();
    expect((await tabs.adopt("a", "3F2a91c4")).tab.targetId).toBe(HUMAN);
  });

  test("a prefix matching two tabs is usage and names them", async () => {
    const { tabs } = fake([{ targetId: "AAAABBBB01" }, { targetId: "AAAABBBB02" }]);
    await expect(tabs.adopt("a", "aaaabbbb")).rejects.toThrow("aaaabbbb01, aaaabbbb02");
    expect((await tabs.adopt("a", "aaaabbbb02")).tab.targetId).toBe("AAAABBBB02");
  });

  test("again in the same session: the same tab, made current; in another session: conflict", async () => {
    const { tabs } = fake([{ targetId: HUMAN }]);
    const first = await tabs.adopt("a", HUMAN);
    const opened = await tabs.createTab("a");
    expect(tabs.session("a")?.current).toBe(opened.id);
    const again = await tabs.adopt("a", HUMAN);
    expect(again).toMatchObject({ already: true });
    expect(again.tab.id).toBe(first.tab.id);
    expect(tabs.session("a")?.current).toBe(first.tab.id);
    await expect(tabs.adopt("b", HUMAN)).rejects.toThrow('session "a"');
    expect(tabs.session("b")).toBeUndefined();
  });

  test("session stop releases it (not closed); it can be adopted again under a new id", async () => {
    const { tabs, sent } = fake([{ targetId: HUMAN }]);
    const first = await tabs.adopt("a", HUMAN);
    expect(await tabs.dropSession("a")).toEqual({ closed: [], released: [first.tab.id] });
    expect(sent).not.toContain("Target.closeTarget");
    expect(await tabs.others("a")).toHaveLength(1);
    expect((await tabs.adopt("a", HUMAN)).tab.id).not.toBe(first.tab.id);
  });

  test("it never becomes the fallback when the current tab closes", async () => {
    const { tabs } = fake([{ targetId: HUMAN }]);
    await tabs.adopt("a", HUMAN);
    const own = await tabs.createTab("a");
    tabs.markClosed(own);
    expect(tabs.session("a")?.current).toBeNull();
  });

  test("the session's listeners see it (recording starts here)", async () => {
    const { tabs } = fake([{ targetId: HUMAN }]);
    const added: string[] = [];
    tabs.onTabAdded(async (tab) => void added.push(`${tab.session}:${tab.reason}`));
    await tabs.adopt("a", HUMAN);
    expect(added).toEqual(["a:borrowed"]);
  });

  test("another browser context is conflict, both ways", async () => {
    const { tabs } = fake([{ targetId: HUMAN, browserContextId: "DEFAULT" }, { targetId: "BOUND00000", browserContextId: "CTX-A" }]);
    tabs.contexts.set("a", "CTX-A");
    expect(await code(tabs.adopt("a", HUMAN))).toBe("conflict");
    expect(await code(tabs.adopt("b", "bound00000"))).toBe("conflict");
    expect((await tabs.adopt("a", "bound00000")).tab.session).toBe("a");
    expect((await tabs.adopt("b", HUMAN)).tab.session).toBe("b");
  });

  test("adoptContextOk: the rule", () => {
    const own = new Set(["CTX-A"]);
    expect(adoptContextOk("CTX-A", "CTX-A", own)).toBe(true);
    expect(adoptContextOk("CTX-A", "DEFAULT", own)).toBe(false);
    expect(adoptContextOk("CTX-A", null, own)).toBe(false);
    expect(adoptContextOk(undefined, "DEFAULT", own)).toBe(true);
    expect(adoptContextOk(undefined, null, own)).toBe(true);
    expect(adoptContextOk(undefined, "CTX-A", own)).toBe(false);
  });
});
