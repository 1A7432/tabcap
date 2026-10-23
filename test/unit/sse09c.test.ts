// 0.9-C streaming responses and SSE (docs/04 §47, docs/05 s74): the pure parts.
// Oracle: the WHATWG HTML "Interpreting an event stream" algorithm and its
// examples (https://html.spec.whatwg.org/multipage/server-sent-events.html),
// docs/04 §47 for which responses are streaming and for `at`, and the measured
// CDP shapes of docs/07 §1.1 E3a / E3c (streamResourceContent's bufferedData,
// dataReceived.data in base64, dataLength without data before streaming).
// The recorder over a fake transport: recorder09c.test.ts.
// Reproduce: bun test test/unit/sse09c.test.ts

import { describe, expect, test } from "bun:test";
import { DEFAULT_SIZE_CAP } from "../../src/bundle/blobs.ts";
import { StreamBody } from "../../src/daemon/capture/stream.ts";
import { isEventStream, isStreamingType, mediaTypeOf, parseEventStream } from "../../src/shared/sse.ts";

const enc = new TextEncoder();
const parse = (text: string | Uint8Array, spans: Parameters<typeof parseEventStream>[1] = null) => parseEventStream(typeof text === "string" ? enc.encode(text) : text, spans);
const brief = (text: string) => parse(text).map((m) => ({ event: m.event, id: m.id, data: m.data }));

describe("streaming type (§47: media type before `;`, trimmed, lowercase)", () => {
  test("text/event-stream and application/x-ndjson, with parameters and any case", () => {
    for (const ct of ["text/event-stream", "text/event-stream; charset=utf-8", " Text/Event-Stream ;charset=UTF-8", "application/x-ndjson", "APPLICATION/X-NDJSON; charset=utf-8"]) expect(isStreamingType(ct)).toBe(true);
    for (const ct of ["application/json", "text/plain", "text/event-streams", "application/ndjson", "application/x-ndjson-seq", "", null, undefined]) expect(isStreamingType(ct)).toBe(false);
    expect(isEventStream("TEXT/EVENT-STREAM;x=1")).toBe(true);
    expect(isEventStream("application/x-ndjson")).toBe(false);
    expect(mediaTypeOf("  ; charset=utf-8")).toBeNull();
    expect(mediaTypeOf("Text/HTML ; q=1")).toBe("text/html");
  });
});

describe("parseEventStream (WHATWG event stream interpretation)", () => {
  test("the spec's examples", () => {
    // "data: This is the first message." … (three blocks, the second with two data lines)
    expect(brief("data: This is the first message.\n\ndata: This is the second message, it\ndata: has two lines.\n\ndata: This is the third message.\n\n").map((m) => m.data)).toEqual([
      "This is the first message.",
      "This is the second message, it\nhas two lines.",
      "This is the third message.",
    ]);
    // event types
    expect(brief("event: add\ndata: 73857293\n\nevent: remove\ndata: 2153\n\nevent: add\ndata: 113411\n\n")).toEqual([
      { event: "add", id: "", data: "73857293" },
      { event: "remove", id: "", data: "2153" },
      { event: "add", id: "", data: "113411" },
    ]);
    // three data lines, one message
    expect(brief("data: YHOO\ndata: +2\ndata: 10\n\n")).toEqual([{ event: "message", id: "", data: "YHOO\n+2\n10" }]);
    // comment, id, `id` without a value resets it, only one leading space dropped
    expect(brief(": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n")).toEqual([
      { event: "message", id: "1", data: "first event" },
      { event: "message", id: "", data: "second event" },
      { event: "message", id: "", data: " third event" },
    ]);
    // `data` lines without values: "" then "\n"; the last block has no blank line and is discarded
    expect(brief("data\n\ndata\ndata\n\ndata:").map((m) => m.data)).toEqual(["", "\n"]);
    // the space after the colon is optional
    expect(brief("data:test\n\ndata: test\n\n").map((m) => m.data)).toEqual(["test", "test"]);
  });

  test("CRLF, LF and a lone CR end lines, also mixed in one stream; a CRLF split across spans counts once", () => {
    expect(brief("data: a\r\n\r\ndata: b\n\ndata: c\r\rdata: d\r\ndata: e\n\r\n").map((m) => m.data)).toEqual(["a", "b", "c", "d\ne"]);
    // CR at the end of one span, LF at the start of the next: one line ending, at the CR's span
    const ms = parse("data: x\r\n\r\n", [
      { bytes: 10, mono: 1 },
      { bytes: 1, mono: 2 },
    ]);
    expect(ms.map((m) => [m.data, m.at])).toEqual([["x", 1]]);
  });

  test("comments, lines without a colon, unknown fields, `id` with NUL, `retry` with non-digits", () => {
    expect(parse(":only a comment\n\n").length).toBe(0);
    expect(brief("data\n\n")).toEqual([{ event: "message", id: "", data: "" }]);
    expect(brief("foo: bar\ndata: x\nbaz\n\n")).toEqual([{ event: "message", id: "", data: "x" }]);
    expect(brief("id: 7\ndata: a\n\nid: 8\u00009\ndata: b\n\n").map((m) => m.id)).toEqual(["7", "7"]);
    const r = parse("retry: 100\ndata: a\n\nretry: 1.5\ndata: b\n\nretry: -3\ndata: c\n\nretry:  200\ndata: d\n\nretry: 99999999999999999999\ndata: e\n\nretry: 0300\ndata: f\n\n");
    // "retry:  200" keeps one space after the first is dropped: not all digits
    expect(r.map((m) => m.retry)).toEqual([100, 100, 100, 100, 100, 300]);
    expect(parse("data: a\n\n")[0]?.retry).toBeNull();
    // field names are case-sensitive
    expect(brief("Data: a\nEVENT: x\n\n")).toEqual([]);
  });

  test("a block without data dispatches nothing, but its id is kept for the next message; the event type is cleared", () => {
    expect(brief("id: 5\nevent: x\n\ndata: later\n\n")).toEqual([{ event: "message", id: "5", data: "later" }]);
    // event: with an empty value is the default type
    expect(brief("event:\ndata: a\n\n")[0]?.event).toBe("message");
  });

  test("UTF-8: one leading BOM dropped, a second one kept as data; invalid bytes become U+FFFD; Chinese text intact", () => {
    const bom = [0xef, 0xbb, 0xbf];
    expect(parse(new Uint8Array([...bom, ...enc.encode("data: a\n\n")])).map((m) => m.data)).toEqual(["a"]);
    // a BOM before a field name makes it another name: the line is ignored
    expect(parse(new Uint8Array([...bom, ...bom, ...enc.encode("data: a\n\n")])).length).toBe(0);
    expect(parse(new Uint8Array([...enc.encode("data: "), ...bom, ...enc.encode("x\n\n")]))[0]?.data).toBe("\ufeffx");
    expect(parse(new Uint8Array([...enc.encode("data: a"), 0xff, 0xc3, ...enc.encode("\n\n")]))[0]?.data).toBe("a\ufffd\ufffd");
    expect(parse('id: 1\ndata: {"choices":[{"delta":{"content":"tok1 中文"}}]}\n\n')[0]?.data).toBe('{"choices":[{"delta":{"content":"tok1 中文"}}]}');
  });

  test("what follows the last blank line is discarded (an incomplete message, an unterminated line)", () => {
    expect(brief("data: a\n\ndata: b\n").map((m) => m.data)).toEqual(["a"]);
    expect(brief("data: a\n\ndata: b").map((m) => m.data)).toEqual(["a"]);
    expect(parse("").length).toBe(0);
  });

  test("the s74 stream: comment and retry make no message, every third message has a type, two data lines and an id; done keeps the last id", () => {
    const nl = "\n";
    const pieces = [`: comment line${nl}${nl}`, `retry: 100000${nl}${nl}`];
    for (let i = 1; i <= 6; i++) {
      if (i % 3 === 0) pieces.push(`event: a${nl}id: ${i}${nl}data: line one ${i}${nl}data: line two ${i}${nl}${nl}`);
      else pieces.push(`id: ${i}${nl}data: {"choices":[{"delta":{"content":"tok${i} 中文"}}]}${nl}${nl}`);
    }
    pieces.push(`event: done${nl}data: [DONE]${nl}${nl}`);
    const ms = parse(pieces.join(""));
    expect(ms.map((m) => [m.index, m.event, m.id, m.retry])).toEqual([
      [0, "message", "1", 100000],
      [1, "message", "2", 100000],
      [2, "a", "3", 100000],
      [3, "message", "4", 100000],
      [4, "message", "5", 100000],
      [5, "a", "6", 100000],
      [6, "done", "6", 100000],
    ]);
    expect(ms[2]?.data).toBe("line one 3\nline two 3");
    expect(ms[6]?.data).toBe("[DONE]");
  });

  test("`at`: the span holding the line ending of the blank line; spans that do not cover it, or none, give null", () => {
    const body = "data: a\n\ndata: b\n\ndata: c\n\n"; // 9 bytes per message
    const spans = [
      { bytes: 5, mono: 100 },
      { bytes: 4, mono: 110 }, // ends message a
      { bytes: 9, mono: 120 }, // message b
      { bytes: 9, mono: null }, // message c, time unknown
    ];
    expect(parse(body, spans).map((m) => m.at)).toEqual([110, 120, null]);
    expect(parse(body, spans.slice(0, 2)).map((m) => m.at)).toEqual([110, null, null]);
    expect(parse(body).map((m) => m.at)).toEqual([null, null, null]);
    // a message completed by the first byte of a span takes that span's time
    expect(
      parse(body, [
        { bytes: 8, mono: 1 },
        { bytes: 19, mono: 2 },
      ]).map((m) => m.at),
    ).toEqual([2, 2, 2]);
    // malformed spans: no times at all
    expect(parse(body, [{ bytes: -1, mono: 1 }]).map((m) => m.at)).toEqual([null, null, null]);
  });
});

describe("StreamBody (bufferedData + dataReceived.data, §47)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const text = (b: Uint8Array | null) => (b === null ? null : Buffer.from(b).toString());

  test("buffered part first, then the data chunks in arrival order, also when a chunk is seen before the answer", () => {
    const s = new StreamBody(DEFAULT_SIZE_CAP);
    s.data({ dataLength: 3 }, 1);
    s.data({ dataLength: 2 }, 2);
    s.data({ data: b64("CD"), dataLength: 2 }, 4); // dispatched before the answer was handled
    s.started({ bufferedData: b64("abcAB") });
    s.data({ data: b64("EFG"), dataLength: 3 }, 5);
    expect(text(s.bytes())).toBe("abcABCDEFG");
    expect(s.spans()).toEqual([
      { bytes: 3, mono: 1 },
      { bytes: 2, mono: 2 },
      { bytes: 2, mono: 4 },
      { bytes: 3, mono: 5 },
    ]);
    expect(s.received).toBe(10);
  });

  test("earlier dataLengths that do not add up to bufferedData: one span without a time", () => {
    const s = new StreamBody(DEFAULT_SIZE_CAP);
    s.data({ dataLength: 3 }, 1);
    s.started({ bufferedData: b64("abcdef") });
    expect(s.spans()).toEqual([{ bytes: 6, mono: null }]);
    const empty = new StreamBody(DEFAULT_SIZE_CAP);
    empty.started({ bufferedData: "" });
    expect(empty.spans()).toEqual([]);
    expect(empty.bytes()?.length).toBe(0);
  });

  test("not streaming (pending, failed, malformed answer) or bytes gone missing: no body", () => {
    expect(new StreamBody(10).bytes()).toBeNull();
    const f = new StreamBody(10);
    f.failed();
    expect(f.bytes()).toBeNull();
    for (const bad of [null, {}, { bufferedData: 3 }, "x"]) {
      const m = new StreamBody(10);
      m.started(bad);
      expect(m.state).toBe("failed");
      expect(m.bytes()).toBeNull();
    }
    const lost = new StreamBody(100);
    lost.started({ bufferedData: b64("ab") });
    lost.data({ dataLength: 4 }, 3); // after streaming started, a chunk without its bytes
    expect(lost.bytes()).toBeNull();
    // malformed params are no data and no length
    const odd = new StreamBody(100);
    odd.data({ dataLength: -1 }, 1);
    odd.data({ dataLength: "3" }, 1);
    odd.started({ bufferedData: b64("x") });
    odd.data({ data: 42 }, 2);
    expect(text(odd.bytes())).toBe("x");
  });

  test("past the cap: nothing kept, too large, still counting", () => {
    const s = new StreamBody(8);
    s.started({ bufferedData: b64("12345") });
    s.data({ data: b64("678") }, 1);
    expect(s.tooLarge).toBe(false);
    expect(text(s.bytes())).toBe("12345678");
    s.data({ data: b64("9") }, 2);
    expect(s.tooLarge).toBe(true);
    expect(s.bytes()).toBeNull();
    s.data({ data: b64("0123") }, 3);
    expect(s.received).toBe(13);
    const big = new StreamBody(4);
    big.started({ bufferedData: b64("12345") });
    expect(big.tooLarge).toBe(true);
  });
});
