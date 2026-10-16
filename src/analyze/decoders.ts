// Bounded decode chain for `tabcap analyze find` (docs/05 s04, docs/06 A3).
// Spec: docs/05 s04 table (the 12 channels and the step names reported in the
// chain), docs/04 §5.2.3 (blobs hold real bytes; CDP already removed wire
// compression), docs/04 §9.2 / §13.4 (HAR import), docs/03 §4 "结果为空先怀疑查询".
// Oracle: test/unit/find.test.ts builds every channel with real gzip / brotli /
// base64 / escaping and asserts the exact chain. Reproduce:
//   bun test test/unit/find.test.ts
//
// Model. A body is explored as a tree of nodes (bytes -> text -> JSON values).
// Every decode applied on the way is one step in the chain, named exactly as in
// docs/05 s04. Two kinds of decoders:
// - structural (JSON document, jsonp, sse, ndjson, json-string): they locate the
//   value more precisely, so when they yield a hit it wins over a literal hit on
//   the enclosing text (s04 g/j/k/l are literal in the raw text too);
// - transforms (base64, gzip/br/deflate, urldecode, html-entities,
//   json-unescape): tried only when the node itself has no literal hit.
// The top-level parse of a body as JSON is implicit (no step), as are the JSON
// items inside sse / ndjson; a hit inside an implicit JSON document whose raw
// text does not contain the needle needed unescaping and gets "json-unescape"
// (s04 f). JSON reached after another decode is an explicit "json" step.
//
// Embedded state (0.4-H, embedded.ts): an HTML document's script JSON,
// top-level `window.X = {…}` literals and viewstate fields are structural
// steps "script-json" / "inline-assign" / "viewstate". Their hits address the
// node (`script[0].$.a`, `assign[X].a`, `viewstate[__VIEWSTATE].strings[0]`);
// the text they claim is left out of the literal match on the document, which
// still reports the value where the page shows it (a table cell).
//
// Guards: chain length <= MAX_DEPTH, each step's output <= STEP_CAP, a per-body
// work budget (bytes produced + JSON leaves visited), duplicate decoded
// payloads explored once, iterative JSON walk (no recursion on input depth).

import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { extractEmbedded, mayEmbed, type EmbeddedDoc, type EmbeddedNode, type EmbeddedNote, type EmbeddedStep } from "./embedded.ts";

export const MAX_DEPTH = 4;
export const STEP_CAP = 32 * 1024 * 1024; // 32 MiB, same as the body cap (docs/04 decision c)
export const WORK_BUDGET = 256 * 1024 * 1024; // bytes + leaves explored per body
export const MAX_LEAVES = 2_000_000;
export const MIN_BASE64 = 12;
export const SNIPPET_RADIUS = 80;

export type StepName =
  | "gzip"
  | "br"
  | "deflate"
  | "base64"
  | "json"
  | "json-unescape"
  | "json-string"
  | "urldecode"
  | "html-entities"
  | "jsonp"
  | "sse"
  | "ndjson"
  | "script-json"
  | "inline-assign"
  | "viewstate";

export const STEP_NAMES: readonly StepName[] = [
  "gzip", "br", "deflate", "base64", "json", "json-unescape", "json-string", "urldecode", "html-entities", "jsonp", "sse", "ndjson",
  "script-json", "inline-assign", "viewstate",
];

// ------------------------------------------------------------ small codecs

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. A leading BOM is dropped. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return null;
  }
}

export type Decompressor = "gzip" | "br" | "deflate";

/** Decompress with an output cap; null on any failure (corrupt, too large). */
export function decompress(bytes: Uint8Array, kind: Decompressor | "deflate-raw", cap: number = STEP_CAP): Uint8Array | null {
  try {
    const opts = { maxOutputLength: cap };
    switch (kind) {
      case "gzip":
        return new Uint8Array(gunzipSync(bytes, opts));
      case "br":
        return new Uint8Array(brotliDecompressSync(bytes, opts));
      case "deflate":
        return new Uint8Array(inflateSync(bytes, opts));
      case "deflate-raw":
        return new Uint8Array(inflateRawSync(bytes, opts));
    }
  } catch {
    return null;
  }
}

export const isGzipMagic = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;

/** RFC 1950 zlib header: CM=8, CINFO<=7, (CMF*256+FLG) % 31 == 0, no preset dictionary. */
export function isZlibHeader(b: Uint8Array): boolean {
  const cmf = b[0];
  const flg = b[1];
  if (cmf === undefined || flg === undefined) return false;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && (cmf * 256 + flg) % 31 === 0 && (flg & 0x20) === 0;
}

function startsWith(b: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

/** Media / font / archive magic numbers. Returns a short label or null. */
export function binaryMagic(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46])) return "riff";
  if (startsWith(b, [0x42, 0x4d]) && b.length > 14 && startsWith(b, [0, 0], 6)) return "bmp";
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00])) return "ico";
  if (startsWith(b, [0x77, 0x4f, 0x46, 0x46])) return "woff";
  if (startsWith(b, [0x77, 0x4f, 0x46, 0x32])) return "woff2";
  if (startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00])) return "ttf";
  if (startsWith(b, [0x4f, 0x54, 0x54, 0x4f])) return "otf";
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return "mp4";
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (startsWith(b, [0x49, 0x44, 0x33])) return "mp3";
  if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
  if (startsWith(b, [0x66, 0x4c, 0x61, 0x43])) return "flac";
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return "wasm";
  return null;
}

/** Compressed / archive containers by magic (excluded from the encryption hint). */
export function compressedMagic(b: Uint8Array): string | null {
  if (isGzipMagic(b)) return "gzip";
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (startsWith(b, [0x42, 0x5a, 0x68])) return "bzip2";
  if (isZlibHeader(b)) return "zlib";
  return null;
}

const BINARY_MIME = /^(image|font|video|audio)\//;
const BINARY_MIME_EXACT = new Set([
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/vnd.ms-fontobject",
  "application/pdf",
  "application/wasm",
]);
const COMPRESSED_MIME = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-brotli",
  "application/x-7z-compressed",
  "application/x-xz",
  "application/x-bzip2",
  "application/zstd",
  "application/x-tar",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

export function baseMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Binary media by mime (SVG is XML text, so it is searched). */
export function isBinaryMime(mime: string | null | undefined): boolean {
  const m = baseMime(mime);
  if (m === "image/svg+xml") return false;
  return BINARY_MIME.test(m) || BINARY_MIME_EXACT.has(m);
}

export function isCompressedMime(mime: string | null | undefined): boolean {
  return COMPRESSED_MIME.has(baseMime(mime));
}

/** Shannon entropy in bits per byte. */
export function shannonEntropy(b: Uint8Array): number {
  if (b.length === 0) return 0;
  const counts = new Float64Array(256);
  for (const x of b) counts[x] = (counts[x] ?? 0) + 1;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / b.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const B64_STD = /^[A-Za-z0-9+/]+={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Strict base64: one alphabet (standard or url-safe), '=' only as final
 * padding to a multiple of 4, or no padding at all (length % 4 != 1).
 * Whitespace (line wrapping) is
 * ignored. Returns null for anything else, including strings shorter than
 * `min` characters (default MIN_BASE64: plain words would otherwise "decode";
 * a field known to be base64, such as a viewstate, passes a smaller one).
 */
export function decodeBase64Strict(text: string, min: number = MIN_BASE64): Uint8Array | null {
  if (text.length < min || text.length > STEP_CAP * 2) return null;
  const s = /\s/.test(text) ? text.replace(/\s+/g, "") : text;
  if (s.length < min) return null;
  const padded = s.endsWith("=");
  let std: string;
  if (B64_STD.test(s) && (padded ? s.length % 4 === 0 : s.length % 4 !== 1)) std = s;
  else if (B64_URL.test(s) && (padded ? s.length % 4 === 0 : s.length % 4 !== 1)) std = s.replace(/-/g, "+").replace(/_/g, "/");
  else return null;
  std += "=".repeat((4 - (std.length % 4)) % 4); // unpadded input (base64url style)
  const pad = std.endsWith("==") ? 2 : std.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(Buffer.from(std, "base64"));
  // Round trip guards against Buffer's lenient decoder accepting junk bits.
  if (out.length !== (std.length / 4) * 3 - pad) return null;
  return out;
}

const JSON_ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Undo JSON string escapes found in arbitrary text (\uXXXX incl. surrogate pairs). Null when there are none. */
export function unescapeJsonText(text: string): string | null {
  if (!/\\u[0-9a-fA-F]{4}/.test(text)) return null;
  return text.replace(JSON_ESCAPE, (_m, esc: string) => (esc.length === 5 ? String.fromCharCode(parseInt(esc.slice(1), 16)) : (SIMPLE_ESCAPES[esc] ?? esc)));
}

const PCT_RUN = /(?:%[0-9a-fA-F]{2})+/g;

/** Percent-decoding that leaves invalid UTF-8 runs untouched. Null when nothing is encoded. */
export function urlDecodeLenient(text: string, plusIsSpace = false): string | null {
  if (!/%[0-9a-fA-F]{2}/.test(text) && !(plusIsSpace && text.includes("+"))) return null;
  const src = plusIsSpace ? text.replace(/\+/g, " ") : text;
  return src.replace(PCT_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

const FORM_SNIFF = /^[A-Za-z0-9_.\-*[\]%]+=[^&\s]*(?:&[A-Za-z0-9_.\-*[\]%]+=[^&\s]*)*&?$/;

/**
 * application/x-www-form-urlencoded -> {name: value | value[]}. Without the
 * form mime the text must look like `k=v&k=v` and actually contain an escape.
 */
export function parseFormPairs(text: string, isFormMime: boolean): Record<string, string | string[]> | null {
  const t = text.trim();
  if (t === "" || t.length > STEP_CAP) return null;
  if (!isFormMime && (!FORM_SNIFF.test(t) || !/%[0-9a-fA-F]{2}|\+/.test(t))) return null;
  const out: Record<string, string | string[]> = {};
  for (const pair of t.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = urlDecodeLenient(eq < 0 ? pair : pair.slice(0, eq), true) ?? (eq < 0 ? pair : pair.slice(0, eq));
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    const value = urlDecodeLenient(rawValue, true) ?? rawValue;
    const prev = out[name];
    if (prev === undefined) out[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[name] = [prev, value];
  }
  return Object.keys(out).length === 0 ? null : out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", middot: "·", bull: "•", times: "×", divide: "÷",
  yen: "¥", euro: "€", pound: "£", cent: "¢", deg: "°", plusmn: "±", sect: "§", para: "¶", iexcl: "¡",
  iquest: "¿", shy: "­", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", check: "✓", hearts: "♥", star: "☆", starf: "★",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", micro: "µ", permil: "‰", prime: "′", Prime: "″",
  dagger: "†", Dagger: "‡", circ: "ˆ", tilde: "˜", acute: "´", cedil: "¸", uml: "¨", macr: "¯", ordf: "ª", ordm: "º",
  not: "¬", brvbar: "¦", curren: "¤", infin: "∞", ne: "≠", le: "≤", ge: "≥", minus: "−", lowast: "∗",
};

const ENTITY = /&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

/** Decode HTML named (common subset) and numeric character references. Null when there are none. */
export function decodeHtmlEntities(text: string): string | null {
  let changed = false;
  const out = text.replace(ENTITY, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      changed = true;
      return codePointToString(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      changed = true;
      return codePointToString(parseInt(body.slice(1), 10));
    }
    const v = NAMED_ENTITIES[body];
    if (v === undefined) return m;
    changed = true;
    return v;
  });
  return changed ? out : null;
}

/** Parse text that is a JSON object or array; null otherwise (never throws). */
export function parseJsonDoc(text: string): { value: unknown } | null {
  const t = text.trimStart();
  const c = t[0];
  if (c !== "{" && c !== "[") return null;
  try {
    return { value: JSON.parse(t) as unknown };
  } catch {
    return null;
  }
}

const JSONP_HEAD = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/;

/** `cb({...})` / `ns.cb([...]);` -> the parsed argument when it is JSON. */
export function extractJsonp(text: string): { value: unknown } | null {
  const head = JSONP_HEAD.exec(text.slice(0, 512));
  if (head === null) return null;
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
  if (text[end - 1] === ";") end--;
  while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
  if (text[end - 1] !== ")") return null;
  return parseJsonDoc(text.slice(head[0].length, end - 1));
}

const SSE_FIELD = /^(data|event|id|retry)(:|$)/;

/**
 * text/event-stream -> the `data` of each event (multi-line data joined with
 * "\n", per the WHATWG EventSource parsing rules). Without the mime every
 * non-empty line must be an SSE field or a comment.
 */
export function parseSse(text: string, isSseMime: boolean): string[] | null {
  const lines = text.split(/\r\n|\r|\n/);
  let sawData = false;
  if (!isSseMime) {
    for (const line of lines) {
      if (line === "" || line.startsWith(":")) continue;
      if (!SSE_FIELD.test(line)) return null;
      if (line.startsWith("data")) sawData = true;
    }
    if (!sawData) return null;
  }
  const events: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  }
  flush();
  return events.length === 0 ? null : events;
}

const NDJSON_MIME = new Set(["application/x-ndjson", "application/ndjson", "application/jsonl", "application/x-jsonlines", "application/json-seq"]);

export const isNdjsonMime = (mime: string | null | undefined): boolean => NDJSON_MIME.has(baseMime(mime));

/** Newline-delimited JSON -> non-empty lines, when at least two of them and every one parse as JSON. */
export function splitNdjson(text: string, isMime: boolean): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\u001e/, "")).filter((l) => l.trim() !== "");
  if (lines.length < (isMime ? 1 : 2)) return null;
  for (const l of lines) {
    const t = l.trim();
    if (t[0] !== "{" && t[0] !== "[") return null;
  }
  for (const l of lines) if (parseJsonDoc(l) === null) return null;
  return lines;
}

// ------------------------------------------------------------ JSON paths

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function jsonPathKey(parent: string, key: string): string {
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export const jsonPathIndex = (parent: string, i: number): string => `${parent}[${i}]`;

/** Visit every scalar leaf of a JSON value without recursion. Stops when `visit` returns false. */
export function walkJson(value: unknown, root: string, visit: (path: string, leaf: string | number | boolean | null) => boolean): void {
  const stack: { v: unknown; p: string }[] = [{ v: value, p: root }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    const { v, p } = top;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], p: jsonPathIndex(p, i) });
    } else if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e !== undefined) stack.push({ v: e[1], p: jsonPathKey(p, e[0]) });
      }
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
      if (!visit(p, v)) return;
    }
  }
}

// ------------------------------------------------------------ matcher

export type Match = { index: number; length: number; haystack: string };
export type Matcher = (s: string) => Match | null;

/** The snippet of `m` with SNIPPET_RADIUS characters each side (no split surrogates). */
export function snippetOf(m: Match, radius: number = SNIPPET_RADIUS): string {
  let a = Math.max(0, m.index - radius);
  let b = Math.min(m.haystack.length, m.index + m.length + radius);
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  if (a > 0 && isLow(m.haystack.charCodeAt(a))) a++;
  if (b < m.haystack.length && isHigh(m.haystack.charCodeAt(b - 1))) b--;
  return m.haystack.slice(a, b);
}

// ------------------------------------------------------------ explorer

function nodeTag(n: EmbeddedNode): NodeTag {
  return { step: n.step, address: n.address, ...(n.id === undefined ? {} : { id: n.id }), ...(n.type === undefined ? {} : { type: n.type }) };
}

/** The embedded-state node a hit lies in (embedded.ts). */
export type NodeTag = { step: EmbeddedStep; address: string; id?: string; type?: string };

export type DecodeHit = {
  chain: StepName[];
  /** JSON path per JSON document crossed, outermost first (empty for plain text). */
  paths: string[];
  snippet: string;
  /** The matched text itself (analyze deps reads which value a set matcher found). */
  matched: string;
  /** The match is the whole leaf / text (surrounding whitespace aside), not a part of it. */
  whole: boolean;
  /** Set when the hit lies in an embedded-state node (innermost one). */
  node?: NodeTag;
};

/** An embedded-state node that was not decoded (embedded.ts note), with where its document was reached. */
export type EmbeddedSkip = EmbeddedNote & { chain: StepName[]; paths: string[] };

export type OpaqueNode = { size: number; entropy: number; chain: StepName[]; paths: string[] };

export type ExploreHints = {
  mime?: string | null;
  /** The node is the whole body / frame / text (JSON parse is implicit there). */
  top?: boolean;
};

export type ExploreOptions = {
  maxHits?: number;
  /** Record steps applied (`stats`) and undecodable payloads (`opaque`). */
  record?: boolean;
  /** Undecodable top-level bytes may count as encrypted (false for compressed / binary mime). */
  entropyEligible?: boolean;
  /**
   * The matcher compares whole values (analyze where): "json-unescape" is
   * judged per matched string leaf (its text is not literally in the raw
   * document) instead of by running the matcher on the raw document.
   */
  wholeValues?: boolean;
};

type Ctx = { chain: StepName[]; paths: string[]; root: string };

const EMPTY: DecodeHit[] = [];

/** Small cache: deps explores one body several times; the same document is scanned once. */
const EMBED_CACHE = new Map<string, EmbeddedDoc>();
const EMBED_CACHE_SIZE = 4;

function embeddedOf(t: string): EmbeddedDoc {
  const key = `${t.length}:${Bun.hash(t).toString(16)}`;
  const have = EMBED_CACHE.get(key);
  if (have !== undefined) return have;
  const doc = extractEmbedded(t);
  if (EMBED_CACHE.size >= EMBED_CACHE_SIZE) {
    const first = EMBED_CACHE.keys().next();
    if (first.done !== true) EMBED_CACHE.delete(first.value);
  }
  EMBED_CACHE.set(key, doc);
  return doc;
}

/** HTML that may carry embedded state: an HTML mime, or text that starts with a tag. */
function htmlWithState(t: string, mime: string): boolean {
  if (!mayEmbed(t)) return false;
  return mime === "text/html" || mime === "application/xhtml+xml" || t.trimStart().startsWith("<");
}

/** One exploration of one payload with one matcher. */
export class Explorer {
  readonly stats: Partial<Record<StepName, number>> = {};
  readonly opaque: OpaqueNode[] = [];
  /** Embedded-state nodes seen but not decoded (unparsed / over a bound). */
  readonly embeddedSkips: EmbeddedSkip[] = [];
  budgetExceeded = false;
  private node: NodeTag | undefined = undefined;
  private work = 0;
  private leaves = 0;
  private hitCount = 0;
  private readonly seen = new Set<string>();
  private readonly maxHits: number;
  private readonly record: boolean;
  private readonly entropyEligible: boolean;
  private readonly wholeValues: boolean;

  constructor(
    private readonly matcher: Matcher,
    opts: ExploreOptions = {},
  ) {
    this.maxHits = opts.maxHits ?? 50;
    this.record = opts.record ?? true;
    this.entropyEligible = opts.entropyEligible ?? true;
    this.wholeValues = opts.wholeValues ?? false;
  }

  /** Explore bytes. `prefix` steps were already applied before the bytes were stored (HAR import). */
  exploreBytes(bytes: Uint8Array, hints: ExploreHints = {}, prefix: StepName[] = []): DecodeHit[] {
    return this.bytes(bytes, { chain: [...prefix], paths: [], root: "$" }, hints.top ?? true, baseMime(hints.mime));
  }

  exploreText(text: string, hints: ExploreHints = {}, prefix: StepName[] = []): DecodeHit[] {
    return this.text(text, { chain: [...prefix], paths: [], root: "$" }, hints.top ?? true, baseMime(hints.mime));
  }

  private full(): boolean {
    return this.budgetExceeded || this.hitCount >= this.maxHits;
  }

  private spend(n: number): boolean {
    this.work += n;
    if (this.work > WORK_BUDGET || this.leaves > MAX_LEAVES) this.budgetExceeded = true;
    return !this.budgetExceeded;
  }

  private can(ctx: Ctx, steps: number): boolean {
    return ctx.chain.length + steps <= MAX_DEPTH && !this.full();
  }

  private step(ctx: Ctx, ...steps: StepName[]): Ctx {
    if (this.record) for (const s of steps) this.stats[s] = (this.stats[s] ?? 0) + 1;
    return { chain: [...ctx.chain, ...steps], paths: ctx.paths, root: "$" };
  }

  /** Decoded payloads are explored once per (content, depth, top) to stop explosions. */
  private firstVisit(kind: string, content: Uint8Array | string, ctx: Ctx, top: boolean): boolean {
    if (typeof content === "string" ? content.length < 64 : content.length < 64) return true;
    const key = `${kind}:${ctx.chain.length}:${top ? 1 : 0}:${content.length}:${Bun.hash(content).toString(16)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private hit(ctx: Ctx, m: Match, extra: StepName[] = [], extraPath: string | null = null): DecodeHit {
    this.hitCount++;
    const paths = extraPath === null ? ctx.paths : [...ctx.paths, extraPath];
    const matched = m.haystack.slice(m.index, m.index + m.length);
    return { chain: [...ctx.chain, ...extra], paths, snippet: snippetOf(m), matched, whole: m.haystack.trim() === matched, ...(this.node === undefined ? {} : { node: this.node }) };
  }

  private bytes(b: Uint8Array, ctx: Ctx, top: boolean, mime: string): DecodeHit[] {
    if (this.full() || b.length > STEP_CAP || !this.spend(b.length)) return EMPTY;
    if (!this.firstVisit("b", b, ctx, top)) return EMPTY;
    if (isGzipMagic(b) && this.can(ctx, 1)) {
      const out = decompress(b, "gzip");
      if (out !== null) return this.bytes(out, this.step(ctx, "gzip"), top, mime);
    }
    if (isZlibHeader(b) && this.can(ctx, 1)) {
      const out = decompress(b, "deflate");
      if (out !== null) return this.bytes(out, this.step(ctx, "deflate"), top, mime);
    }
    const text = utf8(b);
    if (text !== null) return this.text(text.startsWith("﻿") ? text.slice(1) : text, ctx, top, mime);
    if (binaryMagic(b) !== null) return EMPTY;
    // No magic: brotli and raw deflate are accepted only when they yield UTF-8 text.
    if (compressedMagic(b) === null && this.can(ctx, 1)) {
      for (const kind of ["br", "deflate-raw"] as const) {
        const out = decompress(b, kind);
        const t = out === null || out.length === 0 ? null : utf8(out);
        if (out !== null && t !== null) return this.bytes(out, this.step(ctx, kind === "br" ? "br" : "deflate"), top, mime);
      }
    }
    if (this.record && b.length >= 256 && compressedMagic(b) === null && (ctx.chain.length > 0 || this.entropyEligible)) {
      this.opaque.push({ size: b.length, entropy: shannonEntropy(b), chain: [...ctx.chain], paths: [...ctx.paths] });
    }
    return EMPTY;
  }

  private text(t: string, ctx: Ctx, top: boolean, mime: string): DecodeHit[] {
    if (this.full() || !this.spend(t.length)) return EMPTY;
    const direct = this.matcher(t);

    // structural: a JSON document
    const doc = parseJsonDoc(t);
    if (doc !== null) {
      let res: DecodeHit[] = EMPTY;
      if (top) res = this.json(doc.value, ctx, t);
      else if (this.can(ctx, 1)) res = this.json(doc.value, this.step(ctx, "json"), null);
      if (res.length > 0) return res;
      return direct === null ? EMPTY : [this.hit(ctx, direct, [], ctx.root === "$" ? null : ctx.root)];
    }

    // structural: embedded state of an HTML document
    if (this.can(ctx, 1) && htmlWithState(t, mime)) {
      const res = this.embedded(t, ctx);
      if (res.length > 0) return res;
    }

    // structural: jsonp, sse, ndjson
    const structural: DecodeHit[] = [];
    if (this.can(ctx, 2)) {
      const parsed = extractJsonp(t);
      if (parsed !== null) structural.push(...this.json(parsed.value, this.step(ctx, "jsonp", "json"), null));
    }
    if (structural.length === 0 && this.can(ctx, 1)) {
      const events = parseSse(t, mime === "text/event-stream");
      if (events !== null) {
        const c = this.step(ctx, "sse");
        events.forEach((data, i) => structural.push(...this.text(data, { ...c, root: jsonPathIndex("$", i) }, true, "")));
      }
    }
    if (structural.length === 0 && this.can(ctx, 1)) {
      const lines = splitNdjson(t, isNdjsonMime(mime));
      if (lines !== null) {
        const c = this.step(ctx, "ndjson");
        lines.forEach((line, i) => structural.push(...this.text(line, { ...c, root: jsonPathIndex("$", i) }, true, "")));
      }
    }
    if (structural.length > 0) return structural;
    if (direct !== null) return [this.hit(ctx, direct, [], ctx.root === "$" ? null : ctx.root)];
    return this.transforms(t, ctx, mime);
  }

  /**
   * script-json / inline-assign / viewstate nodes of an HTML document, then a
   * literal match on the text the decoded nodes did not claim.
   */
  private embedded(t: string, ctx: Ctx): DecodeHit[] {
    const doc = embeddedOf(t);
    if (this.record) for (const n of doc.notes) this.embeddedSkips.push({ ...n, chain: [...ctx.chain], paths: [...ctx.paths] });
    if (doc.nodes.length === 0) return EMPTY;
    const base: Ctx = ctx.root === "$" ? ctx : { ...ctx, paths: [...ctx.paths, ctx.root], root: "$" };
    const out: DecodeHit[] = [];
    const outer = this.node;
    for (const n of doc.nodes) {
      if (this.full()) break;
      this.node = nodeTag(n);
      const c = this.step(base, n.step);
      if (n.raw !== undefined) {
        const m = this.matcher(n.raw);
        if (m !== null) out.push(this.hit(c, m, [], n.address));
      }
      if (n.value !== undefined) out.push(...this.json(n.value, { ...c, root: n.root }, n.text ?? null));
    }
    this.node = outer;
    // the rest of the document, matched literally
    let from = 0;
    const spans = [...doc.nodes.map((n) => n.span)].sort((a, b) => a[0] - b[0]);
    spans.push([t.length, t.length]);
    for (const [a, b] of spans) {
      if (a > from && !this.full()) {
        const m = this.matcher(t.slice(from, a));
        if (m !== null) {
          out.push(this.hit(base, m));
          break;
        }
      }
      from = Math.max(from, b);
    }
    return out;
  }

  /** Decoders that rewrite text; only tried when the text has no literal hit. */
  private transforms(t: string, ctx: Ctx, mime: string): DecodeHit[] {
    if (!this.can(ctx, 1)) return EMPTY;
    const c0: Ctx = ctx.root === "$" ? ctx : { ...ctx, paths: [...ctx.paths, ctx.root], root: "$" };
    const out: DecodeHit[] = [];
    const b64 = decodeBase64Strict(t);
    if (b64 !== null && this.worthBase64(b64) && this.firstVisit("b64", t, c0, false)) {
      out.push(...this.bytes(b64, this.step(c0, "base64"), false, ""));
    }
    const form = parseFormPairs(t, mime === "application/x-www-form-urlencoded");
    if (form !== null) {
      out.push(...this.json(form, this.step(c0, "urldecode"), null));
    } else {
      const u = urlDecodeLenient(t);
      if (u !== null && u !== t) out.push(...this.text(u, this.step(c0, "urldecode"), false, ""));
    }
    const h = decodeHtmlEntities(t);
    if (h !== null) out.push(...this.text(h, this.step(c0, "html-entities"), false, ""));
    const j = unescapeJsonText(t);
    if (j !== null && j !== t) out.push(...this.text(j, this.step(c0, "json-unescape"), false, ""));
    return out;
  }

  /** Base64 output worth following: text, a compressed stream, or a large opaque blob (entropy hint). */
  private worthBase64(b: Uint8Array): boolean {
    return utf8(b) !== null || compressedMagic(b) !== null || binaryMagic(b) !== null || b.length >= 256;
  }

  /**
   * Walk a JSON document. `rawText` is set for an implicit (top-level / sse /
   * ndjson item) document: a value hit there whose raw text lacks the needle
   * needed unescaping, reported as "json-unescape".
   */
  private json(value: unknown, ctx: Ctx, rawText: string | null): DecodeHit[] {
    const out: DecodeHit[] = [];
    let rawHas: boolean | null = null;
    walkJson(value, ctx.root, (path, leaf) => {
      if (this.full()) return false;
      this.leaves++;
      if (this.leaves > MAX_LEAVES) {
        this.budgetExceeded = true;
        return false;
      }
      if (leaf === null) return true;
      const s = typeof leaf === "string" ? leaf : String(leaf);
      const at: Ctx = { chain: ctx.chain, paths: [...ctx.paths, path], root: "$" };
      // structural: a string field that is itself a JSON document
      if (typeof leaf === "string" && this.can(ctx, 2)) {
        const inner = parseJsonDoc(s);
        if (inner !== null && this.firstVisit("js", s, at, false)) {
          const res = this.json(inner.value, this.step(at, "json-string", "json"), null);
          if (res.length > 0) {
            out.push(...res);
            return true;
          }
        }
      }
      const m = this.matcher(s);
      if (m !== null) {
        let unescaped = false;
        if (rawText !== null && this.wholeValues) unescaped = typeof leaf === "string" && !rawText.includes(m.haystack.slice(m.index, m.index + m.length));
        else if (rawText !== null) {
          if (rawHas === null) rawHas = this.matcher(rawText) !== null;
          unescaped = rawHas === false;
        }
        out.push(this.hit(at, m, unescaped ? ["json-unescape"] : []));
        return true;
      }
      if (typeof leaf === "string" && s.length >= 4) out.push(...this.transforms(s, at, ""));
      return true;
    });
    return out;
  }
}
