// `tabcap recon` / `tabcap analyze recon <bundle>`: the recon dossier v0
// (docs/09 §1; owner decision 2026-10-16, docs/08 §3 「0.4 补充」: v0 answers
// four questions only — tech stack, data channels with coverage, cookie
// classification, protection identification — into exports/dossier.json +
// exports/dossier.md; `--probe` is 0.5).
// Pure: a bundle reader and the page (the live page from the daemon, or the
// last recorded document offline) in, a `tabcap-dossier/0` object out. It
// never sends a request; everything comes from recorded evidence and the page.
// Spec (0.4-J brief):
// 1. stack: every adapter `detect` result for the current page (the only
//    fingerprint library), plus header / cookie-name hints from the fixed
//    STACK_MARKERS table, value as seen (cookie values never), grade 推断.
// 2. channels: requests grouped by (method, path template, resource type,
//    body class); path template collapses numeric / uuid / long-hex segments
//    to {id}. Coverage: the page's visible text tokens (>= 4 characters,
//    numbers >= 4 digits, de-duplicated) looked up with `analyze find`'s exact
//    (substring) matching through its decode chain across recorded response
//    bodies (and received WebSocket frames); ratio = found / total.
// 3. cookies: per cookie name origin (set-cookie by r-N / present at session
//    start / unrecorded), lifetime, flags, role from COOKIE_ROLES (推断), and
//    requiredBy from analyze deps (graded as deps grades it). Request inputs
//    other than cookies whose name has the csrf role (e.g. an x-csrf header)
//    are listed too, with carrier = their location and origin from deps.
// 4. protection: the guard's challenge detections (guard breaker events and
//    the handoff of the same reason that followed; a human take-over is not a
//    detection and is never paired) and response signals from PROTECTION_SIGNALS
//    (names only, 推断). Identification only; never a bypass hint.
// Oracle: test/unit/recon.test.ts (synthetic bundles with planted channels,
// cookies and signals), test/e2e/v04j.e2e.test.ts (range s06 + s07, s15).
// Reproduce: bun test test/unit/recon.test.ts

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { parseInlineOrBlob, type BundleReader } from "../bundle/reader.ts";
import type { RawEvent, RequestEvent, ResourceType } from "../bundle/types.ts";
import { isRecord, num, str } from "../shared/json.ts";
import { STEP_CAP } from "./codecs.ts";
import { STEP_NAMES, Explorer, baseMime, binaryMagic, isBinaryMime, isCompressedMime, isPluginStep, parseJsonDoc, utf8, type StepName } from "./decoders.ts";
import { decodedPayload } from "./views.ts";
import { DepsGraph, sourceGrade, type DepsClass, type DepsSource, type InputLocation } from "./deps.ts";
import { cookiePairs, headerValues } from "./diff.ts";
import { wirePrefix } from "./find.ts";
import { htmlTextNodes } from "./htmltext.ts";
import { evidenceFromBundle } from "./protection/evidence.ts";
import { identify, type Detection, type Evidence, type Fingerprinting } from "./protection/identify.ts";
import { builtinFamilies } from "./protection/registry.ts";
import type { Family } from "./protection/rules.ts";

export const DOSSIER_SCHEMA = "tabcap-dossier/0";
export const DOSSIER_JSON = "dossier.json";
export const DOSSIER_MD = "dossier.md";
/** Path of the dossier inside the bundle, as `outputSummary.receipt.dossier` names it. */
export const DOSSIER_RECEIPT = `exports/${DOSSIER_JSON}`;
/** Page tokens looked up (in page order); more are counted in `coverage.capped`. */
export const MAX_TOKENS = 2000;
export const MAX_UNMATCHED = 20;
export const MAX_CHANNELS = 500;
export const MAX_REFS = 10;
export const MAX_REQUIRED_BY = 50;
const MAX_VALUE = 200;
/** A path segment of at least this many hex digits (and at least one digit) is an id. */
export const LONG_HEX = 16;

export const IDENTIFICATION_ONLY = "Identification only: tabcap names what the recording shows; it never bypasses, solves or evades a protection. A challenge goes to the human (guard / handoff).";

export type Grade = "实测" | "推断";

// ------------------------------------------------------------ fixed tables

export type StackMarker = { kind: "header" | "cookie"; marker: string; match: (name: string) => boolean; hint: string };

const exact = (n: string) => (x: string) => x.toLowerCase() === n.toLowerCase();

/**
 * Header and session-cookie-name hints (at most 20, docs/09 §1 #1). The hint
 * says what the marker usually means; the value is reported as seen, no
 * version is guessed and no external data is used.
 */
export const STACK_MARKERS: readonly StackMarker[] = [
  { kind: "header", marker: "server", match: exact("server"), hint: "web server (as announced)" },
  { kind: "header", marker: "x-powered-by", match: exact("x-powered-by"), hint: "application platform (as announced)" },
  { kind: "header", marker: "x-aspnet-version", match: exact("x-aspnet-version"), hint: "ASP.NET" },
  { kind: "header", marker: "x-aspnetmvc-version", match: exact("x-aspnetmvc-version"), hint: "ASP.NET MVC" },
  { kind: "header", marker: "x-generator", match: exact("x-generator"), hint: "site generator / CMS (as announced)" },
  { kind: "header", marker: "x-runtime", match: exact("x-runtime"), hint: "Ruby on Rails / Rack" },
  { kind: "header", marker: "x-nextjs-cache", match: exact("x-nextjs-cache"), hint: "Next.js" },
  { kind: "cookie", marker: "JSESSIONID", match: exact("JSESSIONID"), hint: "Java servlet container" },
  { kind: "cookie", marker: "ASP.NET_SessionId", match: exact("ASP.NET_SessionId"), hint: "ASP.NET" },
  { kind: "cookie", marker: ".AspNetCore.*", match: (n) => n.toLowerCase().startsWith(".aspnetcore."), hint: "ASP.NET Core" },
  { kind: "cookie", marker: "PHPSESSID", match: exact("PHPSESSID"), hint: "PHP" },
  { kind: "cookie", marker: "laravel_session", match: exact("laravel_session"), hint: "Laravel" },
  { kind: "cookie", marker: "csrftoken", match: exact("csrftoken"), hint: "Django" },
  { kind: "cookie", marker: "sessionid", match: exact("sessionid"), hint: "Django (default session cookie name)" },
  { kind: "cookie", marker: "_*_session", match: (n) => /^_[a-z0-9]+(?:_[a-z0-9]+)*_session$/i.test(n), hint: "Ruby on Rails (_<app>_session, e.g. _rails_session)" },
  { kind: "cookie", marker: "connect.sid", match: exact("connect.sid"), hint: "Node.js Express (express-session)" },
  { kind: "cookie", marker: "ci_session", match: exact("ci_session"), hint: "CodeIgniter" },
];

export type CookieRole = "session" | "csrf" | "consent" | "analytics" | "load-balancer" | "unknown";

/** Cookie role by name, first match wins (推断). Also applied to request input names for the csrf role. */
export const COOKIE_ROLES: readonly { role: Exclude<CookieRole, "unknown">; pattern: RegExp }[] = [
  { role: "csrf", pattern: /csrf|xsrf|^_token$|authenticity_token|requestverificationtoken/i },
  {
    role: "session",
    pattern: /^(?:sid|sess|session|sessid|sessionid|session_id|session-id|jsessionid|phpsessid|asp\.net_sessionid|connect\.sid|laravel_session|ci_session)$|^\.aspnetcore\.(?:session|cookies)$|^_[a-z0-9_]+_session$|^sess[_-]|[_-]sess(?:ion)?(?:id)?$/i,
  },
  { role: "consent", pattern: /consent|^cookielawinfo|^cc_cookie$|^optanonalertboxclosed$|^cookie_notice/i },
  { role: "analytics", pattern: /^_ga(?:$|_)|^_gid$|^_gat|^_gcl_|^_fbp$|^_hj|^_pk_|^mp_|^ajs_|^amplitude|^_clck$|^_clsk$|^hm_lvt_|^hm_lpvt_|^_uetsid$|^_uetvid$/i },
  { role: "load-balancer", pattern: /^awsalb|^awselb$|^bigipserver|^serverid$|^routeid$|^arraffinity|^__cflb$|^ingresscookie$|^lb[_-]/i },
];

export function cookieRole(name: string): CookieRole {
  return COOKIE_ROLES.find((r) => r.pattern.test(name))?.role ?? "unknown";
}

export type SignalRule = { signal: "html-403" | "status-429" | "retry-after" | "rate-limit" | "bot-management"; label: string; test: (r: RequestEvent) => string | null };

const respHeaderNames = (r: RequestEvent): string[] => Object.keys(r.response?.headers ?? {}).map((h) => h.toLowerCase());
const hasHeader = (name: string) => (r: RequestEvent) => (respHeaderNames(r).includes(name) ? name : null);
const isHtml = (r: RequestEvent) => {
  const m = baseMime(r.response?.mimeType ?? headerValues(r.response?.headers ?? {}, "content-type")[0] ?? null);
  return m === "text/html" || m === "application/xhtml+xml";
};

/**
 * Response-level protection signals (names only, 推断). The bot-management
 * rows name a vendor from a header name alone; none was seen on a real
 * deployment by this tool (待验), the owner prunes the table.
 */
export const PROTECTION_SIGNALS: readonly SignalRule[] = [
  { signal: "html-403", label: "HTML 403 (block or challenge page)", test: (r) => (r.response?.status === 403 && isHtml(r) ? "403" : null) },
  { signal: "status-429", label: "429 Too Many Requests", test: (r) => (r.response?.status === 429 ? "429" : null) },
  { signal: "retry-after", label: "retry-after header", test: hasHeader("retry-after") },
  { signal: "rate-limit", label: "rate-limit headers (x-ratelimit-* / ratelimit-*)", test: (r) => respHeaderNames(r).find((h) => h.startsWith("x-ratelimit-") || h.startsWith("ratelimit")) ?? null },
  // 0.8-A: cf-mitigated, x-amzn-waf-action and x-datadome moved into the family rules (docs/04 §41);
  // Imperva stays here as a bare header name: its sources are too weak for a family (docs/14 §5).
  { signal: "bot-management", label: "Imperva / Incapsula (x-iinfo)", test: hasHeader("x-iinfo") },
];

// ------------------------------------------------------------ dossier shape

export type AdapterDetection = { adapter: string; category: string; confidence: number; evidence: string[] };

export type ReconPage = {
  url: string | null;
  title: string | null;
  /** Visible text of the page; null when it could not be read. */
  text: string | null;
  source: "live" | "recorded-document" | "none";
  /** recorded-document: the request whose body stands in for the page. */
  request?: string;
  /** live only: adapter detections; null offline (adapters need the live page). */
  adapters: AdapterDetection[] | null;
};

export type StackEntry =
  | { source: "adapter"; name: string; category: string; confidence: number; evidence: string[]; grade: Grade }
  | { source: "header"; marker: string; value: string; hint: string; request: string; requests: number; grade: Grade }
  | { source: "cookie"; marker: string; name: string; hint: string; request: string | null; grade: Grade };

export type BodyClass = "json" | "html" | "fragment" | "text" | "binary" | "ws" | "sse";

export type Channel = {
  method: string;
  template: string;
  type: ResourceType;
  body: BodyClass;
  count: number;
  first: string;
  /** Response statuses seen (null: no response). */
  status: (number | null)[];
  /** Requests whose response the page never read (docs/04 §5.2 rule 9). */
  unreadByPage: number;
  /** Decode steps the find decode chain applied to this channel's payloads (analyze find step names). */
  decode: StepName[];
  /** Page tokens found in this channel's responses. */
  tokens: number;
};

export type Coverage = { ratio: number | null; total: number; found: number; unmatched: string[]; capped: number };

export type CookieOrigin =
  | { kind: "set-cookie"; request: string }
  | { kind: "session-start" }
  | { kind: "unrecorded" }
  /** Non-cookie inputs (csrf role): where analyze deps says the value came from. */
  | { kind: "deps"; class: DepsClass; request?: string; path?: string; cookie?: string; grade: Grade };

export type RequiredBy = { request: string; input: string; via: DepsClass; grade: Grade };

export type CookieEntry = {
  name: string;
  carrier: "cookie" | Exclude<InputLocation, "cookie">;
  origin: CookieOrigin;
  setBy: string[];
  lifetime: { kind: "session" } | { kind: "persistent"; expires: string | null } | null;
  flags: { httpOnly: boolean | null; secure: boolean | null; sameSite: string | null } | null;
  role: CookieRole;
  requiredBy: RequiredBy[];
};

export type ProtectionEntry =
  | {
      source: "guard";
      kind: string;
      request: string | null;
      url: string | null;
      status: number | null;
      handedToHuman: { question: string | null; screenshot: string | null } | null;
      resumedBy: string | null;
      grade: Grade;
    }
  | { source: "response"; signal: SignalRule["signal"]; label: string; name: string; count: number; requests: string[]; grade: Grade }
  | ({ source: "family" } & Detection);

export type Dossier = {
  schema: typeof DOSSIER_SCHEMA;
  bundle: string;
  session: string;
  generatedAt: number;
  page: { url: string | null; title: string | null; source: ReconPage["source"]; request?: string };
  stack: StackEntry[];
  channels: Channel[];
  coverage: Coverage;
  cookies: CookieEntry[];
  protection: ProtectionEntry[];
  /** 0.8-A: fingerprinting techniques from trace `signal` events (empty without trace mode). */
  fingerprinting: Fingerprinting[];
  grades: {
    stack: Grade;
    channels: Grade;
    coverage: Grade;
    cookies: { origin: Grade; lifetime: Grade; flags: Grade; role: Grade; requiredBy: "analyze deps (per entry)" };
    protection: { guard: Grade; response: Grade; family: Grade };
  };
  notes: string[];
  warnings: string[];
};

// ------------------------------------------------------------ channels

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path template: numeric, uuid and long-hex segments become {id}; the query is dropped. */
export function channelTemplate(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? url;
  }
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || UUID.test(seg) || (seg.length >= LONG_HEX && /^[0-9a-f]+$/i.test(seg) && /\d/.test(seg)) ? "{id}" : seg))
    .join("/");
}

const JSON_MIME = /^(?:application|text)\/(?:[a-z0-9.+-]*\+)?json$|^application\/(?:x-)?ndjson$|^application\/jsonl$/;
/** A JSON content type (`application/json`, `+json`, ndjson / jsonl), parameters ignored. */
export const isJsonMime = (mime: string | null | undefined): boolean => JSON_MIME.test(baseMime(mime));
const FULL_HTML = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i;

/** Body class from resource type, mime and the start of the body text (null: no text available). */
export function bodyClass(type: ResourceType, mime: string | null, head: string | null, bytes: Uint8Array | null = null): BodyClass {
  const m = baseMime(mime);
  if (type === "websocket") return "ws";
  if (type === "eventsource" || m === "text/event-stream") return "sse";
  if (JSON_MIME.test(m)) return "json";
  if (m === "text/html" || m === "application/xhtml+xml") return type === "document" || (head !== null && FULL_HTML.test(head)) ? "html" : "fragment";
  if (isBinaryMime(m) || isCompressedMime(m) || ((type === "image" || type === "font" || type === "media") && m !== "image/svg+xml")) return "binary";
  if (bytes !== null && binaryMagic(bytes) !== null) return "binary";
  if (m === "" || m === "text/plain" || m === "application/octet-stream") {
    if (head !== null && parseJsonDoc(head) !== null) return "json";
    if (head !== null && FULL_HTML.test(head)) return "html";
    if (bytes !== null && head === null && bytes.length > 0) return "binary";
  }
  return "text";
}

// ------------------------------------------------------------ tokens

const TOKEN = /\p{N}+(?:[.,'’]\p{N}+)+|[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_.@-]*[\p{L}\p{N}\p{M}])?/gu;
const NUMBERISH = /^[\p{N}.,'’]+$/u;

/** Visible-text tokens: words of >= 4 characters, numbers of >= 4 digits, de-duplicated in page order. */
export function pageTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (seen.has(t)) continue;
    const keep = NUMBERISH.test(t) ? (t.match(/\p{N}/gu)?.length ?? 0) >= 4 : [...t].length >= 4;
    if (!keep) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ------------------------------------------------------------ helpers

function headerString(h: Record<string, string | string[]>, name: string): string | null {
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== name) continue;
    return typeof v === "string" ? v : v.join(", ");
  }
  return null;
}

const cut = (s: string, n = MAX_VALUE): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type Payload = { bytes: Uint8Array; mime: string | null; prefix: StepName[] } | { text: string; mime: null; prefix: StepName[] };

/** The response body of a request as `analyze find` would search it, or null (no body, binary, too large, missing blob). */
function responsePayload(reader: BundleReader, r: RequestEvent, imported: boolean): (Payload & { bytes: Uint8Array }) | null {
  const resp = r.response;
  const body = resp?.body ?? null;
  if (resp === null || body === null || body.size > STEP_CAP) return null;
  const mime = resp.mimeType ?? headerString(resp.headers, "content-type");
  const binaryByType = r.type === "image" || r.type === "font" || r.type === "media";
  if (isBinaryMime(mime) || (binaryByType && baseMime(mime) !== "image/svg+xml")) return null;
  const bytes = reader.readBlob(body.blob);
  if (bytes === null || bytes.length > STEP_CAP || binaryMagic(bytes) !== null) return null;
  return { bytes, mime, prefix: wirePrefix(imported, body.wireEncoding, body.decodeFailed === true) };
}

function wsRecvPayloads(reader: BundleReader, events: readonly RawEvent[], handshake: string): Payload[] {
  const out: Payload[] = [];
  for (const e of events) {
    if (e.kind !== "ws" || e["phase"] !== "frame" || e["ws"] !== handshake || e["direction"] !== "recv") continue;
    const p = parseInlineOrBlob(e["payload"]);
    if (p === null) continue;
    if ("inline" in p) {
      if (num(e, "opcode") === 2) out.push({ bytes: new Uint8Array(Buffer.from(p.inline, "base64")), mime: null, prefix: [] });
      else out.push({ text: p.inline, mime: null, prefix: [] });
    } else {
      const bytes = reader.readBlob(p.blob);
      if (bytes !== null && bytes.length <= STEP_CAP) out.push({ bytes, mime: null, prefix: [] });
    }
  }
  return out;
}

// ------------------------------------------------------------ the dossier

/**
 * `families`: the rule set (built-ins plus config/protection/, docs/04 §41.1);
 * `live`: evidence only the live page has (its globals, current DOM, loaded resources).
 */
export type ReconOptions = { session?: string; now?: number; warnings?: string[]; families?: readonly Family[]; live?: Evidence | null };

/** The page offline: the last root document of the recording (its HTML text nodes stand in for the visible text). */
export function recordedPage(reader: BundleReader): ReconPage {
  const reqs = reader.requests();
  const lastNav = [...reader.events].reverse().find((e) => e.kind === "nav" && e["frame"] === "root" && e["type"] !== "history");
  const navUrl = lastNav === undefined ? null : str(lastNav, "url");
  const docs = reqs.filter((r) => r.type === "document" && r.response?.body !== null && r.response?.body !== undefined);
  const doc = [...docs].reverse().find((r) => navUrl !== null && r.url === navUrl) ?? docs[docs.length - 1];
  if (doc === undefined) return { url: navUrl, title: null, text: null, source: "none", adapters: null };
  const bytes = doc.response?.body ? reader.readBlob(doc.response.body.blob) : null;
  const html = bytes === null ? null : utf8(bytes);
  if (html === null) return { url: doc.url, title: null, text: null, source: "recorded-document", request: doc.id, adapters: null };
  const nodes = htmlTextNodes(html);
  const isTitle = (sel: string) => /(?:^|> )title(?::nth-of-type\(\d+\))?$/.test(sel);
  const title = nodes.find((n) => isTitle(n.selector))?.text ?? null;
  const text = nodes
    .filter((n) => !isTitle(n.selector))
    .map((n) => n.text)
    .join("\n");
  return { url: doc.url, title, text, source: "recorded-document", request: doc.id, adapters: null };
}

export function buildDossier(reader: BundleReader, page: ReconPage, opts: ReconOptions = {}): Dossier {
  const warnings = [...(opts.warnings ?? [])];
  if (!reader.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted (the dossier covers what was written so far)");
  if (reader.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  if (page.source === "recorded-document") warnings.push(`no live page: page text from the recorded document ${page.request ?? ""} (HTML text nodes; text rendered by scripts is missing) and no adapter detection`);
  if (page.source === "none") warnings.push("no page: neither a live page nor a recorded document; coverage is empty and adapters were not run");
  const graph = DepsGraph.of(reader);
  for (const w of graph.warnings) if (!warnings.includes(w)) warnings.push(w);
  const requests = graph.requests;
  const m = reader.manifest;
  const session = opts.session ?? (m.session.name !== "" ? m.session.name : m.id);

  const { channels, coverage } = channelsAndCoverage(reader, requests, page);
  if (channels.length > MAX_CHANNELS) warnings.push(`${channels.length} channels; the first ${MAX_CHANNELS} are listed`);
  const cookies = classifyCookies(reader, graph);
  const stack = stackOf(page, requests, cookies);
  const found = identify(opts.families ?? builtinFamilies(), mergeEvidence(evidenceFromBundle(reader), opts.live ?? null));
  const protection: ProtectionEntry[] = [...found.detections.filter((x) => x.category !== "fingerprint").map((x) => ({ source: "family" as const, ...x })), ...protectionOf(reader, requests)];

  return {
    schema: DOSSIER_SCHEMA,
    bundle: reader.dir,
    session,
    generatedAt: opts.now ?? Date.now(),
    page: { url: page.url, title: page.title, source: page.source, ...(page.request === undefined ? {} : { request: page.request }) },
    stack,
    channels: channels.slice(0, MAX_CHANNELS),
    coverage,
    cookies,
    protection,
    fingerprinting: found.fingerprinting,
    grades: {
      stack: "推断",
      channels: "实测",
      coverage: "实测",
      cookies: { origin: "实测", lifetime: "实测", flags: "实测", role: "推断", requiredBy: "analyze deps (per entry)" },
      protection: { guard: "实测", response: "推断", family: "推断" },
    },
    notes: [IDENTIFICATION_ONLY],
    warnings,
  };
}

/** Bundle evidence plus what only the live page has: globals, the live DOM and resources replace / extend the recorded ones. */
function mergeEvidence(bundle: Evidence, live: Evidence | null): Evidence {
  if (live === null) return bundle;
  return {
    ...bundle,
    cookies: [...(bundle.cookies ?? []), ...(live.cookies ?? [])],
    resources: [...(bundle.resources ?? []), ...(live.resources ?? [])],
    globals: live.globals ?? bundle.globals ?? null,
    dom: live.dom ?? bundle.dom ?? null,
    frames: [...(bundle.frames ?? []), ...(live.frames ?? [])],
  };
}

// ------------------------------------------------------------ 1. stack

function stackOf(page: ReconPage, requests: readonly RequestEvent[], cookies: readonly CookieEntry[]): StackEntry[] {
  const out: StackEntry[] = [];
  for (const d of page.adapters ?? []) out.push({ source: "adapter", name: d.adapter, category: d.category, confidence: d.confidence, evidence: d.evidence, grade: "推断" });
  for (const mk of STACK_MARKERS) {
    if (mk.kind === "header") {
      const seen = new Map<string, { request: string; requests: number }>();
      for (const r of requests) {
        const v = headerString(r.response?.headers ?? {}, mk.marker);
        if (v === null) continue;
        const value = cut(v.trim());
        const have = seen.get(value);
        if (have === undefined) {
          if (seen.size < 5) seen.set(value, { request: r.id, requests: 1 });
        } else have.requests++;
      }
      for (const [value, s] of seen) out.push({ source: "header", marker: mk.marker, value, hint: mk.hint, request: s.request, requests: s.requests, grade: "推断" });
    } else {
      for (const c of cookies) {
        if (c.carrier !== "cookie" || !mk.match(c.name)) continue;
        out.push({ source: "cookie", marker: mk.marker, name: c.name, hint: mk.hint, request: c.origin.kind === "set-cookie" ? c.origin.request : null, grade: "推断" });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ 2. channels and coverage

type ChannelAcc = Channel & { requests: RequestEvent[]; steps: Set<StepName>; found: Set<string> };

function channelsAndCoverage(reader: BundleReader, requests: readonly RequestEvent[], page: ReconPage): { channels: Channel[]; coverage: Coverage } {
  const imported = reader.manifest.imported !== null && reader.manifest.imported !== undefined;
  const all = page.text === null ? [] : pageTokens(page.text);
  const tokens = all.slice(0, MAX_TOKENS);
  const byKey = new Map<string, ChannelAcc>();
  const payloads = new Map<string, Payload[]>();
  for (const r of requests) {
    const p = responsePayload(reader, r, imported);
    const head = p === null ? null : utf8(p.bytes.subarray(0, Math.min(p.bytes.length, 4096))) ?? utf8(p.bytes);
    const mime = r.response?.mimeType ?? headerString(r.response?.headers ?? {}, "content-type");
    // A body find skips (binary magic) is read only when the mime does not already say what it is.
    const ambiguous = baseMime(mime) === "" || baseMime(mime) === "application/octet-stream";
    const rawBytes = p === null && ambiguous && r.response?.body ? reader.readBlob(r.response.body.blob) : null;
    const cls = bodyClass(r.type, mime, head, p?.bytes ?? rawBytes);
    const template = channelTemplate(r.url);
    const key = [r.method, template, r.type, cls].join("\t");
    let c = byKey.get(key);
    if (c === undefined) {
      c = { method: r.method, template, type: r.type, body: cls, count: 0, first: r.id, status: [], unreadByPage: 0, decode: [], tokens: 0, requests: [], steps: new Set(), found: new Set() };
      byKey.set(key, c);
    }
    c.count++;
    c.requests.push(r);
    const st = r.response?.status ?? null;
    if (!c.status.includes(st)) c.status.push(st);
    if (r["unreadByPage"] === true) c.unreadByPage++;
    // 0.6-B: a decode plugin's view is what the channel carries in plaintext; its
    // step leads the channel's `decode` list. The body class stays the original's.
    const view = r.response === null ? null : decodedPayload(reader, r.response.decoded);
    const list: Payload[] = view !== null ? [{ bytes: view.bytes, mime: view.mime, prefix: view.prefix }] : p === null ? [] : [p];
    if (view !== null) for (const s of view.prefix) c.steps.add(s);
    if (r.type === "websocket") list.push(...wsRecvPayloads(reader, reader.events, r.id));
    payloads.set(r.id, list);
  }
  const channels = [...byKey.values()];
  const found = new Set<string>();
  for (const c of channels) {
    for (const r of c.requests) {
      for (const p of payloads.get(r.id) ?? []) {
        const pending = tokens.filter((t) => !c.found.has(t));
        // A matcher that never reports a hit records every token it sees, so
        // the explorer walks the whole decode chain like `analyze find` does
        // for a token it has not found yet.
        const matcher = (s: string) => {
          for (let i = pending.length - 1; i >= 0; i--) {
            const t = pending[i];
            if (t === undefined || s.length < t.length || !s.includes(t)) continue;
            c.found.add(t);
            pending.splice(i, 1);
          }
          return null;
        };
        const ex = new Explorer(matcher, { maxHits: 1, record: true, entropyEligible: false });
        if ("bytes" in p) ex.exploreBytes(p.bytes, { mime: p.mime }, p.prefix);
        else ex.exploreText(p.text, { mime: null }, p.prefix);
        for (const s of STEP_NAMES) if ((ex.stats[s] ?? 0) > 0) c.steps.add(s);
      }
    }
    for (const t of c.found) found.add(t);
  }
  const out: Channel[] = channels
    .map((c) => ({
      method: c.method,
      template: c.template,
      type: c.type,
      body: c.body,
      count: c.count,
      first: c.first,
      status: [...c.status].sort((a, b) => (a ?? -1) - (b ?? -1)),
      unreadByPage: c.unreadByPage,
      decode: [...[...c.steps].filter((s) => isPluginStep(s)).sort(), ...STEP_NAMES.filter((s) => c.steps.has(s))],
      tokens: c.found.size,
      seq: c.requests[0]?.seq ?? 0,
    }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq: _seq, ...c }) => c);
  const total = tokens.length;
  const nFound = tokens.filter((t) => found.has(t)).length;
  return {
    channels: out,
    coverage: {
      ratio: total === 0 ? null : Math.round((nFound / total) * 1000) / 1000,
      total,
      found: nFound,
      unmatched: tokens.filter((t) => !found.has(t)).slice(0, MAX_UNMATCHED),
      capped: all.length - tokens.length,
    },
  };
}

// ------------------------------------------------------------ 3. cookies

type SnapCookie = { name: string; httpOnly: boolean | null; secure: boolean | null; sameSite: string | null; session: boolean | null; expires: number | null };

function snapshotCookies(reader: BundleReader, e: RawEvent): SnapCookie[] {
  const blob = str(e, "blob");
  const bytes = blob === null ? null : reader.readBlob(blob);
  const text = bytes === null ? null : utf8(bytes);
  if (text === null) return [];
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SnapCookie[] = [];
  for (const c of v) {
    if (!isRecord(c) || typeof c["name"] !== "string") continue;
    const b = (k: string) => (typeof c[k] === "boolean" ? c[k] : null);
    out.push({ name: c["name"], httpOnly: b("httpOnly"), secure: b("secure"), sameSite: typeof c["sameSite"] === "string" ? c["sameSite"] : null, session: b("session"), expires: typeof c["expires"] === "number" ? c["expires"] : null });
  }
  return out;
}

type SetCookieLine = { name: string; request: string; httpOnly: boolean; secure: boolean; sameSite: string | null; expires: string | null; persistent: boolean };

function setCookieLines(r: RequestEvent): SetCookieLine[] {
  const out: SetCookieLine[] = [];
  for (const raw of headerValues(r.response?.headers ?? {}, "set-cookie")) {
    for (const line of raw.split("\n")) {
      const parts = line.split(";").map((p) => p.trim());
      const first = parts[0] ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const attrs = new Map<string, string>();
      for (const a of parts.slice(1)) {
        const i = a.indexOf("=");
        attrs.set((i < 0 ? a : a.slice(0, i)).trim().toLowerCase(), i < 0 ? "" : a.slice(i + 1).trim());
      }
      let expires: string | null = null;
      const maxAge = attrs.get("max-age");
      const exp = attrs.get("expires");
      if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
        const t = r.ts + Number(maxAge) * 1000;
        expires = Number.isFinite(t) ? new Date(t).toISOString() : null;
      } else if (exp !== undefined) {
        const t = Date.parse(exp);
        expires = Number.isFinite(t) ? new Date(t).toISOString() : null;
      }
      out.push({
        name: first.slice(0, eq).trim(),
        request: r.id,
        httpOnly: attrs.has("httponly"),
        secure: attrs.has("secure"),
        sameSite: attrs.get("samesite") ?? null,
        expires,
        persistent: maxAge !== undefined || exp !== undefined,
      });
    }
  }
  return out;
}

const stripIndex = (n: string): string => n.replace(/\[\d+\]$/, "");

function classifyCookies(reader: BundleReader, graph: DepsGraph): CookieEntry[] {
  const order: string[] = [];
  const note = (n: string) => {
    if (n !== "" && !order.includes(n)) order.push(n);
  };
  const atStart = new Set<string>();
  const lastSnap = new Map<string, SnapCookie>();
  const sets = new Map<string, SetCookieLine[]>();
  for (const e of reader.events) {
    if (e.kind === "state" && e["what"] === "cookies") {
      for (const c of snapshotCookies(reader, e)) {
        note(c.name);
        lastSnap.set(c.name, c);
        if (e["reason"] === "session-start") atStart.add(c.name);
      }
    } else if (e.kind === "request") {
      const r = graph.byId.get(str(e, "id") ?? "");
      if (r === undefined) continue;
      for (const v of headerValues(r.request.headers, "cookie")) for (const [n] of cookiePairs(v)) note(n);
      for (const l of setCookieLines(r)) {
        note(l.name);
        const list = sets.get(l.name) ?? [];
        list.push(l);
        sets.set(l.name, list);
      }
    }
  }

  // requiredBy: inputs that are this cookie, or whose deps source is its set-cookie
  const required = new Map<string, RequiredBy[]>();
  const csrfInputs = new Map<string, { location: Exclude<InputLocation, "cookie">; name: string; first: { request: string; primary: DepsSource | null; cls: DepsClass; value: string }; users: RequiredBy[] }>();
  for (const r of graph.requests) {
    for (const i of graph.inputs(r.id)) {
      const label = `${i.location}:${i.path ?? i.name}`;
      const grade = sourceGrade(reader, i.value, i.primary);
      const cookieName = i.location === "cookie" ? stripIndex(i.name) : i.primary?.kind === "set-cookie" ? (i.primary.cookie ?? null) : null;
      if (cookieName !== null) {
        const list = required.get(cookieName) ?? [];
        if (!list.some((x) => x.request === r.id && x.input === label)) list.push({ request: r.id, input: label, via: i.class, grade });
        required.set(cookieName, list);
      }
      if (i.location !== "cookie" && cookieRole(stripIndex(i.name)) === "csrf") {
        const k = `${i.location}\t${stripIndex(i.name)}`;
        const have = csrfInputs.get(k) ?? { location: i.location, name: stripIndex(i.name), first: { request: r.id, primary: i.primary, cls: i.class, value: i.value }, users: [] };
        have.users.push({ request: r.id, input: label, via: i.class, grade });
        csrfInputs.set(k, have);
      }
    }
  }

  const out: CookieEntry[] = [];
  for (const name of order) {
    const setters = sets.get(name) ?? [];
    const firstSet = setters[0];
    const origin: CookieOrigin = atStart.has(name) ? { kind: "session-start" } : firstSet !== undefined ? { kind: "set-cookie", request: firstSet.request } : { kind: "unrecorded" };
    const snap = lastSnap.get(name);
    const lastSet = setters[setters.length - 1];
    let lifetime: CookieEntry["lifetime"] = null;
    let flags: CookieEntry["flags"] = null;
    if (snap !== undefined) {
      const persistent = snap.session === false || (snap.session === null && snap.expires !== null && snap.expires > 0);
      lifetime = persistent ? { kind: "persistent", expires: snap.expires !== null && snap.expires > 0 ? new Date(snap.expires * 1000).toISOString() : null } : { kind: "session" };
      flags = { httpOnly: snap.httpOnly, secure: snap.secure, sameSite: snap.sameSite };
    } else if (lastSet !== undefined) {
      lifetime = lastSet.persistent ? { kind: "persistent", expires: lastSet.expires } : { kind: "session" };
      flags = { httpOnly: lastSet.httpOnly, secure: lastSet.secure, sameSite: lastSet.sameSite };
    }
    const setBy: string[] = [];
    for (const s of setters) if (!setBy.includes(s.request) && setBy.length < MAX_REFS) setBy.push(s.request);
    out.push({ name, carrier: "cookie", origin, setBy, lifetime, flags, role: cookieRole(name), requiredBy: (required.get(name) ?? []).slice(0, MAX_REQUIRED_BY) });
  }
  for (const c of csrfInputs.values()) {
    const p = c.first.primary;
    const origin: CookieOrigin = {
      kind: "deps",
      class: c.first.cls,
      ...(p?.request === undefined ? {} : { request: p.request }),
      ...(p?.path === undefined ? {} : { path: p.path }),
      ...(p?.cookie === undefined ? {} : { cookie: p.cookie }),
      grade: sourceGrade(reader, c.first.value, p),
    };
    out.push({ name: c.name, carrier: c.location, origin, setBy: [], lifetime: null, flags: null, role: "csrf", requiredBy: c.users.slice(0, MAX_REQUIRED_BY) });
  }
  return out;
}

// ------------------------------------------------------------ 4. protection

function protectionOf(reader: BundleReader, requests: readonly RequestEvent[]): ProtectionEntry[] {
  const out: ProtectionEntry[] = [];
  const events = reader.events;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined || e.kind !== "guard" || e["event"] !== "breaker") continue;
    const d = isRecord(e["detail"]) ? e["detail"] : {};
    const request = str(d, "request");
    const kind = str(d, "reason");
    let handed: { question: string | null; screenshot: string | null } | null = null;
    let resumedBy: string | null = null;
    for (let j = i + 1; j < events.length; j++) {
      const h = events[j];
      if (h === undefined) continue;
      if (h.kind === "guard" && h["event"] === "breaker") break;
      if (h.kind !== "handoff") continue;
      // docs/04 §4.2 / §37: a handoff belongs to the breaker of the same reason. A `fetch-stop`
      // never waits for the human and a take-over (`human-takeover`) writes no breaker, so a
      // take-over after a fetch stop is not that stop's handoff.
      const why = str(h, "reason");
      if (why === "human-takeover" || (kind !== null && why !== null && why !== kind)) continue;
      if (h["state"] === "waiting" && handed === null) handed = { question: str(h, "question"), screenshot: str(h, "screenshot") };
      else if (h["state"] === "resumed" && resumedBy === null) resumedBy = str(h, "by") ?? "human";
    }
    out.push({ source: "guard", kind: kind ?? "unknown", request, url: str(d, "url"), status: num(d, "status"), handedToHuman: handed, resumedBy, grade: "实测" });
  }
  for (const rule of PROTECTION_SIGNALS) {
    const hits = new Map<string, string[]>();
    for (const r of requests) {
      const name = rule.test(r);
      if (name === null) continue;
      const list = hits.get(name) ?? [];
      list.push(r.id);
      hits.set(name, list);
    }
    for (const [name, ids] of hits) out.push({ source: "response", signal: rule.signal, label: rule.label, name, count: ids.length, requests: ids.slice(0, MAX_REFS), grade: "推断" });
  }
  return out;
}

// ------------------------------------------------------------ output

export type DossierPaths = { json: string; md: string };

/**
 * Write exports/dossier.json and exports/dossier.md (0600; the exports
 * directory 0700), overwriting earlier ones. `scrub` runs over both texts
 * (the daemon passes its known-secret replacement).
 */
export function writeDossier(bundleDir: string, d: Dossier, scrub: (s: string) => string = (s) => s): DossierPaths {
  const dir = join(bundleDir, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const json = join(dir, DOSSIER_JSON);
  const md = join(dir, DOSSIER_MD);
  writeFileAtomic(json, scrub(JSON.stringify(d, null, 2)) + "\n", 0o600);
  writeFileAtomic(md, scrub(renderDossierMd(d)), 0o600);
  return { json, md };
}

/** The command's answer: the two paths, a short summary and the receipt for the `cmd` end event. */
export function reconOutput(d: Dossier, paths: DossierPaths): Record<string, unknown> {
  return {
    dossier: paths.json,
    markdown: paths.md,
    receipt: { dossier: DOSSIER_RECEIPT },
    page: d.page,
    summary: {
      stack: d.stack.filter((s) => s.source !== "adapter" || s.confidence > 0).map(stackLabel),
      channels: d.channels.length,
      requests: d.channels.reduce((n, c) => n + c.count, 0),
      coverage: { ratio: d.coverage.ratio, found: d.coverage.found, total: d.coverage.total },
      cookies: d.cookies.map((c) => `${c.name} (${c.role})`),
      protection: d.protection.map((p) => (p.source === "family" ? `${p.name} (${p.category}, ${p.confidence})` : p.source === "guard" ? `guard ${p.kind} ${p.request ?? ""}`.trim() : `${p.signal} ${p.name}`)),
      fingerprinting: d.fingerprinting.map((f) => `${f.technique}${f.attributedTo === null ? "" : ` → ${f.attributedTo}`}`),
    },
    warnings: d.warnings,
  };
}

function stackLabel(s: StackEntry): string {
  if (s.source === "adapter") return `${s.name} (${s.category}, ${s.confidence})`;
  if (s.source === "header") return `${s.marker}: ${s.value}`;
  return `cookie ${s.name}: ${s.hint}`;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function originText(o: CookieOrigin): string {
  if (o.kind === "set-cookie") return `set-cookie ${o.request}`;
  if (o.kind === "session-start") return "present at session start";
  if (o.kind === "unrecorded") return "unrecorded";
  const parts = [o.class, o.request, o.path, o.cookie === undefined ? undefined : `cookie ${o.cookie}`].filter((x): x is string => x !== undefined);
  return `${parts.join(" ")} (${o.grade})`;
}

/** Short Markdown rendering (tables). */
export function renderDossierMd(d: Dossier): string {
  const L: string[] = [];
  L.push(`# Recon dossier`, "");
  L.push(`- page: ${d.page.url ?? "(none)"}${d.page.title === null || d.page.title === "" ? "" : ` — ${cell(d.page.title)}`} (${d.page.source}${d.page.request === undefined ? "" : ` ${d.page.request}`})`);
  L.push(`- bundle: ${d.bundle}`, `- session: ${d.session}`, `- generated: ${new Date(d.generatedAt).toISOString()}`, `- schema: ${d.schema}`, "");

  L.push(`## Stack (${d.grades.stack})`, "");
  if (d.stack.length === 0) L.push("Nothing identified.", "");
  else {
    L.push("| source | marker | value / confidence | meaning | request |", "|---|---|---|---|---|");
    for (const s of d.stack) {
      if (s.source === "adapter") L.push(`| adapter | ${cell(s.name)} | ${s.confidence} | ${cell(s.category)}${s.evidence.length > 0 ? `: ${cell(s.evidence.join(", "))}` : ""} | |`);
      else if (s.source === "header") L.push(`| header | ${s.marker} | ${cell(s.value)} | ${cell(s.hint)} | ${s.request}${s.requests > 1 ? ` (+${s.requests - 1})` : ""} |`);
      else L.push(`| cookie | ${cell(s.name)} | | ${cell(s.hint)} | ${s.request ?? ""} |`);
    }
    L.push("");
  }

  L.push(`## Data channels (${d.grades.channels})`, "");
  const cv = d.coverage;
  L.push(
    cv.total === 0
      ? "Coverage: no page text tokens."
      : `Coverage (${d.grades.coverage}): ${cv.found} / ${cv.total} page text tokens found in recorded responses (${((cv.ratio ?? 0) * 100).toFixed(1)}%).${cv.unmatched.length > 0 ? ` Not found: ${cv.unmatched.map((t) => `\`${cell(t)}\``).join(", ")}.` : ""}${cv.capped > 0 ? ` ${cv.capped} more tokens not looked up.` : ""}`,
    "",
  );
  if (d.channels.length > 0) {
    L.push("| method | path | type | body | count | first | status | unread | decode | tokens |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const c of d.channels.slice(0, 50)) {
      L.push(`| ${c.method} | ${cell(c.template)} | ${c.type} | ${c.body} | ${c.count} | ${c.first} | ${c.status.map((s) => s ?? "-").join(", ")} | ${c.unreadByPage} | ${c.decode.join(", ")} | ${c.tokens} |`);
    }
    if (d.channels.length > 50) L.push(`| … | ${d.channels.length - 50} more in dossier.json | | | | | | | | |`);
    L.push("");
  }

  L.push(`## Cookies (origin, lifetime, flags ${d.grades.cookies.origin}; role ${d.grades.cookies.role})`, "");
  if (d.cookies.length === 0) L.push("No cookies seen.", "");
  else {
    L.push("| name | carrier | origin | lifetime | flags | role | required by |", "|---|---|---|---|---|---|---|");
    for (const c of d.cookies) {
      const life = c.lifetime === null ? "" : c.lifetime.kind === "session" ? "session" : `persistent${c.lifetime.expires === null ? "" : ` until ${c.lifetime.expires}`}`;
      const f = c.flags === null ? "" : [c.flags.httpOnly === true ? "HttpOnly" : "", c.flags.secure === true ? "Secure" : "", c.flags.sameSite === null ? "" : `SameSite=${c.flags.sameSite}`].filter((x) => x !== "").join(" ");
      const req = c.requiredBy.slice(0, 5).map((x) => `${x.request} (${x.grade})`).join(", ") + (c.requiredBy.length > 5 ? `, … (${c.requiredBy.length})` : "");
      L.push(`| ${cell(c.name)} | ${c.carrier} | ${cell(originText(c.origin))} | ${life} | ${f} | ${c.role} | ${req} |`);
    }
    L.push("");
  }

  L.push(`## Protection (families ${d.grades.protection.family}; guard ${d.grades.protection.guard}; response signals ${d.grades.protection.response})`, "");
  if (d.protection.length === 0) L.push("Nothing identified.", "");
  else {
    L.push("| source | signal | request | detail |", "|---|---|---|---|");
    for (const p of d.protection) {
      if (p.source === "family") {
        const why = p.matched.map((x) => `${x.rule}: ${x.where.join(", ")}`).join("; ");
        L.push(`| family | ${cell(p.name)} (${p.category}, ${p.confidence}${p.combination === null ? "" : `, ${p.combination}`}) | ${cell(p.layers.map((l) => `L${l}`).join(" "))} | ${cell(why)} |`);
      } else if (p.source === "guard") {
        const handed = p.handedToHuman === null ? "" : `handed to the human${p.handedToHuman.screenshot === null ? "" : ` (screenshot ${p.handedToHuman.screenshot})`}`;
        L.push(`| guard | ${cell(p.kind)} | ${p.request ?? ""} | ${cell([`HTTP ${p.status ?? "?"}`, handed, p.resumedBy === null ? "" : `resumed by ${p.resumedBy}`].filter((x) => x !== "").join("; "))} |`);
      } else L.push(`| response | ${p.signal}: ${cell(p.name)} | ${p.requests.join(", ")}${p.count > p.requests.length ? `, … (${p.count})` : ""} | ${cell(p.label)} |`);
    }
    L.push("");
  }
  if (d.fingerprinting.length > 0) {
    L.push("## Fingerprinting (trace mode, 推断)", "", "| technique | APIs | callers | attributed to |", "|---|---|---|---|");
    for (const f of d.fingerprinting) L.push(`| ${cell(f.technique)} | ${cell(f.apis.join(", "))} | ${cell(f.callers.map((c) => `${c.url} ×${c.count}`).join(", "))} | ${f.attributedTo ?? ""} |`);
    L.push("");
  }
  for (const n of d.notes) L.push(`> ${n}`, "");
  for (const w of d.warnings) L.push(`- warning: ${w}`);
  return L.join("\n").replace(/\n+$/, "") + "\n";
}

/** Read the page text into a shape the dossier accepts (daemon answers are untrusted). */
export function pageOf(url: unknown, title: unknown, text: unknown, adapters: AdapterDetection[] | null): ReconPage {
  return { url: typeof url === "string" ? url : null, title: typeof title === "string" ? title : null, text: typeof text === "string" ? text : null, source: "live", adapters };
}
