// 0.9-A: `status` of navigate / go / reload / tab new answers (docs/04 §45, docs/05 s72).
// The value comes out of the page's navigation timing entry, so it is checked as
// untrusted input: a whole number from 100 to 599, else null. The read runs in
// tabcap's isolated world (never the page's main world) and never fails the command.
// Oracle for the semantics (200 / 404 / 500 / 203, redirects, 0 for about:blank):
// docs/07 §1.1 (spike-dp5 E1) and the range's own log, test/e2e/v09a.e2e.test.ts.
// Reproduce: bun test test/unit/nav-status.test.ts

import { describe, expect, test } from "bun:test";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { NAV_STATUS_TRIES, navStatusOf, readNavStatus, withNavStatus, type NavResult, type NavStatusRead } from "../../src/daemon/tools/navigate.ts";
import type { PageState } from "../../src/daemon/transport/direct/ready.ts";
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
const HREF = "http://127.0.0.1:1/s72/ok";
/** What the page answers to the status read: its URL and the entry's status. */
const page = (status: unknown, href: unknown = HREF): CdpResult => value({ href, status });
const none: NavStatusRead = { href: null, status: null };

describe("readNavStatus", () => {
  test("reads the entry in an isolated world of the root frame, not in the page's main world", async () => {
    const f = fake(() => page(404));
    const tab = await tabOf(f.t);
    expect(await readNavStatus(f.t, tab)).toEqual({ href: HREF, status: 404 });
    const world = f.calls.find((c) => c.method === "Page.createIsolatedWorld");
    expect(world?.params["frameId"]).toBe("F1");
    const ev = f.calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params["contextId"]).toBe(101);
    expect(ev?.params["returnByValue"]).toBe(true);
    expect(String(ev?.params["expression"])).toContain('getEntriesByType("navigation")');
    expect(String(ev?.params["expression"])).toContain("responseStatus");
    expect(String(ev?.params["expression"])).toContain("location.href");
    expect(ev?.sessionId).toBe(tab.sessionId);
  });

  test("a value out of range, not a number, or absent is null", async () => {
    for (const v of [0, 99, 600, 299.5, "200", null, undefined, { responseStatus: 200 }]) {
      const f = fake(() => page(v));
      expect([String(v), await readNavStatus(f.t, await tabOf(f.t))]).toEqual([String(v), { href: HREF, status: null }]);
    }
    // not an object, or a URL that is not a string: nothing usable
    for (const v of [200, null, "x"]) {
      const f = fake(() => value(v));
      expect(await readNavStatus(f.t, await tabOf(f.t))).toEqual(none);
    }
    const odd = fake(() => page(200, 42));
    expect(await readNavStatus(odd.t, await tabOf(odd.t))).toEqual({ href: null, status: 200 });
    const f = fake(() => ({ result: { type: "undefined" } }));
    expect(await readNavStatus(f.t, await tabOf(f.t))).toEqual(none);
  });

  test("a vanished context is made again and the read retried once", async () => {
    const f = fake((_p, n) => {
      if (n === 1) throw new Error(STALE);
      return page(503);
    });
    const tab = await tabOf(f.t);
    expect(await readNavStatus(f.t, tab)).toEqual({ href: HREF, status: 503 });
    expect(f.calls.filter((c) => c.method === "Page.createIsolatedWorld")).toHaveLength(2);
  });

  test("still failing after the retry, a page exception, a failed frame tree: null, never a throw", async () => {
    const stale = fake(() => {
      throw new Error(STALE);
    });
    expect(await readNavStatus(stale.t, await tabOf(stale.t))).toEqual(none);
    expect(stale.calls.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(2);

    const thrown = fake(() => ({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } } }));
    expect(await readNavStatus(thrown.t, await tabOf(thrown.t))).toEqual(none);

    const noTree = fake(
      () => page(200),
      () => {
        throw new Error("Page.getFrameTree: target closed");
      },
    );
    expect(await readNavStatus(noTree.t, await tabOf(noTree.t))).toEqual(none);

    const emptyTree = fake(() => page(200), () => ({}));
    expect(await readNavStatus(emptyTree.t, await tabOf(emptyTree.t))).toEqual(none);
  });

  test("another error than a vanished context is not retried", async () => {
    const f = fake(() => {
      throw new Error("Runtime.evaluate: Execution was terminated");
    });
    expect(await readNavStatus(f.t, await tabOf(f.t))).toEqual(none);
    expect(f.calls.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(1);
  });
});

describe("withNavStatus: url, title, readyState and status from one document", () => {
  const A = "http://127.0.0.1:1/s72/js";
  const B = "http://127.0.0.1:1/s72/missing";
  const confirmed: NavResult = { tab: "t1", url: A, title: "js", readyState: "complete", nav: "n-1" };
  const stateB: PageState = { href: B, readyState: "complete", title: "missing" };
  function io(reads: NavStatusRead[], confirms: Array<PageState | null>) {
    const calls = { read: 0, confirm: 0 };
    return {
      calls,
      io: {
        read: async () => reads[calls.read++] ?? none,
        confirm: async () => confirms[calls.confirm++] ?? null,
        navOf: () => `n-${calls.confirm + 1}`,
      },
    };
  }

  test("the status read sees the confirmed URL: one read, the answer unchanged plus status", async () => {
    const x = io([{ href: A, status: 200 }], []);
    expect(await withNavStatus(confirmed, x.io)).toEqual({ ...confirmed, status: 200 });
    expect(x.calls).toEqual({ read: 1, confirm: 0 });
  });

  test("measured race (0.9-D review): confirmed /s72/js, the status read already on /s72/missing → confirm again, answer the 404 document", async () => {
    const x = io([{ href: B, status: 404 }, { href: B, status: 404 }], [stateB]);
    expect(await withNavStatus(confirmed, x.io)).toEqual({ tab: "t1", url: B, title: "missing", readyState: "complete", nav: "n-2", status: 404 });
    expect(x.calls).toEqual({ read: 2, confirm: 1 });
  });

  test("never the same document within the tries: status null, the last confirmed state", async () => {
    const reads = Array.from({ length: NAV_STATUS_TRIES }, (_, i) => ({ href: `http://127.0.0.1:1/r${i}`, status: 200 }));
    const confirms = Array.from({ length: NAV_STATUS_TRIES }, (_, i) => ({ href: `http://127.0.0.1:1/c${i}`, readyState: "complete", title: `c${i}` }));
    const x = io(reads, confirms);
    const r = await withNavStatus(confirmed, x.io);
    expect(r.status).toBeNull();
    expect(r.url).toBe(`http://127.0.0.1:1/c${NAV_STATUS_TRIES - 1}`);
    expect(x.calls).toEqual({ read: NAV_STATUS_TRIES, confirm: NAV_STATUS_TRIES });
  });

  test("an unreadable status read is retried after a fresh confirmation; a page that no longer answers: null", async () => {
    const x = io([none, { href: A, status: 500 }], [{ href: A, readyState: "complete", title: "js" }]);
    expect((await withNavStatus(confirmed, x.io)).status).toBe(500);
    const y = io([none], [null]);
    expect(await withNavStatus(confirmed, y.io)).toEqual({ ...confirmed, status: null });
    expect(y.calls).toEqual({ read: 1, confirm: 1 });
  });

  test("a hash or pushState URL is compared as is (both reads see the same location.href)", async () => {
    const hashed = { ...confirmed, url: `${B}#x` };
    const x = io([{ href: `${B}#x`, status: 404 }], []);
    expect((await withNavStatus(hashed, x.io)).status).toBe(404);
  });
});
