// `tabcap replay serve <bundle>`: an offline replay server for a recorded
// bundle (docs/03 §5 `replay`, §4 离线回放优先). Loopback only. Matching and
// response building live in ./match.ts; this file is the Bun.serve shell.
// Key rules (0.6-C, ./rules.ts): with rules the `x-tabcap-replay` header
// names the rule that applied (`r-N;n=k;rule=<id>`), `x-tabcap-replay-ignored`
// lists the ignored query names / body fields whose values differed from the
// recording that answered, and the 404 names the rule and, per candidate,
// which parts differ (`query`, `body`, `ignored`). Body "decoded" rules decode
// each incoming body with the plugin(s) first (./plaintext.ts).
// Oracle: the bundle's recorded status / headers / blobs. Reproduce:
//   bun test test/unit/replay-server.test.ts

import { BundleReader } from "../bundle/reader.ts";
import { sha256Hex } from "../shared/ids.ts";
import { MAX_REQUEST_BODY, checkLoopbackListen, headerJoined, replayableRequests, requestBodyBytes, type Skipped } from "./common.ts";
import { ReplayIndex, buildResponse, queryText, recordedViewPlain, type Incoming, type Plain } from "./match.ts";
import { NO_RULES, pickRule, rulesInfo, type RuleSet } from "./rules.ts";
import { Plaintexts } from "./plaintext.ts";

export type ServeOptions = {
  bundle: string;
  host: string;
  port: number;
  strict: readonly string[];
  matchCookies: boolean;
  /** One line per served request (text mode); null: silent. */
  log?: ((line: string) => void) | null;
  /** Key rules (0.6-C); absent: the 0.3-B key. */
  rules?: RuleSet;
  /** Where decode plugins are installed (body "decoded" rules). */
  configDir?: string;
};

/** `host` only when the bundle spans several hosts (it is then part of the match key). */
export type RouteInfo = { method: string; host?: string; path: string; query: string; bodySha256: string | null; recordings: number; ids: string[]; rule?: string };

export const MAX_LISTED = 500;

export type ServeInfo = {
  bundle: string;
  url: string;
  host: string;
  port: number;
  complete: boolean;
  match: { strict: string[]; cookies: boolean; host: boolean };
  /** Where the key rules come from and how many there are (0.6-C). */
  rules: ReturnType<typeof rulesInfo>;
  /** Distinct match keys (at most MAX_LISTED listed; `routeCount` is the total). */
  routes: RouteInfo[];
  routeCount: number;
  recordings: number;
  skipped: Skipped[];
  skippedCount: number;
  warnings: string[];
};

export type ReplayServer = { info: ServeInfo; stop: () => void; readonly served: number };

function incomingHeaders(h: globalThis.Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of h) out[k.toLowerCase()] = v;
  return out;
}

/** Header-safe spelling of a name list: visible ASCII kept, `%`, `,`, `;` and anything else percent-encoded. */
function nameList(names: readonly string[]): string {
  return names.map((n) => n.replace(/[^\x21-\x7e]|[%,;]/gu, (c) => encodeURIComponent(c))).join(",");
}

export async function startReplayServer(opts: ServeOptions): Promise<ReplayServer> {
  checkLoopbackListen(opts.host);
  const reader = BundleReader.open(opts.bundle);
  const { requests, skipped } = replayableRequests(reader);
  const rules = opts.rules ?? NO_RULES;
  const withRules = rules.rules.length > 0;
  const plaintexts = withRules && rules.rules.some((r) => r.key.body === "decoded") ? new Plaintexts(opts.configDir ?? "") : null;
  const warnings: string[] = [];
  // Recorded request bodies a decodeWith plugin has to decode (no view of that plugin).
  const plain = new Map<string, Plain>();
  if (plaintexts !== null) {
    for (const name of new Set(rules.rules.flatMap((r) => (r.key.decodeWith === null ? [] : [r.key.decodeWith])))) {
      const why = plaintexts.problem(name);
      if (why !== null) warnings.push(`${why}: requests of the rules naming it are keyed on their raw bytes`);
    }
    let noView = 0;
    for (const r of requests) {
      const rule = pickRule(rules, r);
      if (rule.key.body !== "decoded") continue;
      const body = requestBodyBytes(r, reader);
      if (!("bytes" in body) || body.bytes.length === 0) continue;
      if (recordedViewPlain(r, reader, rule.key.decodeWith) !== null) continue;
      if (rule.key.decodeWith === null) {
        noView++;
        continue;
      }
      plain.set(
        r.id,
        await plaintexts.decode(rule.key.decodeWith, { direction: "request", id: r.id, url: r.url, method: r.method, requestHeaders: r.request.headers, response: null, body: body.bytes, mime: headerJoined(r.request.headers, "content-type") }),
      );
    }
    if (noView > 0) warnings.push(`${noView} recorded request(s) of body "decoded" rules have no decoded view and their rule names no decodeWith plugin: keyed on their raw bytes (run tabcap bundle decode, or set key.decodeWith)`);
    const failed = [...plain.values()].filter((p) => "error" in p).length;
    if (failed > 0) warnings.push(`${failed} recorded request body/bodies could not be decoded by their rule's decodeWith plugin: keyed on their raw bytes`);
  }
  const index = new ReplayIndex(requests, reader, { strict: opts.strict, matchCookies: opts.matchCookies, rules }, plain);
  const log = opts.log ?? null;
  let served = 0;

  /** Decode an incoming body with every plugin its body "decoded" rules may use. */
  const decodeIncoming = async (incoming: Incoming): Promise<Incoming> => {
    if (plaintexts === null) return incoming;
    const needs = index.pluginsFor(incoming);
    if (needs.length === 0) return incoming;
    const decoded = new Map<string, Plain>();
    for (const { plugin, url } of needs) {
      decoded.set(
        plugin,
        incoming.body.length === 0
          ? { error: "empty body" }
          : await plaintexts.decode(plugin, { direction: "request", id: null, url, method: incoming.method, requestHeaders: incoming.headers, response: null, body: incoming.body, mime: headerJoined(incoming.headers, "content-type") }),
      );
    }
    return { ...incoming, decoded };
  };

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    maxRequestBodySize: MAX_REQUEST_BODY,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      // url.host is the request's Host header: a client can name the recorded origin it means (multi-host bundles).
      const incoming = await decodeIncoming({ method: req.method, url: `${url.pathname}${url.search}`, headers: incomingHeaders(req.headers), body, host: url.host });
      const m = index.match(incoming);
      served++;
      if (m === null) {
        const candidates = index.nearest(incoming);
        log?.(`${req.method} ${url.pathname}${url.search} -> 404 no match (${candidates.length} candidate(s))`);
        const payload = {
          error: "no-match",
          message: `no recording for ${req.method} ${url.pathname}`,
          next: candidates.length > 0 ? "Compare with the candidates below: the listed key parts differ from the recording." : "Nothing was recorded on this path; record it first (tabcap net start, then load the page).",
          request: { method: req.method, path: url.pathname, query: queryText([...url.searchParams]), bodySha256: sha256Hex(body), ...(withRules ? { rule: index.ruleOf(incoming).id } : {}) },
          candidates,
        };
        return new Response(JSON.stringify(payload, null, 2) + "\n", { status: 404, headers: { "content-type": "application/json; charset=utf-8", "x-tabcap-replay": "no-match" } });
      }
      const r = buildResponse(m.recording, reader, m.n);
      log?.(`${req.method} ${url.pathname}${url.search} -> ${m.recording.id} n=${m.n}/${m.of} ${r.status}${withRules ? ` rule ${m.rule.id}` : ""}${r.missing === null ? "" : ` (body missing: ${r.missing})`}`);
      const headers = new Headers();
      for (const [k, v] of r.headers) headers.append(k, k === "x-tabcap-replay" && withRules ? `${v};rule=${m.rule.id}` : v);
      const ign = [...(m.ignored.query.length > 0 ? [`query=${nameList(m.ignored.query)}`] : []), ...(m.ignored.body.length > 0 ? [`body=${nameList(m.ignored.body)}`] : [])];
      if (ign.length > 0) headers.set("x-tabcap-replay-ignored", ign.join(";"));
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
    },
    error(e) {
      return new Response(JSON.stringify({ error: "internal", message: e.message }) + "\n", { status: 500, headers: { "content-type": "application/json" } });
    },
  });

  const routes = index.routes();
  const port = server.port ?? opts.port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  if (!reader.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted");
  if (reader.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  if (index.hosts.size > 1) warnings.push(`the bundle spans ${index.hosts.size} hosts (${[...index.hosts].sort().join(", ")}): a request whose Host header names one of them matches that host only; any other Host matches on method, path, query and body alone`);
  if (requests.some((r) => r.request.postDataMissing !== undefined)) warnings.push("some recorded request bodies are missing: those recordings match any request body");
  const info: ServeInfo = {
    bundle: opts.bundle,
    url: `http://${host}:${port}`,
    host: opts.host,
    port,
    complete: reader.isComplete(),
    match: { strict: [...opts.strict], cookies: opts.matchCookies, host: index.hosts.size > 1 },
    rules: rulesInfo(rules),
    routes: routes.slice(0, MAX_LISTED).map(({ recordings }) => {
      const first = recordings[0];
      return {
        method: first?.method ?? "",
        ...(index.hosts.size > 1 ? { host: first?.host ?? "" } : {}),
        path: first?.path ?? "",
        query: first === undefined ? "" : queryText(first.query),
        bodySha256: first?.bodySha256 ?? null,
        recordings: recordings.length,
        ids: recordings.map((r) => r.id),
        ...(withRules && first !== undefined ? { rule: first.rule.id } : {}),
      };
    }),
    routeCount: routes.length,
    recordings: index.recordings.length,
    skipped: skipped.slice(0, MAX_LISTED),
    skippedCount: skipped.length,
    warnings,
  };
  return {
    info,
    stop: () => {
      void server.stop(true);
      plaintexts?.close();
    },
    get served() {
      return served;
    },
  };
}
