// Live output redaction (0.6-E, docs/04 §8.3): the `bundle redact` name rule
// (docs/04 §8, src/bundle/redact.ts) applied to what the daemon prints, not to
// what it records. The bundle stays the evidence (request events unchanged);
// HAR export redacts as before. Shown as `<redacted:<name>>`:
//   headers  the value of a header that bundle/redact.ts isSensitiveHeaderName
//            calls sensitive (the header set, the name rule and x-csrf* / x-xsrf*:
//            authorization, x-api-key, access-token, *auth*, *session*, *sid* …,
//            the same test as export and session export); cookie / set-cookie keep the cookie names and
//            attributes, every cookie value is redacted (state rule: all values)
//   URLs     query parameters with a sensitive name (the rest of the URL as is)
//   bodies   form fields and JSON keys (any depth) with a sensitive name, in a
//            request body text (net show postData)
//   details  a json: stop / end rule's `$.path is value` when the path's last
//            name is sensitive (fetch end / stopped, handoff detail; 2026-10-21)
// A value that is, as a whole, a known store secret keeps its
// `<secret:site.field>` placeholder (docs/04 §8.1), which the envelope
// scrubber writes; `--reveal` (the human asked) skips this redaction, never
// that substitution.
// Oracle: test/unit/liveredact.test.ts (the rule table of docs/04 §8) and
// test/e2e/v06e.e2e.test.ts (docs/05 s07: sid cookie, Authorization and,
// since the one header test of 2026-10-21, x-csrf are redacted).

import { isSensitiveHeaderName, isSensitiveName } from "../../bundle/redact.ts";
import { isRecord } from "../../shared/json.ts";
import { optBool, type Args } from "./args.ts";

export const redacted = (name: string): string => `<redacted:${name}>`;

/** A whole value that the known-secret scrubber turns into one placeholder. */
const PLACEHOLDER_ONLY = /^(?:<secret:[A-Za-z0-9_.-]+>|<masked>)$/;

/** Redaction context: `scrub` is the daemon's known-secret replacement (docs/04 §8.1). */
export type LiveCtx = { scrub: (s: string) => string };

/** `--reveal` on a command: print real values (the human asked for them). */
export const revealOf = (a: Args): boolean => optBool(a, "reveal");

function mask(name: string, value: string, c: LiveCtx): string {
  if (value === "" || value.startsWith("<redacted:")) return value;
  const s = c.scrub(value);
  return PLACEHOLDER_ONLY.test(s) ? s : redacted(name);
}

/** `a=1; b=2` → `a=<redacted:a>; b=<redacted:b>` (names kept). */
export function redactCookieHeader(v: string, c: LiveCtx): string {
  return v
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return part;
      const name = part.slice(0, eq).trim();
      const lead = part.slice(0, part.length - part.trimStart().length);
      return `${lead}${name}=${mask(name, part.slice(eq + 1).trim(), c)}`;
    })
    .join(";");
}

/** One set-cookie line per `\n`: the first pair's value redacted, attributes kept. */
export function redactSetCookie(v: string, c: LiveCtx): string {
  return v
    .split("\n")
    .map((line) => {
      const semi = line.indexOf(";");
      const first = semi < 0 ? line : line.slice(0, semi);
      const rest = semi < 0 ? "" : line.slice(semi);
      const eq = first.indexOf("=");
      if (eq <= 0) return line;
      const name = first.slice(0, eq).trim();
      return `${first.slice(0, eq)}=${mask(name, first.slice(eq + 1).trim(), c)}${rest}`;
    })
    .join("\n");
}

/** A header value as printed: cookies per pair, sensitive names whole, a URL-valued header by its query. */
export function redactHeaderValue(name: string, value: string, c: LiveCtx): string {
  const n = name.toLowerCase();
  if (n === "cookie") return redactCookieHeader(value, c);
  if (n === "set-cookie") return redactSetCookie(value, c);
  if (isSensitiveHeaderName(n)) return mask(n, value, c);
  if (n === "location" || n === "referer" || n === "content-location") return redactUrl(value, c);
  return value;
}

/** A header map (string or repeated values) with values redacted; names and order kept. */
export function redactHeaders(h: Readonly<Record<string, string | string[]>>, c: LiveCtx): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.map((x) => redactHeaderValue(k, x, c)) : redactHeaderValue(k, v, c);
  return out;
}

/** A header map of single values (fetch envelopes) with values redacted. */
export function redactFlatHeaders(h: Readonly<Record<string, string>>, c: LiveCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = redactHeaderValue(k, v, c);
  return out;
}

/** `$.a.b[0].c is <value>`: the detail of a json: stop / end rule (fetch/stoprules.ts firstStop). */
const RULE_DETAIL = /^(\$\S*) is ([\s\S]+)$/;

/**
 * A stop / end rule's detail as printed (fetch end / stopped, handoff detail, guard.stopped): a json:
 * rule's value shows as <redacted:name> when the path's last name is sensitive (an index takes its
 * array field's name: `$.tokens[0]` → tokens); every other detail (status, empty body, text match,
 * `no value`) as it is.
 */
export function redactRuleDetail(detail: string, c: LiveCtx): string {
  const m = RULE_DETAIL.exec(detail);
  if (m === null || m[1] === undefined || m[2] === undefined || m[2] === "no value") return detail;
  const name = [...m[1].matchAll(/\.([A-Za-z0-9_$-]+)/g)].at(-1)?.[1];
  if (name === undefined || !isSensitiveName(name)) return detail;
  let value = m[2];
  try {
    const v: unknown = JSON.parse(value);
    if (typeof v === "string") value = v;
  } catch {
    // truncated (show() cuts at 120 characters) or not JSON: masked whole
  }
  const shown = mask(name, value, c);
  return shown === value ? detail : `${m[1]} is ${shown}`;
}

/** A command answer whose top-level `url` (a string) is shown with sensitive query parameters redacted. */
export function withRedactedUrl<T>(v: T, c: LiveCtx): T | Record<string, unknown> {
  if (!isRecord(v) || typeof v["url"] !== "string") return v;
  return { ...v, url: redactUrl(v["url"], c) };
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** `k=v&…` with the values of sensitive names redacted; everything else byte for byte. */
export function redactPairs(text: string, c: LiveCtx): string {
  return text
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return part;
      const name = decodeName(part.slice(0, eq));
      return isSensitiveName(name) ? `${part.slice(0, eq)}=${mask(name, decodeName(part.slice(eq + 1)), c)}` : part;
    })
    .join("&");
}

/** A URL with sensitive query parameters redacted (path, fragment and other parameters as they are). */
export function redactUrl(url: string, c: LiveCtx): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash);
  return `${url.slice(0, q + 1)}${redactPairs(query, c)}${hash < 0 ? "" : url.slice(hash)}`;
}

function redactJson(v: unknown, c: LiveCtx): { v: unknown; changed: boolean } {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = redactJson(x, c);
      changed ||= r.changed;
      return r.v;
    });
    return { v: out, changed };
  }
  if (isRecord(v)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (isSensitiveName(k) && (typeof x === "string" || typeof x === "number") && String(x) !== "") {
        out[k] = mask(k, String(x), c);
        changed = true;
      } else {
        const r = redactJson(x, c);
        changed ||= r.changed;
        out[k] = r.v;
      }
    }
    return { v: out, changed };
  }
  return { v, changed: false };
}

const FORM_TEXT = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*$/;

/**
 * A request body text: JSON (object / array) with sensitive keys redacted (re-serialised
 * compactly only when something changed), a form body per field; anything else as is.
 */
export function redactBodyText(text: string, contentType: string | null, c: LiveCtx): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const doc: unknown = JSON.parse(t);
      const r = redactJson(doc, c);
      return r.changed ? JSON.stringify(r.v) : text;
    } catch {
      // not JSON after all: fall through
    }
  }
  const form = (contentType ?? "").toLowerCase().includes("x-www-form-urlencoded") || FORM_TEXT.test(t);
  return form ? redactPairs(text, c) : text;
}

const headerOf = (h: unknown, name: string): string | null => {
  if (!isRecord(h)) return null;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : null;
  return null;
};

function stringHeaders(h: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!isRecord(h)) return out;
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** A copy of a stored `request` event as `net show` prints it: URL, both header maps and an inline postData redacted. */
export function redactRequestEvent(ev: Record<string, unknown>, c: LiveCtx): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ev };
  if (typeof ev["url"] === "string") out["url"] = redactUrl(ev["url"], c);
  const req = isRecord(ev["request"]) ? { ...ev["request"] } : null;
  if (req !== null) {
    const ctype = headerOf(req["headers"], "content-type");
    req["headers"] = redactHeaders(stringHeaders(req["headers"]), c);
    const pd = isRecord(req["postData"]) ? { ...req["postData"] } : null;
    if (pd !== null && typeof pd["inline"] === "string") pd["inline"] = redactBodyText(pd["inline"], ctype, c);
    if (pd !== null) req["postData"] = pd;
    out["request"] = req;
  }
  const resp = isRecord(ev["response"]) ? { ...ev["response"] } : null;
  if (resp !== null) {
    resp["headers"] = redactHeaders(stringHeaders(resp["headers"]), c);
    out["response"] = resp;
  }
  return out;
}

/** The content-type of a stored request event's request side (for redacting a postData head). */
export const requestContentType = (ev: Record<string, unknown>): string | null => headerOf(isRecord(ev["request"]) ? ev["request"]["headers"] : null, "content-type");

/**
 * `net show` of a stored request event, redacted: `detailOf` (netshow.ts requestDetail) runs on the
 * redacted copy; a blob-backed postData `head` is redacted afterwards, and `bytes` stays the recorded one.
 */
export function redactedDetail(ev: Record<string, unknown>, c: LiveCtx, detailOf: (ev: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const d = detailOf(redactRequestEvent(ev, c));
  const req = d["request"];
  const pd = isRecord(req) ? req["postData"] : null;
  if (isRecord(pd)) {
    if (typeof pd["head"] === "string") pd["head"] = redactBodyText(pd["head"], requestContentType(ev), c);
    const recorded = isRecord(ev["request"]) && isRecord(ev["request"]["postData"]) ? ev["request"]["postData"]["inline"] : undefined;
    if (typeof recorded === "string") pd["bytes"] = new TextEncoder().encode(recorded).length;
  }
  return d;
}
