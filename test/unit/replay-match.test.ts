// replay serve matcher (src/replay/match.ts): key building, cycling, nearest
// candidates, response header filtering. Expected bytes come from the blobs
// the builder stored (sha256 compared), not from hand-written hashes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import type { RequestEvent } from "../../src/bundle/types.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { EMPTY_SHA256, globMatcher, isLoopbackHost, replayableRequests } from "../../src/replay/common.ts";
import { ReplayIndex, buildResponse, keyOf, sortedQuery, type Incoming } from "../../src/replay/match.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { startReplayServer } from "../../src/replay/server.ts";
import { CSRF, FEED, ITEMS1, LOGIN_BODY, ORIGIN, SEARCH, SID, buildReplayBundle } from "./_replay.ts";
import { SLOW_IO_MS } from "./_platform.ts";

let dir = "";
let reader: BundleReader;
let requests: RequestEvent[] = [];

const enc = new TextEncoder();
const get = (url: string, headers: Record<string, string> = {}): Incoming => ({ method: "GET", url, headers, body: new Uint8Array(0) });
const post = (url: string, body: string, headers: Record<string, string> = {}): Incoming => ({ method: "POST", url, headers, body: enc.encode(body) });
const blobSha = (r: RequestEvent): string => {
  const ref = r.response?.body?.blob ?? "";
  const b = reader.readBlob(ref);
  if (b === null) throw new Error(`no blob for ${r.id}`);
  return sha256Hex(b);
};
const byUrl = (suffix: string): RequestEvent[] => requests.filter((r) => r.url.endsWith(suffix));

beforeAll(async () => {
  dir = join(tmp("tabcap-replay-m-"), "b");
  await buildReplayBundle(dir);
  reader = BundleReader.open(dir);
  requests = replayableRequests(reader).requests;
}, SLOW_IO_MS);
afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }), SLOW_IO_MS);

describe("key building", () => {
  test("query order does not matter; values and repeated names do", () => {
    expect(sortedQuery("?b=2&a=1&a=0")).toEqual([["a", "0"], ["a", "1"], ["b", "2"]]);
    const o = { strict: [], matchCookies: false };
    const k = (q: string) => keyOf({ method: "get", path: "/x", query: sortedQuery(q), bodySha256: EMPTY_SHA256, strict: [], cookie: null }, o);
    expect(k("?a=1&b=2")).toBe(k("?b=2&a=1"));
    expect(k("?a=1&b=2")).not.toBe(k("?a=1&b=3"));
    expect(k("?a=1")).not.toBe(k("?a=1&a=1"));
    // percent-encoding spelling does not matter (decoded pairs)
    expect(k("?q=%E8%8B%B9")).toBe(k("?q=苹"));
  });

  test("empty body hashes to the constant sha256 of zero bytes; any other body must hash equal", () => {
    expect(EMPTY_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    expect(idx.match(post("/api/login", LOGIN_BODY))?.recording.id).toBe(byUrl("/api/login")[0]?.id ?? "?");
    expect(idx.match(post("/api/login", LOGIN_BODY + "&x=1"))).toBeNull();
    expect(idx.match(post("/api/login", ""))).toBeNull();
    // JSON body: byte-exact
    expect(idx.match(post("/api/search", JSON.stringify(SEARCH[1])))?.recording.id).toBe(byUrl("/api/search")[1]?.id ?? "?");
    expect(idx.match(post("/api/search", JSON.stringify(SEARCH[1], null, 1)))).toBeNull();
  });

  test("a recording whose request body was not captured matches any body", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    const up = byUrl("/api/upload")[0];
    expect(up?.request.postDataMissing?.reason).toBe("unavailable");
    expect(idx.match(post("/api/upload", "anything"))?.recording.id).toBe(up?.id ?? "?");
    expect(idx.match(post("/api/upload", ""))?.recording.id).toBe(up?.id ?? "?");
  });

  test("--strict headers and --match-cookies join the key", () => {
    const strict = new ReplayIndex(requests, reader, { strict: ["x-client-build"], matchCookies: false });
    expect(strict.match(get("/api/items?page=1&client=web"))).toBeNull();
    expect(strict.match(get("/api/items?page=1&client=web", { "x-client-build": "2026.10" }))?.recording.request.url).toBe(`${ORIGIN}/api/items?page=1&client=web`);
    expect(strict.match(get("/api/items?page=1&client=web", { "x-client-build": "2026.11" }))).toBeNull();
    const loose = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    expect(loose.match(get("/api/items?page=1&client=web"))).not.toBeNull();
    const ck = new ReplayIndex(requests, reader, { strict: [], matchCookies: true });
    expect(ck.match(get("/api/items?page=1&client=web"))).toBeNull();
    // cookie pair order does not matter
    expect(ck.match(get("/api/items?page=1&client=web", { cookie: `theme=dark; sid=${SID}` }))).not.toBeNull();
    expect(ck.match(get("/api/items?page=1&client=web", { cookie: "sid=other; theme=dark" }))).toBeNull();
  });
});

describe("cycling", () => {
  test("same key: recorded order, then around again; n is the 1-based position", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    const feed = byUrl("/api/feed");
    expect(feed.length).toBe(3);
    const seen = [1, 2, 3, 4, 5].map(() => idx.match(get("/api/feed")));
    expect(seen.map((m) => m?.recording.id)).toEqual([feed[0]?.id, feed[1]?.id, feed[2]?.id, feed[0]?.id, feed[1]?.id]);
    expect(seen.map((m) => m?.n)).toEqual([1, 2, 3, 1, 2]);
    expect(seen.every((m) => m?.of === 3)).toBe(true);
    // served bytes are the recorded blobs, in order
    expect(seen.slice(0, 3).map((m) => (m === null ? "" : sha256Hex(buildResponse(m.recording, reader, m.n).body ?? new Uint8Array(0))))).toEqual(feed.map(blobSha));
    expect(FEED.map((f) => sha256Hex(f))).toEqual(feed.map(blobSha));
  });

  test("counters are per key", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    expect(idx.match(get("/api/feed"))?.n).toBe(1);
    expect(idx.match(get("/api/items?page=1&client=web"))?.n).toBe(1);
    expect(idx.match(get("/api/feed"))?.n).toBe(2);
  });
});

describe("nearest candidates", () => {
  const idx = () => new ReplayIndex(requests, reader, { strict: ["x-client-build"], matchCookies: false });

  test("same method + path first, with the query parts that differ", () => {
    const c = idx().nearest(get("/api/items?page=9&client=web&extra=1", { "x-client-build": "2026.10" }));
    expect(c.length).toBe(2);
    expect(c[0]?.path).toBe("/api/items");
    expect(c[0]?.differs).toEqual({ query: { missing: [], extra: ["extra"], changed: ["page"] } });
    const noHeader = idx().nearest(get("/api/items?page=1&client=web"));
    expect(noHeader[0]?.differs).toEqual({ headers: ["x-client-build"] });
  });

  test("then same path with another method; body differences name the JSON fields", () => {
    const wrong = { q: "apple", page: 3, t: SEARCH[0]?.t, client: "web" };
    const c = idx().nearest(post("/api/search", JSON.stringify(wrong)));
    expect(c.length).toBe(2);
    const body = c[0]?.differs.body;
    expect(body?.fields).toEqual({ missing: [], extra: [], changed: ["$.page"] });
    expect(body?.gotSha256).toBe(sha256Hex(JSON.stringify(wrong)));
    const viaGet = idx().nearest(get("/api/search"));
    expect(viaGet.map((x) => x.differs.method)).toEqual([
      { recorded: "POST", got: "GET" },
      { recorded: "POST", got: "GET" },
    ]);
  });

  test("at most three; nothing on an unknown path", () => {
    expect(idx().nearest(get("/api/feed?x=1")).length).toBe(1); // one key on /api/feed
    expect(idx().nearest(get("/nope"))).toEqual([]);
    const many = new ReplayIndex(
      requests.concat(requests.filter((r) => r.url.includes("/api/sign"))),
      reader,
      { strict: [], matchCookies: false },
    );
    expect(many.nearest(get("/api/sign?q=z")).length).toBeLessThanOrEqual(3);
  });
});

describe("responses", () => {
  test("hop-by-hop, content-length and content-encoding dropped; set-cookie kept per value; content-length matches the body", () => {
    const login = byUrl("/api/login")[0];
    if (login === undefined) throw new Error("no login");
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    const rec = idx.recordings.find((x) => x.id === login.id);
    if (rec === undefined) throw new Error("login not indexed");
    const r = buildResponse(rec, reader, 1);
    const names = r.headers.map(([k]) => k);
    for (const gone of ["connection", "transfer-encoding", "content-encoding"]) expect(names).not.toContain(gone);
    expect(r.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v)).toEqual([`sid=${SID}; Path=/; HttpOnly`, "theme=dark; Path=/"]);
    expect(r.headers.filter(([k]) => k === "content-length")).toEqual([["content-length", String(r.body?.length ?? -1)]]);
    expect(r.headers).toContainEqual(["x-request-id", "login-1"]);
    expect(r.headers).toContainEqual(["x-tabcap-replay", `${login.id};n=1`]);
    expect(new TextDecoder().decode(r.body ?? new Uint8Array(0))).toContain(CSRF);
    expect(sha256Hex(r.body ?? new Uint8Array(0))).toBe(blobSha(login));
  });

  test("missing body: recorded status, empty body, reason header", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    const m = idx.match(get("/api/evicted"));
    if (m === null) throw new Error("no match");
    const r = buildResponse(m.recording, reader, m.n);
    expect(r.status).toBe(200);
    expect(r.body?.length).toBe(0);
    expect(r.headers).toContainEqual(["x-tabcap-replay-missing", "evicted"]);
    expect(r.headers).toContainEqual(["content-length", "0"]);
  });

  test("null-body statuses carry no body; same-origin location becomes a path", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    const ping = idx.match({ method: "POST", url: "/api/ping", headers: {}, body: new Uint8Array(0) });
    if (ping === null) throw new Error("no ping");
    const r = buildResponse(ping.recording, reader, 1);
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    expect(r.headers.map(([k]) => k)).not.toContain("content-length");
    const go = idx.match(get("/go"));
    if (go === null) throw new Error("no go");
    const g = buildResponse(go.recording, reader, 1);
    expect(g.status).toBe(302);
    expect(g.headers).toContainEqual(["location", "/final?x=1"]);
  });

  test("invalid recorded header values are not sent and are listed", () => {
    const base = byUrl("/api/items?page=1&client=web")[0];
    if (base === undefined || base.response === null) throw new Error("no base");
    const evil: RequestEvent = { ...base, response: { ...base.response, headers: { ...base.response.headers, "x-ok": "1", "x-bad": "a\r\nInjected: 1", "bad name": "v" } } };
    const idx = new ReplayIndex([evil], reader, { strict: [], matchCookies: false });
    const rec = idx.recordings[0];
    if (rec === undefined) throw new Error("no rec");
    const r = buildResponse(rec, reader, 1);
    expect(r.headers).toContainEqual(["x-ok", "1"]);
    expect(r.headers.map(([k]) => k)).not.toContain("x-bad");
    expect(r.dropped.sort()).toEqual(["bad name", "x-bad"]);
    expect(sha256Hex(ITEMS1)).toBe(blobSha(base));
  });
});

describe("helpers", () => {
  test("loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.9.8.7", "localhost", "::1", "[::1]", "api.localhost"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.1", "example.com", "127.0.0.1.example.com", "128.0.0.1", "::"]) expect(isLoopbackHost(h)).toBe(false);
  });

  test("path globs", () => {
    const m = globMatcher("/api/*,/static/**");
    expect(m).not.toBeNull();
    expect(m?.("/api/items")).toBe(true);
    expect(m?.("/api/items/2")).toBe(false);
    expect(m?.("/static/a/b.js")).toBe(true);
    expect(globMatcher("")).toBeNull();
    expect(globMatcher("/a.b")?.("/aXb")).toBe(false);
  });

  test("unreplayable requests are skipped with a reason", () => {
    const { skipped } = replayableRequests(reader);
    expect(skipped.map((s) => s.reason)).toEqual(["status 0"]);
  });
});

describe("multi-host bundles: the host joins the key (0.3-C)", () => {
  // Two origins with the same path; the one-origin bundle above keeps the old key (tested throughout this file).
  const A = "http://127.0.0.1:4310";
  const B = "http://api.127.0.0.1.nip.test:4311";
  let multi: BundleReader;
  let reqs: RequestEvent[] = [];
  beforeAll(async () => {
    const d = join(tmp("tabcap-replay-mh-"), "b");
    await buildBundle(d, { name: "mh", created: 1760700000000, seed: 7 }, async (b) => {
      await b.request({ url: `${A}/api/me`, body: '{"from":"a"}', mime: "application/json", ts: 1760700000100 });
      await b.request({ url: `${B}/api/me`, body: '{"from":"b"}', mime: "application/json", ts: 1760700000200 });
      await b.request({ url: `${B}/api/only-b`, body: "{}", mime: "application/json", ts: 1760700000300 });
    });
    multi = BundleReader.open(d);
    reqs = replayableRequests(multi).requests;
  }, SLOW_IO_MS);
  afterAll(() => rmSync(join(multi.dir, ".."), { recursive: true, force: true }), SLOW_IO_MS);
  const from = (m: ReturnType<ReplayIndex["match"]>): string => (m === null ? "none" : new TextDecoder().decode(buildResponse(m.recording, multi, m.n).body ?? new Uint8Array(0)));

  test("a Host naming a recorded host picks that host's recording only", () => {
    const idx = new ReplayIndex(reqs, multi, { strict: [], matchCookies: false });
    expect([...idx.hosts].sort()).toEqual(["127.0.0.1:4310", "api.127.0.0.1.nip.test:4311"]);
    expect(from(idx.match({ ...get("/api/me"), host: "127.0.0.1:4310" }))).toBe('{"from":"a"}');
    expect(from(idx.match({ ...get("/api/me"), host: "API.127.0.0.1.nip.test:4311" }))).toBe('{"from":"b"}');
    expect(from(idx.match({ ...get("/api/me"), host: "127.0.0.1:4310" }))).toBe('{"from":"a"}'); // no cycling into the other host
    expect(idx.match({ ...get("/api/only-b"), host: "127.0.0.1:4310" })).toBeNull();
    const c = idx.nearest({ ...get("/api/only-b"), host: "127.0.0.1:4310" });
    expect(c[0]).toMatchObject({ host: "api.127.0.0.1.nip.test:4311", path: "/api/only-b", differs: { host: { recorded: "api.127.0.0.1.nip.test:4311", got: "127.0.0.1:4310" } } });
  });

  test("any other Host (the replay server's own address) matches as before: path, query, body; same key cycles across hosts", () => {
    const idx = new ReplayIndex(reqs, multi, { strict: [], matchCookies: false });
    const own = { host: "127.0.0.1:4500" };
    expect([from(idx.match({ ...get("/api/me"), ...own })), from(idx.match({ ...get("/api/me"), ...own })), from(idx.match(get("/api/me")))]).toEqual(['{"from":"a"}', '{"from":"b"}', '{"from":"a"}']);
    expect(from(idx.match({ ...get("/api/only-b"), ...own }))).toBe("{}");
  });

  test("replay serve: the Host header selects the origin; serve info says host matching is on", async () => {
    const srv = startReplayServer({ bundle: multi.dir, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null });
    try {
      expect(srv.info.match).toEqual({ strict: [], cookies: false, host: true });
      expect(srv.info.routes.map((r) => `${r.host ?? "-"} ${r.path}`)).toEqual(["127.0.0.1:4310 /api/me", "api.127.0.0.1.nip.test:4311 /api/me", "api.127.0.0.1.nip.test:4311 /api/only-b"]);
      expect(srv.info.warnings.some((w) => w.includes("spans 2 hosts"))).toBe(true);
      const b = await fetch(`${srv.info.url}/api/me`, { headers: { host: "api.127.0.0.1.nip.test:4311" } });
      expect(await b.text()).toBe('{"from":"b"}');
      const miss = await fetch(`${srv.info.url}/api/only-b`, { headers: { host: "127.0.0.1:4310" } });
      expect(miss.status).toBe(404);
      expect((await fetch(`${srv.info.url}/api/only-b`)).status).toBe(200);
    } finally {
      srv.stop();
    }
  });

  test("a one-host bundle never keys on the host", () => {
    const idx = new ReplayIndex(requests, reader, { strict: [], matchCookies: false });
    expect(idx.hosts.size).toBe(1);
    expect(idx.match({ ...get("/api/feed"), host: "elsewhere.test" })).not.toBeNull();
    expect(idx.nearest({ ...get("/api/feed?x=1"), host: "elsewhere.test" })[0]).not.toHaveProperty("host");
  });
});
