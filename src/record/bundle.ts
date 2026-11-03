// Writes the record proxy's exchanges as `request` events (0.9-F, docs/04
// §50.2 包). Events are written in arrival order (the proxy's ordinal: request
// head complete), not completion order, so seq is the order the client sent
// its requests in (§49 reads it). An exchange that ends early waits in a
// small reorder buffer until every earlier one has been written.
// Same conventions as a HAR import (§9.2): actor human, tab t1, no cmd / nav /
// cdp; type inferred from sec-fetch / content-type. Unlike an import:
// headersSource "wire", a monotonic clock (mono, timing in performance.now()
// ms, timing.cdp null), protocol http/1.1, response bodies de-chunked and
// decoded with the HAR import's decoder (wireEncoding keeps the header).
// Oracle: docs/04 §5.1 / §50.2; test/unit/record-proxy.test.ts reads the
// bundle back. Reproduce: bun test test/unit/record-proxy.test.ts

import type { BundleWriter } from "../bundle/writer.ts";
import type { Headers, UnsequencedEvent } from "../bundle/types.ts";
import { decodeWireBody, importedType } from "../bundle/har.ts";
import type { Header } from "./http1.ts";
import { headerValues } from "./http1.ts";
import type { Exchange } from "./proxy.ts";

const INLINE_MAX = 64 * 1024; // §5.3

/** §5.1 header object: lowercase names, repeated names as arrays. */
export function headersObject(list: readonly Header[]): Headers {
  const out: Headers = {};
  for (const [k0, v] of list) {
    const k = k0.toLowerCase();
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

function utf8OrNull(b: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

function missingReason(x: Exchange): string | null {
  const st = x.response?.status ?? 0;
  if (x.method === "HEAD" || st === 204) return "no-content";
  if (st === 304) return "not-modified";
  if (st >= 300 && st < 400) return "redirect";
  return null;
}

export class RecordWriter {
  private next = 1;
  private readonly ready = new Map<number, Exchange>();
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  written = 0;
  typeInferred = { "sec-fetch": 0, "content-type": 0 };

  constructor(private readonly w: BundleWriter) {}

  /** Hand over an ended exchange; written once every earlier one is. */
  add(x: Exchange): void {
    this.ready.set(x.ordinal, x);
    this.chain = this.chain.then(() => this.drain()).catch((e: unknown) => {
      this.failure ??= e;
    });
  }

  /** Wait for everything handed over so far; `upTo` ordinals that never arrive are skipped. */
  async settle(upTo: number): Promise<void> {
    await this.chain;
    while (this.next <= upTo) {
      if (!this.ready.has(this.next)) this.next++;
      else await this.drain();
    }
    await this.chain;
    if (this.failure !== null) throw this.failure;
  }

  private async drain(): Promise<void> {
    for (let x = this.ready.get(this.next); x !== undefined; x = this.ready.get(this.next)) {
      this.ready.delete(this.next);
      this.next++;
      const ev = await this.event(x);
      this.w.append((seq) => ({ ...ev, id: `r-${seq}` }));
      this.written++;
    }
  }

  private async blobOrInline(bytes: Uint8Array): Promise<{ inline: string } | { blob: string; size: number } | null> {
    const text = bytes.length <= INLINE_MAX ? utf8OrNull(bytes) : null;
    if (text !== null) return { inline: text };
    const put = await this.w.putBlob(bytes);
    return put.outcome === "stored" ? { blob: put.ref, size: put.size } : null;
  }

  private async event(x: Exchange): Promise<UnsequencedEvent> {
    const reqHeaders = headersObject(x.request.headers);
    let postData: { inline: string } | { blob: string; size: number } | null = null;
    let postDataMissing: { reason: string; detail: string } | null = null;
    if (x.reqBody.tooLarge) postDataMissing = { reason: "too-large", detail: `${x.reqBody.size} bytes` };
    else if (x.reqBody.size > 0) postData = await this.blobOrInline(x.reqBody.bytes());

    let response: Record<string, unknown> | null = null;
    let respHeaders: Headers | null = null;
    if (x.response !== null) {
      respHeaders = headersObject(x.response.headers);
      const ct = headerValues(x.response.headers, "content-type")[0] ?? null;
      const [mime, ...params] = (ct ?? "").split(";").map((s) => s.trim());
      const charset = params.find((p) => p.toLowerCase().startsWith("charset="));
      let body: Record<string, unknown> | null = null;
      let bodyMissing: Record<string, unknown> | null = null;
      if (x.websocket) bodyMissing = { reason: "unsupported", detail: "WebSocket: frames are not recorded (docs/04 §50.1)" };
      else if (x.respBody.tooLarge) bodyMissing = { reason: "too-large", detail: `${x.respBody.size} bytes` };
      else if (x.respBody.size === 0 && missingReason(x) !== null) bodyMissing = { reason: missingReason(x), detail: "no body on the wire" };
      else {
        const ce = headerValues(x.response.headers, "content-encoding")[0] ?? null;
        const dec = decodeWireBody(x.respBody.bytes(), ce);
        const put = await this.w.putBlob(dec.bytes);
        if (put.outcome === "stored") {
          body = { blob: put.ref, size: put.size, base64: false, wireEncoding: dec.wireEncoding, truncated: false };
          if (dec.decodeFailed) body["decodeFailed"] = true;
          if (x.partial) body["partial"] = true;
        } else bodyMissing = { reason: "too-large", detail: `${put.size} bytes > ${put.cap}` };
      }
      response = {
        status: x.response.status,
        statusText: x.response.reason,
        headers: respHeaders,
        headersSource: "wire",
        mimeType: mime === undefined || mime === "" ? null : mime,
        charset: charset === undefined ? null : charset.slice("charset=".length),
        protocol: "http/1.1",
        remote: x.remote,
        fromCache: false,
        fromServiceWorker: false,
        fromPrefetch: false,
        body,
        bodyMissing,
      };
    }
    const typed = x.websocket ? { type: "websocket" as const } : importedType({}, reqHeaders, respHeaders, null);
    if (typed.typeInferred !== undefined) this.typeInferred[typed.typeInferred]++;
    const u = (() => {
      try {
        return new URL(x.url);
      } catch {
        return null;
      }
    })();
    return {
      ts: x.ts,
      mono: x.start,
      kind: "request",
      actor: "human",
      tab: "t1",
      cmd: null,
      nav: null,
      id: "",
      cdp: null,
      type: typed.type,
      ...(typed.typeInferred === undefined ? {} : { typeInferred: typed.typeInferred }),
      method: x.method,
      url: u === null ? x.url : `${u.origin}${u.pathname}${u.search}`,
      urlFragment: null,
      initiator: null,
      request: { headers: reqHeaders, headersSource: "wire", postData, ...(postDataMissing === null ? {} : { postDataMissing }) },
      response,
      redirect: null,
      timing: { start: x.start, responseStart: x.responseStart, end: x.end, cdp: null },
      outcome: x.outcome,
      error: x.error === null ? null : { text: x.error, canceled: false, blockedReason: null },
    };
  }
}
