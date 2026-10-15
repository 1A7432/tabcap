import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { initiatorOf } from "../../src/daemon/capture/recorder.ts";
import { lookBack, parseListQuery, parseStatus, selectNet } from "../../src/daemon/tools/netquery.ts";
import { findRequestEvent, initiatorAt, materialize, requestDetail, summariseHeaders } from "../../src/daemon/tools/netshow.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { expectMode } from "./_platform.ts";

let seq = 0;
const entry = (o: Partial<NetEntry>): NetEntry => ({
  id: `r-${++seq}`,
  tab: "t1",
  type: "fetch",
  method: "GET",
  url: "http://127.0.0.1:8080/api/x",
  status: 200,
  mime: "application/json",
  size: 10,
  outcome: "finished",
  blob: null,
  bodyMissing: null,
  cmd: null,
  at: 1000,
  ...o,
});

// A port-scan page (docs/05 s20): 3 real requests, 60 failed scans, 10 data: images.
function noise(): NetEntry[] {
  const out: NetEntry[] = [entry({ type: "document", url: "http://127.0.0.1:8080/noise", mime: "text/html" })];
  for (let i = 0; i < 60; i++) out.push(entry({ url: `http://127.0.0.1:${9432 + (i % 58)}/`, status: null, outcome: "failed", at: 1100 + i }));
  for (let i = 0; i < 10; i++) out.push(entry({ type: "image", url: `data:image/svg+xml,${i}`, mime: "image/svg+xml", at: 1200 + i }));
  out.push(entry({ url: "http://127.0.0.1:8080/api/ok", at: 1300, cmd: "c-9" }));
  out.push(entry({ method: "POST", url: "http://api.example.test:9000/v1/log", status: 404, at: 1400, tab: "t2" }));
  return out;
}

const q = (a: Record<string, unknown> = {}, cmds: Record<string, number> = {}) => parseListQuery(a, (id) => cmds[id] ?? null);

describe("net list selection (docs/05 s20)", () => {
  test("default hides failed and data: but counts them; nothing silently dropped", () => {
    const r = selectNet(noise(), q());
    // No paging flag: every match (docs/08 §5, chrome-devtools-mcp semantics).
    expect(r).toMatchObject({ total: 73, matched: 3, shown: 3, hidden: { failed: 60, data: 10 }, pageSize: null, pageIdx: 0, totalPages: 1, nextPageIdx: null, offset: 0, limit: null, nextOffset: null });
    expect(r.pagination).toEqual(["Showing 1-3 of 3 (Page 1 of 1)."]);
    expect(r.total).toBe(r.matched + r.hidden.failed + r.hidden.data);
  });

  test("--failed shows only the failed ones; --all shows everything", () => {
    expect(selectNet(noise(), q({ failed: true }))).toMatchObject({ matched: 60, shown: 60, hidden: { failed: 0, data: 10 } });
    expect(selectNet(noise(), q({ all: true }))).toMatchObject({ matched: 73, hidden: { failed: 0, data: 0 } });
    expect(selectNet(noise(), q({ noFailed: true })).matched).toBe(3);
  });

  test("paging: --limit / --offset walk the matches oldest first with nextOffset", () => {
    const all = noise();
    const p1 = selectNet(all, q({ failed: true, limit: 25 }));
    const p2 = selectNet(all, q({ failed: true, limit: 25, offset: 25 }));
    const p3 = selectNet(all, q({ failed: true, limit: 25, offset: 50 }));
    expect([p1.shown, p2.shown, p3.shown]).toEqual([25, 25, 10]);
    expect([p1.nextOffset, p2.nextOffset, p3.nextOffset]).toEqual([25, 50, null]);
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((e) => e.id);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual(all.filter((e) => e.outcome === "failed").map((e) => e.id));
  });

  test("host / status / method / type / tab / since filters", () => {
    const all = noise();
    expect(selectNet(all, q({ host: "example.test" })).rows.map((e) => e.url)).toEqual(["http://api.example.test:9000/v1/log"]);
    expect(selectNet(all, q({ host: "127.0.0.1:9440", failed: true })).matched).toBe(1);
    expect(selectNet(all, q({ status: "4xx" })).rows.map((e) => e.status)).toEqual([404]);
    expect(selectNet(all, q({ status: "200" })).matched).toBe(2);
    expect(selectNet(all, q({ method: "post" })).matched).toBe(1);
    expect(selectNet(all, q({ type: "document,xhr" })).matched).toBe(1);
    expect(selectNet(all, q({ tab: "t2" })).matched).toBe(1);
    expect(selectNet(all, q({ since: "c-9" }, { "c-9": 1300 })).rows.map((e) => e.url)).toEqual(["http://127.0.0.1:8080/api/ok", "http://api.example.test:9000/v1/log"]);
  });

  test("bad arguments are usage errors; an unknown command id is not-found", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof TabcapError ? e.code : "other";
      }
      return "none";
    };
    expect(code(() => q({ status: "2x" }))).toBe("usage");
    expect(code(() => q({ limit: 0 }))).toBe("usage");
    expect(code(() => q({ offset: -1 }))).toBe("usage");
    expect(code(() => q({ failed: true, noFailed: true }))).toBe("usage");
    expect(code(() => q({ since: "12" }))).toBe("usage");
    expect(code(() => q({ since: "c-404" }))).toBe("not-found");
    expect(parseStatus("5XX")).toEqual({ klass: 5 });
    expect(parseStatus("204")).toEqual({ code: 204 });
  });
});

describe("net wait look-back (docs/04 §16)", () => {
  const base = { sinceArg: null, fresh: false, now: 5000, recordingStart: 100, cmdStart: (id: string) => (id === "c-7" ? 3000 : null) };
  test("default: the start of the most recent action command", () => {
    expect(lookBack({ ...base, last: { action: "click", at: 4000, cmd: "c-11" } })).toEqual({ since: 4000, from: "action", cmd: "c-11", action: "click" });
  });
  test("no action yet: the whole recording", () => {
    expect(lookBack({ ...base, last: null })).toMatchObject({ since: 100, from: "start" });
  });
  test("--since c-<n> | start, --fresh", () => {
    const last = { action: "click", at: 4000, cmd: "c-11" };
    expect(lookBack({ ...base, last, sinceArg: "c-7" })).toMatchObject({ since: 3000, from: "cmd", cmd: "c-7" });
    expect(lookBack({ ...base, last, sinceArg: "start" })).toMatchObject({ since: 100, from: "start" });
    expect(lookBack({ ...base, last, fresh: true })).toMatchObject({ since: 5000, from: "fresh" });
    expect(() => lookBack({ ...base, last, fresh: true, sinceArg: "start" })).toThrow(/exclude each other/);
    expect(() => lookBack({ ...base, last, sinceArg: "c-8" })).toThrow(/no command c-8/);
    expect(() => lookBack({ ...base, last, sinceArg: "yesterday" })).toThrow(/--since yesterday/);
  });
});

describe("net show", () => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-show-"));
  const long = JSON.stringify({ user: "alice", pad: "p".repeat(3000) });
  const ev = {
    seq: 12,
    kind: "request",
    id: "r-12",
    tab: "t1",
    nav: "n-3",
    cmd: "c-10",
    actor: "ai",
    type: "fetch",
    method: "POST",
    url: "http://127.0.0.1:8080/api/submit",
    initiator: { type: "script", url: "http://127.0.0.1:8080/post", line: 2, col: 0, stack: null },
    request: { headers: { "content-type": "application/json", "x-sign": "sig-1", cookie: "c".repeat(2100) }, postData: { inline: long } },
    response: { status: 200, statusText: "OK", headers: { "set-cookie": ["a=1", "b=2"] }, mimeType: "application/json", body: { blob: `sha256:${"ab".repeat(32)}`, size: 12, wireEncoding: null }, bodyMissing: null },
    timing: { start: 1000.5, responseStart: 1003, end: 1004.25, cdp: null },
    outcome: "finished",
    error: null,
  };

  test("requestDetail: headers, long postData as path + 2 KB head, body path, timing total, 1-based initiator", () => {
    const store = { pathOf: (r: string) => `/blobs/${r.slice(7, 9)}/${r.slice(7)}`, tryRead: () => null };
    const d = requestDetail(ev, store, (text) => materialize(dir, "post", "r-12.txt", text));
    expect(d).toMatchObject({ id: "r-12", tab: "t1", nav: "n-3", cmd: "c-10", method: "POST", status: 200, outcome: "finished" });
    const req = d["request"] as Record<string, Record<string, unknown>>;
    expect(req["headers"]?.["x-sign"]).toBe("sig-1");
    expect(String(req["headers"]?.["cookie"])).toMatch(/…\(\+52 chars\)$/);
    expect(req["postData"]).toMatchObject({ size: long.length, truncated: true });
    expect(String(req["postData"]?.["head"])).toHaveLength(2048);
    const path = String(req["postData"]?.["path"]);
    expect(readFileSync(path, "utf8")).toBe(long);
    expectMode(path, 0o600);
    expect(d["response"]).toMatchObject({ headers: { "set-cookie": ["a=1", "b=2"] }, mime: "application/json", body: { size: 12, path: `/blobs/ab/${"ab".repeat(32)}` } });
    expect(d["timing"]).toEqual({ start: 1000.5, responseStart: 1003, end: 1004.25, total: 3.75 });
    expect(d["initiator"]).toEqual({ type: "script", at: "http://127.0.0.1:8080/post:3:1" });
  });

  test("short postData stays inline", () => {
    const short = { ...ev, request: { headers: {}, postData: { inline: "a=1" } } };
    const d = requestDetail(short, { pathOf: () => null, tryRead: () => null }, () => "unused");
    expect((d["request"] as Record<string, unknown>)["postData"]).toEqual({ inline: "a=1", size: 3, truncated: false });
  });

  test("findRequestEvent reads the event line by id and skips torn lines", () => {
    const b = mkdtempSync(join(tmpdir(), "tabcap-show-b-"));
    writeFileSync(join(b, "events.jsonl"), [JSON.stringify({ seq: 1, kind: "cmd", id: "c-1" }), JSON.stringify(ev), '{"seq":13,"kind":"request","id":"r-13"'].join("\n"));
    expect(findRequestEvent(b, "r-12")?.["url"]).toBe(ev.url);
    expect(findRequestEvent(b, "r-13")).toBeNull();
    expect(findRequestEvent(b, "c-1")).toBeNull();
  });

  test("summariseHeaders drops non-string values; initiatorAt without line", () => {
    expect(summariseHeaders({ a: "1", b: 2, c: ["x", 3] })).toEqual({ a: "1", c: ["x"] });
    expect(initiatorAt({ url: "http://h/a.js", line: null, col: null })).toBe("http://h/a.js");
    expect(initiatorAt({ url: null })).toBeNull();
  });

  test("initiatorOf takes url / line / col from the stack's top frame (script initiators)", () => {
    const init = { type: "script", stack: { callFrames: [], parent: { callFrames: [{ url: "http://h/app.js", lineNumber: 9, columnNumber: 4 }] } } };
    expect(initiatorOf(init)).toEqual({ type: "script", url: "http://h/app.js", line: 9, col: 4, stack: null });
    expect(initiatorOf({ type: "parser", url: "http://h/", lineNumber: 1, columnNumber: 2 })).toEqual({ type: "parser", url: "http://h/", line: 1, col: 2, stack: null });
    expect(initiatorOf({ type: "other" })).toEqual({ type: "other", url: null, line: null, col: null, stack: null });
  });
});
