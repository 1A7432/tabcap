// 0.5-F: read only what is needed of recorded bodies.
//   net body <id> --grep <re> [--context 3] [--max-matches 50]
//   net body <id> --lines a-b
//   net body <id>|--url <u> --at line:col [--context 5]
//   net body … --pretty            (JS / JSON bodies ≤ 8 MB)
//   net grep <re> [--resource-types …] [--max-matches 20] [--context 1] [--pretty]
// Bodies are the bundle's blobs: CDP hands them over decompressed; text is
// decoded as UTF-8, else with the response charset. Every text is passed
// through the known-secret substitution before it is searched or sliced, so
// a pattern never finds, and a slice never shows, a stored secret. Read-only:
// nothing is written to the bundle (the daemon's `cmd` events aside).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "../../bundle/blobs.ts";
import { EVENTS_FILE } from "../../bundle/manifest.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { isTextMime } from "../capture/cdpnet.ts";
import type { NetEntry } from "../capture/recorder.ts";
import type { Daemon } from "../state.ts";
import { optBool, optNum, optStr, type Args } from "./args.ts";
import { findRequestEvent } from "./netshow.ts";
import { mapOffset, prettyJs, prettyJson, prettyKind, PRETTY_MAX_BYTES } from "./pretty.ts";
import { around, clampInt, compileRegex, grepLines, lineRange, lineStarts, offsetOf, parsePos, parseRange, posOf, splitLines, type LineMatch } from "./textsearch.ts";

/** Bodies over this size are skipped by `net grep` (listed under `skipped`). */
export const GREP_MAX_BYTES = 8 * 1024 * 1024;
/** `net grep` lists at most this many requests (`more` counts the rest). */
export const GREP_MAX_REQUESTS = 50;

/** A TextDecoder for any WHATWG encoding label known at run time (bun-types narrows the label; an unknown one throws RangeError). */
function labelDecoder(label: string): TextDecoder {
  const dec: unknown = Reflect.construct(TextDecoder, [label, { fatal: false }]);
  if (!(dec instanceof TextDecoder)) throw new RangeError(`no decoder for ${label}`);
  return dec;
}

/** Decoded text of a body, or null for binary data. */
export function decodeBody(bytes: Uint8Array, mime: string | null, charset: () => string | null): string | null {
  if (bytes.length === 0) return "";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Valid UTF-8 with NULs early on is binary (images, fonts) unless the MIME type says text.
    if (!isTextMime(mime) && text.slice(0, 1024).includes("\u0000")) return null;
    return text;
  } catch {
    // not UTF-8: the response charset (Fetch-paused bodies are the server's bytes), else binary
  }
  const cs = charset();
  if (cs !== null && cs !== "utf-8" && cs !== "utf8") {
    try {
      return labelDecoder(cs).decode(bytes);
    } catch {
      // a charset label TextDecoder does not know
    }
  }
  return isTextMime(mime) || prettyKind(mime, null) !== null ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
}

export type Prettied = { text: string; pretty: boolean; js: ReturnType<typeof prettyJs> | null; note: string | null };

/** `--pretty`: JS / JSON bodies up to 8 MB; otherwise the text unchanged and why. */
export function prettify(text: string, bytes: number, mime: string | null, resourceType: string | null): Prettied {
  const kind = prettyKind(mime, resourceType);
  if (kind === null) return { text, pretty: false, js: null, note: `--pretty applies to JavaScript and JSON bodies; this one is ${mime ?? "of unknown type"}` };
  if (bytes > PRETTY_MAX_BYTES) return { text, pretty: false, js: null, note: `not prettified: ${bytes} bytes is over the 8 MB limit` };
  if (kind === "json") {
    const j = prettyJson(text);
    return j === null ? { text, pretty: false, js: null, note: "not prettified: the body is not valid JSON" } : { text: j, pretty: true, js: null, note: null };
  }
  const js = prettyJs(text);
  return { text: js.text, pretty: true, js, note: null };
}

export type BodySearch =
  | { mode: "grep"; re: RegExp; source: string; context: number; max: number }
  | { mode: "lines"; from: number; to: number }
  | { mode: "at"; line: number; col: number; context: number }
  | { mode: "preview" };

/** The search flags of `net body`; null when none is given (the 0.3-F answer, unchanged). */
export function bodySearchOf(a: Args): { search: BodySearch; pretty: boolean } | null {
  const grep = optStr(a, "grep");
  const lines = optStr(a, "lines");
  const at = optStr(a, "at");
  const pretty = optBool(a, "pretty");
  const given = [grep, lines, at].filter((x) => x !== null).length;
  if (given > 1) throw new TabcapError("usage", "give one of --grep, --lines and --at", "e.g. tabcap net body r-12 --grep token, --lines 1-80 or --at 1:20345");
  const context = optNum(a, "context");
  if (grep !== null) {
    return { search: { mode: "grep", re: compileRegex(grep, "--grep", true), source: grep, context: clampInt(context, 3, 50), max: Math.max(1, clampInt(optNum(a, "maxMatches"), 50, 1000)) }, pretty };
  }
  if (lines !== null) {
    const [from, to] = parseRange(lines);
    return { search: { mode: "lines", from, to }, pretty };
  }
  if (at !== null) {
    const [line, col] = parsePos(at);
    return { search: { mode: "at", line, col, context: clampInt(context, 5, 100) }, pretty };
  }
  if (pretty) return { search: { mode: "preview" }, pretty };
  return null;
}

/** charset of a request's response from events.jsonl (read only when a body is not UTF-8). */
export function charsetOf(dir: string, id: string): string | null {
  const ev = findRequestEvent(dir, id);
  const resp = ev !== null && isRecord(ev["response"]) ? ev["response"] : null;
  return resp === null ? null : str(resp, "charset");
}

/** Every request's response charset, one pass over events.jsonl (untrusted lines are skipped). */
function charsets(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(dir, EVENTS_FILE);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"kind":"request"') || !line.includes('"charset"')) continue;
    try {
      const ev: unknown = JSON.parse(line);
      if (!isRecord(ev) || typeof ev["id"] !== "string" || !isRecord(ev["response"])) continue;
      const cs = str(ev["response"], "charset");
      if (cs !== null) out.set(ev["id"], cs);
    } catch {
      // a torn last line while recording
    }
  }
  return out;
}

/** Run a `net body` search on a decoded, scrubbed body. `base` is the identity part of the answer. */
export function searchBody(base: Record<string, unknown>, text: string, bytes: number, mime: string | null, resourceType: string | null, s: { search: BodySearch; pretty: boolean }): Record<string, unknown> {
  const p = s.pretty ? prettify(text, bytes, mime, resourceType) : { text, pretty: false, js: null, note: null };
  const lines = splitLines(p.text);
  const notes: string[] = p.note === null ? [] : [p.note];
  const head = { ...base, mime, bytes, lines: lines.length, pretty: p.pretty };
  const q = s.search;
  if (q.mode === "grep") {
    const r = grepLines(lines, q.re, q.context, q.max);
    if (r.total > r.matches.length) notes.push(`${r.total - r.matches.length} more match(es): raise --max-matches (max 1000), narrow the pattern, or read a range with --lines`);
    if (r.matches.some((m) => m.clip !== undefined)) notes.push("long lines are shown as a 500-char window (clip.from is its first column); --pretty breaks minified JavaScript / JSON into lines");
    return { ...head, regex: q.source, total: r.total, shown: r.matches.length, truncated: r.total > r.matches.length, matches: r.matches, ...noteOf(notes) };
  }
  if (q.mode === "lines") {
    if (q.from > lines.length) throw new TabcapError("usage", `--lines ${q.from}-${q.to}: the body has ${lines.length} line(s)`, `Ask for a range within 1-${lines.length}.`);
    const r = lineRange(lines, q.from, q.to);
    if (r.more !== null) notes.push(`at most 500 lines per call; more: ${r.more}`);
    if (r.clipped > 0) notes.push(`${r.clipped} line(s) over 500 chars were clipped; use --at line:col for a window anywhere in a line, or --pretty`);
    return { ...head, from: r.from, to: r.to, content: r.content, truncated: r.more !== null || r.clipped > 0, ...noteOf(notes) };
  }
  if (q.mode === "at") {
    // Positions come from the raw body (trace list, console stacks); with --pretty they are mapped into the pretty text.
    let at: LineMatch & { raw?: { line: number; col: number } };
    if (p.pretty && p.js !== null) {
      const rawStarts = lineStarts(text);
      if (q.line > rawStarts.length) throw new TabcapError("usage", `--at ${q.line}:${q.col}: the body has ${rawStarts.length} line(s)`, `Give a line within 1-${rawStarts.length}.`);
      const [pl, pc] = posOf(lineStarts(p.text), mapOffset(p.js, offsetOf(rawStarts, text, q.line, q.col)));
      at = { ...around(lines, pl, pc, q.context), raw: { line: q.line, col: q.col } };
    } else {
      if (p.pretty) notes.push("--at positions are raw-body positions; the JSON was re-serialised, so the raw text is shown");
      const raw = p.pretty ? splitLines(text) : lines;
      if (q.line > raw.length) throw new TabcapError("usage", `--at ${q.line}:${q.col}: the body has ${raw.length} line(s)`, `Give a line within 1-${raw.length}.`);
      at = around(raw, q.line, q.col, q.context);
      if (p.pretty) return { ...head, pretty: false, lines: raw.length, at, ...noteOf(notes) };
    }
    return { ...head, at, ...noteOf(notes) };
  }
  return { ...head, ...noteOf(notes) };
}

const noteOf = (notes: string[]) => (notes.length > 0 ? { note: notes.join("; ") } : {});

/** The request a `--url` names: the last one with a stored body whose URL equals it (fragment ignored). */
export function requestByUrl(index: readonly NetEntry[], url: string): { entry: NetEntry; count: number } | null {
  const strip = (u: string) => {
    const h = u.indexOf("#");
    return h < 0 ? u : u.slice(0, h);
  };
  const want = strip(url);
  const all = index.filter((e) => strip(e.url) === want);
  const withBody = all.filter((e) => e.blob !== null);
  const entry = withBody[withBody.length - 1] ?? all[all.length - 1];
  return entry === undefined ? null : { entry, count: all.length };
}

export type GrepRow = { id: string; url: string; resourceType: string; count: number; matches: LineMatch[] };

/** `net grep`: pure core over (entry, bytes) pairs, for tests and the tool. */
export function grepBodies(
  items: ReadonlyArray<{ entry: NetEntry; bytes: () => Uint8Array | null }>,
  re: RegExp,
  o: { context: number; max: number; pretty: boolean; scrub: (s: string) => string; charset: (id: string) => string | null },
): { searched: number; requests: GrepRow[]; more: number; total: number; skipped: Array<{ id: string; url: string; bytes: number; reason: string }>; binary: number } {
  const rows: GrepRow[] = [];
  const skipped: Array<{ id: string; url: string; bytes: number; reason: string }> = [];
  let searched = 0;
  let binary = 0;
  let more = 0;
  let total = 0;
  for (const { entry, bytes } of items) {
    const size = entry.size ?? 0;
    if (size > GREP_MAX_BYTES) {
      skipped.push({ id: entry.id, url: entry.url, bytes: size, reason: "over 8 MB" });
      continue;
    }
    const b = bytes();
    if (b === null) continue;
    if (b.length > GREP_MAX_BYTES) {
      skipped.push({ id: entry.id, url: entry.url, bytes: b.length, reason: "over 8 MB" });
      continue;
    }
    const decoded = decodeBody(b, entry.mime, () => o.charset(entry.id));
    if (decoded === null) {
      binary++;
      continue;
    }
    searched++;
    let text = o.scrub(decoded);
    if (o.pretty && prettyKind(entry.mime, entry.type) !== null) text = prettify(text, b.length, entry.mime, entry.type).text;
    const r = grepLines(splitLines(text), re, o.context, o.max);
    if (r.total === 0) continue;
    total += r.total;
    if (rows.length >= GREP_MAX_REQUESTS) {
      more++;
      continue;
    }
    rows.push({ id: entry.id, url: entry.url, resourceType: entry.type, count: r.total, matches: r.matches });
  }
  return { searched, requests: rows, more, total, skipped, binary };
}

type Recorded = { dir: string; index: NetEntry[]; recording: boolean };

/** `tabcap net grep <regex>` over every recorded response body of the session. */
export function netGrep(d: Daemon, a: Args, session: string, rec: Recorded): unknown {
  const source = optStr(a, "regex") ?? "";
  const re = compileRegex(source, "net grep", true);
  const types = optStr(a, "types")
    ?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  const context = clampInt(optNum(a, "context"), 1, 20);
  const max = Math.max(1, clampInt(optNum(a, "maxMatches"), 20, 200));
  const pretty = optBool(a, "pretty");
  const store = new BlobStore(rec.dir);
  let cs: Map<string, string> | null = null;
  const pool = rec.index.filter((e) => e.blob !== null && (types === undefined || types.length === 0 || types.includes(e.type)));
  const r = grepBodies(
    pool.map((entry) => ({ entry, bytes: () => (entry.blob === null ? null : store.tryRead(entry.blob)) })),
    re,
    {
      context,
      max,
      pretty,
      scrub: (s) => d.secrets.scrub(s),
      charset: (id) => {
        cs ??= charsets(rec.dir);
        return cs.get(id) ?? null;
      },
    },
  );
  const notes: string[] = [];
  if (r.more > 0) notes.push(`${r.more} more request(s) with matches: narrow with --resource-types or a more specific pattern, or search one body with \`net body <id> --grep\``);
  if (r.requests.some((x) => x.count > x.matches.length)) notes.push("per request at most --max-matches matches are shown (count has them all); `net body <id> --grep` pages one body");
  if (r.skipped.length > 0) notes.push(`${r.skipped.length} body(ies) over 8 MB skipped: search them one at a time with \`net body <id> --grep\``);
  return {
    session,
    bundle: rec.dir,
    recording: rec.recording,
    regex: source,
    pretty,
    bodies: pool.length,
    searched: r.searched,
    binary: r.binary,
    total: r.total,
    requests: r.requests,
    more: r.more,
    skipped: r.skipped,
    ...noteOf(notes),
  };
}
