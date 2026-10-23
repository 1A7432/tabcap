// Streaming responses and Server-Sent Events (docs/04 §47, 0.9-C).
// - Which responses are streaming: the media type of Content-Type (before `;`,
//   trimmed, lowercase) is text/event-stream or application/x-ndjson.
// - parseEventStream: WHATWG HTML "Interpreting an event stream" over a recorded
//   body, https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
//   UTF-8 decode (one leading BOM dropped, invalid bytes as U+FFFD); lines end
//   with CRLF, LF or a lone CR; a blank line dispatches; `:` starts a comment;
//   `name: value` (one space after the colon dropped), a line without a colon is
//   a field name with an empty value; data / event / id (no NUL) / retry (ASCII
//   digits) are used, other fields ignored; a block still open at the end of
//   the stream is discarded.
// - `at`: the CDP monotonic ms of the span of bytes that completed a message
//   (the one holding the first byte of the line ending of its blank line).
// Oracle: the spec's examples, and Chrome's Network.eventSourceMessageReceived
// {eventName, eventId, data} for EventSource requests (docs/07 §1.1 E3a).
// Reproduce: bun test test/unit/sse09c.test.ts. Pure: no I/O; the body is
// untrusted page bytes and never throws.

/** The media types whose responses the recorder passes through and reads as they arrive (§47). */
export const STREAMING_TYPES: readonly string[] = ["text/event-stream", "application/x-ndjson"];

/** The media type of a Content-Type value (before `;`, no surrounding white space, lowercase); null when there is none. */
export function mediaTypeOf(contentType: string | null | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const t = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return t === "" ? null : t;
}

/** text/event-stream or application/x-ndjson, whatever the parameters and case (§47). */
export function isStreamingType(contentType: string | null | undefined): boolean {
  const t = mediaTypeOf(contentType);
  return t !== null && STREAMING_TYPES.includes(t);
}

/** text/event-stream: the responses whose messages become `sse` events (§47). */
export function isEventStream(contentType: string | null | undefined): boolean {
  return mediaTypeOf(contentType) === "text/event-stream";
}

/** A run of body bytes as they arrived: `bytes` long, at CDP monotonic `mono` ms (null: unknown). In body order. */
export type ByteSpan = { bytes: number; mono: number | null };

/** One dispatched message. `id` is the last event ID at dispatch ("" before any `id` field). */
export type SseMessage = { index: number; event: string; id: string; retry: number | null; data: string; at: number | null };

const CR = 0x0d;
const LF = 0x0a;

/**
 * The messages of an event stream body, in stream order. `spans` (arrival
 * spans covering the body from its first byte) give each message its `at`;
 * without them, or past their end, `at` is null.
 */
export function parseEventStream(body: Uint8Array, spans: readonly ByteSpan[] | null = null): SseMessage[] {
  const out: SseMessage[] = [];
  // ignoreBOM: a BOM inside the stream is data; only the one at the very start is dropped (below).
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const ends = spanEnds(spans);
  let data = "";
  let eventType = "";
  let lastId = "";
  let retry: number | null = null;
  let start = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  let spanIdx = 0;
  const atOf = (offset: number): number | null => {
    if (ends === null) return null;
    while (spanIdx < ends.length && (ends[spanIdx]?.end ?? 0) <= offset) spanIdx++;
    const s = ends[spanIdx];
    return s === undefined ? null : s.mono;
  };
  for (let i = start; i < body.length; i++) {
    const b = body[i];
    if (b !== CR && b !== LF) continue;
    const line = decoder.decode(body.subarray(start, i));
    const terminator = i;
    if (b === CR && body[i + 1] === LF) i++;
    start = i + 1;
    if (line === "") {
      // Dispatch (the last event ID string is already up to date: it is the buffer). An empty data
      // buffer dispatches nothing; `data:` with an empty value leaves "\n" in it, a message with data "".
      if (data !== "") {
        out.push({ index: out.length, event: eventType === "" ? "message" : eventType, id: lastId, retry, data: data.endsWith("\n") ? data.slice(0, -1) : data, at: atOf(terminator) });
      }
      data = "";
      eventType = "";
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (name) {
      case "data":
        data += `${value}\n`;
        break;
      case "event":
        eventType = value;
        break;
      case "id":
        if (!value.includes("\u0000")) lastId = value;
        break;
      case "retry":
        // ASCII digits only; a value past 2^53 cannot be kept exactly and is ignored (Chrome ignores one past 2^64).
        if (/^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))) retry = Number(value);
        break;
      default:
        break;
    }
  }
  // Whatever follows the last line ending (and a block without its blank line) is discarded.
  return out;
}

/** Cumulative end offsets of the spans; null without spans. */
function spanEnds(spans: readonly ByteSpan[] | null): Array<{ end: number; mono: number | null }> | null {
  if (spans === null) return null;
  const out: Array<{ end: number; mono: number | null }> = [];
  let end = 0;
  for (const s of spans) {
    if (!Number.isSafeInteger(s.bytes) || s.bytes < 0) return null;
    end += s.bytes;
    out.push({ end, mono: s.mono });
  }
  return out;
}
