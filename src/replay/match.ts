// Request matching and response building for `tabcap replay serve`
// (docs/03 §5 `replay`: 离线回放服务器，按请求匹配吐出录到的响应).
// Spec (approved 0.3-B design): match key = method + path + sorted query +
// sha256 of the request body (empty body = sha256 of zero bytes); `--strict`
// adds named request headers, `--match-cookies` the cookie header. Several
// recordings with one key are served in recorded order, cycling. No match →
// up to 3 nearest candidates (same method + path first, then same path) with
// the key parts that differ, using the parameter extraction of analyze diff.
// Multi-origin bundles (0.3-C): when the recorded requests span more than one
// host, the host (`URL.host`, from the incoming Host header) joins the key, so
// /api/x of two origins are told apart; a request whose Host is none of the
// recorded hosts (plain http://127.0.0.1:4500/...) matches without the host,
// as single-origin bundles always do.
// Key rules (0.6-C, rules.ts, docs/04 §31): with a rules document, the rule
// that fits a recording (host, path, method) decides its query (ignored
// names dropped, optionally case-insensitive) and body part (raw sha256,
// form pairs, canonical JSON, the decoded view, or none), and the rule's id
// joins the key. An incoming request is read under the rule of each recorded
// host it may mean (its Host, else every recorded host); body "decoded" reads
// the plaintext of each plugin that may decode it (replay serve decodes ahead).
// Without rules every request gets the 0.3-B key above.
// Oracle: the recorded bundle itself (status, headers, blob bytes); tests in
// test/unit/replay-match.test.ts build bundles with the writer and compare the
// served bytes with the blobs by sha256. Reproduce: bun test test/unit/replay-match.test.ts

import { sha256Hex } from "../shared/ids.ts";
import type { BundleReader } from "../bundle/reader.ts";
import type { Headers, RequestEvent } from "../bundle/types.ts";
import { extractParams, splitKey, type ParamSource } from "../analyze/diff.ts";
import { utf8 } from "../analyze/decoders.ts";
import { decodedPayload } from "../analyze/views.ts";
import { HOP_BY_HOP, headerJoined, headerList, normalizeCookieHeader, requestBodyBytes } from "./common.ts";
import {
  DEFAULT_RULE,
  NO_RULES,
  bodyKeyPart,
  canonicalBody,
  canonicalQuery,
  differingIgnored,
  pickRule,
  type CanonBody,
  type CanonQuery,
  type CompiledRule,
  type RuleSet,
} from "./rules.ts";

/** `rules` (0.6-C): the key rules; absent = the 0.3-B key for every request. */
export type MatchOptions = { strict: readonly string[]; matchCookies: boolean; rules?: RuleSet };

/** A decoded request body: the plaintext, or why there is none. */
export type Plain = { bytes: Uint8Array; mime: string | null } | { error: string };

/**
 * `host`: the request's Host (`URL.host` form), or null when unknown.
 * `decoded`: the request body as decoded by each named plugin (body "decoded" rules; replay serve fills it).
 */
export type Incoming = { method: string; url: string; headers: Headers; body: Uint8Array; host?: string | null; decoded?: ReadonlyMap<string, Plain> };

export type Recording = {
  id: string;
  seq: number;
  method: string;
  /** Recorded `URL.host` (lowercase), e.g. `api.example.test:8443`. */
  host: string;
  path: string;
  /** Decoded query pairs sorted by name, then value (the rule's canonical query: ignored names dropped). */
  query: [string, string][];
  /** null: the recorder could not get the request body, so any body matches. */
  bodySha256: string | null;
  bodyMissing: string | null;
  strict: (string | null)[];
  cookie: string | null;
  /** Match key; includes the host when the bundle has several hosts. */
  key: string;
  /** Match key without the host (requests whose Host is not a recorded one). */
  looseKey: string;
  request: RequestEvent;
  /** The key rule that applies (0.6-C; DEFAULT_RULE without rules). */
  rule: CompiledRule;
  canonQuery: CanonQuery;
  /** The rule's reading of the request body; null when the body is missing. */
  body: CanonBody | null;
};

/** `ignored`: the ignored query names / body fields whose values differ from the recording that answered. */
export type Matched = { recording: Recording; n: number; of: number; rule: CompiledRule; ignored: { query: string[]; body: string[] } };

export type QueryDiff = { missing: string[]; extra: string[]; changed: string[] };

export type Candidate = {
  id: string;
  method: string;
  /** Only in multi-host bundles. */
  host?: string;
  path: string;
  query: string;
  recordings: number;
  /** The recording's key rule (only when rules are loaded). */
  rule?: string;
  differs: {
    method?: { recorded: string; got: string };
    host?: { recorded: string; got: string };
    query?: QueryDiff;
    body?: { recordedSha256: string; gotSha256: string; fields: QueryDiff | null; as?: CanonBody["as"]; fallback?: string };
    headers?: string[];
    cookie?: boolean;
    /** Ignored by the rule but different (rules only): query names, body fields. */
    ignored?: { query?: string[]; body?: string[] };
  };
};

const BODY_ANY = "*";

export function sortedQuery(search: string): [string, string][] {
  const pairs = [...new URLSearchParams(search)];
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

export function queryText(q: readonly [string, string][]): string {
  return q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** `host` null: not part of the key (single-host bundles, or an unknown incoming host). `rule`: the key rule's id (0.6-C). */
export function keyOf(
  parts: { method: string; path: string; query: readonly [string, string][]; bodySha256: string; strict: readonly (string | null)[]; cookie: string | null; host?: string | null; rule?: string },
  opts: MatchOptions,
): string {
  const head = parts.host === undefined || parts.host === null ? [] : [parts.host.toLowerCase()];
  const rule = parts.rule === undefined ? [] : [parts.rule];
  return JSON.stringify([...head, ...rule, parts.method.toUpperCase(), parts.path, queryText(parts.query), parts.bodySha256, ...parts.strict, ...(opts.matchCookies ? [parts.cookie ?? ""] : [])]);
}

function pathAndSearch(url: string): { path: string; search: string; host: string; origin: string } | null {
  try {
    const u = new URL(url, "http://replay.invalid");
    return { path: u.pathname, search: u.search, host: u.host.toLowerCase(), origin: u.origin };
  } catch {
    return null;
  }
}

/** The recorded request body's plaintext for a body "decoded" rule, from the recorded view (null: no usable view). */
export function recordedViewPlain(r: RequestEvent, reader: Pick<BundleReader, "readBlob">, decodeWith: string | null): Plain | null {
  const v = r.request.decoded;
  if (v === undefined || !v.ok || (decodeWith !== null && v.by !== decodeWith)) return null;
  const p = decodedPayload(reader, v);
  return p === null ? { error: `the decoded view of ${v.by} is missing or too large` } : { bytes: p.bytes, mime: p.mime };
}

type Parts = {
  method: string;
  host: string | null;
  path: string;
  query: [string, string][];
  canonQuery: CanonQuery;
  body: CanonBody;
  bodyKey: string;
  /** sha256 of the incoming body bytes (diagnostics). */
  bodySha256: string;
  strict: (string | null)[];
  cookie: string | null;
  rule: CompiledRule;
};

export class ReplayIndex {
  readonly recordings: Recording[] = [];
  /** Recorded hosts; more than one puts the host into the match key. */
  readonly hosts: ReadonlySet<string>;
  readonly rules: RuleSet;
  private readonly origins = new Map<string, string>();
  private readonly byKey = new Map<string, Recording[]>();
  private readonly byLoose = new Map<string, Recording[]>();
  private readonly counters = new Map<string, number>();
  /** Plugins whose views the recordings of a body "decoded" rule without decodeWith carry. */
  private readonly rulePlugins = new Map<string, Set<string>>();

  /** `plain`: recorded request plaintexts decoded ahead (decodeWith plugins, replay serve); views are read here. */
  constructor(
    requests: readonly RequestEvent[],
    readonly reader: Pick<BundleReader, "readBlob">,
    readonly opts: MatchOptions,
    plain: ReadonlyMap<string, Plain> = new Map(),
  ) {
    this.rules = opts.rules ?? NO_RULES;
    const hosts = new Set<string>();
    for (const r of requests) {
      const ps = pathAndSearch(r.url);
      if (ps === null) continue;
      hosts.add(ps.host);
      if (!this.origins.has(ps.host)) this.origins.set(ps.host, ps.origin);
    }
    this.hosts = hosts;
    const multiHost = hosts.size > 1;
    for (const r of requests) {
      const ps = pathAndSearch(r.url);
      if (ps === null) continue;
      const rule = pickRule(this.rules, r);
      const body = requestBodyBytes(r, reader);
      const cq = canonicalQuery(ps.search, rule);
      let cb: CanonBody | null = null;
      if ("bytes" in body) {
        const p = rule.key.body === "decoded" ? (plain.get(r.id) ?? recordedViewPlain(r, reader, rule.key.decodeWith)) : null;
        cb = canonicalBody(body.bytes, rule, p);
      }
      const view = r.request.decoded;
      if (rule.key.body === "decoded" && rule.key.decodeWith === null && view !== undefined && view.ok) {
        const set = this.rulePlugins.get(rule.id) ?? new Set<string>();
        set.add(view.by);
        this.rulePlugins.set(rule.id, set);
      }
      const rec: Recording = {
        id: r.id,
        seq: r.seq,
        method: r.method.toUpperCase(),
        host: ps.host,
        path: ps.path,
        query: cq.pairs,
        bodySha256: "bytes" in body ? sha256Hex(body.bytes) : null,
        bodyMissing: "missing" in body ? body.missing : null,
        strict: opts.strict.map((h) => headerJoined(r.request.headers, h)),
        cookie: opts.matchCookies ? normalizeCookieHeader(headerJoined(r.request.headers, "cookie")) : null,
        key: "",
        looseKey: "",
        request: r,
        rule,
        canonQuery: cq,
        body: cb,
      };
      const bodyKey = cb === null ? BODY_ANY : this.bodyKey(cb);
      rec.looseKey = this.keyFor({ ...rec, host: null }, bodyKey);
      rec.key = multiHost ? this.keyFor(rec, bodyKey) : rec.looseKey;
      this.recordings.push(rec);
      for (const [map, k] of [
        [this.byKey, rec.key],
        [this.byLoose, rec.looseKey],
      ] as const) {
        const list = map.get(k) ?? [];
        list.push(rec);
        map.set(k, list);
      }
    }
    for (const list of [...this.byKey.values(), ...this.byLoose.values()]) list.sort((a, b) => a.seq - b.seq);
  }

  private get withRules(): boolean {
    return this.rules.rules.length > 0;
  }

  /** Body part of a key: the 0.3-B sha256 without rules, the rule's reading with them. */
  private bodyKey(b: CanonBody): string {
    return this.withRules ? bodyKeyPart(b) : b.digest;
  }

  private keyFor(p: { method: string; path: string; query: readonly [string, string][]; strict: readonly (string | null)[]; cookie: string | null; host?: string | null; rule: CompiledRule }, bodyKey: string): string {
    const { rule, ...rest } = p;
    return keyOf({ ...rest, bodySha256: bodyKey, ...(this.withRules ? { rule: rule.id } : {}) }, this.opts);
  }

  /** The host to key on for an incoming request: only in a multi-host bundle, and only a recorded host. */
  private keyHost(req: Incoming): string | null {
    const h = (req.host ?? "").toLowerCase();
    return this.hosts.size > 1 && this.hosts.has(h) ? h : null;
  }

  /** Distinct keys with their recordings, in first-recorded order. */
  routes(): { key: string; recordings: Recording[] }[] {
    return [...this.byKey.entries()].map(([key, recordings]) => ({ key, recordings })).sort((a, b) => (a.recordings[0]?.seq ?? 0) - (b.recordings[0]?.seq ?? 0));
  }

  /** The recorded hosts an incoming request may mean: its Host when that is one, else all (first recorded first). */
  private candidateHosts(req: Incoming): string[] {
    const known = this.keyHost(req);
    return known !== null ? [known] : [...this.origins.keys()];
  }

  /** The incoming request's URL on one recorded origin (rule match, plugin match). */
  private urlFor(req: Incoming, host: string): string {
    const origin = this.origins.get(host) ?? "http://replay.invalid";
    const ps = pathAndSearch(req.url);
    return ps === null ? origin : `${origin}${ps.path}${ps.search}`;
  }

  /** The decode plugins an incoming body has to go through (body "decoded" rules), each with the URL to decode it as. */
  pluginsFor(req: Incoming): { plugin: string; url: string }[] {
    const out = new Map<string, string>();
    for (const h of this.candidateHosts(req)) {
      const url = this.urlFor(req, h);
      const rule = pickRule(this.rules, { url, method: req.method });
      for (const n of this.decoders(rule)) if (!out.has(n)) out.set(n, url);
    }
    return [...out].map(([plugin, url]) => ({ plugin, url }));
  }

  private decoders(rule: CompiledRule): string[] {
    if (rule.key.body !== "decoded") return [];
    return rule.key.decodeWith !== null ? [rule.key.decodeWith] : [...(this.rulePlugins.get(rule.id) ?? [])].sort();
  }

  /** The incoming request read under `rule`: one reading per plugin that may decode its body. */
  private incomingParts(req: Incoming, rule: CompiledRule, keyHost: string | null): Parts[] {
    const ps = pathAndSearch(req.url);
    if (ps === null) return [];
    const cq = canonicalQuery(ps.search, rule);
    const names = this.decoders(rule);
    const bodies =
      rule.key.body === "decoded" && names.length > 0
        ? names.map((n) => canonicalBody(req.body, rule, req.decoded?.get(n) ?? { error: `not decoded by ${n}` }))
        : [canonicalBody(req.body, rule, null)];
    const sha = sha256Hex(req.body);
    const seen = new Set<string>();
    const out: Parts[] = [];
    for (const body of bodies) {
      const bodyKey = this.bodyKey(body);
      if (seen.has(bodyKey)) continue;
      seen.add(bodyKey);
      out.push({
        method: req.method.toUpperCase(),
        host: keyHost,
        path: ps.path,
        query: cq.pairs,
        canonQuery: cq,
        body,
        bodyKey,
        bodySha256: sha,
        strict: this.opts.strict.map((h) => headerJoined(req.headers, h)),
        cookie: this.opts.matchCookies ? normalizeCookieHeader(headerJoined(req.headers, "cookie")) : null,
        rule,
      });
    }
    return out;
  }

  /** Every reading of an incoming request: per candidate host, its rule and bodies (one reading without rules). */
  private readings(req: Incoming): Parts[] {
    const keyHost = this.keyHost(req);
    if (!this.withRules) return this.incomingParts(req, DEFAULT_RULE, keyHost);
    const out: Parts[] = [];
    const seen = new Set<string>();
    for (const h of this.candidateHosts(req)) {
      const rule = pickRule(this.rules, { url: this.urlFor(req, h), method: req.method });
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      out.push(...this.incomingParts(req, rule, keyHost));
    }
    return out;
  }

  /** The next recording for this request (cycling per key), or null. */
  match(req: Incoming): Matched | null {
    for (const parts of this.readings(req)) {
      // A recorded host keys on the host (multi-host bundles); anything else on the loose key.
      const map = parts.host === null ? this.byLoose : this.byKey;
      let key = this.keyFor(parts, parts.bodyKey);
      let list = map.get(key);
      if (list === undefined) {
        key = this.keyFor(parts, BODY_ANY);
        list = map.get(key);
      }
      if (list === undefined || list.length === 0) continue;
      const i = this.counters.get(key) ?? 0;
      this.counters.set(key, i + 1);
      const recording = list[i % list.length];
      if (recording === undefined) return null;
      const ignored = {
        query: differingIgnored(recording.canonQuery.ignored, parts.canonQuery.ignored),
        body: recording.body === null ? [] : differingIgnored(recording.body.ignored, parts.body.ignored),
      };
      return { recording, n: (i % list.length) + 1, of: list.length, rule: recording.rule, ignored };
    }
    return null;
  }

  /** The rule an incoming request is read under (the first candidate host's); DEFAULT_RULE without rules. */
  ruleOf(req: Incoming): CompiledRule {
    if (!this.withRules) return DEFAULT_RULE;
    const h = this.candidateHosts(req)[0];
    return pickRule(this.rules, { url: h === undefined ? new URL(req.url, "http://replay.invalid").href : this.urlFor(req, h), method: req.method });
  }

  /** Up to `max` nearest recordings: same method + path first, then same path; fewest differing parts first. */
  nearest(req: Incoming, max = 3): Candidate[] {
    const ps = pathAndSearch(req.url);
    if (ps === null) return [];
    const method = req.method.toUpperCase();
    const keyHost = this.keyHost(req);
    const samePath = this.recordings.filter((r) => r.path === ps.path);
    const tiers = [samePath.filter((r) => r.method === method), samePath.filter((r) => r.method !== method)];
    const incomingParams = extractParams(incomingSource(req), () => null, () => undefined);
    const out: Candidate[] = [];
    const seenKeys = new Set<string>();
    for (const tier of tiers) {
      const firstPerKey: Recording[] = [];
      for (const r of tier) {
        if (seenKeys.has(r.key)) continue;
        seenKeys.add(r.key);
        firstPerKey.push(r);
      }
      const scored: { r: Recording; c: Candidate }[] = [];
      for (const r of firstPerKey) {
        // the incoming request read under the recording's own rule
        const parts = this.incomingParts(req, r.rule, keyHost)[0];
        if (parts !== undefined) scored.push({ r, c: this.explain(r, parts, incomingParams) });
      }
      scored.sort((a, b) => Object.keys(a.c.differs).length - Object.keys(b.c.differs).length || a.r.seq - b.r.seq);
      for (const { c } of scored) {
        if (out.length >= max) return out;
        out.push(c);
      }
    }
    return out;
  }

  private explain(r: Recording, parts: Parts, incoming: Map<string, string>): Candidate {
    const recParams = extractParams(r.request, (ref) => this.reader.readBlob(ref), () => undefined);
    const differs: Candidate["differs"] = {};
    if (r.method !== parts.method) differs.method = { recorded: r.method, got: parts.method };
    if (parts.host !== null && r.host !== parts.host) differs.host = { recorded: r.host, got: parts.host };
    if (!this.withRules || r.rule === DEFAULT_RULE) {
      // the 0.3-B explanation
      const q = compareParams(recParams, incoming, (loc) => loc === "query");
      if (q !== null) differs.query = q;
      if (r.bodySha256 !== null && r.bodySha256 !== parts.bodySha256) {
        differs.body = { recordedSha256: r.bodySha256, gotSha256: parts.bodySha256, fields: compareParams(recParams, incoming, (loc) => loc === "json" || loc === "form") };
      }
    } else {
      const q = compareMaps(pairMap(r.query), pairMap(parts.query));
      if (q !== null) differs.query = q;
      if (r.body !== null && this.bodyKey(r.body) !== parts.bodyKey) {
        const fields = r.body.fields !== null && parts.body.fields !== null && r.body.as === parts.body.as ? compareMaps(r.body.fields, parts.body.fields) : null;
        const fallback = parts.body.fallback ?? r.body.fallback;
        differs.body = { recordedSha256: r.bodySha256 ?? "", gotSha256: parts.bodySha256, fields, as: r.body.as, ...(fallback === null ? {} : { fallback }) };
      }
      const iq = differingIgnored(r.canonQuery.ignored, parts.canonQuery.ignored);
      const ib = r.body === null ? [] : differingIgnored(r.body.ignored, parts.body.ignored);
      if (iq.length + ib.length > 0) differs.ignored = { ...(iq.length > 0 ? { query: iq } : {}), ...(ib.length > 0 ? { body: ib } : {}) };
    }
    const h = this.opts.strict.filter((_, i) => (r.strict[i] ?? null) !== (parts.strict[i] ?? null));
    if (h.length > 0) differs.headers = h;
    if (this.opts.matchCookies && r.cookie !== parts.cookie) differs.cookie = true;
    return {
      id: r.id,
      method: r.method,
      ...(this.hosts.size > 1 ? { host: r.host } : {}),
      path: r.path,
      query: queryText(r.query),
      recordings: this.byKey.get(r.key)?.length ?? 1,
      ...(this.withRules ? { rule: r.rule.id } : {}),
      differs,
    };
  }
}

function pairMap(pairs: readonly [string, string][]): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const [k, v] of pairs) m.set(k, [...(m.get(k) ?? []), v]);
  return new Map([...m].map(([k, vs]) => [k, JSON.stringify(vs)]));
}

function compareMaps(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): QueryDiff | null {
  const missing = [...a.keys()].filter((k) => !b.has(k)).sort();
  const extra = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort();
  return missing.length + extra.length + changed.length === 0 ? null : { missing, extra, changed };
}

function incomingSource(req: Incoming): ParamSource {
  const text = req.body.length > 0 && req.body.length <= 1024 * 1024 ? utf8(req.body) : null;
  return { id: "incoming", url: new URL(req.url, "http://replay.invalid").href, request: { headers: req.headers, postData: text === null ? null : { inline: text } } };
}

function compareParams(recorded: Map<string, string>, got: Map<string, string>, where: (loc: string) => boolean): QueryDiff | null {
  const pick = (m: Map<string, string>) => new Map([...m].filter(([k]) => where(splitKey(k).location)).map(([k, v]) => [splitKey(k).name, v]));
  const a = pick(recorded);
  const b = pick(got);
  const missing = [...a.keys()].filter((k) => !b.has(k)).sort();
  const extra = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort();
  return missing.length + extra.length + changed.length === 0 ? null : { missing, extra, changed };
}

// ------------------------------------------------------------ responses

/** Statuses that must not carry a body (Fetch spec "null body status"). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DROP = new Set([...HOP_BY_HOP, "content-length", "content-encoding"]);

export type BuiltResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array | null;
  /** Why the body is empty although the recording had one (bodyMissing reason, or blob-missing). */
  missing: string | null;
  /** Recorded header fields that could not be sent (invalid name or value). */
  dropped: string[];
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Field values: visible ASCII, obs-text, space and tab; no CR / LF / NUL.
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Same-origin absolute `location` → path, so a client following it stays on the replay server. */
function relativeLocation(value: string, requestUrl: string): string {
  try {
    const base = new URL(requestUrl);
    const u = new URL(value, base);
    return u.origin === base.origin ? `${u.pathname}${u.search}${u.hash}` : value;
  } catch {
    return value;
  }
}

/** The recorded response for `rec`, ready to send. */
export function buildResponse(rec: Recording, reader: Pick<BundleReader, "readBlob">, n: number): BuiltResponse {
  const resp = rec.request.response;
  const status = resp?.status ?? 502;
  const headers: [string, string][] = [];
  const dropped: string[] = [];
  const recorded = resp?.headers ?? {};
  for (const name of Object.keys(recorded)) {
    const lower = name.toLowerCase();
    if (DROP.has(lower) || lower.startsWith(":")) continue;
    for (const v0 of headerList(recorded, name)) {
      const v = lower === "location" ? relativeLocation(v0, rec.request.url) : v0;
      if (!TOKEN.test(lower) || !FIELD_VALUE.test(v)) {
        dropped.push(lower);
        continue;
      }
      headers.push([lower, v]);
    }
  }
  let body: Uint8Array | null = null;
  let missing: string | null = null;
  if (resp?.body) {
    const bytes = reader.readBlob(resp.body.blob);
    if (bytes === null) missing = "blob-missing";
    else body = bytes;
  } else if (resp?.bodyMissing) missing = resp.bodyMissing.reason;
  if (NULL_BODY.has(status)) body = null;
  else {
    body ??= new Uint8Array(0);
    headers.push(["content-length", String(body.length)]);
  }
  headers.push(["x-tabcap-replay", `${rec.id};n=${n}`]);
  if (missing !== null) headers.push(["x-tabcap-replay-missing", missing]);
  if (resp?.body?.truncated === true) headers.push(["x-tabcap-replay-truncated", "1"]);
  if (dropped.length > 0) headers.push(["x-tabcap-replay-dropped", [...new Set(dropped)].join(",")]);
  const statusText = resp?.statusText ?? "";
  return { status, statusText: FIELD_VALUE.test(statusText) ? statusText : "", headers, body, missing, dropped: [...new Set(dropped)] };
}
