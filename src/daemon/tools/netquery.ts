// Pure selection logic for `net list` (filters, default hides, paging) and the
// `net wait` look-back window (docs/04 §16). Nothing here talks to the browser.

import { TabcapError } from "../../shared/envelope.ts";
import { paginate, paginationLines, DEFAULT_PAGE_SIZE, type PaginationResult } from "../../shared/pagination.ts";
import type { NetEntry } from "../capture/recorder.ts";
import type { LastAction } from "../state.ts";
import { optBool, optNum, optStr, type Args } from "./args.ts";

export const LIST_DEFAULT_LIMIT = DEFAULT_PAGE_SIZE;
export const LIST_MAX_LIMIT = 1000;

/**
 * docs/08 §5 page-index paging (chrome-devtools-mcp names). Owner, 2026-10-16:
 * no paging flag → page 0 of 100; `--page-size 0` → every match.
 */
export type Paging = { mode: "all" } | { mode: "page"; size: number; idx: number | null };

export type StatusFilter = { code: number } | { klass: number };

export type ListQuery = {
  filter: string | null;
  host: string | null;
  status: StatusFilter | null;
  method: string | null;
  types: string[] | null;
  tab: string | null;
  /** Daemon clock: only entries written at or after this. */
  since: number | null;
  /** hide (default) | only (--failed) | include (--all) */
  failed: "hide" | "only" | "include";
  /** data: URLs are hidden unless --all. */
  data: "hide" | "include";
  paging: Paging;
};

const usage = (msg: string, next: string) => new TabcapError("usage", msg, next);

export function parseStatus(v: string): StatusFilter {
  if (/^[1-5]\d\d$/.test(v)) return { code: Number(v) };
  const m = /^([1-5])xx$/i.exec(v);
  if (m !== null && m[1] !== undefined) return { klass: Number(m[1]) };
  throw usage(`--status ${v}?`, "Use a status code (--status 404) or a class (--status 2xx | 3xx | 4xx | 5xx).");
}

function count(a: Args, name: string, flag: string, dflt: number, min: number, max: number, cmd = "net list"): number {
  const v = optNum(a, name);
  if (v === null) return dflt;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw usage(`${flag} must be an integer from ${min} to ${max}`, `e.g. \`tabcap ${cmd} ${flag} ${Math.max(min, Math.min(dflt, max))}\`.`);
  return v;
}

/** `net list` arguments. `sinceOf` turns a `c-<n>` id into the command's start time. */
export function parseListQuery(a: Args, sinceOf: (cmd: string) => number | null): ListQuery {
  const failedOnly = optBool(a, "failed");
  const noFailed = optBool(a, "noFailed");
  const all = optBool(a, "all");
  if (failedOnly && noFailed) throw usage("--failed and --no-failed exclude each other", "Use --failed (only failed requests) or nothing (failed ones hidden, counted in hidden.failed).");
  const statusArg = optStr(a, "status");
  const sinceArg = optStr(a, "since");
  let since: number | null = null;
  if (sinceArg !== null) {
    if (!/^c-\d+$/.test(sinceArg)) throw usage(`--since ${sinceArg}?`, "Pass a command id like c-12 (commands return it as `cmd` while recording; requests carry it in `net list`).");
    since = sinceOf(sinceArg);
    if (since === null) throw new TabcapError("not-found", `no command ${sinceArg} in this recording`, "Use a `cmd` id returned while `net start` was recording, or leave --since out.");
  }
  const types = optStr(a, "types")
    ?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  const method = optStr(a, "method");
  return {
    filter: optStr(a, "filter"),
    host: optStr(a, "host")?.toLowerCase() ?? null,
    status: statusArg === null ? null : parseStatus(statusArg),
    method: method === null || method === "" ? null : method.toUpperCase(),
    types: types === undefined || types.length === 0 ? null : types,
    tab: optStr(a, "tab"),
    since,
    failed: failedOnly ? "only" : all ? "include" : "hide",
    data: all ? "include" : "hide",
    paging: parsePaging(a, "net list"),
  };
}

/** `--page-size` (default 30, 0: everything), `--page-idx` (default 0). */
export function parsePaging(a: Args, cmd: string): Paging {
  const given = (k: string) => a[k] !== undefined && a[k] !== null;
  const size = count(a, "pageSize", "--page-size", LIST_DEFAULT_LIMIT, 0, LIST_MAX_LIMIT, cmd);
  const idx = given("pageIdx") ? count(a, "pageIdx", "--page-idx", 0, 0, Number.MAX_SAFE_INTEGER, cmd) : null;
  if (size === 0) {
    if (idx !== null && idx > 0) throw usage("--page-size 0 returns every match on one page", `Leave --page-idx out, or give a page size, e.g. \`tabcap ${cmd} --page-size 50 --page-idx ${idx}\`.`);
    return { mode: "all" };
  }
  return { mode: "page", size, idx };
}

export type Paged<T> = {
  rows: T[];
  /** null: not paged (every match returned). */
  pageSize: number | null;
  pageIdx: number;
  totalPages: number;
  nextPageIdx: number | null;
  invalidPage: boolean;
  /** "Showing a-b of n (Page x of y)." … (chrome-devtools-mcp wording). */
  pagination: string[];
};

/** Apply a paging request to the matches (oldest first). */
export function pageOf<T>(matched: readonly T[], p: Paging): Paged<T> {
  const opts = p.mode === "all" ? undefined : { pageSize: p.size, ...(p.idx === null ? {} : { pageIdx: p.idx }) };
  const r = paginate(matched, opts);
  return {
    rows: [...r.items],
    pageSize: p.mode === "all" ? null : p.size,
    pageIdx: r.currentPage,
    totalPages: r.totalPages,
    nextPageIdx: r.hasNextPage ? r.currentPage + 1 : null,
    invalidPage: r.invalidPage,
    pagination: paginationLines(matched.length, r, p.mode !== "all"),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

const isData = (e: Pick<NetEntry, "url">) => e.url.startsWith("data:");
const isFailed = (e: Pick<NetEntry, "outcome">) => e.outcome === "failed";

function statusOk(s: number | null, f: StatusFilter): boolean {
  if (s === null) return false;
  return "code" in f ? s === f.code : Math.floor(s / 100) === f.klass;
}

export type ListResult = {
  /** Every request in the recording. */
  total: number;
  /** Passed the filters and the default hides (what paging walks over). */
  matched: number;
  /** Passed the filters but hidden by default: failed requests and data: URLs. */
  hidden: { failed: number; data: number };
  shown: number;
} & Paged<NetEntry>;

/** Filter, hide, page. Oldest first, so offsets stay stable while the recording grows. */
export function selectNet(index: readonly NetEntry[], q: ListQuery): ListResult {
  const hidden = { failed: 0, data: 0 };
  const matched: NetEntry[] = [];
  for (const e of index) {
    if (q.tab !== null && e.tab !== q.tab) continue;
    if (q.since !== null && e.at < q.since) continue;
    if (q.filter !== null && !e.url.includes(q.filter)) continue;
    if (q.host !== null && !hostOf(e.url).includes(q.host)) continue;
    if (q.status !== null && !statusOk(e.status, q.status)) continue;
    if (q.method !== null && e.method.toUpperCase() !== q.method) continue;
    if (q.types !== null && !q.types.includes(e.type)) continue;
    if (q.data === "hide" && isData(e)) {
      hidden.data++;
      continue;
    }
    if (q.failed === "only" && !isFailed(e)) continue;
    if (q.failed === "hide" && isFailed(e)) {
      hidden.failed++;
      continue;
    }
    matched.push(e);
  }
  const page = pageOf(matched, q.paging);
  return { total: index.length, matched: matched.length, hidden, shown: page.rows.length, ...page };
}

// ---------------------------------------------------------------- net wait look-back

export type LookBack = {
  /** Daemon clock: requests written at or after this count. */
  since: number;
  from: "action" | "cmd" | "start" | "fresh";
  cmd: string | null;
  action: string | null;
};

/**
 * docs/04 §16: by default `net wait` accepts requests finished since the start of
 * the most recent action command (navigate / click / fill / type / press / go /
 * reload / evaluate), skipping read-only commands; `--since c-<n>` or `--since start`
 * moves the point, `--fresh` accepts only requests finishing after the wait began.
 */
export function lookBack(o: { sinceArg: string | null; fresh: boolean; now: number; recordingStart: number; last: LastAction | null; cmdStart: (id: string) => number | null }): LookBack {
  if (o.fresh && o.sinceArg !== null) throw usage("--fresh and --since exclude each other", "Use --fresh (only new requests) or --since c-<n>|start.");
  if (o.fresh) return { since: o.now, from: "fresh", cmd: null, action: null };
  if (o.sinceArg === "start") return { since: o.recordingStart, from: "start", cmd: null, action: null };
  if (o.sinceArg !== null) {
    if (!/^c-\d+$/.test(o.sinceArg)) throw usage(`--since ${o.sinceArg}?`, "Use --since c-<n> (a command id) or --since start (the whole recording).");
    const at = o.cmdStart(o.sinceArg);
    if (at === null) throw new TabcapError("not-found", `no command ${o.sinceArg} in this recording`, "Use a `cmd` id returned while recording, or --since start.");
    return { since: at, from: "cmd", cmd: o.sinceArg, action: null };
  }
  if (o.last === null) return { since: o.recordingStart, from: "start", cmd: null, action: null };
  return { since: o.last.at, from: "action", cmd: o.last.cmd, action: o.last.action };
}
