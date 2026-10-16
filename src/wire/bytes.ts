// Byte-level pieces of the wire echo (pure, unit tested with recorded bytes):
// how much of a client's first flight is the ClientHello, where the first
// HTTP/2 request or HTTP/1.1 request head ends, and the hand-built HTTP/2 /
// HTTP/1.1 answers. Everything here reads untrusted bytes: malformed input
// gives a "bad" result, never an exception.

export const H2_PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** RFC 8446 §5.1: a record fragment is at most 2^14 bytes. */
const MAX_FRAGMENT = 1 << 14;
/** A ClientHello larger than this is not plausible (handshake messages are capped far below 2^24 in practice). */
const MAX_CLIENT_HELLO = 1 << 20;

export type HelloScan =
  | { kind: "need-more" }
  /** `end`: bytes up to and including the record that completes the ClientHello message. */
  | { kind: "complete"; end: number }
  | { kind: "not-tls"; reason: string };

/**
 * Scans the start of a client->server stream for a complete ClientHello: TLS
 * handshake records (content type 22) whose fragments, concatenated, hold one
 * handshake message of type 1 (RFC 8446 §4) with its 4-byte header and body.
 */
export function scanClientHello(buf: Uint8Array): HelloScan {
  let off = 0;
  const msg: number[] = []; // first bytes of the handshake stream, enough for the 4-byte header
  let need: number | null = null; // total handshake bytes (4 + body) once the header is known
  let have = 0;
  while (true) {
    if (buf.length < off + 5) return { kind: "need-more" };
    const type = buf[off] ?? 0;
    const major = buf[off + 1] ?? 0;
    if (type !== 22 || major !== 3) return { kind: "not-tls", reason: off === 0 ? "first bytes are not a TLS handshake record" : "record after the first is not a handshake record" };
    const len = ((buf[off + 3] ?? 0) << 8) | (buf[off + 4] ?? 0);
    if (len === 0 || len > MAX_FRAGMENT) return { kind: "not-tls", reason: `record length ${len}` };
    if (buf.length < off + 5 + len) return { kind: "need-more" };
    for (let i = 0; i < len && msg.length < 4; i++) msg.push(buf[off + 5 + i] ?? 0);
    have += len;
    off += 5 + len;
    if (need === null && msg.length >= 4) {
      if (msg[0] !== 1) return { kind: "not-tls", reason: `first handshake message is type ${msg[0] ?? 0}, not ClientHello` };
      need = 4 + (((msg[1] ?? 0) << 16) | ((msg[2] ?? 0) << 8) | (msg[3] ?? 0));
      if (need > MAX_CLIENT_HELLO) return { kind: "not-tls", reason: `ClientHello length ${need}` };
    }
    if (need !== null && have >= need) return { kind: "complete", end: off };
  }
}

export type RequestScan =
  | { kind: "need-more" }
  | { kind: "h2"; end: number; stream: number }
  | { kind: "h1"; end: number; requestLine: string }
  | { kind: "bad"; reason: string };

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

const H2_HEADERS = 0x1;
const H2_CONTINUATION = 0x9;
const END_HEADERS = 0x4;
/** Frames before the first request: preface SETTINGS, WINDOW_UPDATE, PRIORITY … ; more is not a browser. */
const MAX_H2_HEAD = 256 * 1024;
const MAX_H1_HEAD = 64 * 1024;

/**
 * The client's first request in a decrypted stream. `alpn` "h2" expects the
 * HTTP/2 preface (RFC 9113 §3.4) and frames up to the first HEADERS
 * (+ CONTINUATION) block with END_HEADERS; anything else (http/1.1 or no
 * ALPN) expects an HTTP/1.1 head ending in an empty line.
 */
export function scanFirstRequest(buf: Uint8Array, alpn: string | null): RequestScan {
  if (alpn === "h2") {
    if (buf.length < H2_PREFACE.length) return startsWith(H2_PREFACE, buf) ? { kind: "need-more" } : { kind: "bad", reason: "h2 negotiated but no connection preface" };
    if (!startsWith(buf, H2_PREFACE)) return { kind: "bad", reason: "h2 negotiated but no connection preface" };
    let off = H2_PREFACE.length;
    while (true) {
      if (off > MAX_H2_HEAD) return { kind: "bad", reason: "no request headers in the first 256 KiB" };
      if (buf.length < off + 9) return { kind: "need-more" };
      const len = ((buf[off] ?? 0) << 16) | ((buf[off + 1] ?? 0) << 8) | (buf[off + 2] ?? 0);
      const type = buf[off + 3] ?? 0;
      const flags = buf[off + 4] ?? 0;
      const stream = (((buf[off + 5] ?? 0) & 0x7f) * 2 ** 24) + ((buf[off + 6] ?? 0) << 16) + ((buf[off + 7] ?? 0) << 8) + (buf[off + 8] ?? 0);
      if (buf.length < off + 9 + len) return { kind: "need-more" };
      off += 9 + len;
      if ((type === H2_HEADERS || type === H2_CONTINUATION) && (flags & END_HEADERS) !== 0) return { kind: "h2", end: off, stream };
    }
  }
  const limit = Math.min(buf.length, MAX_H1_HEAD + 4);
  for (let i = 3; i < limit; i++) {
    if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13) {
      let lineEnd = 0;
      while (lineEnd < i && buf[lineEnd] !== 13) lineEnd++;
      return { kind: "h1", end: i + 1, requestLine: String.fromCharCode(...buf.subarray(0, Math.min(lineEnd, 8192))) };
    }
  }
  return buf.length > MAX_H1_HEAD ? { kind: "bad", reason: "no end of the request head in the first 64 KiB" } : { kind: "need-more" };
}

/** The request target of an HTTP/1.1 request line, or null. */
export function h1Target(requestLine: string): string | null {
  const parts = requestLine.split(" ");
  return parts.length === 3 && parts[1] !== undefined && parts[1] !== "" ? parts[1] : null;
}

// ---------------------------------------------------------------- answers

function frame(type: number, flags: number, stream: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  out[0] = (payload.length >>> 16) & 0xff;
  out[1] = (payload.length >>> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  out[5] = (stream >>> 24) & 0x7f;
  out[6] = (stream >>> 16) & 0xff;
  out[7] = (stream >>> 8) & 0xff;
  out[8] = stream & 0xff;
  out.set(payload, 9);
  return out;
}

/** RFC 7541 §5.1 integer with an N-bit prefix. */
export function hpackInt(n: number, prefixBits: number, firstByteHigh: number): number[] {
  const max = (1 << prefixBits) - 1;
  if (n < max) return [firstByteHigh | n];
  const out = [firstByteHigh | max];
  let rest = n - max;
  while (rest >= 128) {
    out.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

/** Literal Header Field Never Indexed — New Name (RFC 7541 §6.2.3), no Huffman: needs no table state. */
export function hpackLiteral(name: string, value: string): number[] {
  const n = new TextEncoder().encode(name);
  const v = new TextEncoder().encode(value);
  return [0x10, ...hpackInt(n.length, 7, 0), ...n, ...hpackInt(v.length, 7, 0), ...v];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const MAX_DATA_FRAME = 16_384; // SETTINGS_MAX_FRAME_SIZE initial value (RFC 9113 §6.5.2)

/**
 * A complete HTTP/2 answer on `stream`: empty SETTINGS, SETTINGS ACK, HEADERS
 * (200, JSON, length, no-store), DATA (END_STREAM on the last), GOAWAY
 * NO_ERROR — the client opens a new connection for its next request.
 */
export function h2Response(stream: number, status: number, body: Uint8Array): Uint8Array {
  const hdr = Uint8Array.from([
    ...hpackLiteral(":status", String(status)),
    ...hpackLiteral("content-type", "application/json"),
    ...hpackLiteral("content-length", String(body.length)),
    ...hpackLiteral("cache-control", "no-store"),
  ]);
  const goaway = new Uint8Array(8);
  goaway[0] = (stream >>> 24) & 0x7f;
  goaway[1] = (stream >>> 16) & 0xff;
  goaway[2] = (stream >>> 8) & 0xff;
  goaway[3] = stream & 0xff;
  const parts = [frame(0x4, 0x0, 0, new Uint8Array(0)), frame(0x4, 0x1, 0, new Uint8Array(0)), frame(0x1, END_HEADERS, stream, hdr)];
  if (body.length === 0) parts.push(frame(0x0, 0x1, stream, body));
  for (let o = 0; o < body.length; o += MAX_DATA_FRAME) {
    const chunk = body.subarray(o, Math.min(body.length, o + MAX_DATA_FRAME));
    parts.push(frame(0x0, o + MAX_DATA_FRAME >= body.length ? 0x1 : 0x0, stream, chunk));
  }
  parts.push(frame(0x7, 0x0, 0, goaway));
  return concat(parts);
}

export function h1Response(status: number, body: Uint8Array): Uint8Array {
  const reason = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
  const head = new TextEncoder().encode(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n`);
  return concat([head, body]);
}

/** The request path of an HTTP/2 HEADERS block cannot be read without HPACK; the echo asks the Zig report. */
export function roleOf(path: string | null): "navigation" | "fetch" | "client" | "other" {
  const p = path === null ? "" : path.split("?")[0] ?? "";
  if (p === "/") return "navigation";
  if (p === "/fetch") return "fetch";
  if (p === "/client") return "client";
  return "other";
}
