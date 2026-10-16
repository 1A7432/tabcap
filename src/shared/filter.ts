// Generic post-filters on a command's envelope `data` (0.5-C, owner 10-16):
// `--select <path>`, `--grep <regex>` (with `--context` / `--max-matches`)
// and `--fields a,b,c`. They run in the CLI output layer, after the command
// and before the output budget (src/shared/budget.ts), so every command gets
// them, the MCP `tabcap_run` tool included. Order: select → grep → fields.
// Arguments are untrusted: a bad path, regex or count is a `usage` error,
// never an exception out of the process.

import { TabcapError } from "./envelope.ts";
import { isRecord } from "./json.ts";

export const MAX_PATH_CHARS = 256;
export const MAX_PATH_SEGMENTS = 32;
export const MAX_REGEX_CHARS = 256;
export const DEFAULT_MAX_MATCHES = 50;
export const MAX_MATCHES_LIMIT = 1000;
export const MAX_CONTEXT = 20;
export const MAX_FIELDS = 32;
/** In an object, a string field is grepped line by line when it has a newline or is this long (paths and ids stay as they are). */
export const LONG_STRING = 1000;

export type PathSeg = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "all" };

export type FilterOptions = {
  select: string | null;
  grep: string | null;
  context: number;
  maxMatches: number;
  fields: string[] | null;
};

/** What the envelope records next to `data` (`filter:{…}`). */
export type FilterRecord = {
  select: string | null;
  grep: string | null;
  fields: string[] | null;
  /** Matching elements / lines (all of them, also past --max-matches); with only a wildcard --select: the selected count. */
  matches: number | null;
  /** Elements / lines --grep looked at. */
  total: number | null;
  /** More matches than --max-matches: only the first ones are kept. */
  capped: boolean;
};

export type LineHit = { line: number; text: string; match: boolean };

const usage = (message: string, next: string) => new TabcapError("usage", message, next);

/** True when any filter flag was given. */
export function hasFilters(o: FilterOptions): boolean {
  return o.select !== null || o.grep !== null || o.fields !== null;
}

/** `a.b[0].c`, `requests[*].url`, `[2]`: dotted keys, `[n]`, `[*]`. */
export function parsePath(path: string): PathSeg[] {
  const bad = (why: string) => usage(`--select ${JSON.stringify(path.slice(0, 80))}: ${why}`, "Use dotted keys, [n] and [*], e.g. --select requests[*].url or --select requests[0].headers");
  if (path.length === 0) throw bad("empty path");
  if (path.length > MAX_PATH_CHARS) throw bad(`longer than ${MAX_PATH_CHARS} characters`);
  const segs: PathSeg[] = [];
  let i = 0;
  let needKey = true; // at the start or right after "."
  while (i < path.length) {
    const ch = path[i];
    if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close < 0) throw bad("unclosed [");
      const inner = path.slice(i + 1, close);
      if (inner === "*") segs.push({ kind: "all" });
      else if (/^\d{1,9}$/.test(inner)) segs.push({ kind: "index", index: Number(inner) });
      else throw bad(`[${inner.slice(0, 20)}] is neither [n] nor [*]`);
      i = close + 1;
      needKey = false;
      continue;
    }
    if (ch === ".") {
      if (needKey) throw bad("empty key");
      i++;
      needKey = true;
      if (i >= path.length) throw bad("ends with .");
      continue;
    }
    if (!needKey) throw bad(`expected . or [ at position ${i}`);
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[" && path[j] !== "]" && !/\s/.test(path[j] ?? "")) j++;
    if (j === i) throw bad(`unexpected ${JSON.stringify(path[i])} at position ${i}`);
    segs.push({ kind: "key", key: path.slice(i, j) });
    i = j;
    needKey = false;
  }
  if (segs.length > MAX_PATH_SEGMENTS) throw bad(`more than ${MAX_PATH_SEGMENTS} segments`);
  return segs;
}

const segText = (s: PathSeg): string => (s.kind === "key" ? `.${s.key}` : s.kind === "index" ? `[${s.index}]` : "[*]");

function shapeHint(v: unknown): string {
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (isRecord(v)) {
    const keys = Object.keys(v);
    return `an object with keys ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", …" : ""}`;
  }
  return v === null ? "null" : `a ${typeof v}`;
}

/**
 * The sub-tree at `segs`. Without `[*]`: that one value, or a `not-found`
 * error naming what is there instead. With `[*]`: every match, as an array
 * (missing branches are skipped).
 */
export function selectPath(data: unknown, path: string, segs: readonly PathSeg[]): { value: unknown; count: number | null } {
  const wild = segs.some((s) => s.kind === "all");
  let nodes: unknown[] = [data];
  let at = "";
  for (const s of segs) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (s.kind === "key") {
        if (isRecord(n) && Object.hasOwn(n, s.key)) next.push(n[s.key]);
        else if (!wild) throw new TabcapError("not-found", `--select ${path}: no key ${JSON.stringify(s.key)} at ${at === "" ? "data" : at.replace(/^\./, "")} (it is ${shapeHint(n)})`, "Fix the path, or run the command without --select to see the whole answer.");
      } else if (s.kind === "index") {
        if (Array.isArray(n) && s.index < n.length) next.push(n[s.index]);
        else if (!wild) throw new TabcapError("not-found", `--select ${path}: no element [${s.index}] at ${at === "" ? "data" : at.replace(/^\./, "")} (it is ${shapeHint(n)})`, "Fix the path, or run the command without --select to see the whole answer.");
      } else if (Array.isArray(n)) next.push(...n);
      else if (isRecord(n)) next.push(...Object.values(n));
    }
    nodes = next;
    at += segText(s);
  }
  return wild ? { value: nodes, count: nodes.length } : { value: nodes[0], count: null };
}

/** `--grep`: a `u`-flag regex of at most 256 characters; a bad one is a usage error. */
export function compileGrep(src: string): RegExp {
  if (src.length === 0) throw usage("--grep needs a non-empty regular expression", "e.g. --grep /api/ or --grep 'token|csrf'");
  if (src.length > MAX_REGEX_CHARS) throw usage(`--grep: the regular expression is longer than ${MAX_REGEX_CHARS} characters`, "Use a shorter expression; combine with --select to narrow the input instead.");
  try {
    return new RegExp(src, "u");
  } catch (e) {
    throw usage(`--grep: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`, "Escape special characters (\\. \\( \\[), or use a plain substring.");
  }
}

function test(re: RegExp, s: string): boolean {
  try {
    re.lastIndex = 0;
    return re.test(s);
  } catch {
    return false;
  }
}

const elementText = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
};

type Budget = { left: number; matches: number; total: number; capped: boolean };

function grepArray(items: readonly unknown[], re: RegExp, b: Budget): unknown[] {
  const kept: unknown[] = [];
  for (const it of items) {
    b.total++;
    if (!test(re, elementText(it))) continue;
    b.matches++;
    if (b.left > 0) {
      kept.push(it);
      b.left--;
    } else b.capped = true;
  }
  return kept;
}

/** Matching lines (1-based `line`) with `context` lines around each; context lines have `match:false`. */
export function grepLines(text: string, re: RegExp, context: number, b: Budget): LineHit[] {
  const lines = text.split(/\r?\n/);
  const keep = new Map<number, boolean>();
  for (let i = 0; i < lines.length; i++) {
    b.total++;
    if (!test(re, lines[i] ?? "")) continue;
    b.matches++;
    if (b.left <= 0) {
      b.capped = true;
      continue;
    }
    b.left--;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) if (!keep.get(k)) keep.set(k, k === i);
  }
  return [...keep.keys()].sort((x, y) => x - y).map((i) => ({ line: i + 1, text: lines[i] ?? "", match: keep.get(i) === true }));
}

function grepValue(v: unknown, re: RegExp, context: number, b: Budget, top: boolean): unknown {
  if (Array.isArray(v)) return grepArray(v, re, b);
  if (typeof v === "string") return grepLines(v, re, context, b);
  if (top && isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (Array.isArray(x)) out[k] = grepArray(x, re, b);
      else if (typeof x === "string" && (x.length >= LONG_STRING || x.includes("\n"))) out[k] = grepLines(x, re, context, b);
      else out[k] = x;
    }
    return out;
  }
  b.total++;
  if (test(re, elementText(v))) {
    b.matches++;
    return v;
  }
  return null;
}

/** `--fields a,b,c`: at most 32 top-level keys. */
export function parseFields(s: string): string[] {
  const fields = s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (fields.length === 0) throw usage("--fields needs a comma list of keys", "e.g. --fields id,method,url");
  if (fields.length > MAX_FIELDS) throw usage(`--fields: more than ${MAX_FIELDS} keys`, "Name fewer keys.");
  if (fields.some((f) => f.length > 64)) throw usage("--fields: a key is longer than 64 characters", "Name the top-level keys of the elements, e.g. --fields id,url");
  return [...new Set(fields)];
}

const pick = (v: unknown, fields: readonly string[]): unknown => {
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (Object.hasOwn(v, f)) out[f] = v[f];
  return out;
};

/**
 * Project array elements to `fields`: the array itself, or every array field
 * of an object; an object without array fields is projected itself.
 */
export function projectFields(v: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => pick(x, fields));
  if (!isRecord(v)) return v;
  const arrays = Object.entries(v).filter(([, x]) => Array.isArray(x));
  if (arrays.length === 0) return pick(v, fields);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = Array.isArray(x) ? x.map((e) => pick(e, fields)) : x;
  return out;
}

/** Validate the numbers once (they come from argv as strings or numbers). */
export function filterOptions(raw: { select?: string | undefined; grep?: string | undefined; context?: string | undefined; maxMatches?: string | undefined; fields?: string | undefined }): FilterOptions {
  const int = (name: string, v: string | undefined, dflt: number, min: number, max: number): number => {
    if (v === undefined) return dflt;
    if (!/^\d{1,9}$/.test(v)) throw usage(`${name} must be a whole number`, `e.g. ${name} ${dflt === 0 ? 2 : dflt}`);
    const n = Number(v);
    if (n < min || n > max) throw usage(`${name} must be between ${min} and ${max}`, `e.g. ${name} ${Math.min(max, Math.max(min, dflt === 0 ? 2 : dflt))}`);
    return n;
  };
  const o: FilterOptions = {
    select: raw.select ?? null,
    grep: raw.grep ?? null,
    context: int("--context", raw.context, 0, 0, MAX_CONTEXT),
    maxMatches: int("--max-matches", raw.maxMatches, DEFAULT_MAX_MATCHES, 1, MAX_MATCHES_LIMIT),
    fields: raw.fields === undefined ? null : parseFields(raw.fields),
  };
  if (o.grep === null && (raw.context !== undefined || raw.maxMatches !== undefined)) throw usage("--context and --max-matches go with --grep", "e.g. --grep token --context 2");
  return o;
}

/** select → grep → fields over `data`. */
export function applyFilters(data: unknown, o: FilterOptions): { data: unknown; filter: FilterRecord } {
  let v = data;
  let matches: number | null = null;
  let total: number | null = null;
  let capped = false;
  if (o.select !== null) {
    const r = selectPath(v, o.select, parsePath(o.select));
    v = r.value;
    matches = r.count;
  }
  if (o.grep !== null) {
    const re = compileGrep(o.grep);
    const b: Budget = { left: o.maxMatches, matches: 0, total: 0, capped: false };
    v = grepValue(v, re, o.context, b, true);
    matches = b.matches;
    total = b.total;
    capped = b.capped;
  }
  if (o.fields !== null) v = projectFields(v, o.fields);
  return { data: v, filter: { select: o.select, grep: o.grep, fields: o.fields, matches, total, capped } };
}
