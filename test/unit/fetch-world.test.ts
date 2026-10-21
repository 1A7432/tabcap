// `tabcap fetch` runs its helper in an isolated world (review 10-21, low item):
// one `tabcap-fetch` world per document of the tab, made on first use through
// browser/worlds.ts and reused by every later fetch on that document (a batch
// of 1000 lines no longer leaves 1000 worlds in the page); a navigation (the
// tab's committed-navigation count moves) gets a new one; a vanished context is made again once for the
// compile. The fetch world is not the adapters' world. The transport is a
// fake; CDP's own error text for a stale context id is used.

import { describe, expect, test } from "bun:test";
import { inWorld, rootDoc, WORLD } from "../../src/daemon/browser/worlds.ts";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { compileFetchHelper, FETCH_WORLD } from "../../src/daemon/tools/fetch.ts";
import type { AttachedTarget, Transport } from "../../src/daemon/transport/types.ts";

function fakeTransport() {
  const worlds: Array<{ worldName: unknown; ctx: number }> = [];
  const compiled: Array<{ ctx: unknown }> = [];
  let stale = 0;
  let ctx = 100;
  let n = 0;
  const target = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}) => {
      if (method === "Target.createTarget") return { targetId: `T${++n}` };
      if (method === "Page.createIsolatedWorld") {
        worlds.push({ worldName: params["worldName"], ctx: ++ctx });
        return { executionContextId: ctx };
      }
      if (method === "Runtime.compileScript") {
        if (stale > 0) {
          stale--;
          throw new Error("Runtime.compileScript: Cannot find context with specified id");
        }
        compiled.push({ ctx: params["executionContextId"] });
        return { scriptId: `s${compiled.length}` };
      }
      return {};
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => target(id),
    detach: async () => undefined,
    waitAttached: async (id) => target(id),
    targets: () => [],
  };
  return {
    t,
    worlds,
    compiled,
    staleOnce: () => {
      stale = 1;
    },
  };
}

async function tabOf(t: Transport): Promise<Tab> {
  return new Tabs(t, false).createTab("f");
}

describe("the fetch helper's isolated world", () => {
  test("one tabcap-fetch world per document, reused by every fetch; a navigation gets a new one", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    const got: Array<{ ctx: number; scriptId: string }> = [];
    for (let i = 0; i < 5; i++) got.push(await compileFetchHelper(f.t, tab, "1"));
    expect(f.worlds).toEqual([{ worldName: FETCH_WORLD, ctx: 101 }]);
    expect(got.map((x) => x.ctx)).toEqual([101, 101, 101, 101, 101]);
    expect(got.map((x) => x.scriptId)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    tab.navEpoch++; // Tabs counts a committed navigation of the tab
    expect((await compileFetchHelper(f.t, tab, "1")).ctx).toBe(102);
    expect((await compileFetchHelper(f.t, tab, "1")).ctx).toBe(102);
    expect(f.worlds.map((w) => w.worldName)).toEqual([FETCH_WORLD, FETCH_WORLD]);
  });

  test("a vanished context: the world is made again once and the helper compiled there", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    await compileFetchHelper(f.t, tab, "1");
    f.staleOnce();
    const again = await compileFetchHelper(f.t, tab, "1");
    expect(again.ctx).toBe(102);
    expect(f.compiled.map((c) => c.ctx)).toEqual([101, 102]);
  });

  test("the adapters' world on the same document is another world", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    const fetchCtx = (await compileFetchHelper(f.t, tab, "1")).ctx;
    const doc = rootDoc(tab, { frameId: tab.targetId, loaderId: `nav-${tab.navEpoch}`, url: tab.url });
    const adaptersCtx = await inWorld(f.t, tab, doc, async (c) => c);
    expect(adaptersCtx).not.toBe(fetchCtx);
    expect(f.worlds.map((w) => w.worldName)).toEqual([FETCH_WORLD, WORLD]);
  });
});
