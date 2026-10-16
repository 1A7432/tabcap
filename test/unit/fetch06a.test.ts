// 0.6-A `tabcap fetch`: option parsing, request validation (untrusted JSON),
// stop rules, the per-host limiter (fake clock), marker stripping and the
// initiator fallback in the recorder, the guard stop / resume, and the
// endpoint's body validation. The browser is a fake transport that answers the
// helper's CDP calls with the events Chrome sent in the 10-16 spike
// (requestWillBeSent with the marker, Request-stage requestPaused, a script
// initiator naming the helper function and its scriptId).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchLines, fetchArgs, fetchClientTimeout, formPair, headerPair } from "../../src/cli/fetch.ts";
import { continueHeaders, initiatorMatch, markerOf, withoutMarker, type FetchReg } from "../../src/daemon/capture/fetchmark.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { HostLimiter, type Clock } from "../../src/daemon/fetch/limiter.ts";
import { helperResultOf, helperSource } from "../../src/daemon/fetch/helper.ts";
import { FETCH_MARKER, parseFetchSpec, targetUrl } from "../../src/daemon/fetch/spec.ts";
import { firstStop, parseStopRule, parseStopRules } from "../../src/daemon/fetch/stoprules.ts";
import { handleFetch } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { envelopeHeaders, envelopeTiming, fetchRun, siteOf } from "../../src/daemon/tools/fetch.ts";
import { guardResume } from "../../src/daemon/tools/handoff.ts";
import { fetchConfigFrom, FETCH_DEFAULTS } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import type { AttachedTarget, CdpEvent, CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

const roots: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `not a TabcapError: ${String(e)}`;
  }
};

describe("CLI options → request (src/cli/fetch.ts)", () => {
  test("--body @file and --json @file are read relative to cwd; --json text is parsed; --form and --header pairs", () => {
    const dir = tmp("tabcap-fetch-cli-");
    writeFileSync(join(dir, "b.txt"), "a=1&b=2");
    writeFileSync(join(dir, "j.json"), '{"page": 2, "q": "x"}');
    expect(fetchArgs({ url: "/api/x", method: "POST", body: "@b.txt" }, dir)).toEqual({ url: "/api/x", method: "POST", body: "a=1&b=2" });
    expect(fetchArgs({ url: "/api/x", method: "POST", json: "@j.json" }, dir)).toEqual({ url: "/api/x", method: "POST", json: { page: 2, q: "x" } });
    expect(fetchArgs({ url: "/api/x", method: "POST", json: "[1,2]" }, dir)["json"]).toEqual([1, 2]);
    expect(fetchArgs({ url: "/api/x", body: "plain @ text" }, dir)["body"]).toBe("plain @ text");
    expect(fetchArgs({ url: "/u", method: "POST", form: ["a=1", "b=x=y"], header: ["X-A: v 1", "accept:application/json"] }, dir)).toEqual({
      url: "/u",
      method: "POST",
      headers: [
        ["X-A", "v 1"],
        ["accept", "application/json"],
      ],
      form: [
        ["a", "1"],
        ["b", "x=y"],
      ],
    });
    expect(fetchArgs({ url: "/u", stopOn: ["empty-body"], tab: "t2", timeoutMs: 5000, rawBody: true }, dir)).toEqual({ url: "/u", stopOn: ["empty-body"], tab: "t2", timeoutMs: 5000, rawBody: true });
  });

  test("bad options are usage errors: invalid --json, two body kinds, bad pairs, missing url, a missing @file", () => {
    const dir = tmp("tabcap-fetch-cli-");
    expect(codeOf(() => fetchArgs({ url: "/x", json: "{nope" }, dir))).toBe("usage");
    expect(codeOf(() => fetchArgs({ url: "/x", json: "{}", body: "a" }, dir))).toBe("usage");
    expect(codeOf(() => headerPair("no-colon"))).toBe("usage");
    expect(codeOf(() => headerPair(":v"))).toBe("usage");
    expect(codeOf(() => formPair("=v"))).toBe("usage");
    expect(codeOf(() => fetchArgs({}, dir))).toBe("usage");
    expect(codeOf(() => fetchArgs({ url: "/x", body: "@missing.txt" }, dir))).toBe("not-found");
  });

  test("--batch: one object per non-empty line, --timeout as the per-line default, no request flags beside it; the CLI waits for the sum", () => {
    const dir = tmp("tabcap-fetch-cli-");
    writeFileSync(join(dir, "b.jsonl"), '{"url":"/a"}\n\n{"url":"/b","method":"POST","json":{"k":1},"timeoutMs":9000}\r\n');
    const a = fetchArgs({ batch: "b.jsonl", timeoutMs: 4000 }, dir);
    expect(a).toEqual({ batch: [{ url: "/a", timeoutMs: 4000 }, { url: "/b", method: "POST", json: { k: 1 }, timeoutMs: 9000 }] });
    expect(fetchClientTimeout(a, 30000)).toBe(13000);
    expect(fetchClientTimeout({ url: "/x" }, 30000)).toBe(30000);
    expect(codeOf(() => fetchArgs({ batch: "b.jsonl", url: "/x" }, dir))).toBe("usage");
    expect(codeOf(() => batchLines("[1]\n"))).toBe("usage");
    expect(codeOf(() => batchLines("{bad\n"))).toBe("usage");
    expect(codeOf(() => batchLines("\n\n"))).toBe("usage");
  });
});

describe("request validation (fetch/spec.ts; the endpoint body is untrusted JSON)", () => {
  test("defaults, json / form bodies get their content-type unless given; method upper-cased", () => {
    expect(parseFetchSpec({ url: "/x" })).toEqual({ url: "/x", method: "GET", headers: [], body: null, tab: null, timeoutMs: 30000, stopOn: [], out: null, rawBody: false, reveal: false });
    const j = parseFetchSpec({ url: "/x", method: "post", json: { a: [1] } });
    expect([j.method, j.body, j.headers]).toEqual(["POST", '{"a":[1]}', [["content-type", "application/json"]]]);
    const f = parseFetchSpec({ url: "/x", method: "POST", form: { a: "1 2", b: "&" }, headers: { "Content-Type": "text/plain" } });
    expect([f.body, f.headers]).toEqual(["a=1+2&b=%26", [["Content-Type", "text/plain"]]]);
    expect(parseFetchSpec({ url: "/x", stopOn: "empty-body" }).stopOn).toEqual(["empty-body"]);
  });

  test("refused: a body on GET, two body kinds, the marker header, header injection, bad tab / timeout / method", () => {
    for (const bad of [
      { url: "/x", body: "a" },
      { url: "/x", method: "POST", body: "a", json: 1 },
      { url: "/x", headers: { [FETCH_MARKER]: "c-1:f-1" } },
      { url: "/x", headers: { "X-Tabcap-Fetch": "x" } },
      { url: "/x", headers: { a: "1\r\nb: 2" } },
      { url: "/x", headers: { "bad name": "1" } },
      { url: "/x", headers: [["a"]] },
      { url: "/x", tab: "../t1" },
      { url: "/x", timeoutMs: 0 },
      { url: "/x", timeoutMs: 10_000_000 },
      { url: "/x", method: "GE T" },
      { url: "/x", method: "CONNECT" },
      { url: "/x", rawBody: "yes" },
      { url: "/x", rawBody: true, out: "/tmp/f" },
      { url: "" },
      {},
    ]) {
      expect(codeOf(() => parseFetchSpec(bad))).toBe("usage");
    }
  });

  test("untrusted values never crash: every shape is a usage error or a valid spec", () => {
    const values: unknown[] = [null, undefined, 0, -1, 1e309, NaN, "", "x", [], [[]], {}, { a: 1 }, true, [1, "a"], { toString: 1 }, "\u0000", "a".repeat(20_000)];
    const keys = ["url", "method", "headers", "body", "json", "form", "tab", "timeoutMs", "stopOn", "out", "rawBody"];
    for (const top of [...values, ...values.map((v) => ({ url: v }))]) expect(["usage", null]).toContain(codeOf(() => parseFetchSpec(top)));
    for (const k of keys) for (const v of values) expect(["usage", null]).toContain(codeOf(() => parseFetchSpec({ url: "/x", method: "POST", [k]: v })));
  });

  test("targetUrl: relative to the tab's page, http(s) only, fragment dropped", () => {
    expect(targetUrl("/api/x?a=1#f", "http://127.0.0.1:9/p/q").href).toBe("http://127.0.0.1:9/api/x?a=1");
    expect(codeOf(() => targetUrl("file:///etc/passwd", "http://127.0.0.1:9/"))).toBe("usage");
    expect(codeOf(() => targetUrl("/x", "about:blank"))).toBe("usage");
  });
});

describe("stop rules (fetch/stoprules.ts)", () => {
  const json = (v: unknown) => ({ status: 200, bytes: JSON.stringify(v).length, text: JSON.stringify(v) });
  const table: Array<[string, { status: number | null; bytes: number; text: string | null }, boolean]> = [
    ["empty-body", { status: 200, bytes: 0, text: "" }, true],
    ["empty-body", { status: 200, bytes: 3, text: " \n " }, true],
    ["empty-body", { status: 204, bytes: 0, text: null }, true],
    ["empty-body", { status: 200, bytes: 2, text: "{}" }, false],
    ["status>=400", { status: 400, bytes: 1, text: "x" }, true],
    ["status>=400", { status: 503, bytes: 1, text: "x" }, true],
    ["status>=400", { status: 399, bytes: 1, text: "x" }, false],
    ["status=302", { status: 302, bytes: 0, text: null }, true],
    ["status=302", { status: 200, bytes: 1, text: "x" }, false],
    ["json:$.code!=0", json({ code: 1 }), true],
    ["json:$.code!=0", json({ code: 0 }), false],
    ["json:$.code!=0", json({ code: "0" }), true],
    ["json:$.code!=0", json({ other: 0 }), true],
    ["json:$.code!=0", { status: 200, bytes: 6, text: "<html>" }, true],
    ["json:$.code=1", { status: 200, bytes: 6, text: "<html>" }, false],
    ["json:$.code=1", json({ code: 1 }), true],
    ['json:$.data.items[1].state="locked"', json({ data: { items: [{ state: "ok" }, { state: "locked" }] } }), true],
    ["json:$.data.items[1].state=locked", json({ data: { items: [{ state: "ok" }, { state: "locked" }] } }), true],
    ["json:$.data.items[5].state=locked", json({ data: { items: [] } }), false],
    ["json:$.ok=true", json({ ok: true }), true],
    ["json:$.err=null", json({ err: null }), true],
    ["json:$.err!=null", json({}), true],
    ["json:$.a={\"b\":[1]}", json({ a: { b: [1] } }), true],
    ["text:请求过于频繁|verify", { status: 200, bytes: 9, text: "<p>请求过于频繁</p>" }, true],
    ["text:^ok$", { status: 200, bytes: 6, text: "not ok" }, false],
    ["text:x", { status: 200, bytes: 4, text: null }, false],
  ];
  test.each(table)("%s on %j → %p", (rule, input, fires) => {
    const hit = firstStop([parseStopRule(rule)], input);
    expect(hit !== null).toBe(fires);
    if (hit !== null) expect(hit.rule).toBe(rule);
  });

  test("the first rule that fires wins (config rules come first); details never echo the body", () => {
    const rules = parseStopRules(["status>=500", "json:$.code!=0", "text:secret-token"]);
    expect(firstStop(rules, json({ code: 7, t: "secret-token" }))).toEqual({ rule: "json:$.code!=0", detail: "$.code is 7" });
    const t = firstStop(parseStopRules(["text:secret-token"]), { status: 200, bytes: 20, text: "xx secret-token yy" });
    expect(t?.detail).toBe("the body matches at character 3");
  });

  test("bad rules are usage errors", () => {
    for (const bad of ["", "nope", "status>=abc", "status=4000", "json:code=1", "json:$.a", "json:$..a=1", "json:$.a[x]=1", "text:", "text:(", `text:${"a".repeat(300)}`]) {
      expect(codeOf(() => parseStopRule(bad))).toBe("usage");
    }
  });
});

describe("per-host limiter (fake clock)", () => {
  function fakeClock(): Clock & { advance: (ms: number) => Promise<void>; t: number } {
    const timers: Array<{ at: number; fire: () => void }> = [];
    const c = {
      t: 1_000_000,
      now: () => c.t,
      sleep: (ms: number) => new Promise<void>((r) => timers.push({ at: c.t + ms, fire: r })),
      advance: async (ms: number) => {
        const end = c.t + ms;
        for (;;) {
          await Promise.resolve();
          await Bun.sleep(0);
          timers.sort((a, b) => a.at - b.at);
          const next = timers[0];
          if (next === undefined || next.at > end) break;
          timers.shift();
          c.t = next.at;
          next.fire();
        }
        c.t = end;
        await Bun.sleep(0);
      },
    };
    return c;
  }

  test("concurrency 1: requests to one host start in arrival order, minIntervalMs after the previous one ended; waitedMs reported", async () => {
    const c = fakeClock();
    const l = new HostLimiter(c);
    const pace = { minIntervalMs: 3000, concurrency: 1 };
    const starts: Array<[string, number, number]> = [];
    const run = async (name: string, holdMs: number) => {
      const s = await l.acquire("h:1", pace, c.t + 60_000);
      starts.push([name, c.t, s.waitedMs]);
      await c.sleep(holdMs);
      s.release();
    };
    const t0 = c.t;
    const all = Promise.all([run("a", 500), run("b", 200), run("c", 0)]);
    await c.advance(20_000);
    await all;
    expect(starts.map(([n, t, w]) => [n, t - t0, w])).toEqual([
      ["a", 0, 0],
      ["b", 3500, 3500],
      ["c", 6700, 6700],
    ]);
  });

  test("another host does not wait; concurrency 2 lets two run, still spaced by the interval", async () => {
    const c = fakeClock();
    const l = new HostLimiter(c);
    const a = await l.acquire("a:1", { minIntervalMs: 3000, concurrency: 1 }, c.t + 1000);
    const b = await l.acquire("b:1", { minIntervalMs: 3000, concurrency: 1 }, c.t + 1000);
    expect([a.waitedMs, b.waitedMs]).toEqual([0, 0]);
    const t0 = c.t;
    const pace = { minIntervalMs: 1000, concurrency: 2 };
    const got: number[] = [];
    const p1 = l.acquire("c:1", pace, c.t + 10_000).then((s) => got.push(c.t - t0));
    const p2 = l.acquire("c:1", pace, c.t + 10_000).then((s) => got.push(c.t - t0));
    await c.advance(5000);
    await Promise.all([p1, p2]);
    expect(got).toEqual([0, 1000]);
    expect(l.inFlight("c:1")).toBe(2);
  });

  test("a turn past the deadline is a timeout before anything is sent; the queue goes on", async () => {
    const c = fakeClock();
    const l = new HostLimiter(c);
    const pace = { minIntervalMs: 3000, concurrency: 1 };
    const first = await l.acquire("h:1", pace, c.t + 1000);
    first.release();
    const late = l.acquire("h:1", pace, c.t + 1000).then(
      () => "admitted",
      (e: unknown) => (e instanceof TabcapError ? e.code : "other"),
    );
    await c.advance(10);
    expect(await late).toBe("timeout");
    const next = l.acquire("h:1", pace, c.t + 10_000);
    await c.advance(5000);
    expect((await next).waitedMs).toBe(2990);
  });
});

describe("marker header and attribution helpers (capture/fetchmark.ts)", () => {
  test("the marker is found in any case and removed from continueRequest headers and recorded headers", () => {
    expect(markerOf({ "X-Tabcap-Fetch": "c-3:f-1", a: "b" })).toBe("c-3:f-1");
    expect(markerOf({ a: "b" })).toBeNull();
    expect(markerOf(null)).toBeNull();
    expect(continueHeaders({ Accept: "*/*", "x-tabcap-fetch": "c-3:f-1", n: 5 })).toEqual([{ name: "Accept", value: "*/*" }]);
    expect(withoutMarker({ accept: "*/*", "x-tabcap-fetch": "c-3:f-1" })).toEqual({ accept: "*/*" });
  });

  test("initiator fallback: the helper's function name and scriptId on the stack (or an async parent), same session only", () => {
    const reg: FetchReg = { fetchId: "c-5:f-1", cmd: "c-5", sessionId: "S1", marker: null, fnName: "__tabcap_fetch_ab_1", scriptId: "42" };
    const other: FetchReg = { ...reg, fetchId: "c-6:f-1", fnName: "__tabcap_fetch_cd_1", scriptId: "43" };
    const stack = (fn: string, sid: string) => ({ type: "script", stack: { callFrames: [{ functionName: fn, scriptId: sid, url: "", lineNumber: 0, columnNumber: 0 }] } });
    expect(initiatorMatch(stack("__tabcap_fetch_ab_1", "42"), [other, reg], "S1")?.fetchId).toBe("c-5:f-1");
    expect(initiatorMatch(stack("__tabcap_fetch_ab_1", "99"), [reg], "S1")).toBeNull();
    expect(initiatorMatch(stack("__tabcap_fetch_ab_1", "42"), [reg], "S2")).toBeNull();
    expect(initiatorMatch(stack("pageFn", "42"), [reg], "S1")).toBeNull();
    expect(initiatorMatch({ type: "script", stack: { callFrames: [], parent: { callFrames: [{ functionName: "__tabcap_fetch_cd_1", scriptId: "43" }] } } }, [reg, other], "S1")?.fetchId).toBe("c-6:f-1");
    expect(initiatorMatch({ type: "other" }, [reg], "S1")).toBeNull();
    expect(initiatorMatch("junk", [reg], "S1")).toBeNull();
  });

  test("the helper source names its function and carries the marker only as data; results are validated", () => {
    const src = helperSource("__tabcap_fetch_0a_1", { url: "http://127.0.0.1:9/x", method: "GET", headers: [["a", "b"]], body: null, marker: "c-1:f-1", timeoutMs: 100 });
    expect(src.startsWith("(function __tabcap_fetch_0a_1() {")).toBe(true);
    expect(src).toContain('"marker":"c-1:f-1"');
    expect(() => helperSource("bad name()", { url: "", method: "GET", headers: [], body: null, marker: null, timeoutMs: 1 })).toThrow();
    expect(helperResultOf({ ok: true, status: 200, bytes: 3 })).toMatchObject({ ok: true, status: 200, bytes: 3, marked: false });
    expect(helperResultOf({ ok: false, error: "TypeError: Failed to fetch" })).toMatchObject({ ok: false, aborted: false });
    expect(helperResultOf("x")).toBeNull();
    expect(helperResultOf({ ok: true })).toBeNull();
  });
});

describe("config.json fetch / sites.<name>.fetch", () => {
  test("defaults, a site's keys override the global ones, wrong values are errors", () => {
    expect(fetchConfigFrom({}, null)).toEqual(FETCH_DEFAULTS);
    expect(FETCH_DEFAULTS).toEqual({ minIntervalMs: 3000, concurrency: 1, stopOn: [] });
    const raw = { fetch: { minIntervalMs: 5000, stopOn: ["status>=400"] }, sites: { example: { fetch: { concurrency: 2, stopOn: ["empty-body"] } } } };
    expect(fetchConfigFrom(raw, null)).toEqual({ minIntervalMs: 5000, concurrency: 1, stopOn: ["status>=400"] });
    expect(fetchConfigFrom(raw, "example")).toEqual({ minIntervalMs: 5000, concurrency: 2, stopOn: ["empty-body"] });
    expect(fetchConfigFrom(raw, "other")).toEqual({ minIntervalMs: 5000, concurrency: 1, stopOn: ["status>=400"] });
    for (const bad of [{ fetch: 1 }, { fetch: { minIntervalMs: -1 } }, { fetch: { minIntervalMs: 1.5 } }, { fetch: { concurrency: 0 } }, { fetch: { stopOn: "x" } }, { sites: { example: { fetch: { concurrency: "2" } } } }, { sites: 3 }]) {
      expect(codeOf(() => fetchConfigFrom(bad, "example"))).toBe("bad-input");
    }
  });

  test("site of a URL: the session's site first, entry URL host or a stored domain (subdomains too), else the host", () => {
    const sites = [
      { name: "a", entryUrl: "http://127.0.0.1:4000/login", domains: [] },
      { name: "b", entryUrl: "https://b.example/", domains: ["api.example"] },
    ];
    expect(siteOf(sites, null, new URL("http://127.0.0.1:5000/x"))).toEqual({ key: "a", site: "a" });
    expect(siteOf(sites, null, new URL("https://v2.api.example/x"))).toEqual({ key: "b", site: "b" });
    expect(siteOf([...sites, { name: "c", entryUrl: "http://127.0.0.1/", domains: [] }], "c", new URL("http://127.0.0.1:5000/x"))).toEqual({ key: "c", site: "c" });
    expect(siteOf(sites, null, new URL("http://localhost:7/x"))).toEqual({ key: "localhost:7", site: null });
  });

  test("envelope headers are the selected ones, scrubbed; timing from the recorded event", () => {
    expect(envelopeHeaders({ "content-type": "application/json", "set-cookie": "sid=1", "x-other": "1", "retry-after": "S3CRET" }, (s) => s.replace("S3CRET", "<secret:x>"))).toEqual({
      "content-type": "application/json",
      "retry-after": "<secret:x>",
    });
    expect(envelopeTiming({ timing: { start: 10.5, responseStart: 11, end: 12.25 } })).toEqual({ startMono: 10.5, endMono: 12.25, ms: 1.75 });
    expect(envelopeTiming({})).toEqual({ startMono: null, endMono: null, ms: null });
  });
});

// ------------------------------------------------------------------ the fetch flow on a fake browser

type Served = { status: number; body: string; mime?: string };

/**
 * A fake Chrome: the helper's isolated world, compile and run; running the
 * helper emits the Network / Fetch events the spike recorded, in that order.
 */
function fakeBrowser(origin: string, serve: (url: string) => Served) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const sent: Array<{ method: string; params: CdpParams }> = [];
  const scripts = new Map<string, { fn: string; spec: Record<string, unknown> }>();
  const bodies = new Map<string, string>();
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let n = 0;
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const l of [...listeners]) l({ method, params, sessionId: "S1" });
  };
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const pausedFor = new Map<string, () => void>();
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}): Promise<CdpResult> => {
      sent.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.compileScript") {
        const src = String(params["expression"]);
        const fn = /^\(function (\w+)\(\)/.exec(src)?.[1] ?? "";
        const spec: unknown = JSON.parse(/const spec = (.*);\n/.exec(src)?.[1] ?? "{}");
        const id = String(100 + scripts.size);
        scripts.set(id, { fn, spec: isRecord(spec) ? spec : {} });
        return { scriptId: id };
      }
      if (method === "Runtime.runScript") return runHelper(String(params["scriptId"]));
      if (method === "Fetch.continueRequest") {
        pausedFor.get(String(params["requestId"]))?.(); // the request leaves Chrome now
        return {};
      }
      if (method === "Network.getResponseBody") return { body: bodies.get(String(params["requestId"])) ?? "", base64Encoded: false };
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
  async function runHelper(scriptId: string): Promise<CdpResult> {
    const s = scripts.get(scriptId);
    if (s === undefined) throw new Error("no script");
    const url = String(s.spec["url"]);
    const rid = `R${++n}`;
    const headers: Record<string, string> = {};
    const pairs = Array.isArray(s.spec["headers"]) ? s.spec["headers"] : [];
    for (const p of pairs) if (Array.isArray(p)) headers[String(p[0])] = String(p[1]);
    const same = new URL(url).origin === origin;
    if (same && typeof s.spec["marker"] === "string") headers[FETCH_MARKER] = s.spec["marker"];
    const initiator = { type: "script", stack: { callFrames: [{ functionName: s.fn, scriptId, url: "", lineNumber: 11, columnNumber: 9 }] } };
    emit("Network.requestWillBeSent", { requestId: rid, loaderId: "L1", type: "Fetch", timestamp: n, wallTime: 1760600000 + n, initiator, request: { url, method: String(s.spec["method"]), headers } });
    // With the Request stage held, the request waits for Fetch.continueRequest (the server sees what it carries then).
    const stageHeld = sent.some((x) => x.method === "Fetch.enable" && JSON.stringify(x.params).includes('"requestStage":"Request"'));
    let wire = { ...headers };
    if (stageHeld) {
      const continued = new Promise<void>((r) => pausedFor.set(`I${rid}`, r));
      emit("Fetch.requestPaused", { requestId: `I${rid}`, networkId: rid, resourceType: "Fetch", frameId: "T1", request: { url, method: String(s.spec["method"]), headers } });
      await continued;
      const c = [...sent].reverse().find((x) => x.method === "Fetch.continueRequest" && x.params["requestId"] === `I${rid}`);
      const hs = c !== undefined && Array.isArray(c.params["headers"]) ? c.params["headers"] : null;
      if (hs !== null) wire = Object.fromEntries(hs.filter(isRecord).map((h) => [String(h["name"]), String(h["value"])]));
    }
    seen.push({ url, headers: wire });
    emit("Network.requestWillBeSentExtraInfo", { requestId: rid, headers: wire });
    const r = serve(url);
    bodies.set(rid, r.body);
    emit("Network.responseReceived", { requestId: rid, type: "Fetch", timestamp: n + 0.1, response: { url, status: r.status, statusText: "OK", headers: { "content-type": r.mime ?? "application/json" }, mimeType: r.mime ?? "application/json" } });
    emit("Network.loadingFinished", { requestId: rid, timestamp: n + 0.2 });
    return { result: { type: "object", value: { ok: true, status: r.status, type: "basic", redirected: false, url, bytes: r.body.length, marked: same } } };
  }
  return { t, emit, sent, seen };
}

async function fetchHome(origin: string, serve: (url: string) => Served, config: Record<string, unknown> = { fetch: { minIntervalMs: 0 } }) {
  const root = tmp("tabcap-fetch-flow-");
  const p = paths({ TABCAP_HOME: root });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  writeFileSync(p.configFile, JSON.stringify(config));
  const d = new Daemon(p);
  const fb = fakeBrowser(origin, serve);
  const tabs = new Tabs(fb.t, false);
  const tab = await tabs.createTab("s1");
  tab.url = `${origin}/page`;
  const rec = await Recorder.start({ session: "s1", dir: join(root, "bundle"), t: fb.t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
  d.recorders.set("s1", rec);
  return { d, rec, fb, b: { t: fb.t, tabs, console: null } };
}

const ORIGIN = "http://127.0.0.1:9";

describe("the fetch flow (fake browser)", () => {
  test("concurrent fetches in overlapping command windows: each request carries its own fetchId and cmd; the marker never reaches the wire or the bundle", async () => {
    const { d, rec, fb, b } = await fetchHome(ORIGIN, (u) => ({ status: 200, body: JSON.stringify({ code: 0, n: new URL(u).searchParams.get("n") }) }));
    const c1 = rec.cmdStart({ tab: null, argv: null, input: {} });
    const c2 = rec.cmdStart({ tab: null, argv: null, input: {} });
    const c3 = rec.cmdStart({ tab: null, argv: null, input: {} }); // innermost open window: c3
    const [r1, r2] = await Promise.all([fetchRun(d, b, { url: "/api/item?n=1" }, "s1", { cmd: c1 }), fetchRun(d, b, { url: "/api/item?n=2" }, "s1", { cmd: c2 })]);
    expect(isRecord(r1) && isRecord(r2)).toBe(true);
    if (!isRecord(r1) || !isRecord(r2)) return;
    expect([r1["fetchId"], r2["fetchId"]]).toEqual([`${c1}:f-1`, `${c2}:f-1`]);
    expect([r1["body"], r2["body"], r1["status"], r1["bytes"]]).toEqual(['{"code":0,"n":"1"}', '{"code":0,"n":"2"}', 200, 18]);
    expect(Object.keys(r1).sort()).toEqual(["body", "bytes", "fetchId", "headers", "id", "mime", "status", "statusText", "timing", "waitedMs"]);
    // the wire (what continueRequest let out) has no marker
    expect(fb.seen.map((s) => Object.keys(s.headers).map((k) => k.toLowerCase()))).toEqual([[], []]);
    await rec.stop();
    const events = readFileSync(join(rec.dir, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
    const reqs = events.filter((e) => e["kind"] === "request");
    expect(reqs.map((e) => [e["id"], e["fetchId"], e["cmd"]])).toEqual([
      [r1["id"], `${c1}:f-1`, c1],
      [r2["id"], `${c2}:f-1`, c2],
    ]);
    expect(JSON.stringify(reqs)).not.toContain(FETCH_MARKER);
    expect(c3).not.toBeNull();
    // Request stage held during the fetches, then the recorder's own patterns back
    const enables = fb.sent.filter((x) => x.method === "Fetch.enable").map((x) => JSON.stringify(x.params).includes('"requestStage":"Request"'));
    expect(enables.at(-1)).toBe(false);
    expect(enables.filter(Boolean).length).toBeGreaterThan(0);
  });

  test("cross-origin: no marker, no Request-stage hold; attribution through the helper's function on the initiator stack", async () => {
    const { d, rec, fb, b } = await fetchHome(ORIGIN, () => ({ status: 200, body: "{}" }));
    const c = rec.cmdStart({ tab: null, argv: null, input: {} });
    const r = await fetchRun(d, b, { url: "http://127.0.0.1:10/api/cors" }, "s1", { cmd: c });
    expect(isRecord(r) && r["fetchId"]).toBe(`${c}:f-1`);
    expect(fb.sent.some((x) => x.method === "Fetch.enable" && JSON.stringify(x.params).includes('"requestStage":"Request"'))).toBe(false);
    expect(fb.sent.some((x) => x.method === "Fetch.continueRequest")).toBe(false);
    await rec.stop();
    expect(rec.index.map((e) => e.fetchId)).toEqual([`${c}:f-1`]);
  });

  test("a stop rule fires: response recorded, fetch.stopped with the r-N, a guard breaker event, the site refused until guard resume", async () => {
    const { d, rec, b } = await fetchHome(ORIGIN, (u) => ({ status: 200, body: u.includes("biz") ? '{"code":1}' : '{"code":0}' }), { fetch: { minIntervalMs: 0, stopOn: ["status>=500"] } });
    const c = rec.cmdStart({ tab: null, argv: null, input: {} });
    const err = await fetchRun(d, b, { url: "/api/biz", stopOn: ["json:$.code!=0"] }, "s1", { cmd: c }).catch((e: unknown) => e);
    expect(err instanceof TabcapError && err.code).toBe("fetch.stopped");
    if (!(err instanceof TabcapError)) return;
    const id = rec.index[0]?.id;
    expect(err.extra).toMatchObject({ site: "127.0.0.1:9", rule: "json:$.code!=0", detail: "$.code is 1", request: id });
    expect(isRecord(err.extra["result"]) && err.extra["result"]["stopped"]).toEqual({ rule: "json:$.code!=0", detail: "$.code is 1" });
    const refused = await fetchRun(d, b, { url: "/api/ok" }, "s1", { cmd: c }).catch((e: unknown) => e);
    expect(refused instanceof TabcapError && refused.code).toBe("guard.stopped");
    expect(rec.index.length).toBe(1); // nothing was sent
    expect(guardResume(d, { site: "127.0.0.1:9" }, "s1")).toMatchObject({ site: "127.0.0.1:9", resumed: true, rule: "json:$.code!=0", request: id });
    expect(codeOf(() => guardResume(d, { site: "127.0.0.1:9" }, "s1"))).toBe("not-found");
    const ok = await fetchRun(d, b, { url: "/api/ok" }, "s1", { cmd: c });
    expect(isRecord(ok) && ok["status"]).toBe(200);
    await rec.stop();
    const guard = readFileSync(join(rec.dir, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord).filter((e) => e["kind"] === "guard");
    expect(guard.map((g) => [g["event"], g["reason"], g["rule"], g["request"]])).toEqual([
      ["breaker", "fetch-stop", "json:$.code!=0", id],
      ["resume", "fetch-stop", "json:$.code!=0", id],
    ]);
  });

  test("bodies over 8 KB go to bodyFile (scrubbed); rawBody returns base64; --out writes the given file", async () => {
    const big = JSON.stringify({ pad: "x".repeat(9000) });
    const { d, rec, b } = await fetchHome(ORIGIN, (u) => ({ status: 200, body: u.includes("big") ? big : '{"s":"hello"}' }));
    const c = rec.cmdStart({ tab: null, argv: null, input: {} });
    const r = await fetchRun(d, b, { url: "/big" }, "s1", { cmd: c });
    expect(isRecord(r) && typeof r["bodyFile"] === "string" && !("body" in r)).toBe(true);
    if (isRecord(r)) expect(readFileSync(String(r["bodyFile"]), "utf8")).toBe(big);
    const raw = await fetchRun(d, b, { url: "/small", rawBody: true }, "s1", { cmd: c });
    expect(isRecord(raw) && Buffer.from(String(raw["bodyBase64"]), "base64").toString("utf8")).toBe('{"s":"hello"}');
    const outFile = join(tmp("tabcap-fetch-out-"), "o.json");
    const o = await fetchRun(d, b, { url: "/small", out: outFile }, "s1", { cmd: c });
    expect(isRecord(o) && o["bodyFile"]).toBe(outFile);
    expect(readFileSync(outFile, "utf8")).toBe('{"s":"hello"}');
    await rec.stop();
  });

  test("not recording → not-found before anything is sent; batch: every line validated first, then one envelope per line with f-1..f-K", async () => {
    const { d, rec, fb, b } = await fetchHome(ORIGIN, (u) => ({ status: 200, body: JSON.stringify({ u: new URL(u).pathname }) }));
    expect(await fetchRun(d, b, { url: "/x" }, "nobody", { cmd: null }).catch((e: unknown) => (e instanceof TabcapError ? e.code : e))).toBe("not-found");
    const c = rec.cmdStart({ tab: null, argv: null, input: {} });
    const bad = await fetchRun(d, b, { batch: [{ url: "/a" }, { url: "/b", body: "x" }] }, "s1", { cmd: c }).catch((e: unknown) => (e instanceof TabcapError ? e.message : e));
    expect(String(bad)).toContain("batch line 2");
    expect(fb.sent.some((x) => x.method === "Runtime.runScript")).toBe(false);
    const res = await fetchRun(d, b, { batch: [{ url: "/a" }, { url: "/b" }] }, "s1", { cmd: c });
    expect(isRecord(res) && Array.isArray(res["batch"])).toBe(true);
    if (!isRecord(res) || !Array.isArray(res["batch"])) return;
    expect(res["batch"].map((x) => (isRecord(x) && isRecord(x["data"]) ? [x["ok"], x["data"]["fetchId"], x["data"]["body"]] : x))).toEqual([
      [true, `${c}:f-1`, '{"u":"/a"}'],
      [true, `${c}:f-2`, '{"u":"/b"}'],
    ]);
    await rec.stop();
  });
});

describe("POST /fetch body validation (untrusted JSON never crashes the daemon)", () => {
  test("garbage bodies answer an error envelope", async () => {
    const root = tmp("tabcap-fetch-ep-");
    const d = new Daemon(paths({ TABCAP_HOME: root }));
    const bodies: unknown[] = [null, 1, "x", [], {}, { url: 5 }, { session: 3, url: "/x" }, { url: "/x", headers: "h" }, { url: "/x", batch: [] }, { url: "/x", out: "/tmp/x" }, { url: "/x", json: undefined, form: [["a"]] }, { session: "s", url: "/x", method: "POST", body: 1 }];
    for (const body of bodies) {
      const env = await handleFetch(d, body, () => undefined);
      expect(env.ok).toBe(false);
      if (!env.ok) expect(["usage", "not-running", "not-found"]).toContain(env.error.code);
    }
    // a valid request without a browser: not-running, not a crash
    const env = await handleFetch(d, { session: "s", url: "http://127.0.0.1:9/x" }, () => undefined);
    expect(!env.ok && env.error.code).toBe("not-running");
  });
});
