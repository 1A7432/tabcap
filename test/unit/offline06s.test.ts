// 0.6-S offline fixes (owner brief 2026-10-17, from the neighbouring project's
// real-site test of 0.6.0): replay preference (`prefer` / `--prefer`) in
// replay serve, replay check and bundle export fixtures; CORS preflights left
// out of fixtures; `bundle info --usage` by actor (fetch / evaluate / page /
// other), preflights, data: URLs and loopback hosts; analyze shape / schema-diff
// default resource types and `--types`. Expected values come from the
// builder's own data (ids, statuses, blob bytes by sha256) and the docs/04
// §30 / §31 / §32 rules, never from the implementation's output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { exportFixtures } from "../../src/bundle/fixtures.ts";
import { exportHar, importHar } from "../../src/bundle/har.ts";
import { renderUsageText, usageReport, parseUsageActor } from "../../src/bundle/usage.ts";
import { parseShapeTypes, schemaDiff, shape } from "../../src/analyze/shape.ts";
import { replayableRequests, isPreflight } from "../../src/replay/common.ts";
import { ReplayIndex } from "../../src/replay/match.ts";
import { startReplayServer } from "../../src/replay/server.ts";
import { check } from "../../src/replay/check.ts";
import { NO_RULES, RULES_SCHEMA, parsePrefer, parseRulesDoc, preferred, type RuleSet } from "../../src/replay/rules.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { isRecord } from "../../src/shared/json.ts";
import { run } from "../../src/cli/main.ts";
import { buildBundle, idOf, tmp } from "./_analyze.ts";

const O = "http://127.0.0.1:4310";
const C = 1761000000000;
const J = "application/json";
const set = (rules: unknown[]): RuleSet => ({ rules: parseRulesDoc({ schema: RULES_SCHEMA, rules }, "rules", { requireSchema: true, where: "test" }), source: { kind: "file", file: "replay-rules.json" } });

let root = "";
let bundle = "";
/** Ids by role, from the builder's events. */
const ids: Record<string, string> = {};
const I = (k: string): string => {
  const v = ids[k];
  if (v === undefined) throw new Error(`no id ${k}`);
  return v;
};
const DENIED = JSON.stringify({ error: "forbidden" });
const LIST = JSON.stringify({ items: [1, 2], ok: true });
const FEED_OLD = JSON.stringify({ feed: "old" });
const FEED_NEW = JSON.stringify({ feed: "new" });

beforeAll(async () => {
  root = tmp("tabcap-06s-");
  bundle = await buildBundle(join(root, "b"), { name: "s06s", created: C, seed: 4 }, async (b) => {
    // one key, a failed attempt first (403) and the answer the scraper needs later (200)
    ids["denied"] = idOf(await b.request({ url: `${O}/api/list?page=1`, status: 403, mime: J, body: DENIED, ts: C + 10 }));
    ids["list"] = idOf(await b.request({ url: `${O}/api/list?page=1`, mime: J, body: LIST, ts: C + 20 }));
    // another key, two 200 recordings (latest picks the second)
    ids["feedOld"] = idOf(await b.request({ url: `${O}/api/feed`, mime: J, body: FEED_OLD, ts: C + 30 }));
    ids["feedNew"] = idOf(await b.request({ url: `${O}/api/feed`, mime: J, body: FEED_NEW, ts: C + 40 }));
    // a key with only failures: 2xx serves them all
    ids["err1"] = idOf(await b.request({ url: `${O}/api/err`, status: 500, mime: J, body: '{"e":1}', ts: C + 50 }));
    ids["err2"] = idOf(await b.request({ url: `${O}/api/err`, status: 502, mime: J, body: '{"e":2}', ts: C + 60 }));
    // a CORS preflight before a cross-origin POST (CDP initiator type "preflight")
    ids["preflight"] = idOf(
      await b.request({
        url: `${O}/api/save`,
        method: "OPTIONS",
        type: "other",
        status: 204,
        bodyMissing: "no-content",
        reqHeaders: { "access-control-request-method": "POST", origin: "http://app.example.test" },
        respHeaders: { "access-control-allow-origin": "http://app.example.test", "access-control-allow-methods": "POST" },
        extra: { initiator: { type: "preflight", url: `${O}/api/save` } },
        ts: C + 70,
      }),
    );
    ids["save"] = idOf(await b.request({ url: `${O}/api/save`, method: "POST", type: "fetch", mime: J, body: '{"saved":true}', postData: '{"a":1}', ts: C + 80 }));
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const blobSha = (id: string): string => {
  const r = BundleReader.open(bundle);
  const ev = r.requests().find((x) => x.id === id);
  return sha256Hex(r.readBlob(ev?.response?.body?.blob ?? "") ?? new Uint8Array(0));
};

describe("prefer: the rules field and the selection table", () => {
  test("rules accept prefer recorded / 2xx / latest, default recorded; anything else is bad-input", () => {
    expect(set([{ match: { path: "/api/**" } }]).rules[0]?.prefer).toBe("recorded");
    expect(set([{ prefer: "2xx" }]).rules[0]?.prefer).toBe("2xx");
    expect(set([{ prefer: "latest" }]).rules[0]?.prefer).toBe("latest");
    expect(() => set([{ prefer: "first" }])).toThrow(/rules\[0\]\.prefer: must be one of "recorded", "2xx", "latest"/);
    expect(() => set([{ key: { prefer: "2xx" } }])).toThrow(/unknown key "prefer"/);
    expect(parsePrefer("2xx")).toBe("2xx");
    expect(() => parsePrefer("best")).toThrow(/bad --prefer/);
  });

  test("preferred(): all in order; only the 2xx ones (all when none); the last one", () => {
    const l = [{ status: 403 }, { status: 200 }, { status: 201 }, { status: null }];
    expect(preferred(l, "recorded")).toEqual(l);
    expect(preferred(l, "2xx")).toEqual([{ status: 200 }, { status: 201 }]);
    expect(preferred([{ status: 500 }, { status: 502 }], "2xx")).toEqual([{ status: 500 }, { status: 502 }]);
    expect(preferred(l, "latest")).toEqual([{ status: null }]);
    expect(preferred([], "latest")).toEqual([]);
  });
});

describe("prefer in the replay index", () => {
  const index = (rules: RuleSet, prefer?: "recorded" | "2xx" | "latest") => {
    const reader = BundleReader.open(bundle);
    return new ReplayIndex(replayableRequests(reader).requests, reader, { strict: [], matchCookies: false, rules, ...(prefer === undefined ? {} : { prefer }) });
  };
  const get = (path: string) => ({ method: "GET", url: path, headers: {}, body: new Uint8Array(0) });

  test("default (recorded): the 403 answers first, then the 200, cycling (the 0.3-B behaviour)", () => {
    const ix = index(NO_RULES);
    expect([1, 2, 3].map(() => ix.match(get("/api/list?page=1"))?.recording.id)).toEqual([I("denied"), I("list"), I("denied")]);
  });

  test("--prefer 2xx: only the 200 answers, n=1 of 1; a key without 2xx keeps all its recordings", () => {
    const ix = index(NO_RULES, "2xx");
    const m = [1, 2].map(() => ix.match(get("/api/list?page=1")));
    expect(m.map((x) => [x?.recording.id, x?.n, x?.of, x?.prefer])).toEqual([
      [I("list"), 1, 1, "2xx"],
      [I("list"), 1, 1, "2xx"],
    ]);
    expect([1, 2].map(() => ix.match(get("/api/err"))?.recording.id)).toEqual([I("err1"), I("err2")]);
  });

  test("--prefer latest: the last recording of each key", () => {
    const ix = index(NO_RULES, "latest");
    expect([1, 2].map(() => ix.match(get("/api/feed"))?.recording.id)).toEqual([I("feedNew"), I("feedNew")]);
    expect(ix.match(get("/api/list?page=1"))?.recording.id).toBe(I("list"));
  });

  test("a rule's prefer applies to the keys of its requests; --prefer overrides every rule", () => {
    const rules = set([{ match: { path: "/api/list" }, prefer: "2xx" }]);
    const ix = index(rules);
    expect([1, 2].map(() => ix.match(get("/api/list?page=1"))?.recording.id)).toEqual([I("list"), I("list")]);
    expect([1, 2].map(() => ix.match(get("/api/feed"))?.recording.id)).toEqual([I("feedOld"), I("feedNew")]); // default rule: recorded
    const over = index(rules, "recorded");
    expect([1, 2].map(() => over.match(get("/api/list?page=1"))?.recording.id)).toEqual([I("denied"), I("list")]);
  });
});

describe("prefer in replay serve, replay check and bundle export fixtures", () => {
  test("replay serve --prefer 2xx: the scraper gets the 200 every time; the header and the route say so", async () => {
    const srv = await startReplayServer({ bundle, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null, prefer: "2xx" });
    try {
      expect(srv.info.prefer).toBe("2xx");
      const route = srv.info.routes.find((r) => r.path === "/api/list");
      expect(route).toMatchObject({ ids: [I("denied"), I("list")], prefer: "2xx", served: [I("list")] });
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${srv.info.url}/api/list?page=1`);
        expect([res.status, res.headers.get("x-tabcap-replay")]).toEqual([200, `${I("list")};n=1;prefer=2xx`]);
        expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(blobSha(I("list")));
      }
    } finally {
      srv.stop();
    }
  });

  test("replay serve without --prefer: unchanged (403 first, no prefer in the header or the routes)", async () => {
    const srv = await startReplayServer({ bundle, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null });
    try {
      expect(srv.info.prefer).toBeNull();
      expect(srv.info.routes.find((r) => r.path === "/api/list")).not.toHaveProperty("served");
      const res = await fetch(`${srv.info.url}/api/list?page=1`);
      expect([res.status, res.headers.get("x-tabcap-replay")]).toEqual([403, `${I("denied")};n=1`]);
    } finally {
      srv.stop();
    }
  });

  test("replay check --prefer 2xx against replay serve --prefer 2xx: no difference; the shadowed recordings are listed, not sent", async () => {
    const srv = await startReplayServer({ bundle, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null, prefer: "2xx" });
    try {
      const r = await check({ bundle, against: srv.info.url, live: false, withCookies: false, headers: ["content-type"], configDir: join(root, "cfg"), prefer: "2xx" });
      expect(r.notPreferred).toEqual([{ id: I("denied"), prefer: "2xx", servedBy: [I("list")] }]);
      expect(r.rows.map((x) => x.id)).not.toContain(I("denied"));
      expect(r.totals.different + r.totals.errors).toBe(0);
      expect(r.prefer).toBe("2xx");
      // without --prefer the check sends the 403 recording too, and the server answers it with the 200
      const plain = await check({ bundle, against: srv.info.url, live: false, withCookies: false, headers: ["content-type"], configDir: join(root, "cfg") });
      expect(plain.notPreferred).toEqual([]);
      expect(plain.rows.find((x) => x.id === I("denied"))).toMatchObject({ result: "different", status: { recorded: 403, got: 200 } });
    } finally {
      srv.stop();
    }
  });

  test("bundle export fixtures: a rule's prefer decides which recordings of a key become fixtures (the ones serve answers with)", async () => {
    const out = join(root, "fx-prefer");
    const res = await exportFixtures(BundleReader.open(bundle), { out, rules: set([{ prefer: "2xx" }]), format: "json", redact: false, configDir: join(root, "cfg") });
    expect(res.notPreferred).toEqual([{ request: I("denied"), prefer: "2xx", servedBy: [I("list")] }]);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as { fixtures: { request: string; file: string }[]; notPreferred: unknown[]; skipped: { id: string; reason: string }[] };
    const requests = index.fixtures.map((f) => f.request);
    expect(requests).toEqual([I("list"), I("feedOld"), I("feedNew"), I("err1"), I("err2"), I("save")]);
    expect(index.fixtures.map((f) => f.file.split("-")[0])).toEqual(["fixtures/1", "fixtures/2", "fixtures/3", "fixtures/4", "fixtures/5", "fixtures/6"]);
    expect(index.notPreferred).toEqual([{ request: I("denied"), prefer: "2xx", servedBy: [I("list")] }]);
    const latest = await exportFixtures(BundleReader.open(bundle), { out: join(root, "fx-latest"), rules: set([{ match: { path: "/api/feed" }, prefer: "latest" }]), format: "json", redact: false, configDir: join(root, "cfg") });
    expect(latest.notPreferred.map((x) => x.request)).toEqual([I("feedOld")]);
    expect(latest.fixtures).toBe(6); // 403 + 200 of /api/list (recorded), feed latest, two errors, the POST
  });
});

describe("CORS preflights", () => {
  test("isPreflight: OPTIONS with initiator preflight or an access-control-request-method header", () => {
    const r = BundleReader.open(bundle).requests();
    expect(r.filter(isPreflight).map((x) => x.id)).toEqual([I("preflight")]);
  });

  test("bundle export fixtures skips them (reason preflight); --include-preflight keeps them", async () => {
    const res = await exportFixtures(BundleReader.open(bundle), { out: join(root, "fx-pf"), rules: NO_RULES, format: "json", redact: false, configDir: join(root, "cfg") });
    expect(res.skipped).toEqual([{ id: I("preflight"), reason: "preflight" }]);
    expect(res.fixtures).toBe(7);
    const keep = await exportFixtures(BundleReader.open(bundle), { out: join(root, "fx-pf2"), rules: NO_RULES, format: "json", redact: false, configDir: join(root, "cfg"), includePreflight: true });
    expect(keep.skipped).toEqual([]);
    expect(keep.fixtures).toBe(8);
  });

  test("replay serve answers an OPTIONS with the recorded preflight (status, access-control headers, no body); an unrecorded one is a 404", async () => {
    const srv = await startReplayServer({ bundle, host: "127.0.0.1", port: 0, strict: [], matchCookies: false, log: null });
    try {
      const res = await fetch(`${srv.info.url}/api/save`, { method: "OPTIONS", headers: { "access-control-request-method": "POST", origin: "http://app.example.test" } });
      expect([res.status, res.headers.get("access-control-allow-origin"), res.headers.get("x-tabcap-replay"), (await res.arrayBuffer()).byteLength]).toEqual([204, "http://app.example.test", `${I("preflight")};n=1`, 0]);
      const miss = await fetch(`${srv.info.url}/api/list`, { method: "OPTIONS" });
      expect(miss.status).toBe(404);
    } finally {
      srv.stop();
    }
  });
});

describe("bundle info --usage by actor", () => {
  const A = "http://shop.example.test";
  let ub = "";
  beforeAll(async () => {
    ub = await buildBundle(join(root, "usage"), { name: "u06s", created: C, seed: 5 }, async (b) => {
      const cmd = (id: string, action: string, actor: "ai" | "system") => b.w.append({ actor, tab: "t1", cmd: id, ts: C, mono: null, kind: "cmd", phase: "start", id, argv: null, input: { action } });
      cmd("c-90", "evaluate", "ai");
      cmd("c-91", "fetch", "ai");
      cmd("c-92", "challenge", "system");
      await b.request({ url: `${A}/`, type: "document", mime: "text/html", body: "<p>x</p>", ts: C + 0 });
      await b.request({ url: `${A}/api/a`, mime: J, body: "{}", ts: C + 100 });
      await b.request({ url: `${A}/api/f1`, type: "fetch", mime: J, body: "{}", ts: C + 1000, extra: { cmd: "c-91", fetchId: "c-91:f-1" } });
      await b.request({ url: `${A}/api/f2`, type: "fetch", mime: J, body: "{}", ts: C + 4000, extra: { cmd: "c-91", fetchId: "c-91:f-2" } });
      await b.request({ url: `${A}/api/f2`, method: "OPTIONS", type: "other", status: 204, bodyMissing: "no-content", reqHeaders: { "access-control-request-method": "POST" }, ts: C + 3990, extra: { cmd: "c-91", fetchId: "c-91:f-2", initiator: { type: "preflight" } } });
      await b.request({ url: `${A}/api/e`, type: "fetch", mime: J, body: "{}", ts: C + 5000, extra: { cmd: "c-90" } });
      await b.request({ url: `${A}/api/poll`, mime: J, body: "{}", ts: C + 5100, extra: { cmd: "c-91" } }); // the page, during a fetch command
      await b.request({ url: `${A}/plugin`, mime: J, body: "{}", ts: C + 6000, extra: { cmd: "c-92" } });
      await b.request({ url: "data:image/png;base64,iVBORw0KGgo=", type: "image", mime: "image/png", body: new Uint8Array([1]), ts: C + 6100 });
      await b.request({ url: "http://127.0.0.1:9222/json/version", mime: J, body: "{}", ts: C + 6200 });
      await b.request({ url: "http://localhost:4500/api/x", mime: J, body: "{}", ts: C + 6300 });
      await b.request({ url: "http://[::1]:4501/api/y", mime: J, body: "{}", ts: C + 6400 });
    });
  });

  test("one row per host and actor; preflights apart and not empty; data: and loopback in skipped", () => {
    const u = usageReport(BundleReader.open(ub), ub, []);
    expect(u.hosts.map((h) => [h.host, h.actor, h.requests])).toEqual([
      ["shop.example.test", "page", 3],
      ["shop.example.test", "fetch", 3],
      ["shop.example.test", "evaluate", 1],
      ["shop.example.test", "other", 1],
    ]);
    expect(u.actors).toEqual({ page: 3, fetch: 3, evaluate: 1, other: 1 });
    const f = u.hosts.find((h) => h.actor === "fetch");
    // 0.6-U: intervals leave the preflight (3990, 10 ms before its fetch) out: 1000 → 4000
    expect(f).toMatchObject({ preflights: 1, emptyBodies: 0, byMethod: { GET: 2, OPTIONS: 1 }, minIntervalMs: 3000, firstMono: 2000, lastMono: 5000 });
    expect(u.skipped).toEqual({ loopback: { hosts: ["127.0.0.1:9222", "[::1]:4501", "localhost:4500"], requests: 3 }, schemes: { data: 1 } });
    expect(u.windows.reduce((n, w) => n + w.requests, 0)).toBe(8);
    expect(u.filter).toEqual({ actor: null, allHosts: false });
  });

  test("--actor keeps one actor's rows; --all-hosts lists loopback hosts", () => {
    const only = usageReport(BundleReader.open(ub), ub, [], { actor: "fetch" });
    expect(only.hosts.map((h) => [h.host, h.actor])).toEqual([["shop.example.test", "fetch"]]);
    expect(only.actors).toEqual({ page: 0, fetch: 3, evaluate: 0, other: 0 });
    const all = usageReport(BundleReader.open(ub), ub, [], { allHosts: true });
    expect(all.hosts.map((h) => h.host).filter((h) => h !== "shop.example.test").sort()).toEqual(["127.0.0.1:9222", "[::1]:4501", "localhost:4500"]);
    expect(all.skipped).toEqual({ loopback: { hosts: [], requests: 0 }, schemes: { data: 1 } });
    expect(() => parseUsageActor("human")).toThrow(/bad --actor/);
  });

  test("--text: actor column, preflight column, one skipped line", () => {
    const t = renderUsageText(usageReport(BundleReader.open(ub), ub, []));
    expect(t).toMatch(/^host\s+actor\s+req\s+min ms\s+mean ms\s+burst\/1s\s+empty\s+preflight\s+biz err\s+bytes in$/m);
    expect(t).toMatch(/^shop\.example\.test\s+fetch\s+3\s/m);
    expect(t).toContain("actors page 3  fetch 3  evaluate 1  other 1");
    expect(t).toContain("skipped: loopback 3 request(s) on 127.0.0.1:9222, [::1]:4501, localhost:4500 (--all-hosts lists them); data: 1 (no host)");
  });

  test("CLI: --actor / --all-hosts need --usage; a bad --actor is a usage error", async () => {
    const r1 = await run(["bundle", "info", ub, "--actor", "fetch"]);
    expect(r1.code).toBe(2);
    const r2 = await run(["bundle", "info", ub, "--usage", "--actor", "nobody"]);
    expect(r2.code).toBe(2);
    const r3 = await run(["bundle", "info", ub, "--usage", "--actor", "fetch", "--all-hosts"]);
    expect(r3.code).toBe(0);
    const env = r3.envelope;
    const data = env.ok && isRecord(env.data) ? env.data : {};
    expect(data["filter"]).toEqual({ actor: "fetch", allHosts: true });
  });
});

describe("analyze shape / schema-diff: default resource types and --types", () => {
  const A = "http://api.example.test";
  const body = (n: number) => JSON.stringify({ items: [{ id: n }], total: 1 });
  let sb = "";
  beforeAll(async () => {
    sb = await buildBundle(join(root, "shape"), { name: "sh06s", created: C, seed: 6 }, async (b) => {
      await b.request({ url: `${A}/api/list?page=1&size=20`, mime: J, body: body(1), ts: C + 1 });
      await b.request({ url: `${A}/api/list?page=2&size=20`, type: "fetch", mime: J, body: body(2), ts: C + 2 });
      await b.request({ url: `${A}/api/list?page=1`, type: "document", mime: J, body: body(1), ts: C + 3 });
      await b.request({ url: `${A}/app.js?v=1`, type: "script", mime: "text/javascript", body: "1", ts: C + 4 });
      await b.request({ url: `${A}/site.css?v=2`, type: "stylesheet", mime: "text/css", body: "a{}", ts: C + 5 });
      await b.request({ url: `${A}/logo.png?v=3`, type: "image", mime: "image/png", body: new Uint8Array([0x89, 0x50]), ts: C + 6 });
      await b.request({ url: `${A}/beacon`, type: "other", mime: "application/json; charset=utf-8", body: '{"ok":1}', ts: C + 7 });
    });
  });

  test("default: xhr, fetch, document and JSON responses of any type; static resources left out and counted", () => {
    const r = shape(sb);
    expect(r.endpoints.map((e) => e.key)).toEqual(["GET /api/list", "GET /beacon"]);
    expect(r.excluded).toBe(3);
    expect(r.filter).toMatchObject({ types: ["xhr", "fetch", "document"], json: true });
    const all = shape(sb, { types: parseShapeTypes("all") });
    expect(all.endpoints.map((e) => e.key)).toEqual(["GET /api/list", "GET /app.js", "GET /site.css", "GET /logo.png", "GET /beacon"]);
    expect(all.excluded).toBe(0);
    const narrow = shape(sb, { types: parseShapeTypes("xhr,fetch") });
    expect(narrow.endpoints.map((e) => [e.key, e.exchanges])).toEqual([["GET /api/list", 2]]);
    expect(narrow.filter).toMatchObject({ types: ["xhr", "fetch"], json: false });
    // --request is never filtered
    const js = BundleReader.open(sb).requests().find((x) => x.type === "script")?.id ?? "";
    expect(shape(sb, { request: js }).endpoints.map((e) => e.key)).toEqual(["GET /app.js"]);
    expect(() => parseShapeTypes("xhr,css")).toThrow(/bad --types entry "css"/);
    expect(() => parseShapeTypes(",")).toThrow(/at least one/);
  });

  test("the HAR round trip itself keeps every query name (all types, --no-redact): same; redaction only changes a sensitive value's format", async () => {
    const rb = await buildBundle(join(root, "rt"), { name: "rt06s", created: C, seed: 7 }, async (b) => {
      await b.request({ url: `${A}/api/list?page=1&size=20&q=a+b&flag&empty=&r=1&r=2`, mime: J, body: body(1), ts: C + 1 });
      await b.request({ url: `${A}/api/list?page=2&size=20&q=%E4%B8%AD&token=abcdef0123456789abcdef`, mime: J, body: body(2), ts: C + 2 });
      await b.request({ url: `${A}/api/list?page=3`, type: "fetch", mime: J, body: body(3), ts: C + 3 });
    });
    const trip = async (name: string, redact: boolean) => {
      const har = exportHar(BundleReader.open(rb), { redact: redact ? { salt: "s06s", knownSecrets: [] } : false });
      const out = join(root, name);
      await importHar(JSON.parse(JSON.stringify(har.har)), out);
      return schemaDiff(rb, out);
    };
    expect((await trip("rt-raw", false)).summary).toEqual({ same: 1, drift: 0, new: 0, gone: 0 });
    const red = (await trip("rt-red", true)).endpoints[0];
    expect([red?.optionalityChanged, red?.added, red?.removed, red?.changed]).toEqual([[], [], [], [{ path: "query:token", from: "string(id)", to: "string" }]]);
  });

  test("an incomplete exchange of the endpoint is not in the HAR (docs/04 §9.1): optionality drift whatever the types", async () => {
    const ib = await buildBundle(join(root, "inc"), { name: "inc06s", created: C, seed: 8 }, async (b) => {
      await b.request({ url: `${A}/api/list?page=1&size=20`, mime: J, body: body(1), ts: C + 1 });
      await b.request({ url: `${A}/api/list?page=2&size=20`, mime: J, body: body(2), ts: C + 2 });
      await b.request({ url: `${A}/api/list?page=3`, mime: J, status: 0, bodyMissing: "navigated", ts: C + 3 });
    });
    const har = exportHar(BundleReader.open(ib), { types: ["xhr", "fetch"], redact: false });
    expect(har.skipped).toEqual({ incomplete: 1, filtered: 0 });
    const out = join(root, "inc-imp");
    await importHar(JSON.parse(JSON.stringify(har.har)), out);
    const d = schemaDiff(ib, out, { types: parseShapeTypes("xhr,fetch") });
    expect(d.endpoints[0]?.optionalityChanged).toEqual([{ path: "query:size", from: "optional", to: "required" }]);
  });

  test("the false drift: a HAR exported with xhr,fetch differs from its bundle in the request set; --types xhr,fetch on both sides is same", async () => {
    const har = exportHar(BundleReader.open(sb), { types: ["xhr", "fetch"], redact: false });
    const imp = join(root, "shape-imp");
    await importHar(JSON.parse(JSON.stringify(har.har)), imp);
    const d = schemaDiff(sb, imp);
    // the document exchange (no size) is in the bundle, not in the HAR: query:size optional -> required
    expect(d.endpoints.find((e) => e.key === "GET /api/list")?.optionalityChanged).toEqual([{ path: "query:size", from: "optional", to: "required" }]);
    const same = schemaDiff(sb, imp, { types: parseShapeTypes("xhr,fetch") });
    expect(same.summary).toEqual({ same: 1, drift: 0, new: 0, gone: 0 });
    expect(same.filter).toMatchObject({ types: ["xhr", "fetch"], json: false });
  });
});
