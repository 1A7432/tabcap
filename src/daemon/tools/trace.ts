// tabcap trace start | stop | status | list (0.4-F, 0.6-L): which page scripts
// read which browser signals, and — with `--decode` — the observe mode: the
// plaintext the page itself parses out of an encrypted response, filed as a
// `decoded` view `by:"page"`. Explicit and announced (docs/03 §10.3): the
// output says that debugger breakpoints make scripts slower and timing
// observable. No page state is changed and no output suggests changing one;
// the observe mode calls only the page's native `console.dirxml` (its
// log-point) and reads scopes (never a CryptoKey). With `--decode` no signal
// breakpoints are installed (owner decision 10-16, 0.6-L2).
// 0.6-U: `trace start --decode` names the enabled decode plugins
// (`decodePlugins`, with `decodePluginsNotice`): a body a plugin filed a view
// for is not observed (tracer.ts) and plugin views outrank the page's
// (docs/04 §33 D4), so where one matches, few `by:"page"` rows appear.
// Whether one matches the session's traffic is not knowable at start; an
// enabled one is enough. 0.6-V: `trace status` and `trace stop` answer the
// same two fields while decode is on, and every `--decode` answer says
// `weakRows` (config.json `trace.weakRows`, default false: single-suspect
// rows are counted as `drops.weak`, not filed).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../bundle/reader.ts";
import { TabcapError } from "../../shared/envelope.ts";
import type { Daemon } from "../state.ts";
import { DEFAULT_LIMITS, type TraceLimits } from "../trace/aggregate.ts";
import { builtinSignalList, parseSignalList, sha256Text, type SignalList } from "../trace/signals.ts";
import { traceTable } from "../trace/table.ts";
import { TRACE_NOTICE, Tracer } from "../trace/tracer.ts";
import { readTraceConfig } from "../../shared/config.ts";
import { decodePlugins } from "../hooks/plugins.ts";
import { checkSessionName, optBool, optNum, optStr, type Args } from "./args.ts";
import { redactUrl, revealOf } from "./liveredact.ts";

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

/** The observe mode traces no signals (0.6-L2): an empty list, said as such. */
const OBSERVE_ONLY: SignalList = { names: [], source: "none (--decode: observe mode, no signal breakpoints)", hash: sha256Text("[]"), warnings: [] };

const DECODE_NOTICE_BASE =
  'observe mode on, no signal breakpoints: every JSON.parse of a string of 32+ chars pauses (~0.4 ms plus a round trip) and its argument is logged to tabcap through the native console.dirxml; turn it off after the recording (trace stop / --no-decode). The plaintext the page parses is filed by "page" as a decoded view';

/** The `decodeNotice` of `trace start --decode` (0.6-V: says what happens to weak rows). */
export function decodeNotice(weakRows: boolean): string {
  return weakRows
    ? `${DECODE_NOTICE_BASE}; weakRows on: evidence.link "weak" means it was only the one armed suspect`
    : `${DECODE_NOTICE_BASE} when the parsing frame can reach the ciphertext (evidence.link "strong"); a plaintext tied only by being the one armed suspect is counted as drops.weak, not filed (config.json trace.weakRows: true files it with link "weak")`;
}

/** `trace start --decode` fields naming the enabled decode plugins (0.6-U), or {} when there is none.
 * 0.6-V: `trace status` / `trace stop` answer them too while decode is on (`withDecodePlugins`). */
export function decodePluginsFields(configDir: string): { decodePlugins?: string[]; decodePluginsNotice?: string } {
  const names = decodePlugins(configDir).map((p) => p.name);
  if (names.length === 0) return {};
  const first = names[0] ?? "";
  return {
    decodePlugins: names,
    decodePluginsNotice: `enabled decode plugin(s) ${names.join(", ")}: a response body one of them filed a view for (decoded or failed) is not observed, and plugin views outrank by:"page" views (docs/04 §33 D4), so where a plugin matches the traffic few by:"page" rows appear; to observe the page instead: \`tabcap plugin disable ${names.length === 1 ? first : "<name>"}\``,
  };
}

/** A trace status / stop answer with the decode-plugin fields added when the
 * observe mode is on (the answer carries a `decode` block), else unchanged. */
export function withDecodePlugins(answer: Record<string, unknown>, configDir: string): Record<string, unknown> {
  return answer["decode"] === undefined ? answer : { ...answer, ...decodePluginsFields(configDir) };
}

export async function traceStart(d: Daemon, a: Args, session: string): Promise<unknown> {
  checkSessionName(session);
  const { t, tabs, console: consoleLog } = d.need();
  const have = d.tracers.get(session);
  if (have !== undefined) return { session, alreadyOn: true, notice: TRACE_NOTICE, ...statusLite(have) };
  const limits: TraceLimits = {
    stack: limitArg(a, "stack", "--stack", DEFAULT_LIMITS.stack, 1, 64),
    firstN: limitArg(a, "firstN", "--first-n", DEFAULT_LIMITS.firstN, 0, 100_000),
    maxHits: limitArg(a, "maxHits", "--max-hits", DEFAULT_LIMITS.maxHits, 1, 1_000_000),
  };
  // 0.6-L: --decode / --no-decode override config.json `trace.decode`.
  const cfg = readTraceConfig(d.paths.configFile);
  const decode = "decode" in a ? optBool(a, "decode") : cfg.decode;
  const apis = optStr(a, "apis");
  if (decode && apis !== null) throw new TabcapError("usage", "--apis has no effect with --decode: the observe mode installs no signal breakpoints", "Trace signals with `tabcap trace start --no-decode --apis <file>`, or drop --apis.");
  const list = decode ? OBSERVE_ONLY : loadSignalList(d.paths.config, apis);
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
    decode,
    weakRows: cfg.weakRows,
    suppressConsole: (marker) => consoleLog.suppressMarker(marker),
  });
  d.tracers.set(session, tr);
  const recording = d.recorders.get(session)?.dir ?? null;
  return {
    session,
    alreadyOn: false,
    notice: TRACE_NOTICE,
    ...statusLite(tr),
    recording,
    ...(decode ? { decode: tr.status()["decode"], weakRows: cfg.weakRows, decodeNotice: decodeNotice(cfg.weakRows), ...decodePluginsFields(d.paths.config) } : {}),
    ...(recording === null
      ? { warning: decode ? "the session is not recording: observe rows reach a bundle only while `tabcap net start` records" : "the session is not recording: signal events reach a bundle only while `tabcap net start` records; trace status still counts reads" }
      : {}),
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
  const decode = tr.status()["decode"];
  await tr.stop("trace stop");
  return withDecodePlugins({ session, stopped: true, hits, ...(decode === undefined ? {} : { decode }), bundle: d.recorders.get(session)?.dir ?? null }, d.paths.config);
}

export function traceStatus(d: Daemon, _a: Args, session: string): unknown {
  const tr = d.tracers.get(session);
  if (tr === undefined) return { session, trace: "off" };
  return withDecodePlugins(tr.status(), d.paths.config);
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
  const table = traceTable([...written, ...pending], { api: optStr(a, "api"), script: optStr(a, "script") });
  // 0.6-E: a script URL's sensitive query parameters as <redacted:name> unless --reveal (rows carry no argument values)
  const c = { scrub: (s: string) => d.secrets.scrub(s) };
  const rows = revealOf(a) ? table : table.map((r) => ({ ...r, script: redactUrl(r.script, c) }));
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
