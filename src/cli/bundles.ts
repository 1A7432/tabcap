// `tabcap bundle list` and `tabcap bundle prune` (review 10-21, owner decision;
// docs/04 §2, §8.1). Both read the store's bundle index: `net start` notes each
// recording (path, site, session, start) and its finish is noted when it ends.
// Recordings have no total size limit; prune is how they are cleaned up.
//   list   newest first: id (manifest), dir, site, session, startedAt,
//          finishedAt, bytes on disk, state (recording | finished |
//          unfinished | missing); --site, --limit
//   prune  --keep N (the N newest stay) or --older-than <duration>; a dry run
//          unless --yes. Never deleted: a recording the daemon still has open,
//          an unfinished one while a daemon runs but does not answer (it may
//          still be writing), and anything that is not a bundle directory (a
//          symlink, no manifest.json). Index rows whose directory is gone are
//          forgotten.
// Index paths are local data written by the daemon; they are still checked
// before anything is deleted.

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readManifest } from "../bundle/manifest.ts";
import { Store, storePath, type BundleRow } from "../daemon/store/db.ts";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import type { Paths } from "../shared/paths.ts";
import { status as daemonStatus } from "./client.ts";

export type BundleState = "recording" | "finished" | "unfinished" | "missing";

export type BundleListing = {
  /** manifest.json `id`; null when the directory is gone or the manifest unreadable. */
  id: string | null;
  dir: string;
  site: string | null;
  session: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Bytes on disk (files and links themselves, links not followed); null when the directory is gone. */
  bytes: number | null;
  state: BundleState;
  /** Why this is not a bundle directory prune may delete (a symlink, no manifest.json …). */
  problem?: string;
};

/** What the daemon has open: its recordings' directories; `reachable: false` when a daemon runs but did not answer. */
export type OpenRecordings = { dirs: ReadonlySet<string>; reachable: boolean };

export const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 1000;
const UNITS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION_HELP = "Use a whole number with s, m, h, d or w, e.g. --older-than 30d.";

/** `30d`, `12h`, `2w`, `90m`, `45s` → ms (a whole number above 0). */
export function parseDuration(s: string): number {
  const m = /^(\d{1,6})([smhdw])$/.exec(s);
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2]];
  const n = m?.[1] === undefined ? 0 : Number(m[1]);
  if (unit === undefined || n <= 0) throw new TabcapError("usage", `bad duration: ${JSON.stringify(s.slice(0, 40))}`, DURATION_HELP);
  return n * unit;
}

/** Bytes under `path` without following symlinks (a link counts as itself). */
export function dirBytes(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) {
    try {
      total += dirBytes(join(path, name));
    } catch {
      // vanished while counting
    }
  }
  return total;
}

/** Null when `dir` is a plain bundle directory prune may delete, else why not. */
function bundleProblem(dir: string): string | null {
  if (!isAbsolute(dir)) return "not an absolute path";
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return "a symlink, not a bundle directory";
  if (!st.isDirectory()) return "not a directory";
  const m = lstatSync(join(dir, "manifest.json"), { throwIfNoEntry: false });
  if (m === undefined || !m.isFile()) return "no manifest.json";
  return null;
}

/** One index row as listed: what is on disk now and whether the daemon still writes it. */
export function describeBundle(r: BundleRow, open: OpenRecordings): BundleListing {
  const base = { dir: r.path, site: r.site, session: r.sessionName, startedAt: r.created };
  if (lstatSync(r.path, { throwIfNoEntry: false }) === undefined) return { id: null, ...base, finishedAt: r.finished, bytes: null, state: "missing" };
  const problem = bundleProblem(r.path);
  let id: string | null = null;
  let manifestFinished: number | null = null;
  let manifestProblem: string | null = null;
  if (problem === null) {
    try {
      const m = readManifest(r.path);
      id = m.id;
      manifestFinished = m.finished ?? null;
    } catch (e) {
      manifestProblem = `manifest.json unreadable: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  }
  const finishedAt = r.finished ?? manifestFinished;
  const state: BundleState = open.dirs.has(r.path) ? "recording" : finishedAt !== null ? "finished" : "unfinished";
  let bytes: number | null = null;
  try {
    bytes = dirBytes(r.path);
  } catch {
    bytes = null;
  }
  const why = problem ?? manifestProblem;
  return { id, ...base, finishedAt, bytes, state, ...(why === null ? {} : { problem: why }) };
}

function indexRows(p: Paths, site: string | null): BundleRow[] {
  if (!existsSync(storePath(p.config))) return [];
  const s = Store.open(p.config);
  try {
    return s.bundles(site ?? undefined);
  } finally {
    s.close();
  }
}

const newestFirst = (a: { startedAt: number; dir: string }, b: { startedAt: number; dir: string }): number => b.startedAt - a.startedAt || (a.dir < b.dir ? 1 : a.dir > b.dir ? -1 : 0);

function siteArg(args: Record<string, unknown>): string | null {
  const s = args["site"];
  return typeof s === "string" && s !== "" ? s : null;
}

export type BundleList = { store: string; site: string | null; total: number; bundles: BundleListing[] };

/** `tabcap bundle list [--site s] [--limit N]`. */
export function listBundles(p: Paths, args: Record<string, unknown>, open: OpenRecordings): BundleList {
  const limitArg = args["limit"];
  const limit = typeof limitArg === "number" ? limitArg : LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) throw new TabcapError("usage", `--limit must be a whole number from 1 to ${LIST_MAX_LIMIT}`, "e.g. tabcap bundle list --limit 20");
  const site = siteArg(args);
  const rows = indexRows(p, site).map((r) => describeBundle(r, open)).sort(newestFirst);
  return { store: storePath(p.config), site, total: rows.length, bundles: rows.slice(0, limit) };
}

function humanBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const isoSecond = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** `bundle list --text`: one line per bundle (start, state, size, site, session, dir). */
export function renderBundleListText(l: BundleList): string {
  if (l.bundles.length === 0) return "no recordings in the store's bundle index";
  return l.bundles.map((b) => [isoSecond(b.startedAt), b.state.padEnd(10), humanBytes(b.bytes).padStart(9), b.site ?? "-", b.session ?? "-", b.dir].join("  ")).join("\n");
}

export type PrunePlan = { selected: BundleListing[]; kept: number; forgotten: string[]; skipped: { dir: string; reason: string }[] };

/**
 * Pure: which bundles prune deletes. `keep`: the N newest present bundles stay; `olderThanMs`: those
 * started before now - olderThanMs go. Missing rows are forgotten and count for neither.
 */
export function planPrune(rows: readonly BundleListing[], o: { keep?: number; olderThanMs?: number; now: number; reachable: boolean }): PrunePlan {
  const present = rows.filter((b) => b.state !== "missing").sort(newestFirst);
  const forgotten = rows.filter((b) => b.state === "missing").map((b) => b.dir);
  const candidates = o.keep !== undefined ? present.slice(o.keep) : present.filter((b) => b.startedAt < o.now - (o.olderThanMs ?? Number.POSITIVE_INFINITY));
  const selected: BundleListing[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  for (const b of candidates) {
    if (b.state === "recording") skipped.push({ dir: b.dir, reason: "recording: the daemon still writes it (`tabcap net stop` first)" });
    else if (b.problem !== undefined) skipped.push({ dir: b.dir, reason: b.problem });
    else if (!o.reachable && b.finishedAt === null) skipped.push({ dir: b.dir, reason: "unfinished while the daemon does not answer: it may still be recording" });
    else selected.push(b);
  }
  return { selected, kept: present.length - candidates.length, forgotten, skipped };
}

export type PruneResult = {
  dryRun: boolean;
  rule: { keep: number } | { olderThan: string; before: number };
  site: string | null;
  selected: BundleListing[];
  bytes: number;
  deleted: number;
  kept: number;
  forgotten: string[];
  skipped: { dir: string; reason: string }[];
  next?: string;
};

/** `tabcap bundle prune (--keep N | --older-than d) [--site s] [--dry-run] [--yes]`. */
export function pruneBundles(p: Paths, args: Record<string, unknown>, open: OpenRecordings, now: number): PruneResult {
  const keepArg = args["keep"];
  const olderArg = args["olderThan"];
  const usage = "Usage: tabcap bundle prune (--keep N | --older-than <30d>) [--site s] [--dry-run] [--yes]";
  if ((keepArg === undefined) === (olderArg === undefined)) throw new TabcapError("usage", "give exactly one of --keep and --older-than", usage);
  if (args["dryRun"] === true && args["yes"] === true) throw new TabcapError("usage", "--dry-run and --yes contradict each other", "Leave out --yes to see what would go; give --yes alone to delete.");
  let keep: number | undefined;
  let olderThanMs: number | undefined;
  if (keepArg !== undefined) {
    if (typeof keepArg !== "number" || !Number.isInteger(keepArg) || keepArg < 0) throw new TabcapError("usage", "--keep must be a whole number of 0 or more", usage);
    keep = keepArg;
  } else {
    if (typeof olderArg !== "string") throw new TabcapError("usage", "--older-than needs a duration", DURATION_HELP);
    olderThanMs = parseDuration(olderArg);
  }
  const site = siteArg(args);
  const dryRun = args["yes"] !== true;
  const rows = indexRows(p, site).map((r) => describeBundle(r, open));
  const plan = planPrune(rows, { ...(keep === undefined ? {} : { keep }), ...(olderThanMs === undefined ? {} : { olderThanMs }), now, reachable: open.reachable });
  const skipped = [...plan.skipped];
  let deleted = 0;
  const selected: BundleListing[] = [];
  if (dryRun) selected.push(...plan.selected);
  else {
    const s = Store.open(p.config);
    try {
      for (const b of plan.selected) {
        // Checked again right before deleting: the directory may have changed since it was listed.
        const why = lstatSync(b.dir, { throwIfNoEntry: false }) === undefined ? "gone before it was deleted" : bundleProblem(b.dir);
        if (why !== null) {
          skipped.push({ dir: b.dir, reason: why });
          continue;
        }
        try {
          rmSync(b.dir, { recursive: true });
        } catch (e) {
          skipped.push({ dir: b.dir, reason: `could not delete: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` });
          continue;
        }
        s.forgetBundle(b.dir);
        selected.push(b);
        deleted++;
      }
      for (const dir of plan.forgotten) s.forgetBundle(dir);
    } finally {
      s.close();
    }
  }
  const bytes = selected.reduce((n, b) => n + (b.bytes ?? 0), 0);
  const rule = keep !== undefined ? { keep } : { olderThan: String(olderArg), before: now - (olderThanMs ?? 0) };
  const next = dryRun && (selected.length > 0 || plan.forgotten.length > 0) ? `Nothing was deleted (dry run). Run the same command with --yes to delete ${selected.length} recording(s) (${humanBytes(bytes)})${plan.forgotten.length > 0 ? ` and forget ${plan.forgotten.length} index row(s) whose directory is gone` : ""}.` : undefined;
  return { dryRun, rule, site, selected, bytes, deleted, kept: plan.kept, forgotten: plan.forgotten, skipped, ...(next === undefined ? {} : { next }) };
}

/**
 * The recordings a running daemon has open (`GET /status`). No daemon: nothing records. A daemon that
 * runs but does not answer (a timeout): unknown, so unfinished bundles are kept.
 */
export async function openRecordings(p: Paths): Promise<OpenRecordings> {
  const st = await daemonStatus(p);
  if (!st.ok) return { dirs: new Set(), reachable: st.error.code === "not-running" };
  const recs = isRecord(st.data) && Array.isArray(st.data["recordings"]) ? st.data["recordings"].filter(isRecord) : [];
  return { dirs: new Set(recs.filter((r) => r["recording"] === true && typeof r["bundle"] === "string").map((r) => String(r["bundle"]))), reachable: true };
}
