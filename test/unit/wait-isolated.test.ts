// Owner 10-21: `wait --text / --selector` and `handoff wait --until-text /
// --until-selector` evaluate their condition in tabcap's isolated world
// (`tabcap-wait`) in every frame document they look at — the main frame and an
// out-of-process iframe's own document too, as same-process child frames
// already were — so the page neither sees the condition nor can change the
// result; `--fn` stays in the page's main world (it is the page's own code).
// readPoll counts a text only when it is one of the texts asked for. The page
// is a fake CDP transport that logs every Runtime.evaluate; the handoff part
// uses the fake browser of _fakechrome.ts, answering only evaluations that name
// an execution context (an isolated world).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { FrameScope, waitPoll } from "../../src/daemon/tools/wait.ts";
import { readPoll } from "../../src/daemon/tools/waitspec.ts";
import type { AttachedTarget, CdpEvent, CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await removeTree(r);
});

/** A tab with one same-process child frame and one OOPIF; `answer` decides what an evaluation returns. */
function fakePage(answer: (expression: string, contextId: number | null) => unknown) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const evals: Array<{ sessionId: string | null; contextId: number | null; expression: string }> = [];
  const worlds: Array<{ sessionId: string | null; frameId: unknown; worldName: unknown; ctx: number }> = [];
  let ctx = 100;
  const target = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}, sessionId: string | null = null): Promise<CdpResult> => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Page.getFrameTree") {
        if (sessionId === "S-T1") return { frameTree: { frame: { id: "T1", loaderId: "L1", url: "https://shop.test/" }, childFrames: [{ frame: { id: "F2", loaderId: "L2", url: "https://shop.test/inner" } }] } };
        if (sessionId === "S-OOP") return { frameTree: { frame: { id: "OOP", loaderId: "L3", url: "https://pay.test/" } } };
        return {};
      }
      if (method === "Page.createIsolatedWorld") {
        const c = ++ctx;
        worlds.push({ sessionId, frameId: params["frameId"], worldName: params["worldName"], ctx: c });
        return { executionContextId: c };
      }
      if (method === "Runtime.compileScript") return {};
      if (method === "Runtime.evaluate") {
        const contextId = typeof params["contextId"] === "number" ? params["contextId"] : null;
        const expression = String(params["expression"]);
        evals.push({ sessionId, contextId, expression });
        const v = answer(expression, contextId);
        return { result: v === undefined ? { type: "undefined" } : { type: "object", value: v } };
      }
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => target(id),
    detach: async () => undefined,
    waitAttached: async (id) => target(id),
    targets: () => [{ targetId: "OOP", sessionId: "S-OOP", type: "iframe", url: "https://pay.test/", title: "", parentSessionId: "S-T1", openerId: null }],
  };
  return { t, evals, worlds };
}

async function tabOf(t: Transport) {
  const tabs = new Tabs(t, false);
  const tab = await tabs.createTab("w");
  return { tabs, tab };
}

describe("FrameScope: every frame document in the isolated world", () => {
  test("main frame, same-process child and the OOPIF's own document each get a tabcap-wait world; mainOnly is the main frame's", async () => {
    const f = fakePage(() => undefined);
    const { tabs, tab } = await tabOf(f.t);
    const scope = new FrameScope(f.t, tabs, tab);
    const frames = await scope.frames();
    expect(frames.map((x) => x.frame)).toEqual(["main", "https://shop.test/inner", "https://pay.test/"]);
    for (const x of frames) expect(typeof x.contextId).toBe("number");
    expect(f.worlds.map((w) => [w.sessionId, w.frameId, w.worldName])).toEqual([
      ["S-T1", "T1", "tabcap-wait"],
      ["S-T1", "F2", "tabcap-wait"],
      ["S-OOP", "OOP", "tabcap-wait"],
    ]);
    // made once per document (session, frame, loader), reused on the next poll
    expect((await scope.frames()).map((x) => x.contextId)).toEqual(frames.map((x) => x.contextId));
    expect(f.worlds).toHaveLength(3);
    const main = await scope.frames({ mainOnly: true });
    expect(main).toEqual([{ sessionId: "S-T1", contextId: frames[0]?.contextId ?? -1, frame: "main" }]);
  });
});

describe("wait polls in the isolated world (--fn in the main world)", () => {
  const poll = async (spec: Parameters<typeof waitPoll>[2], answer: (expression: string, contextId: number | null) => unknown, ms = 1500) => {
    const f = fakePage(answer);
    const { tabs, tab } = await tabOf(f.t);
    const out = await waitPoll(f.t, tab, spec, Date.now() + ms, ms, new FrameScope(f.t, tabs, tab)).catch((e: unknown) => e);
    return { out, f };
  };

  test("--text: every evaluation names an isolated world; the page's main world is never asked", async () => {
    const { out, f } = await poll({ kind: "text", texts: ["Welcome"] }, (_x, ctx) => (ctx === null ? { text: "Welcome", context: "main world" } : null), 600);
    expect(out instanceof TabcapError && out.code).toBe("timeout");
    expect(f.evals.length).toBeGreaterThan(0);
    expect(f.evals.filter((e) => e.contextId === null)).toEqual([]);
  });

  test("--text: matched in the isolated world of the main frame", async () => {
    const { out, f } = await poll({ kind: "text", texts: ["Welcome"] }, (_x, ctx) => (ctx === MAIN_CTX ? { text: "Welcome", context: "… Welcome …" } : null));
    expect(out).toMatchObject({ text: "Welcome", context: "… Welcome …", frame: "main" });
    expect(f2ctx(f)).toBe(MAIN_CTX);
  });

  test("--selector: the main frame's isolated world", async () => {
    const { out, f } = await poll({ kind: "selector", selector: "#me" }, (_x, ctx) => (ctx !== null ? { tag: "div", text: "me", visible: true } : null));
    expect(out).toMatchObject({ selector: "#me", tag: "div" });
    expect(f.evals.map((e) => e.contextId)).toEqual([f2ctx(f)]);
  });

  test("--fn stays in the page's main world", async () => {
    const { out, f } = await poll({ kind: "fn", expr: "window.ready" }, (_x, ctx) => (ctx === null ? { value: true } : null));
    expect(out).toMatchObject({ value: true });
    expect(f.evals.every((e) => e.contextId === null)).toBe(true);
  });
});

/** The fake numbers worlds from 101 in the order they are made; the main frame's is made first. */
const MAIN_CTX = 101;

/** The main frame's world: the first one made. */
function f2ctx(f: { worlds: Array<{ ctx: number }> }): number {
  return f.worlds[0]?.ctx ?? -1;
}

describe("readPoll: a text counts only when it is one of the texts asked for", () => {
  test("a record without the text, or with another text, is pending", () => {
    expect(readPoll({ kind: "text", texts: ["t"] }, { context: "… t …" })).toEqual({ state: "pending" });
    expect(readPoll({ kind: "text", texts: ["a", "b"] }, { text: "c", context: "… c …" })).toEqual({ state: "pending" });
    expect(readPoll({ kind: "text", texts: ["a", "b"] }, { text: "b", context: "… b …" })).toEqual({ state: "matched", detail: { text: "b", context: "… b …" } });
  });
});

describe.skipIf(!FAKE_CHROME)("handoff wait --until-text / --until-selector in the isolated world (fake browser, POSIX)", () => {
  async function started(evaluate: Array<{ when: string; value: unknown }>) {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-wiso-"));
    roots.push(dir);
    const p = paths({ TABCAP_HOME: dir });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    const d = new Daemon(p);
    const run = (action: string, args: Record<string, unknown>) => handleCommand(d, { action, args, session: "w" }, () => undefined);
    const env = await run("browser.start", { executablePath: fakeChrome(dir, { evaluate, evaluateNeedsContext: true }), proxy: "none" });
    if (!env.ok) throw new Error(`fake browser did not start: ${JSON.stringify(env.error)}`);
    const b = d.browser;
    if (b === null) throw new Error("no browser");
    const tab = await b.tabs.createTab("w");
    const h = d.guard.takeover("w", { tab: tab.id, url: tab.url, event: "pointerdown", at: 1 }, undefined);
    await h.started;
    return { d, run };
  }

  for (const [flag, arg, when, value] of [
    ["--until-text", "untilText", "innerText", { text: "Welcome", context: "Welcome back" }],
    ["--until-selector", "untilSelector", "querySelector", { tag: "div", text: "", visible: true }],
  ] as const) {
    test(
      `${flag}: the page answers only in an isolated world, and the wait sees it (already true on the first look)`,
      async () => {
        const { d, run } = await started([{ when, value }]);
        try {
          const env = await run("handoff.wait", { [arg]: arg === "untilText" ? "Welcome" : "#me", timeoutMs: 3000 });
          const e: Record<string, unknown> = env.ok ? {} : env.error;
          expect(e["code"]).toBe("waiting");
          expect(String(e["message"])).toContain("already holds");
        } finally {
          await run("browser.stop", {});
        }
        expect(d.browser).toBeNull();
      },
      SLOW_IO_MS,
    );
  }
});
