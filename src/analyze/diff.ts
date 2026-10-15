// `tabcap analyze diff <bundle1> <bundle2> [...]`: classify request parameters
// across recordings of the same flow (docs/05 s06, docs/06 A4).
// Spec: docs/05 s06 classification table (常量 / 会话值 / 时间戳 / 变化值),
// docs/06 A4.1 (same session twice -> sid is "常量或会话值"), A4.2 (a third
// recording from a new session -> sid is a session value), A4.4 (query, JSON
// body, form body, header and cookie positions are all classified).
// Oracle: test/unit/diff.test.ts builds three bundles with known parameter
// behaviour (HMAC signatures computed with node:crypto) and asserts the table.
// Reproduce: bun test test/unit/diff.test.ts
//
// Grouping: method + path template (all-digit segments -> {n}, UUIDs -> {id}).
// A bundle's session is manifest.session.name (manifest id when the name is
// empty); bundles with the same name are recordings of one session.

import { TabcapError } from "../shared/envelope.ts";
import { BundleReader } from "../bundle/reader.ts";
import type { Headers, RequestEvent } from "../bundle/types.ts";
import { parseJsonDoc, walkJson } from "./decoders.ts";

export type ParamLocation = "query" | "header" | "cookie" | "json" | "form";
export type ParamClass = "constant" | "timestamp" | "session" | "constant-or-session" | "varying";
export type ParamHint = "looks-random" | "looks-signature" | "input";

export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const MAX_BODY_PARAMS = 1000;
export const MAX_BODY_BYTES = 1024 * 1024;

export type DiffParam = {
  location: ParamLocation;
  name: string;
  class: ParamClass;
  hints: ParamHint[];
  /** Samples carrying the parameter / samples in the group. */
  present: number;
  samples: number;
  /** Distinct values in sample order (at most 5, each cut at 64 chars). */
  values: string[];
  /** For `input`: other parameters that carried the same value in the same bundle. */
  alsoIn?: string[];
};

export type DiffGroup = {
  key: string;
  method: string;
  template: string;
  origins: string[];
  samples: number;
  perBundle: number[];
  sessions: number;
  requests: { bundle: number; ref: string }[];
  params: DiffParam[];
};

export type DiffBundle = { dir: string; label: string; id: string; session: string; sessionKey: string; complete: boolean; requests: number };

export type DiffResult = {
  bundles: DiffBundle[];
  sessions: number;
  groups: DiffGroup[];
  /** Groups seen only once in all bundles: nothing to compare. */
  singleSampleGroups: string[];
  summary: Record<ParamClass, number>;
  warnings: string[];
};

const LOCATIONS: readonly ParamLocation[] = ["query", "header", "cookie", "json", "form"];

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade"]);
const EXCLUDED_HEADERS = new Set([...HOP_BY_HOP, "content-length", "cookie"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function pathTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? "{n}" : UUID.test(seg) ? "{id}" : seg))
    .join("/");
}

export type Sample = { bundle: number; session: string; ts: number; ref: string; params: Map<string, string> };

/** Key of a parameter in a sample's `params` map. */
export const pkey = (loc: ParamLocation, name: string) => `${loc}\t${name}`;

export function splitKey(k: string): { location: ParamLocation; name: string } {
  const tab = k.indexOf("\t");
  const loc = k.slice(0, tab);
  const location = LOCATIONS.find((l) => l === loc) ?? "query";
  return { location, name: k.slice(tab + 1) };
}

function setUnique(m: Map<string, string>, loc: ParamLocation, name: string, value: string): void {
  let n = name;
  for (let i = 1; m.has(pkey(loc, n)); i++) n = `${name}[${i}]`;
  m.set(pkey(loc, n), value);
}

export function headerValues(h: Headers, name: string): string[] {
  const v = h[name];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function cookiePairs(header: string): [string, string][] {
  return header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p): [string, string] => {
      const eq = p.indexOf("=");
      return eq < 0 ? [p, ""] : [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
    });
}

const SIMPLE_FORM = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*&?$/;

function leafString(v: string | number | boolean | null): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** What parameter extraction reads from a request (a recorded `request` event, or a live one). */
export type ParamSource = { id: string; url: string; request: { headers: Headers; postData: RequestEvent["request"]["postData"] } };

/**
 * Flatten a request into `location\tname -> value`: query, headers (minus
 * hop-by-hop, content-length and cookie), cookie pairs, JSON body leaves
 * (JSONPath names) or form fields. Repeated names get `[1]`, `[2]` suffixes.
 */
export function extractParams(r: ParamSource, readBlob: (ref: string) => Uint8Array | null, warn: (w: string) => void): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const u = new URL(r.url);
    for (const [k, v] of u.searchParams) setUnique(m, "query", k, v);
  } catch {
    warn(`${r.id}: url is not parseable, query skipped`);
  }
  const headers = r.request.headers;
  for (const [k, v] of Object.entries(headers)) {
    if (EXCLUDED_HEADERS.has(k) || k.startsWith(":")) continue;
    setUnique(m, "header", k, Array.isArray(v) ? v.join(", ") : v);
  }
  for (const c of headerValues(headers, "cookie")) for (const [k, v] of cookiePairs(c)) setUnique(m, "cookie", k, v);

  const pd = r.request.postData;
  if (pd === null) return m;
  let text: string | null = null;
  if ("inline" in pd) text = pd.inline;
  else {
    const bytes = readBlob(pd.blob);
    if (bytes === null) warn(`${r.id}: request body blob missing`);
    else if (bytes.length > MAX_BODY_BYTES) warn(`${r.id}: request body over ${MAX_BODY_BYTES} bytes, not flattened`);
    else text = new TextDecoder().decode(bytes);
  }
  if (text === null || text.length > MAX_BODY_BYTES) return m;
  const ctype = (headerValues(headers, "content-type")[0] ?? "").toLowerCase();
  const doc = ctype.includes("json") || /^\s*[[{]/.test(text) ? parseJsonDoc(text) : null;
  if (doc !== null) {
    let n = 0;
    walkJson(doc.value, "$", (path, leaf) => {
      if (n++ >= MAX_BODY_PARAMS) {
        warn(`${r.id}: JSON body has more than ${MAX_BODY_PARAMS} leaves, rest ignored`);
        return false;
      }
      m.set(pkey("json", path), leafString(leaf));
      return true;
    });
  } else if (ctype.includes("x-www-form-urlencoded") || SIMPLE_FORM.test(text.trim())) {
    let n = 0;
    for (const [k, v] of new URLSearchParams(text.trim())) {
      if (n++ >= MAX_BODY_PARAMS) break;
      setUnique(m, "form", k, v);
    }
  }
  return m;
}

// ------------------------------------------------------------ value tests

/** Epoch (seconds / milliseconds, optional fraction) or ISO 8601 -> ms; null otherwise. */
export function timestampMs(v: string): number | null {
  if (/^\d{10}(?:\.\d+)?$/.test(v)) return Number(v) * 1000;
  if (/^\d{13}(?:\.\d+)?$/.test(v)) return Number(v);
  if (ISO_8601.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function charEntropy(values: readonly string[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const v of values) for (const c of v) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
    total++;
  }
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

const SIG_LENGTHS = new Set([32, 40, 64, 128]);
const HEX = /^[0-9a-fA-F]+$/;
const B64ISH = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function looksSignature(values: readonly string[]): boolean {
  return values.every((v) => SIG_LENGTHS.has(v.length) && (HEX.test(v) || B64ISH.test(v))) && new Set(values).size === values.length;
}

function looksRandom(values: readonly string[]): boolean {
  const len = values[0]?.length ?? 0;
  return len >= 8 && values.every((v) => v.length === len) && new Set(values).size === values.length && charEntropy(values) >= 3;
}

const TOKEN = /^[A-Za-z0-9._~+/=-]{16,}$/;
const isTokenLike = (v: string) => TOKEN.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v);

// ------------------------------------------------------------ diff

export type GroupAcc = { method: string; template: string; origins: Set<string>; samples: Sample[] };

/** One recording to group: its requests (possibly filtered) and its session identity. */
export type GroupSource = { label: string; sessionKey: string; requests: readonly RequestEvent[]; readBlob: (ref: string) => Uint8Array | null };

export type Grouped = {
  /** Groups by `METHOD template`, samples in source then recorded order. */
  groups: Map<string, GroupAcc>;
  /** Per source: cookie and set-cookie values seen (session evidence). */
  cookieValues: Set<string>[];
};

/** Group requests by method + path template and extract each sample's parameters. */
export function groupRequests(sources: readonly GroupSource[], warn: (w: string) => void): Grouped {
  const groups = new Map<string, GroupAcc>();
  const cookieValues: Set<string>[] = [];
  sources.forEach((src, bi) => {
    const cv = new Set<string>();
    cookieValues.push(cv);
    for (const r of src.requests) {
      for (const c of headerValues(r.request.headers, "cookie")) for (const [, v] of cookiePairs(c)) cv.add(v);
      for (const sc of r.response === null ? [] : headerValues(r.response.headers, "set-cookie")) {
        const first = sc.split(";")[0] ?? "";
        const eq = first.indexOf("=");
        if (eq > 0) cv.add(first.slice(eq + 1).trim());
      }
      let template = r.url;
      let origin = "";
      try {
        const u = new URL(r.url);
        template = pathTemplate(u.pathname);
        origin = u.origin;
      } catch {
        // keep the raw url as its own group
      }
      const key = `${r.method} ${template}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { method: r.method, template, origins: new Set(), samples: [] };
        groups.set(key, g);
      }
      if (origin !== "") g.origins.add(origin);
      g.samples.push({ bundle: bi, session: src.sessionKey, ts: r.ts, ref: r.id, params: extractParams(r, src.readBlob, (w) => warn(`${src.label} ${w}`)) });
    }
  });
  return { groups, cookieValues };
}

/** Classify every parameter of a group with at least two samples (`nBundles`: how many sources were grouped). */
export function classifyGroup(key: string, g: GroupAcc, cookieValues: readonly Set<string>[], nBundles: number): DiffGroup | null {
  const sessions = new Set(g.samples.map((s) => s.session));
  const keys = new Set<string>();
  for (const s of g.samples) for (const k of s.params.keys()) keys.add(k);
  const bundleCookies = new Set<string>();
  for (const s of g.samples) for (const v of cookieValues[s.bundle] ?? []) if (v.length >= 8) bundleCookies.add(v);
  const params: DiffParam[] = [];
  for (const k of keys) {
    const { location, name } = splitKey(k);
    params.push(classify(location, name, g.samples.map((s) => s.params.get(k) ?? null), g.samples, sessions.size, bundleCookies));
  }
  params.sort((a, b) => LOCATIONS.indexOf(a.location) - LOCATIONS.indexOf(b.location) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (params.length === 0) return null;
  return {
    key,
    method: g.method,
    template: g.template,
    origins: [...g.origins].sort(),
    samples: g.samples.length,
    perBundle: Array.from({ length: nBundles }, (_, i) => g.samples.filter((s) => s.bundle === i).length),
    sessions: sessions.size,
    requests: g.samples.map((s) => ({ bundle: s.bundle, ref: s.ref })),
    params,
  };
}

export function diff(dirs: readonly string[]): DiffResult {
  if (dirs.length < 2) throw new TabcapError("usage", "diff needs at least two bundles", "Record the same flow twice (or more) and pass all bundle directories: tabcap analyze diff <b1> <b2> [...]");
  const warnings: string[] = [];
  const bundles: DiffBundle[] = [];
  const sources: GroupSource[] = [];

  dirs.forEach((dir, bi) => {
    const reader = BundleReader.open(dir);
    const label = `b${bi + 1}`;
    const name = reader.manifest.session.name;
    const sessionKey = name !== "" ? name : reader.manifest.id;
    const requests = reader.requests();
    bundles.push({ dir, label, id: reader.manifest.id, session: name, sessionKey, complete: reader.isComplete(), requests: requests.length });
    if (!reader.isComplete()) warnings.push(`${label}: bundle is not finished (未收尾)`);
    sources.push({ label, sessionKey, requests, readBlob: (ref) => reader.readBlob(ref) });
  });
  const { groups, cookieValues } = groupRequests(sources, (w) => warnings.push(w));

  const out: DiffGroup[] = [];
  const singleSampleGroups: string[] = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (g.samples.length < 2) {
      singleSampleGroups.push(key);
      continue;
    }
    const dg = classifyGroup(key, g, cookieValues, dirs.length);
    if (dg !== null) out.push(dg);
  }

  markInputs(out, groups);

  const summary: Record<ParamClass, number> = { constant: 0, timestamp: 0, session: 0, "constant-or-session": 0, varying: 0 };
  for (const g of out) for (const p of g.params) summary[p.class]++;
  const sessionCount = new Set(bundles.map((b) => b.sessionKey)).size;
  if (sessionCount < 2) warnings.push("all bundles come from one session: session values cannot be told from constants (constant-or-session); record once more in a new session");
  return { bundles, sessions: sessionCount, groups: out, singleSampleGroups, summary, warnings };
}

function classify(
  location: ParamLocation,
  name: string,
  values: readonly (string | null)[],
  samples: readonly Sample[],
  sessionCount: number,
  bundleCookies: ReadonlySet<string>,
): DiffParam {
  const present = values.filter((v): v is string => v !== null);
  const distinct = [...new Set(present)];
  const base = { location, name, present: present.length, samples: values.length, values: distinct.slice(0, 5).map((v) => (v.length > 64 ? v.slice(0, 63) + "…" : v)) };
  const allPresent = present.length === values.length;

  if (allPresent && distinct.length === 1) {
    const v = distinct[0] ?? "";
    const sessionish = location === "cookie" || bundleCookies.has(v) || isTokenLike(v);
    return { ...base, class: sessionCount < 2 && sessionish ? "constant-or-session" : "constant", hints: [] };
  }

  if (allPresent) {
    const ms = present.map(timestampMs);
    const inWindow = ms.every((t, i) => t !== null && Math.abs(t - (samples[i]?.ts ?? 0)) <= TIMESTAMP_WINDOW_MS);
    if (inWindow) {
      const order = samples.map((s, i) => ({ ts: s.ts, v: ms[i] ?? 0 })).sort((a, b) => a.ts - b.ts);
      if (order.every((x, i) => i === 0 || x.v >= (order[i - 1]?.v ?? 0))) return { ...base, class: "timestamp", hints: [] };
    }
  }

  if (allPresent && sessionCount >= 2) {
    const perSession = new Map<string, Set<string>>();
    samples.forEach((s, i) => {
      const set = perSession.get(s.session) ?? new Set<string>();
      set.add(present[i] ?? "");
      perSession.set(s.session, set);
    });
    const each = [...perSession.values()];
    const firsts = each.map((s) => [...s][0] ?? "");
    if (each.every((s) => s.size === 1) && new Set(firsts).size === firsts.length) return { ...base, class: "session", hints: [] };
  }

  const hints: ParamHint[] = [];
  if (allPresent) {
    if (looksSignature(present)) hints.push("looks-signature");
    else if (looksRandom(present)) hints.push("looks-random");
  }
  return { ...base, class: "varying", hints };
}

/** `input`: a varying query / body value that another varying query / body parameter also carried in the same bundle. */
function markInputs(out: DiffGroup[], groups: ReadonlyMap<string, GroupAcc>): void {
  const eligible = (p: DiffParam) => p.class === "varying" && (p.location === "query" || p.location === "json" || p.location === "form");
  const usable = (v: string) => v.length >= 2 && !/^\d+$/.test(v);
  // bundle -> value -> param ids
  const index = new Map<number, Map<string, Set<string>>>();
  const idOf = (g: DiffGroup, p: DiffParam) => `${g.key} ${p.location} ${p.name}`;
  const valuesOf = (g: DiffGroup, p: DiffParam): { bundle: number; v: string }[] => {
    const acc = groups.get(g.key);
    if (acc === undefined) return [];
    const k = pkey(p.location, p.name);
    return acc.samples.flatMap((s) => {
      const v = s.params.get(k);
      return v === undefined || !usable(v) ? [] : [{ bundle: s.bundle, v }];
    });
  };
  for (const g of out) for (const p of g.params) {
    if (!eligible(p)) continue;
    for (const { bundle, v } of valuesOf(g, p)) {
      const byValue = index.get(bundle) ?? new Map<string, Set<string>>();
      index.set(bundle, byValue);
      const ids = byValue.get(v) ?? new Set<string>();
      ids.add(idOf(g, p));
      byValue.set(v, ids);
    }
  }
  for (const g of out) for (const p of g.params) {
    if (!eligible(p)) continue;
    const self = idOf(g, p);
    const also = new Set<string>();
    for (const { bundle, v } of valuesOf(g, p)) for (const id of index.get(bundle)?.get(v) ?? []) if (id !== self) also.add(id);
    if (also.size > 0) {
      p.hints.push("input");
      p.alsoIn = [...also].sort();
    }
  }
}

// ------------------------------------------------------------ text rendering

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u;

/** Terminal columns: East Asian wide characters take two. */
function displayWidth(s: string): number {
  let w = 0;
  for (const c of s) w += WIDE.test(c) ? 2 : 1;
  return w;
}

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - displayWidth(s)));

export function renderDiffText(r: DiffResult): string {
  const lines: string[] = [];
  lines.push(`diff of ${r.bundles.length} bundles, ${r.sessions} session(s)`);
  for (const b of r.bundles) lines.push(`  ${b.label}  ${b.dir}  session=${b.session === "" ? b.id : b.session}${b.complete ? "" : " (未收尾)"}  requests=${b.requests}`);
  for (const g of r.groups) {
    lines.push("");
    lines.push(`${g.key}  samples ${g.samples} (${g.perBundle.join("/")}), sessions ${g.sessions}`);
    const rows = g.params.map((p) => [p.location, p.name, p.class, p.hints.join(","), p.values.join(" | ") + (p.present < p.samples ? `  (in ${p.present}/${p.samples})` : "")]);
    const widths = [0, 1, 2, 3].map((i) => Math.min(32, Math.max(...rows.map((row) => displayWidth(row[i] ?? "")), 0)));
    for (const row of rows) lines.push("  " + row.map((cell, i) => (i < 4 ? pad(cell, widths[i] ?? 0) : cell)).join("  ").trimEnd());
  }
  if (r.singleSampleGroups.length > 0) lines.push("", `single sample (not compared): ${r.singleSampleGroups.join(", ")}`);
  const s = r.summary;
  lines.push("", `summary: constant ${s.constant}, timestamp ${s.timestamp}, session ${s.session}, constant-or-session ${s["constant-or-session"]}, varying ${s.varying}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
