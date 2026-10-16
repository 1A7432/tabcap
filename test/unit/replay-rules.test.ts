// Replay key rules (0.6-C, src/replay/rules.ts, docs/04 §31): validation of
// the rules document, the canonicalisation table, key equality in the replay
// index, replay serve's headers / 404, replay check's compare modes and
// `bundle export har --rules`. The canonical forms are the docs/04 §31 table;
// served bytes are compared with the builder's blobs (sha256), never with
// hand-written hashes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { DecodeHost, DecodeSession } from "../../src/daemon/hooks/decode.ts";
import { decodePlugins } from "../../src/daemon/hooks/plugins.ts";
import { decodeBundle } from "../../src/bundle/decode.ts";
import { exportHar } from "../../src/bundle/har.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { replayableRequests } from "../../src/replay/common.ts";
import { ReplayIndex, type Incoming } from "../../src/replay/match.ts";
import { startReplayServer } from "../../src/replay/server.ts";
import { check } from "../../src/replay/check.ts";
import {
  DEFAULT_RULE,
  RULES_SCHEMA,
  bodyKeyText,
  canonicalBody,
  canonicalQuery,
  dropIgnoredQuery,
  parseRulesDoc,
  pickRule,
  queryString,
  readRulesFile,
  rulesFromConfig,
  type RuleSet,
} from "../../src/replay/rules.ts";
import { S42_ORDER_JSON, S42_POST_JSON, xorEncode } from "../e2e/site.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { S42_ORIGIN, installXor, s42Bundle } from "./_decode.ts";

const O = "http://127.0.0.1:4310";
const C = 1760800000000;
const enc = new TextEncoder();
const set = (rules: unknown[]): RuleSet => ({ rules: parseRulesDoc({ schema: RULES_SCHEMA, rules }, "rules", { requireSchema: true, where: "test" }), source: { kind: "none" } });
const rule = (r: unknown) => set([r]).rules[0] ?? DEFAULT_RULE;
const text = (s: string) => enc.encode(s);

const SEARCH_URL = `${O}/api/search?q=apple&page=1&client=web&v=3&t=1760800000123&nonce=0f1e2d3c4b5a6978&sig=aa11`;
const LOGIN = "user=demo&password=pw-1&_ts=111";
const QUERY = { q: "a", page: 1, ts: 5, meta: { nonce: "n1", lang: "zh" }, items: [{ id: 1, at: 9 }, { id: 2, at: 10 }] };

let root = "";
let bundle = "";
let reader: BundleReader;

beforeAll(async () => {
  root = tmp("tabcap-rules-");
  bundle = await buildBundle(join(root, "b"), { name: "rules", created: C, seed: 9 }, async (b) => {
    await b.request({ url: SEARCH_URL, mime: "application/json", body: JSON.stringify({ hits: ["apple-1-a"], served: 1 }), reqHeaders: { "x-client-build": "2026.10" }, ts: C + 10 });
    await b.request({ url: `${O}/api/login`, method: "POST", type: "fetch", mime: "application/json", body: '{"csrf":"c1"}', postData: LOGIN, reqHeaders: { "content-type": "application/x-www-form-urlencoded" }, ts: C + 20 });
    await b.request({ url: `${O}/api/query`, method: "POST", type: "fetch", mime: "application/json", body: JSON.stringify({ rows: [1, 2], at: 1760800000999, id: "q1" }), postData: JSON.stringify(QUERY), reqHeaders: { "content-type": "application/json" }, ts: C + 30 });
    await b.request({ url: `${O}/api/Case?Page=1&Lang=ZH`, mime: "application/json", body: '{"case":1}', ts: C + 40 });
    await b.request({ url: `${O}/api/raw`, method: "POST", type: "fetch", mime: "application/json", body: '{"raw":1}', postData: "a=1&b=2", ts: C + 50 });
  });
  reader = BundleReader.open(bundle);
}, 20_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rules document validation (untrusted input)", () => {
  const bad = (doc: unknown, re: RegExp) => expect(() => parseRulesDoc(doc, "rules", { requireSchema: true, where: "test" })).toThrow(re);

  test("a full rule parses with its defaults; ids name the position", () => {
    const s = set([{ match: { host: "127.0.0.1", path: "/api/**", method: "post" }, key: { ignoreQuery: ["t", "nonce"], body: "json", ignoreBodyFields: ["$.ts"] }, response: { compare: "status", ignorePaths: [] } }, {}]);
    expect(s.rules.map((r) => [r.id, r.match, r.key.body, r.response.compare])).toEqual([
      ["rules[0]", { host: "127.0.0.1", path: "/api/**", method: "POST" }, "json", "status"],
      ["rules[1]", { host: null, path: null, method: null }, "raw", "status+body"],
    ]);
    expect(DEFAULT_RULE.id).toBe("default");
    expect([DEFAULT_RULE.key.body, DEFAULT_RULE.response.compare]).toEqual(["raw", "status+body"]);
  });

  test("unknown keys, wrong enums and contradictions are refused", () => {
    bad({ rules: [] }, /schema/);
    bad({ schema: "tabcap-replay-rules/1", rules: [] }, /schema/);
    bad({ schema: RULES_SCHEMA, rules: [], extra: 1 }, /unknown key "extra"/);
    bad({ schema: RULES_SCHEMA, rules: [{ when: {} }] }, /unknown key "when"/);
    bad({ schema: RULES_SCHEMA, rules: [{ match: { url: "/x" } }] }, /rules\[0\]\.match: unknown key "url"/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { ignore: [] } }] }, /unknown key "ignore"/);
    bad({ schema: RULES_SCHEMA, rules: [{ response: { paths: [] } }] }, /unknown key "paths"/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { body: "xml" } }] }, /key\.body: must be one of/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { body: "json", decodeWith: "xor-decode" } }] }, /decodeWith: needs body "decoded"/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { ignoreBodyFields: ["a"] } }] }, /needs body "form", "json" or "decoded"/);
    bad({ schema: RULES_SCHEMA, rules: [{ response: { compare: "body" } }] }, /compare: must be one of/);
    bad({ schema: RULES_SCHEMA, rules: [{ response: { compare: "status", ignorePaths: ["$.a"] } }] }, /compares no body/);
    bad({ schema: RULES_SCHEMA, rules: [{ response: { decodeWith: "x" } }] }, /needs compare "status\+decoded-body"/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { body: "decoded", decodeWith: "Bad Name" } }] }, /plugin name/);
    bad({ schema: RULES_SCHEMA, rules: [{ match: { path: "api/x" } }] }, /path glob starting with \//);
    bad({ schema: RULES_SCHEMA, rules: [{ match: { host: "a b" } }] }, /host name or glob/);
    bad({ schema: RULES_SCHEMA, rules: [{ match: { method: "GE T" } }] }, /method token/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { caseInsensitiveQuery: "yes" } }] }, /true or false/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { body: "json", ignoreBodyFields: ["$.a[x]"] } }] }, /not an index/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { body: "json", ignoreBodyFields: ["$"] } }] }, /whole body/);
    bad({ schema: RULES_SCHEMA, rules: [{ key: { ignoreQuery: "t" } }] }, /list of at most/);
    bad({ schema: RULES_SCHEMA, rules: Array.from({ length: 257 }, () => ({})) }, /at most 256 rules/);
    bad([], /JSON object/);
  });

  test("files: missing, not JSON, too large; config.json: the site's rules before the global ones", () => {
    const dir = join(root, "files");
    mkdirSync(dir, { recursive: true });
    expect(() => readRulesFile(join(dir, "none.json"))).toThrow(/not found/);
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(() => readRulesFile(join(dir, "bad.json"))).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "big.json"), " ".repeat(1024 * 1024 + 1));
    expect(() => readRulesFile(join(dir, "big.json"))).toThrow(/over 1048576 bytes/);
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ schema: RULES_SCHEMA, rules: [{ key: { body: "none" } }] }));
    expect(readRulesFile(join(dir, "ok.json")).source).toEqual({ kind: "file", file: join(dir, "ok.json") });
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ replay: { rules: [{ match: { path: "/g" } }] }, sites: { example: { replay: { rules: [{ match: { path: "/s" } }] } } } }));
    expect(rulesFromConfig(cfg, "example").rules.map((r) => r.id)).toEqual(["sites.example.replay.rules[0]", "replay.rules[0]"]);
    expect(rulesFromConfig(cfg, null).rules.map((r) => r.id)).toEqual(["replay.rules[0]"]);
    expect(rulesFromConfig(join(dir, "missing.json"), "example").source).toEqual({ kind: "none" });
    writeFileSync(cfg, JSON.stringify({ replay: { rules: [{ key: { body: "yaml" } }] } }));
    expect(() => rulesFromConfig(cfg, null)).toThrow(/config.json replay|replay.rules\[0\]/);
  });

  test("the first rule whose host, path and method fit applies; else the default", () => {
    const s = set([{ match: { path: "/api/*", method: "POST" }, key: { body: "none" } }, { match: { host: "127.0.0.*", path: "/api/**" } }, { match: { host: "127.0.0.1:4310" } }]);
    expect(pickRule(s, { url: `${O}/api/login`, method: "post" }).id).toBe("rules[0]");
    expect(pickRule(s, { url: `${O}/api/login`, method: "GET" }).id).toBe("rules[1]");
    expect(pickRule(s, { url: `${O}/other`, method: "GET" }).id).toBe("rules[2]");
    expect(pickRule(s, { url: "http://127.0.0.1:9/other", method: "GET" }).id).toBe("default");
    expect(pickRule(set([]), { url: `${O}/x`, method: "GET" })).toBe(DEFAULT_RULE);
  });
});

describe("canonicalisation table (docs/04 §31)", () => {
  test("query: ignored names (and globs) dropped, the rest sorted; case-insensitive lowercases names and values", () => {
    const r = rule({ key: { ignoreQuery: ["t", "non*"] } });
    const q = canonicalQuery(new URL(SEARCH_URL).search, r);
    expect(queryString(q.pairs)).toBe("client=web&page=1&q=apple&sig=aa11&v=3");
    expect([...q.ignored.keys()].sort()).toEqual(["nonce", "t"]);
    const ci = rule({ key: { ignoreQuery: ["LANG"], caseInsensitiveQuery: true } });
    expect(queryString(canonicalQuery("?Page=1&Lang=ZH&Q=Apple", ci).pairs)).toBe("page=1&q=apple");
    expect(queryString(canonicalQuery("?Page=1&Lang=ZH", rule({ key: { ignoreQuery: ["LANG"] } })).pairs)).toBe("Lang=ZH&Page=1");
  });

  test("form: pairs sorted, ignored names dropped; order and spelling of the body do not matter", () => {
    const r = rule({ key: { body: "form", ignoreBodyFields: ["_ts"] } });
    const a = canonicalBody(text(LOGIN), r);
    const b = canonicalBody(text("password=pw%2D1&_ts=999&user=demo"), r);
    expect([a.as, a.text, bodyKeyText(a)]).toEqual(["form", "password=pw-1&user=demo", "password=pw-1&user=demo"]);
    expect(b.digest).toBe(a.digest);
    expect([...a.ignored]).toEqual([["_ts", '["111"]']]);
    expect(canonicalBody(text("user=demo&password=other"), r).digest).not.toBe(a.digest);
  });

  test("json: keys sorted, whitespace gone, ignored paths ([*], .*, bare top-level names) dropped; not JSON falls back to raw", () => {
    const r = rule({ key: { body: "json", ignoreBodyFields: ["ts", "$.meta.nonce", "$.items[*].at"] } });
    const a = canonicalBody(text(JSON.stringify(QUERY)), r);
    expect(a.text).toBe('{"items":[{"id":1},{"id":2}],"meta":{"lang":"zh"},"page":1,"q":"a"}');
    const reordered = '{ "page": 1, "q": "a", "ts": 77, "meta": { "lang": "zh", "nonce": "n2" }, "items": [ { "at": 1, "id": 1 }, { "id": 2, "at": 2 } ] }';
    expect(canonicalBody(text(reordered), r).digest).toBe(a.digest);
    expect([...a.ignored.keys()].sort()).toEqual(["$.items[0].at", "$.items[1].at", "$.meta.nonce", "$.ts"]);
    const any = canonicalBody(text('{"a":{"x":1,"y":2},"b":3}'), rule({ key: { body: "json", ignoreBodyFields: ["$.a.*"] } }));
    expect(any.text).toBe('{"a":{},"b":3}');
    const quoted = canonicalBody(text('{"x y":1,"z":2}'), rule({ key: { body: "json", ignoreBodyFields: ['$["x y"]'] } }));
    expect(quoted.text).toBe('{"z":2}');
    const notJson = canonicalBody(text("a=1"), r);
    expect([notJson.as, notJson.fallback, notJson.digest]).toEqual(["raw", "not-json", sha256Hex("a=1")]);
  });

  test("decoded: the plaintext as JSON (or form by its mime, else raw); no plaintext: the original's raw bytes", () => {
    const r = rule({ key: { body: "decoded", ignoreBodyFields: ["qty"] } });
    const cipher = text(xorEncode(S42_POST_JSON));
    const d = canonicalBody(cipher, r, { bytes: text(S42_POST_JSON), mime: "application/json" });
    expect([d.as, d.text]).toEqual(["json", '{"item":"S42-ITEM-0001","token":"S42-TOKEN-5e1f9a3c7b2d4e60"}']);
    const f = canonicalBody(cipher, r, { bytes: text("b=2&a=1&qty=3"), mime: "application/x-www-form-urlencoded; charset=utf-8" });
    expect([f.as, f.text]).toEqual(["form", "a=1&b=2"]);
    const t = canonicalBody(cipher, r, { bytes: text("plain words"), mime: "text/plain" });
    expect([t.as, t.digest, t.fallback]).toEqual(["raw", sha256Hex("plain words"), null]);
    const none = canonicalBody(cipher, r, { error: "boom" });
    expect([none.as, none.digest, none.fallback]).toEqual(["raw", sha256Hex(cipher), "not-decoded: boom"]);
  });

  test("none leaves the body out; raw is the sha256 of the bytes (0.3-B)", () => {
    const n = canonicalBody(text("anything"), rule({ key: { body: "none" } }));
    expect([n.as, bodyKeyText(n)]).toEqual(["none", null]);
    const raw = canonicalBody(text("a=1"), DEFAULT_RULE);
    expect([raw.as, bodyKeyText(raw)]).toEqual(["raw", `sha256:${sha256Hex("a=1")}`]);
  });

  test("HAR export --rules: ignored query parameters leave the URL and queryString, nothing else", () => {
    const r = rule({ key: { ignoreQuery: ["t", "nonce"] } });
    expect(dropIgnoredQuery(`${O}/x?a=1&t=2&nonce=3&b=4#f`, r)).toBe(`${O}/x?a=1&b=4#f`);
    expect(dropIgnoredQuery(`${O}/x?t=2`, r)).toBe(`${O}/x`);
    const plain = exportHar(reader);
    const ruled = exportHar(reader, { rules: set([{ match: { path: "/api/search" }, key: { ignoreQuery: ["t", "nonce"] } }]) });
    const search = (h: typeof plain) => h.har.log.entries.find((e) => e.request.url.includes("/api/search"));
    expect(search(ruled)?.request.url).toBe(`${O}/api/search?q=apple&page=1&client=web&v=3&sig=aa11`);
    expect(search(ruled)?.request.queryString.map((p) => p.name)).toEqual(["q", "page", "client", "v", "sig"]);
    expect(search(plain)?.request.url).toBe(SEARCH_URL);
    // every other field is the same
    const strip = (h: typeof plain) => h.har.log.entries.map((e) => ({ ...e, request: { ...e.request, url: "", queryString: [] } }));
    expect(strip(ruled)).toEqual(strip(plain));
  });
});

describe("key equality in the replay index", () => {
  const get = (url: string): Incoming => ({ method: "GET", url, headers: {}, body: new Uint8Array(0) });
  const post = (url: string, body: string): Incoming => ({ method: "POST", url, headers: {}, body: text(body) });
  const RULES = set([
    { match: { path: "/api/search" }, key: { ignoreQuery: ["t", "nonce"] } },
    { match: { path: "/api/login", method: "POST" }, key: { body: "form", ignoreBodyFields: ["_ts"] } },
    { match: { path: "/api/query" }, key: { body: "json", ignoreBodyFields: ["ts", "$.meta.nonce"] } },
    { match: { path: "/api/Case" }, key: { caseInsensitiveQuery: true } },
    { match: { path: "/api/raw" }, key: { body: "none" } },
  ]);
  const idx = (rules?: RuleSet) => new ReplayIndex(replayableRequests(reader).requests, reader, { strict: [], matchCookies: false, ...(rules === undefined ? {} : { rules }) });
  const SEARCH_PATH = new URL(SEARCH_URL).pathname + new URL(SEARCH_URL).search;
  const other = SEARCH_PATH.replace("t=1760800000123", "t=1760800099999").replace("nonce=0f1e2d3c4b5a6978", "nonce=ffffffffffffffff");

  test("without rules nothing changes: volatile params, form order and JSON spacing all miss", () => {
    const i = idx();
    expect(i.match(get(SEARCH_PATH))?.recording.id).toBe("r-2");
    expect(i.match(get(other))).toBeNull();
    expect(i.match(post("/api/login", "password=pw-1&user=demo&_ts=111"))).toBeNull();
    expect(i.match(post("/api/query", JSON.stringify(QUERY, null, 1)))).toBeNull();
  });

  test("with rules: ignored params, reordered forms, re-spelled JSON, case and left-out bodies match; real differences do not", () => {
    const i = idx(RULES);
    const m = i.match(get(other));
    expect([m?.recording.id, m?.rule.id, m?.ignored]).toEqual(["r-2", "rules[0]", { query: ["nonce", "t"], body: [] }]);
    expect(i.match(get(SEARCH_PATH))?.ignored).toEqual({ query: [], body: [] });
    expect(i.match(get(other.replace("q=apple", "q=pear")))).toBeNull();
    expect(i.match(get(SEARCH_PATH.replace("&t=1760800000123", "")))?.ignored.query).toEqual(["t"]);
    const login = i.match(post("/api/login", "_ts=5&password=pw-1&user=demo"));
    expect([login?.recording.id, login?.ignored.body]).toEqual(["r-3", ["_ts"]]);
    expect(i.match(post("/api/login", "user=demo&password=wrong"))).toBeNull();
    expect(i.match(post("/api/query", JSON.stringify({ ...QUERY, ts: 6, meta: { lang: "zh", nonce: "zz" } }, null, 2)))?.recording.id).toBe("r-4");
    expect(i.match(post("/api/query", JSON.stringify({ ...QUERY, page: 2 })))).toBeNull();
    expect(i.match(get("/api/Case?lang=zh&PAGE=1"))?.recording.id).toBe("r-5");
    expect(i.match(post("/api/raw", "whatever"))?.recording.id).toBe("r-6");
  });

  test("404 candidates: the rule, the canonical query / body differences and the ignored parts that differ", () => {
    const i = idx(RULES);
    const q = i.nearest(get(other.replace("q=apple", "q=pear")));
    expect(q[0]).toMatchObject({ id: "r-2", rule: "rules[0]", differs: { query: { missing: [], extra: [], changed: ["q"] }, ignored: { query: ["nonce", "t"] } } });
    const b = i.nearest(post("/api/query", JSON.stringify({ ...QUERY, page: 2, ts: 1 })));
    expect(b[0]?.differs.body).toMatchObject({ as: "json", fields: { missing: [], extra: [], changed: ["$.page"] } });
    expect(b[0]?.differs.ignored).toEqual({ body: ["$.ts"] });
    // a request no rule covers keeps the 0.3-B explanation
    expect(idx().nearest(get("/api/search?q=pear"))[0]).not.toHaveProperty("rule");
  });
});

describe("replay serve / check with rules", () => {
  const RULES = (): RuleSet => set([{ match: { path: "/api/search" }, key: { ignoreQuery: ["t", "nonce"] } }, { match: { path: "/api/query" }, key: { body: "json", ignoreBodyFields: ["ts"] }, response: { ignorePaths: ["$.at"] } }]);

  test("x-tabcap-replay names the rule, x-tabcap-replay-ignored the differing ignored names; info lists the rules", async () => {
    const srv = await startReplayServer({ bundle, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null, rules: RULES() });
    try {
      expect(srv.info.rules).toEqual({ source: "none", rules: 2 });
      expect(srv.info.routes.find((r) => r.path === "/api/search")?.rule).toBe("rules[0]");
      const u = new URL(SEARCH_URL);
      const res = await fetch(`${srv.info.url}${u.pathname}?q=apple&page=1&client=web&v=3&t=1&nonce=2&sig=aa11`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-tabcap-replay")).toBe("r-2;n=1;rule=rules[0]");
      expect(res.headers.get("x-tabcap-replay-ignored")).toBe("query=nonce,t");
      const blob = reader.readBlob(reader.requests().find((r) => r.id === "r-2")?.response?.body?.blob ?? "");
      expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(sha256Hex(blob ?? new Uint8Array(0)));
      const same = await fetch(`${srv.info.url}/api/login`, { method: "POST", body: LOGIN });
      expect([same.status, same.headers.get("x-tabcap-replay"), same.headers.get("x-tabcap-replay-ignored")]).toEqual([200, "r-3;n=1;rule=default", null]);
      const miss = await fetch(`${srv.info.url}${u.pathname}?q=pear&t=1`);
      expect(miss.status).toBe(404);
      const body: unknown = await miss.json();
      expect(body).toMatchObject({ error: "no-match", request: { rule: "rules[0]" }, candidates: [{ id: "r-2", rule: "rules[0]", differs: { ignored: { query: ["nonce", "t"] } } }] });
    } finally {
      srv.stop();
    }
  });

  test("replay check --rules: compare status skips the body; ignorePaths leave volatile fields out of both sides", async () => {
    const fake = (body: Record<string, string>) => async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(body[u.pathname] ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const answers = { "/api/query": JSON.stringify({ rows: [1, 2], at: 1, id: "q1" }), "/api/search": '{"other":true}' };
    const base = { bundle, against: "http://127.0.0.1:1", live: false, withCookies: false, headers: ["content-type"], configDir: join(root, "cfg"), filter: "/api/query,/api/search", fetch: fake(answers) };
    const plain = await check(base);
    expect(plain.rows.map((r) => [r.id, r.result])).toEqual([
      ["r-2", "different"],
      ["r-4", "different"],
    ]);
    const ruled = await check({ ...base, rules: set([{ match: { path: "/api/search" }, response: { compare: "status" } }, { match: { path: "/api/query" }, response: { ignorePaths: ["$.at"] } }]) });
    expect(ruled.rows.map((r) => [r.id, r.rule, r.result])).toEqual([
      ["r-2", "rules[0]", "same"],
      ["r-4", "rules[1]", "same"],
    ]);
    expect(ruled.rows[0]?.notes).toContain('body not compared (rule rules[0]: compare "status")');
    expect(ruled.rules).toEqual({ source: "none", rules: 2 });
  });
});

describe("decoded bodies through the range plugin (s42, xor-decode)", () => {
  let config = "";
  let plain = "";
  let viewed = "";
  const ORDER = "/s42/api/order";
  const DECODED = (decodeWith?: string): RuleSet =>
    set([{ match: { path: ORDER }, key: { body: "decoded", ...(decodeWith === undefined ? {} : { decodeWith }) }, response: { compare: "status+decoded-body", ...(decodeWith === undefined ? {} : { decodeWith }) } }]);

  beforeAll(async () => {
    config = join(root, "s42-config");
    installXor(config, false); // installed, not enabled: naming it in the rules is the opt-in
    plain = await s42Bundle(join(root, "s42-plain"));
    viewed = await s42Bundle(join(root, "s42-viewed"));
    const host = new DecodeHost();
    installXor(join(root, "s42-enabled"));
    try {
      await decodeBundle(viewed, new DecodeSession(host, decodePlugins(join(root, "s42-enabled"))));
    } finally {
      host.close();
    }
  }, 30_000);

  // The same plaintext with other key order and spacing: another ciphertext.
  const respelled = JSON.stringify({ qty: 2, item: "S42-ITEM-0001", token: JSON.parse(S42_POST_JSON).token }, null, 1);

  for (const [name, rules, dir] of [
    ["decodeWith on a bundle without views", () => DECODED("xor-decode"), () => plain],
    ["the recorded view's plugin", () => DECODED(), () => viewed],
  ] as const) {
    test(`replay serve: ${name}: a re-spelled encrypted body matches, another plaintext does not`, async () => {
      expect(xorEncode(respelled)).not.toBe(xorEncode(S42_POST_JSON));
      const srv = await startReplayServer({ bundle: dir(), host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null, rules: rules(), configDir: config });
      try {
        const send = (plainText: string) => fetch(`${srv.info.url}${ORDER}`, { method: "POST", headers: { "content-type": "text/plain", "x-enc": "xor" }, body: xorEncode(plainText) });
        const hit = await send(respelled);
        expect([hit.status, hit.headers.get("x-tabcap-replay")]).toEqual([200, "r-5;n=1;rule=rules[0]"]);
        expect(await hit.text()).toBe(xorEncode(S42_ORDER_JSON));
        const miss = await send(JSON.stringify({ token: "x", item: "S42-ITEM-0001", qty: 2 }));
        expect(miss.status).toBe(404);
        const p: unknown = await miss.json();
        expect(p).toMatchObject({ candidates: [{ id: "r-5", differs: { body: { as: "json", fields: { changed: ["$.token"] } } } }] });
      } finally {
        srv.stop();
      }
    }, 30_000);
  }

  test("replay check --rules status+decoded-body against replay serve: decoded bodies compared, all same", async () => {
    const srv = await startReplayServer({ bundle: plain, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null, rules: DECODED("xor-decode"), configDir: config });
    try {
      const r = await check({ bundle: plain, against: srv.info.url, live: false, withCookies: false, headers: ["content-type"], configDir: config, filter: ORDER, rules: DECODED("xor-decode") });
      expect(r.rows.map((x) => [x.id, x.result, x.rule])).toEqual([["r-5", "same", "rules[0]"]]);
      expect(r.rows[0]?.notes).toContain("body compared as decoded by xor-decode (plugin:xor-decode; rule rules[0])");
      // without a plugin to decode with, the row is unverified, with the reason
      const none = await check({ bundle: plain, against: srv.info.url, live: false, withCookies: false, headers: [], configDir: join(root, "no-plugins"), filter: ORDER, rules: DECODED("xor-decode") });
      expect(none.rows.map((x) => x.result)).toEqual(["unverified"]);
      expect(none.rows[0]?.notes.join(" ")).toContain("decode plugin xor-decode is not installed");
    } finally {
      srv.stop();
    }
    expect(S42_ORIGIN).toBe("http://127.0.0.1:4342");
  }, 30_000);
});
