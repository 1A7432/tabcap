// Isolated worlds per frame document (src/daemon/browser/worlds.ts): one
// `Page.createIsolatedWorld` per (session, frame, loader) and tab, reused while
// the document stays; a new loader (navigation) makes a new one; a vanished
// context is made again once and the call retried once; any other error is
// the caller's; a tab keeps at most 64 frames' worlds, the oldest made go
// first. The error text of a vanished context is CDP's own for a stale
// executionContextId ("Cannot find context with specified id", -32000).

import { describe, expect, test } from "bun:test";
import { inWorld, rootDoc, WORLD, type FrameDoc } from "../../src/daemon/browser/worlds.ts";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import type { AttachedTarget, CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

const STALE = "Runtime.evaluate: Cannot find context with specified id";

/** Answers Page.createIsolatedWorld with a new context id each time (or what `world` says) and logs it. */
function fakeTransport(world?: (params: CdpParams) => CdpResult) {
  const made: Array<{ frameId: unknown; sessionId: string | null; worldName: unknown; ctx: unknown }> = [];
  let ctx = 100;
  let n = 0;
  const target = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      if (method === "Target.createTarget") return { targetId: `T${++n}` };
      if (method !== "Page.createIsolatedWorld") return {};
      const r = world !== undefined ? world(params) : { executionContextId: ++ctx };
      made.push({ frameId: params["frameId"], sessionId, worldName: params["worldName"], ctx: r["executionContextId"] });
      return r;
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => target(id),
    detach: async () => undefined,
    waitAttached: async (id) => target(id),
    targets: () => [],
  };
  return { t, made };
}

async function tabOf(t: Transport): Promise<Tab> {
  return new Tabs(t, false).createTab("w");
}

const doc = (tab: Tab, frameId: string, loaderId = "L1"): FrameDoc => rootDoc(tab, { frameId, loaderId, url: "https://w.example/" });

describe("isolated worlds (worlds.ts)", () => {
  test("made once per document and reused; a new loader or another frame gets its own", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    const ctxs: number[] = [];
    const use = (d: FrameDoc) => inWorld(f.t, tab, d, async (ctx) => (ctxs.push(ctx), ctx));
    await use(doc(tab, "F1"));
    await use(doc(tab, "F1"));
    await use(doc(tab, "F1", "L2")); // the frame navigated
    await use(doc(tab, "F2"));
    expect(ctxs).toEqual([101, 101, 102, 103]);
    expect(f.made).toEqual([
      { frameId: "F1", sessionId: tab.sessionId, worldName: WORLD, ctx: 101 },
      { frameId: "F1", sessionId: tab.sessionId, worldName: WORLD, ctx: 102 },
      { frameId: "F2", sessionId: tab.sessionId, worldName: WORLD, ctx: 103 },
    ]);
  });

  test("per tab: another tab's same frame id gets its own world", async () => {
    const f = fakeTransport();
    const a = await tabOf(f.t);
    const b = await tabOf(f.t);
    expect(await inWorld(f.t, a, doc(a, "F1"), async (ctx) => ctx)).toBe(101);
    expect(await inWorld(f.t, b, doc(b, "F1"), async (ctx) => ctx)).toBe(102);
  });

  test("a vanished context: the world is made again and the call retried once", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    await inWorld(f.t, tab, doc(tab, "F1"), async (ctx) => ctx); // world 101, cached
    const seen: number[] = [];
    const out = await inWorld(f.t, tab, doc(tab, "F1"), async (ctx) => {
      seen.push(ctx);
      if (ctx === 101) throw new Error(STALE);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen).toEqual([101, 102]);
    // the new world is the cached one now
    expect(await inWorld(f.t, tab, doc(tab, "F1"), async (ctx) => ctx)).toBe(102);
    expect(f.made.length).toBe(2);
  });

  test("only once: a context that vanishes again fails the call", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    let calls = 0;
    const run = inWorld(f.t, tab, doc(tab, "F1"), async () => {
      calls++;
      throw new Error(STALE);
    });
    await expect(run).rejects.toThrow(STALE);
    expect(calls).toBe(2);
    expect(f.made.length).toBe(2);
  });

  test("any other error is not retried and no world is made again", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    let calls = 0;
    const boom = inWorld(f.t, tab, doc(tab, "F1"), async () => {
      calls++;
      throw new TabcapError("page", "page script failed: TypeError: x is not a function", "retry");
    });
    await expect(boom).rejects.toThrow("x is not a function");
    const thrown = inWorld(f.t, tab, doc(tab, "F1"), async () => {
      calls++;
      throw "not an Error";
    });
    await expect(thrown).rejects.toBe("not an Error");
    expect(calls).toBe(2);
    expect(f.made.length).toBe(1);
  });

  test("Page.createIsolatedWorld without a usable context id is a cdp error", async () => {
    for (const bad of [{}, { executionContextId: "7" }, { executionContextId: 1.5 }]) {
      const f = fakeTransport(() => bad);
      const tab = await tabOf(f.t);
      let ran = false;
      const r = inWorld(f.t, tab, doc(tab, "F1"), async () => {
        ran = true;
      });
      await expect(r).rejects.toMatchObject({ code: "cdp" });
      expect(ran).toBe(false);
    }
  });

  test("at most 64 frames per tab: the oldest made goes first", async () => {
    const f = fakeTransport();
    const tab = await tabOf(f.t);
    const use = (frame: string) => inWorld(f.t, tab, doc(tab, frame), async (ctx) => ctx);
    for (let i = 1; i <= 64; i++) await use(`F${i}`);
    expect(f.made.length).toBe(64);
    expect(await use("F64")).toBe(164); // all 64 kept
    expect(f.made.length).toBe(64);
    await use("F65"); // one too many: F1's world, made first, is dropped
    expect(f.made.length).toBe(65);
    expect(await use("F2")).toBe(102); // still kept
    expect(await use("F1")).toBe(166); // made again
    expect(f.made.length).toBe(66);
  });
});
