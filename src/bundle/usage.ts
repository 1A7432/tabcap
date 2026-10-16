// Account-usage report of a bundle (docs/04 §28, 0.6-H): how many logins per
// account, requests per host, the shortest interval, empty bodies and business
// error codes. Counts and names only, never values.
//
// Spec: docs/04 §28. Oracle: the range site's access log (e2e v06h) and
// literal expectations in test/unit/usage.test.ts. Reproduce:
//   bun test test/unit/usage.test.ts
//   TABCAP_E2E=1 bun run test:e2e   (v06h)
//
// Times: a request's start is `timing.start` (CDP monotonic ms), else the
// event's `mono` (completion). Intervals are between consecutive starts of the
// same host (host:port); the first request has none.

import { TabcapError } from "../shared/envelope.ts";
import { isRecord, rec, str } from "../shared/json.ts";
import { jsonEqual, parsePath, valueAt, type PathStep } from "../daemon/fetch/stoprules.ts";
import type { BundleReader } from "./reader.ts";
import type { RawEvent, RequestEvent } from "./types.ts";

export const USAGE_SCHEMA = "tabcap-usage/0";
export const WINDOW_MS = 600_000;
/** Blobs up to this size are read to tell an empty (whitespace-only) body from a short one. */
const EMPTY_PROBE_BYTES = 65_536;
/** JSON bodies up to this size are parsed for business-code rules. */
const BUSINESS_MAX_BYTES = 8 * 1024 * 1024;

export type BusinessRule = { src: string; path: PathStep[]; ok: unknown };

export type HostUsage = {
  host: string;
  requests: number;
  byMethod: Record<string, number>;
  firstMono: number | null;
  lastMono: number | null;
  minIntervalMs: number | null;
  meanIntervalMs: number | null;
  maxBurst1s: number;
  statuses: Record<string, number>;
  emptyBodies: number;
  businessErrors: number;
  bytesIn: number;
};

export type UsageReport = {
  schema: typeof USAGE_SCHEMA;
  bundle: string;
  session: { name: string; site: string | null; account: string | null };
  logins: {
    attempts: number;
    byAccount: Record<string, number>;
    guardEvents: Array<{ seq: number; event: string; site: string | null; account: string | null; rule: string | null; decision: string | null; reason: string | null; request: string | null }>;
  };
  hosts: HostUsage[];
  stops: Array<{ kind: string; request: string | null; rule: string | null }>;
  windows: Array<{ from: number; to: number; requests: number }>;
  businessRules: string[];
  note: string;
};

export const USAGE_NOTE =
  "counts and names only, no values; intervals are between request starts of one host (CDP monotonic clock); empty = a response with no body, 0 bytes or only whitespace (3xx excluded); business errors are judged on JSON bodies only";

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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid-url)";
  }
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
  const resp = r.response;
  if (resp === null || resp.status === null) return false;
  if (resp.status >= 300 && resp.status < 400) return false;
  if (resp.body === null) return resp.bodyMissing === null || resp.bodyMissing.reason === "no-content";
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

export function usageReport(reader: BundleReader, dir: string, rules: readonly BusinessRule[]): UsageReport {
  const requests = reader.requests();
  const byHost = new Map<string, RequestEvent[]>();
  for (const r of requests) {
    const h = hostOf(r.url);
    const list = byHost.get(h);
    if (list === undefined) byHost.set(h, [r]);
    else list.push(r);
  }
  const hosts: HostUsage[] = [];
  for (const [host, list] of byHost) {
    const byMethod: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    let empty = 0;
    let business = 0;
    let bytesIn = 0;
    const starts: number[] = [];
    for (const r of list) {
      byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
      const status = r.response?.status ?? null;
      const key = status !== null ? String(status) : r.outcome === "failed" ? "failed" : r.outcome === "incomplete" ? "incomplete" : "none";
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (isEmptyBody(reader, r)) empty++;
      if (isBusinessError(reader, r, rules)) business++;
      bytesIn += r.response?.body?.size ?? 0;
      const s = startOf(r);
      if (s !== null) starts.push(s);
    }
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
      requests: list.length,
      byMethod,
      firstMono: first,
      lastMono: last,
      minIntervalMs: minInterval === null ? null : round3(minInterval),
      meanIntervalMs: starts.length < 2 || first === null || last === null ? null : round3((last - first) / (starts.length - 1)),
      maxBurst1s: maxBurst(starts),
      statuses,
      emptyBodies: empty,
      businessErrors: business,
      bytesIn,
    });
  }
  hosts.sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host));

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
  for (const r of requests) {
    const b = Math.floor(wallStartOf(r) / WINDOW_MS) * WINDOW_MS;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const windows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([from, n]) => ({ from, to: from + WINDOW_MS, requests: n }));

  return {
    schema: USAGE_SCHEMA,
    bundle: dir,
    session: { name: reader.manifest.session.name, site: reader.manifest.session.site, account: reader.manifest.session.account },
    logins,
    hosts,
    stops,
    windows,
    businessRules: rules.map((r) => r.src),
    note: USAGE_NOTE,
  };
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
  out.push("");
  const head = ["host", "req", "min ms", "mean ms", "burst/1s", "empty", "biz err", "bytes in"];
  const rows = u.hosts.map((h) => [h.host, String(h.requests), h.minIntervalMs === null ? "-" : String(h.minIntervalMs), h.meanIntervalMs === null ? "-" : String(h.meanIntervalMs), String(h.maxBurst1s), String(h.emptyBodies), String(h.businessErrors), String(h.bytesIn)]);
  const w = head.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length)));
  out.push(head.map((c, i) => (i === 0 ? pad(c, w[i] ?? 0) : padL(c, w[i] ?? 0))).join("  "));
  for (const r of rows) out.push(r.map((c, i) => (i === 0 ? pad(c, w[i] ?? 0) : padL(c, w[i] ?? 0))).join("  "));
  out.push("");
  for (const h of u.hosts) {
    const st = Object.entries(h.statuses).map(([k, n]) => `${k}:${n}`).join(" ");
    const me = Object.entries(h.byMethod).map(([k, n]) => `${k}:${n}`).join(" ");
    out.push(`${h.host}  methods ${me}  statuses ${st}`);
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
