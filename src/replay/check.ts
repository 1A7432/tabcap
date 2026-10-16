// `tabcap replay check <bundle> --against <url>`: send every recorded request
// again and compare the answers item by item with the recording (docs/03 §3
// 步骤 6 「重放请求，与录到的响应逐项比对」:
// same count, same fields, not "looks similar").
// Compared: status; selected response headers that the recording has
// (default content-type, location); body — JSON per path (every scalar leaf
// and every empty container), text by equality, binary by sha256.
// Target: loopback by default (`replay serve` of the same bundle must give zero
// differences). A non-loopback target needs --live, a stored site whose
// domains include the host, and is paced through the store's guard counters
// (1 request per 2 s unless --rate). Tests never use --live against a real
// site. A live check goes out through the proxy of the bundle's account when
// it is bound to a pool proxy (0.4-D); the result names the proxy, never its URL.
// Oracle: the bundle (recorded status / headers / blobs). Reproduce:
//   bun test test/unit/replay-check.test.ts test/unit/replay-integration.test.ts

import { BundleReader } from "../bundle/reader.ts";
import type { RequestEvent } from "../bundle/types.ts";
import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import { Store } from "../daemon/store/db.ts";
import { accountProxy, type AccountProxy } from "./proxyenv.ts";
import type { HttpClient } from "../daemon/pool/proxy.ts";
import { isBinaryMime, parseJsonDoc, utf8 } from "../analyze/decoders.ts";
import { HOP_BY_HOP, flattenJson, globMatcher, headerJoined, isLoopbackHost, replayableRequests, requestBodyBytes, type Skipped } from "./common.ts";

export const DEFAULT_AGAINST = "http://127.0.0.1:4500";
export const DEFAULT_HEADERS = ["content-type", "location"];
export const LIVE_INTERVAL_MS = 2000;
export const LIVE_SCOPE = "replay-check";
export const MAX_FIELD_DIFFS = 20;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Request headers never re-sent: connection-specific, computed by the client, or the session itself. */
const NOT_SENT = new Set([...HOP_BY_HOP, "host", "content-length", "accept-encoding"]);

export type FieldDiff = { path: string; kind: "missing" | "extra" | "changed"; recorded: string | null; got: string | null };

export type BodyDiff =
  | { kind: "json"; fields: FieldDiff[]; count: number }
  | { kind: "not-json"; detail: string }
  | { kind: "text"; recordedSha256: string; gotSha256: string; recordedSize: number; gotSize: number; firstDiff: number }
  | { kind: "binary"; recordedSha256: string; gotSha256: string; recordedSize: number; gotSize: number };

export type HeaderDiff = { name: string; recorded: string; got: string | null };

export type RowResult = "same" | "different" | "error" | "unverified";

export type CheckRow = {
  id: string;
  method: string;
  path: string;
  status: { recorded: number | null; got: number | null };
  result: RowResult;
  diffs: { status?: true; headers?: HeaderDiff[]; body?: BodyDiff };
  notes: string[];
  error?: string;
};

export type CheckTotals = { requests: number; same: number; different: number; errors: number; unverified: number; skipped: number };

export type CheckResult = {
  bundle: string;
  against: string;
  live: boolean;
  /** Pool proxy name a live check went out through (0.4-D), else null. */
  proxy?: string | null;
  headers: string[];
  totals: CheckTotals;
  rows: CheckRow[];
  skipped: Skipped[];
  warnings: string[];
};

// ------------------------------------------------------------ comparator

/** Field-by-field JSON comparison: every path missing, extra or changed (types included: 1 vs "1" differ). */
export function compareJson(recorded: unknown, got: unknown): FieldDiff[] | null {
  const a = flattenJson(recorded);
  const b = flattenJson(got);
  if (a === null || b === null) return null;
  const out: FieldDiff[] = [];
  for (const [p, v] of a) {
    const w = b.get(p);
    if (w === undefined) out.push({ path: p, kind: "missing", recorded: v, got: null });
    else if (w !== v) out.push({ path: p, kind: "changed", recorded: v, got: w });
  }
  for (const [p, w] of b) if (!a.has(p)) out.push({ path: p, kind: "extra", recorded: null, got: w });
  return out;
}

/** Compare two bodies the way the recording's type says: JSON per path, text equal, binary by hash. Null: same. */
export function compareBodies(recorded: Uint8Array, mime: string | null, got: Uint8Array): BodyDiff | null {
  const recText = isBinaryMime(mime) ? null : utf8(recorded);
  const recJson = recText === null ? null : parseJsonDoc(recText);
  if (recJson !== null) {
    const gotText = utf8(got);
    const gotJson = gotText === null ? null : parseJsonDoc(gotText);
    if (gotJson === null) return { kind: "not-json", detail: `the recording is JSON, the answer is not (${got.length} bytes)` };
    const fields = compareJson(recJson.value, gotJson.value);
    if (fields === null) {
      // too large to walk: fall back to bytes
      const same = sha256Hex(recorded) === sha256Hex(got);
      return same ? null : { kind: "binary", recordedSha256: sha256Hex(recorded), gotSha256: sha256Hex(got), recordedSize: recorded.length, gotSize: got.length };
    }
    return fields.length === 0 ? null : { kind: "json", fields: fields.slice(0, MAX_FIELD_DIFFS), count: fields.length };
  }
  if (recText !== null) {
    const gotText = utf8(got);
    if (gotText === recText) return null;
    let i = 0;
    const n = Math.min(recorded.length, got.length);
    while (i < n && recorded[i] === got[i]) i++;
    return { kind: "text", recordedSha256: sha256Hex(recorded), gotSha256: sha256Hex(got), recordedSize: recorded.length, gotSize: got.length, firstDiff: i };
  }
  const ra = sha256Hex(recorded);
  const gb = sha256Hex(got);
  return ra === gb ? null : { kind: "binary", recordedSha256: ra, gotSha256: gb, recordedSize: recorded.length, gotSize: got.length };
}

/** `location` compared as a path when it points at the request's own origin (replay serve rewrites it so). */
function normLocation(value: string, requestUrl: string): string {
  try {
    const base = new URL(requestUrl);
    const u = new URL(value, base);
    return u.origin === base.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
  } catch {
    return value;
  }
}

export function normHeader(name: string, value: string, requestUrl: string): string {
  if (name === "location") return normLocation(value, requestUrl);
  if (name === "content-type") return value.trim().toLowerCase().replace(/\s*;\s*/g, ";");
  return value.trim();
}

/** Compare the selected headers that the recording has. */
export function compareHeaders(names: readonly string[], recorded: RequestEvent, got: globalThis.Headers, targetUrl: string): HeaderDiff[] {
  const out: HeaderDiff[] = [];
  const rh = recorded.response?.headers ?? {};
  for (const name of names) {
    const rv = headerJoined(rh, name);
    if (rv === null) continue;
    const gv = name === "set-cookie" ? (got.getSetCookie().join(", ") || null) : got.get(name);
    if (gv === null || normHeader(name, rv, recorded.url) !== normHeader(name, gv, targetUrl)) out.push({ name, recorded: rv, got: gv });
  }
  return out;
}

// ------------------------------------------------------------ sending

export type CheckOptions = {
  bundle: string;
  against: string;
  live: boolean;
  rate?: number | undefined;
  site?: string | undefined;
  filter?: string | undefined;
  withCookies: boolean;
  headers: readonly string[];
  configDir: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Tests: the HTTP client. */
  fetch?: HttpClient;
};

/** Reasons a recorded body cannot be compared (not a difference). */
const EMPTY_BY_DESIGN = new Set(["no-content", "not-modified", "redirect"]);

function targetUrl(base: URL, recordedUrl: string): string {
  const u = new URL(recordedUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${prefix}${u.pathname}${u.search}`;
}

function requestHeaders(r: RequestEvent, withCookies: boolean): globalThis.Headers {
  const h = new Headers();
  for (const [name, v] of Object.entries(r.request.headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(":") || NOT_SENT.has(lower) || (lower === "cookie" && !withCookies)) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      try {
        h.append(lower, one);
      } catch {
        // invalid name / value in the recording: not sent
      }
    }
  }
  return h;
}

type LiveGuard = { site: string; intervalMs: number; store: Store };

function openLiveGuard(opts: CheckOptions, base: URL, manifestSite: string | null): LiveGuard {
  const site = opts.site ?? manifestSite;
  if (site === null) throw new TabcapError("usage", "--live needs a stored site to count requests against", "Pass --site <name> (see `tabcap site list`), or record the bundle in a session started with --site.");
  if (opts.rate !== undefined && !(Number.isFinite(opts.rate) && opts.rate > 0)) throw new TabcapError("usage", "--rate must be a positive number of requests per second", "e.g. --rate 1");
  const store = Store.open(opts.configDir);
  const row = store.site(site);
  if (row === null) {
    store.close();
    throw new TabcapError("not-found", `no site "${site}" in the store`, "Run `tabcap site list`; add the site with `tabcap site add` first.");
  }
  let entryHost = "";
  try {
    entryHost = new URL(row.entryUrl).hostname;
  } catch {
    entryHost = "";
  }
  const hosts = new Set([entryHost, ...row.domains].map((d) => d.toLowerCase()).filter((d) => d !== ""));
  if (!hosts.has(base.hostname.toLowerCase())) {
    store.close();
    throw new TabcapError("usage", `${base.hostname} is not one of the domains of site "${site}" (${[...hosts].join(", ")})`, "Check --against, or add the domain to the site (tabcap site remove + add with --domains).");
  }
  return { site, intervalMs: opts.rate === undefined ? LIVE_INTERVAL_MS : Math.ceil(1000 / opts.rate), store };
}

export async function check(opts: CheckOptions): Promise<CheckResult> {
  let base: URL;
  try {
    base = new URL(opts.against);
  } catch {
    throw new TabcapError("usage", `--against is not a URL: ${opts.against}`, `Pass the replay server or target origin, e.g. ${DEFAULT_AGAINST}.`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new TabcapError("usage", `--against must be http(s): ${opts.against}`, `e.g. ${DEFAULT_AGAINST}`);
  const loopback = isLoopbackHost(base.hostname);
  if (!loopback && !opts.live) {
    throw new TabcapError(
      "usage",
      `refusing to send recorded requests to ${base.host}: not a loopback address`,
      "Replay offline first: `tabcap replay serve <bundle>` and check against it (docs/03 §4: replay offline first). Against a real site only with --live, which is paced and counted per site.",
    );
  }
  const reader = BundleReader.open(opts.bundle);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const guard = !loopback && opts.live ? openLiveGuard(opts, base, reader.manifest.session.site) : null;
  // 0.4-D: the account's pool proxy, as the browser session used it (system / none / unbound: none).
  let egress: AccountProxy | null = null;
  try {
    egress = guard === null ? null : accountProxy(opts.configDir, guard.site, reader.manifest.session.site === guard.site ? reader.manifest.session.account : null);
  } catch (e) {
    guard?.store.close();
    throw e;
  }
  const warnings: string[] = [];
  if (!reader.isComplete()) warnings.push("bundle is not finished (未收尾): recording in progress or interrupted");
  if (guard !== null) warnings.push(`live target: requests paced at one per ${guard.intervalMs} ms and counted for site ${guard.site}`);
  if (egress !== null) warnings.push(`live target: sent through proxy ${egress.proxy} (account ${egress.site}.${egress.account})`);
  if (opts.withCookies) warnings.push("--with-cookies: the recorded cookie header is sent; it may have expired (docs/03 §4: sessions expire)");

  const { requests, skipped } = replayableRequests(reader);
  const match = globMatcher(opts.filter);
  const chosen = requests.filter((r) => {
    if (match === null) return true;
    try {
      return match(new URL(r.url).pathname);
    } catch {
      return false;
    }
  });

  const rows: CheckRow[] = [];
  try {
    for (const r of chosen) rows.push(await checkOne(r, reader, base, opts, guard, sleep, now, egress));
  } finally {
    guard?.store.close();
  }
  const totals: CheckTotals = { requests: rows.length, same: 0, different: 0, errors: 0, unverified: 0, skipped: skipped.length };
  for (const row of rows) {
    if (row.result === "same") totals.same++;
    else if (row.result === "different") totals.different++;
    else if (row.result === "error") totals.errors++;
    else totals.unverified++;
  }
  return { bundle: opts.bundle, against: base.href, live: guard !== null, proxy: egress?.proxy ?? null, headers: [...opts.headers], totals, rows, skipped, warnings };
}

async function checkOne(
  r: RequestEvent,
  reader: BundleReader,
  base: URL,
  opts: CheckOptions,
  guard: LiveGuard | null,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  egress: AccountProxy | null,
): Promise<CheckRow> {
  const u = new URL(r.url);
  const row: CheckRow = { id: r.id, method: r.method, path: `${u.pathname}${u.search}`, status: { recorded: r.response?.status ?? null, got: null }, result: "same", diffs: {}, notes: [] };
  const target = targetUrl(base, r.url);
  const body = requestBodyBytes(r, reader);
  if ("missing" in body) row.notes.push(`request body missing in the recording (${body.missing}); sent without a body`);
  const bytes = "bytes" in body ? body.bytes : new Uint8Array(0);
  const method = r.method.toUpperCase();
  if (guard !== null) {
    const last = guard.store.requestCounter(guard.site, LIVE_SCOPE).lastRequestAt;
    const wait = last === null ? 0 : last + guard.intervalMs - now();
    if (wait > 0) await sleep(wait);
    guard.store.noteRequest(guard.site, LIVE_SCOPE, now());
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target, {
      method,
      headers: requestHeaders(r, opts.withCookies),
      redirect: "manual",
      ...(bytes.length > 0 && method !== "GET" && method !== "HEAD" ? { body: bytes } : {}),
      ...(egress === null ? {} : { proxy: egress.url }),
    });
  } catch (e) {
    row.result = "error";
    const msg = e instanceof Error ? e.message : String(e);
    row.error = egress === null ? msg : egress.scrub(msg); // a proxy error may echo the credentialed URL
    return row;
  }
  row.status.got = res.status;
  // A replay server says which recording it served; with repeated keys a used server is offset.
  const servedId = /^(r-\d+);n=\d+$/.exec(res.headers.get("x-tabcap-replay") ?? "")?.[1];
  if (servedId !== undefined && servedId !== r.id) row.notes.push(`the replay server answered with ${servedId} (same match key, cycling); restart it for a one-to-one check`);
  const got = new Uint8Array(await res.arrayBuffer());
  if (got.length > MAX_RESPONSE_BYTES) row.notes.push(`answer over ${MAX_RESPONSE_BYTES} bytes`);
  if (res.status !== row.status.recorded) row.diffs.status = true;
  const hd = compareHeaders(opts.headers, r, res.headers, target);
  if (hd.length > 0) row.diffs.headers = hd;

  const resp = r.response;
  let bodyChecked = false;
  if (resp?.body) {
    const rec = reader.readBlob(resp.body.blob);
    if (rec === null) row.notes.push("recorded body blob is missing; body not compared");
    else {
      bodyChecked = true;
      const bd = compareBodies(rec, resp.mimeType ?? headerJoined(resp.headers, "content-type"), got);
      if (bd !== null) row.diffs.body = bd;
    }
  } else if (resp?.bodyMissing) {
    if (EMPTY_BY_DESIGN.has(resp.bodyMissing.reason)) {
      bodyChecked = true;
      if (got.length > 0 && method !== "HEAD") row.diffs.body = { kind: "binary", recordedSha256: sha256Hex(new Uint8Array(0)), gotSha256: sha256Hex(got), recordedSize: 0, gotSize: got.length };
    } else row.notes.push(`recorded body missing (${resp.bodyMissing.reason}); body not compared`);
  } else {
    bodyChecked = true;
    if (got.length > 0 && method !== "HEAD") row.diffs.body = { kind: "binary", recordedSha256: sha256Hex(new Uint8Array(0)), gotSha256: sha256Hex(got), recordedSize: 0, gotSize: got.length };
  }
  if (Object.keys(row.diffs).length > 0) row.result = "different";
  else if (!bodyChecked) row.result = "unverified";
  return row;
}

// ------------------------------------------------------------ text

function cut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function detail(row: CheckRow): string {
  if (row.error !== undefined) return `error: ${row.error}`;
  const parts: string[] = [];
  if (row.diffs.status) parts.push(`status ${row.status.recorded ?? "-"} → ${row.status.got ?? "-"}`);
  for (const h of row.diffs.headers ?? []) parts.push(`${h.name}: ${cut(h.recorded, 40)} → ${cut(h.got ?? "(absent)", 40)}`);
  const b = row.diffs.body;
  if (b?.kind === "json") parts.push(`body ${b.count} field(s): ${b.fields.slice(0, 3).map((f) => `${f.path} ${f.kind}`).join(", ")}${b.count > 3 ? ", …" : ""}`);
  else if (b?.kind === "not-json") parts.push(`body: ${b.detail}`);
  else if (b !== undefined) parts.push(`body ${b.kind} ${b.recordedSize} → ${b.gotSize} bytes, sha256 differs`);
  parts.push(...row.notes);
  return parts.join("; ");
}

export function renderCheckText(r: CheckResult): string {
  const lines: string[] = [`replay check ${r.bundle} against ${r.against}${r.live ? " (live)" : ""}`, ""];
  const head = ["id", "method", "path", "status", "result"];
  const table = r.rows.map((row) => [row.id, row.method, cut(row.path, 60), `${row.status.recorded ?? "-"}→${row.status.got ?? "-"}`, row.result]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((t) => (t[i] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  lines.push(fmt(head).trimEnd());
  r.rows.forEach((row, i) => {
    const d = detail(row);
    lines.push((fmt(table[i] ?? []) + (d === "" ? "" : `  ${d}`)).trimEnd());
  });
  const t = r.totals;
  lines.push("", `totals: ${t.requests} request(s), ${t.same} same, ${t.different} different, ${t.errors} error(s), ${t.unverified} unverified, ${t.skipped} skipped (not replayable)`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
