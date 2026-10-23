// Export-time redaction (docs/04 §8). Produces a redacted COPY; the source
// bundle is never modified, except that the per-export salt is written to the
// source's exports/<name>.salt (§8: the salt never goes into the copy).
//
// Rules "default@3" (owner 2026-10-21): default@2 applied to every event kind.
// default@2 = default@1 + `pass` / `pwd` as name segments (owner 2026-10-16).
// `ticket` was added for one day (0.7-E) and removed again on the owner's
// decision 2026-10-17: a CAS return URL's ticket is a constant of the
// recording for replay, and the name list also classifies replay inputs.
//   headers  cookie, set-cookie, authorization, proxy-authorization, x-api-key,
//            any header whose name contains token|secret|session|auth, matches
//            the name rule below, or starts with x-csrf / x-xsrf (default@3:
//            one test, isSensitiveHeaderName, for every path)
//   names    query / form / JSON keys containing (token|secret|passw|session|sid|auth|api[-_]?key),
//            or with a word `pass` / `pwd` (words split at non-alphanumerics,
//            camelCase and letter / digit boundaries: user_pass, userPass, login-pwd,
//            Pwd2 match; bypass, passport, compass, passenger do not)
//   values   18-digit CN id, 11-digit CN mobile, email, JWT (anywhere in text)
//   state    cookie / storage snapshots: every value
// Placeholder: «r:<kind>:<first 8 hex of sha256(salt + value)>». The kind is
// derived from the value only, so one value maps to one placeholder across
// headers, URLs, bodies and state, which keeps `diff` classifications intact.
// Events (default@3): request headers / bodies, ws payloads, sse data (0.9-C: as a text ws payload), state blobs,
// action.value, note.text and finding.claim keep their own rules; every other
// string of every event is walked: URL-shaped strings (and `url` / `from` /
// `*Url` fields) by the URL rule, `--switch=value` by its value, the rest by
// the value patterns (a URL's userinfo is dropped, owner 10-21). Envelope fields, ids (r-12, c-3, n-5), blob refs and the
// store names (site, account) are not values and stay. The manifest's browser
// args / extraArgs / dropArgs, tabs[].firstUrl and notes are walked the same way.
// Two passes: pass 1 collects every value masked by a name rule (manifest and
// all events); pass 2 also replaces those exact values in every walked string
// (min length 6), so a token masked in a request URL reads the same in a cmd
// argv or a guard detail.
// Decoded views (0.6-B, docs/04 §28) are plaintext of a body: redacted like
// a body of their own mime type; their error / note texts are scrubbed.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { TabcapError } from "../shared/envelope.ts";
import { isBlobRef, sha256Hex } from "../shared/ids.ts";
import { isRecord, tryParseJson } from "../shared/json.ts";
import { nowMs } from "../shared/time.ts";
import { toBytes } from "./blobs.ts";
import { writeFileAtomic } from "./manifest.ts";
import { BundleReader, type BundleView } from "./reader.ts";
import type { Headers, Manifest, RawEvent } from "./types.ts";
import { BundleWriter } from "./writer.ts";

export const RULES_VERSION = "default@3";

const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-api-key"]);
const SENSITIVE_HEADER_PARTS = ["token", "secret", "session", "auth"];
const SENSITIVE_NAME = /(token|secret|passw|session|sid|auth|api[-_]?key)/i;
/** Words that are sensitive only as a whole name segment (substrings such as bypass or passport are not). */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set(["pass", "pwd"]);
const KNOWN_MIN_LENGTH = 6;
/** `scheme://user[:pass]@` up to the authority's last `@` (RFC 3986 §3.2): dropped by the URL rule. */
const URL_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

type PatternKind = "jwt" | "email" | "cnid" | "mobile";

const PATTERNS: { kind: PatternKind; re: RegExp }[] = [
  { kind: "jwt", re: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*(?![A-Za-z0-9_.-])/g },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "cnid", re: /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g },
  { kind: "mobile", re: /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/g },
];

/** JWT = three base64url segments whose first segment decodes to a JSON object. */
function isJwt(candidate: string): boolean {
  const head = candidate.split(".")[0] ?? "";
  try {
    const json = Buffer.from(head, "base64url").toString("utf8");
    return isRecord(tryParseJson(json));
  } catch {
    return false;
  }
}

function matchesWhole(kind: PatternKind, re: RegExp, value: string): boolean {
  const anchored = new RegExp(`^(?:${re.source})$`);
  return anchored.test(value) && (kind !== "jwt" || isJwt(value));
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

export function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_HEADERS.has(n) || SENSITIVE_HEADER_PARTS.some((p) => n.includes(p));
}

/** The words of a name: split at non-alphanumerics, camelCase humps and letter / digit boundaries. */
export function nameWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name) || nameWords(name).some((w) => SENSITIVE_WORDS.has(w.toLowerCase()));
}

/** Header names session export always counted as credentials (x-csrf*, x-xsrf*, *-token, *-auth*, *api-key). */
const SENSITIVE_HEADER_EXTRA = /^(x-csrf|x-xsrf)|-token$|-auth|(^|-)api-key$/;

/**
 * The one sensitive-header test (default@3, owner 2026-10-21): the header set and name parts
 * (isSensitiveHeader), the name rule (isSensitiveName) and the session-export extras. Export
 * redaction, live output, offline analysis, session export and the headers withheld from decode
 * plugins all use it.
 */
export function isSensitiveHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  return isSensitiveHeader(n) || isSensitiveName(name) || isSensitiveName(n) || SENSITIVE_HEADER_EXTRA.test(n);
}

/** Percent-encode only what would break a query/form string; placeholders stay readable. */
function lightEncode(s: string): string {
  return s.replace(/[%&=#+ ]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** A query / form name or value as text (`+` is a space); malformed escapes stay as they are. */
export function formDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** A whole value that already is a placeholder: export `«r:…»`, live / analyze `<redacted:…>`, known secret `<secret:…>`, `<masked>`. */
const PLACEHOLDER = /^(?:«r:[^»]*»|<redacted:[^>]*>|<secret:[^>]*>|<masked>)$/;

/** Is this value already redacted (by any of the placeholders)? Then it is never masked again. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/** How a caller shows a sensitive query / form value: gets the decoded name and value, returns the text to print. */
export type PairMask = (name: string, value: string) => string;

/**
 * `k=v&…` (a query or a form body) with the value of every sensitive name (isSensitiveName, decoded)
 * replaced by `mask(name, value)`; every other pair, an empty value and a value that already is a
 * placeholder stay byte for byte. The one walk of live output (liveredact) and offline analysis
 * (AnalyzeRedactor); export redaction (Redactor.formString) also scrubs the other values.
 */
export function redactPairs(text: string, mask: PairMask): string {
  return text
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return part;
      const name = formDecode(part.slice(0, eq));
      if (!isSensitiveName(name)) return part;
      const value = formDecode(part.slice(eq + 1));
      return value === "" || isPlaceholder(value) ? part : `${part.slice(0, eq)}=${mask(name, value)}`;
    })
    .join("&");
}

/** A URL with its query's sensitive values masked (redactPairs); path, fragment and other parameters as they are. */
export function redactQueryPairs(url: string, mask: PairMask): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash);
  return `${url.slice(0, q + 1)}${redactPairs(query, mask)}${hash < 0 ? "" : url.slice(hash)}`;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export class Redactor {
  readonly salt: string;
  private readonly known = new Set<string>();
  private collecting = true;

  constructor(salt: string, knownSecrets: readonly string[] = []) {
    this.salt = salt;
    for (const s of knownSecrets) if (s.length > 0) this.known.add(s);
  }

  /** Switch from pass 1 (collect) to pass 2 (also replace known values). */
  startSecondPass(): void {
    this.collecting = false;
  }

  classify(value: string): string {
    for (const p of PATTERNS) if (matchesWhole(p.kind, p.re, value)) return p.kind;
    return "secret";
  }

  placeholder(value: string): string {
    return `«r:${this.classify(value)}:${sha256Hex(this.salt + value).slice(0, 8)}»`;
  }

  /** Mask a value found by a name rule; remember it for pass 2. */
  mask(value: string): string {
    if (value === "" || value.startsWith("«r:")) return value;
    if (this.collecting && value.length >= KNOWN_MIN_LENGTH) this.known.add(value);
    return this.placeholder(value);
  }

  /** Replace known secret values, then value patterns, inside free text. */
  scrubText(text: string): string {
    let out = text;
    if (!this.collecting && this.known.size > 0) {
      const values = [...this.known].sort((a, b) => b.length - a.length);
      for (const v of values) if (out.includes(v)) out = out.split(v).join(this.placeholder(v));
    }
    for (const p of PATTERNS) {
      out = out.replace(p.re, (m) => (p.kind === "jwt" && !isJwt(m) ? m : this.mask(m)));
    }
    return out;
  }

  /** `a=1&b=2` (query or urlencoded form). Untouched pairs keep their exact bytes. */
  formString(qs: string): string {
    return qs
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        const k = pair.slice(0, eq);
        const v = pair.slice(eq + 1);
        const decoded = formDecode(v);
        if (isSensitiveName(formDecode(k))) return `${k}=${lightEncode(this.mask(decoded))}`;
        const scrubbed = this.scrubText(decoded);
        return scrubbed === decoded ? pair : `${k}=${lightEncode(scrubbed)}`;
      })
      .join("&");
  }

  /** default@3 URL rule: userinfo dropped (review 10-21), the query by the name rule, the rest by the value patterns. */
  url(raw: string): string {
    const u = raw.replace(URL_USERINFO, "$1");
    const hash = u.indexOf("#");
    const frag = hash < 0 ? "" : u.slice(hash);
    const rest = hash < 0 ? u : u.slice(0, hash);
    const q = rest.indexOf("?");
    const base = q < 0 ? rest : rest.slice(0, q);
    const query = q < 0 ? null : rest.slice(q + 1);
    return this.scrubText(base) + (query === null ? "" : "?" + this.formString(query)) + this.scrubText(frag);
  }

  private cookiePairs(value: string, sep: string): string {
    return value
      .split(sep)
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq < 0) return part;
        return part.slice(0, eq + 1) + this.mask(part.slice(eq + 1).trim());
      })
      .join(sep);
  }

  headerValue(name: string, value: string): string {
    const n = name.toLowerCase();
    if (n === "cookie") return this.cookiePairs(value, ";");
    if (n === "set-cookie") {
      const semi = value.indexOf(";");
      const first = semi < 0 ? value : value.slice(0, semi);
      return this.cookiePairs(first, ";") + (semi < 0 ? "" : value.slice(semi));
    }
    if (n === "authorization" || n === "proxy-authorization") {
      const m = /^(\S+)\s+(.+)$/.exec(value);
      return m !== null && m[1] !== undefined && m[2] !== undefined ? `${m[1]} ${this.mask(m[2])}` : this.mask(value);
    }
    if (isSensitiveHeaderName(n)) return this.mask(value);
    if (n === "referer" || n === "location") return this.url(value);
    return this.scrubText(value);
  }

  headers(h: unknown): unknown {
    if (!isRecord(h)) return h;
    const out: Headers = {};
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === "string") out[k] = this.headerValue(k, v);
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? this.headerValue(k, x) : String(x)));
    }
    return out;
  }

  /** Mask every primitive leaf under a sensitive key. */
  private maskAll(v: unknown): unknown {
    if (typeof v === "string") return this.mask(v);
    if (typeof v === "number") return this.mask(String(v));
    if (Array.isArray(v)) return v.map((x) => this.maskAll(x));
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.maskAll(x)]));
    return v;
  }

  json(v: unknown): unknown {
    if (typeof v === "string") return this.scrubText(v);
    if (Array.isArray(v)) return v.map((x) => this.json(x));
    if (isRecord(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSensitiveName(k) ? this.maskAll(x) : this.json(x)]));
    }
    return v;
  }

  /** Redact a text body by type. Returns null when nothing changed. */
  text(text: string, mimeType: string | null): string | null {
    const mime = (mimeType ?? "").toLowerCase();
    let out: string;
    if (mime.includes("x-www-form-urlencoded")) {
      out = this.formString(text);
    } else {
      const trimmed = text.trimStart();
      const parsed = mime.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[") ? tryParseJson(text) : undefined;
      if (parsed !== undefined && (isRecord(parsed) || Array.isArray(parsed))) {
        const red = this.json(parsed);
        out = JSON.stringify(red) === JSON.stringify(parsed) ? text : JSON.stringify(red);
      } else {
        out = this.scrubText(text);
      }
    }
    return out === text ? null : out;
  }

  /** Redact body bytes; binary (non UTF-8) bodies are left alone. Null = unchanged. */
  bytes(bytes: Uint8Array, mimeType: string | null): Uint8Array | null {
    const text = utf8OrNull(bytes);
    if (text === null) return null;
    const out = this.text(text, mimeType);
    return out === null ? null : toBytes(out);
  }

  /** §8: state snapshots are masked as a whole (every cookie / storage value). */
  stateBlob(bytes: Uint8Array): Uint8Array | null {
    const text = utf8OrNull(bytes);
    if (text === null) return null;
    const parsed = tryParseJson(text);
    if (!Array.isArray(parsed)) return this.bytes(bytes, null);
    const red = parsed.map((item: unknown) => {
      if (isRecord(item) && typeof item["value"] === "string") return { ...item, value: this.mask(item["value"]) };
      if (Array.isArray(item) && item.length === 2 && typeof item[1] === "string") return [item[0], this.mask(item[1])];
      return this.json(item);
    });
    const out = JSON.stringify(red);
    return out === text ? null : toBytes(out);
  }
}

// ------------------------------------------------------------ event walker

function headerOf(h: unknown, name: string): string | null {
  if (!isRecord(h)) return null;
  const v = h[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

type BlobRewrite = (ref: string, fn: (bytes: Uint8Array) => Uint8Array | null) => { ref: string; size: number } | null;

/** A request / response side's `decoded` view: its blob redacted as a body of the view's mime. */
function redactDecoded(r: Redactor, side: Record<string, unknown>, rewrite: BlobRewrite): void {
  const d = side["decoded"];
  if (!isRecord(d)) return;
  for (const k of ["error", "note"]) if (typeof d[k] === "string") d[k] = r.scrubText(d[k]);
  if (!isBlobRef(d["blob"])) return;
  const mime = typeof d["mime"] === "string" ? d["mime"] : null;
  const nb = rewrite(d["blob"], (b) => r.bytes(b, mime));
  if (nb !== null) {
    d["blob"] = nb.ref;
    d["bytes"] = nb.size;
  }
}

/** A whole string shaped like a URL: `scheme://…`, a path (`/…`) or a bare query (`?…`), without whitespace. */
const URL_SHAPED = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[/?])\S*$/;
/** Fields that hold a URL whatever it looks like. */
const URL_KEY = /^(?:url|from)$|Url$/;
/** A command-line switch with a value (`--proxy-server=…`): the value is redacted, the switch kept. */
const SWITCH = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*=)([\s\S]*)$/;
/** Ids that are never values: r-12, c-3, n-5, r-12:34 (a ws frame). */
const ID_SHAPED = /^[a-z]-\d+(?::\d+)?$/;
/** Top-level event fields left alone: the envelope (docs/04 §3) and the store names (§8.1: bundle and store join on them). */
const KEEP_KEYS: ReadonlySet<string> = new Set(["seq", "ts", "mono", "kind", "actor", "tab", "cmd", "site", "account"]);

/** default@3: one string of an event or of the manifest. */
function redactString(r: Redactor, s: string, key: string | null): string {
  if (s === "" || isBlobRef(s) || ID_SHAPED.test(s)) return s;
  if (key !== null && URL_KEY.test(key)) return r.url(s);
  const sw = SWITCH.exec(s);
  if (sw !== null && sw[1] !== undefined && sw[2] !== undefined) return sw[1] + redactString(r, sw[2], null);
  return URL_SHAPED.test(s) ? r.url(s) : r.scrubText(s);
}

/** default@3: every string under `v` (in place for records and arrays); array items take their field's key. */
function walk(r: Redactor, v: unknown, key: string | null): unknown {
  if (typeof v === "string") return redactString(r, v, key);
  if (Array.isArray(v)) return v.map((x) => walk(r, x, key));
  if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) v[k] = walk(r, x, k);
    return v;
  }
  return v;
}

/** Walk the fields of `o` except those in `except` (already redacted by their own rule, or not values). */
function walkFields(r: Redactor, o: Record<string, unknown>, except: ReadonlySet<string>): void {
  for (const [k, x] of Object.entries(o)) if (!except.has(k)) o[k] = walk(r, x, k);
}

/** Request / response side fields with their own rules (headers, bodies, decoded views). */
const SIDE_OWN: ReadonlySet<string> = new Set(["headers", "postData", "body", "decoded"]);

function redactEvent(r: Redactor, e: Record<string, unknown>, rewrite: BlobRewrite): void {
  const kind = e["kind"];
  const own = new Set(KEEP_KEYS);

  if (kind === "request") {
    // cdp ids are the browser's, never values
    for (const k of ["request", "response", "cdp"]) own.add(k);
    const req = e["request"];
    if (isRecord(req)) {
      const ctype = headerOf(req["headers"], "content-type");
      req["headers"] = r.headers(req["headers"]);
      const pd = req["postData"];
      if (isRecord(pd) && typeof pd["inline"] === "string") {
        const out = r.text(pd["inline"], ctype);
        if (out !== null) pd["inline"] = out;
      } else if (isRecord(pd) && isBlobRef(pd["blob"])) {
        const nb = rewrite(pd["blob"], (b) => r.bytes(b, ctype));
        if (nb !== null) {
          pd["blob"] = nb.ref;
          pd["size"] = nb.size;
        }
      }
      redactDecoded(r, req, rewrite);
      walkFields(r, req, SIDE_OWN);
    }
    const resp = e["response"];
    if (isRecord(resp)) {
      const mime = typeof resp["mimeType"] === "string" ? resp["mimeType"] : headerOf(resp["headers"], "content-type");
      resp["headers"] = r.headers(resp["headers"]);
      const body = resp["body"];
      if (isRecord(body) && isBlobRef(body["blob"])) {
        const nb = rewrite(body["blob"], (b) => r.bytes(b, mime));
        if (nb !== null) {
          body["blob"] = nb.ref;
          body["size"] = nb.size;
        }
      }
      redactDecoded(r, resp, rewrite);
      walkFields(r, resp, SIDE_OWN);
    }
  } else if (kind === "ws") {
    own.add("payload");
    const p = e["payload"];
    if (isRecord(p) && typeof p["inline"] === "string" && e["opcode"] !== 2) {
      const out = r.text(p["inline"], null);
      if (out !== null) p["inline"] = out;
    } else if (isRecord(p) && isBlobRef(p["blob"]) && e["opcode"] !== 2) {
      const nb = rewrite(p["blob"], (b) => r.bytes(b, null));
      if (nb !== null) {
        p["blob"] = nb.ref;
        p["size"] = nb.size;
      }
    }
  } else if (kind === "sse") {
    // 0.9-C (docs/04 §47): a message's data is page text, redacted like a text WebSocket payload.
    own.add("data");
    const d = e["data"];
    if (isRecord(d) && typeof d["inline"] === "string") {
      const out = r.text(d["inline"], null);
      if (out !== null) d["inline"] = out;
    } else if (isRecord(d) && isBlobRef(d["blob"])) {
      const nb = rewrite(d["blob"], (b) => r.bytes(b, null));
      if (nb !== null) {
        d["blob"] = nb.ref;
        d["size"] = nb.size;
      }
    }
  } else if (kind === "state") {
    own.add("blob");
    if (isBlobRef(e["blob"])) {
      const nb = rewrite(e["blob"], (b) => r.stateBlob(b));
      if (nb !== null) e["blob"] = nb.ref;
    }
  } else if (kind === "action") {
    own.add("value");
    if (typeof e["value"] === "string") e["value"] = r.scrubText(e["value"]);
  } else if (kind === "note") {
    own.add("text");
    if (typeof e["text"] === "string") e["text"] = r.scrubText(e["text"]);
  } else if (kind === "finding") {
    own.add("claim");
    if (typeof e["claim"] === "string") e["claim"] = r.scrubText(e["claim"]);
  } else if (kind === "session") {
    // the session's name, as in manifest.session.name
    own.add("name");
  }
  walkFields(r, e, own);
}

/** default@3: the manifest's values (browser switches, first URLs, notes); names and ids stay. */
function redactManifest(r: Redactor, m: Manifest): void {
  for (const t of m.session.tabs) if (t.firstUrl !== null) t.firstUrl = r.url(t.firstUrl);
  const b = m.producer.browser;
  if (b !== undefined && b !== null) {
    if (b.args !== undefined) b.args = b.args.map((a) => redactString(r, a, null));
    if (b.extraArgs !== undefined) b.extraArgs = b.extraArgs.map((a) => redactString(r, a, null));
    if (b.dropArgs !== undefined) b.dropArgs = b.dropArgs.map((a) => redactString(r, a, null));
  }
  if (typeof m.notes === "string") m.notes = r.scrubText(m.notes);
}

export type RedactedView = BundleView & {
  /** Blobs created by redaction (ref -> bytes); other refs read from the source. */
  readonly rewritten: ReadonlyMap<string, Uint8Array>;
};

export type RedactOptions = { salt: string; knownSecrets?: readonly string[]; now?: () => number };

/** Redact a bundle view in memory (used by HAR export and redactBundle). */
export function redactView(src: BundleView, opts: RedactOptions): RedactedView {
  const r = new Redactor(opts.salt, opts.knownSecrets ?? []);
  const run = (): { manifest: Manifest; events: RawEvent[]; rewritten: Map<string, Uint8Array> } => {
    const rewritten = new Map<string, Uint8Array>();
    const rewrite: BlobRewrite = (ref, fn) => {
      const bytes = src.readBlob(ref);
      if (bytes === null) return null;
      const out = fn(bytes);
      if (out === null) return null;
      const newRef = `sha256:${sha256Hex(out)}`;
      rewritten.set(newRef, out);
      return { ref: newRef, size: out.length };
    };
    const manifest: Manifest = structuredClone(src.manifest);
    redactManifest(r, manifest);
    const events = src.events.map((e) => {
      const copy = structuredClone(e);
      redactEvent(r, copy, rewrite);
      return copy;
    });
    return { manifest, events, rewritten };
  };
  run(); // pass 1: collect values masked by name rules, over the manifest and every event
  r.startSecondPass();
  const { manifest, events, rewritten } = run();
  manifest.redaction = { rules: RULES_VERSION, applied: (opts.now ?? nowMs)() };
  return {
    manifest,
    events,
    rewritten,
    readBlob: (ref: string) => rewritten.get(ref) ?? src.readBlob(ref),
  };
}

/** Write `<bundle>/exports/<name>.salt` (source bundle only). Returns its path. */
export function writeSalt(bundleDir: string, name: string, salt: string): string {
  const dir = join(bundleDir, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.salt`);
  // The salt undoes the placeholders' anonymity: owner-only, like the HAR next to it.
  writeFileAtomic(path, salt + "\n", 0o600);
  return path;
}

/** Collect every blob ref an event mentions (any string value shaped like a ref). */
export function blobRefsOf(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (isBlobRef(v)) out.add(v);
  else if (Array.isArray(v)) for (const x of v) blobRefsOf(x, out);
  else if (isRecord(v)) for (const x of Object.values(v)) blobRefsOf(x, out);
  return out;
}

export type RedactBundleResult = { out: string; saltFile: string; events: number; blobsRewritten: number; missingBlobs: string[] };

/**
 * `tabcap bundle redact <in> <out>`: write a redacted copy. The copy has no raw/
 * (raw CDP is unredacted) and no exports/. `seq` values are preserved.
 */
export async function redactBundle(inDir: string, outDir: string, opts: Partial<RedactOptions> = {}): Promise<RedactBundleResult> {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new TabcapError("conflict", `output directory is not empty: ${outDir}`, "Pick a new directory for the redacted copy; existing bundles are never overwritten.");
  }
  const src = BundleReader.open(inDir);
  const salt = opts.salt ?? newSalt();
  const view = redactView(src, { salt, knownSecrets: opts.knownSecrets ?? [], ...(opts.now === undefined ? {} : { now: opts.now }) });

  const w = await BundleWriter.open(outDir, { manifest: view.manifest, ...(opts.now === undefined ? {} : { now: opts.now }) });
  const missing: string[] = [];
  const refs = new Set<string>();
  for (const e of view.events) {
    w.appendRestored(e);
    blobRefsOf(e, refs);
  }
  for (const ref of refs) {
    const bytes = view.readBlob(ref);
    if (bytes === null) {
      missing.push(ref);
      continue;
    }
    await w.putBlob(bytes);
  }
  await w.close({ finished: src.manifest.finished ?? null });
  const saltFile = writeSalt(inDir, basename(outDir), salt);
  return { out: outDir, saltFile, events: view.events.length, blobsRewritten: view.rewritten.size, missingBlobs: missing };
}
