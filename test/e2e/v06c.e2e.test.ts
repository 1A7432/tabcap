// L2 for 0.6-C: replay key rules and fixture export on the range (Chrome for
// Testing, the real daemon). One recording holds docs/05 s06 (search with a
// page-computed t / nonce / sig), s07 (form login, then the csrf data call)
// and s42 (encoded bodies; the range decode plugin xor-decode writes the
// views while recording). A rules file ignores t / nonce on the search, keys
// the login on its form pairs and the s42 API on the decoded plaintext:
// `replay serve --rules` answers requests whose volatile parameters, field
// order or ciphertext differ (and, without the rules, does not); `replay
// check --rules` passes against it; `bundle export fixtures` writes the
// expected files; the range fixture plugin (test/e2e/plugins/fixture-harness)
// converts them; `bundle export har --rules` drops t / nonce.
// Oracles: the range sites (test/e2e/site.ts `served` hashes, S42_* plaintexts
// written by hand, LOGIN_*), the bundle's blobs, docs/04 §31.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { requestBodyBytes } from "../../src/replay/common.ts";
import { LOGIN_PASSWORD, LOGIN_USER, S42_ORDER, S42_ORDER_JSON, S42_POST_JSON, startDecodeSite, startGuardSite, startSearchSite, xorEncode, type DecodeSite, type GuardSite, type Site } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PLUGINS = join(import.meta.dir, "plugins");
const SITE = "example";
const S = ["--session", "rules6c"];

let home = "";
let search: Site;
let guard: GuardSite;
let s42: DecodeSite;
let bundle = "";
let rulesFile = "";

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

type Served = { url: string; info: Record<string, unknown>; stop: () => Promise<void> };

async function serve(dir: string, extra: string[] = []): Promise<Served> {
  const proc = Bun.spawn(["bun", MAIN, "replay", "serve", dir, "--port", "0", "--once", "120", "--json", ...extra], { env: { ...process.env, TABCAP_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`replay serve exited early: ${buf}`);
    buf += dec.decode(value);
  }
  reader.releaseLock();
  const env: unknown = JSON.parse(buf.slice(0, buf.indexOf("\n")));
  const info = rec(rec(env)["data"]);
  return {
    url: s(info["url"]),
    info,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

const RULES = {
  schema: "tabcap-replay-rules/0",
  rules: [
    { match: { path: "/api/search" }, key: { ignoreQuery: ["t", "nonce"] } },
    { match: { path: "/api/login", method: "POST" }, key: { body: "form" } },
    { match: { path: "/s42/api/*" }, key: { body: "decoded" }, response: { compare: "status+decoded-body" } },
  ],
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe.skipIf(!enabled)("tabcap 0.6-C L2 (replay rules and fixture export on s06 / s07 / s42)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6c-"));
    search = startSearchSite();
    guard = startGuardSite();
    s42 = startDecodeSite();
    mkdirSync(join(home, "config", "plugins"), { recursive: true, mode: 0o700 });
    for (const p of ["xor-decode", "fixture-harness"]) cpSync(join(PLUGINS, p), join(home, "config", "plugins", p), { recursive: true });
    await ok("plugin", "enable", "xor-decode");
    const listed = recs((await ok("plugin", "list"))["plugins"]).map((p) => [p["name"], p["kind"], p["enabled"], p["error"]]);
    expect(listed).toEqual([
      ["fixture-harness", "fixture", false, null],
      ["xor-decode", "decode", true, null],
    ]);
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    rulesFile = join(home, "replay-rules.json");
    writeFileSync(rulesFile, JSON.stringify(RULES, null, 2));
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    search.stop();
    guard.stop();
    s42.stop();
    removeHome(home, import.meta.file);
  });

  test("record s06 search, s07 login + data, s42 token / items / order into one bundle", async () => {
    await ok("session", "start", "rules6c", "--site", SITE);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${search.origin}/s06?q=apple&page=1`, ...S);
    await ok("wait", "--text", "hits apple-1-a", ...S);
    await ok("net", "wait", "--url", "/api/search?q=apple", ...S);

    await ok("navigate", `${guard.origin}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);

    await ok("navigate", `${s42.origin}/s42`, ...S);
    await ok("wait", "--text", "ready", ...S);
    const t42 = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("click", refOf(t42, "button", "order"), ...S);
    await ok("wait", "--text", `ordered ${S42_ORDER}`, ...S);
    await ok("net", "wait", "--url", "/s42/api/order", ...S);
    await ok("net", "stop", ...S);
    expect(s42.orders).toEqual([S42_POST_JSON]);
    const r = BundleReader.open(bundle);
    const paths = r.requests().map((x) => `${x.method} ${new URL(x.url).pathname}`);
    for (const want of ["GET /api/search", "POST /api/login", "POST /api/data", "GET /s42/api/token", "POST /s42/api/order"]) expect(paths).toContain(want);
    expect(r.requests().find((x) => x.url.endsWith("/s42/api/order"))?.request.decoded?.ok).toBe(true);
  }, 120_000);

  test("replay serve --rules: volatile t / nonce, reordered form fields and a re-spelled ciphertext match; without the rules they do not", async () => {
    const r = BundleReader.open(bundle);
    const searchReq = r.requests().find((x) => new URL(x.url).pathname === "/api/search");
    const login = r.requests().find((x) => new URL(x.url).pathname === "/api/login");
    if (searchReq === undefined || login === undefined) throw new Error("recording incomplete");
    const su = new URL(searchReq.url);
    const q = new URLSearchParams(su.search);
    q.set("t", "1");
    q.set("nonce", "0000000000000000");
    const volatile = `${su.pathname}?${q}`;
    const lb = requestBodyBytes(login, r);
    if (!("bytes" in lb)) throw new Error("no login body");
    const reordered = [...new URLSearchParams(new TextDecoder().decode(lb.bytes))].reverse().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    expect(reordered).not.toBe(new TextDecoder().decode(lb.bytes));
    const respelled = xorEncode(JSON.stringify(JSON.parse(S42_POST_JSON), null, 2));
    const order = () => ({ method: "POST", headers: { "content-type": "text/plain", "x-enc": "xor" }, body: respelled });

    const plain = await serve(bundle);
    try {
      expect(rec(plain.info["rules"])).toEqual({ source: "none", rules: 0 });
      expect((await fetch(`${plain.url}${volatile}`)).status).toBe(404);
      expect((await fetch(`${plain.url}/api/login`, { method: "POST", body: reordered })).status).toBe(404);
      expect((await fetch(`${plain.url}/s42/api/order`, order())).status).toBe(404);
    } finally {
      await plain.stop();
    }

    const ruled = await serve(bundle, ["--rules", rulesFile]);
    try {
      expect(rec(ruled.info["rules"])).toEqual({ source: "file", file: rulesFile, rules: 3 });
      const a = await fetch(`${ruled.url}${volatile}`);
      expect([a.status, a.headers.get("x-tabcap-replay"), a.headers.get("x-tabcap-replay-ignored")]).toEqual([200, `${searchReq.id};n=1;rule=rules[0]`, "query=nonce,t"]);
      // the bytes the s06 site sent for the recorded search
      expect(sha256Hex(new Uint8Array(await a.arrayBuffer()))).toBe(search.served.get(su.pathname + su.search) ?? "?");
      const b = await fetch(`${ruled.url}/api/login`, { method: "POST", body: reordered });
      expect([b.status, b.headers.get("x-tabcap-replay")]).toEqual([200, `${login.id};n=1;rule=rules[1]`]);
      const c = await fetch(`${ruled.url}/s42/api/order`, order());
      expect([c.status, (c.headers.get("x-tabcap-replay") ?? "").endsWith(";rule=rules[2]")]).toEqual([200, true]);
      expect(await c.text()).toBe(xorEncode(S42_ORDER_JSON));
      // a real difference still misses, and the 404 says what differs under which rule
      const miss = await fetch(`${ruled.url}${volatile.replace("q=apple", "q=pear")}`);
      expect(miss.status).toBe(404);
      expect(await miss.json()).toMatchObject({ request: { rule: "rules[0]" }, candidates: [{ id: searchReq.id, rule: "rules[0]", differs: { query: { changed: ["q"] }, ignored: { query: ["nonce", "t"] } } }] });
    } finally {
      await ruled.stop();
    }
  }, 60_000);

  test("replay check --rules against replay serve --rules: zero differences; s42 bodies compared decoded", async () => {
    const srv = await serve(bundle, ["--rules", rulesFile]);
    try {
      const c = await tabcap(["replay", "check", bundle, "--against", srv.url, "--rules", rulesFile]);
      expect(c.exit).toBe(0);
      expect(c.data["totals"]).toMatchObject({ different: 0, errors: 0 });
      const rows = recs(c.data["rows"]);
      const order = rows.find((x) => s(x["path"]).startsWith("/s42/api/order"));
      expect([order?.["result"], order?.["rule"]]).toEqual(["same", "rules[2]"]);
      expect(s(order?.["notes"])).toContain("body compared as decoded by xor-decode (plugin:xor-decode; rule rules[2])");
      expect(rows.filter((x) => x["result"] === "same").length).toBeGreaterThanOrEqual(5);
    } finally {
      await srv.stop();
    }
  }, 60_000);

  test("bundle export fixtures --rules: one fixture per exchange, keys per rule, the password nowhere", async () => {
    const out = join(home, "fixtures");
    const res = await ok("bundle", "export", "fixtures", bundle, "--rules", rulesFile, "--out", out);
    const r = BundleReader.open(bundle);
    const replayable = r.requests().filter((x) => x.response?.status !== null && x.response?.status !== undefined && x.response.status >= 200 && x.type !== "websocket");
    expect([res["fixtures"], res["format"], res["redacted"], res["failed"]]).toEqual([replayable.length, "json", true, []]);
    expect(typeof res["saltFile"] === "string" && existsSync(s(res["saltFile"]))).toBe(true);
    const index = rec(JSON.parse(readFileSync(join(out, "index.json"), "utf8")));
    const list = recs(index["fixtures"]);
    expect(list.length).toBe(replayable.length);
    const read = (f: unknown) => rec(JSON.parse(readFileSync(join(out, s(f)), "utf8")));
    const one = (path: string) => {
      const row = list.find((x) => x["path"] === path);
      if (row === undefined) throw new Error(`no fixture for ${path}`);
      expect(s(row["file"])).toMatch(new RegExp(`^fixtures/\\d+-${s(row["method"])}-${path.slice(1).replace(/\//g, "-")}\\.json$`));
      return read(row["file"]);
    };
    const sf = one("/api/search");
    expect(rec(sf["key"])["query"]).not.toMatch(/(^|&)(t|nonce)=/);
    expect(rec(sf["key"])["query"]).toMatch(/^client=web&page=1&q=apple&sig=[0-9a-f]{64}&v=3$/);
    expect(rec(sf["meta"])["rule"]).toBe("rules[0]");
    const lf = one("/api/login");
    expect([rec(lf["meta"])["rule"], rec(lf["meta"])["keyBody"]]).toEqual(["rules[1]", "form"]);
    expect(s(rec(lf["key"])["body"])).toMatch(/^password=.+&user=demo-user$/);
    const of = one("/s42/api/order");
    // the plaintext's token is redacted like any token field (docs/04 §8), in the key too
    expect(s(rec(of["key"])["body"])).toMatch(/^\{"item":"S42-ITEM-0001","qty":2,"token":"«r:secret:[0-9a-f]{8}»"\}$/);
    expect(rec(rec(of["response"])["decoded"])).toEqual({ by: "xor-decode", version: "1", mime: "application/json", body: S42_ORDER_JSON });
    // the password the human's account stores, in any spelling, is in no file
    const all = filesUnder(out).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const spelled of [LOGIN_PASSWORD, encodeURIComponent(LOGIN_PASSWORD), new URLSearchParams({ p: LOGIN_PASSWORD }).toString().slice(2)]) expect(all).not.toContain(spelled);
  }, 60_000);

  test("--format fixture-harness: the range plugin converts every fixture into its own files", async () => {
    const out = join(home, "harness");
    const res = await ok("bundle", "export", "fixtures", bundle, "--rules", rulesFile, "--out", out, "--format", "fixture-harness");
    expect([res["format"], res["index"], res["failed"], res["plugin"]]).toEqual(["fixture-harness", null, [], { name: "fixture-harness", version: "1" }]);
    const cases = readdirSync(join(out, "cases")).sort();
    expect(cases.length).toBe(Number(res["fixtures"]));
    const order = BundleReader.open(bundle).requests().find((x) => x.url.endsWith("/s42/api/order"));
    const c = rec(JSON.parse(readFileSync(join(out, "cases", `${order?.id ?? "?"}.json`), "utf8")));
    expect(c).toEqual({ when: { method: "POST", path: "/s42/api/order", query: "", body: expect.stringMatching(/^\{"item":"S42-ITEM-0001","qty":2,"token":"«r:secret:[0-9a-f]{8}»"\}$/) }, then: { status: 200, body: S42_ORDER_JSON }, rule: "rules[2]" });
    expect(existsSync(join(out, "index.json"))).toBe(false);
  }, 60_000);

  test("bundle export har --rules: t / nonce leave the search URL, nothing else changes", async () => {
    const a = await ok("bundle", "export", "har", bundle, "--out", join(home, "a.har"), "--no-redact");
    const b = await ok("bundle", "export", "har", bundle, "--out", join(home, "b.har"), "--no-redact", "--rules", rulesFile);
    expect(rec(b["rules"])).toEqual({ source: "file", file: rulesFile, rules: 3 });
    const entries = (f: string) => recs(rec(rec(JSON.parse(readFileSync(f, "utf8")))["log"])["entries"]);
    const ea = entries(s(a["out"]));
    const eb = entries(s(b["out"]));
    expect(eb.length).toBe(ea.length);
    const url = (e: Record<string, unknown>) => s(rec(e["request"])["url"]);
    const sa = ea.find((e) => url(e).includes("/api/search"));
    const sb = eb.find((e) => url(e).includes("/api/search"));
    const qa = new URL(url(sa ?? {})).searchParams;
    qa.delete("t");
    qa.delete("nonce");
    expect([...new URL(url(sb ?? {})).searchParams]).toEqual([...qa]);
    const strip = (list: Record<string, unknown>[]) => list.map((e) => ({ ...e, request: { ...rec(e["request"]), url: "", queryString: [] } }));
    expect(strip(eb)).toEqual(strip(ea));
  }, 60_000);

  test("daemon stop leaves no browser process of this TABCAP_HOME", async () => {
    await ok("daemon", "stop");
    let left = "";
    for (let i = 0; i < 50; i++) {
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes("Chrome for Testing") && l.includes(home)).join("\n").trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
