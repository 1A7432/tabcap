// Bundle reader (docs/04 §2, §3). Rules:
// - a truncated last line of events.jsonl is reported, never thrown (§1.1);
// - unknown kinds and unknown fields are kept verbatim (§3);
// - damaged middle lines are reported and skipped;
// - a manifest with a different format major is refused (§10);
// - decoded views added by `bundle decode` live in the decoded.jsonl sidecar
//   (docs/04 §26); `events` and `requests()` carry them overlaid on their
//   request events, the file itself is never changed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isBlobRef } from "../shared/ids.ts";
import { bool, isRecord, num, oneOf, rec, str } from "../shared/json.ts";
import { BlobStore } from "./blobs.ts";
import { decodedOf, latestViews, overlayEvent, readSidecar } from "./decoded.ts";
import { EVENTS_FILE, readManifest } from "./manifest.ts";
import type {
  Actor,
  BodyMissingReason,
  Headers,
  HeadersSource,
  InlineOrBlob,
  Manifest,
  RawEvent,
  RequestEvent,
  ResourceType,
  ResponseBody,
  ResponseSide,
} from "./types.ts";

export type ReadIssue = {
  line: number; // 1-based line number in events.jsonl (0 = not line specific)
  kind: "truncated-last-line" | "bad-json" | "bad-envelope" | "seq-order" | "bad-request" | "bad-sidecar";
  detail: string;
};

export type ParsedEvents = { events: RawEvent[]; issues: ReadIssue[]; truncatedLastLine: boolean };

/** Anything HAR export / redaction can work from: a bundle on disk or in memory. */
export interface BundleView {
  readonly manifest: Manifest;
  readonly events: readonly RawEvent[];
  readBlob(ref: string): Uint8Array | null;
}

const ACTORS: readonly Actor[] = ["human", "ai", "system"];
const isActor = (v: unknown): v is Actor => oneOf(ACTORS, v);

/** Validate the §3 envelope of one parsed line; returns the event or a reason. */
export function toRawEvent(obj: unknown): RawEvent | string {
  if (!isRecord(obj)) return "line is not a JSON object";
  const { seq, ts, mono, kind, actor, tab, cmd } = obj;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return "seq must be a positive integer";
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "ts must be a number";
  if (mono !== null && (typeof mono !== "number" || !Number.isFinite(mono))) return "mono must be a number or null";
  if (typeof kind !== "string" || kind === "") return "kind must be a non-empty string";
  if (!isActor(actor)) return "actor must be human|ai|system";
  if (tab !== null && typeof tab !== "string") return "tab must be a string or null";
  if (cmd !== null && typeof cmd !== "string") return "cmd must be a string or null";
  // Spread first keeps the original key order; values are identical.
  return { ...obj, seq, ts, mono, kind, actor, tab, cmd };
}

export function parseEventsText(text: string): ParsedEvents {
  const events: RawEvent[] = [];
  const issues: ReadIssue[] = [];
  let truncatedLastLine = false;
  const lines = text.split("\n");
  const endsClean = text.endsWith("\n") || text === "";
  if (endsClean) lines.pop(); // trailing "" after the final newline
  let prevSeq = 0;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const isLast = i === lines.length - 1;
    if (line.trim() === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch (e) {
      if (isLast && !endsClean) {
        truncatedLastLine = true;
        issues.push({ line: lineNo, kind: "truncated-last-line", detail: `last line is incomplete (${line.length} bytes); recording was probably interrupted` });
      } else {
        issues.push({ line: lineNo, kind: "bad-json", detail: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    const ev = toRawEvent(obj);
    if (typeof ev === "string") {
      issues.push({ line: lineNo, kind: "bad-envelope", detail: ev });
      return;
    }
    if (ev.seq <= prevSeq) issues.push({ line: lineNo, kind: "seq-order", detail: `seq ${ev.seq} after ${prevSeq}` });
    prevSeq = Math.max(prevSeq, ev.seq);
    events.push(ev);
  });
  return { events, issues, truncatedLastLine };
}

// ------------------------------------------------------------ request parsing

function parseHeaders(v: unknown): Headers {
  const out: Headers = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
    else if (Array.isArray(val)) out[k] = val.filter((x): x is string => typeof x === "string");
  }
  return out;
}

function parseHeadersSource(v: unknown): HeadersSource {
  return v === "event" || v === "wire" || v === "merged" ? v : "event";
}

export function parseInlineOrBlob(v: unknown): InlineOrBlob | null {
  if (!isRecord(v)) return null;
  if (typeof v["inline"] === "string") return { inline: v["inline"] };
  if (isBlobRef(v["blob"])) return { blob: v["blob"], size: num(v, "size") ?? 0 };
  return null;
}

const RESOURCE_TYPES: readonly ResourceType[] = [
  "document", "xhr", "fetch", "script", "stylesheet", "image", "font", "media", "websocket", "eventsource", "manifest", "other",
];

export function toResourceType(v: unknown): ResourceType {
  if (typeof v !== "string") return "other";
  const t = v.toLowerCase();
  return oneOf(RESOURCE_TYPES, t) ? t : "other";
}

const MISSING_REASONS: readonly BodyMissingReason[] = [
  "too-large", "redirect", "not-modified", "no-content", "navigated", "evicted", "detached", "stopped", "failed", "unsupported",
];

function parseBodyMissing(v: unknown): ResponseSide["bodyMissing"] {
  if (!isRecord(v)) return null;
  const reason = str(v, "reason");
  if (!oneOf(MISSING_REASONS, reason)) return null;
  return { reason, detail: str(v, "detail") };
}

function parseBody(v: unknown): ResponseBody | null {
  if (!isRecord(v) || !isBlobRef(v["blob"])) return null;
  const body: ResponseBody = {
    blob: v["blob"],
    size: num(v, "size") ?? 0,
    base64: v["base64"] === true,
    wireEncoding: str(v, "wireEncoding"),
    truncated: v["truncated"] === true,
  };
  if (v["decodeFailed"] === true) body.decodeFailed = true;
  return body;
}

function postDataMissingOf(v: unknown): { postDataMissing?: { reason: string; detail: string | null } } {
  if (!isRecord(v)) return {};
  return { postDataMissing: { reason: str(v, "reason") ?? "unknown", detail: str(v, "detail") } };
}

function parseResponse(v: unknown): ResponseSide | null {
  if (!isRecord(v)) return null;
  const remote = rec(v, "remote");
  const ip = remote === null ? null : str(remote, "ip");
  return {
    status: num(v, "status"),
    statusText: str(v, "statusText") ?? "",
    headers: parseHeaders(v["headers"]),
    headersSource: parseHeadersSource(v["headersSource"]),
    mimeType: str(v, "mimeType"),
    charset: str(v, "charset"),
    protocol: str(v, "protocol"),
    remote: remote === null || ip === null ? null : { ip, port: num(remote, "port") },
    fromCache: bool(v, "fromCache") ?? false,
    fromServiceWorker: bool(v, "fromServiceWorker") ?? false,
    fromPrefetch: bool(v, "fromPrefetch") ?? false,
    body: parseBody(v["body"]),
    bodyMissing: parseBodyMissing(v["bodyMissing"]),
    ...decodedOf(v["decoded"]),
  };
}

/**
 * Normalized view of a `request` event (§5.1). Fields absent on disk come back
 * as null / empty (the §11 sample elides most of them). Returns a reason
 * string when the event cannot be a request at all.
 */
export function parseRequest(e: RawEvent): RequestEvent | string {
  if (e.kind !== "request") return "not a request event";
  const method = str(e, "method");
  const url = str(e, "url");
  if (method === null) return "method is not a string";
  if (url === null) return "url is not a string";
  const reqRaw = rec(e, "request") ?? {};
  const cdpRaw = rec(e, "cdp");
  const initRaw = rec(e, "initiator");
  const timingRaw = rec(e, "timing");
  const redirectRaw = rec(e, "redirect");
  const errorRaw = rec(e, "error");
  const outcome = e["outcome"];
  const out: RequestEvent = {
    ...e,
    kind: "request",
    nav: str(e, "nav"),
    id: str(e, "id") ?? `r-${e.seq}`,
    cdp:
      cdpRaw === null
        ? null
        : { requestId: str(cdpRaw, "requestId") ?? "", loaderId: str(cdpRaw, "loaderId"), frameId: str(cdpRaw, "frameId"), sessionId: str(cdpRaw, "sessionId") },
    type: toResourceType(e["type"]),
    method,
    url,
    urlFragment: str(e, "urlFragment"),
    initiator: initRaw === null ? null : { ...initRaw, type: str(initRaw, "type") ?? "other" },
    request: {
      headers: parseHeaders(reqRaw["headers"]),
      headersSource: parseHeadersSource(reqRaw["headersSource"]),
      postData: parseInlineOrBlob(reqRaw["postData"]),
      ...postDataMissingOf(reqRaw["postDataMissing"]),
      ...decodedOf(reqRaw["decoded"]),
    },
    response: parseResponse(e["response"]),
    redirect: redirectRaw === null || str(redirectRaw, "from") === null ? null : { from: str(redirectRaw, "from") ?? "" },
    timing:
      timingRaw === null
        ? null
        : { start: num(timingRaw, "start"), responseStart: num(timingRaw, "responseStart"), end: num(timingRaw, "end"), cdp: rec(timingRaw, "cdp") },
    outcome: outcome === "finished" || outcome === "failed" || outcome === "incomplete" ? outcome : "incomplete",
    error: errorRaw === null ? null : { ...errorRaw, text: str(errorRaw, "text") ?? "" },
  };
  return out;
}

// ------------------------------------------------------------ reader

export class BundleReader implements BundleView {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly events: RawEvent[];
  readonly issues: ReadIssue[];
  readonly truncatedLastLine: boolean;
  /** The bundle has a decoded.jsonl sidecar (views added by `bundle decode`). */
  readonly decodedSidecar: boolean;
  private readonly blobs: BlobStore;

  private constructor(dir: string, manifest: Manifest, parsed: ParsedEvents) {
    this.dir = dir;
    this.manifest = manifest;
    const sidecar = readSidecar(dir);
    this.decodedSidecar = sidecar !== null;
    const views = latestViews(sidecar);
    this.events = views.size === 0 ? parsed.events : parsed.events.map((e) => overlayEvent(e, views));
    // sidecar issues name lines of decoded.jsonl
    this.issues = [...parsed.issues, ...(sidecar?.issues ?? []).map((i) => ({ line: i.line, kind: "bad-sidecar" as const, detail: `decoded.jsonl: ${i.detail}` }))];
    this.truncatedLastLine = parsed.truncatedLastLine;
    this.blobs = new BlobStore(dir);
  }

  static open(dir: string): BundleReader {
    if (!existsSync(dir)) throw new TabcapError("not-found", `bundle directory not found: ${dir}`, "Check the path; `tabcap bundle info <dir>` works on any bundle directory.");
    const manifest = readManifest(dir);
    const eventsPath = join(dir, EVENTS_FILE);
    const text = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    return new BundleReader(dir, manifest, parseEventsText(text));
  }

  /** §2: a bundle is complete when the manifest has `finished`. */
  isComplete(): boolean {
    return typeof this.manifest.finished === "number";
  }

  byKind(kind: string): RawEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /** All request events, normalized; unusable ones are added to `issues`. */
  requests(): RequestEvent[] {
    const out: RequestEvent[] = [];
    for (const e of this.events) {
      if (e.kind !== "request") continue;
      const r = parseRequest(e);
      if (typeof r === "string") this.issues.push({ line: 0, kind: "bad-request", detail: `seq ${e.seq}: ${r}` });
      else out.push(r);
    }
    return out;
  }

  readBlob(ref: string): Uint8Array | null {
    return this.blobs.tryRead(ref);
  }

  /** Like readBlob but throws a TabcapError when missing. */
  mustReadBlob(ref: string): Uint8Array {
    return this.blobs.read(ref);
  }
}
