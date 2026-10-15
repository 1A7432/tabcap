import { describe, expect, test } from "bun:test";
import { atLeast, parseConsoleEvent, remoteText, RingBuffer, stackText, truncateUtf8, whereOf } from "../../src/daemon/capture/console.ts";

describe("RingBuffer", () => {
  test("keeps the last N in order and counts drops", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.toArray()).toEqual([5, 6, 7]);
    expect(r.size).toBe(3);
    expect(r.dropped).toBe(4);
    r.clear();
    expect(r.toArray()).toEqual([]);
    expect(r.dropped).toBe(0);
    r.push(9);
    expect(r.toArray()).toEqual([9]);
  });
  test("under capacity, and exactly at capacity", () => {
    const r = new RingBuffer<string>(2);
    r.push("a");
    expect(r.toArray()).toEqual(["a"]);
    r.push("b");
    expect(r.toArray()).toEqual(["a", "b"]);
    expect(r.dropped).toBe(0);
  });
  test("rejects a bad capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });
});

describe("console entry parsing (docs/04 §4.1 console)", () => {
  test("truncateUtf8 never splits a character", () => {
    expect(truncateUtf8("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(truncateUtf8("ab€", 4)).toEqual({ text: "ab", truncated: true }); // € is 3 bytes
    expect(truncateUtf8("x".repeat(5000), 4096).text.length).toBe(4096);
  });
  test("levels: --level keeps that level and above; log and info rank the same", () => {
    expect(atLeast("error", "warn")).toBe(true);
    expect(atLeast("log", "warn")).toBe(false);
    expect(atLeast("info", "log")).toBe(true);
    expect(atLeast("log", "info")).toBe(true);
    expect(atLeast("debug", "log")).toBe(false);
  });
  test("RemoteObject text", () => {
    expect(remoteText({ type: "string", value: "hi" })).toBe("hi");
    expect(remoteText({ type: "number", value: 42, description: "42" })).toBe("42");
    expect(remoteText({ type: "number", unserializableValue: "NaN" })).toBe("NaN");
    expect(remoteText({ type: "undefined" })).toBe("undefined");
    expect(remoteText({ type: "object", subtype: "null", value: null })).toBe("null");
    expect(remoteText({ type: "object", description: "Object", preview: { type: "object", properties: [{ name: "a", type: "number", value: "1" }, { name: "b", type: "string", value: "x" }] } })).toBe('{a: 1, b: "x"}');
    expect(remoteText({ type: "object", subtype: "array", description: "Array(3)", preview: { subtype: "array", properties: [{ name: "0", type: "number", value: "1" }], overflow: true } })).toBe("[1, …]");
    expect(remoteText({ type: "function", description: "function f() {}" })).toBe("function f() {}");
    expect(remoteText("junk")).toBe("");
  });
  test("consoleAPICalled: level, joined text, 1-based location from the top frame", () => {
    const e = parseConsoleEvent(
      {
        method: "Runtime.consoleAPICalled",
        sessionId: "S",
        params: {
          type: "warning",
          timestamp: 1700000000123.5,
          args: [{ type: "string", value: "careful" }, { type: "number", value: 3, description: "3" }],
          stackTrace: { callFrames: [{ functionName: "", url: "http://127.0.0.1/p", lineNumber: 2, columnNumber: 8 }] },
        },
      },
      1,
    );
    expect(e).toEqual({ ts: 1700000000123.5, level: "warn", source: "console", text: "careful 3", truncated: false, args: ["careful", "3"], url: "http://127.0.0.1/p", line: 3, col: 9, stack: null });
    expect(whereOf(e ?? { url: null, line: null, col: null })).toBe("http://127.0.0.1/p:3:9");
  });
  test("long text is cut at 4 KB and flagged", () => {
    const e = parseConsoleEvent({ method: "Runtime.consoleAPICalled", sessionId: "S", params: { type: "log", args: [{ type: "string", value: "y".repeat(10_000) }] } }, 5);
    expect(e?.text.length).toBe(4096);
    expect(e?.truncated).toBe(true);
    expect(e?.ts).toBe(5); // no timestamp: daemon clock
    expect(e?.args[0]?.length).toBe(201);
  });
  test("exceptionThrown: Uncaught + message, stack from callFrames", () => {
    const e = parseConsoleEvent(
      {
        method: "Runtime.exceptionThrown",
        sessionId: "S",
        params: {
          timestamp: 1700000000000,
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 4,
            columnNumber: 30,
            url: "http://127.0.0.1/p",
            exception: { type: "object", subtype: "error", description: "Error: boom\n    at explode (http://127.0.0.1/p:5:31)" },
            stackTrace: { callFrames: [{ functionName: "explode", url: "http://127.0.0.1/p", lineNumber: 4, columnNumber: 30 }, { functionName: "", url: "http://127.0.0.1/p", lineNumber: 6, columnNumber: 0 }] },
          },
        },
      },
      1,
    );
    expect(e).toMatchObject({ level: "error", source: "exception", text: "Uncaught Error: boom", url: "http://127.0.0.1/p", line: 5, col: 31 });
    expect(e?.stack).toBe("    at explode (http://127.0.0.1/p:5:31)\n    at http://127.0.0.1/p:7:1");
  });
  test("exception without stackTrace falls back to the description's stack lines", () => {
    const e = parseConsoleEvent({ method: "Runtime.exceptionThrown", sessionId: "S", params: { exceptionDetails: { text: "Uncaught Error: x", exception: { description: "Error: x\n    at a (u:1:2)" } } } }, 1);
    expect(e?.text).toBe("Uncaught Error: x");
    expect(e?.stack).toBe("    at a (u:1:2)");
  });
  test("Log.entryAdded: sources and levels", () => {
    const e = parseConsoleEvent({ method: "Log.entryAdded", sessionId: "S", params: { entry: { source: "network", level: "error", text: "Failed to load resource", url: "http://x/y", timestamp: 9, lineNumber: 0 } } }, 1);
    expect(e).toMatchObject({ level: "error", source: "network", text: "Failed to load resource", url: "http://x/y", line: 1, ts: 9 });
    expect(parseConsoleEvent({ method: "Log.entryAdded", sessionId: "S", params: { entry: { source: "violation", level: "verbose", text: "t" } } }, 1)).toMatchObject({ level: "debug", source: "other" });
  });
  test("malformed or unrelated events give null", () => {
    expect(parseConsoleEvent({ method: "Runtime.exceptionThrown", sessionId: "S", params: {} }, 1)).toBeNull();
    expect(parseConsoleEvent({ method: "Log.entryAdded", sessionId: "S", params: { entry: 3 } }, 1)).toBeNull();
    expect(parseConsoleEvent({ method: "Page.loadEventFired", sessionId: "S", params: {} }, 1)).toBeNull();
    expect(stackText({ callFrames: "x" })).toBeNull();
  });
});
