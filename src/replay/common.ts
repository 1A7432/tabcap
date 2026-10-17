// Shared pieces of `tabcap replay …` (docs/03 §5 `replay`, §4 离线回放优先).
// Bundle content is untrusted (docs/04): every field read here is checked, a
// malformed request is skipped with a reason, never thrown on.

import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import type { BundleReader } from "../bundle/reader.ts";
import type { Headers, RequestEvent } from "../bundle/types.ts";
import { isPreflightOf } from "../daemon/hooks/decode.ts";

/** RFC 9110 §7.6.1 connection-specific fields, plus the legacy ones proxies still send. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request headers the browser itself adds or manages (Fetch Standard
 * forbidden request-header names, the CORS preflight / cache / range / client
 * hints Chrome sends, and the body framing headers): never what a page or its
 * scripts set to authenticate. content-type describes one request's body.
 * Used by `session export` (0.6-F) and `replay export-python` (0.6-E).
 */
export const BROWSER_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "access-control-request-headers",
  "access-control-request-method",
  "cache-control",
  "content-length",
  "content-type",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "origin",
  "pragma",
  "priority",
  "purpose",
  "range",
  "referer",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
  "x-client-data",
]);
export const BROWSER_PREFIXES = ["sec-", ":"];

/** A header the browser adds or manages itself (BROWSER_HEADERS, `sec-*`, pseudo-headers). */
export const isBrowserHeader = (name: string): boolean => {
  const n = name.toLowerCase();
  return BROWSER_PREFIXES.some((p) => n.startsWith(p)) || BROWSER_HEADERS.has(n);
};

/** sha256 of zero bytes: the body hash of every request without a body. */
export const EMPTY_SHA256 = sha256Hex(new Uint8Array(0));

export const MAX_REQUEST_BODY = 64 * 1024 * 1024;

const enc = new TextEncoder();

/** All values of a header (lowercase name) as a list. */
export function headerList(h: Headers, name: string): string[] {
  const v = h[name];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** One header value as a request would carry it (repeated fields joined with ", "). */
export function headerJoined(h: Headers, name: string): string | null {
  const l = headerList(h, name);
  return l.length === 0 ? null : l.join(", ");
}

/**
 * Bytes of a recorded request body. `missing` when the recorder could not get
 * it (postDataMissing) or the blob is gone: a missing body is not an empty one.
 */
export function requestBodyBytes(r: RequestEvent, reader: Pick<BundleReader, "readBlob">): { bytes: Uint8Array } | { missing: string } {
  const pd = r.request.postData;
  if (pd === null) {
    const pm = r.request.postDataMissing;
    if (pm !== undefined) return { missing: pm.reason };
    return { bytes: new Uint8Array(0) };
  }
  if ("inline" in pd) return { bytes: enc.encode(pd.inline) };
  const b = reader.readBlob(pd.blob);
  return b === null ? { missing: "blob-missing" } : { bytes: b };
}

/** Is this host a loopback name (127.0.0.0/8, ::1, localhost)? */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((x) => Number(x) <= 255);
}

/** Path glob: `**` any characters, `*` any characters but `/`, `?` one character. Several globs separated by commas. */
export function globMatcher(globs: string | undefined): ((path: string) => boolean) | null {
  if (globs === undefined || globs.trim() === "") return null;
  const res = globs
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g !== "")
    .map((g) => {
      let re = "";
      for (let i = 0; i < g.length; i++) {
        const c = g[i] ?? "";
        if (c === "*" && g[i + 1] === "*") {
          re += ".*";
          i++;
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += ".";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${re}$`);
    });
  return (path) => res.some((r) => r.test(path));
}

/** Why a recorded request cannot be replayed, or null when it can. */
export function unreplayable(r: RequestEvent): string | null {
  if (r.type === "websocket") return "websocket";
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return "bad-url";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol.replace(/:$/, "")}`;
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(r.method)) return "bad-method";
  const st = r.response?.status ?? null;
  if (st === null) return `no-response${r.response?.bodyMissing ? ` (${r.response.bodyMissing.reason})` : ""}`;
  if (!Number.isInteger(st) || st < 200 || st > 599) return `status ${st}`;
  return null;
}

/**
 * A CORS preflight: an OPTIONS request the browser sent before the real one
 * (CDP initiator type "preflight"; HAR imports and older recordings: an
 * OPTIONS with an access-control-request-method header).
 */
export function isPreflight(r: RequestEvent): boolean {
  return isPreflightOf(r.method, r.initiator?.type, r.request.headers);
}

export type Skipped = { id: string; reason: string };

/** Requests of a bundle that carry a response we can serve / compare, in recorded order, and the rest with a reason. */
export function replayableRequests(reader: BundleReader): { requests: RequestEvent[]; skipped: Skipped[] } {
  const requests: RequestEvent[] = [];
  const skipped: Skipped[] = [];
  for (const r of reader.requests()) {
    const why = unreplayable(r);
    if (why === null) requests.push(r);
    else skipped.push({ id: r.id, reason: why });
  }
  return { requests, skipped };
}

/** Parse `a,b` header lists to lowercase names. */
export function headerNames(list: string | undefined): string[] {
  if (list === undefined) return [];
  return [...new Set(list.split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== ""))];
}

export function checkLoopbackListen(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new TabcapError("usage", `refusing to listen on ${host}: replay serve is loopback only`, "Use --host 127.0.0.1 (default), ::1 or localhost.");
  }
}

/** Sort cookie pairs so `a=1; b=2` and `b=2; a=1` compare equal. */
export function normalizeCookieHeader(v: string | null): string {
  if (v === null) return "";
  return v
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .sort()
    .join("; ");
}

const MAX_JSON_NODES = 200_000;

/** Path → canonical leaf text; empty arrays / objects are leaves too ("[]" / "{}"). Null when too large. */
export function flattenJson(value: unknown): Map<string, string> | null {
  const out = new Map<string, string>();
  const stack: { v: unknown; p: string }[] = [{ v: value, p: "$" }];
  let nodes = 0;
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  while (stack.length > 0) {
    if (++nodes > MAX_JSON_NODES) return null;
    const top = stack.pop();
    if (top === undefined) break;
    const { v, p } = top;
    if (Array.isArray(v)) {
      if (v.length === 0) out.set(p, "[]");
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], p: `${p}[${i}]` });
    } else if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v);
      if (entries.length === 0) out.set(p, "{}");
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e !== undefined) stack.push({ v: e[1], p: IDENT.test(e[0]) ? `${p}.${e[0]}` : `${p}[${JSON.stringify(e[0])}]` });
      }
    } else out.set(p, JSON.stringify(v) ?? "undefined");
  }
  return out;
}
