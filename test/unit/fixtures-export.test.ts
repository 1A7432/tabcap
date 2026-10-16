// `bundle export fixtures` (0.6-C, src/bundle/fixtures.ts, docs/04 §31) and
// the fixture plugin kind (src/daemon/hooks/fixture.ts). Expected bodies are
// the builder's bytes; keys follow the docs/04 §31 canonicalisation table;
// the plugin is the range plugin test/e2e/plugins/fixture-harness.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { exportFixtures, fixtureFileName, type Fixture } from "../../src/bundle/fixtures.ts";
import { decodeBundle } from "../../src/bundle/decode.ts";
import { DecodeHost, DecodeSession } from "../../src/daemon/hooks/decode.ts";
import { asFixturePlugin, decodePlugins, listPlugins, parseManifest } from "../../src/daemon/hooks/plugins.ts";
import { checkOutputPath, parseFixtureReply } from "../../src/daemon/hooks/fixture.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { isRecord } from "../../src/shared/json.ts";
import { NO_RULES, RULES_SCHEMA, parseRulesDoc, type RuleSet } from "../../src/replay/rules.ts";
import { S42_ORDER_JSON, S42_POST_JSON } from "../e2e/site.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { installXor, s42Bundle } from "./_decode.ts";
import { SLOW_IO_MS, expectMode } from "./_platform.ts";

const O = "http://127.0.0.1:4310";
const C = 1760900000000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const PLUGIN = join(import.meta.dir, "..", "e2e", "plugins", "fixture-harness");
const set = (rules: unknown[]): RuleSet => ({ rules: parseRulesDoc({ schema: RULES_SCHEMA, rules }, "rules", { requireSchema: true, where: "test" }), source: { kind: "file", file: "replay-rules.json" } });
const RULES = set([
  { match: { path: "/api/search" }, key: { ignoreQuery: ["t", "nonce"] } },
  { match: { path: "/api/login" }, key: { body: "form" } },
]);

let root = "";
let bundle = "";
const read = (f: string): unknown => JSON.parse(readFileSync(f, "utf8"));
const fx = (dir: string, file: string): Fixture => {
  const v = read(join(dir, file));
  if (!isRecord(v)) throw new Error("not a fixture");
  return v as Fixture;
};

beforeAll(async () => {
  root = tmp("tabcap-fixtures-");
  bundle = await buildBundle(join(root, "b"), { name: "fixtures", created: C, seed: 3 }, async (b) => {
    await b.request({ url: `${O}/api/search?q=apple&t=1760900000001&nonce=ab12&page=1`, mime: "application/json", body: '{"hits":["a"]}', reqHeaders: { cookie: "sid=s-123; theme=dark", "x-client-build": "2026.10" }, ts: C + 10 });
    await b.request({ url: `${O}/api/login`, method: "POST", type: "fetch", mime: "application/json", body: '{"ok":true}', postData: "user=demo&password=hunter2", reqHeaders: { "content-type": "application/x-www-form-urlencoded" }, respHeaders: { "set-cookie": "sid=s-456; Path=/" }, ts: C + 20 });
    await b.request({ url: `${O}/img/logo.png`, type: "image", mime: "image/png", body: PNG, base64: true, ts: C + 30 });
    await b.request({ url: `${O}/api/gone`, status: 0, bodyMissing: "navigated", ts: C + 40 });
    await b.request({ url: `${O}/api/refuse`, mime: "application/json", body: "{}", ts: C + 50 });
  });
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("file naming", () => {
  test("<n>-<METHOD>-<path slug>.json", () => {
    expect(fixtureFileName(1, "get", "/api/search")).toBe("fixtures/1-GET-api-search.json");
    expect(fixtureFileName(12, "POST", "/v2/订单/list.json")).toBe("fixtures/12-POST-v2-list.json.json");
    expect(fixtureFileName(3, "GET", "/")).toBe("fixtures/3-GET-root.json");
    expect(fixtureFileName(4, "GET", "/../../etc")).toBe("fixtures/4-GET-etc.json");
    expect(fixtureFileName(5, "GET", `/${"a".repeat(200)}`).length).toBeLessThanOrEqual("fixtures/5-GET-".length + 80 + ".json".length);
  });
});

describe("format json", () => {
  test("one fixture per exchange, keyed by the rules, plus index.json; secrets redacted like HAR export", async () => {
    const out = join(root, "out-json");
    const res = await exportFixtures(BundleReader.open(bundle), { out, rules: RULES, format: "json", redact: { salt: "00".repeat(16), knownSecrets: [] }, configDir: join(root, "cfg") });
    expect([res.fixtures, res.format, res.redacted, res.index]).toEqual([4, "json", true, join(out, "index.json")]);
    expect(res.skipped).toEqual([{ id: "r-5", reason: "status 0" }]);
    expect(res.files.filter((f) => f.startsWith("fixtures/"))).toEqual(["fixtures/1-GET-api-search.json", "fixtures/2-POST-api-login.json", "fixtures/3-GET-img-logo.png.json", "fixtures/4-GET-api-refuse.json"]);
    const s = fx(out, "fixtures/1-GET-api-search.json");
    expect(s.key).toEqual({ method: "GET", path: "/api/search", query: "page=1&q=apple", body: `sha256:${sha256Hex(new Uint8Array(0))}` });
    expect(s.meta).toEqual({ request: "r-2", rule: "rules[0]", recordedAt: new Date(C + 10).toISOString(), keyBody: "raw" });
    expect(s.response).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: '{"hits":["a"]}', bodyEncoding: "utf8" });
    expect(String(s.request.headers["cookie"])).toMatch(/^sid=«r:secret:[0-9a-f]{8}»; theme=«r:secret:[0-9a-f]{8}»$/);
    expect(s.request.headers["x-client-build"]).toBe("2026.10");
    const login = fx(out, "fixtures/2-POST-api-login.json");
    expect(login.key.body).toMatch(/^password=%C2%ABr%3Asecret%3A[0-9a-f]{8}%C2%BB&user=demo$/);
    expect(login.request.body).not.toContain("hunter2");
    expect(JSON.stringify(login)).not.toContain("s-456");
    const png = fx(out, "fixtures/3-GET-img-logo.png.json");
    expect(png.response.bodyFile).toBe(`bodies/${sha256Hex(PNG)}.bin`);
    expect(sha256Hex(new Uint8Array(readFileSync(join(out, png.response.bodyFile ?? ""))))).toBe(sha256Hex(PNG));
    const index = read(join(out, "index.json"));
    expect(index).toMatchObject({ schema: "tabcap-fixtures/0", redacted: true, count: 4, rules: { source: "file", file: "replay-rules.json", rules: 2 } });
    expectMode(join(out, "index.json"), 0o600);
    expectMode(join(out, "fixtures"), 0o700);
  });

  test("--no-redact keeps the recorded values (the login body, as HAR export does)", async () => {
    const out = join(root, "out-raw");
    await exportFixtures(BundleReader.open(bundle), { out, rules: RULES, format: "json", redact: false, configDir: join(root, "cfg") });
    const login = fx(out, "fixtures/2-POST-api-login.json");
    expect([login.key.body, login.request.body]).toEqual(["password=hunter2&user=demo", "user=demo&password=hunter2"]);
  });

  test("without rules every key is the 0.3-B one; a non-empty --out is refused", async () => {
    const out = join(root, "out-default");
    await exportFixtures(BundleReader.open(bundle), { out, rules: NO_RULES, format: "json", redact: false, configDir: join(root, "cfg") });
    const s = fx(out, "fixtures/1-GET-api-search.json");
    expect([s.key.query, s.meta.rule]).toEqual(["nonce=ab12&page=1&q=apple&t=1760900000001", "default"]);
    expect(exportFixtures(BundleReader.open(bundle), { out, rules: NO_RULES, format: "json", redact: false, configDir: join(root, "cfg") })).rejects.toThrow(/not empty/);
  });

  test("decoded views: the response plaintext rides along; body \"decoded\" keys on the plaintext", async () => {
    const enabled = join(root, "dec-cfg");
    installXor(enabled);
    const dir = await s42Bundle(join(root, "s42"));
    const host = new DecodeHost();
    try {
      await decodeBundle(dir, new DecodeSession(host, decodePlugins(enabled)));
    } finally {
      host.close();
    }
    const out = join(root, "out-s42");
    await exportFixtures(BundleReader.open(dir), { out, rules: set([{ match: { path: "/s42/api/order" }, key: { body: "decoded" } }]), format: "json", redact: false, configDir: enabled });
    const order = fx(out, "fixtures/4-POST-s42-api-order.json");
    expect(order.key.body).toBe(JSON.stringify(JSON.parse(S42_POST_JSON), Object.keys(JSON.parse(S42_POST_JSON)).sort()));
    expect(order.meta.keyBody).toBe("json");
    expect(order.response.decoded).toEqual({ by: "xor-decode", version: "1", mime: "application/json", body: S42_ORDER_JSON });
  }, 30_000);
});

describe("fixture plugins", () => {
  test("manifest: kind fixture parses strictly", () => {
    const m = parseManifest({ name: "fx", kind: "fixture", version: "1", command: ["bun", "./x.ts"] }, "fx");
    expect([m.fixture, m.hooks, m.timeoutMs]).toEqual([{ maxBytes: 8 * 1024 * 1024 }, [], 5000]);
    expect(() => parseManifest({ name: "fx", kind: "fixture", version: "1", command: ["bun"], match: {} }, "fx")).toThrow(/unknown key "match"/);
    expect(() => parseManifest({ name: "fx", kind: "fixture", command: ["bun"] }, "fx")).toThrow(/version/);
    expect(() => parseManifest({ name: "fx", kind: "fixture", version: "1", command: ["../x"] }, "fx")).toThrow(/command\[0\]/);
    expect(() => parseManifest({ name: "fx", kind: "fixture", version: "1", command: ["bun"], maxBytes: 0 }, "fx")).toThrow(/maxBytes/);
  });

  test("output paths stay under --out; broken answers are protocol failures", () => {
    for (const ok of ["cases/r-2.json", "a.txt", "deep/er/x.py"]) expect(checkOutputPath(ok)).toBeNull();
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b", "C:/x", "a\nb", "x".repeat(256)]) expect(checkOutputPath(bad)).not.toBeNull();
    expect(parseFixtureReply({ id: 2, files: [] }, 1, 10)).toBe("answer id 2 is not 1");
    expect(parseFixtureReply({ id: 1, files: [{ path: "../x", encoding: "utf8", data: "" }] }, 1, 10)).toMatch(/segments/);
    expect(parseFixtureReply({ id: 1, files: [{ path: "a", encoding: "hex", data: "" }] }, 1, 10)).toMatch(/encoding/);
    expect(parseFixtureReply({ id: 1, files: [{ path: "a", encoding: "utf8", data: "x".repeat(11) }] }, 1, 10)).toMatch(/maxBytes 10/);
    expect(parseFixtureReply({ id: 1, files: [{ path: "a", encoding: "utf8", data: "" }, { path: "a", encoding: "utf8", data: "" }] }, 1, 10)).toMatch(/twice/);
    expect(parseFixtureReply({ id: 1, ok: false, error: "no" }, 1, 10)).toEqual({ ok: false, error: "no" });
    const good = parseFixtureReply({ id: 1, files: [{ path: "a", encoding: "base64", data: "aGk=" }] }, 1, 10);
    expect(typeof good === "object" && good.ok ? new TextDecoder().decode(good.files[0]?.data) : null).toBe("hi");
  });

  test("--format <plugin>: the plugin's files are written; a refused fixture is listed in failed", async () => {
    const config = join(root, "fx-cfg");
    mkdirSync(join(config, "plugins"), { recursive: true, mode: 0o700 });
    cpSync(PLUGIN, join(config, "plugins", "fixture-harness"), { recursive: true });
    const info = listPlugins(config).find((p) => p.name === "fixture-harness");
    const plugin = info === undefined ? undefined : asFixturePlugin(info)[0];
    if (plugin === undefined) throw new Error(`plugin not usable: ${info?.error ?? "missing"}`);
    const out = join(root, "out-plugin");
    const res = await exportFixtures(BundleReader.open(bundle), { out, rules: RULES, format: plugin, redact: false, configDir: config });
    expect([res.format, res.fixtures, res.index, res.plugin]).toEqual(["fixture-harness", 3, null, { name: "fixture-harness", version: "1" }]);
    expect(res.failed).toEqual([{ request: "r-6", error: "refused on purpose" }]);
    expect(existsSync(join(out, "index.json"))).toBe(false);
    expect(read(join(out, "cases", "r-2.json"))).toEqual({ when: { method: "GET", path: "/api/search", query: "page=1&q=apple", body: `sha256:${sha256Hex(new Uint8Array(0))}` }, then: { status: 200, body: '{"hits":["a"]}' }, rule: "rules[0]" });
    expect(res.files).toContain(`bodies/${sha256Hex(PNG)}.bin`);
  }, 30_000);
});
