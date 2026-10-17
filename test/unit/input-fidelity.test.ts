// L0 for 0.3-E input fidelity (docs/06 A7.2, A7.3 fake-CDP half, A7.7) and the
// docs/04 §5.2 rule 9 recorder timer. Oracles: the plan limits the owner set
// (docs/10 §3.3, decisions 10-15), the Playwright type() export on the s46
// probe page (fixtures/probe/oracle/*-type.json) for the key table, and the CDP
// call order a fake transport records. Every random draw comes from a seeded rng.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { RefTable } from "../../src/daemon/browser/refs.ts";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { distanceFromLine, JITTER_PX, keyEventParams, minJerk, PATH_MS, planClick, planTyping, PRESS_GAP_MS, type Rng } from "../../src/daemon/tools/inputplan.ts";
import { paintCheck, pointerClick, trustedClickOn, typeKeys, type PointerDeps } from "../../src/daemon/tools/input.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { CdpTimeoutError } from "../../src/daemon/transport/direct/cdp.ts";
import { until } from "./_platform.ts";
import type { AttachedTarget, CdpEvent, CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

/** mulberry32: a small deterministic rng for the tests. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORACLE_DIR = join(import.meta.dir, "..", "..", "fixtures", "probe", "oracle");
function oracle(mode: string): Record<string, unknown>[] {
  const f = readdirSync(ORACLE_DIR).find((n) => n.endsWith(`-${mode}.json`));
  if (f === undefined) throw new Error(`no oracle export for ${mode}`);
  const doc: unknown = JSON.parse(readFileSync(join(ORACLE_DIR, f), "utf8"));
  const report = isRecord(doc) && isRecord(doc["report"]) ? doc["report"] : {};
  return Array.isArray(report["events"]) ? report["events"].filter(isRecord) : [];
}

describe("A7.2 click path plan (pure, seeded rng)", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 171, y: 185.9375 };

  test("1000 plans: duration in [100, 400] ms, >= 25 points/s, last point exactly the target, press gap in [50, 140] ms", () => {
    const rng = seeded(46);
    for (let i = 0; i < 1000; i++) {
      const start = { x: Math.round(rng() * 1200), y: Math.round(rng() * 800) };
      const p = planClick(start, to, rng);
      expect(p.durationMs).toBeGreaterThanOrEqual(PATH_MS.min);
      expect(p.durationMs).toBeLessThanOrEqual(PATH_MS.max);
      expect((p.points.length * 1000) / p.durationMs).toBeGreaterThanOrEqual(25);
      expect(p.points.length).toBeGreaterThanOrEqual(3);
      expect(p.points.at(-1)).toEqual({ x: to.x, y: to.y, atMs: p.durationMs });
      expect(p.pressGapMs).toBeGreaterThanOrEqual(PRESS_GAP_MS.min);
      expect(p.pressGapMs).toBeLessThanOrEqual(PRESS_GAP_MS.max);
      // scheduled times strictly increase and end at the duration
      for (let k = 1; k < p.points.length; k++) expect(p.points[k]?.atMs ?? 0).toBeGreaterThan(p.points[k - 1]?.atMs ?? 0);
      // without scatter every point is on the straight line (0.01 px rounding)
      for (const q of p.points) expect(distanceFromLine(q, start, to)).toBeLessThanOrEqual(0.01);
    }
  });

  test("scatter on: intermediate points stay within 0.4 px of the line; the last point is still exact", () => {
    const rng = seeded(7);
    let maxOff = 0;
    for (let i = 0; i < 1000; i++) {
      const p = planClick(from, to, rng, { jitterPx: JITTER_PX });
      for (const q of p.points.slice(0, -1)) maxOff = Math.max(maxOff, distanceFromLine(q, from, to));
      expect(p.points.at(-1)).toMatchObject({ x: to.x, y: to.y });
    }
    expect(maxOff).toBeLessThanOrEqual(JITTER_PX + 0.01);
    expect(maxOff).toBeGreaterThan(0.2); // the scatter really is applied
  });

  test("same seed, same plan; the scatter is off by default", () => {
    expect(planClick(from, to, seeded(1))).toEqual(planClick(from, to, seeded(1)));
    expect(planClick(from, to, seeded(1))).not.toEqual(planClick(from, to, seeded(2)));
    expect(planClick(from, to, seeded(3))).toEqual(planClick(from, to, seeded(3), { jitterPx: 0 }));
  });

  test("minimum-jerk easing: 0 → 1, symmetric, monotone; a bad rng value is clamped", () => {
    expect([minJerk(0), minJerk(0.5), minJerk(1)]).toEqual([0, 0.5, 1]);
    for (let x = 0; x < 1; x += 0.05) expect(minJerk(x + 0.05)).toBeGreaterThanOrEqual(minJerk(x));
    const bad = planClick(from, to, () => Number.NaN);
    expect([bad.durationMs, bad.pressGapMs]).toEqual([PATH_MS.min, PRESS_GAP_MS.min]);
    const high = planClick(from, to, () => 7);
    expect([high.durationMs, high.pressGapMs]).toEqual([PATH_MS.max, PRESS_GAP_MS.max]);
    const zero = planClick(to, to, seeded(5));
    expect(zero.points.every((q) => Math.abs(q.x - to.x) <= 0.01 && Math.abs(q.y - to.y) <= 0.01)).toBe(true);
  });
});

describe("typing plan against the Playwright type() oracle (s46)", () => {
  test("keys of 'aB3 中' are the oracle's keydown key / code / keyCode; '中' has no key", () => {
    const downs = oracle("type").filter((e) => e["type"] === "keydown").map((e) => [e["key"], e["code"], e["keyCode"]]);
    const plan = planTyping("aB3 中");
    const keys: unknown[] = plan.flatMap((k) => (k.kind === "key" ? [[k.key, k.code, k.keyCode]] : []));
    expect(keys).toEqual(downs);
    expect(plan.filter((k) => k.kind === "insert").map((k) => k.char)).toEqual(["中"]);
    // the oracle's capital B has no Shift: shiftKey false on every keyboard event
    expect(oracle("type").filter((e) => typeof e["key"] === "string").every((e) => e["shiftKey"] === false)).toBe(true);
  });

  test("key event params: keyDown with text (no modifiers, as Playwright sends them), keyUp without", () => {
    const [b] = planTyping("B");
    if (b === undefined || b.kind !== "key") throw new Error("B has a key");
    expect(keyEventParams(b)).toEqual({
      down: { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: 66, code: "KeyB", key: "B", location: 0, isKeypad: false, text: "B", unmodifiedText: "B", autoRepeat: false },
      up: { type: "keyUp", modifiers: 0, windowsVirtualKeyCode: 66, code: "KeyB", key: "B", location: 0, isKeypad: false },
    });
    expect(planTyping("!\n\t😀").map((k) => (k.kind === "key" ? `${k.code}:${k.keyCode}:${JSON.stringify(k.text)}` : `insert:${k.char}`))).toEqual(["Digit1:49:\"!\"", "Enter:13:\"\\r\"", "insert:\t", "insert:😀"]);
  });
});

// ---------------------------------------------------------------- fake CDP

type Call = { method: string; params: CdpParams; timeoutMs: number | undefined };

/** `frames`: the frame gap each paint check reports, in order (the last one repeats); default 16 ms. */
function fakeChrome(
  o: { raf?: boolean; visibility?: string; moveTimeoutAt?: number; delivered?: boolean; frames?: Array<number | null>; probeReadFails?: boolean; onRelease?: () => void } = {},
) {
  const calls: Call[] = [];
  let moves = 0;
  let checks = 0;
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}, _sid?: string | null, timeoutMs?: number): Promise<CdpResult> => {
      calls.push({ method, params, timeoutMs });
      if (method === "Runtime.evaluate") {
        const frames = o.frames ?? [16];
        const frameMs = frames[Math.min(checks++, frames.length - 1)] ?? null;
        return { result: { value: { raf: o.raf ?? true, frameMs, visibility: o.visibility ?? "visible" } } };
      }
      if (method === "DOM.getBoxModel") return { model: { content: [41, 141, 301, 141, 301, 231, 41, 231] } };
      if (method === "Runtime.callFunctionOn") {
        const fn = typeof params["functionDeclaration"] === "string" ? params["functionDeclaration"] : "";
        if (fn.includes("elementFromPoint")) return { result: { value: { ok: true, hit: "div#target" } } };
        if (fn.includes("addEventListener(\"pointerdown\"")) return { result: { objectId: "probe-1" } };
        if (fn.includes("this.off()")) {
          // A navigation committed: the old execution context is gone.
          if (o.probeReadFails === true) throw new Error("Runtime.callFunctionOn: Cannot find context with specified id");
          return { result: { value: { pointerdown: o.delivered ?? true, mousedown: o.delivered ?? true } } };
        }
        if (fn.includes("el.click()")) return { result: { value: { ok: true, tag: "div" } } };
        return { result: { value: { ok: true } } };
      }
      if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseMoved") {
        moves++;
        if (o.moveTimeoutAt !== undefined && moves >= o.moveTimeoutAt) throw new CdpTimeoutError(method, timeoutMs ?? 0);
      }
      if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseReleased") o.onRelease?.();
      return {};
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: () => Promise.reject(new Error("unused")),
    detach: async () => undefined,
    waitAttached: () => Promise.reject(new Error("unused")),
    targets: () => [],
  };
  const mouse = () => calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => String(c.params["type"]));
  return { t, calls, mouse };
}

function fakeTab(): Tab {
  return {
    id: "t1",
    targetId: "T1",
    sessionId: "S1",
    session: "s46",
    owned: true,
    reason: "ai-opened",
    opener: null,
    url: "http://127.0.0.1:9/probe",
    title: "input probe",
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
    emulation: {},
  };
}

/** No real waiting: sleeps are recorded, the clock advances by them. */
function instantDeps(seed: number): PointerDeps & { slept: number[] } {
  let clock = 0;
  const slept: number[] = [];
  return {
    rng: seeded(seed),
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    moveTimeoutMs: 1000,
    slept,
  };
}

const NODE = { objectId: "node-1", backendNodeId: 12 };

describe("click --trusted on a fake Chrome", () => {
  test("painted tab: emulation on → paint check → moves along the plan → press (force 0.5) → gap → release → emulation off", async () => {
    const { t, calls, mouse } = fakeChrome();
    const tab = fakeTab();
    const deps = instantDeps(11);
    const r = await trustedClickOn(t, tab, NODE, "e3", deps);
    if (r.kind !== "clicked") throw new Error("expected a click");
    const plan = planClick({ x: 0, y: 0 }, { x: 171, y: 186 }, seeded(11));
    expect(r.result.plan).toEqual(plan);
    expect(mouse()).toEqual([...plan.points.map(() => "mouseMoved"), "mousePressed", "mouseReleased"]);
    const moves = calls.filter((c) => c.params["type"] === "mouseMoved");
    expect(moves.map((c) => [c.params["x"], c.params["y"]])).toEqual(plan.points.map((p) => [p.x, p.y]));
    expect(moves.every((c) => c.timeoutMs === 1000 && c.params["button"] === "none" && c.params["buttons"] === 0)).toBe(true);
    const press = calls.find((c) => c.params["type"] === "mousePressed");
    expect(press?.params).toMatchObject({ x: 171, y: 186, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
    expect(calls.find((c) => c.params["type"] === "mouseReleased")?.params).toMatchObject({ x: 171, y: 186, button: "left", buttons: 0, clickCount: 1 });
    // the last sleep is the press gap; the move sleeps follow the schedule
    expect(deps.slept.at(-1)).toBe(plan.pressGapMs);
    expect(deps.slept.slice(0, -1).reduce((a, b) => a + b, 0)).toBeCloseTo(plan.durationMs, 5);
    const order = calls.map((c) => (c.method === "Emulation.setFocusEmulationEnabled" ? `emu:${String(c.params["enabled"])}` : c.method));
    expect(order[0]).toBe("emu:true");
    expect(order.at(-1)).toBe("emu:false");
    expect(order.indexOf("Runtime.evaluate")).toBeLessThan(order.indexOf("Input.dispatchMouseEvent"));
    // the tab remembers where the pointer is; the next path starts there
    expect(tab.pointer).toEqual({ x: 171, y: 186 });
    const again = await trustedClickOn(fakeChrome().t, tab, NODE, "e3", instantDeps(12));
    expect(again.kind === "clicked" ? again.from : null).toEqual({ x: 171, y: 186 });
  });

  test("A7.3: rAF never fires (or the tab stays hidden) → DOM click, not one mouse event sent", async () => {
    for (const o of [{ raf: false, visibility: "hidden" }, { raf: true, visibility: "hidden" }, { raf: false, visibility: "visible" }]) {
      const { t, calls, mouse } = fakeChrome(o);
      const r = await trustedClickOn(t, fakeTab(), NODE, "e3", instantDeps(1));
      expect(r.kind).toBe("degraded");
      expect(mouse()).toEqual([]);
      expect(calls.some((c) => c.method === "Runtime.callFunctionOn" && String(c.params["functionDeclaration"]).includes("el.click()"))).toBe(true);
      expect(calls.at(-1)?.params).toEqual({ enabled: false });
    }
  });

  test("paint check: a CDP timeout or exception counts as not painted", async () => {
    const t: Transport = { ...fakeChrome().t, send: () => Promise.reject(new CdpTimeoutError("Runtime.evaluate", 2000)) };
    expect(await paintCheck(t, "S1")).toMatchObject({ painted: false, raf: false });
    const { t: ok } = fakeChrome();
    expect(await paintCheck(ok, "S1")).toEqual({ painted: true, raf: true, visibility: "visible", frameMs: 16, error: null });
  });

  test("full-rate frames: no screencast", async () => {
    const { t, calls } = fakeChrome();
    const r = await trustedClickOn(t, fakeTab(), NODE, "e3", instantDeps(2));
    expect(r.kind === "clicked" ? r.held : "degraded").toBeNull();
    expect(calls.some((c) => c.method.includes("Screencast"))).toBe(false);
  });

  test("throttled frames (Linux background tab, 1 per second): a tiny screencast runs from before the first move until after the release, reported as held", async () => {
    for (const first of [null, 1017]) {
      const { t, calls, mouse } = fakeChrome({ frames: [first, 17] });
      const r = await trustedClickOn(t, fakeTab(), NODE, "e3", instantDeps(3));
      if (r.kind !== "clicked") throw new Error("expected a click");
      expect(r.held).toEqual({ raf: true, frameMs: first, visibility: "visible", held: "screencast" });
      expect(mouse().at(-1)).toBe("mouseReleased");
      const order = calls.map((c) => (c.method === "Input.dispatchMouseEvent" ? `mouse:${String(c.params["type"])}` : c.method));
      const start = order.indexOf("Page.startScreencast");
      expect(start).toBeGreaterThan(-1);
      expect(start).toBeLessThan(order.indexOf("mouse:mouseMoved"));
      expect(order.filter((m) => m === "Runtime.evaluate").length).toBe(2); // checked again with the screencast on
      expect(order.slice(-2)).toEqual(["Page.stopScreencast", "Emulation.setFocusEmulationEnabled"]);
      expect(order.lastIndexOf("mouse:mouseReleased")).toBeLessThan(order.indexOf("Page.stopScreencast"));
    }
  });

  test("throttled frames the screencast does not fix: screencast stopped before any move, the click goes on unheld; a move timeout still aborts", async () => {
    const { t, calls, mouse } = fakeChrome({ frames: [null, null], moveTimeoutAt: 1 });
    const err = await trustedClickOn(t, fakeTab(), NODE, "e3", instantDeps(5)).catch((e: unknown) => e);
    expect(err instanceof TabcapError ? err.code : String(err)).toBe("move-timeout");
    expect(mouse()).toEqual(["mouseMoved"]);
    const order = calls.map((c) => c.method);
    expect(order.indexOf("Page.stopScreencast")).toBeLessThan(order.indexOf("Input.dispatchMouseEvent"));
    expect(order.filter((m) => m.includes("Screencast"))).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(calls.at(-1)?.params).toEqual({ enabled: false });
  });

  test("a hidden tab gets no screencast: degraded as before", async () => {
    const { t, calls } = fakeChrome({ visibility: "hidden", frames: [null] });
    expect((await trustedClickOn(t, fakeTab(), NODE, "e3", instantDeps(6))).kind).toBe("degraded");
    expect(calls.some((c) => c.method.includes("Screencast"))).toBe(false);
  });

  test("A7.7: a move that times out aborts at once — move-timeout, nothing pressed, no second try", async () => {
    const { t, mouse } = fakeChrome({ moveTimeoutAt: 2 });
    const tab = fakeTab();
    const err = await trustedClickOn(t, tab, NODE, "e3", instantDeps(4)).catch((e: unknown) => e);
    expect(err instanceof TabcapError ? err.code : String(err)).toBe("move-timeout");
    expect(mouse()).toEqual(["mouseMoved", "mouseMoved"]);
    expect(tab.pointer).not.toBeNull(); // the first, acknowledged move
  });

  test("A7.7: not delivered → one press, one release, not-delivered without a retry hint", async () => {
    const { t, mouse } = fakeChrome({ delivered: false });
    const err = await pointerClick(t, "S1", "node-1", "e3", { x: 0, y: 0 }, { x: 10, y: 10 }, instantDeps(9)).catch((e: unknown) => e);
    expect(err instanceof TabcapError ? [err.code, err.next.includes("did not retry")] : String(err)).toEqual(["not-delivered", true]);
    expect(mouse().filter((m) => m !== "mouseMoved")).toEqual(["mousePressed", "mouseReleased"]);
  });

  test("0.7.3: probe read fails after the press + the tab navigated → delivered unknown/navigated (no error)", async () => {
    const tab = fakeTab();
    const { t, mouse } = fakeChrome({
      probeReadFails: true,
      onRelease: () => {
        // The navigation commit, as Page.frameNavigated records it.
        tab.navEpoch++;
        tab.url = "http://127.0.0.1:9/second";
      },
    });
    const r = await trustedClickOn(t, tab, NODE, "e3", instantDeps(21));
    if (r.kind !== "clicked") throw new Error("expected a click");
    expect(r.result.delivered).toEqual({ pointerdown: "unknown", mousedown: "unknown", reason: "navigated" });
    expect(mouse().filter((m) => m !== "mouseMoved")).toEqual(["mousePressed", "mouseReleased"]);
  });

  test("0.7.3: probe read fails and the tab did not navigate → not-delivered, no retry", async () => {
    const { t, mouse } = fakeChrome({ probeReadFails: true });
    const nav = { mark: () => ({ epoch: 0, url: "http://127.0.0.1:9/probe" }), navigated: () => false, wait: async () => false };
    const err = await pointerClick(t, "S1", "node-1", "e3", { x: 0, y: 0 }, { x: 10, y: 10 }, instantDeps(22), () => undefined, 1, "S1", nav).catch((e: unknown) => e);
    expect(err instanceof TabcapError ? [err.code, err.next.includes("did not retry"), err.message.includes("could not be read")] : String(err)).toEqual(["not-delivered", true, true]);
    expect(mouse().filter((m) => m !== "mouseMoved")).toEqual(["mousePressed", "mouseReleased"]);
  });
});

describe("type --trusted on a fake Chrome", () => {
  test("'aB3 中': keyDown + keyUp per key, one insertText for '中'; --delay sleeps between characters only", async () => {
    const { t, calls } = fakeChrome();
    const slept: number[] = [];
    const r = await typeKeys(t, "S1", "aB3 中", 30, async (ms) => slept.push(ms));
    expect(r).toEqual({ keys: 4, inserted: 1 });
    expect(calls.map((c) => (c.method === "Input.insertText" ? `insert:${String(c.params["text"])}` : `${String(c.params["type"])}:${String(c.params["key"])}`))).toEqual([
      "keyDown:a",
      "keyUp:a",
      "keyDown:B",
      "keyUp:B",
      "keyDown:3",
      "keyUp:3",
      "keyDown: ",
      "keyUp: ",
      "insert:中",
    ]);
    expect(slept).toEqual([30, 30, 30, 30]);
    const none: number[] = [];
    await typeKeys(fakeChrome().t, "S1", "ab", 0, async (ms) => none.push(ms));
    expect(none).toEqual([]);
  });
});

// ---------------------------------------------------------------- recorder timer

function recorderChrome(bodyFor: Record<string, string>) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}) => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Fetch.getResponseBody") {
        const b = bodyFor[String(params["requestId"])];
        if (b === undefined) throw new Error("no body");
        return { body: b, base64Encoded: false };
      }
      if (method === "Network.getResponseBody") return { body: "network-body", base64Encoded: false };
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => target(),
    detach: async () => undefined,
    waitAttached: async () => target(),
    targets: () => [],
  };
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const l of [...listeners]) l({ method, params, sessionId: "S1" });
  };
  return { t, emit };
}

describe("docs/04 §5.2 rule 9: bodies the page never reads", () => {
  test("Fetch holds the body and no loadingFinished within the delay → finished, end null, bodySource fetch, unreadByPage; visible in the index while recording", async () => {
    const { t, emit } = recorderChrome({ I1: '{"n":1}' });
    const tabs = new Tabs(t, false);
    await tabs.createTab("s46");
    const dir = join(mkdtempSync(join(tmpdir(), "tabcap-unread-")), "b");
    const rec = await Recorder.start({ session: "s46", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" }, unreadAfterMs: 40 });
    const url = "http://127.0.0.1:9/api/limited";
    emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", type: "Fetch", timestamp: 10, wallTime: 1760500000, request: { url, method: "GET", headers: {} } });
    emit("Fetch.requestPaused", { requestId: "I1", networkId: "R1", resourceType: "Fetch", frameId: "T1", responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }] });
    await Bun.sleep(5);
    emit("Network.responseReceived", { requestId: "R1", type: "Fetch", timestamp: 10.2, response: { status: 200, headers: { "content-type": "application/json" }, mimeType: "application/json" } });
    expect(rec.index).toEqual([]);
    await Bun.sleep(25);
    expect(rec.index).toEqual([]); // not before the delay
    await Bun.sleep(80);
    // The timer fired by now; the write behind it (blob to disk) can lag on a
    // Windows runner, where 80 ms was not always enough.
    await until(() => rec.index.length > 0);
    expect(rec.index.map((e) => [e.url, e.outcome, e.unreadByPage, e.blob !== null])).toEqual([[url, "finished", true, true]]);
    // a late loadingFinished (the page read it after all) does not write it twice
    emit("Network.loadingFinished", { requestId: "R1", timestamp: 12 });
    await rec.stop();
    const reqs = BundleReader.open(dir).requests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ outcome: "finished", bodySource: "fetch", unreadByPage: true, timing: { end: null } });
    expect(reqs[0]?.response?.body?.size).toBe(7);
  });

  test("no Fetch body → nothing early, closed at stop as before; a loadingFinished in time → plain finished", async () => {
    const { t, emit } = recorderChrome({ I2: "body-2" });
    const tabs = new Tabs(t, false);
    await tabs.createTab("s46");
    const dir = join(mkdtempSync(join(tmpdir(), "tabcap-unread-")), "b");
    const rec = await Recorder.start({ session: "s46", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" }, unreadAfterMs: 30 });
    // R1: response, never a Fetch body, never finished
    emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", type: "Other", timestamp: 10, wallTime: 1760500000, request: { url: "http://127.0.0.1:9/stream", method: "GET", headers: {} } });
    emit("Network.responseReceived", { requestId: "R1", type: "Other", timestamp: 10.1, response: { status: 200, headers: {}, mimeType: "text/plain" } });
    // R2: Fetch body, then loadingFinished before the delay
    emit("Network.requestWillBeSent", { requestId: "R2", loaderId: "L1", type: "Fetch", timestamp: 11, wallTime: 1760500001, request: { url: "http://127.0.0.1:9/api/read", method: "GET", headers: {} } });
    emit("Fetch.requestPaused", { requestId: "I2", networkId: "R2", resourceType: "Fetch", frameId: "T1", responseStatusCode: 200, responseHeaders: [] });
    await Bun.sleep(5);
    emit("Network.responseReceived", { requestId: "R2", type: "Fetch", timestamp: 11.1, response: { status: 200, headers: {}, mimeType: "text/plain" } });
    emit("Network.loadingFinished", { requestId: "R2", timestamp: 11.2 });
    await Bun.sleep(100);
    await until(() => rec.index.length > 0); // R2's write, as above
    expect(rec.index.map((e) => [e.url, e.outcome, e.unreadByPage ?? false])).toEqual([["http://127.0.0.1:9/api/read", "finished", false]]);
    await rec.stop();
    const reqs = BundleReader.open(dir).requests();
    expect(reqs.map((r) => [r.url, r.outcome, r["unreadByPage"] ?? null])).toEqual([
      ["http://127.0.0.1:9/api/read", "finished", null],
      ["http://127.0.0.1:9/stream", "incomplete", null],
    ]);
  });
});
