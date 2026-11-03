// 0.9-F HTTP/1.1 framing for the record proxy (docs/04 §50.1). Expected
// values come from RFC 9112 §6 framing rules applied to hand-written byte
// streams; every input byte must come back in exactly one event's raw.

import { describe, expect, test } from "bun:test";
import { Http1Parser, MAX_HEAD, concat, type ParseEvent } from "../../src/record/http1.ts";

const te = new TextEncoder();
const td = new TextDecoder();
const b = (s: string) => te.encode(s);

/** Feed in pieces of `step` bytes (0: all at once), then finish. */
function parse(kind: "request" | "response", input: string, step = 0, methods: string[] = []): ParseEvent[] {
  const p = new Http1Parser(kind, () => methods.shift() ?? null);
  const bytes = b(input);
  const out: ParseEvent[] = [];
  if (step === 0) out.push(...p.feed(bytes));
  else for (let i = 0; i < bytes.length; i += step) out.push(...p.feed(bytes.subarray(i, i + step)));
  out.push(...p.finish());
  return out;
}

const raws = (evs: ParseEvent[]) => td.decode(concat(...evs.map((e) => e.raw)));
const bodies = (evs: ParseEvent[]) => td.decode(concat(...evs.flatMap((e) => (e.t === "body" ? [e.data] : []))));
const kinds = (evs: ParseEvent[]) => evs.map((e) => e.t).filter((t, i, a) => !(t === "body" && a[i - 1] === "body"));

describe("Http1Parser", () => {
  const REQS = "GET /a?x=1 HTTP/1.1\r\nHost: h\r\n\r\nPOST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhelloPOST /c HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n2\r\nde\r\n0\r\nX-T: 1\r\n\r\n";

  for (const step of [0, 1, 7]) {
    test(`three requests (none, Content-Length, chunked with a trailer), fed ${step === 0 ? "whole" : `${step} byte(s) at a time`}`, () => {
      const evs = parse("request", REQS, step);
      expect(raws(evs)).toBe(REQS);
      expect(kinds(evs)).toEqual(["head", "end", "head", "body", "end", "head", "body", "end"]);
      const heads = evs.flatMap((e) => (e.t === "head" && e.head.kind === "request" ? [`${e.head.method} ${e.head.target}`] : []));
      expect(heads).toEqual(["GET /a?x=1", "POST /b", "POST /c"]);
      expect(bodies(evs)).toBe("helloabcde");
    });
  }

  test("header names keep their case and order", () => {
    const evs = parse("request", "GET / HTTP/1.1\r\nX-B: 2\r\nhost: h\r\nX-A: 1\r\n\r\n");
    const h = evs[0]?.t === "head" ? evs[0].head.headers : [];
    expect(h).toEqual([
      ["X-B", "2"],
      ["host", "h"],
      ["X-A", "1"],
    ]);
  });

  test("responses: HEAD, 204 and 304 have no body; Content-Length; read until close", () => {
    const input = "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nHTTP/1.1 204 No Content\r\n\r\nHTTP/1.1 304 Not Modified\r\nContent-Length: 4\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\n\r\nuntil close";
    const evs = parse("response", input, 3, ["HEAD", "GET", "GET", "GET", "GET"]);
    expect(raws(evs)).toBe(input);
    expect(kinds(evs)).toEqual(["head", "end", "head", "end", "head", "end", "head", "body", "end", "head", "body", "end"]);
    expect(bodies(evs)).toBe("okuntil close");
  });

  test("100 Continue is info, then the final response", () => {
    const evs = parse("response", "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n", 0, ["POST"]);
    expect(evs.map((e) => e.t)).toEqual(["info", "head", "end"]);
  });

  test("101 hands the rest over as raw bytes", () => {
    const p = new Http1Parser("response", () => "GET");
    const evs = [...p.feed(b("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\x81\x02hi")), ...p.feed(b("more"))];
    expect(evs.map((e) => e.t)).toEqual(["head", "raw", "raw"]);
    expect(p.opaque).toBe(true);
    const req = new Http1Parser("request");
    req.feed(b("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n\x81"));
    expect(req.toRaw().map((e) => td.decode(e.raw))).toEqual(["\x81"]);
  });

  test("malformed input is an error event, never a throw", () => {
    const err = (kind: "request" | "response", s: string) => {
      const evs = parse(kind, s);
      const e = evs.find((x) => x.t === "error");
      return e?.t === "error" ? e.reason : null;
    };
    expect(err("request", "POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n")).toBe("bad Content-Length");
    expect(err("request", "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab")).toBe("conflicting Content-Length values");
    expect(err("request", "POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n")).toContain("does not end in chunked");
    expect(err("request", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")).toContain("bad chunk size");
    expect(err("request", "GET / HTTP/1.1\r\nA: 1\r\n folded\r\n\r\n")).toBe("obsolete line folding in a header");
    expect(err("request", "BAD\r\n\r\n")).toContain("bad request line");
    expect(err("response", "HTTP/2 200\r\n\r\n")).toContain("bad status line");
    expect(err("request", `GET / HTTP/1.1\r\nX: ${"a".repeat(MAX_HEAD)}\r\n`)).toContain("larger than");
    expect(err("request", "POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc")).toContain("before the message body ended");
    // a duplicate Content-Length with one value is fine (RFC 9110 §8.6)
    expect(err("request", "POST / HTTP/1.1\r\nContent-Length: 2, 2\r\n\r\nab")).toBeNull();
  });

  test("a response Transfer-Encoding that is not chunked is read until close", () => {
    const evs = parse("response", "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nzzz", 0, ["GET"]);
    expect(kinds(evs)).toEqual(["head", "body", "end"]);
  });
});
