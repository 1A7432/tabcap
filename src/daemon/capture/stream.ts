// A streaming response body read while it arrives (docs/04 §47, 0.9-C).
// The recorder asks `Network.streamResourceContent {requestId}` on
// responseReceived of a text/event-stream / application/x-ndjson response: the
// answer's `bufferedData` (base64) is what arrived before, and every later
// `Network.dataReceived` of the request carries its bytes in `data` (base64).
// Buffered bytes first, then the data chunks in arrival order, are the body
// (measured E3a / E3c, docs/07 §1.1: byte-identical with what the server sent).
// dataReceived events that came before the answer carry no `data`; their
// `dataLength` / `timestamp` give the arrival times of the buffered part when
// their lengths add up to it (§47 `at`).
// Pure bookkeeping (no CDP calls here); CDP params are untrusted: a chunk that
// is not a string is not data, a length that is not a count is not a length.

import { isRecord, num, str } from "../../shared/json.ts";
import type { ByteSpan } from "../../shared/sse.ts";

export class StreamBody {
  /** pending: no answer to Network.streamResourceContent yet; failed: the command failed (the body is read at the end instead). */
  state: "pending" | "streaming" | "failed" = "pending";
  /** Settled once Network.streamResourceContent answered or failed (set by the recorder; never rejects). */
  ready: Promise<void> = Promise.resolve();
  /** The body went past the cap: nothing is kept any more (§47 too-large). */
  tooLarge = false;
  /** Body bytes streamed so far (buffered part and data chunks, kept or not), for the too-large detail. */
  received = 0;
  /** A dataReceived without `data` after streaming had started: bytes are missing, the accumulated body is not the response. */
  private lost = false;
  private buffered: Uint8Array | null = null;
  /** dataReceived before streaming started (no `data`): their lengths and times. */
  private pre: ByteSpan[] = [];
  private chunks: Array<{ bytes: Uint8Array; mono: number | null }> = [];
  private kept = 0;

  constructor(readonly cap: number) {}

  /** The answer of Network.streamResourceContent. An answer without `bufferedData` is a failure. */
  started(answer: unknown): void {
    const data = isRecord(answer) ? str(answer, "bufferedData") : null;
    if (data === null) {
      this.state = "failed";
      return;
    }
    this.state = "streaming";
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    this.buffered = bytes;
    this.received += bytes.length;
    this.keep(bytes.length);
  }

  failed(): void {
    this.state = "failed";
  }

  /** One Network.dataReceived of the request, with its timestamp as mono ms. */
  data(params: Record<string, unknown>, mono: number | null): void {
    const d = params["data"];
    if (typeof d === "string") {
      const bytes = new Uint8Array(Buffer.from(d, "base64"));
      this.received += bytes.length;
      if (this.tooLarge) return;
      this.chunks.push({ bytes, mono });
      this.keep(bytes.length);
      return;
    }
    const n = num(params, "dataLength");
    if (n === null || !Number.isSafeInteger(n) || n < 0) return;
    // Before the answer these bytes are in bufferedData; after it they would be missing from the body.
    if (this.state === "streaming") {
      if (n > 0) this.lost = true;
    } else this.pre.push({ bytes: n, mono });
  }

  /** The body as accumulated; null when streaming never started, bytes went missing, or it went past the cap. */
  bytes(): Uint8Array | null {
    if (this.state !== "streaming" || this.lost || this.tooLarge) return null;
    const parts = [this.buffered ?? new Uint8Array(0), ...this.chunks.map((c) => c.bytes)];
    const out = new Uint8Array(this.kept);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /**
   * Arrival spans of bytes(), in order: the buffered part split by the earlier
   * dataReceived lengths when they add up to it (one span with `mono: null`
   * otherwise), then one span per data chunk.
   */
  spans(): ByteSpan[] {
    const out: ByteSpan[] = [];
    const head = this.buffered?.length ?? 0;
    if (head > 0) {
      const sum = this.pre.reduce((n, s) => n + s.bytes, 0);
      if (sum === head) out.push(...this.pre.filter((s) => s.bytes > 0));
      else out.push({ bytes: head, mono: null });
    }
    for (const c of this.chunks) out.push({ bytes: c.bytes.length, mono: c.mono });
    return out;
  }

  private keep(n: number): void {
    this.kept += n;
    if (this.kept <= this.cap) return;
    this.tooLarge = true;
    this.buffered = null;
    this.chunks = [];
    this.pre = [];
    this.kept = 0;
  }
}
