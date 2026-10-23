// 0.9-A: `status` of navigate / go / reload / tab new answers (docs/04 §45, docs/05 s72).
// The value comes out of the page's navigation timing entry, so it is checked as
// untrusted input: a whole number from 100 to 599, else null. The read runs in
// tabcap's isolated world (never the page's main world) and never fails the command.
// Oracle for the semantics (200 / 404 / 500 / 203, redirects, 0 for about:blank):
// docs/07 §1.1 (spike-dp5 E1) and the range's own log, test/e2e/v09a.e2e.test.ts.
// Reproduce: bun test test/unit/nav-status.test.ts

import { describe, expect, test } from "bun:test";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { navStatusOf, readNavStatus } from "../../src/daemon/tools/navigate.ts";
import type { AttachedTarget, CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

describe("navStatusOf: what a page's responseStatus may become", () => {
  test("whole numbers from 100 to 599 pass", () => {
    for (const v of [100, 200, 203, 302, 404, 500, 599]) expect([v, navStatusOf(v)]).toEqual([v, v]);
  });

  test("everything else is null: the edges, 0, fractions, non-numbers, a missing entry", () => {
    const bad: unknown[] = [99, 600, 0, -200, 200.5, 99.999, 599.5, NaN, Infinity, -Infinity, "200", "404", " 200", true, null, undefined, {}, [200], { status: 200 }, 2 ** 53];
    for (const v of bad) expect([String(v), navStatusOf(v)]).toEqual([String(v), null]);
  });
});

const STALE = "Runtime.evaluate: Cannot find context with specified id";

type Call = { method: string; params: CdpParams; sessionId: string | null };

/** A transport that answers the three calls readNavStatus makes; `evaluate` decides what the page says. */
function fake(evaluate: (params: CdpParams, n: number) => CdpResult | Promise<CdpResult>, frameTree: () => CdpResult = () => ({ frameTree: { frame: { id: "F1", loaderId: "L1", url: "http://127.0.0.1:1/s72/ok" } } })) {
  const calls: Call[] = [];
  let ctx = 100;
  let evals = 0;
  let n = 0;
  const target = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: `T${++n}` };
      if (method === "Page.getFrameTree") return frameTree();
      if (method === "Page.createIsolatedWorld") return { executionContextId: ++ctx };
      if (method === "Runtime.evaluate") return evaluate(params, ++evals);
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
  return { t, calls };
}

async function tabOf(t: Transport): Promise<Tab> {
  return new Tabs(t, false).createTab("w");
}

const value = (v: unknown): CdpResult => ({ result: { type: "object", value: v } });

describe("readNavStatus", () => {
  test("reads the entry in an isolated world of the root frame, not in the page's main world", async () => {
    const f = fake(() => value(404));
    const tab = await tabOf(f.t);
    expect(await readNavStatus(f.t, tab)).toBe(404);
    const world = f.calls.find((c) => c.method === "Page.createIsolatedWorld");
    expect(world?.params["frameId"]).toBe("F1");
    const ev = f.calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params["contextId"]).toBe(101);
    expect(ev?.params["returnByValue"]).toBe(true);
    expect(String(ev?.params["expression"])).toContain('getEntriesByType("navigation")');
    expect(String(ev?.params["expression"])).toContain("responseStatus");
    expect(ev?.sessionId).toBe(tab.sessionId);
  });

  test("a value out of range, not a number, or absent is null", async () => {
    for (const v of [0, 99, 600, 299.5, "200", null, undefined, { responseStatus: 200 }]) {
      const f = fake(() => value(v));
      expect([String(v), await readNavStatus(f.t, await tabOf(f.t))]).toEqual([String(v), null]);
    }
    const f = fake(() => ({ result: { type: "undefined" } }));
    expect(await readNavStatus(f.t, await tabOf(f.t))).toBeNull();
  });

  test("a vanished context is made again and the read retried once", async () => {
    const f = fake((_p, n) => {
      if (n === 1) throw new Error(STALE);
      return value(503);
    });
    const tab = await tabOf(f.t);
    expect(await readNavStatus(f.t, tab)).toBe(503);
    expect(f.calls.filter((c) => c.method === "Page.createIsolatedWorld")).toHaveLength(2);
  });

  test("still failing after the retry, a page exception, a failed frame tree: null, never a throw", async () => {
    const stale = fake(() => {
      throw new Error(STALE);
    });
    expect(await readNavStatus(stale.t, await tabOf(stale.t))).toBeNull();
    expect(stale.calls.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(2);

    const thrown = fake(() => ({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } } }));
    expect(await readNavStatus(thrown.t, await tabOf(thrown.t))).toBeNull();

    const noTree = fake(
      () => value(200),
      () => {
        throw new Error("Page.getFrameTree: target closed");
      },
    );
    expect(await readNavStatus(noTree.t, await tabOf(noTree.t))).toBeNull();

    const emptyTree = fake(() => value(200), () => ({}));
    expect(await readNavStatus(emptyTree.t, await tabOf(emptyTree.t))).toBeNull();
  });

  test("another error than a vanished context is not retried", async () => {
    const f = fake(() => {
      throw new Error("Runtime.evaluate: Execution was terminated");
    });
    expect(await readNavStatus(f.t, await tabOf(f.t))).toBeNull();
    expect(f.calls.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(1);
  });
});
