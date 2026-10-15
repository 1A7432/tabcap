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
// Oracle: the recorded bundle itself (status, headers, blob bytes); tests in
// test/unit/replay-match.test.ts build bundles with the writer and compare the
// served bytes with the blobs by sha256. Reproduce: bun test test/unit/replay-match.test.ts

import { sha256Hex } from "../shared/ids.ts";
import type { BundleReader } from "../bundle/reader.ts";
import type { Headers, RequestEvent } from "../bundle/types.ts";
import { extractParams, splitKey, type ParamSource } from "../analyze/diff.ts";
import { utf8 } from "../analyze/decoders.ts";
import { EMPTY_SHA256, HOP_BY_HOP, headerJoined, headerList, normalizeCookieHeader, requestBodyBytes } from "./common.ts";

export type MatchOptions = { strict: readonly string[]; matchCookies: boolean };

/** `host`: the request's Host (`URL.host` form), or null when unknown. */
export type Incoming = { method: string; url: string; headers: Headers; body: Uint8Array; host?: string | null };

export type Recording = {
  id: string;
  seq: number;
  method: string;
  /** Recorded `URL.host` (lowercase), e.g. `api.example.test:8443`. */
  host: string;
  path: string;
  /** Decoded query pairs sorted by name, then value. */
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
};

export type Matched = { recording: Recording; n: number; of: number };

export type QueryDiff = { missing: string[]; extra: string[]; changed: string[] };

export type Candidate = {
  id: string;
  method: string;
  /** Only in multi-host bundles. */
  host?: string;
  path: string;
  query: string;
  recordings: number;
  differs: {
    method?: { recorded: string; got: string };
    host?: { recorded: string; got: string };
    query?: QueryDiff;
    body?: { recordedSha256: string; gotSha256: string; fields: QueryDiff | null };
    headers?: string[];
    cookie?: boolean;
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

/** `host` null: not part of the key (single-host bundles, or an unknown incoming host). */
export function keyOf(
  parts: { method: string; path: string; query: readonly [string, string][]; bodySha256: string; strict: readonly (string | null)[]; cookie: string | null; host?: string | null },
  opts: MatchOptions,
): string {
  const head = parts.host === undefined || parts.host === null ? [] : [parts.host.toLowerCase()];
  return JSON.stringify([...head, parts.method.toUpperCase(), parts.path, queryText(parts.query), parts.bodySha256, ...parts.strict, ...(opts.matchCookies ? [parts.cookie ?? ""] : [])]);
}

function pathAndSearch(url: string): { path: string; search: string; host: string } | null {
  try {
    const u = new URL(url, "http://replay.invalid");
    return { path: u.pathname, search: u.search, host: u.host.toLowerCase() };
  } catch {
    return null;
  }
}

export class ReplayIndex {
  readonly recordings: Recording[] = [];
  /** Recorded hosts; more than one puts the host into the match key. */
  readonly hosts: ReadonlySet<string>;
  private readonly byKey = new Map<string, Recording[]>();
  private readonly byLoose = new Map<string, Recording[]>();
  private readonly counters = new Map<string, number>();

  constructor(
    requests: readonly RequestEvent[],
    readonly reader: Pick<BundleReader, "readBlob">,
    readonly opts: MatchOptions,
  ) {
    const hosts = new Set<string>();
    for (const r of requests) {
      const ps = pathAndSearch(r.url);
      if (ps !== null) hosts.add(ps.host);
    }
    this.hosts = hosts;
    const multiHost = hosts.size > 1;
    for (const r of requests) {
      const ps = pathAndSearch(r.url);
      if (ps === null) continue;
      const body = requestBodyBytes(r, reader);
      const rec: Recording = {
        id: r.id,
        seq: r.seq,
        method: r.method.toUpperCase(),
        host: ps.host,
        path: ps.path,
        query: sortedQuery(ps.search),
        bodySha256: "bytes" in body ? sha256Hex(body.bytes) : null,
        bodyMissing: "missing" in body ? body.missing : null,
        strict: opts.strict.map((h) => headerJoined(r.request.headers, h)),
        cookie: opts.matchCookies ? normalizeCookieHeader(headerJoined(r.request.headers, "cookie")) : null,
        key: "",
        looseKey: "",
        request: r,
      };
      rec.looseKey = keyOf({ ...rec, host: null, bodySha256: rec.bodySha256 ?? BODY_ANY }, opts);
      rec.key = multiHost ? keyOf({ ...rec, bodySha256: rec.bodySha256 ?? BODY_ANY }, opts) : rec.looseKey;
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

  /** The host to key on for an incoming request: only in a multi-host bundle, and only a recorded host. */
  private keyHost(req: Incoming): string | null {
    const h = (req.host ?? "").toLowerCase();
    return this.hosts.size > 1 && this.hosts.has(h) ? h : null;
  }

  /** Distinct keys with their recordings, in first-recorded order. */
  routes(): { key: string; recordings: Recording[] }[] {
    return [...this.byKey.entries()].map(([key, recordings]) => ({ key, recordings })).sort((a, b) => (a.recordings[0]?.seq ?? 0) - (b.recordings[0]?.seq ?? 0));
  }

  private incomingParts(req: Incoming): { method: string; host: string | null; path: string; query: [string, string][]; bodySha256: string; strict: (string | null)[]; cookie: string | null } | null {
    const ps = pathAndSearch(req.url);
    if (ps === null) return null;
    return {
      method: req.method.toUpperCase(),
      host: this.keyHost(req),
      path: ps.path,
      query: sortedQuery(ps.search),
      bodySha256: req.body.length === 0 ? EMPTY_SHA256 : sha256Hex(req.body),
      strict: this.opts.strict.map((h) => headerJoined(req.headers, h)),
      cookie: this.opts.matchCookies ? normalizeCookieHeader(headerJoined(req.headers, "cookie")) : null,
    };
  }

  /** The next recording for this request (cycling per key), or null. */
  match(req: Incoming): Matched | null {
    const parts = this.incomingParts(req);
    if (parts === null) return null;
    // A recorded host keys on the host (multi-host bundles); anything else on the loose key.
    const map = parts.host === null ? this.byLoose : this.byKey;
    let key = keyOf(parts, this.opts);
    let list = map.get(key);
    if (list === undefined) {
      key = keyOf({ ...parts, bodySha256: BODY_ANY }, this.opts);
      list = map.get(key);
    }
    if (list === undefined || list.length === 0) return null;
    const i = this.counters.get(key) ?? 0;
    this.counters.set(key, i + 1);
    const recording = list[i % list.length];
    if (recording === undefined) return null;
    return { recording, n: (i % list.length) + 1, of: list.length };
  }

  /** Up to `max` nearest recordings: same method + path first, then same path; fewest differing parts first. */
  nearest(req: Incoming, max = 3): Candidate[] {
    const parts = this.incomingParts(req);
    if (parts === null) return [];
    const samePath = this.recordings.filter((r) => r.path === parts.path);
    const tiers = [samePath.filter((r) => r.method === parts.method), samePath.filter((r) => r.method !== parts.method)];
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
      const scored = firstPerKey
        .map((r) => ({ r, c: this.explain(r, parts, incomingParams) }))
        .sort((a, b) => Object.keys(a.c.differs).length - Object.keys(b.c.differs).length || a.r.seq - b.r.seq);
      for (const { c } of scored) {
        if (out.length >= max) return out;
        out.push(c);
      }
    }
    return out;
  }

  private explain(
    r: Recording,
    parts: { method: string; host: string | null; query: [string, string][]; bodySha256: string; strict: (string | null)[]; cookie: string | null },
    incoming: Map<string, string>,
  ): Candidate {
    const recParams = extractParams(r.request, (ref) => this.reader.readBlob(ref), () => undefined);
    const differs: Candidate["differs"] = {};
    if (r.method !== parts.method) differs.method = { recorded: r.method, got: parts.method };
    if (parts.host !== null && r.host !== parts.host) differs.host = { recorded: r.host, got: parts.host };
    const q = compareParams(recParams, incoming, (loc) => loc === "query");
    if (q !== null) differs.query = q;
    if (r.bodySha256 !== null && r.bodySha256 !== parts.bodySha256) {
      differs.body = { recordedSha256: r.bodySha256, gotSha256: parts.bodySha256, fields: compareParams(recParams, incoming, (loc) => loc === "json" || loc === "form") };
    }
    const h = this.opts.strict.filter((_, i) => (r.strict[i] ?? null) !== (parts.strict[i] ?? null));
    if (h.length > 0) differs.headers = h;
    if (this.opts.matchCookies && r.cookie !== parts.cookie) differs.cookie = true;
    return { id: r.id, method: r.method, ...(this.hosts.size > 1 ? { host: r.host } : {}), path: r.path, query: queryText(r.query), recordings: this.byKey.get(r.key)?.length ?? 1, differs };
  }
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
