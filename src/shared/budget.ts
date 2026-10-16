// Output budget (0.5-C, owner 10-16): when the serialised `data` of a command
// is larger than TABCAP_OUTPUT_LIMIT bytes (default 16384), the whole `data`
// goes to a file and the envelope carries `{summary, file, bytes, truncated}`
// instead, so one answer cannot flood an agent's context. `--full` prints
// everything. The file lands in the current recording's bundle
// (`exports/<command>-<seq>.json`) or, when nothing records,
// `<cache>/outputs/<stamp>-<command>.json`; 0600 in 0700 directories like the
// rest of the bundle (docs/04 §17). Paginated lists and `snapshot` have their
// own limits and are exempt.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "./envelope.ts";
import { envVar } from "./env.ts";
import { isRecord } from "./json.ts";
import { compactStamp } from "./time.ts";

export const OUTPUT_LIMIT_DEFAULT = 16_384;
/** Commands with their own size mechanism (pages, --max-chars), and `schema`: the CLI contract is printed whole (owner: schema unchanged). */
export const BUDGET_EXEMPT: ReadonlySet<string> = new Set(["net list", "console list", "snapshot", "schema"]);
/** Strings longer than this count as bulk in the generic summary (replaced by their length). */
export const SUMMARY_STRING_MAX = 200;
const WHERE_TOP = 5;

/** TABCAP_OUTPUT_LIMIT: a whole number of bytes; 0 turns the budget off; anything else falls back to the default. */
export function outputLimit(env: Record<string, string | undefined> = process.env): number {
  const v = envVar("OUTPUT_LIMIT", env);
  if (v === undefined || !/^\d{1,12}$/.test(v.trim())) return OUTPUT_LIMIT_DEFAULT;
  const n = Number(v.trim());
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

const isScalar = (v: unknown): boolean => v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= SUMMARY_STRING_MAX);

const sizeOf = (v: unknown): number => (Array.isArray(v) ? v.length : isRecord(v) ? Object.keys(v).length : typeof v === "string" ? v.length : 0);

/** Every scalar top-level field as is; every array / object (and long string) by its length. */
export function genericSummary(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return { type: Array.isArray(data) ? "array" : typeof data, length: sizeOf(data) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = isScalar(v) ? v : sizeOf(v);
  return out;
}

const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** `analyze deps`: inputs per request and the unresolved count. */
function depsSummary(data: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, number> = {};
  for (const r of recs(data["requests"])) if (typeof r["id"] === "string") inputs[r["id"]] = Array.isArray(r["inputs"]) ? r["inputs"].length : 0;
  return { inputs, unresolved: Array.isArray(data["unresolved"]) ? data["unresolved"].length : 0 };
}

/** `recon` / `analyze recon`: the dossier's own summary block. */
function reconSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { ...(isRecord(data["summary"]) ? { summary: data["summary"] } : {}), ...(isRecord(data["page"]) ? { page: data["page"] } : {}) };
}

/** `trace list`: reads per API × script. */
function traceSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { rows: recs(data["rows"]).map((r) => ({ api: r["api"], script: r["script"], count: r["count"] })), ...(isRecord(data["totals"]) ? { totals: data["totals"] } : {}) };
}

/** `where`: the five best candidates. */
function whereSummary(data: Record<string, unknown>): Record<string, unknown> {
  const all = recs(data["candidates"]);
  return { candidates: all.slice(0, WHERE_TOP), candidateCount: all.length, ...(isRecord(data["query"]) ? { query: data["query"] } : {}) };
}

const CUSTOM: Record<string, (d: Record<string, unknown>) => Record<string, unknown>> = {
  "analyze deps": depsSummary,
  recon: reconSummary,
  "analyze recon": reconSummary,
  "trace list": traceSummary,
  where: whereSummary,
};

/** The summary that replaces an over-budget `data`: generic, overlaid by the command's own one. */
export function summaryOf(command: string, data: unknown): Record<string, unknown> {
  const base = genericSummary(data);
  const custom = CUSTOM[command];
  return custom !== undefined && isRecord(data) ? { ...base, ...custom(data) } : base;
}

/** `analyze deps` → `analyze-deps` (file names). */
export const commandSlug = (command: string): string => command.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "output";

function writeNew(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if (isRecord(e) && e["code"] === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Write `text` as the next `exports/<slug>-<seq>.json` of a bundle (seq: one
 * more than the highest one there, from 1) or as
 * `<cacheDir>/outputs/<stamp>-<slug>.json` (`-2`, `-3` … on a clash).
 */
export function writeOutputFile(where: { bundle: string } | { cache: string }, command: string, text: string, now: number = Date.now()): string {
  const slug = commandSlug(command);
  if ("bundle" in where) {
    const dir = join(where.bundle, "exports");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const re = new RegExp(`^${slug}-(\\d+)\\.json$`);
    let seq = readdirSync(dir).reduce((m, n) => Math.max(m, Number(re.exec(n)?.[1] ?? 0)), 0) + 1;
    for (let tries = 0; tries < 50; tries++, seq++) {
      const p = join(dir, `${slug}-${seq}.json`);
      if (writeNew(p, text)) return p;
    }
    throw new TabcapError("io", `could not pick a free exports/${slug}-<seq>.json in ${dir}`, "Rerun with --full to print the whole answer instead.");
  }
  const dir = join(where.cache, "outputs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${compactStamp(now)}-${slug}`;
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, n === 1 ? `${base}.json` : `${base}-${n}.json`);
    if (!existsSync(p) && writeNew(p, text)) return p;
  }
  throw new TabcapError("io", `could not pick a free ${base}.json in ${dir}`, "Rerun with --full to print the whole answer instead.");
}

export type Budgeted = { summary: Record<string, unknown>; file: string; bytes: number; truncated: true };

/** The summary + file form of an over-budget answer. */
export function isBudgeted(v: unknown): v is Budgeted {
  return isRecord(v) && v["truncated"] === true && typeof v["file"] === "string" && typeof v["bytes"] === "number" && isRecord(v["summary"]) && Object.keys(v).length === 4;
}

export type BudgetOptions = {
  limit: number;
  full: boolean;
  /** Where the file goes; only asked when the data is over the limit. */
  target: () => Promise<{ bundle: string } | { cache: string }>;
  now?: number;
};

/** `data` as it is when it fits (or --full, or an exempt command); else the summary + file form. */
export async function applyBudget(command: string, data: unknown, o: BudgetOptions): Promise<unknown | Budgeted> {
  if (o.full || BUDGET_EXEMPT.has(command) || data === undefined) return data;
  const text = JSON.stringify(data);
  if (text === undefined) return data;
  const bytes = Buffer.byteLength(text);
  if (bytes <= o.limit) return data;
  let file: string;
  try {
    file = writeOutputFile(await o.target(), command, JSON.stringify(data, null, 2) + "\n", o.now);
  } catch (e) {
    if (e instanceof TabcapError) throw e;
    throw new TabcapError("io", `the answer is ${bytes} bytes (over TABCAP_OUTPUT_LIMIT ${o.limit}) and could not be written to a file: ${e instanceof Error ? e.message : String(e)}`, "Rerun with --full to print the whole answer, or narrow it with --select / --grep / --fields.");
  }
  return { summary: summaryOf(command, data), file, bytes, truncated: true };
}
