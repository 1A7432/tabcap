// Embedded-state decoders: three built-in steps of the analyze decode chain
// (owner decision 2026-10-16, docs/08 §3 "0.4 补充"; docs/05 s04 step table and
// s41; docs/09 §6.2 / §6.5). They read an HTML document's text; page scripts
// are never executed, everything is a bounded text scanner.
//
//   script-json    <script type="application/json"> / "application/ld+json"
//                  (Next.js `<script id="__NEXT_DATA__" type="application/json">`
//                  included): node `script[<n>]`, n = index among such scripts
//                  in document order; the JSON continues below it as
//                  `script[<n>].$.a.b[0]`. Over 4 MiB: skipped, note `truncated`.
//                  Malformed JSON: note `unparsed`.
//   inline-assign  inline scripts (no `src`, a JavaScript type): top-level
//                  `window.X = <literal>`, `var|let|const X = <literal>` where
//                  the literal is an object / array in JSON or a tolerant
//                  superset (unquoted identifier keys, single-quoted strings,
//                  trailing commas, `undefined` -> null) and the statement ends
//                  after it. Node `assign[X]`, JSON below it as `assign[X].a[0]`.
//                  At most 64 per document, 1 MiB per literal; a literal that
//                  does not parse is `unparsed` with its first 80 chars quoted.
//                  Anything else on the right-hand side is not decoded.
//   viewstate      hidden inputs __VIEWSTATE / __VIEWSTATEGENERATOR /
//                  __EVENTVALIDATION / javax.faces.ViewState: node
//                  `viewstate[<name>]` is the value as sent; base64-decoded
//                  (2 MiB per field) it is `{bytes:{length, sha256}, strings}`,
//                  strings = printable runs (>= 4 ASCII bytes, >= 4 UTF-16LE
//                  units) in byte order, de-duplicated. No .NET LOS / Java
//                  object-graph decoding.
//
// A decoded node claims its text (script body, literal, input value): the
// explorer matches the rest of the document literally, so a value shown in a
// table cell and carried in a script is reported once per place.
// Untrusted input: linear scans, the tolerant parser stops at MAX_NESTING, no
// function throws.
// Oracle: test/unit/embedded.test.ts (hand-written HTML and bytes) and docs/05
// s41 on the range site (test/e2e/v04h.e2e.test.ts).
// Reproduce: bun test test/unit/embedded.test.ts

import { createHash } from "node:crypto";
import { decodeBase64Strict, decodeHtmlEntities } from "./codecs.ts";

export const MAX_SCRIPT_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_ASSIGNMENTS = 64;
export const MAX_LITERAL_BYTES = 1024 * 1024;
export const MAX_VIEWSTATE_BYTES = 2 * 1024 * 1024;
export const MIN_RUN = 4;
/** Strings kept per viewstate field (random bytes make many short runs). */
export const MAX_STRINGS = 10_000;
/** Deepest object / array nesting the tolerant parser accepts. */
export const MAX_NESTING = 512;
export const UNPARSED_QUOTE = 80;
/** Notes kept per document. */
export const MAX_NOTES = 256;

export type EmbeddedStep = "script-json" | "inline-assign" | "viewstate";

export const VIEWSTATE_FIELDS: readonly string[] = ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "javax.faces.ViewState"];

export type EmbeddedNode = {
  step: EmbeddedStep;
  /** `script[0]`, `assign[__STATE__]`, `viewstate[__VIEWSTATE]`. */
  address: string;
  /** JSON path root of `value`: `script[0].$`, `assign[__STATE__]`, `viewstate[__VIEWSTATE]`. */
  root: string;
  /** script-json: the script's `id` / `type` attributes. */
  id?: string;
  type?: string;
  /** The decoded value; absent for a viewstate field that is not base64 (or too large). */
  value?: unknown;
  /** The source text `value` was parsed from (json-unescape judgement); absent for viewstate. */
  text?: string;
  /** viewstate: the field value as sent (entity-decoded attribute). */
  raw?: string;
  /** [start, end) of the claimed text in the document. */
  span: [number, number];
};

export type EmbeddedNote = { step: EmbeddedStep; address: string; status: "unparsed" | "truncated"; detail: string; id?: string; type?: string };

export type EmbeddedDoc = { nodes: EmbeddedNode[]; notes: EmbeddedNote[] };

const quote = (s: string): string => JSON.stringify(s.length > UNPARSED_QUOTE ? s.slice(0, UNPARSED_QUOTE) : s);
const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

/** Cheap pre-check: the text may carry embedded state. */
export function mayEmbed(text: string): boolean {
  return /<(script|input)\b/i.test(text);
}

// ------------------------------------------------------------ HTML scanning

/** Index just past the `>` that ends a tag whose attributes start at `from` (quotes respected), or the input length. */
function tagEnd(html: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q !== null) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i + 1;
  }
  return html.length;
}

type Attr = { value: string; start: number; end: number };

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attributes of a tag (names lowercased, first one wins); value offsets are absolute. */
function parseAttrs(html: string, from: number, to: number): Map<string, Attr> {
  const out = new Map<string, Attr>();
  const s = html.slice(from, to);
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(s); m !== null; m = ATTR.exec(s)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name === "" || out.has(name)) continue;
    const dq = m[2];
    const sq = m[3];
    const uq = m[4];
    const value = dq ?? sq ?? uq ?? "";
    const quoted = dq !== undefined || sq !== undefined;
    const endInMatch = m[0].length - (quoted ? 1 : 0);
    const start = from + m.index + endInMatch - value.length;
    out.set(name, { value, start, end: start + value.length });
  }
  return out;
}

const OPEN = /<!--|<(script|input|style|textarea|title|xmp)(?=[\s/>])/gi;
const JS_TYPE = /^(|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/(?:jscript|livescript))$/;
const JSON_TYPES = new Set(["application/json", "application/ld+json"]);

function indexOfCI(html: string, needle: string, from: number): number {
  const re = new RegExp(needle, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m === null ? -1 : m.index;
}

/** All embedded-state nodes of an HTML document, in document order. Never throws. */
export function extractEmbedded(html: string): EmbeddedDoc {
  const nodes: EmbeddedNode[] = [];
  const notes: EmbeddedNote[] = [];
  const note = (n: EmbeddedNote) => {
    if (notes.length < MAX_NOTES) notes.push(n);
  };
  const assigns = { count: 0, full: false };
  let scriptN = 0;
  OPEN.lastIndex = 0;
  let i = 0;
  while (i < html.length) {
    OPEN.lastIndex = i;
    const m = OPEN.exec(html);
    if (m === null) break;
    if (m[0] === "<!--") {
      const e = html.indexOf("-->", m.index + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    const tag = (m[1] ?? "").toLowerCase();
    const attrFrom = m.index + m[0].length;
    const end = tagEnd(html, attrFrom);
    const attrs = parseAttrs(html, attrFrom, end - 1);
    if (tag === "input") {
      viewstateField(attrs, nodes, note);
      i = end;
      continue;
    }
    // raw-text / RCDATA element: its content runs to the closing tag
    const close = indexOfCI(html, `</${tag}`, end);
    const contentEnd = close < 0 ? html.length : close;
    i = close < 0 ? html.length : tagEnd(html, close + 2);
    if (tag !== "script") continue;
    const content = html.slice(end, contentEnd);
    const type = (attrs.get("type")?.value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (JSON_TYPES.has(type)) {
      scriptJson(content, end, scriptN++, attrs.get("id")?.value, attrs.get("type")?.value ?? type, nodes, note);
    } else if (!attrs.has("src") && JS_TYPE.test(type) && !assigns.full) {
      scanAssignments(content, end, assigns, nodes, note);
    }
  }
  return { nodes, notes };
}

function scriptJson(content: string, start: number, n: number, id: string | undefined, type: string, nodes: EmbeddedNode[], note: (n: EmbeddedNote) => void): void {
  const address = `script[${n}]`;
  const meta = { ...(id === undefined ? {} : { id }), type };
  const bytes = utf8Length(content);
  if (bytes > MAX_SCRIPT_JSON_BYTES) {
    note({ step: "script-json", address, status: "truncated", detail: `${bytes} bytes, over the ${MAX_SCRIPT_JSON_BYTES} byte bound; not decoded`, ...meta });
    return;
  }
  const t = content.trim();
  let value: unknown;
  try {
    value = JSON.parse(t) as unknown;
  } catch {
    note({ step: "script-json", address, status: "unparsed", detail: `not JSON: ${quote(t)}`, ...meta });
    return;
  }
  nodes.push({ step: "script-json", address, root: `${address}.$`, ...meta, value, text: content, span: [start, start + content.length] });
}

function viewstateField(attrs: Map<string, Attr>, nodes: EmbeddedNode[], note: (n: EmbeddedNote) => void): void {
  if ((attrs.get("type")?.value ?? "").trim().toLowerCase() !== "hidden") return;
  const name = attrs.get("name")?.value ?? "";
  if (!VIEWSTATE_FIELDS.includes(name)) return;
  const v = attrs.get("value");
  if (v === undefined || v.value === "") return;
  const raw = decodeHtmlEntities(v.value) ?? v.value;
  const address = `viewstate[${name}]`;
  const base: EmbeddedNode = { step: "viewstate", address, root: address, raw, span: [v.start, v.end] };
  const compact = raw.replace(/\s+/g, "");
  const estimate = Math.floor((compact.length * 3) / 4);
  if (estimate > MAX_VIEWSTATE_BYTES) {
    note({ step: "viewstate", address, status: "truncated", detail: `about ${estimate} bytes decoded, over the ${MAX_VIEWSTATE_BYTES} byte bound; only the value as sent is searched` });
    nodes.push(base);
    return;
  }
  const bytes = compact.length < 2 ? null : decodeBase64Strict(compact, 2);
  if (bytes === null) {
    note({ step: "viewstate", address, status: "unparsed", detail: `not base64: ${quote(raw)}` });
    nodes.push(base);
    return;
  }
  const runs = printableRuns(bytes);
  if (runs.truncated) note({ step: "viewstate", address, status: "truncated", detail: `more than ${MAX_STRINGS} strings; the rest are not listed` });
  nodes.push({ ...base, value: { bytes: { length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, strings: runs.strings } });
}

// ------------------------------------------------------------ printable runs

const isAsciiPrintable = (b: number): boolean => b >= 0x20 && b <= 0x7e;

function fromUnits(units: readonly number[]): string {
  let s = "";
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode(...units.slice(i, i + 4096));
  return s;
}

/**
 * A UTF-16LE code unit that counts as printable: ASCII (high byte 0), or a
 * non-ASCII letter / punctuation range below whose low byte is not 0 (a 0 low
 * byte is ASCII UTF-16 text read one byte off).
 */
function isPrintableUnit(u: number): boolean {
  if (u <= 0xff) return isAsciiPrintable(u) || (u >= 0xa0 && u <= 0xff);
  if ((u & 0xff) === 0) return false;
  // Latin Extended-A and CJK Ext A are left out on purpose: their units are
  // what a control byte next to ASCII text reads as, and they are rare in text.
  return (
    (u >= 0x0370 && u <= 0x04ff) || // Greek, Cyrillic
    (u >= 0x2010 && u <= 0x205e) || // general punctuation
    (u >= 0x3000 && u <= 0x30ff) || // CJK symbols, kana
    (u >= 0x4e00 && u <= 0x9fff) || // CJK unified
    (u >= 0xac00 && u <= 0xd7a3) || // Hangul
    (u >= 0xff01 && u <= 0xff5e) // full-width forms
  );
}

/**
 * Printable runs of a byte string, in order of their first byte, de-duplicated:
 * >= MIN_RUN printable ASCII bytes, and >= MIN_RUN printable UTF-16LE units at
 * either byte alignment. A UTF-16LE run is kept only when more than half of its
 * units are not two printable ASCII bytes (otherwise it is ASCII text read as
 * UTF-16).
 */
export function printableRuns(b: Uint8Array): { strings: string[]; truncated: boolean } {
  const found: { at: number; s: string }[] = [];
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const ok = i < b.length && isAsciiPrintable(b[i] ?? 0);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= MIN_RUN) found.push({ at: start, s: Buffer.from(b.subarray(start, i)).toString("latin1") });
      start = -1;
    }
  }
  for (const align of [0, 1]) {
    let runStart = -1;
    let units: number[] = [];
    let wide = 0;
    const flush = () => {
      if (units.length >= MIN_RUN && wide * 2 > units.length) found.push({ at: runStart, s: fromUnits(units) });
      runStart = -1;
      units = [];
      wide = 0;
    };
    for (let i = align; i + 1 < b.length; i += 2) {
      const lo = b[i] ?? 0;
      const hi = b[i + 1] ?? 0;
      const u = lo | (hi << 8);
      if (!isPrintableUnit(u)) {
        flush();
        continue;
      }
      if (runStart < 0) runStart = i;
      if (units.length < 65_536) units.push(u);
      if (!(isAsciiPrintable(lo) && isAsciiPrintable(hi))) wide++;
    }
    flush();
  }
  found.sort((a, b2) => a.at - b2.at);
  const seen = new Set<string>();
  const strings: string[] = [];
  for (const f of found) {
    if (seen.has(f.s)) continue;
    if (strings.length >= MAX_STRINGS) return { strings, truncated: true };
    seen.add(f.s);
    strings.push(f.s);
  }
  return { strings, truncated: false };
}

// ------------------------------------------------------------ inline scripts

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
/** After one of these the next `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
/** A line break before one of these continues the expression (no automatic semicolon). */
const CONTINUES = new Set([".", "(", "[", "`", "+", "-", "*", "/", "%", "?", "&", "|", "^", ",", "=", "<", ">", "!"]);
const ASSIGN_HEAD = /(?:window\s*\.\s*([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*))\s*=(?![=>])\s*/y;

/** Index after a '...' / "..." string starting at i (stops at a line break or the end). */
function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (c === "\n" || c === "\r") return j;
    else j++;
  }
  return s.length;
}

/** Index after a template literal starting at i, `${ … }` (nested templates included) skipped iteratively. */
function skipTemplate(s: string, i: number): number {
  const stack: ({ t: "tpl" } | { t: "expr"; braces: number })[] = [{ t: "tpl" }];
  let j = i + 1;
  while (j < s.length) {
    const top = stack[stack.length - 1];
    if (top === undefined) return j;
    const c = s[j];
    if (top.t === "tpl") {
      if (c === "\\") j += 2;
      else if (c === "`") {
        stack.pop();
        j++;
        if (stack.length === 0) return j;
      } else if (c === "$" && s[j + 1] === "{") {
        stack.push({ t: "expr", braces: 0 });
        j += 2;
      } else j++;
      continue;
    }
    if (c === "'" || c === '"') j = skipString(s, j);
    else if (c === "`") {
      stack.push({ t: "tpl" });
      j++;
    } else if (c === "/" && s[j + 1] === "/") j = lineEnd(s, j);
    else if (c === "/" && s[j + 1] === "*") j = commentEnd(s, j);
    else if (c === "{") {
      top.braces++;
      j++;
    } else if (c === "}") {
      if (top.braces === 0) stack.pop();
      else top.braces--;
      j++;
    } else j++;
  }
  return s.length;
}

function lineEnd(s: string, i: number): number {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
}

function commentEnd(s: string, i: number): number {
  const e = s.indexOf("*/", i + 2);
  return e < 0 ? s.length : e + 2;
}

/** Index after a regular expression literal starting at i (classes respected; stops at a line break). */
function skipRegex(s: string, i: number): number {
  let j = i + 1;
  let cls = false;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === "\n" || c === "\r") return j;
    else if (cls) {
      if (c === "]") cls = false;
      j++;
    } else if (c === "[") {
      cls = true;
      j++;
    } else if (c === "/") return j + 1;
    else j++;
  }
  return s.length;
}

/**
 * End of an object / array literal starting at i (balanced brackets; strings,
 * templates, comments skipped); -1 when it does not close within `limit`
 * characters or before the end.
 */
function literalEnd(s: string, i: number, limit: number): number | "too-long" {
  let depth = 0;
  let j = i;
  const stop = Math.min(s.length, i + limit);
  while (j < stop) {
    const c = s[j];
    if (c === "'" || c === '"') j = skipString(s, j);
    else if (c === "`") j = skipTemplate(s, j);
    else if (c === "/" && s[j + 1] === "/") j = lineEnd(s, j);
    else if (c === "/" && s[j + 1] === "*") j = commentEnd(s, j);
    else {
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") {
        depth--;
        if (depth === 0) return j + 1;
        if (depth < 0) return -1;
      }
      j++;
    }
  }
  return stop < s.length ? "too-long" : -1;
}

/** The statement ends right after the literal: `;`, the end, or a line break not followed by a continuation. */
function statementEnds(s: string, k: number): boolean {
  let j = k;
  let newline = false;
  while (j < s.length) {
    const c = s[j] ?? "";
    if (c === "\n" || c === "\r" || c === " " || c === " ") {
      newline = true;
      j++;
    } else if (/\s/.test(c)) j++;
    else if (c === "/" && s[j + 1] === "/") j = lineEnd(s, j);
    else if (c === "/" && s[j + 1] === "*") {
      const e = commentEnd(s, j);
      if (s.slice(j, e).includes("\n")) newline = true;
      j = e;
    } else break;
  }
  if (j >= s.length) return true;
  const c = s[j] ?? "";
  if (c === ";" || c === "}") return true;
  return newline && !CONTINUES.has(c);
}

function scanAssignments(src: string, base: number, state: { count: number; full: boolean }, nodes: EmbeddedNode[], note: (n: EmbeddedNote) => void): void {
  let depth = 0;
  let prev = ""; // last significant character
  let word = ""; // last identifier, for regex-after-keyword
  let newline = true; // a line break since the last significant character (script start counts)
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (c === "\n" || c === "\r" || c === " " || c === " ") {
      newline = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = lineEnd(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = commentEnd(src, i);
      if (src.slice(i, e).includes("\n")) newline = true;
      i = e;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipString(src, i);
      prev = c;
      word = "";
      newline = false;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      prev = c;
      word = "";
      newline = false;
      continue;
    }
    if (c === "/") {
      i = REGEX_AFTER.has(prev) || REGEX_KEYWORDS.has(word) ? skipRegex(src, i) : i + 1;
      prev = "/";
      word = "";
      newline = false;
      continue;
    }
    if (IDENT_START.test(c) && !IDENT_PART.test(src[i - 1] ?? "")) {
      const atStatement = depth === 0 && (prev === "" || prev === ";" || prev === "}" || (newline && !CONTINUES.has(prev)));
      if (atStatement) {
        const next = assignmentAt(src, i, base, state, nodes, note);
        if (state.full) return;
        if (next !== null) {
          i = next;
          prev = ";";
          word = "";
          newline = false;
          continue;
        }
      }
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j] ?? "")) j++;
      word = src.slice(i, j);
      prev = "a";
      newline = false;
      i = j;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
    prev = c;
    word = "";
    newline = false;
    i++;
  }
}

/**
 * Try `window.X = <literal>` / `var|let|const X = <literal>` at i. Returns the
 * index after the literal when an assignment node (or note) was produced, else
 * null (scanning continues normally).
 */
function assignmentAt(src: string, i: number, base: number, state: { count: number; full: boolean }, nodes: EmbeddedNode[], note: (n: EmbeddedNote) => void): number | null {
  ASSIGN_HEAD.lastIndex = i;
  const m = ASSIGN_HEAD.exec(src);
  if (m === null) return null;
  const name = m[1] ?? m[2] ?? "";
  const at = i + m[0].length;
  const open = src[at];
  if (open !== "{" && open !== "[") return null;
  const address = `assign[${name}]`;
  const end = literalEnd(src, at, MAX_LITERAL_BYTES + 1);
  if (end !== "too-long" && end >= 0 && !statementEnds(src, end)) return null; // an expression, not a literal
  if (state.count >= MAX_ASSIGNMENTS) {
    note({ step: "inline-assign", address, status: "truncated", detail: `more than ${MAX_ASSIGNMENTS} assignments in the document; this and later ones are not decoded` });
    state.full = true;
    return null;
  }
  state.count++;
  if (end === "too-long") {
    note({ step: "inline-assign", address, status: "truncated", detail: `literal over the ${MAX_LITERAL_BYTES} byte bound; not decoded` });
    return null;
  }
  if (end < 0) {
    note({ step: "inline-assign", address, status: "unparsed", detail: `unbalanced literal: ${quote(src.slice(at))}` });
    return null;
  }
  const text = src.slice(at, end);
  if (utf8Length(text) > MAX_LITERAL_BYTES) {
    note({ step: "inline-assign", address, status: "truncated", detail: `literal over the ${MAX_LITERAL_BYTES} byte bound; not decoded` });
    return end;
  }
  const parsed = parseTolerant(text);
  if (parsed === null) {
    note({ step: "inline-assign", address, status: "unparsed", detail: `not a JSON literal: ${quote(text)}` });
    return end;
  }
  nodes.push({ step: "inline-assign", address, root: address, value: parsed.value, text, span: [base + at, base + end] });
  return end;
}

// ------------------------------------------------------------ tolerant JSON

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const KEY_IDENT = /[A-Za-z_$][\w$]*/y;
const SIMPLE: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };

class Fail extends Error {}

/**
 * JSON plus: unquoted identifier keys, single-quoted strings (JavaScript
 * escapes), trailing commas in objects and arrays, `undefined` as null.
 * Null when the text is anything else. Never throws.
 */
export function parseTolerant(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    // fall through to the superset
  }
  const p = new TolerantParser(text);
  try {
    p.ws();
    const value = p.value(0);
    p.ws();
    if (p.i !== text.length) return null;
    return { value };
  } catch {
    return null; // Fail, or a RangeError from a pathological input
  }
}

class TolerantParser {
  i = 0;
  constructor(private readonly s: string) {}

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? "")) this.i++;
  }

  value(depth: number): unknown {
    if (depth > MAX_NESTING) throw new Fail();
    const c = this.s[this.i];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"' || c === "'") return this.string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
    KEY_IDENT.lastIndex = this.i;
    const m = KEY_IDENT.exec(this.s);
    if (m === null) throw new Fail();
    this.i += m[0].length;
    switch (m[0]) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
      case "undefined":
        return null;
      default:
        throw new Fail();
    }
  }

  private object(depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === "}") {
        this.i++;
        return out;
      }
      let key: string;
      if (c === '"' || c === "'") key = this.string();
      else {
        KEY_IDENT.lastIndex = this.i;
        const m = KEY_IDENT.exec(this.s);
        if (m === null) throw new Fail();
        key = m[0];
        this.i += key.length;
      }
      this.ws();
      if (this.s[this.i] !== ":") throw new Fail();
      this.i++;
      this.ws();
      const v = this.value(depth + 1);
      // defineProperty: a "__proto__" key is data, as in JSON.parse
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      this.ws();
      const sep = this.s[this.i];
      if (sep === ",") this.i++;
      else if (sep !== "}") throw new Fail();
    }
  }

  private array(depth: number): unknown[] {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value(depth + 1));
      this.ws();
      const sep = this.s[this.i];
      if (sep === ",") this.i++;
      else if (sep !== "]") throw new Fail();
    }
  }

  private number(): number {
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (m === null) throw new Fail();
    this.i += m[0].length;
    return Number(m[0]);
  }

  private string(): string {
    const q = this.s[this.i];
    let out = "";
    let j = this.i + 1;
    for (;;) {
      if (j >= this.s.length) throw new Fail();
      const c = this.s[j] ?? "";
      if (c === q) {
        this.i = j + 1;
        return out;
      }
      if (c === "\n" || c === "\r") throw new Fail();
      if (c !== "\\") {
        out += c;
        j++;
        continue;
      }
      const e = this.s[j + 1] ?? "";
      if (e === "u" && this.s[j + 2] === "{") {
        const close = this.s.indexOf("}", j + 3);
        const hex = close < 0 ? "" : this.s.slice(j + 3, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) throw new Fail();
        out += String.fromCodePoint(parseInt(hex, 16));
        j = close + 1;
      } else if (e === "u") {
        const hex = this.s.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Fail();
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
      } else if (e === "x") {
        const hex = this.s.slice(j + 2, j + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Fail();
        out += String.fromCharCode(parseInt(hex, 16));
        j += 4;
      } else if (e === "\r" && this.s[j + 2] === "\n") j += 3; // line continuation
      else if (e === "\n" || e === "\r" || e === " " || e === " ") j += 2;
      else {
        out += SIMPLE[e] ?? e;
        j += 2;
      }
    }
  }
}
