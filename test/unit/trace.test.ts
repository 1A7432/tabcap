// 0.4-F trace mode, offline. Oracles: docs/04 §4.1 `signal` and §7
// (`mode.trace`, `traceWindows`) as written in the owner's 10-16 design, the
// synthetic `Debugger.paused` payloads below (shaped like the spike's CfT 155
// logs: callFrames[].url empty, scriptId → scriptParsed), and the signal list
// format (a JSON array of strings, ≤ 500). Real-browser coverage:
// test/e2e/v04f.e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, parseTraceMode, parseTraceWindows } from "../../src/bundle/manifest.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";
import type { TraceMode } from "../../src/bundle/types.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { classifyPause, cutBytes, TraceBook, type DocRef, type Hit, type PauseFrame, type ScriptInfo } from "../../src/daemon/trace/aggregate.ts";
import { builtinSignalList, DEFAULT_SIGNALS_JSON, defaultSignals, INSTRUMENTATION_EVENTS, notRecorded, parseSignalList, resolverExpression, valueExpression } from "../../src/daemon/trace/signals.ts";
import { renderTraceText, traceTable } from "../../src/daemon/trace/table.ts";
import { MonoClock, TRACE_NOTICE, Tracer } from "../../src/daemon/trace/tracer.ts";
import { loadSignalList } from "../../src/daemon/tools/trace.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;

describe("signal list (signals.json, docs/04 §4.1)", () => {
  test("the built-in list has the brief's names, in IDL form, and its hash is the sha256 of the embedded JSON text", () => {
    const names = defaultSignals();
    for (const n of [
      "Navigator.prototype.userAgent",
      "Navigator.prototype.webdriver",
      "NavigatorUAData.prototype.getHighEntropyValues",
      "Permissions.prototype.query",
      "MediaDevices.prototype.enumerateDevices",
      "Screen.prototype.pixelDepth",
      "Intl.DateTimeFormat.prototype.resolvedOptions",
      "Date.prototype.getTimezoneOffset",
      "HTMLCanvasElement.prototype.toBlob",
      "CanvasRenderingContext2D.prototype.getImageData",
      "WebGL2RenderingContext.prototype.getSupportedExtensions",
      "SpeechSynthesis.prototype.getVoices",
      "FontFaceSet.prototype.check",
    ])
      expect(names).toContain(n);
    for (const n of ["Performance.prototype.now", "Date.now", "Math.random"]) expect(names).not.toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(builtinSignalList().hash).toBe(sha(DEFAULT_SIGNALS_JSON));
    expect(INSTRUMENTATION_EVENTS).toEqual(["canvasContextCreated", "webglErrorFired", "audioContextCreated", "audioContextClosed"]);
  });

  test("an override file: strings only, at most 500, unknown names skipped with a warning, duplicates once; hash of the file text", () => {
    const text = JSON.stringify(["Navigator.prototype.userAgent", "not a name", "Navigator.prototype.userAgent", "x", "Screen.prototype.width", "a.b;alert(1)"]);
    const l = parseSignalList(text, "signals.json");
    expect(l.names).toEqual(["Navigator.prototype.userAgent", "Screen.prototype.width"]);
    expect(l.warnings.length).toBe(3);
    expect(l.warnings[0]).toContain("not a name");
    expect(l.hash).toBe(sha(text));
    const bad = (t: string) => {
      try {
        parseSignalList(t, "f");
      } catch (e) {
        return e instanceof TabcapError ? e.code : "other";
      }
      return "accepted";
    };
    expect(bad("{")).toBe("bad-input");
    expect(bad('{"a":1}')).toBe("bad-input");
    expect(bad('["Navigator.prototype.userAgent", 3]')).toBe("bad-input");
    expect(bad(JSON.stringify(Array.from({ length: 501 }, (_, i) => `A${i}.prototype.x`)))).toBe("bad-input");
    expect(bad(JSON.stringify(Array.from({ length: 500 }, (_, i) => `A${i}.prototype.x`)))).toBe("accepted");
  });

  test("source order: --apis file, else config/signals.json, else built-in", () => {
    const dir = tmp("tabcap-signals-");
    expect(loadSignalList(dir, null).source).toBe("built-in");
    writeFileSync(join(dir, "signals.json"), '["Screen.prototype.width"]');
    expect(loadSignalList(dir, null).names).toEqual(["Screen.prototype.width"]);
    const other = join(dir, "mine.json");
    writeFileSync(other, '["Navigator.prototype.vendor"]');
    expect(loadSignalList(dir, other)).toMatchObject({ names: ["Navigator.prototype.vendor"], source: other });
    expect(() => loadSignalList(dir, join(dir, "missing.json"))).toThrow(TabcapError);
  });

  test("the resolver only reads descriptors (no getter call, no assignment) and embeds names as JSON", () => {
    const e = resolverExpression(['Navigator.prototype.userAgent', 'A."b']);
    expect(e).toContain(JSON.stringify(['Navigator.prototype.userAgent', 'A."b']));
    expect(e).toContain("Object.getOwnPropertyDescriptor");
    expect(e).not.toMatch(/\.call\(|\.apply\(|defineProperty|=\s*function/);
    // evaluate it here: a getter is returned, never invoked
    let calls = 0;
    const g = globalThis as Record<string, unknown>;
    class Probe {
      get secret(): string {
        calls++;
        return "v";
      }
    }
    g["Probe"] = Probe;
    try {
      const out: unknown = (0, eval)(resolverExpression(["Probe.prototype.secret", "Probe.prototype.none", "Nope.prototype.x"]));
      expect(Array.isArray(out)).toBe(true);
      const arr = Array.isArray(out) ? out : [];
      expect([typeof arr[0], arr[1], arr[2], arr[3], arr[4], arr[6], arr[7]]).toEqual(["function", "get", "Probe.prototype.secret", undefined, "missing", undefined, "missing"]);
      expect(calls).toBe(0);
    } finally {
      delete g["Probe"];
    }
  });

  test("values: argument-free reads only; cookies, storage and form values are never read", () => {
    expect(valueExpression("Navigator.prototype.userAgent")).toBe("navigator.userAgent");
    expect(valueExpression("Screen.prototype.width")).toBe("screen.width");
    for (const n of ["HTMLCanvasElement.prototype.toDataURL", "WebGLRenderingContext.prototype.getParameter", "SpeechSynthesis.prototype.getVoices", "Permissions.prototype.query", "FontFaceSet.prototype.check"]) expect(valueExpression(n)).toBeNull();
    for (const n of ["Document.prototype.cookie", "Storage.prototype.getItem", "HTMLInputElement.prototype.value", "Window.prototype.localStorage"]) expect(notRecorded(n)).toBe(true);
    expect(notRecorded("Navigator.prototype.userAgent")).toBe(false);
  });
});

// ---------------------------------------------------------------- pauses and aggregation

const scripts = new Map<string, ScriptInfo>([
  ["11", { url: "http://127.0.0.1:4310/fp.js", ctx: 3, frameId: "F1", isDefault: true }],
  ["12", { url: "http://127.0.0.1:4310/lib.js", ctx: 3, frameId: "F1", isDefault: true }],
]);
const frame = (scriptId: string, line: number, col: number) => ({ callFrameId: `cf-${scriptId}-${line}`, functionName: "f", url: "", location: { scriptId, lineNumber: line, columnNumber: col } });

describe("Debugger.paused classification (synthetic payloads, CfT 155 shape)", () => {
  const bps = new Map([["7:1", { api: "Navigator.prototype.userAgent", access: "get" as const }]]);
  test("our breakpoint: hits by id, script URL from scriptParsed (callFrames[].url is empty)", () => {
    const p = classifyPause({ reason: "other", hitBreakpoints: ["7:1", "9:9"], callFrames: [frame("11", 2, 19), frame("12", 40, 3)] }, bps, (id) => scripts.get(id));
    expect(p.kind).toBe("bp");
    if (p.kind !== "bp") return;
    expect(p.hits).toEqual([{ bpId: "7:1", info: { api: "Navigator.prototype.userAgent", access: "get" } }]);
    expect(p.frames.map((f) => [f.url, f.line, f.col])).toEqual([
      ["http://127.0.0.1:4310/fp.js", 2, 19],
      ["http://127.0.0.1:4310/lib.js", 40, 3],
    ]);
  });

  test("scriptFirstStatement → install; listed instrumentation → event with data as args; anything else → other", () => {
    expect(classifyPause({ reason: "EventListener", data: { eventName: "instrumentation:scriptFirstStatement" }, callFrames: [frame("11", 0, 0)] }, bps, (id) => scripts.get(id)).kind).toBe("install");
    const ev = classifyPause({ reason: "EventListener", data: { eventName: "instrumentation:webglErrorFired", webglErrorName: "INVALID_ENUM" }, callFrames: [frame("11", 6, 4)] }, bps, (id) => scripts.get(id));
    expect(ev).toMatchObject({ kind: "event", api: "instrumentation:webglErrorFired", args: '{"webglErrorName":"INVALID_ENUM"}' });
    for (const p of [
      { reason: "other", callFrames: [frame("11", 1, 1)] }, // a page `debugger;` statement
      { reason: "EventListener", data: { eventName: "instrumentation:setTimeout" } },
      { reason: "other", hitBreakpoints: ["unknown"] },
      { hitBreakpoints: "7:1" },
      {},
    ])
      expect(classifyPause(p, bps, (id) => scripts.get(id)).kind).toBe("other");
    expect(cutBytes("ab中", 3)).toBe("ab");
  });
});

const doc = (key: string, extra: Partial<DocRef> = {}): DocRef => ({ key, sessionId: "S1", tab: "t1", frame: "root", nav: "n-3", url: "http://127.0.0.1:4310/", realm: "window", ...extra });
const fr = (scriptId: string, url: string, line: number, col = 0): PauseFrame => ({ scriptId, url, line, col, callFrameId: null });
const hit = (d: DocRef, api: string, frames: PauseFrame[], mono: number | null = 1, kind: "page" | "tabcap" = "page"): Hit => ({ doc: d, api, access: "get", args: null, frames, callerKind: kind, mono });

describe("TraceBook: aggregation per (document, api, caller), firstN, maxHits", () => {
  test("one aggregate per caller location, counts and first / last mono; stack cut to `stack` frames", () => {
    const b = new TraceBook({ stack: 2, firstN: 20, maxHits: 500 });
    const d = doc("S1:3");
    const deep = [fr("11", "u/fp.js", 2, 19), fr("12", "u/lib.js", 40, 3), fr("12", "u/lib.js", 50, 1)];
    expect(b.record(hit(d, "Navigator.prototype.userAgent", deep, 10))).toEqual({ counted: true, firstOfApi: true, truncateNow: false });
    expect(b.record(hit(d, "Navigator.prototype.userAgent", deep, 12)).firstOfApi).toBe(false);
    b.record(hit(d, "Navigator.prototype.userAgent", [fr("11", "u/fp.js", 9, 1)], 13));
    b.record(hit(d, "Navigator.prototype.userAgent", [fr("99", "", 0, 10)], 14, "tabcap"));
    const aggs = b.finish("S1:3");
    expect(aggs.map((a) => [a.caller.url, a.caller.line, a.caller.kind, a.count, a.firstMono, a.lastMono, a.stack.length])).toEqual([
      ["u/fp.js", 2, "page", 2, 10, 12, 2],
      ["u/fp.js", 9, "page", 1, 13, 13, 1],
      ["", 0, "tabcap", 1, 14, 14, 1],
    ]);
    expect(b.finish("S1:3")).toEqual([]);
  });

  test("maxHits per API per document: the hit that reaches it asks for removal, later hits are not counted, every aggregate of that API is truncated", () => {
    const b = new TraceBook({ stack: 8, firstN: 20, maxHits: 3 });
    const d = doc("S1:3");
    const r = [1, 2, 3, 4, 5].map((i) => b.record(hit(d, "Navigator.prototype.userAgent", [fr("11", "u", i % 2)])));
    expect(r.map((x) => [x.counted, x.truncateNow])).toEqual([
      [true, false],
      [true, false],
      [true, true],
      [false, false],
      [false, false],
    ]);
    b.record(hit(d, "Screen.prototype.width", [fr("11", "u", 7)]));
    b.record(hit(doc("S1:4"), "Navigator.prototype.userAgent", [fr("11", "u", 1)]));
    const aggs = b.finish("S1:3");
    expect(aggs.map((a) => [a.api, a.count, a.truncated])).toEqual([
      // counted hits 1..3 came from lines 1, 0, 1 (i % 2)
      ["Navigator.prototype.userAgent", 2, true],
      ["Navigator.prototype.userAgent", 1, true],
      ["Screen.prototype.width", 1, false],
    ]);
    expect(aggs.filter((a) => a.api === "Navigator.prototype.userAgent").reduce((n, a) => n + a.count, 0)).toBe(3);
    expect(b.finish("S1:4").map((a) => [a.count, a.truncated])).toEqual([[1, false]]);
  });

  test("firstN: per (api, caller url:line:col) only the first N aggregates carry a stack, across documents", () => {
    const b = new TraceBook({ stack: 8, firstN: 2, maxHits: 500 });
    for (let i = 0; i < 4; i++) b.record(hit(doc(`S1:${i}`), "Navigator.prototype.userAgent", [fr(`s${i}`, "u/fp.js", 2, 19)]));
    b.record(hit(doc("S1:9"), "Navigator.prototype.userAgent", [fr("x", "u/fp.js", 3, 1)]));
    const stacks = [0, 1, 2, 3, 9].map((i) => b.finish(`S1:${i}`)[0]?.stack.length);
    expect(stacks).toEqual([1, 1, 0, 0, 1]);
  });

  test("drain hands over the counts so far and starts them again; hit totals and truncation stay", () => {
    const b = new TraceBook({ stack: 8, firstN: 20, maxHits: 2 });
    const d = doc("S1:3");
    b.record(hit(d, "A.prototype.a", [fr("11", "u", 1)]));
    expect(b.drain().map((a) => a.count)).toEqual([1]);
    expect(b.record(hit(d, "A.prototype.a", [fr("11", "u", 1)])).truncateNow).toBe(true);
    expect(b.record(hit(d, "A.prototype.a", [fr("11", "u", 1)])).counted).toBe(false);
    expect(b.summaries()).toEqual([{ tab: "t1", frame: "root", nav: "n-3", url: "http://127.0.0.1:4310/", realm: "window", hits: 2, apis: 1, truncated: ["A.prototype.a"] }]);
    expect(b.finish("S1:3").map((a) => [a.count, a.truncated])).toEqual([[1, true]]);
  });

  test("MonoClock: CDP monotonic ms from the least delayed event", () => {
    let local = 1000;
    const c = new MonoClock(() => local);
    expect(c.now()).toBeNull();
    c.observe(5.0); // 5000 ms CDP at local 1000 → offset 4000
    local = 1005;
    c.observe(5.004); // offset 3999: more delayed, ignored
    local = 1010;
    expect(c.now()).toBe(5010);
  });
});

// ---------------------------------------------------------------- trace list table

describe("trace list table (API × script)", () => {
  const ev = (api: string, url: string, line: number, count: number, extra: Record<string, unknown> = {}) => ({
    seq: 1,
    ts: 0,
    mono: null,
    kind: "signal",
    actor: "ai",
    tab: "t1",
    cmd: null,
    frame: "root",
    nav: "n-3",
    api,
    access: "get",
    args: null,
    caller: { kind: "page", url, scriptId: "11", line, col: 4 },
    stack: [],
    count,
    firstMono: null,
    lastMono: null,
    ...extra,
  });
  const events = [
    ev("Navigator.prototype.userAgent", "http://h/fp.js", 1, 2, { value: "UA" }),
    ev("Navigator.prototype.userAgent", "http://h/fp.js", 8, 1),
    ev("Navigator.prototype.userAgent", "http://h/fp.js", 1, 3, { nav: "n-9" }),
    ev("Navigator.prototype.userAgent", "", 0, 1, { caller: { kind: "tabcap", url: "", scriptId: "40", line: 0, col: 10 } }),
    ev("Screen.prototype.width", "http://h/other.js", 4, 500, { truncated: true }),
    { kind: "signal", api: 3 },
    { kind: "request" },
    null,
  ];

  test("rows per (api, access, script); callers 1-based with kind; documents; truncated; value", () => {
    const rows = traceTable(events, { api: null, script: null });
    expect(rows).toEqual([
      { api: "Navigator.prototype.userAgent", access: "get", script: "", count: 1, documents: 1, callers: [{ line: 1, col: 11, kind: "tabcap", count: 1 }], truncated: false, value: false },
      {
        api: "Navigator.prototype.userAgent",
        access: "get",
        script: "http://h/fp.js",
        count: 6,
        documents: 2,
        callers: [
          { line: 2, col: 5, kind: "page", count: 5 },
          { line: 9, col: 5, kind: "page", count: 1 },
        ],
        truncated: false,
        value: true,
      },
      { api: "Screen.prototype.width", access: "get", script: "http://h/other.js", count: 500, documents: 1, callers: [{ line: 5, col: 5, kind: "page", count: 500 }], truncated: true, value: false },
    ]);
    expect(traceTable(events, { api: "Screen.prototype.width", script: null }).map((r) => r.script)).toEqual(["http://h/other.js"]);
    expect(traceTable(events, { api: "Screen", script: null })).toEqual([]);
    expect(traceTable(events, { api: null, script: "fp.js" }).map((r) => r.count)).toEqual([6]);
    const text = renderTraceText({ session: "s", rows });
    expect(text).toContain("Screen.prototype.width [get] ×500 in 1 doc(s) (truncated)");
    expect(text).toContain("http://h/fp.js @ 2:5 ×5, 9:5 ×1");
    expect(text).toContain("(tabcap)");
  });
});

// ---------------------------------------------------------------- manifest shape

describe("manifest: mode.trace and traceWindows (docs/04 §7)", () => {
  test("parse: an object with the five fields, else false; windows keep fromSeq / toSeq", () => {
    const mode: TraceMode = { mechanism: ["fn-breakpoint", "instrumentation"], apis: sha("[]"), stack: 8, firstN: 20, maxHits: 500 };
    expect(parseTraceMode(mode)).toEqual(mode);
    expect(parseTraceMode(false)).toBe(false);
    expect(parseTraceMode(true)).toBe(false);
    expect(parseTraceMode({ apis: "x" })).toBe(false);
    expect(parseTraceWindows(undefined)).toBeNull();
    expect(parseTraceWindows([{ fromSeq: 3, toSeq: 9 }, { fromSeq: 12, toSeq: null }, { toSeq: 1 }, "x"])).toEqual([
      { fromSeq: 3, toSeq: 9 },
      { fromSeq: 12, toSeq: null },
    ]);
  });

  test("written and read back unchanged; an old bundle reads trace:false without windows", async () => {
    const dir = join(tmp("tabcap-tracemf-"), "b");
    const w = await BundleWriter.open(dir, { init: { session: { name: "x" } } });
    w.updateManifest((m) => {
      m.mode.trace = { mechanism: ["fn-breakpoint", "instrumentation"], apis: sha("[]"), stack: 8, firstN: 20, maxHits: 500 };
      m.traceWindows = [{ fromSeq: 1, toSeq: 2 }];
    });
    await w.close();
    const m = readManifest(dir);
    expect(m.mode.trace).toEqual({ mechanism: ["fn-breakpoint", "instrumentation"], apis: sha("[]"), stack: 8, firstN: 20, maxHits: 500 });
    expect(m.traceWindows).toEqual([{ fromSeq: 1, toSeq: 2 }]);
    const old = join(tmp("tabcap-tracemf-"), "b");
    await (await BundleWriter.open(old, { init: { session: { name: "y" } } })).close();
    const o = readManifest(old);
    expect([o.mode.trace, "traceWindows" in o]).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------- tracer + recorder over a fake CDP

/** One page tab (T1 / S1); answers the tracer's CDP calls the way CfT 155 did in the spike. */
function fakeChrome() {
  const listeners = new Set<(e: CdpEvent) => void>();
  const sent: Array<{ method: string; params: CdpParams; sessionId: string | null }> = [];
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      sent.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getCookies") return { cookies: [] };
      if ((method === "Runtime.evaluate" && params["contextId"] === undefined) || method === "Debugger.evaluateOnCallFrame") return { result: { type: "object", objectId: "arr" } };
      if (method === "Runtime.getProperties") {
        // [getter, "get", name] for the first API; the second is missing in this "browser"
        return {
          result: [
            { name: "0", value: { type: "function", objectId: "fn-ua" } },
            { name: "1", value: { type: "string", value: "get" } },
            { name: "2", value: { type: "string", value: "Navigator.prototype.userAgent" } },
            { name: "3", value: { type: "undefined" } },
            { name: "4", value: { type: "string", value: "missing" } },
            { name: "5", value: { type: "string", value: "Nope.prototype.x" } },
            { name: "length", value: { type: "number", value: 6 } },
          ],
        };
      }
      if (method === "Debugger.setBreakpointOnFunctionCall") return { breakpointId: `bp-${String(params["objectId"])}` };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 99 };
      if (method === "Runtime.evaluate" && params["contextId"] === 99) return { result: { type: "string", value: JSON.stringify("Mozilla/5.0 test-ua") } };
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
  return { t, emit, sent };
}

describe("tracer over a fake CDP: events, value once per document, windows", () => {
  test("pauses become signal events at document end; the bundle gets mode.trace, a window and the value once", async () => {
    const { t, emit, sent } = fakeChrome();
    const tabs = new Tabs(t, false);
    await tabs.createTab("tr");
    const dir = join(tmp("tabcap-tracer-"), "b");
    mkdirSync(dir, { recursive: true });
    const rec = await Recorder.start({ session: "tr", dir: join(dir, "x"), t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    const list = parseSignalList(JSON.stringify(["Navigator.prototype.userAgent", "Nope.prototype.x"]), "test.json");
    const tr = await Tracer.start({ session: "tr", t, tabs, list, limits: { stack: 8, firstN: 20, maxHits: 500 }, recorder: () => rec, scrub: (s) => s.replace("test-ua", "<secret:x>"), paused: false, decode: false });
    expect(sent.filter((x) => x.method === "EventBreakpoints.setInstrumentationBreakpoint").map((x) => x.params["eventName"])).toEqual(["scriptFirstStatement", ...INSTRUMENTATION_EVENTS]);
    expect(tr.status()).toMatchObject({ trace: "on", notice: TRACE_NOTICE, active: ["Navigator.prototype.userAgent"], skipped: [{ api: "Nope.prototype.x", reason: "not present in this browser" }] });

    emit("Network.requestWillBeSent", { timestamp: 100 }); // calibrates the CDP clock
    emit("Debugger.scriptParsed", { scriptId: "11", url: "http://127.0.0.1:4310/fp.js", executionContextId: 3, executionContextAuxData: { frameId: "T1", isDefault: true } });
    emit("Debugger.scriptParsed", { scriptId: "50", url: "", executionContextId: 99, executionContextAuxData: { frameId: "T1", isDefault: false } });
    const paused = { reason: "other", hitBreakpoints: ["bp-fn-ua"], callFrames: [frame("11", 1, 16)] };
    for (let i = 0; i < 3; i++) emit("Debugger.paused", paused);
    emit("Debugger.paused", { reason: "other", hitBreakpoints: ["bp-fn-ua"], callFrames: [frame("50", 0, 1)] }); // isolated world: not a page read
    emit("Debugger.paused", { reason: "other", callFrames: [frame("11", 5, 0)] }); // page `debugger;`: resumed, not recorded
    expect(sent.filter((x) => x.method === "Debugger.resume").length).toBe(5);
    expect(tr.hits).toBe(3);
    await Bun.sleep(10);
    emit("Runtime.executionContextDestroyed", { executionContextId: 3 });
    await tr.stop("trace stop");
    expect(sent.filter((x) => x.method === "Debugger.removeBreakpoint").map((x) => x.params["breakpointId"])).toEqual(["bp-fn-ua"]);
    expect(sent.some((x) => x.method === "Debugger.disable")).toBe(true);
    await rec.stop();

    const r = BundleReader.open(join(dir, "x"));
    const sig = r.events.filter((e) => e.kind === "signal");
    expect(sig.length).toBe(1);
    const e = sig[0];
    if (e === undefined) throw new Error("no signal event");
    expect(Object.keys(e).sort()).toEqual(["access", "actor", "api", "args", "caller", "cmd", "count", "firstMono", "frame", "kind", "lastMono", "mono", "nav", "seq", "stack", "tab", "ts", "value"].sort());
    expect(e).toMatchObject({
      kind: "signal",
      tab: "t1",
      frame: "root",
      api: "Navigator.prototype.userAgent",
      access: "get",
      args: null,
      caller: { kind: "page", url: "http://127.0.0.1:4310/fp.js", scriptId: "11", line: 1, col: 16 },
      stack: [{ url: "http://127.0.0.1:4310/fp.js", line: 1, col: 16 }],
      count: 3,
      value: "Mozilla/5.0 <secret:x>",
    });
    expect(typeof e["firstMono"] === "number" && e["firstMono"] >= 100_000).toBe(true);
    const first: unknown = e["firstMono"];
    expect(e.mono === first).toBe(true);
    const m = r.manifest;
    expect(m.mode.trace).toEqual({ mechanism: ["fn-breakpoint", "instrumentation"], apis: list.hash, stack: 8, firstN: 20, maxHits: 500 });
    const notes = r.events.filter((x) => x.kind === "note");
    expect(m.traceWindows).toEqual([{ fromSeq: notes[0]?.seq ?? -1, toSeq: notes[1]?.seq ?? -1 }]);
    expect(e.seq > (notes[0]?.seq ?? 0) && e.seq < (notes[1]?.seq ?? 0)).toBe(true);
    const stop = r.events.find((x) => x.kind === "session" && x["phase"] === "stop");
    expect(isRecord(stop?.["mode"]) ? stop["mode"]["trace"] : null).toEqual(m.mode.trace);
  });

  test("a recording that stops while trace is on gets what was seen so far, and its window is closed", async () => {
    const { t, emit } = fakeChrome();
    const tabs = new Tabs(t, false);
    await tabs.createTab("tr");
    const dir = join(tmp("tabcap-tracer-"), "b");
    const rec = await Recorder.start({ session: "tr", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    const tr = await Tracer.start({ session: "tr", t, tabs, list: parseSignalList('["Navigator.prototype.userAgent"]', "t.json"), limits: { stack: 8, firstN: 20, maxHits: 500 }, recorder: () => rec, scrub: (s) => s, paused: false, decode: false });
    emit("Debugger.scriptParsed", { scriptId: "11", url: "http://h/fp.js", executionContextId: 3, executionContextAuxData: { frameId: "T1", isDefault: true } });
    emit("Debugger.paused", { reason: "other", hitBreakpoints: ["bp-fn-ua"], callFrames: [frame("11", 1, 16)] });
    await rec.stop();
    const r = BundleReader.open(dir);
    expect(r.events.filter((e) => e.kind === "signal").map((e) => e["count"])).toEqual([1]);
    expect(r.manifest.traceWindows?.every((w) => typeof w.toSeq === "number")).toBe(true);
    await tr.stop("trace stop");
  });

  test("handoff: setSkipAllPauses on every traced session and a note each way", async () => {
    const { t, sent } = fakeChrome();
    const tabs = new Tabs(t, false);
    await tabs.createTab("tr");
    const dir = join(tmp("tabcap-tracer-"), "b");
    const rec = await Recorder.start({ session: "tr", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    const tr = await Tracer.start({ session: "tr", t, tabs, list: builtinSignalList(), limits: { stack: 8, firstN: 20, maxHits: 500 }, recorder: () => rec, scrub: (s) => s, paused: false, decode: false });
    await tr.setPaused(true);
    expect(tr.status()["trace"]).toBe("paused");
    await tr.setPaused(false);
    expect(sent.filter((x) => x.method === "Debugger.setSkipAllPauses").map((x) => x.params["skip"])).toEqual([true, false]);
    await tr.stop("trace stop");
    await rec.stop();
    const notes = BundleReader.open(dir).events.filter((e) => e.kind === "note").map((e) => String(e["text"]));
    expect(notes.some((x) => x.startsWith("trace paused:"))).toBe(true);
    expect(notes.some((x) => x.startsWith("trace resumed:"))).toBe(true);
  });
});
