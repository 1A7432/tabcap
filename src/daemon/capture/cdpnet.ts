// Pure helpers that turn untrusted CDP Network data into docs/04 §5.1 fields.

import { isRecord, oneOf } from "../../shared/json.ts";
import type { BodyMissingReason, Headers, ResourceType } from "../../bundle/types.ts";

/** Lowercase names, drop ":" pseudo headers, split "\n"-joined repeats into arrays (decision e). */
export function normalizeHeaders(raw: unknown): Headers {
  const out: Headers = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || k.startsWith(":")) continue;
    const name = k.toLowerCase();
    const values = v.split("\n");
    const prev = out[name];
    const merged = prev === undefined ? values : [...(Array.isArray(prev) ? prev : [prev]), ...values];
    out[name] = merged.length === 1 ? (merged[0] ?? "") : merged;
  }
  return out;
}

/** Event headers overlaid with wire (ExtraInfo) headers; wire wins on conflicts. */
export function mergeHeaders(event: Headers | null, wire: Headers | null): { headers: Headers; source: "event" | "wire" | "merged" } {
  if (wire === null) return { headers: event ?? {}, source: "event" };
  if (event === null) return { headers: wire, source: "wire" };
  return { headers: { ...event, ...wire }, source: "merged" };
}

export function headerValue(h: Headers, name: string): string | null {
  const v = h[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m === null || m[1] === undefined ? null : m[1].toLowerCase();
}

const TYPES: readonly ResourceType[] = ["document", "xhr", "fetch", "script", "stylesheet", "image", "font", "media", "websocket", "eventsource", "manifest", "other"];

export function resourceType(v: unknown): ResourceType {
  const t = typeof v === "string" ? v.toLowerCase() : "other";
  return oneOf(TYPES, t) ? t : "other";
}

/** Responses that never carry a body (docs/04 §5.2 rule 5), or null to try fetching it. */
export function noBodyReason(method: string, status: number): BodyMissingReason | null {
  if (status === 304) return "not-modified";
  if (method.toUpperCase() === "HEAD" || status === 204 || status === 205) return "no-content";
  if (status >= 300 && status < 400 && status !== 304) return "redirect";
  return null;
}

/**
 * Classify a failed getResponseBody. CDP only says "No resource with given
 * identifier found"; a root navigation committed after the request started
 * means `navigated`, otherwise `evicted` (docs/04 §5.2 rule 5).
 */
export function bodyErrorReason(message: string, navigatedSinceStart: boolean, tabGone: boolean): BodyMissingReason {
  if (tabGone) return "detached";
  if (/no resource with given identifier|no data found for resource/i.test(message)) return navigatedSinceStart ? "navigated" : "evicted";
  return "unsupported";
}

const TEXTUAL = /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|ld\+json|manifest\+json)|image\/svg\+xml)|\+json$|\+xml$/i;

export function isTextMime(mime: string | null): boolean {
  return mime !== null && TEXTUAL.test(mime.split(";")[0]?.trim() ?? "");
}

/** Decode CDP `{body, base64Encoded}` to real bytes (docs/04 §5.2 rule 3). */
export function bodyBytes(body: string, base64Encoded: boolean): Uint8Array {
  return base64Encoded ? new Uint8Array(Buffer.from(body, "base64")) : new TextEncoder().encode(body);
}

const round3 = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * docs/04 §17: the three `timing` points on one clock (CDP MonotonicTime, ms).
 * `start` is requestWillBeSent's timestamp and `end` loadingFinished's (or
 * loadingFailed's). `responseStart` is taken from the response's ResourceTiming
 * (`requestTime` s + `receiveHeadersEnd` ms), the network service's clock that
 * `end` also comes from: the responseReceived event's own timestamp is when the
 * renderer heard of the response, which with Fetch interception can be after
 * the body finished (measured 10-15: 0.5 ms after `end` on the s15 page). That
 * timestamp is only the fallback when ResourceTiming is absent. responseStart
 * is clamped into [start, end] when they are known, so it is never after `end`.
 */
export function requestTiming(
  startMono: number | null,
  responseEventMono: number | null,
  endMono: number | null,
  cdpTiming: unknown,
): { start: number | null; responseStart: number | null; end: number | null } {
  let rs = responseEventMono;
  if (isRecord(cdpTiming)) {
    const base = cdpTiming["requestTime"];
    const rhe = cdpTiming["receiveHeadersEnd"];
    if (typeof base === "number" && Number.isFinite(base) && base > 0 && typeof rhe === "number" && Number.isFinite(rhe) && rhe >= 0) rs = round3(base * 1000 + rhe);
  }
  if (rs !== null && endMono !== null && rs > endMono) rs = endMono;
  if (rs !== null && startMono !== null && rs < startMono) rs = startMono;
  return { start: startMono, responseStart: rs, end: endMono };
}
