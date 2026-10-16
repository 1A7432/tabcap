// tabcap trace start | stop | status | list (0.4-F): which page scripts read
// which browser signals. Explicit and announced (docs/03 §10.3): the output
// says that debugger breakpoints make scripts slower and timing observable.
// Read-only: no value in the page is changed, and no output suggests changing one.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../bundle/reader.ts";
import { TabcapError } from "../../shared/envelope.ts";
import type { Daemon } from "../state.ts";
import { DEFAULT_LIMITS, type TraceLimits } from "../trace/aggregate.ts";
import { builtinSignalList, parseSignalList, type SignalList } from "../trace/signals.ts";
import { traceTable } from "../trace/table.ts";
import { TRACE_NOTICE, Tracer } from "../trace/tracer.ts";
import { checkSessionName, optNum, optStr, type Args } from "./args.ts";

export const SIGNALS_FILE = "signals.json";

function limitArg(a: Args, key: string, flag: string, def: number, min: number, max: number): number {
  const v = optNum(a, key);
  if (v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw new TabcapError("usage", `${flag} must be an integer from ${min} to ${max}`, `e.g. ${flag} ${def}`);
  return v;
}

/** `--apis <file>`, else `$TABCAP_HOME/config/signals.json`, else the built-in list. */
export function loadSignalList(configDir: string, file: string | null): SignalList {
  const path = file ?? join(configDir, SIGNALS_FILE);
  if (file === null && !existsSync(path)) return builtinSignalList();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new TabcapError("not-found", `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, "Pass a readable JSON file with --apis, or remove it to use the built-in list.");
  }
  return parseSignalList(text, path);
}

export async function traceStart(d: Daemon, a: Args, session: string): Promise<unknown> {
  checkSessionName(session);
  const { t, tabs } = d.need();
  const have = d.tracers.get(session);
  if (have !== undefined) return { session, alreadyOn: true, notice: TRACE_NOTICE, ...statusLite(have) };
  const limits: TraceLimits = {
    stack: limitArg(a, "stack", "--stack", DEFAULT_LIMITS.stack, 1, 64),
    firstN: limitArg(a, "firstN", "--first-n", DEFAULT_LIMITS.firstN, 0, 100_000),
    maxHits: limitArg(a, "maxHits", "--max-hits", DEFAULT_LIMITS.maxHits, 1, 1_000_000),
  };
  const list = loadSignalList(d.paths.config, optStr(a, "apis"));
  tabs.ensureSession(session);
  const tr = await Tracer.start({
    session,
    t,
    tabs,
    list,
    limits,
    recorder: () => d.recorders.get(session),
    scrub: (s) => d.secrets.scrub(s),
    paused: d.guard.isWaiting(session),
  });
  d.tracers.set(session, tr);
  const recording = d.recorders.get(session)?.dir ?? null;
  return {
    session,
    alreadyOn: false,
    notice: TRACE_NOTICE,
    ...statusLite(tr),
    recording,
    ...(recording === null ? { warning: "the session is not recording: signal events reach a bundle only while `tabcap net start` records; trace status still counts reads" } : {}),
  };
}

function statusLite(tr: Tracer): Record<string, unknown> {
  const s = tr.status();
  return { settings: s["settings"], requested: s["requested"], active: s["active"], skipped: s["skipped"], warnings: s["warnings"] };
}

export async function traceStop(d: Daemon, _a: Args, session: string): Promise<unknown> {
  const tr = d.tracers.get(session);
  if (tr === undefined) throw new TabcapError("not-found", `trace mode is not on in session "${session}"`, "Run `tabcap trace start` first.");
  d.tracers.delete(session);
  const hits = tr.hits;
  await tr.stop("trace stop");
  return { session, stopped: true, hits, bundle: d.recorders.get(session)?.dir ?? null };
}

export function traceStatus(d: Daemon, _a: Args, session: string): unknown {
  const tr = d.tracers.get(session);
  if (tr === undefined) return { session, trace: "off" };
  return tr.status();
}

/** Stop trace mode of a session (session stop), writing what it saw first. */
export async function stopTrace(d: Daemon, session: string, reason: string): Promise<void> {
  const tr = d.tracers.get(session);
  if (tr === undefined) return;
  d.tracers.delete(session);
  await tr.stop(reason).catch(() => undefined);
}

export async function traceList(d: Daemon, a: Args, session: string): Promise<unknown> {
  const rec = d.recorders.get(session) ?? d.lastBundles.get(session);
  const tr = d.tracers.get(session);
  if (rec === undefined) throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start` and `tabcap trace start`, load the page, then `tabcap trace list`.");
  await rec.flushEvents();
  const reader = BundleReader.open(rec.dir);
  const written = reader.events.filter((e) => e.kind === "signal");
  // Documents still open have not been written yet; show them too (they are written when the document ends).
  const pending = tr !== undefined && d.recorders.get(session) === rec ? tr.pendingEvents() : [];
  const rows = traceTable([...written, ...pending], { api: optStr(a, "api"), script: optStr(a, "script") });
  return {
    session,
    bundle: rec.dir,
    recording: rec.recording,
    written: written.length,
    pending: pending.length,
    lines: "1-based",
    rows,
    totals: { rows: rows.length, reads: rows.reduce((n, r) => n + r.count, 0) },
  };
}
