// Output budget (0.5-C, owner 10-16): when the serialised `data` of a command
// is larger than TABCAP_OUTPUT_LIMIT bytes (default 16384), the whole `data`
// goes to a file and the envelope carries `{summary, file, bytes, truncated}`
// instead, so one answer cannot flood an agent's context. `--full` prints
// everything. The file lands in the current recording's bundle
// (`exports/<command>-<seq>.json`) or, when nothing records,
// `<cache>/outputs/<stamp>-<command>.json`; 0600 in 0700 directories like the
// rest of the bundle (docs/04 §17). Paginated lists and `snapshot` have their
// own limits and are exempt. 0.7-C: every command whose answer can pass the
// limit has its own summary — the key counts and the first few ids / keys —
// never only lengths (an agent must be able to pick the next step from it).

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
/** How many ids / keys / rows a command summary lists (0.7-C); the counts say how many there are. */
export const SUMMARY_FIRST = 10;

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
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
/** The first SUMMARY_FIRST rows of a list, each cut to `keys` (absent keys left out). */
function firstRows(v: unknown, keys: readonly string[], n: number = SUMMARY_FIRST): Record<string, unknown>[] {
  return recs(v)
    .slice(0, n)
    .map((r) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, isScalar(r[k]) ? r[k] : sizeOf(r[k])])));
}
/** The first SUMMARY_FIRST values of one key of a list's rows. */
const firstOf = (v: unknown, key: string, n: number = SUMMARY_FIRST): unknown[] => recs(v).slice(0, n).map((r) => r[key]);
/** The first SUMMARY_FIRST keys of an object (header names, …). */
const firstKeys = (v: unknown, n: number = SUMMARY_FIRST): string[] => Object.keys(rec(v)).slice(0, n);

/** `analyze deps`: requests and inputs counted, the first requests with their input counts. */
function depsSummary(data: Record<string, unknown>): Record<string, unknown> {
  const reqs = recs(data["requests"]);
  const inputs: Record<string, number> = {};
  for (const r of reqs.slice(0, SUMMARY_FIRST)) if (typeof r["id"] === "string") inputs[r["id"]] = len(r["inputs"]);
  return { requests: reqs.length, inputCount: reqs.reduce((n, r) => n + len(r["inputs"]), 0), inputs, edges: len(data["edges"]), unresolved: len(data["unresolved"]), unresolvedFirst: firstRows(data["unresolved"], ["request", "location", "name"]) };
}

/** `recon` / `analyze recon`: the dossier's own summary block. */
function reconSummary(data: Record<string, unknown>): Record<string, unknown> {
  const page = rec(data["page"]);
  return { ...(isRecord(data["summary"]) ? { summary: data["summary"] } : {}), ...(isRecord(data["page"]) ? { page: { url: page["url"], title: page["title"], textChars: typeof page["text"] === "string" ? page["text"].length : 0 } } : {}) };
}

/** `trace list`: the row count, reads, and the first rows (api × script). */
function traceSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { rowCount: len(data["rows"]), rows: firstRows(data["rows"], ["api", "script", "count"]), ...(isRecord(data["totals"]) ? { totals: data["totals"] } : {}) };
}

/** `where`: the five best candidates. */
function whereSummary(data: Record<string, unknown>): Record<string, unknown> {
  const all = recs(data["candidates"]);
  return { candidates: all.slice(0, WHERE_TOP), candidateCount: all.length, ...(isRecord(data["query"]) ? { query: data["query"] } : {}) };
}

/** `net show`: the request line, the header names, where the bodies are. */
function netShowSummary(data: Record<string, unknown>): Record<string, unknown> {
  const req = rec(data["request"]);
  const res = rec(data["response"]);
  const body = rec(res["body"]);
  const post = rec(req["postData"]);
  return {
    requestHeaders: Object.keys(rec(req["headers"])).length,
    requestHeaderNames: firstKeys(req["headers"]),
    responseHeaders: Object.keys(rec(res["headers"])).length,
    responseHeaderNames: firstKeys(res["headers"]),
    ...(isRecord(req["postData"]) ? { postData: { bytes: post["size"], path: post["path"] ?? null, truncated: post["truncated"] } } : {}),
    ...(isRecord(res["body"]) ? { body: { path: body["path"] ?? null, bytes: body["size"] ?? null } } : {}),
    ...(isRecord(data["payload"]) ? { payload: { path: rec(data["payload"])["path"] ?? null, bytes: rec(data["payload"])["size"] ?? null } } : {}),
  };
}

/** `net body`: where the body is, how much of it the preview / search carried, the first matches. */
function netBodySummary(data: Record<string, unknown>): Record<string, unknown> {
  const preview = data["textPreview"];
  return {
    ...(typeof preview === "string" ? { previewChars: preview.length } : {}),
    ...(Array.isArray(data["matches"]) ? { matchCount: len(data["matches"]), matches: firstRows(data["matches"], ["line", "col"]) } : {}),
    ...(Array.isArray(data["content"]) ? { lineCount: len(data["content"]), lines: firstOf(data["content"], "line") } : {}),
    ...(isRecord(data["decoded"]) ? { decoded: data["decoded"] } : {}),
  };
}

/** `net grep`: the counts and the first requests with their match counts. */
function netGrepSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { requestCount: len(data["requests"]), requests: firstRows(data["requests"], ["id", "url", "count"]), skippedCount: len(data["skipped"]) };
}

/** `analyze find`: the hit count, the first hits, what was searched. */
function findSummary(data: Record<string, unknown>): Record<string, unknown> {
  const searched = rec(data["searched"]);
  const hints = rec(data["hints"]);
  return {
    hitCount: len(data["hits"]),
    hits: firstRows(data["hits"], ["ref", "part", "path", "match", "decode"]),
    searched: { requests: searched["requests"], bodies: searched["bodies"], wsFrames: searched["wsFrames"], console: searched["console"] },
    ...(isRecord(data["hints"]) ? { suspectEncrypted: firstOf(hints["suspectEncrypted"], "ref") } : {}),
  };
}

/** `analyze chain`: the target, the steps in order, the open inputs. */
function chainSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { stepCount: len(data["steps"]), steps: firstOf(data["steps"], "id"), todo: len(data["todo"]), todoFirst: firstRows(data["todo"], ["request", "location", "name"]), inputs: len(data["inputs"]) };
}

/** `analyze diff`: the bundles, the per-class counts, the first groups. */
function diffSummary(data: Record<string, unknown>): Record<string, unknown> {
  return {
    bundles: firstRows(data["bundles"], ["short", "dir", "requests"]),
    groupCount: len(data["groups"]),
    groups: firstRows(data["groups"], ["key", "samples", "sessions"]),
    singleSampleGroups: len(data["singleSampleGroups"]),
    ...(isRecord(data["summary"]) ? { summary: data["summary"] } : {}),
  };
}

/** `analyze shape`: the endpoint count and the first endpoints with their exchange counts. */
function shapeSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { endpointCount: len(data["endpoints"]), endpoints: firstRows(data["endpoints"], ["key", "exchanges", "notJson"]), unshaped: len(data["unshaped"]) };
}

/** `analyze schema-diff`: the verdict counts, the bundles, the first endpoints that changed. */
function schemaDiffSummary(data: Record<string, unknown>): Record<string, unknown> {
  const changed = recs(data["endpoints"]).filter((e) => e["verdict"] !== "same");
  return {
    ...(isRecord(data["summary"]) ? { summary: data["summary"] } : {}),
    ...(Array.isArray(data["bundles"]) ? { bundles: data["bundles"] } : {}),
    endpointCount: len(data["endpoints"]),
    changed: changed.slice(0, SUMMARY_FIRST).map((e) => ({ key: e["key"], verdict: e["verdict"], added: len(e["added"]), removed: len(e["removed"]), changed: len(e["changed"]) })),
  };
}

/** `bundle info` (and `--usage`): the counts, the first issues / hosts. */
function infoSummary(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data["hosts"])) {
    const logins = rec(data["logins"]);
    return { hostCount: len(data["hosts"]), hosts: firstRows(data["hosts"], ["host", "actor", "requests"]), logins: { attempts: logins["attempts"], guardEvents: len(logins["guardEvents"]) }, stops: len(data["stops"]), windows: len(data["windows"]) };
  }
  return {
    ...(isRecord(data["counts"]) ? { counts: data["counts"] } : {}),
    ...(isRecord(data["kinds"]) ? { kinds: data["kinds"] } : {}),
    issueCount: len(data["issues"]),
    issues: firstRows(data["issues"], ["line", "kind"]),
    warningCount: len(data["warnings"]),
  };
}

/** `replay check`: the totals and the first rows that were not the same. */
function checkSummary(data: Record<string, unknown>): Record<string, unknown> {
  const off = recs(data["rows"]).filter((r) => r["result"] !== "same");
  return {
    ...(isRecord(data["totals"]) ? { totals: data["totals"] } : {}),
    ...(Array.isArray(data["bundles"]) ? { bundles: data["bundles"] } : {}),
    rowCount: len(data["rows"]),
    notSame: off.slice(0, SUMMARY_FIRST).map((r) => ({ id: r["id"], result: r["result"], ...(r["bundle"] === undefined ? {} : { bundle: r["bundle"] }) })),
    skipped: len(data["skipped"]),
  };
}

/** `status`: daemon and browser up or not, the sessions, the conflicts. */
function statusSummary(data: Record<string, unknown>): Record<string, unknown> {
  const daemon = rec(data["daemon"]);
  const browser = rec(data["browser"]);
  return {
    daemon: { running: daemon["running"] },
    browser: { running: browser["running"], tabs: browser["tabs"] },
    sessionCount: len(data["sessions"]),
    sessions: recs(data["sessions"])
      .slice(0, SUMMARY_FIRST)
      .map((x) => ({ session: x["session"], state: x["state"], tabs: x["tabs"], recording: isRecord(x["recording"]) ? x["recording"]["bundle"] : null, trace: rec(x["trace"])["state"] })),
    conflictCount: len(data["conflicts"]),
    conflicts: firstRows(data["conflicts"], ["code", "session"]),
    handoff: len(data["handoff"]),
  };
}

/** `bundle export fixtures`: the counts and the first files. */
function fixturesSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { files: (Array.isArray(data["files"]) ? data["files"] : []).slice(0, SUMMARY_FIRST), failed: len(data["failed"]), failedFirst: firstRows(data["failed"], ["request", "error"]), notPreferred: len(data["notPreferred"]), ...(isRecord(data["skipped"]) ? { skipped: data["skipped"] } : {}) };
}

/** `fetch --batch`: the count, the failures, the first results. */
function fetchSummary(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data["batch"])) return { ...(typeof data["body"] === "string" ? { bodyChars: data["body"].length } : {}), headers: firstKeys(data["headers"]) };
  return { batch: recs(data["batch"]).slice(0, SUMMARY_FIRST).map((e) => (e["ok"] === true ? { ok: true, id: rec(e["data"])["id"], status: rec(e["data"])["status"] } : { ok: false, code: rec(e["error"])["code"] })) };
}

/** `console show`: the message head, the argument count. */
function consoleShowSummary(data: Record<string, unknown>): Record<string, unknown> {
  return { textChars: typeof data["text"] === "string" ? data["text"].length : 0, args: len(data["args"]) };
}

const CUSTOM: Record<string, (d: Record<string, unknown>) => Record<string, unknown>> = {
  "analyze deps": depsSummary,
  recon: reconSummary,
  "analyze recon": reconSummary,
  "trace list": traceSummary,
  where: whereSummary,
  "net show": netShowSummary,
  "net body": netBodySummary,
  "net grep": netGrepSummary,
  "analyze find": findSummary,
  "analyze chain": chainSummary,
  "analyze diff": diffSummary,
  "analyze shape": shapeSummary,
  "analyze schema-diff": schemaDiffSummary,
  "bundle info": infoSummary,
  "replay check": checkSummary,
  status: statusSummary,
  "bundle export fixtures": fixturesSummary,
  fetch: fetchSummary,
  "console show": consoleShowSummary,
};

/** The commands with their own summary (0.7-C: a unit test feeds each a large answer). */
export const SUMMARY_COMMANDS: readonly string[] = Object.keys(CUSTOM);

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
