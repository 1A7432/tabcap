// Line-based search over text (0.5-F): `net body --grep / --lines / --at`,
// `net grep`, and the regex rules `snapshot --grep` shares. Pure functions.
// Lines are split on "\n" (a trailing "\r" is dropped); lines and columns are
// 1-based, columns in UTF-16 code units (what V8 reports in stack frames and
// `trace list`). Long lines (minified code) are clipped to a window of
// LINE_MAX chars around the position, and the clip is said.

import { TabcapError } from "../../shared/envelope.ts";

export const REGEX_MAX = 256;
/** Chars of one line in an answer; longer lines are clipped (a window around a match / position). */
export const LINE_MAX = 500;
/** `--lines a-b`: at most this many lines per call. */
export const RANGE_MAX = 500;

/** A user regex (≤ 256 chars, `u` flag); invalid → `usage`. `global` for matchAll. */
export function compileRegex(src: string, flag: string, global = false): RegExp {
  if (src === "") throw new TabcapError("usage", `${flag} needs a pattern`, `e.g. ${flag} 'token|csrf'`);
  if (src.length > REGEX_MAX) throw new TabcapError("usage", `${flag} pattern is ${src.length} chars; at most ${REGEX_MAX}`, "Use a shorter pattern.");
  try {
    return new RegExp(src, global ? "gu" : "u");
  } catch (e) {
    throw new TabcapError("usage", `${flag}: invalid regular expression: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, "Patterns are JavaScript regular expressions with the u flag; escape ( [ { . * + ? ^ $ | \\ to match them literally.");
  }
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.endsWith("\r")) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/** Never cut a surrogate pair: move a cut index off the low half. */
function safeCut(s: string, i: number): number {
  if (i <= 0 || i >= s.length) return Math.max(0, Math.min(i, s.length));
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

/** A context line: whole when short, else its first LINE_MAX chars and "…". */
export function clipLine(s: string): string {
  return s.length <= LINE_MAX ? s : `${s.slice(0, safeCut(s, LINE_MAX))}…`;
}

export type Clip = { from: number; chars: number };

/** A LINE_MAX window of the line around 0-based column `col0` (length `len`), with "…" where cut. */
export function windowAt(s: string, col0: number, len = 0): { text: string; clip: Clip | null } {
  if (s.length <= LINE_MAX) return { text: s, clip: null };
  const span = Math.min(Math.max(len, 0), LINE_MAX);
  let from = Math.max(0, col0 - Math.floor((LINE_MAX - span) / 2));
  from = safeCut(s, Math.min(from, s.length - LINE_MAX));
  const to = safeCut(s, Math.min(s.length, from + LINE_MAX));
  return { text: `${from > 0 ? "…" : ""}${s.slice(from, to)}${to < s.length ? "…" : ""}`, clip: { from: from + 1, chars: s.length } };
}

export type LineMatch = { line: number; col: number; text: string; before: string[]; after: string[]; clip?: Clip };

function contextOf(lines: readonly string[], idx: number, context: number): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (let k = Math.max(0, idx - context); k < idx; k++) before.push(clipLine(lines[k] ?? ""));
  for (let k = idx + 1; k <= Math.min(lines.length - 1, idx + context); k++) after.push(clipLine(lines[k] ?? ""));
  return { before, after };
}

/** Every occurrence of `re` (a `g` + `u` regex), line by line; `total` counts all, `matches` keeps the first `max`. */
export function grepLines(lines: readonly string[], re: RegExp, context: number, max: number): { total: number; matches: LineMatch[] } {
  const matches: LineMatch[] = [];
  let total = 0;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(g)) {
      total++;
      if (matches.length >= max) continue;
      const col0 = m.index;
      const w = windowAt(line, col0, m[0].length);
      matches.push({ line: i + 1, col: col0 + 1, text: w.text, ...contextOf(lines, i, context), ...(w.clip === null ? {} : { clip: w.clip }) });
    }
  }
  return { total, matches };
}

/** `a-b` (1-based, inclusive) → [a, b]; a single number is one line. */
export function parseRange(spec: string): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec);
  const a = m === null ? NaN : Number(m[1]);
  const b = m === null ? NaN : m[2] === undefined ? a : Number(m[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) throw new TabcapError("usage", `--lines ${spec}?`, "Give a 1-based inclusive range, e.g. --lines 120-180 (at most 500 lines per call).");
  return [a, b];
}

export type LineRange = { from: number; to: number; content: Array<{ line: number; text: string }>; clipped: number; more: string | null };

/** Lines a..b (capped at RANGE_MAX); `more` is the next range to ask for, or null. */
export function lineRange(lines: readonly string[], a: number, b: number): LineRange {
  const to = Math.min(b, a + RANGE_MAX - 1, lines.length);
  const content: Array<{ line: number; text: string }> = [];
  let clipped = 0;
  for (let k = a; k <= to; k++) {
    const s = lines[k - 1] ?? "";
    if (s.length > LINE_MAX) clipped++;
    content.push({ line: k, text: clipLine(s) });
  }
  const wanted = Math.min(b, lines.length);
  return { from: a, to: Math.max(to, a - 1), content, clipped, more: to < wanted ? `--lines ${to + 1}-${Math.min(wanted, to + RANGE_MAX)}` : null };
}

/** `L:C` (1-based) → [line, col]. */
export function parsePos(spec: string): [number, number] {
  const m = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(spec);
  const line = m === null ? NaN : Number(m[1]);
  const col = m === null || m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(col) || line < 1 || col < 1) throw new TabcapError("usage", `--at ${spec}?`, "Give a 1-based line:col, as `trace list` and console stack frames print it, e.g. --at 1:20345.");
  return [line, col];
}

/** The lines around a 1-based position: the position's line windowed around the column. */
export function around(lines: readonly string[], line: number, col: number, context: number): LineMatch {
  const idx = line - 1;
  const s = lines[idx] ?? "";
  const w = windowAt(s, col - 1, 1);
  return { line, col, text: w.text, ...contextOf(lines, idx, context), ...(w.clip === null ? {} : { clip: w.clip }) };
}

/** 0-based offsets where each line starts (split on "\n", as splitLines). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line:col → 0-based offset (clamped to the line). */
export function offsetOf(starts: readonly number[], text: string, line: number, col: number): number {
  const s = starts[Math.min(line, starts.length) - 1] ?? 0;
  const next = starts[line] ?? text.length + 1;
  return Math.min(s + col - 1, Math.max(s, next - 1));
}

/** 0-based offset → 1-based line:col. */
export function posOf(starts: readonly number[], off: number): [number, number] {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((starts[mid] ?? 0) <= off) lo = mid;
    else hi = mid - 1;
  }
  return [lo + 1, off - (starts[lo] ?? 0) + 1];
}

/** Bounded non-negative integer flag value. */
export function clampInt(v: number | null, dflt: number, max: number): number {
  if (v === null) return dflt;
  return Math.max(0, Math.min(Math.floor(v), max));
}
