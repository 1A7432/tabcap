// HAR 1.2 export / import (docs/04 §9).
// Spec: http://www.softwareishard.com/blog/har-12-spec/ ; Chrome DevTools
// extensions (_resourceType, _initiator, _fromCache, _webSocketMessages).
// Oracle: docs/04 §9.1 mapping table, §9.2 import rules, §9.3 round-trip
// properties (test/unit/har.test.ts). Reproduce: `bun test test/unit/har.test.ts`.

import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { brotliDecompressSync, inflateRawSync, inflateSync } from "node:zlib";
import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import { isRecord, num, rec, str } from "../shared/json.ts";
import { isoToTs, nowMs, tsToIso } from "../shared/time.ts";
import { toBytes } from "./blobs.ts";
import { TOOL_NAME, TOOL_VERSION } from "./manifest.ts";
import { parseInlineOrBlob, parseRequest, toRawEvent, toResourceType, type BundleView } from "./reader.ts";
import { blobRefsOf, redactView } from "./redact.ts";
import type { Headers, RawEvent, RequestEvent, ResourceType, UnsequencedEvent } from "./types.ts";
import { BundleWriter } from "./writer.ts";
import { dropIgnoredQuery, pickRule, type RuleSet } from "../replay/rules.ts";

// ------------------------------------------------------------ HAR shapes (output)

export type HarNameValue = { name: string; value: string };
export type HarCookie = { name: string; value: string };
export type HarPage = {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
};
export type HarContent = { size: number; mimeType: string; text?: string; encoding?: "base64" };
export type HarWsMessage = { type: "send" | "receive"; time: number; opcode: number; data: string };
export type HarEntry = {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: { mimeType: string; text: string; params: HarNameValue[] };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { blocked: number; dns: number; connect: number; ssl: number; send: number; wait: number; receive: number };
  serverIPAddress?: string;
  _seq: number;
  _id: string;
  _tab: string | null;
  _actor: string;
  _cmd: string | null;
  _nav: string | null;
  _resourceType: string;
  _initiator: unknown;
  _bodyMissing: unknown;
  _fromServiceWorker: boolean;
  _protocol: string | null;
  _fromCache: boolean;
  _webSocketMessages?: HarWsMessage[];
};
export type HarLog = {
  version: "1.2";
  creator: { name: string; version: string };
  browser?: { name: string; version: string };
  pages: HarPage[];
  entries: HarEntry[];
  _events?: RawEvent[];
};
export type HarDocument = { log: HarLog };

// ------------------------------------------------------------ helpers

const ROOT_PAGE_TYPES = new Set(["navigation", "reload", "back_forward"]);

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function headerList(h: Headers): HarNameValue[] {
  const out: HarNameValue[] = [];
  for (const [name, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const x of v) out.push({ name, value: x });
    else out.push({ name, value: v });
  }
  return out;
}

function firstHeader(h: Headers, name: string): string | null {
  const v = h[name];
  if (typeof v === "string") return v;
  return v?.[0] ?? null;
}

function allHeaders(h: Headers, name: string): string[] {
  const v = h[name];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function formDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function parsePairs(qs: string): HarNameValue[] {
  if (qs === "") return [];
  return qs.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq < 0 ? { name: formDecode(pair), value: "" } : { name: formDecode(pair.slice(0, eq)), value: formDecode(pair.slice(eq + 1)) };
  });
}

function queryOf(url: string): HarNameValue[] {
  const noFrag = url.split("#")[0] ?? "";
  const q = noFrag.indexOf("?");
  return q < 0 ? [] : parsePairs(noFrag.slice(q + 1));
}

function cookiesFromHeader(value: string): HarCookie[] {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      const eq = p.indexOf("=");
      return eq < 0 ? { name: p, value: "" } : { name: p.slice(0, eq), value: p.slice(eq + 1) };
    });
}

function setCookieToCookie(value: string): HarCookie {
  const first = value.split(";")[0] ?? "";
  const eq = first.indexOf("=");
  return eq < 0 ? { name: first.trim(), value: "" } : { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

/** Our `protocol` (CDP style: h2, h3, http/1.1) -> HAR httpVersion (DevTools style). */
function httpVersionOf(protocol: string | null): string {
  if (protocol === null) return "";
  const p = protocol.toLowerCase();
  if (p === "h2") return "http/2.0";
  if (p === "h3" || p.startsWith("h3-")) return "http/3.0";
  return protocol;
}

function protocolOf(httpVersion: string): string | null {
  const v = httpVersion.toLowerCase();
  if (v === "") return null;
  if (v === "http/2.0" || v === "h2") return "h2";
  if (v === "http/3.0" || v === "h3") return "h3";
  return httpVersion;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function payloadText(bytes: Uint8Array, binary: boolean): { text: string; base64: boolean } {
  const t = binary ? null : utf8OrNull(bytes);
  return t === null ? { text: Buffer.from(bytes).toString("base64"), base64: true } : { text: t, base64: false };
}

/**
 * §13 ruling 3: blocked / dns / connect / ssl are -1 when unknown; send / wait /
 * receive must be >= 0 (HAR 1.2), so unknown or negative spans become 0.
 */
function cdpTimings(r: RequestEvent): HarEntry["timings"] {
  const t: HarEntry["timings"] = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 };
  const cdp = r.timing?.cdp ?? null;
  const nonNegative = (x: number) => (x >= 0 ? x : 0);
  if (cdp !== null) {
    const g = (k: string): number => num(cdp, k) ?? -1;
    const span = (a: number, b: number) => (a >= 0 && b >= 0 && b >= a ? round3(b - a) : -1);
    const firstStart = [g("dnsStart"), g("connectStart"), g("sendStart")].find((x) => x >= 0);
    t.blocked = firstStart === undefined ? -1 : round3(firstStart);
    t.dns = span(g("dnsStart"), g("dnsEnd"));
    t.connect = span(g("connectStart"), g("connectEnd"));
    t.ssl = span(g("sslStart"), g("sslEnd"));
    t.send = nonNegative(span(g("sendStart"), g("sendEnd")));
    t.wait = nonNegative(span(g("sendEnd"), g("receiveHeadersEnd")));
  }
  const end = r.timing?.end ?? null;
  const rs = r.timing?.responseStart ?? null;
  if (end !== null && rs !== null) t.receive = nonNegative(round3(end - rs));
  return t;
}

/**
 * §13 ruling 2: a request event's `ts` is its completion time; HAR wants the
 * start, `ts - (mono - timing.start)`. Falls back to `ts` when either clock is missing.
 */
function startedTs(r: RequestEvent): number {
  const start = r.timing?.start ?? null;
  if (start === null || r.mono === null) return r.ts;
  const t = r.ts - (r.mono - start);
  return Number.isFinite(t) ? t : r.ts;
}

/**
 * §13 ruling 1: HAR pages are root navigation / reload / back_forward epochs.
 * Any other epoch (history, sub-frame) maps to the closest preceding page of
 * the same tab; an epoch with no page before it gets no pageref.
 */
function pageRefs(events: readonly RawEvent[], tabOk: (e: RawEvent) => boolean): Map<string, string> {
  const pageOf = new Map<string, string>();
  const lastPage = new Map<string | null, string>();
  for (const e of events) {
    if (e.kind !== "nav" || !tabOk(e)) continue;
    const id = str(e, "nav") ?? `n-${e.seq}`;
    if (e["frame"] === "root" && ROOT_PAGE_TYPES.has(str(e, "type") ?? "")) {
      pageOf.set(id, id);
      lastPage.set(e.tab, id);
    } else {
      const page = lastPage.get(e.tab);
      if (page !== undefined) pageOf.set(id, page);
    }
  }
  return pageOf;
}

// ------------------------------------------------------------ export

export type ExportOptions = {
  tab?: string;
  types?: readonly string[];
  embedEvents?: boolean;
  /** Redact before building the HAR (§8). Pass the per-export salt. */
  redact?: { salt: string; knownSecrets?: readonly string[] } | false;
  now?: () => number;
  /** `--rules` (0.6-C, §31): drop each request's ignoreQuery parameters from its URL and queryString; nothing else changes. */
  rules?: RuleSet;
};

export type ExportResult = {
  har: HarDocument;
  pages: number;
  entries: number;
  /** Event kinds not represented in the HAR (empty with embedEvents). */
  dropped: Record<string, number>;
  /** Requests left out: outcome incomplete, or filtered by tab/types. */
  skipped: { incomplete: number; filtered: number };
  redacted: boolean;
};

function wsMessages(view: BundleView, events: readonly RawEvent[], requestId: string): HarWsMessage[] {
  const out: HarWsMessage[] = [];
  for (const e of events) {
    if (e.kind !== "ws" || e["ws"] !== requestId || e["phase"] !== "frame") continue;
    const opcode = e["opcode"] === 2 ? 2 : 1;
    const p = parseInlineOrBlob(e["payload"]);
    let data = "";
    if (p !== null && "inline" in p) data = p.inline;
    else if (p !== null) {
      const bytes = view.readBlob(p.blob);
      if (bytes !== null) data = opcode === 2 ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
    }
    out.push({ type: e["direction"] === "send" ? "send" : "receive", time: e.ts / 1000, opcode, data });
  }
  return out;
}

function toEntry(view: BundleView, events: readonly RawEvent[], r: RequestEvent, pageOf: ReadonlyMap<string, string>, rules: RuleSet | undefined): HarEntry {
  const reqHeaders = r.request.headers;
  const url = rules === undefined ? r.url : dropIgnoredQuery(r.url, pickRule(rules, r));
  const resp = r.response;
  const httpVersion = httpVersionOf(resp?.protocol ?? null);

  let postData: HarEntry["request"]["postData"];
  let reqBodySize = 0;
  const pd = r.request.postData;
  if (pd !== null) {
    let text = "";
    if ("inline" in pd) text = pd.inline;
    else {
      const bytes = view.readBlob(pd.blob);
      text = bytes === null ? "" : new TextDecoder().decode(bytes);
    }
    reqBodySize = toBytes(text).length;
    const mimeType = firstHeader(reqHeaders, "content-type") ?? "";
    postData = { mimeType, text, params: mimeType.includes("x-www-form-urlencoded") ? parsePairs(text) : [] };
  }

  const content: HarContent = { size: 0, mimeType: resp?.mimeType ?? (resp === null ? null : firstHeader(resp.headers, "content-type")) ?? "x-unknown" };
  if (resp?.body) {
    content.size = resp.body.size;
    const bytes = view.readBlob(resp.body.blob);
    if (bytes !== null) {
      const t = payloadText(bytes, resp.body.base64);
      content.size = bytes.length;
      content.text = t.text;
      if (t.base64) content.encoding = "base64";
    }
  }

  const entry: HarEntry = {
    startedDateTime: tsToIso(startedTs(r)),
    time: r.timing !== null && r.timing.end !== null && r.timing.start !== null ? round3(r.timing.end - r.timing.start) : -1,
    request: {
      method: r.method,
      url,
      httpVersion,
      cookies: allHeaders(reqHeaders, "cookie").flatMap(cookiesFromHeader),
      headers: headerList(reqHeaders),
      queryString: queryOf(url),
      headersSize: -1,
      bodySize: reqBodySize,
    },
    response: {
      status: resp?.status ?? 0,
      statusText: resp?.statusText ?? "",
      httpVersion,
      cookies: resp === null ? [] : allHeaders(resp.headers, "set-cookie").map(setCookieToCookie),
      headers: resp === null ? [] : headerList(resp.headers),
      content,
      redirectURL: resp === null ? "" : (firstHeader(resp.headers, "location") ?? ""),
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: cdpTimings(r),
    _seq: r.seq,
    _id: r.id,
    _tab: r.tab,
    _actor: r.actor,
    _cmd: r.cmd,
    _nav: r.nav,
    _resourceType: r.type,
    _initiator: r.initiator,
    _bodyMissing: resp?.bodyMissing ?? null,
    _fromServiceWorker: resp?.fromServiceWorker ?? false,
    _protocol: resp?.protocol ?? null,
    _fromCache: resp?.fromCache ?? false,
  };
  const pageref = r.nav === null ? undefined : pageOf.get(r.nav);
  if (pageref !== undefined) entry.pageref = pageref;
  if (postData !== undefined) entry.request.postData = postData;
  if (resp?.remote) entry.serverIPAddress = resp.remote.ip;
  const msgs = wsMessages(view, events, r.id);
  if (r.type === "websocket" || msgs.length > 0) entry._webSocketMessages = msgs;
  return entry;
}

export function exportHar(source: BundleView, opts: ExportOptions = {}): ExportResult {
  const view: BundleView = opts.redact
    ? redactView(source, { salt: opts.redact.salt, knownSecrets: opts.redact.knownSecrets ?? [], ...(opts.now === undefined ? {} : { now: opts.now }) })
    : source;
  const events = view.events;
  const types = opts.types === undefined ? null : new Set(opts.types.map((t) => t.toLowerCase()));
  const tabOk = (e: RawEvent) => opts.tab === undefined || e.tab === opts.tab;

  const pageOf = pageRefs(events, tabOk);
  const pages: HarPage[] = [];
  const entries: HarEntry[] = [];
  const dropped: Record<string, number> = {};
  const skipped = { incomplete: 0, filtered: 0 };
  const drop = (kind: string) => {
    dropped[kind] = (dropped[kind] ?? 0) + 1;
  };

  for (const e of events) {
    if (e.kind === "nav") {
      const type = str(e, "type") ?? "";
      if (e["frame"] === "root" && ROOT_PAGE_TYPES.has(type)) {
        if (!tabOk(e)) continue;
        const load = rec(e, "loadEvent");
        const rel = (k: string): number => {
          const v = load === null ? null : num(load, k);
          return v !== null && e.mono !== null ? round3(v - e.mono) : -1;
        };
        const url = str(e, "url") ?? "";
        pages.push({
          startedDateTime: tsToIso(e.ts),
          id: str(e, "nav") ?? `n-${e.seq}`,
          title: url,
          pageTimings: { onContentLoad: rel("domContentLoaded"), onLoad: rel("load") },
        });
      } else drop("nav");
    } else if (e.kind === "request") {
      const r = parseRequest(e);
      if (typeof r === "string") {
        drop("request");
        continue;
      }
      if (r.outcome === "incomplete") {
        skipped.incomplete++;
        continue;
      }
      if (!tabOk(e) || (types !== null && !types.has(r.type))) {
        skipped.filtered++;
        continue;
      }
      entries.push(toEntry(view, events, r, pageOf, opts.rules));
    } else if (e.kind === "ws") {
      if (e["phase"] !== "frame") drop("ws");
    } else {
      drop(e.kind);
    }
  }

  const producer = view.manifest.producer;
  const log: HarLog = {
    version: "1.2",
    creator: { name: producer.tool || TOOL_NAME, version: producer.version || TOOL_VERSION },
    pages,
    entries,
  };
  if (producer.browser) log.browser = { name: producer.browser.name, version: producer.browser.version };
  if (opts.embedEvents === true) log._events = [...events];
  return { har: { log }, pages: pages.length, entries: entries.length, dropped: opts.embedEvents === true ? {} : dropped, skipped, redacted: Boolean(opts.redact) };
}

// ------------------------------------------------------------ import: validation

type HarHeaderIn = { name: string; value: string };
type HarEntryIn = {
  index: number;
  ts: number;
  pageref: string | null;
  method: string;
  url: string;
  httpVersion: string;
  reqHeaders: HarHeaderIn[];
  postText: string | null;
  status: number;
  statusText: string;
  respHeaders: HarHeaderIn[];
  content: { text: string | null; base64: boolean; mimeType: string | null };
  serverIPAddress: string | null;
  raw: Record<string, unknown>;
  ws: { type: string; time: number; opcode: number; data: string }[];
};
type HarPageIn = { index: number; id: string; ts: number; title: string };
type HarIn = {
  creator: { name: string; version: string } | null;
  browser: { name: string; version: string } | null;
  pages: HarPageIn[];
  entries: HarEntryIn[];
  events: unknown[] | null;
};

const badHar = (where: string, what: string) =>
  new TabcapError("bad-input", `HAR ${where}: ${what}`, "Export the HAR again from DevTools (Network panel > Export HAR) or check that the file is HAR 1.2 JSON.");

function parseHeadersIn(v: unknown, where: string): HarHeaderIn[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badHar(where, "headers is not an array");
  return v.map((h, i) => {
    if (!isRecord(h) || typeof h["name"] !== "string" || typeof h["value"] !== "string") throw badHar(`${where}[${i}]`, "header needs string name and value");
    return { name: h["name"], value: h["value"] };
  });
}

function parseHar(json: unknown): HarIn {
  if (!isRecord(json) || !isRecord(json["log"])) throw badHar("root", "missing log object");
  const log = json["log"];
  const entriesRaw = log["entries"];
  if (!Array.isArray(entriesRaw)) throw badHar("log", "entries is not an array");
  const pagesRaw = log["pages"] ?? [];
  if (!Array.isArray(pagesRaw)) throw badHar("log", "pages is not an array");

  const pages = pagesRaw.map((p, i): HarPageIn => {
    const where = `log.pages[${i}]`;
    if (!isRecord(p)) throw badHar(where, "not an object");
    const id = str(p, "id");
    const started = str(p, "startedDateTime");
    const ts = started === null ? null : isoToTs(started);
    if (id === null) throw badHar(where, "id is not a string");
    if (ts === null) throw badHar(where, "startedDateTime is not ISO 8601");
    return { index: i, id, ts, title: str(p, "title") ?? "" };
  });

  const entries = entriesRaw.map((e, i): HarEntryIn => {
    const where = `log.entries[${i}]`;
    if (!isRecord(e)) throw badHar(where, "not an object");
    const started = str(e, "startedDateTime");
    const ts = started === null ? null : isoToTs(started);
    if (ts === null) throw badHar(where, "startedDateTime is not ISO 8601");
    const req = rec(e, "request");
    const resp = rec(e, "response");
    if (req === null) throw badHar(where, "request is not an object");
    if (resp === null) throw badHar(where, "response is not an object");
    const method = str(req, "method");
    const url = str(req, "url");
    const status = num(resp, "status");
    if (method === null) throw badHar(`${where}.request`, "method is not a string");
    if (url === null) throw badHar(`${where}.request`, "url is not a string");
    if (status === null) throw badHar(`${where}.response`, "status is not a number");
    const post = rec(req, "postData");
    const content = rec(resp, "content") ?? {};
    const wsRaw = e["_webSocketMessages"];
    const ws: HarEntryIn["ws"] = [];
    if (Array.isArray(wsRaw)) {
      wsRaw.forEach((m, j) => {
        const mw = `${where}._webSocketMessages[${j}]`;
        if (!isRecord(m)) throw badHar(mw, "not an object");
        const time = num(m, "time");
        if (time === null) throw badHar(mw, "time is not a number");
        ws.push({ type: str(m, "type") ?? "receive", time, opcode: num(m, "opcode") ?? 1, data: str(m, "data") ?? "" });
      });
    }
    return {
      index: i,
      ts,
      pageref: str(e, "pageref"),
      method,
      url,
      httpVersion: str(resp, "httpVersion") ?? str(req, "httpVersion") ?? "",
      reqHeaders: parseHeadersIn(req["headers"], `${where}.request.headers`),
      postText: post === null ? null : str(post, "text"),
      status,
      statusText: str(resp, "statusText") ?? "",
      respHeaders: parseHeadersIn(resp["headers"], `${where}.response.headers`),
      content: { text: str(content, "text"), base64: content["encoding"] === "base64", mimeType: str(content, "mimeType") },
      serverIPAddress: str(e, "serverIPAddress"),
      raw: e,
      ws,
    };
  });

  const creatorRaw = rec(log, "creator");
  const browserRaw = rec(log, "browser");
  const nameVersion = (o: Record<string, unknown> | null) => (o === null ? null : { name: str(o, "name") ?? "", version: str(o, "version") ?? "" });
  const eventsRaw = log["_events"];
  if (eventsRaw !== undefined && !Array.isArray(eventsRaw)) throw badHar("log", "_events is not an array");
  return { creator: nameVersion(creatorRaw), browser: nameVersion(browserRaw), pages, entries, events: eventsRaw ?? null };
}

// ------------------------------------------------------------ import: bodies

/** §5.1 header object from a HAR list: lowercase names, no pseudo headers, repeats as arrays. */
function headersFromHar(list: readonly HarHeaderIn[]): Headers {
  const out: Headers = {};
  for (const { name, value } of list) {
    if (name.startsWith(":")) continue;
    const k = name.toLowerCase();
    const prev = out[k];
    if (prev === undefined) out[k] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[k] = [prev, value];
  }
  return out;
}

export type DecodedBody = { bytes: Uint8Array; base64: boolean; wireEncoding: string | null; decodeFailed: boolean };

/**
 * §9.2: base64 text is decoded first. When content-encoding is set, gzip (magic
 * 1f 8b), deflate and brotli are tried; success stores the decompressed bytes.
 * §13 ruling 4: when decompression fails but the bytes are valid UTF-8 text,
 * the HAR producer already decoded them (DevTools does): store them as-is
 * without decodeFailed. Only undecodable binary is marked decodeFailed.
 * wireEncoding records the header value in every case.
 */
function decodeHarBody(text: string, base64: boolean, contentEncoding: string | null): DecodedBody {
  const raw = base64 ? new Uint8Array(Buffer.from(text, "base64")) : toBytes(text);
  const ce = contentEncoding?.trim().toLowerCase() ?? "";
  if (ce === "" || ce === "identity") return { bytes: raw, base64, wireEncoding: null, decodeFailed: false };
  const rawText = utf8OrNull(raw);
  const attempts: (() => Uint8Array)[] = [];
  if (raw[0] === 0x1f && raw[1] === 0x8b) attempts.push(() => Bun.gunzipSync(new Uint8Array(raw)));
  if (ce.includes("deflate")) attempts.push(() => new Uint8Array(inflateSync(raw)), () => new Uint8Array(inflateRawSync(raw)));
  attempts.push(() => new Uint8Array(brotliDecompressSync(raw)));
  for (const attempt of attempts) {
    try {
      const out = attempt();
      // Text that "decodes" into non-text is a false positive (brotli has no magic number).
      if (rawText !== null && utf8OrNull(out) === null) continue;
      return { bytes: out, base64, wireEncoding: contentEncoding, decodeFailed: false };
    } catch {
      // try the next decoder
    }
  }
  return { bytes: raw, base64, wireEncoding: contentEncoding, decodeFailed: rawText === null };
}

// ------------------------------------------------------------ import

export type ImportOptions = { now?: () => number; name?: string; sizeCap?: number };

export type ImportResult = {
  out: string;
  events: number;
  requests: number;
  pages: number;
  wsFrames: number;
  restoredFromEvents: boolean;
  lossy: string[];
  missingBlobs: string[];
};

const INLINE_MAX = 64 * 1024; // §5.3

function ensureEmptyDir(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new TabcapError("conflict", `output directory is not empty: ${dir}`, "Pick a new directory for the imported bundle.");
  }
}

/** Every byte payload a HAR carries, for restoring blobs referenced by `_events`. */
function harPayloads(har: HarIn): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const e of har.entries) {
    if (e.content.text !== null) {
      const ce = headersFromHar(e.respHeaders)["content-encoding"];
      out.push(decodeHarBody(e.content.text, e.content.base64, typeof ce === "string" ? ce : null).bytes);
    }
    if (e.postText !== null) out.push(toBytes(e.postText));
    for (const m of e.ws) out.push(m.opcode === 2 ? new Uint8Array(Buffer.from(m.data, "base64")) : toBytes(m.data));
  }
  return out;
}

/** Validate `log._events` fully before anything is written. */
function parseEmbeddedEvents(raw: readonly unknown[]): RawEvent[] {
  const events: RawEvent[] = [];
  let prev = 0;
  raw.forEach((obj, i) => {
    const e = toRawEvent(obj);
    if (typeof e === "string") throw badHar(`log._events[${i}]`, e);
    if (e.seq <= prev) throw badHar(`log._events[${i}]`, `seq ${e.seq} is not greater than ${prev}`);
    prev = e.seq;
    events.push(e);
  });
  return events;
}

export async function importHar(harJson: unknown, outDir: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const har = parseHar(harJson);
  const embedded = har.events === null ? null : parseEmbeddedEvents(har.events);
  ensureEmptyDir(outDir);
  const now = opts.now ?? nowMs;
  const firstUrl = har.pages[0]?.title ?? har.entries[0]?.url ?? null;
  const w = await BundleWriter.open(outDir, {
    now,
    ...(opts.sizeCap === undefined ? {} : { sizeCap: opts.sizeCap }),
    init: {
      producer: { tool: TOOL_NAME, version: TOOL_VERSION, browser: har.browser },
      session: { name: opts.name ?? basename(outDir), tabs: [{ tab: "t1", chromeTabId: null, owned: false, firstUrl }] },
      mode: { capture: "passive", trace: false, raw: false, humanRecorder: false },
      imported: { from: "har", creator: har.creator, lossy: [] },
    },
  });

  let result: ImportResult;
  try {
    result = embedded !== null ? await restoreFromEvents(w, har, embedded, outDir) : await importEntries(w, har, outDir);
  } catch (e) {
    await w.close({ finished: null }); // leave it visibly unfinished, never complete
    throw e;
  }
  await w.close();
  return result;
}

async function restoreFromEvents(w: BundleWriter, har: HarIn, events: readonly RawEvent[], outDir: string): Promise<ImportResult> {
  const refs = new Set<string>();
  for (const e of events) {
    w.appendRestored(e);
    blobRefsOf(e, refs);
  }
  for (const bytes of harPayloads(har)) {
    const ref = `sha256:${sha256Hex(bytes)}`;
    if (refs.has(ref) && !w.blobs.has(ref)) await w.putBlob(bytes);
  }
  const missingBlobs = [...refs].filter((r) => !w.blobs.has(r));
  const lossy = ["manifest", ...(missingBlobs.length > 0 ? ["blobs"] : [])];
  w.updateManifest((m) => {
    m.imported = { from: "har", creator: har.creator, lossy };
  });
  return {
    out: outDir,
    events: events.length,
    requests: events.filter((e) => e.kind === "request").length,
    pages: events.filter((e) => e.kind === "nav").length,
    wsFrames: events.filter((e) => e.kind === "ws").length,
    restoredFromEvents: true,
    lossy,
    missingBlobs,
  };
}

type Item =
  | { kind: "nav"; ts: number; order: number; page: HarPageIn }
  | { kind: "request"; ts: number; order: number; entry: HarEntryIn }
  | { kind: "ws"; ts: number; order: number; entry: HarEntryIn; msg: HarEntryIn["ws"][number] };

async function importEntries(w: BundleWriter, har: HarIn, outDir: string): Promise<ImportResult> {
  // Order everything by time (§9.2), stable: pages, then entries, then frames.
  const items: Item[] = [];
  let order = 0;
  for (const page of har.pages) items.push({ kind: "nav", ts: page.ts, order: order++, page });
  for (const entry of har.entries) items.push({ kind: "request", ts: entry.ts, order: order++, entry });
  for (const entry of har.entries) for (const msg of entry.ws) items.push({ kind: "ws", ts: msg.time * 1000, order: order++, entry, msg });
  items.sort((a, b) => a.ts - b.ts || a.order - b.order);

  const base = w.lastSeq;
  const seqOfPage = new Map<string, number>();
  const seqOfEntry = new Map<number, number>();
  items.forEach((it, i) => {
    if (it.kind === "nav") seqOfPage.set(it.page.id, base + i + 1);
    if (it.kind === "request") seqOfEntry.set(it.entry.index, base + i + 1);
  });

  let lacksInitiator = false;
  let lacksBody = false;
  let lacksTiming = false;
  const env = { mono: null, actor: "human" as const, tab: "t1", cmd: null };

  for (const it of items) {
    const expected = w.lastSeq + 1;
    if (it.kind === "nav") {
      w.append((seq) => ({ ts: it.ts, ...env, kind: "nav", frame: "root", nav: `n-${seq}`, url: it.page.title, from: null, type: "navigation", loaderId: null, loadEvent: null }));
    } else if (it.kind === "ws") {
      const hs = seqOfEntry.get(it.entry.index) ?? 0;
      const opcode = it.msg.opcode === 2 ? 2 : 1;
      let payload: { inline: string } | { blob: string; size: number } = { inline: it.msg.data };
      if (it.msg.data.length > INLINE_MAX) {
        const bytes = opcode === 2 ? new Uint8Array(Buffer.from(it.msg.data, "base64")) : toBytes(it.msg.data);
        const put = await w.putBlob(bytes);
        if (put.outcome === "stored") payload = { blob: put.ref, size: put.size };
      }
      w.append({ ts: it.ts, ...env, kind: "ws", ws: `r-${hs}`, phase: "frame", direction: it.msg.type === "send" ? "send" : "recv", opcode, payload, reason: null });
    } else {
      const ev = await requestFromEntry(w, it.entry, seqOfPage);
      if (ev.initiator === null) lacksInitiator = true;
      if (ev.timing === null) lacksTiming = true;
      if (it.entry.content.text === null) lacksBody = true;
      w.append((seq) => ({ ...ev, id: `r-${seq}` }));
    }
    if (w.lastSeq !== expected) throw new TabcapError("internal", `import seq drift at ${expected}`, "This is a bug in HAR import.");
  }

  const lossy = ["actor", "tab", "cmd", "mono", "cdp", "headersSource", "redirect"];
  if (lacksTiming) lossy.push("timing");
  if (lacksInitiator) lossy.push("initiator");
  if (lacksBody) lossy.push("bodies");
  w.updateManifest((m) => {
    m.imported = { from: "har", creator: har.creator, lossy };
  });
  return {
    out: outDir,
    events: items.length,
    requests: har.entries.length,
    pages: har.pages.length,
    wsFrames: items.filter((i) => i.kind === "ws").length,
    restoredFromEvents: false,
    lossy,
    missingBlobs: [],
  };
}

// ------------------------------------------------------------ import: type and timing

function headerValue(h: Headers, name: string): string | null {
  const v = h[name];
  if (typeof v === "string") return v;
  return Array.isArray(v) && v.length > 0 ? (v[0] ?? null) : null;
}

/** docs/04 section 9.2 table step 2: `sec-fetch-dest` (`empty` is xhr only with `x-requested-with: XMLHttpRequest`, else fetch). */
function typeFromSecFetch(req: Headers): ResourceType | null {
  const dest = headerValue(req, "sec-fetch-dest")?.trim().toLowerCase() ?? null;
  switch (dest) {
    case "document":
    case "iframe":
      return "document";
    case "script":
    case "image":
    case "font":
      return dest;
    case "style":
      return "stylesheet";
    case "audio":
    case "video":
      return "media";
    case "empty":
      return headerValue(req, "x-requested-with")?.trim().toLowerCase() === "xmlhttprequest" ? "xhr" : "fetch";
    default:
      return null;
  }
}

/** docs/04 section 9.2 table step 3: the response content-type. */
function typeFromContentType(contentType: string | null): ResourceType {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct === "text/html") return "document";
  if (ct.includes("javascript")) return "script";
  if (ct === "text/css") return "stylesheet";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("font/")) return "font";
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return "media";
  if (ct.includes("json") || ct.includes("xml") || ct === "text/plain") return "xhr";
  return "other";
}

/** The imported event's type and, when `_resourceType` is absent, how it was inferred. */
function importedType(raw: Record<string, unknown>, req: Headers, resp: Headers | null, mimeType: string | null): { type: ResourceType; typeInferred?: "sec-fetch" | "content-type" } {
  if (raw["_resourceType"] !== undefined) return { type: toResourceType(raw["_resourceType"]) };
  const bySecFetch = typeFromSecFetch(req);
  if (bySecFetch !== null) return { type: bySecFetch, typeInferred: "sec-fetch" };
  if (resp === null) return { type: "other" }; // no response: nothing to infer from
  return { type: typeFromContentType(headerValue(resp, "content-type") ?? mimeType), typeInferred: "content-type" };
}

/**
 * HAR `time` + `timings` -> the event's `timing` (docs/04 section 9.2 timing mapping). -1 / absent = unknown.
 * An import has no monotonic clock (`mono:null`): `timing.start` is the entry's `startedDateTime` in
 * epoch ms, `end = start + time`, `responseStart = end - receive`, and `timing.cdp` is rebuilt as
 * offsets from the start (blocked, then dns, connect with ssl inside it, send, wait) so that
 * `exportHar` reads the same spans back. `null` when the entry has no number at all.
 */
function timingFromHar(ts: number, raw: Record<string, unknown>): RequestEvent["timing"] {
  const known = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 ? v : null);
  const tm = rec(raw, "timings");
  const g = (k: string): number | null => (tm === null ? null : known(num(tm, k)));
  const time = known(num(raw, "time"));
  const blocked = g("blocked");
  const dns = g("dns");
  const connect = g("connect");
  const ssl = g("ssl");
  const send = g("send");
  const wait = g("wait");
  const receive = g("receive");
  if (time === null && [blocked, dns, connect, ssl, send, wait, receive].every((x) => x === null)) return null;
  const cdp: Record<string, number> = {};
  let at = blocked ?? 0;
  if (dns !== null) {
    cdp["dnsStart"] = at;
    at += dns;
    cdp["dnsEnd"] = at;
  }
  if (connect !== null) {
    cdp["connectStart"] = at;
    at += connect;
    cdp["connectEnd"] = at;
    if (ssl !== null && ssl <= connect) {
      cdp["sslStart"] = at - ssl;
      cdp["sslEnd"] = at;
    }
  } else if (ssl !== null) {
    cdp["sslStart"] = at;
    at += ssl;
    cdp["sslEnd"] = at;
  }
  if (send !== null || wait !== null) {
    cdp["sendStart"] = at;
    at += send ?? 0;
    cdp["sendEnd"] = at;
  }
  if (wait !== null) {
    at += wait;
    cdp["receiveHeadersEnd"] = at;
  }
  const end = time === null ? null : ts + time;
  const responseStart = end !== null && receive !== null ? end - receive : wait !== null ? ts + at : null;
  return { start: ts, responseStart, end, cdp: Object.keys(cdp).length === 0 ? null : cdp };
}

async function requestFromEntry(w: BundleWriter, e: HarEntryIn, seqOfPage: ReadonlyMap<string, number>): Promise<UnsequencedEvent & { initiator: unknown }> {
  const reqHeaders = headersFromHar(e.reqHeaders);
  const respHeaders = headersFromHar(e.respHeaders);
  const raw = e.raw;

  let postData: { inline: string } | { blob: string; size: number } | null = null;
  if (e.postText !== null) {
    const bytes = toBytes(e.postText);
    if (bytes.length <= INLINE_MAX) postData = { inline: e.postText };
    else {
      const put = await w.putBlob(bytes);
      if (put.outcome === "stored") postData = { blob: put.ref, size: put.size };
    }
  }

  const failed = e.status === 0;
  let response: Record<string, unknown> | null = null;
  if (!failed) {
    const mimeFull = e.content.mimeType ?? (typeof respHeaders["content-type"] === "string" ? respHeaders["content-type"] : null);
    const [mime, ...params] = (mimeFull ?? "").split(";").map((s) => s.trim());
    const charsetParam = params.find((p) => p.toLowerCase().startsWith("charset="));
    let body: Record<string, unknown> | null = null;
    let bodyMissing: Record<string, unknown> | null = null;
    if (e.content.text !== null) {
      const ce = respHeaders["content-encoding"];
      const dec = decodeHarBody(e.content.text, e.content.base64, typeof ce === "string" ? ce : null);
      const put = await w.putBlob(dec.bytes);
      if (put.outcome === "stored") {
        body = { blob: put.ref, size: put.size, base64: dec.base64, wireEncoding: dec.wireEncoding, truncated: false };
        if (dec.decodeFailed) body["decodeFailed"] = true;
      } else {
        bodyMissing = { reason: "too-large", detail: `${put.size} bytes > ${put.cap}` };
      }
    } else {
      const reason = e.status === 304 ? "not-modified" : e.status === 204 ? "no-content" : e.status >= 300 && e.status < 400 ? "redirect" : "unsupported";
      bodyMissing = { reason, detail: "HAR entry has no content.text" };
    }
    const protocol = typeof raw["_protocol"] === "string" ? raw["_protocol"] : protocolOf(e.httpVersion);
    const fromCache = raw["_fromCache"];
    response = {
      status: e.status,
      statusText: e.statusText,
      headers: respHeaders,
      headersSource: "event",
      mimeType: mime === undefined || mime === "" ? null : mime,
      charset: charsetParam === undefined ? null : charsetParam.slice("charset=".length),
      protocol,
      remote: e.serverIPAddress === null ? null : { ip: e.serverIPAddress, port: null },
      fromCache: fromCache === true || fromCache === "disk" || fromCache === "memory",
      fromServiceWorker: raw["_fromServiceWorker"] === true,
      fromPrefetch: false,
      body,
      bodyMissing,
    };
  }

  const typed = importedType(raw, reqHeaders, response === null ? null : respHeaders, e.content.mimeType);
  const pageSeq = e.pageref === null ? undefined : seqOfPage.get(e.pageref);
  const initRaw = raw["_initiator"];
  const errorText = typeof raw["_error"] === "string" ? raw["_error"] : "unknown (status 0 in HAR)";
  return {
    ts: e.ts,
    mono: null,
    kind: "request",
    actor: "human",
    tab: "t1",
    cmd: null,
    nav: pageSeq === undefined ? null : `n-${pageSeq}`,
    id: "",
    cdp: null,
    type: typed.type,
    ...(typed.typeInferred === undefined ? {} : { typeInferred: typed.typeInferred }),
    method: e.method,
    url: e.url,
    urlFragment: null,
    initiator: isRecord(initRaw) ? { ...initRaw, type: str(initRaw, "type") ?? "other" } : null,
    request: { headers: reqHeaders, headersSource: "event", postData },
    response,
    redirect: null,
    timing: timingFromHar(e.ts, raw),
    outcome: failed ? "failed" : "finished",
    error: failed ? { text: errorText, canceled: null, blockedReason: null } : null,
  };
}
