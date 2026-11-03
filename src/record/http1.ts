// Incremental HTTP/1.1 message parser for the record proxy (0.9-F, docs/04
// §50.1). It only finds message boundaries and reads heads and bodies for the
// recording: every input byte comes back in exactly one event's `raw`, so the
// proxy can forward the bytes unchanged. Framing per RFC 9112 §6: request
// bodies by Transfer-Encoding chunked, else Content-Length, else none;
// responses: HEAD requests, 1xx, 204 and 304 have none, then chunked, then
// Content-Length, else until the connection closes. 101 hands the rest of
// the stream over as opaque bytes. Malformed input (head over MAX_HEAD,
// conflicting or bad Content-Length, a bad chunk size, obs-fold, a bad start
// line) is an `error` event; the parser then stops reading.
// Oracle: RFC 9112 framing rules; hand-written byte streams in
// test/unit/record-http1.test.ts. Reproduce: bun test test/unit/record-http1.test.ts

export const MAX_HEAD = 64 * 1024;

export type Header = [name: string, value: string];
export type RequestHead = { kind: "request"; method: string; target: string; version: string; headers: Header[] };
export type ResponseHead = { kind: "response"; status: number; reason: string; version: string; headers: Header[] };
export type Head = RequestHead | ResponseHead;

export type ParseEvent =
  | { t: "head"; head: Head; raw: Uint8Array }
  /** A 1xx response other than 101 (100 Continue): the final response follows. */
  | { t: "info"; head: ResponseHead; raw: Uint8Array }
  /** `data`: body bytes without chunk framing (may be empty when `raw` is only framing). */
  | { t: "body"; data: Uint8Array; raw: Uint8Array }
  | { t: "end"; raw: Uint8Array }
  /** The stream is opaque from here (after 101, or after `toRaw()`): `raw` is passed on as is. */
  | { t: "raw"; raw: Uint8Array }
  | { t: "error"; reason: string; raw: Uint8Array };

type State = { s: "head" } | { s: "fixed"; left: number } | { s: "chunk-size" } | { s: "chunk-data"; left: number } | { s: "chunk-crlf" } | { s: "trailers" } | { s: "close" } | { s: "raw" } | { s: "dead" };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const EMPTY = new Uint8Array(0);

function indexOfCrlf(b: Uint8Array, from: number): number {
  for (let i = from; i + 1 < b.length; i++) if (b[i] === 0x0d && b[i + 1] === 0x0a) return i;
  return -1;
}

function indexOfHeadEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x0d && b[i + 1] === 0x0a && b[i + 2] === 0x0d && b[i + 3] === 0x0a) return i;
  return -1;
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

export function headerValues(headers: readonly Header[], name: string): string[] {
  const n = name.toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
}

/** Parse a head (start line + fields, without the final CRLF CRLF); a string is the reason it is malformed. */
export function parseHead(text: string, kind: "request" | "response"): Head | string {
  const lines = text.split("\r\n");
  const start = lines[0] ?? "";
  const headers: Header[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) return "obsolete line folding in a header";
    const c = line.indexOf(":");
    if (c <= 0) return `bad header line ${JSON.stringify(line.slice(0, 40))}`;
    const name = line.slice(0, c);
    if (!TOKEN.test(name)) return `bad header name ${JSON.stringify(name.slice(0, 40))}`;
    const value = line.slice(c + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (/[\r\n\0]/.test(value)) return `bad header value in ${name}`;
    headers.push([name, value]);
  }
  if (kind === "request") {
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/1\.[01])$/.exec(start);
    if (m === null) return `bad request line ${JSON.stringify(start.slice(0, 60))}`;
    return { kind, method: m[1] ?? "", target: m[2] ?? "", version: m[3] ?? "", headers };
  }
  const m = /^(HTTP\/1\.[01]) (\d{3})(?: (.*))?$/.exec(start);
  if (m === null) return `bad status line ${JSON.stringify(start.slice(0, 60))}`;
  return { kind, status: Number(m[2]), reason: m[3] ?? "", version: m[1] ?? "", headers };
}

/** Content-Length: null when absent, a string when malformed or conflicting. */
function contentLength(headers: readonly Header[]): number | null | string {
  const vals = headerValues(headers, "content-length").flatMap((v) => v.split(",").map((x) => x.trim()));
  if (vals.length === 0) return null;
  if (!vals.every((v) => /^\d{1,15}$/.test(v))) return "bad Content-Length";
  if (new Set(vals.map(Number)).size > 1) return "conflicting Content-Length values";
  return Number(vals[0]);
}

/** Transfer-Encoding: "none", "chunked", or a string naming what cannot be framed. */
function transferEncoding(headers: readonly Header[]): "none" | "chunked" | { bad: string } {
  const codings = headerValues(headers, "transfer-encoding")
    .flatMap((v) => v.split(","))
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== "");
  if (codings.length === 0) return "none";
  return codings[codings.length - 1] === "chunked" ? "chunked" : { bad: `Transfer-Encoding ${codings.join(", ")} does not end in chunked` };
}

export class Http1Parser {
  private buf: Uint8Array = EMPTY;
  private state: State = { s: "head" };

  /**
   * `kind`: which side this parser reads. A response parser needs the method
   * of the request each response answers (`nextMethod`, called once per
   * final response, in order); null when there is no outstanding request.
   */
  constructor(
    readonly kind: "request" | "response",
    private readonly nextMethod: () => string | null = () => null,
  ) {}

  /** True between messages (nothing of a message read yet). */
  get idle(): boolean {
    return this.state.s === "head" && this.buf.length === 0;
  }

  get opaque(): boolean {
    return this.state.s === "raw";
  }

  /** From now on every byte is opaque (the other side switched protocols). */
  toRaw(): ParseEvent[] {
    if (this.state.s === "dead") return [];
    this.state = { s: "raw" };
    const rest = this.buf;
    this.buf = EMPTY;
    return rest.length > 0 ? [{ t: "raw", raw: rest }] : [];
  }

  feed(chunk: Uint8Array): ParseEvent[] {
    const out: ParseEvent[] = [];
    if (this.state.s === "dead") return out;
    if (this.state.s === "raw") {
      if (chunk.length > 0) out.push({ t: "raw", raw: chunk });
      return out;
    }
    this.buf = this.buf.length === 0 ? chunk : concat(this.buf, chunk);
    this.run(out);
    return out;
  }

  /** The stream ended: a message read until close ends here; anything else unfinished is an error. */
  finish(): ParseEvent[] {
    const out: ParseEvent[] = [];
    const s = this.state.s;
    if (s === "close") out.push({ t: "end", raw: this.takeAll() });
    else if (s === "head" && this.buf.length === 0) return out;
    else if (s === "raw" || s === "dead") return out;
    else out.push({ t: "error", reason: s === "head" ? "the connection closed inside a message head" : "the connection closed before the message body ended", raw: this.takeAll() });
    this.state = { s: "dead" };
    return out;
  }

  private takeAll(): Uint8Array {
    const rest = this.buf;
    this.buf = EMPTY;
    return rest;
  }

  /** Move `n` bytes from the buffer into the raw bytes of the next event. */
  private take(n: number): Uint8Array {
    const t = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return t;
  }

  private fail(out: ParseEvent[], reason: string): void {
    out.push({ t: "error", reason, raw: this.takeAll() });
    this.state = { s: "dead" };
  }

  private run(out: ParseEvent[]): void {
    for (;;) {
      const st = this.state;
      switch (st.s) {
        case "head": {
          if (this.buf.length === 0) return;
          const end = indexOfHeadEnd(this.buf);
          if (end < 0) {
            if (this.buf.length > MAX_HEAD) this.fail(out, `message head larger than ${MAX_HEAD} bytes`);
            return;
          }
          if (end + 4 > MAX_HEAD) return this.fail(out, `message head larger than ${MAX_HEAD} bytes`);
          const text = latin1(this.buf.subarray(0, end));
          const head = parseHead(text, this.kind);
          if (typeof head === "string") return this.fail(out, head);
          const raw = this.take(end + 4);
          if (!this.afterHead(head, raw, out)) return;
          break;
        }
        case "fixed": {
          if (this.buf.length === 0) return;
          const n = Math.min(st.left, this.buf.length);
          const raw = this.take(n);
          out.push({ t: "body", data: raw, raw });
          const left = st.left - n;
          if (left === 0) {
            this.state = { s: "head" };
            out.push({ t: "end", raw: EMPTY });
          } else this.state = { s: "fixed", left };
          break;
        }
        case "chunk-size": {
          const e = indexOfCrlf(this.buf, 0);
          if (e < 0) {
            if (this.buf.length > 4096) this.fail(out, "chunk size line too long");
            return;
          }
          const line = latin1(this.buf.subarray(0, e));
          const hex = (line.split(";")[0] ?? "").trim();
          if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) return this.fail(out, `bad chunk size ${JSON.stringify(line.slice(0, 20))}`);
          const size = parseInt(hex, 16);
          const raw = this.take(e + 2);
          out.push({ t: "body", data: EMPTY, raw });
          this.state = size === 0 ? { s: "trailers" } : { s: "chunk-data", left: size };
          break;
        }
        case "chunk-data": {
          if (this.buf.length === 0) return;
          const n = Math.min(st.left, this.buf.length);
          const raw = this.take(n);
          out.push({ t: "body", data: raw, raw });
          this.state = st.left - n === 0 ? { s: "chunk-crlf" } : { s: "chunk-data", left: st.left - n };
          break;
        }
        case "chunk-crlf": {
          if (this.buf.length < 2) return;
          if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) return this.fail(out, "chunk data not followed by CRLF");
          out.push({ t: "body", data: EMPTY, raw: this.take(2) });
          this.state = { s: "chunk-size" };
          break;
        }
        case "trailers": {
          const e = indexOfCrlf(this.buf, 0);
          if (e < 0) {
            if (this.buf.length > MAX_HEAD) this.fail(out, "trailer section too large");
            return;
          }
          const raw = this.take(e + 2);
          if (e === 0) {
            this.state = { s: "head" };
            out.push({ t: "end", raw });
          } else out.push({ t: "body", data: EMPTY, raw });
          break;
        }
        case "close": {
          if (this.buf.length === 0) return;
          const raw = this.take(this.buf.length);
          out.push({ t: "body", data: raw, raw });
          return;
        }
        case "raw": {
          if (this.buf.length > 0) out.push({ t: "raw", raw: this.take(this.buf.length) });
          return;
        }
        case "dead":
          return;
      }
    }
  }

  /** Decide the framing after a head; false when parsing stops (error, upgrade). */
  private afterHead(head: Head, raw: Uint8Array, out: ParseEvent[]): boolean {
    if (head.kind === "response" && head.status >= 100 && head.status < 200 && head.status !== 101) {
      out.push({ t: "info", head, raw });
      return true;
    }
    out.push({ t: "head", head, raw });
    if (head.kind === "response" && head.status === 101) {
      this.nextMethod();
      this.state = { s: "raw" };
      if (this.buf.length > 0) out.push({ t: "raw", raw: this.take(this.buf.length) });
      return false;
    }
    let noBody = false;
    if (head.kind === "response") {
      const method = this.nextMethod();
      noBody = method === "HEAD" || head.status === 204 || head.status === 304 || (method === "CONNECT" && head.status >= 200 && head.status < 300);
    }
    if (noBody) {
      out.push({ t: "end", raw: EMPTY });
      return true;
    }
    const te = transferEncoding(head.headers);
    if (typeof te === "object") {
      if (head.kind === "request") {
        this.fail(out, te.bad);
        return false;
      }
      this.state = { s: "close" };
      return true;
    }
    if (te === "chunked") {
      this.state = { s: "chunk-size" };
      return true;
    }
    const cl = contentLength(head.headers);
    if (typeof cl === "string") {
      this.fail(out, cl);
      return false;
    }
    if (cl === null) {
      if (head.kind === "request") {
        out.push({ t: "end", raw: EMPTY });
        return true;
      }
      this.state = { s: "close" };
      return true;
    }
    if (cl === 0) {
      out.push({ t: "end", raw: EMPTY });
      return true;
    }
    this.state = { s: "fixed", left: cl };
    return true;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
