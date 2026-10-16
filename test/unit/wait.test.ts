import { describe, expect, test } from "bun:test";
import { parseCommand, matchCommand } from "../../src/cli/commands.ts";
import { IdleTracker, IDLE_DEFAULT_MS, listForHint, netMatch, parseNetWait, parseWait, pollExpression, readPoll, WAIT_DEFAULT_MS, WAIT_MAX_MS, waitTimeout } from "../../src/daemon/tools/waitspec.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : "other";
  }
};

describe("wait arguments", () => {
  test("exactly one condition", () => {
    expect(parseWait({ text: "hi" })).toEqual({ kind: "text", texts: ["hi"] });
    // `--text` repeated: any of them (docs/08 §5)
    expect(parseWait({ text: ["hi", "bye"] })).toEqual({ kind: "text", texts: ["hi", "bye"] });
    expect(parseWait({ selector: "#a" })).toEqual({ kind: "selector", selector: "#a" });
    expect(parseWait({ url: "/done" })).toEqual({ kind: "url", url: "/done" });
    expect(parseWait({ fn: "window.ok" })).toEqual({ kind: "fn", expr: "window.ok" });
    expect(parseWait({ idle: true })).toEqual({ kind: "idle", ms: IDLE_DEFAULT_MS });
    expect(parseWait({ idle: 800 })).toEqual({ kind: "idle", ms: 800 });
    expect(code(() => parseWait({}))).toBe("usage");
    expect(code(() => parseWait({ text: "a", url: "b" }))).toBe("usage");
    expect(code(() => parseWait({ text: "" }))).toBe("usage");
    expect(code(() => parseWait({ fn: "  " }))).toBe("usage");
    expect(code(() => parseWait({ idle: -1 }))).toBe("usage");
    expect(code(() => parseWait({ text: 3 }))).toBe("usage");
  });
  test("timeout: default 10 s, clamped to 120 s", () => {
    expect(waitTimeout({})).toBe(WAIT_DEFAULT_MS);
    expect(waitTimeout({ timeoutMs: 2500 })).toBe(2500);
    expect(waitTimeout({ timeoutMs: 999_999 })).toBe(WAIT_MAX_MS);
    expect(waitTimeout({ timeoutMs: 1 })).toBe(100);
  });
  test("CLI: --idle with and without a value; net wait is its own command", () => {
    const w = matchCommand(["wait"]);
    if (w === null) throw new Error("no wait command");
    expect(parseCommand(w, ["--idle"]).args).toEqual({ idle: true });
    expect(parseCommand(w, ["--idle", "750"]).args).toEqual({ idle: 750 });
    expect(parseCommand(w, ["--idle=40", "--timeout", "3000"]).args).toEqual({ idle: 40, timeoutMs: 3000 });
    expect(parseCommand(w, ["--idle", "--timeout", "3000"]).args).toEqual({ idle: true, timeoutMs: 3000 });
    expect(matchCommand(["net", "wait"])?.action).toBe("net.wait");
    expect(matchCommand(["wait", "net"])?.action).toBe("wait");
    expect(matchCommand(["console"])).toBeNull();
  });
});

describe("poll expressions and results", () => {
  test("user strings are embedded as JSON literals", () => {
    expect(pollExpression({ kind: "text", texts: ['a"b'] })).toContain(JSON.stringify('a"b'));
    expect(pollExpression({ kind: "selector", selector: "div[x='1']" })).toContain(JSON.stringify("div[x='1']"));
    // the user's expression sits on its own lines so a trailing // comment cannot eat the wrapper
    expect(pollExpression({ kind: "fn", expr: "x // c" })).toContain("\nx // c\n");
  });
  test("readPoll: pending until a record comes back", () => {
    expect(readPoll({ kind: "text", texts: ["t"] }, null)).toEqual({ state: "pending" });
    expect(readPoll({ kind: "text", texts: ["t"] }, { context: "… t …" })).toEqual({ state: "matched", detail: { text: "t", context: "… t …" } });
    expect(readPoll({ kind: "text", texts: ["a", "b"] }, { text: "b", context: "… b …" })).toEqual({ state: "matched", detail: { text: "b", context: "… b …" } });
    expect(readPoll({ kind: "selector", selector: "p" }, { tag: "p", text: "x", visible: true })).toEqual({ state: "matched", detail: { selector: "p", tag: "p", text: "x", visible: true } });
    expect(readPoll({ kind: "selector", selector: "##" }, { invalid: "bad" })).toEqual({ state: "invalid", message: "bad" });
    expect(readPoll({ kind: "fn", expr: "1" }, { value: 1 })).toEqual({ state: "matched", detail: { value: 1, truncated: false } });
    expect(readPoll({ kind: "fn", expr: "1" }, { other: 1 })).toEqual({ state: "pending" });
    const big = readPoll({ kind: "fn", expr: "1" }, { value: "z".repeat(5000) });
    expect(big.state === "matched" && big.detail["truncated"]).toBe(true);
  });
});

describe("IdleTracker", () => {
  test("idle only after the last request ends, for N ms", () => {
    const t = new IdleTracker(0);
    expect(t.idleFor(100)).toBe(100);
    t.begin("a", "GET /a", "L1");
    t.begin("b", "GET /b", "L1");
    t.begin("a", "GET /a", "L1"); // redirect: same id again
    expect(t.seen).toBe(2);
    expect(t.idleFor(500)).toBe(0);
    t.end("a", 600);
    expect(t.idleFor(700)).toBe(0);
    t.end("b", 800);
    expect(t.idleFor(900)).toBe(100);
    t.end("zzz", 950); // unknown ids do not reset the quiet period
    expect(t.idleFor(1000)).toBe(200);
    expect(t.outstanding()).toEqual([]);
  });
  test("a root commit drops the old document's requests (they never finish)", () => {
    const t = new IdleTracker(0);
    t.begin("old", "GET /stream", "L1");
    t.begin("worker", "GET /w", null);
    t.commit("L2", 50);
    expect(t.outstanding()).toEqual(["GET /w"]);
    t.end("worker", 60);
    expect(t.idleFor(100)).toBe(40);
    const u = new IdleTracker(0);
    u.begin("x", "GET /x", "L1");
    u.commit("L2", 70);
    expect(u.idleFor(100)).toBe(30);
    u.commit(null, 80);
  });
});

describe("net wait matching", () => {
  test("url substring, method, body stored", () => {
    const q = parseNetWait({ url: "/api/x", method: "post" });
    expect(q).toEqual({ url: "/api/x", method: "POST" });
    expect(netMatch({ url: "http://h/api/x?1", method: "POST", blob: "sha256:aa" }, q)).toBe("match");
    expect(netMatch({ url: "http://h/api/x", method: "GET", blob: "sha256:aa" }, q)).toBe("no");
    expect(netMatch({ url: "http://h/api/y", method: "POST", blob: "sha256:aa" }, q)).toBe("no");
    expect(netMatch({ url: "http://h/api/x", method: "post", blob: null }, q)).toBe("no-body");
    expect(netMatch({ url: "http://h/api/x", method: "PUT", blob: "s" }, parseNetWait({ url: "/api/x" }))).toBe("match");
    expect(code(() => parseNetWait({}))).toBe("usage");
  });
  test("hint lists stay short", () => {
    expect(listForHint([])).toBe("none");
    expect(listForHint(["a", "b"])).toBe("a, b");
    expect(listForHint(["a", "b", "c", "d", "e"])).toBe("a, b, c (+2 more)");
  });
});
