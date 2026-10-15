// `tabcap replay serve <bundle>`: an offline replay server for a recorded
// bundle (docs/03 §5 `replay`, §4 离线回放优先). Loopback only. Matching and
// response building live in ./match.ts; this file is the Bun.serve shell.
// Oracle: the bundle's recorded status / headers / blobs. Reproduce:
//   bun test test/unit/replay-server.test.ts

import { BundleReader } from "../bundle/reader.ts";
import { sha256Hex } from "../shared/ids.ts";
import { MAX_REQUEST_BODY, checkLoopbackListen, replayableRequests, type Skipped } from "./common.ts";
import { ReplayIndex, buildResponse, queryText, type Incoming } from "./match.ts";

export type ServeOptions = {
  bundle: string;
  host: string;
  port: number;
  strict: readonly string[];
  matchCookies: boolean;
  /** One line per served request (text mode); null: silent. */
  log?: ((line: string) => void) | null;
};

/** `host` only when the bundle spans several hosts (it is then part of the match key). */
export type RouteInfo = { method: string; host?: string; path: string; query: string; bodySha256: string | null; recordings: number; ids: string[] };

export const MAX_LISTED = 500;

export type ServeInfo = {
  bundle: string;
  url: string;
  host: string;
  port: number;
  complete: boolean;
  match: { strict: string[]; cookies: boolean; host: boolean };
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

export function startReplayServer(opts: ServeOptions): ReplayServer {
  checkLoopbackListen(opts.host);
  const reader = BundleReader.open(opts.bundle);
  const { requests, skipped } = replayableRequests(reader);
  const index = new ReplayIndex(requests, reader, { strict: opts.strict, matchCookies: opts.matchCookies });
  const log = opts.log ?? null;
  let served = 0;

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    maxRequestBodySize: MAX_REQUEST_BODY,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      // url.host is the request's Host header: a client can name the recorded origin it means (multi-host bundles).
      const incoming: Incoming = { method: req.method, url: `${url.pathname}${url.search}`, headers: incomingHeaders(req.headers), body, host: url.host };
      const m = index.match(incoming);
      served++;
      if (m === null) {
        const candidates = index.nearest(incoming);
        log?.(`${req.method} ${url.pathname}${url.search} -> 404 no match (${candidates.length} candidate(s))`);
        const payload = {
          error: "no-match",
          message: `no recording for ${req.method} ${url.pathname}`,
          next: candidates.length > 0 ? "Compare with the candidates below: the listed key parts differ from the recording." : "Nothing was recorded on this path; record it first (tabcap net start, then load the page).",
          request: { method: req.method, path: url.pathname, query: queryText([...url.searchParams]), bodySha256: sha256Hex(body) },
          candidates,
        };
        return new Response(JSON.stringify(payload, null, 2) + "\n", { status: 404, headers: { "content-type": "application/json; charset=utf-8", "x-tabcap-replay": "no-match" } });
      }
      const r = buildResponse(m.recording, reader, m.n);
      log?.(`${req.method} ${url.pathname}${url.search} -> ${m.recording.id} n=${m.n}/${m.of} ${r.status}${r.missing === null ? "" : ` (body missing: ${r.missing})`}`);
      const headers = new Headers();
      for (const [k, v] of r.headers) headers.append(k, v);
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
    },
    error(e) {
      return new Response(JSON.stringify({ error: "internal", message: e.message }) + "\n", { status: 500, headers: { "content-type": "application/json" } });
    },
  });

  const routes = index.routes();
  const port = server.port ?? opts.port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  const warnings: string[] = [];
  if (!reader.isComplete()) warnings.push("bundle is not finished (未收尾): recording in progress or interrupted");
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
    },
    get served() {
      return served;
    },
  };
}
