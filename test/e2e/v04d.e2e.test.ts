// L2 for 0.4-D: account pool / proxy pool on the real daemon and Chrome for
// Testing. Two local Basic-auth forward proxies (fwdproxy.ts; loopback forced
// through them with `<-loopback>`, spike 10-16 Q1) and the pool site
// (site.ts startPoolSite). Oracles: the proxies' request logs (which proxy saw
// which request, with or without valid credentials, any CONNECT), the site's
// log (which Cookie header each request carried), and the files tabcap wrote.
// Credentials are test values; nothing outside 127.0.0.1 is contacted: the
// default context runs with --proxy none (the black-hole check of
// tabcap.e2e.test.ts), the pool contexts only reach these local proxies, which
// forward to 127.0.0.1 and refuse CONNECT.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { startForwardProxy, type FwdProxy } from "./fwdproxy.ts";
import { startPoolSite, type PoolSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "example";
const P1 = { user: "pool1", pass: "e2e-Pool1:pw/7f3a!" };
const P2 = { user: "pool2", pass: "e2e-Pool2 pw&c41d" };
const SITE_PW = "Site-pass-e2e-0042";
const b64 = (u: { user: string; pass: string }) => Buffer.from(`${u.user}:${u.pass}`).toString("base64");
/** Every spelling of the proxy secrets that must never appear outside the store. */
const SECRETS = [P1, P2].flatMap((c) => [c.pass, b64(c), encodeURIComponent(c.pass), JSON.stringify(c.pass).slice(1, -1)]);

let home = "";
let site: PoolSite;
let px1: FwdProxy;
let px2: FwdProxy;
const outputs: string[] = [];

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME, TABCAP_LOG: "debug" },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  outputs.push(out, err);
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

/** Request paths the proxy forwarded (absolute-form target → path + query). */
const forwarded = (p: FwdProxy) => p.hits.filter((h) => h.answered === "forward").map((h) => new URL(h.target).pathname + new URL(h.target).search);
const cookiesAt = (path: string) => site.hits.filter((h) => h.path === path).map((h) => h.cookie);

describe.skipIf(!enabled)("tabcap 0.4-D L2 (account pool, proxy pool, per-account browser context)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4d-"));
    site = startPoolSite();
    px1 = startForwardProxy(P1);
    px2 = startForwardProxy(P2);
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/pool/me`, "--user", "alice", "--password-stdin"], SITE_PW + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    // a second account of the same site (store level: the CLI has one account per site add)
    const st = Store.open(paths({ TABCAP_HOME: home }).config);
    st.addAccount({ site: SITE, username: "bob", password: "Site-pass-e2e-0043" });
    st.close();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    px1.stop();
    px2.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("proxy add takes the password on stdin only; socks5 with a user is refused", async () => {
    const a1 = await tabcap(["proxy", "add", "p1", "--url", px1.url, "--user", P1.user, "--password-stdin", "--bypass", "<-loopback>"], P1.pass + "\n");
    expect(a1.ok).toBe(true);
    expect(rec(a1.data["proxy"])).toMatchObject({ name: "p1", hostPort: `127.0.0.1:${px1.port}`, user: P1.user, hasAuth: true, state: "unknown" });
    const a2 = await tabcap(["proxy", "add", "p2", "--url", px2.url, "--user", P2.user, "--password-stdin", "--bypass", "<-loopback>"], P2.pass + "\n");
    expect(a2.ok).toBe(true);
    const socks = await tabcap(["proxy", "add", "s5", "--url", "socks5://127.0.0.1:1080", "--user", "u", "--password-stdin"], "pw-pw-pw\n");
    expect(socks.error?.["code"]).toBe("unsupported");
    // no health URL configured, none given: nothing contacted, state unchecked
    const chk = await ok("proxy", "check", "p1");
    expect(chk).toMatchObject({ contacted: false, state: "unchecked" });
    expect(px1.hits.length).toBe(0);
    expect(await ok("account", "bind", `${SITE}.alice`, "--proxy", "p1")).toMatchObject({ proxy: "p1" });
    expect(await ok("account", "bind", `${SITE}.bob`, "--proxy", "p2")).toMatchObject({ proxy: "p2" });
    const list = await ok("account", "list", "--site", SITE);
    expect(list["accounts"]).toEqual([
      { account: `${SITE}.alice`, site: SITE, user: "alice", state: "active", coolUntil: null, proxy: "p1", lastUsedAt: null },
      { account: `${SITE}.bob`, site: SITE, user: "bob", state: "active", coolUntil: null, proxy: "p2", lastUsedAt: null },
    ]);
  }, 60_000);

  let bundleA = "";
  test("session start --account: own context through the account's proxy; fetchAuth marked; two accounts on two proxies do not cross", async () => {
    const A = ["--session", "sa"];
    const B = ["--session", "sb"];
    const sa = await ok("session", "start", "sa", "--site", SITE, "--account", "alice");
    expect(sa).toMatchObject({ site: SITE, account: "alice", proxy: "p1", browserContext: "own", cookiesRestored: 0, fetchAuth: "on" });
    bundleA = s((await ok("net", "start", ...A))["bundle"]);
    const nav = await ok("navigate", `${site.origin}/pool/set?v=alice-cookie-0001`, ...A);
    expect(nav["fetchAuth"]).toBe("on");
    const sb = await ok("session", "start", "sb", "--site", SITE, "--account", "bob");
    expect(sb).toMatchObject({ account: "bob", proxy: "p2", browserContext: "own" });
    await ok("navigate", `${site.origin}/pool/set?v=bob-cookie-0002`, ...B);
    await ok("navigate", `${site.origin}/pool/me?who=a`, ...A);
    await ok("navigate", `${site.origin}/pool/me?who=b`, ...B);
    // sa records, so its cookie snapshots were written back to the store and the value is a secret from then on
    // (docs/04 §19: saved cookie values >= 8 chars); sb does not record, nothing saved yet
    expect(s((await ok("evaluate", "document.getElementById('me').textContent", ...A))["value"])).toBe("cookie: pool_sid=<secret:example.cookie.pool_sid>");
    expect(s((await ok("evaluate", "document.getElementById('me').textContent", ...B))["value"])).toBe("cookie: pool_sid=bob-cookie-0002");
    // proxy logs: each account's requests through its own proxy only, after a 407 → credentials round
    expect(forwarded(px1)).toEqual(expect.arrayContaining(["/pool/set?v=alice-cookie-0001", "/pool/me?who=a"]));
    expect(forwarded(px2)).toEqual(expect.arrayContaining(["/pool/set?v=bob-cookie-0002", "/pool/me?who=b"]));
    expect(forwarded(px1).some((p) => p.includes("bob") || p.includes("who=b"))).toBe(false);
    expect(forwarded(px2).some((p) => p.includes("alice") || p.includes("who=a"))).toBe(false);
    expect(px1.hits.some((h) => h.answered === "407")).toBe(true);
    expect(px1.hits.filter((h) => h.answered === "forward").every((h) => h.authOk === true)).toBe(true);
    expect(px2.hits.filter((h) => h.answered === "forward").every((h) => h.authOk === true)).toBe(true);
    // the site saw each account's cookie only
    expect(cookiesAt("/pool/me?who=a")).toEqual(["pool_sid=alice-cookie-0001"]);
    expect(cookiesAt("/pool/me?who=b")).toEqual(["pool_sid=bob-cookie-0002"]);
    // nothing but 127.0.0.1 through the proxies, and no CONNECT (PreconnectToSearch is off)
    for (const p of [px1, px2]) {
      expect(p.hits.filter((h) => h.method === "CONNECT")).toEqual([]);
      expect(p.hits.every((h) => new URL(h.target).hostname === "127.0.0.1")).toBe(true);
    }
    await ok("net", "stop", ...A);
    const m: unknown = JSON.parse(readFileSync(join(bundleA, "manifest.json"), "utf8"));
    expect(rec(rec(m)["session"])).toMatchObject({ name: "sa", site: SITE, account: "alice", proxy: "p1" });
    // raw/cdp.jsonl did see Proxy-Authorization (spike Q2), and holds only the placeholder
    // the recorder's page-level Fetch and the pool's browser-level Fetch coexist: requests and bodies recorded
    const reqs = BundleReader.open(bundleA).requests();
    const me = reqs.find((r) => r.url === `${site.origin}/pool/me?who=a`);
    expect(me?.response?.status).toBe(200);
    expect(me?.response?.body).not.toBeNull();
    expect(reqs.find((r) => r.url.endsWith("/pool/set?v=alice-cookie-0001"))?.response?.status).toBe(200);
    const raw = readFileSync(join(bundleA, "raw", "cdp.jsonl"), "utf8");
    expect(raw).toContain("Basic <secret:proxy.p1>");
  }, 120_000);

  test("cookies survive session stop / session start (store sessions row, Storage.setCookies into the new context)", async () => {
    const stop = await ok("session", "stop", "sa");
    expect(stop).toMatchObject({ browserContext: "disposed", storeSession: { site: SITE, account: "alice" } });
    expect(Number(rec(stop["storeSession"])["cookies"])).toBeGreaterThanOrEqual(1);
    const again = await ok("session", "start", "sa2", "--site", SITE, "--account", "alice");
    expect(again).toMatchObject({ account: "alice", proxy: "p1", browserContext: "own" });
    expect(Number(again["cookiesRestored"])).toBeGreaterThanOrEqual(1);
    await ok("navigate", `${site.origin}/pool/me?who=a2`, "--session", "sa2");
    expect(cookiesAt("/pool/me?who=a2")).toEqual(["pool_sid=alice-cookie-0001"]);
    expect(forwarded(px1)).toContain("/pool/me?who=a2");
    // one session per pool account at a time
    const busy = await tabcap(["session", "start", "sa3", "--site", SITE, "--account", "alice"]);
    expect(busy.error?.["code"]).toBe("conflict");
    const list = await ok("account", "list", "--site", SITE);
    const alice = (Array.isArray(list["accounts"]) ? list["accounts"] : []).map(rec).find((x) => x["user"] === "alice");
    expect(typeof alice?.["lastUsedAt"]).toBe("number");
  }, 90_000);

  test("export-python --proxy-env writes the account's proxy URL (0600) and never prints it", async () => {
    const out = join(home, "client");
    const file = join(home, "proxy.env");
    const r = await ok("replay", "export-python", bundleA, "-o", out, "--proxy-env", file);
    expect(rec(r["proxyEnv"])).toMatchObject({ file, proxy: "p1", account: `${SITE}.alice`, mode: "0600" });
    expect(readFileSync(file, "utf8")).toBe(`TABCAP_PROXY_URL='http://${P1.user}:${encodeURIComponent(P1.pass).replace(/'/g, "%27")}@127.0.0.1:${px1.port}'\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(out, "client.py"), "utf8")).toContain('os.environ.get("TABCAP_PROXY_URL")');
    rmSync(file);
  }, 60_000);

  test("daemon stop writes the open pool contexts' cookies back before the browser goes", async () => {
    await ok("navigate", `${site.origin}/pool/set?v=bob-cookie-0003`, "--session", "sb");
    await ok("daemon", "stop");
    await Bun.sleep(500);
    const st = Store.open(paths({ TABCAP_HOME: home }).config);
    const saved = st.savedSession(SITE, "bob");
    st.close();
    const values = (Array.isArray(saved?.cookies) ? saved.cookies : []).map(rec).filter((c) => c["name"] === "pool_sid").map((c) => c["value"]);
    expect(values).toEqual(["bob-cookie-0003"]);
  }, 60_000);

  test("no proxy password or base64 credential anywhere: command outputs, daemon log, bundles, profile (state.db excepted)", () => {
    expect(outputs.length).toBeGreaterThan(20);
    const all = outputs.join("\n");
    for (const v of SECRETS) expect([v, all.includes(v)]).toEqual([v, false]);
    expect(all).toContain('"fetchAuth":"on"');
    const files = walk(home).filter((f) => !/state\.db(-wal|-shm|-journal)?$/.test(f));
    expect(files.some((f) => f.endsWith("daemon.log"))).toBe(true);
    expect(files.some((f) => f.endsWith(join("raw", "cdp.jsonl")))).toBe(true);
    for (const f of files) {
      const text = readFileSync(f).toString("latin1");
      for (const v of SECRETS) expect([f, v, text.includes(v)]).toEqual([f, v, false]);
    }
  }, 60_000);
});
