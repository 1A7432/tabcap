// Account-usage report of a bundle (docs/04 §30, 0.6-H): how many logins per
// account, requests per host, the shortest interval, empty bodies and business
// error codes. Counts and names only, never values.
//
// Spec: docs/04 §30. Oracle: the range site's access log (e2e v06h) and
// literal expectations in test/unit/usage.test.ts. Reproduce:
//   bun test test/unit/usage.test.ts
//   TABCAP_E2E=1 bun run test:e2e   (v06h)
//
// Times: a request's start is `timing.start` (CDP monotonic ms), else the
// event's `mono` (completion). Intervals are between consecutive starts of the
// same host (host:port) and actor; the first request has none. CORS preflights
// take no part in the interval statistics (min / mean / burst; 0.6-U): the
// browser sends one a moment before its real request, which made a 0.2 ms
// "minimum" out of every cross-origin call. firstMono / lastMono still span
// every request of the row, preflights included.
//
// Actors (0.6-S): one row per host and actor. `fetch` = the request carries a
// `fetchId` (tabcap fetch, its redirect hops and preflights); `evaluate` = it
// was written in the window of a tabcap `evaluate` command (`cmd` names a cmd
// start whose input.action is "evaluate"); `other` = no tab, or the window of
// a command the daemon itself started (cmd start actor "system": plugin
// hooks); `page` = the rest (the page's own requests, including those during
// navigate / click / fill). CORS preflights (OPTIONS) are counted apart
// (`preflights`), never as empty bodies. URLs without a host (data:, blob:,
// about:) are not host rows; loopback hosts (127.0.0.0/8, localhost, ::1) are
// left out unless allHosts. Both are counted in `skipped`.

import { TabcapError } from "../shared/envelope.ts";
import { isRecord, rec, str } from "../shared/json.ts";
import { jsonEqual, parsePath, valueAt, type PathStep } from "../daemon/fetch/stoprules.ts";
import { isLoopbackHost, isPreflight } from "../replay/common.ts";
import type { BundleReader } from "./reader.ts";
import type { RawEvent, RequestEvent } from "./types.ts";

export const USAGE_SCHEMA = "tabcap-usage/0";
export const WINDOW_MS = 600_000;
/** Blobs up to this size are read to tell an empty (whitespace-only) body from a short one. */
const EMPTY_PROBE_BYTES = 65_536;
/** JSON bodies up to this size are parsed for business-code rules. */
const BUSINESS_MAX_BYTES = 8 * 1024 * 1024;

export type BusinessRule = { src: string; path: PathStep[]; ok: unknown };

export const USAGE_ACTORS = ["page", "fetch", "evaluate", "other"] as const;
export type UsageActor = (typeof USAGE_ACTORS)[number];

/** `--actor` value, or a usage error. */
export function parseUsageActor(v: string): UsageActor {
  const a = USAGE_ACTORS.find((x) => x === v);
  if (a === undefined) throw new TabcapError("usage", `bad --actor ${JSON.stringify(v.slice(0, 40))}`, `Use one of: ${USAGE_ACTORS.join(", ")}.`);
  return a;
}

export type HostUsage = {
  host: string;
  /** Who sent these requests (0.6-S): one row per host and actor. */
  actor: UsageActor;
  requests: number;
  byMethod: Record<string, number>;
  firstMono: number | null;
  lastMono: number | null;
  /** Interval statistics are over the row's non-preflight requests (0.6-U). */
  minIntervalMs: number | null;
  meanIntervalMs: number | null;
  maxBurst1s: number;
  statuses: Record<string, number>;
  emptyBodies: number;
  /** CORS preflights (OPTIONS) among `requests`; never counted as empty bodies. */
  preflights: number;
  businessErrors: number;
  bytesIn: number;
};

export type UsageOptions = { actor?: UsageActor | null; allHosts?: boolean };

export type UsageReport = {
  schema: typeof USAGE_SCHEMA;
  bundle: string;
  session: { name: string; site: string | null; account: string | null };
  logins: {
    attempts: number;
    byAccount: Record<string, number>;
    guardEvents: Array<{ seq: number; event: string; site: string | null; account: string | null; rule: string | null; decision: string | null; reason: string | null; request: string | null }>;
  };
  /** Requests per actor over the listed rows. */
  actors: Record<UsageActor, number>;
  filter: { actor: UsageActor | null; allHosts: boolean };
  hosts: HostUsage[];
  /** Left out of `hosts` (and `windows`): loopback hosts (unless allHosts), URLs without a host by scheme. */
  skipped: { loopback: { hosts: string[]; requests: number }; schemes: Record<string, number> };
  stops: Array<{ kind: string; request: string | null; rule: string | null }>;
  windows: Array<{ from: number; to: number; requests: number }>;
  businessRules: string[];
  note: string;
};

export const USAGE_NOTE =
  "counts and names only, no values; one row per host and actor (page / fetch / evaluate / other); intervals are between request starts of one row (CDP monotonic clock), CORS preflights left out; empty = a response with no body, 0 bytes or only whitespace (3xx and CORS preflights excluded); business errors are judged on JSON bodies only";

/** `$.code=0` → path `$.code`, ok value 0 (JSON when it parses, else the string). */
export function parseBusinessRule(src: string): BusinessRule {
  const eq = src.indexOf("=");
  if (eq <= 0) throw new TabcapError("usage", `bad --business-code ${JSON.stringify(src.slice(0, 200))}: expected <$.path>=<ok value>`, "e.g. --business-code '$.code=0'");
  const pathSrc = src.slice(0, eq);
  const raw = src.slice(eq + 1);
  let path: PathStep[];
  try {
    path = parsePath(pathSrc, src);
  } catch (e) {
    throw new TabcapError("usage", e instanceof Error ? e.message.replace("bad stop rule", "bad --business-code").replace(/\.\s*Stop rules:.*$/, "") : "bad --business-code", "e.g. --business-code '$.code=0'");
  }
  let ok: unknown = raw;
  try {
    ok = JSON.parse(raw) as unknown;
  } catch {
    ok = raw;
  }
  return { src, path, ok };
}

/** `host:port`, or the scheme (`data`, `blob`, …) of a URL without a host. */
function hostOf(url: string): { host: string } | { scheme: string } {
  try {
    const u = new URL(url);
    return u.host === "" ? { scheme: u.protocol.replace(/:$/, "") } : { host: u.host };
  } catch {
    return { host: "(invalid-url)" };
  }
}

/** Who sent a request (see the header comment); `cmds` maps a cmd start id to its action and actor. */
function actorOf(r: RequestEvent, cmds: ReadonlyMap<string, { action: string | null; actor: string }>): UsageActor {
  if (typeof r["fetchId"] === "string") return "fetch";
  const c = r.cmd === null ? undefined : cmds.get(r.cmd);
  if (c?.action === "evaluate") return "evaluate";
  if (r.tab === null || c?.actor === "system") return "other";
  return "page";
}

function startOf(r: RequestEvent): number | null {
  const s = r.timing?.start;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  return typeof r.mono === "number" ? r.mono : null;
}

/** Wall-clock start (epoch ms): `ts - (mono - timing.start)` when both exist, else `ts` (docs/04 §6). */
function wallStartOf(r: RequestEvent): number {
  const s = r.timing?.start;
  if (typeof s === "number" && typeof r.mono === "number") return r.ts - (r.mono - s);
  return r.ts;
}

function bodyText(reader: BundleReader, r: RequestEvent, maxBytes: number): string | null {
  const b = r.response?.body;
  if (b === null || b === undefined || b.base64 || b.size > maxBytes) return null;
  const bytes = reader.readBlob(b.blob);
  if (bytes === null) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isEmptyBody(reader: BundleReader, r: RequestEvent): boolean {
  if (isPreflight(r)) return false;
  const resp = r.response;
  if (resp === null || resp.status === null) return false;
  if (resp.status >= 300 && resp.status < 400) return false;
  // 0.6-I: a body `net start --bodies` skipped was never looked at; it is not an empty one.
  if (resp.body === null) return resp.bodySkipped === undefined && (resp.bodyMissing === null || resp.bodyMissing.reason === "no-content");
  if (resp.body.size === 0) return true;
  if (resp.body.base64 || resp.body.size > EMPTY_PROBE_BYTES) return false;
  const t = bodyText(reader, r, EMPTY_PROBE_BYTES);
  return t !== null && t.trim() === "";
}

function isBusinessError(reader: BundleReader, r: RequestEvent, rules: readonly BusinessRule[]): boolean {
  if (rules.length === 0) return false;
  const t = bodyText(reader, r, BUSINESS_MAX_BYTES);
  if (t === null || t.trim() === "") return false;
  let doc: unknown;
  try {
    doc = JSON.parse(t) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(doc) && !Array.isArray(doc)) return false;
  // Anything but the ok value counts, a missing path included.
  return rules.some((rule) => !jsonEqual(valueAt(doc, rule.path), rule.ok));
}

function maxBurst(starts: readonly number[]): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < starts.length; hi++) {
    while ((starts[hi] ?? 0) - (starts[lo] ?? 0) >= 1000) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

const strOr = (o: Record<string, unknown>, k: string): string | null => str(o, k);

function guardInfo(e: RawEvent): UsageReport["logins"]["guardEvents"][number] {
  const detail = rec(e, "detail") ?? {};
  return {
    seq: e.seq,
    event: strOr(e, "event") ?? "",
    site: strOr(e, "site"),
    account: strOr(e, "account"),
    rule: strOr(e, "rule") ?? strOr(detail, "rule"),
    decision: strOr(detail, "decision"),
    reason: strOr(e, "reason") ?? strOr(detail, "reason"),
    request: strOr(e, "request") ?? strOr(detail, "request"),
  };
}

export function usageReport(reader: BundleReader, dir: string, rules: readonly BusinessRule[], opts: UsageOptions = {}): UsageReport {
  const want = opts.actor ?? null;
  const allHosts = opts.allHosts === true;
  const cmds = new Map<string, { action: string | null; actor: string }>();
  for (const e of reader.events) {
    if (e.kind !== "cmd" || e["phase"] !== "start" || typeof e["id"] !== "string") continue;
    const input = rec(e, "input");
    cmds.set(e["id"], { action: input === null ? null : str(input, "action"), actor: e.actor });
  }
  const skipped: UsageReport["skipped"] = { loopback: { hosts: [], requests: 0 }, schemes: {} };
  const loopHosts = new Set<string>();
  const listed: RequestEvent[] = [];
  const byRow = new Map<string, { host: string; actor: UsageActor; list: RequestEvent[] }>();
  for (const r of reader.requests()) {
    const actor = actorOf(r, cmds);
    if (want !== null && actor !== want) continue;
    const h = hostOf(r.url);
    if ("scheme" in h) {
      skipped.schemes[h.scheme] = (skipped.schemes[h.scheme] ?? 0) + 1;
      continue;
    }
    if (!allHosts && isLoopbackHost(hostnameOf(h.host))) {
      loopHosts.add(h.host);
      skipped.loopback.requests++;
      continue;
    }
    listed.push(r);
    const k = `${h.host}\n${actor}`;
    const row = byRow.get(k);
    if (row === undefined) byRow.set(k, { host: h.host, actor, list: [r] });
    else row.list.push(r);
  }
  skipped.loopback.hosts = [...loopHosts].sort();
  const hosts: HostUsage[] = [];
  for (const { host, actor, list } of byRow.values()) {
    const byMethod: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    let empty = 0;
    let preflights = 0;
    let business = 0;
    let bytesIn = 0;
    const all: number[] = [];
    const starts: number[] = [];
    for (const r of list) {
      byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
      const status = r.response?.status ?? null;
      const key = status !== null ? String(status) : r.outcome === "failed" ? "failed" : r.outcome === "incomplete" ? "incomplete" : "none";
      statuses[key] = (statuses[key] ?? 0) + 1;
      const pre = isPreflight(r);
      if (pre) preflights++;
      else if (isEmptyBody(reader, r)) empty++;
      if (isBusinessError(reader, r, rules)) business++;
      bytesIn += r.response?.body?.size ?? 0;
      const s = startOf(r);
      if (s === null) continue;
      all.push(s);
      if (!pre) starts.push(s);
    }
    all.sort((a, b) => a - b);
    starts.sort((a, b) => a - b);
    let minInterval: number | null = null;
    for (let i = 1; i < starts.length; i++) {
      const d = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      if (minInterval === null || d < minInterval) minInterval = d;
    }
    const first = starts[0] ?? null;
    const last = starts[starts.length - 1] ?? null;
    hosts.push({
      host,
      actor,
      requests: list.length,
      byMethod,
      firstMono: all[0] ?? null,
      lastMono: all[all.length - 1] ?? null,
      minIntervalMs: minInterval === null ? null : round3(minInterval),
      meanIntervalMs: starts.length < 2 || first === null || last === null ? null : round3((last - first) / (starts.length - 1)),
      maxBurst1s: maxBurst(starts),
      statuses,
      emptyBodies: empty,
      preflights,
      businessErrors: business,
      bytesIn,
    });
  }
  const perHost = new Map<string, number>();
  for (const h of hosts) perHost.set(h.host, (perHost.get(h.host) ?? 0) + h.requests);
  const order = (a: UsageActor) => USAGE_ACTORS.indexOf(a);
  hosts.sort((a, b) => (perHost.get(b.host) ?? 0) - (perHost.get(a.host) ?? 0) || a.host.localeCompare(b.host) || order(a.actor) - order(b.actor));
  const actors: Record<UsageActor, number> = { page: 0, fetch: 0, evaluate: 0, other: 0 };
  for (const h of hosts) actors[h.actor] += h.requests;

  const logins: UsageReport["logins"] = { attempts: 0, byAccount: {}, guardEvents: [] };
  const stops: UsageReport["stops"] = [];
  for (const e of reader.events) {
    if (e.kind !== "guard") continue;
    const g = guardInfo(e);
    logins.guardEvents.push(g);
    if (g.event === "budget" && g.rule === "login-limit" && (g.decision === "allowed" || g.decision === "confirmed")) {
      logins.attempts++;
      const k = g.account ?? "(none)";
      logins.byAccount[k] = (logins.byAccount[k] ?? 0) + 1;
    }
    if (g.event === "breaker") stops.push({ kind: g.reason ?? "breaker", request: g.request, rule: g.rule });
  }

  const buckets = new Map<number, number>();
  for (const r of listed) {
    const b = Math.floor(wallStartOf(r) / WINDOW_MS) * WINDOW_MS;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const windows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([from, n]) => ({ from, to: from + WINDOW_MS, requests: n }));

  return {
    schema: USAGE_SCHEMA,
    bundle: dir,
    session: { name: reader.manifest.session.name, site: reader.manifest.session.site, account: reader.manifest.session.account },
    logins,
    actors,
    filter: { actor: want, allHosts },
    hosts,
    skipped,
    stops,
    windows,
    businessRules: rules.map((r) => r.src),
    note: USAGE_NOTE,
  };
}

/** `host:port` → hostname (`[::1]:80` → `[::1]`). */
function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const i = host.lastIndexOf(":");
  return i < 0 ? host : host.slice(0, i);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const clock = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** One screen of text for a run log. */
export function renderUsageText(u: UsageReport): string {
  const out: string[] = [];
  out.push(`usage ${u.bundle}`);
  out.push(`session ${u.session.name}  site ${u.session.site ?? "-"}  account ${u.session.account ?? "-"}`);
  const accts = Object.entries(u.logins.byAccount).map(([a, n]) => `${a}=${n}`).join(" ");
  out.push(`logins ${u.logins.attempts}${accts === "" ? "" : `  (${accts})`}  guard events ${u.logins.guardEvents.length}`);
  out.push(`actors ${USAGE_ACTORS.map((a) => `${a} ${u.actors[a]}`).join("  ")}${u.filter.actor === null ? "" : `  (only ${u.filter.actor})`}`);
  out.push("");
  const head = ["host", "actor", "req", "min ms", "mean ms", "burst/1s", "empty", "preflight", "biz err", "bytes in"];
  const rows = u.hosts.map((h) => [
    h.host,
    h.actor,
    String(h.requests),
    h.minIntervalMs === null ? "-" : String(h.minIntervalMs),
    h.meanIntervalMs === null ? "-" : String(h.meanIntervalMs),
    String(h.maxBurst1s),
    String(h.emptyBodies),
    String(h.preflights),
    String(h.businessErrors),
    String(h.bytesIn),
  ]);
  const w = head.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i < 2 ? pad(c, w[i] ?? 0) : padL(c, w[i] ?? 0))).join("  ");
  out.push(line(head));
  for (const r of rows) out.push(line(r));
  const sk = u.skipped;
  const schemes = Object.entries(sk.schemes).map(([k, n]) => `${k}: ${n}`);
  if (sk.loopback.requests > 0 || schemes.length > 0) {
    const loop = sk.loopback.requests > 0 ? [`loopback ${sk.loopback.requests} request(s) on ${sk.loopback.hosts.join(", ")} (--all-hosts lists them)`] : [];
    out.push(`skipped: ${[...loop, ...schemes.map((x) => `${x} (no host)`)].join("; ")}`);
  }
  out.push("");
  for (const h of u.hosts) {
    const st = Object.entries(h.statuses).map(([k, n]) => `${k}:${n}`).join(" ");
    const me = Object.entries(h.byMethod).map(([k, n]) => `${k}:${n}`).join(" ");
    out.push(`${h.host} ${h.actor}  methods ${me}  statuses ${st}`);
  }
  if (u.stops.length > 0) {
    out.push("");
    for (const s of u.stops) out.push(`stop ${s.kind}  request ${s.request ?? "-"}  rule ${s.rule ?? "-"}`);
  }
  if (u.windows.length > 0) {
    out.push("");
    out.push(`per 10 min (UTC): ${u.windows.map((x) => `${clock(x.from)} ${x.requests}`).join(" | ")}`);
  }
  if (u.businessRules.length > 0) out.push(`business-code: ${u.businessRules.join(", ")}`);
  out.push(u.note);
  return out.join("\n");
}
