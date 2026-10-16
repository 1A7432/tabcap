// 0.4-D account pool / proxy pool (docs/08 §3 0.4, owner design 10-16).
// Oracles: the decided design (state-machine numbers, strategies, triggers),
// the spike 10-16 facts (Proxy-Authorization: Basic base64(user:pass) shows up
// in Network.requestWillBeSentExtraInfo; Fetch.authRequired names the proxy
// origin), RFC 7617 for the Basic credential form, and the CDP shapes of
// Target.createBrowserContext / Storage.get|setCookies / Fetch.*.
// Real-browser coverage: test/e2e/v04d.e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { scrubbedBody } from "../../src/daemon/main.ts";
import { checkThrough, chromeProxyServer, parseProxyUrl, proxyOrigin, proxyUrlWithAuth, type HttpClient } from "../../src/daemon/pool/proxy.ts";
import {
  accountCleared,
  accountOnBreaker,
  accountOnFailedLogin,
  accountState,
  allocate,
  COOLING_MS,
  nextProxy,
  parseRotateOn,
  proxyAfterCheck,
  proxyDue,
  proxyUnchecked,
  rotationDue,
} from "../../src/daemon/pool/rules.ts";
import { cookieParam, extContextError, Pool } from "../../src/daemon/pool/runtime.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { MIGRATIONS, SCHEMA_VERSION, Store, storePath, type AccountRow, type ProxyCheckPatch, type ProxyRow } from "../../src/daemon/store/db.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { accountAdd, accountBind, accountList, accountRemove, accountSetState, parseAccountRef, proxyAdd, proxyCheck, proxyList, proxyRemove, proxySetState } from "../../src/cli/pool.ts";
import { parsePoolConfig, readConfig, writeConfig } from "../../src/shared/config.ts";
import { TabcapError, ok } from "../../src/shared/envelope.ts";
import { paths } from "../../src/shared/paths.ts";
import { check } from "../../src/replay/check.ts";
import { accountProxy, writeProxyEnv } from "../../src/replay/proxyenv.ts";
import { buildReplayBundle } from "./_replay.ts";
import { expectMode } from "./_platform.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const USER = "pool1";
const PASS = "p1-Dummy:pw/7f3a";
const B64 = Buffer.from(`${USER}:${PASS}`).toString("base64"); // RFC 7617: base64(user-id ":" password)

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
}
async function codeOfAsync(f: () => Promise<unknown>): Promise<string | null> {
  try {
    await f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
}

function account(username: string, o: Partial<AccountRow> = {}): AccountRow {
  return { site: "example", username, proxy: null, state: "active", coolUntil: null, lastUsedAt: null, failStreak: 0, lastFailAt: null, created: 0, ...o };
}

describe("store migration 3 (additive)", () => {
  test("a v2 store gets proxies and the pool columns; its rows stay as they were", () => {
    const cfg = join(tmp("tabcap-pool-mig-"), "config");
    mkdirSync(cfg, { mode: 0o700 });
    const raw = new Database(storePath(cfg), { create: true });
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const sql of MIGRATIONS.slice(0, 2)) raw.exec(sql);
    raw.query("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
    raw.query("INSERT INTO sites (name, entry_url, domains, created) VALUES ('example', 'http://127.0.0.1:1/', '[]', 5)").run();
    raw.query("INSERT INTO accounts (site, username, password, created) VALUES ('example', 'alice', 'Old-Pass-12', 6)").run();
    raw.query("INSERT INTO guard_counters (site, session_name, login_attempts, requests) VALUES ('example', 's1', 1, 3)").run();
    raw.close();
    chmodSync(storePath(cfg), 0o600);
    const s = Store.open(cfg);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(3);
    expect(s.tables()).toEqual(["accounts", "bundles", "guard_counters", "login_recipes", "meta", "proxies", "sessions", "sites"]);
    expect(s.account("example", "alice")).toEqual({ site: "example", username: "alice", proxy: null, state: "active", coolUntil: null, lastUsedAt: null, failStreak: 0, lastFailAt: null, created: 6 });
    expect(s.secretValue("example", "password")).toBe("Old-Pass-12");
    expect(s.guardCounter("example", "s1").loginAttempts).toBe(1);
    expect(s.requestCounter("example", "s1").requests).toBe(3);
    // account dimension: per hourly window, separate from the session rows
    const t = 1_760_000_000_000;
    expect(s.noteAccountRequest("example", "alice", t).requests).toBe(1);
    expect(s.noteAccountRequest("example", "alice", t + 1000).requests).toBe(2);
    expect(s.noteAccountLogin("example", "alice", t + 2000)).toMatchObject({ requests: 2, logins: 1 });
    expect(s.accountCounter("example", "alice", t + 3_600_000)).toMatchObject({ requests: 0, logins: 0 });
    expect(s.guardCounter("example", "s1").loginAttempts).toBe(1);
    s.close();
  });
});

describe("proxy state machine (fake clock)", () => {
  const p0: Pick<ProxyRow, "state" | "failCount"> = { state: "unknown", failCount: 0 };
  test("unknown → up on success; up → down after 3 consecutive failures; down rechecks after 1 / 5 / 15 min; one success → up", () => {
    let p: Pick<ProxyRow, "state" | "failCount"> & ProxyCheckPatch = { ...p0, ...proxyAfterCheck(p0, { ok: true, latencyMs: 12 }, 1000) };
    expect(p).toMatchObject({ state: "up", failCount: 0, lastOkAt: 1000, lastCheckAt: 1000, latencyMs: 12, recheckAt: null });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 2000) };
    expect(p).toMatchObject({ state: "up", failCount: 1 });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 3000) };
    expect(p).toMatchObject({ state: "up", failCount: 2 });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 4000) };
    expect(p).toMatchObject({ state: "down", failCount: 3, recheckAt: 4000 + 60_000 });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 70_000) };
    expect(p).toMatchObject({ state: "down", recheckAt: 70_000 + 5 * 60_000 });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 400_000) };
    expect(p).toMatchObject({ state: "down", recheckAt: 400_000 + 15 * 60_000 });
    p = { ...p, ...proxyAfterCheck(p, { ok: false, latencyMs: null }, 2_000_000) };
    expect(p).toMatchObject({ state: "down", recheckAt: 2_000_000 + 15 * 60_000 });
    p = { ...p, ...proxyAfterCheck(p, { ok: true, latencyMs: 5 }, 3_000_000) };
    expect(p).toMatchObject({ state: "up", failCount: 0, recheckAt: null });
  });

  test("a success in between resets the count; disabled stays disabled; no URL → unchecked", () => {
    const p: Pick<ProxyRow, "state" | "failCount"> = { state: "up", failCount: 2 };
    expect(proxyAfterCheck(p, { ok: true, latencyMs: 1 }, 1).failCount).toBe(0);
    expect(proxyAfterCheck({ state: "disabled", failCount: 9 }, { ok: true, latencyMs: 1 }, 1).state).toBeUndefined();
    expect(proxyAfterCheck({ state: "disabled", failCount: 9 }, { ok: false, latencyMs: 1 }, 1).state).toBeUndefined();
    expect(proxyUnchecked({ state: "up" })).toEqual({ state: "unchecked" });
    expect(proxyUnchecked({ state: "disabled" })).toEqual({});
  });

  test("due: down by its recheck time, others by the interval, disabled never", () => {
    expect(proxyDue({ state: "down", lastCheckAt: 0, recheckAt: 100 }, 99, 300_000)).toBe(false);
    expect(proxyDue({ state: "down", lastCheckAt: 0, recheckAt: 100 }, 100, 300_000)).toBe(true);
    expect(proxyDue({ state: "up", lastCheckAt: 0, recheckAt: null }, 299_999, 300_000)).toBe(false);
    expect(proxyDue({ state: "up", lastCheckAt: 0, recheckAt: null }, 300_000, 300_000)).toBe(true);
    expect(proxyDue({ state: "unknown", lastCheckAt: null, recheckAt: null }, 0, 300_000)).toBe(true);
    expect(proxyDue({ state: "disabled", lastCheckAt: null, recheckAt: null }, 1e12, 300_000)).toBe(false);
  });
});

describe("account state machine (fake clock)", () => {
  test("breaker → cooling for 30 min → active when the time has passed", () => {
    const a = account("a");
    const patch = accountOnBreaker(a, 1000);
    expect(patch).toEqual({ state: "cooling", coolUntil: 1000 + COOLING_MS });
    expect(COOLING_MS).toBe(30 * 60_000);
    const cooled = { ...a, ...patch };
    expect(accountState(cooled, 1000 + COOLING_MS - 1)).toBe("cooling");
    expect(accountState(cooled, 1000 + COOLING_MS)).toBe("active");
    expect(accountOnBreaker(account("d", { state: "disabled" }), 1)).toEqual({});
    expect(accountOnBreaker(account("n", { state: "needs-human" }), 1)).toEqual({});
  });

  test("2 failed logins within 24 h → needs-human; failures 24 h apart do not add up; only clearing ends it", () => {
    const H = 3_600_000;
    let a = account("a");
    let r = accountOnFailedLogin(a, 0);
    expect(r).toMatchObject({ failStreak: 1, needsHuman: false });
    a = { ...a, failStreak: r.failStreak, lastFailAt: r.lastFailAt ?? null };
    r = accountOnFailedLogin(a, 24 * H + 1); // more than 24 h later: a new streak
    expect(r).toMatchObject({ failStreak: 1, needsHuman: false });
    a = { ...a, failStreak: r.failStreak, lastFailAt: r.lastFailAt ?? null };
    r = accountOnFailedLogin(a, 24 * H + 1 + 23 * H);
    expect(r).toMatchObject({ failStreak: 2, needsHuman: true, state: "needs-human" });
    const nh = { ...a, state: r.state ?? a.state };
    expect(accountState(nh, 1e15)).toBe("needs-human"); // no timeout clears it
    expect(accountCleared()).toEqual({ state: "active", coolUntil: null, failStreak: 0, lastFailAt: null });
  });
});

describe("allocation strategies", () => {
  const H = 3_600_000;
  const accs = [account("a", { lastUsedAt: 3 * H }), account("b", { lastUsedAt: 1 * H }), account("c", { lastUsedAt: null }), account("d", { lastUsedAt: 2 * H })];
  const all = () => true;
  test("fixed: the first eligible; lru: oldest last_used_at (never used first); round-robin: next after the most recent", () => {
    expect(allocate("fixed", accs, all)?.username).toBe("a");
    expect(allocate("fixed", accs, (x) => x.username !== "a")?.username).toBe("b");
    expect(allocate("lru", accs, all)?.username).toBe("c");
    expect(allocate("lru", accs, (x) => x.username !== "c")?.username).toBe("b");
    expect(allocate("round-robin", accs, all)?.username).toBe("b"); // most recent is a (3 H) → next in order
    expect(allocate("round-robin", accs, (x) => x.username !== "b")?.username).toBe("c");
    expect(allocate("round-robin", [account("x"), account("y")], all)?.username).toBe("x"); // nothing used yet
    expect(allocate("round-robin", accs, () => false)).toBeNull();
  });

  test("Pool.pick: disabled, cooling, needs-human and down-proxy accounts are never allocated; auto with none left is a conflict", () => {
    const cfg = join(tmp("tabcap-pool-pick-"), "config");
    const s = Store.open(cfg);
    s.addSite({ name: "example", entryUrl: "http://127.0.0.1:1/", domains: [], username: "a", password: "Pass-a-123" }, 1);
    for (const [u, t] of [["b", 2], ["c", 3], ["d", 4]] as const) s.addAccount({ site: "example", username: u, password: `Pass-${u}-123` }, t);
    s.addProxy({ name: "px", scheme: "http", host: "127.0.0.1", port: 9, username: null, password: null, bypass: null });
    let now = 10 * H;
    const pool = new Pool(() => now);
    s.patchAccount("example", "a", { state: "disabled" });
    s.patchAccount("example", "b", { state: "cooling", coolUntil: now + 1000 });
    s.patchAccount("example", "c", { state: "needs-human" });
    s.bindAccount("example", "d", "px");
    s.updateProxy("px", { state: "down" });
    expect(codeOf(() => pool.pick(s, "example", "auto"))).toBe("conflict");
    expect(codeOf(() => pool.pick(s, "example", "a"))).toBe("conflict");
    expect(codeOf(() => pool.pick(s, "example", "nobody"))).toBe("not-found");
    s.updateProxy("px", { state: "up" });
    expect(pool.pick(s, "example", "auto")?.username).toBe("d");
    now += 1000; // b's cooling has passed
    expect(pool.pick(s, "example", "auto")?.username).toBe("b");
    s.close();
  });
});

describe("egress rotation", () => {
  test("only per-session, every:<N>requests, every:<T>min", () => {
    expect(parseRotateOn("per-session")).toEqual({ kind: "per-session" });
    expect(parseRotateOn("every:50requests")).toEqual({ kind: "requests", n: 50 });
    expect(parseRotateOn("every:15min")).toEqual({ kind: "minutes", n: 15 });
    for (const bad of ["on-403", "every:0requests", "every:5", "every:5h", "", "per-request"]) expect(codeOf(() => parseRotateOn(bad))).toBe("bad-input");
  });

  test("triggers fire on sessions, request counts and elapsed minutes; the ring skips unusable proxies", () => {
    const r = { current: "p1", rotatedAt: 0, requests: 0, sessions: 0 };
    expect(rotationDue({ kind: "per-session" }, r, 0)).toBe(false);
    expect(rotationDue({ kind: "per-session" }, { ...r, sessions: 1 }, 0)).toBe(true);
    expect(rotationDue({ kind: "requests", n: 3 }, { ...r, requests: 2 }, 0)).toBe(false);
    expect(rotationDue({ kind: "requests", n: 3 }, { ...r, requests: 3 }, 0)).toBe(true);
    expect(rotationDue({ kind: "minutes", n: 5 }, r, 5 * 60_000 - 1)).toBe(false);
    expect(rotationDue({ kind: "minutes", n: 5 }, r, 5 * 60_000)).toBe(true);
    expect(nextProxy(["p1", "p2", "p3"], "p1", () => true)).toBe("p2");
    expect(nextProxy(["p1", "p2", "p3"], "p3", () => true)).toBe("p1");
    expect(nextProxy(["p1", "p2", "p3"], "p1", (n) => n !== "p2")).toBe("p3");
    expect(nextProxy(["p1", "p2"], "p1", () => false)).toBe("p1");
  });

  test("Pool.egress: fixed keeps the bound proxy; rotate per-session moves to the next on the second session", () => {
    const home = tmp("tabcap-pool-eg-");
    const s = Store.open(join(home, "config"));
    s.addSite({ name: "example", entryUrl: "http://127.0.0.1:1/", domains: [], username: "a", password: "Pass-a-123" });
    for (const [n, port] of [["p1", 9001], ["p2", 9002]] as const) s.addProxy({ name: n, scheme: "http", host: "127.0.0.1", port, username: null, password: null, bypass: null });
    s.bindAccount("example", "a", "p1");
    const acc = s.account("example", "a");
    if (acc === null) throw new Error("no account");
    const fixed = new Pool(() => 0);
    fixed.reloadConfig(join(home, "absent.json"));
    expect(fixed.egress(s, acc).proxy).toBe("p1");
    expect(fixed.egress(s, acc).proxy).toBe("p1");
    const cfgFile = join(home, "rotate.json");
    writeFileSync(cfgFile, JSON.stringify({ pool: { egress: { mode: "rotate", rotateOn: "per-session" } } }));
    const rot = new Pool(() => 0);
    rot.reloadConfig(cfgFile);
    const e1 = rot.egress(s, acc);
    expect(e1.proxy).toBe("p1");
    e1.commit();
    const e2 = rot.egress(s, acc);
    expect(e2.proxy).toBe("p2");
    e2.commit();
    s.updateProxy("p1", { state: "disabled" });
    expect(rot.egress(s, acc).proxy).toBe("p2"); // p1 unusable: the ring skips it
    writeFileSync(cfgFile, JSON.stringify({ pool: { egress: { mode: "rotate", rotateOn: "on-403" } } }));
    rot.reloadConfig(cfgFile);
    expect(codeOf(() => rot.egress(s, acc))).toBe("bad-input");
    s.close();
  });

  test("config.json pool: defaults, every key checked, other keys kept on rewrite", () => {
    expect(parsePoolConfig(undefined)).toEqual({ strategy: "fixed", egress: { mode: "fixed", rotateOn: "per-session" }, health: { url: null, intervalS: 300 }, budget: { requestsPerHour: null } });
    expect(parsePoolConfig({ strategy: "lru", budget: { requestsPerHour: 100 } })).toMatchObject({ strategy: "lru", budget: { requestsPerHour: 100 } });
    for (const bad of [{ strategy: "random" }, { egress: { mode: "sometimes" } }, { health: { url: "ftp://x" } }, { health: { intervalS: 1 } }, { budget: { requestsPerHour: 0 } }, "x"]) {
      expect(codeOf(() => parsePoolConfig(bad))).toBe("bad-input");
    }
    const file = join(tmp("tabcap-pool-cfg-"), "config.json");
    writeFileSync(file, JSON.stringify({ pool: { strategy: "lru" }, proxy: "none" }));
    writeConfig(file, { ...readConfig(file), chrome: { executablePath: "/x", version: "1", platform: null } });
    const back: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(back).toMatchObject({ pool: { strategy: "lru" }, proxy: "none", chrome: { executablePath: "/x" } });
  });
});

describe("ext mode", () => {
  test("only system (or unbound) accounts, one at a time; else ext.no-context pointing to direct", () => {
    expect(extContextError(null, { site: "example", user: "a" }, [])).toBeNull();
    expect(extContextError("system", { site: "example", user: "a" }, [{ site: "example", account: "a" }])).toBeNull();
    const e1 = extContextError("p1", { site: "example", user: "a" }, []);
    expect(e1?.code).toBe("ext.no-context");
    expect(e1?.next).toContain("direct");
    expect(extContextError("none", { site: "example", user: "a" }, [])?.code).toBe("ext.no-context");
    expect(extContextError("system", { site: "example", user: "b" }, [{ site: "example", account: "a" }])?.code).toBe("ext.no-context");
  });
});

describe("proxy helpers", () => {
  test("--url: scheme://host:port only, never credentials; Chrome gets host:port", () => {
    expect(parseProxyUrl("http://127.0.0.1:8080")).toEqual({ scheme: "http", host: "127.0.0.1", port: 8080 });
    expect(parseProxyUrl("socks5://[::1]:1080")).toEqual({ scheme: "socks5", host: "::1", port: 1080 });
    expect(parseProxyUrl("https://proxy.test")).toEqual({ scheme: "https", host: "proxy.test", port: 443 });
    expect(codeOf(() => parseProxyUrl(`http://${USER}:x@127.0.0.1:8080`))).toBe("usage");
    expect(codeOf(() => parseProxyUrl("ftp://127.0.0.1:21"))).toBe("usage");
    expect(codeOf(() => parseProxyUrl("http://127.0.0.1:8080/path"))).toBe("usage");
    const row = { scheme: "http" as const, host: "127.0.0.1", port: 8080, username: USER, password: PASS };
    expect(chromeProxyServer(row)).toBe("127.0.0.1:8080");
    expect(chromeProxyServer({ ...row, scheme: "socks5" })).toBe("socks5://127.0.0.1:8080");
    expect(proxyOrigin(row)).toBe("http://127.0.0.1:8080");
    expect(proxyUrlWithAuth(row)).toBe(`http://pool1:${encodeURIComponent(PASS)}@127.0.0.1:8080`);
  });

  test("cookieParam keeps what Storage.setCookies takes; session cookies get no expires", () => {
    expect(cookieParam({ name: "sid", value: "v", domain: "127.0.0.1", path: "/", expires: -1, size: 4, httpOnly: true, secure: false, session: true, sameSite: "Lax", priority: "Medium", sameParty: false, sourceScheme: "NonSecure", sourcePort: 4310 })).toEqual({
      name: "sid",
      value: "v",
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "Lax",
      priority: "Medium",
      sourceScheme: "NonSecure",
      sourcePort: 4310,
    });
    expect(cookieParam({ name: "t", value: "1", domain: "x", path: "/", expires: 1790000000, session: false })).toMatchObject({ expires: 1790000000 });
    expect(cookieParam({ name: "", value: "1", domain: "x" })).toBeNull();
    expect(cookieParam({ name: "a", value: 1, domain: "x" })).toBeNull();
  });
});

/** Store with one site, account `alice` bound to proxy p1 (Basic auth), under a fresh TABCAP_HOME. */
function poolHome() {
  const home = tmp("tabcap-pool-home-");
  const p = paths({ TABCAP_HOME: home });
  const s = Store.open(p.config);
  s.addSite({ name: "example", entryUrl: "http://127.0.0.1:4310/", domains: ["example.invalid"], username: "alice", password: "Site-pass-123" });
  s.addProxy({ name: "p1", scheme: "http", host: "127.0.0.1", port: 8080, username: USER, password: PASS, bypass: "<-loopback>" });
  s.bindAccount("example", "alice", "p1");
  return { home, p, s };
}

describe("secret substitution of proxy credentials", () => {
  test("the store's table holds the password, user:pass@host:port and base64(user:pass) under proxy.<name>", () => {
    const { s } = poolHome();
    const ks = s.knownSecrets().filter((k) => k.ref === "proxy.p1").map((k) => k.value);
    expect(ks).toContain(PASS);
    expect(ks).toContain(`${USER}:${PASS}@127.0.0.1:8080`);
    expect(ks).toContain(B64);
    s.close();
  });

  test("every daemon output shows <secret:proxy.p1> instead", () => {
    const { p, s } = poolHome();
    const d = new Daemon(p);
    d.store = s;
    d.refreshSecrets();
    const env = ok({ a: PASS, b: `http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:8080/`, c: `Basic ${B64}`, d: `${USER}:${PASS}@127.0.0.1:8080`, e: { [`k-${PASS}`]: 1 } });
    const body = scrubbedBody(d, env);
    for (const v of [PASS, B64, encodeURIComponent(PASS), JSON.stringify(PASS).slice(1, -1)]) expect(body).not.toContain(v);
    expect(body).toContain("<secret:proxy.p1>");
    expect(JSON.parse(body)).toMatchObject({ ok: true, data: { a: "<secret:proxy.p1>", c: "Basic <secret:proxy.p1>", d: "<secret:proxy.p1>" } });
    // the recorder's own table holds proxy secrets only (the login POST body stays as sent, docs/04 §8.1)
    expect(d.proxySecrets.scrub("Site-pass-123")).toBe("Site-pass-123");
    expect(d.proxySecrets.scrub(B64)).toBe("<secret:proxy.p1>");
    s.close();
  });

  test("a synthetic Network.requestWillBeSentExtraInfo with Proxy-Authorization: raw/cdp.jsonl and events.jsonl carry the placeholder", async () => {
    const { p, s } = poolHome();
    const d = new Daemon(p);
    d.store = s;
    d.refreshSecrets();
    const f = fakeBrowser();
    const tabs = new Tabs(f.t, false);
    await tabs.createTab("s1");
    const dir = join(tmp("tabcap-pool-rec-"), "b");
    const rec = await Recorder.start({ session: "s1", dir, t: f.t, tabs, browser: { version: "Chrome/155", userAgent: "UA" }, scrubOut: (line) => d.proxySecrets.scrub(line) });
    const url = "http://127.0.0.1:4310/api/x";
    f.emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", documentURL: url, request: { url, method: "GET", headers: {} }, timestamp: 1, wallTime: 1760000000, type: "XHR", initiator: { type: "other" } });
    f.emit("Network.requestWillBeSentExtraInfo", { requestId: "R1", associatedCookies: [], headers: { Host: "127.0.0.1:4310", "Proxy-Authorization": `Basic ${B64}`, "Proxy-Connection": "keep-alive" }, connectTiming: { requestTime: 1 } });
    f.emit("Network.responseReceived", { requestId: "R1", loaderId: "L1", timestamp: 1.1, type: "XHR", response: { url, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, mimeType: "application/json", protocol: "http/1.1" } });
    f.emit("Network.loadingFinished", { requestId: "R1", timestamp: 1.2, encodedDataLength: 2 });
    await Bun.sleep(30);
    await rec.stop();
    const rawText = readFileSync(join(dir, "raw", "cdp.jsonl"), "utf8");
    const eventsText = readFileSync(join(dir, "events.jsonl"), "utf8");
    for (const text of [rawText, eventsText]) {
      expect(text).not.toContain(B64);
      expect(text).not.toContain(PASS);
    }
    expect(rawText).toContain("Basic <secret:proxy.p1>");
    const req = BundleReader.open(dir).requests().find((r) => r.url === url);
    expect(req?.request.headers["proxy-authorization"]).toBe("Basic <secret:proxy.p1>");
    s.close();
  });
});

/** Page tab S1 plus the browser-level calls the pool makes; records every send. */
function fakeBrowser(answers: Record<string, (params: CdpParams) => Record<string, unknown>> = {}) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const sent: Array<{ method: string; params: CdpParams; sessionId: string | null }> = [];
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      sent.push({ method, params, sessionId });
      const a = answers[method];
      if (a !== undefined) return a(params);
      if (method === "Target.createTarget") return { targetId: "T1" };
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => target(),
    detach: async () => undefined,
    waitAttached: async () => target(),
    targets: () => [],
  };
  const emit = (method: string, params: Record<string, unknown>, sessionId: string | null = "S1") => {
    for (const l of [...listeners]) l({ method, params, sessionId });
  };
  return { t, emit, sent };
}

describe("Pool on a fake browser: context, Fetch auth, cookies", () => {
  test("one context per account through host:port; the handler answers the proxy origin's challenge; cookies restored and saved by context; dispose turns it off", async () => {
    const { s } = poolHome();
    s.saveSession("example", "alice", [{ name: "sid", value: "saved-session-0001", domain: "127.0.0.1", path: "/", expires: -1, session: true, httpOnly: true, secure: false, size: 20 }], 1);
    let jar: unknown[] = [];
    const f = fakeBrowser({
      "Target.createBrowserContext": () => ({ browserContextId: "CTX1" }),
      "Storage.getCookies": () => ({ cookies: jar }),
    });
    const pool = new Pool(() => 1000);
    const row = s.proxy("p1");
    if (row === null) throw new Error("no proxy");
    const ctx = await pool.open(f.t, { session: "s1", site: "example", account: "alice", proxy: row });
    const create = f.sent.find((x) => x.method === "Target.createBrowserContext");
    expect(create).toEqual({ method: "Target.createBrowserContext", params: { proxyServer: "127.0.0.1:8080", proxyBypassList: "<-loopback>", disposeOnDetach: false }, sessionId: null });
    expect(JSON.stringify(create)).not.toContain(PASS);
    expect(f.sent.find((x) => x.method === "Fetch.enable")).toEqual({ method: "Fetch.enable", params: { handleAuthRequests: true }, sessionId: null });
    expect(pool.fetchAuth).toBe(true);
    expect(await pool.restoreCookies(s, f.t, ctx)).toBe(1);
    expect(f.sent.find((x) => x.method === "Storage.setCookies")?.params).toEqual({ cookies: [{ name: "sid", value: "saved-session-0001", domain: "127.0.0.1", path: "/", secure: false, httpOnly: true }], browserContextId: "CTX1" });
    // challenges: browser-session events only
    f.emit("Fetch.requestPaused", { requestId: "I1" }, null);
    f.emit("Fetch.authRequired", { requestId: "I2", authChallenge: { source: "Proxy", origin: "http://127.0.0.1:8080", scheme: "basic", realm: "x" } }, null);
    f.emit("Fetch.authRequired", { requestId: "I3", authChallenge: { source: "Proxy", origin: "http://127.0.0.1:9999", scheme: "basic", realm: "x" } }, null);
    f.emit("Fetch.authRequired", { requestId: "I4", authChallenge: { source: "Server", origin: "http://127.0.0.1:4310", scheme: "basic", realm: "x" } }, null);
    f.emit("Fetch.requestPaused", { requestId: "P-page" }, "S1"); // the recorder's, not ours
    await Bun.sleep(5);
    const answers = f.sent.filter((x) => x.method.startsWith("Fetch.continue")).map((x) => [x.method, x.params["requestId"], x.params["authChallengeResponse"] ?? null, x.sessionId]);
    expect(answers).toEqual([
      ["Fetch.continueRequest", "I1", null, null],
      ["Fetch.continueWithAuth", "I2", { response: "ProvideCredentials", username: USER, password: PASS }, null],
      ["Fetch.continueWithAuth", "I3", { response: "CancelAuth" }, null],
      ["Fetch.continueWithAuth", "I4", { response: "Default" }, null],
    ]);
    jar = [{ name: "sid", value: "fresh-session-0002", domain: "127.0.0.1", path: "/" }];
    expect(await pool.saveCookies(s, f.t, "s1")).toBe(1);
    expect(f.sent.filter((x) => x.method === "Storage.getCookies").map((x) => x.params)).toEqual([{ browserContextId: "CTX1" }]);
    expect(s.savedSession("example", "alice")?.cookies).toEqual(jar);
    expect(await pool.close(f.t, "s1")).toBe(true);
    expect(f.sent.filter((x) => x.method === "Target.disposeBrowserContext" || x.method === "Fetch.disable").map((x) => [x.method, x.params, x.sessionId])).toEqual([
      ["Target.disposeBrowserContext", { browserContextId: "CTX1" }, null],
      ["Fetch.disable", {}, null],
    ]);
    expect(pool.fetchAuth).toBe(false);
    s.close();
  });

  test("a second proxy on the same address with other credentials is refused (the challenge names the address only)", async () => {
    const { s } = poolHome();
    s.addProxy({ name: "p2", scheme: "http", host: "127.0.0.1", port: 8080, username: "pool2", password: "Other-pass-99", bypass: null });
    const f = fakeBrowser({ "Target.createBrowserContext": () => ({ browserContextId: `CTX${Math.random()}` }) });
    const pool = new Pool();
    const p1 = s.proxy("p1");
    const p2 = s.proxy("p2");
    if (p1 === null || p2 === null) throw new Error("no proxy");
    await pool.open(f.t, { session: "s1", site: "example", account: "alice", proxy: p1 });
    expect(await codeOfAsync(() => pool.open(f.t, { session: "s2", site: "example", account: "bob", proxy: p2 }))).toBe("conflict");
    s.close();
  });
});

describe("tabcap proxy / account (CLI side)", () => {
  test("proxy add: password from stdin only, never in output; socks5 with a user → unsupported; plain socks5 allowed", async () => {
    const home = tmp("tabcap-pool-cli-");
    const p = paths({ TABCAP_HOME: home });
    const out = await proxyAdd(p, { name: "p1", url: "http://127.0.0.1:8080", user: USER, passwordStdin: true, bypass: "<-loopback>" }, () => Promise.resolve(PASS + "\n"));
    expect(JSON.stringify(out)).not.toContain(PASS);
    expect(out).toMatchObject({ proxy: { name: "p1", scheme: "http", hostPort: "127.0.0.1:8080", user: USER, hasAuth: true, state: "unknown", bypass: "<-loopback>" }, secret: "proxy.p1" });
    expect(await codeOfAsync(() => proxyAdd(p, { name: "s5", url: "socks5://127.0.0.1:1080", user: "u", passwordStdin: true }, () => Promise.resolve("pw-pw-pw")))).toBe("unsupported");
    expect(await codeOfAsync(() => proxyAdd(p, { name: "p1", url: "http://127.0.0.1:1", passwordStdin: false }))).toBe("conflict");
    expect(await codeOfAsync(() => proxyAdd(p, { name: "none", url: "http://127.0.0.1:1" }))).toBe("usage");
    expect(await codeOfAsync(() => proxyAdd(p, { name: "x", url: "http://127.0.0.1:1", passwordStdin: true }, () => Promise.resolve("pw")))).toBe("usage");
    const plain = await proxyAdd(p, { name: "s5", url: "socks5://127.0.0.1:1080" });
    expect(plain).toMatchObject({ proxy: { scheme: "socks5", hasAuth: false }, secret: null });
    const list = proxyList(p);
    expect(JSON.stringify(list)).not.toContain(PASS);
    expect(list).toMatchObject({ proxies: [{ name: "p1", hasAuth: true }, { name: "s5", hasAuth: false }] });
    expectMode(storePath(p.config), 0o600);
    expect(proxyRemove(p, { name: "s5" })).toEqual({ proxy: "s5", removed: true });
    expect(codeOf(() => proxyRemove(p, { name: "s5" }))).toBe("not-found");
    rmSync(home, { recursive: true, force: true });
  });

  test("proxy check without a URL contacts nothing and records unchecked; with one it follows the state machine", async () => {
    const { p, s } = poolHome();
    s.close();
    let calls = 0;
    const fake: HttpClient = async (_u, init) => {
      calls++;
      expect(init.proxy).toBe(`http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:8080`); // the credentialed URL goes to the HTTP client only
      return new Response("ok", { status: calls === 1 ? 200 : 407 });
    };
    const none = await proxyCheck(p, { name: "p1" }, { fetch: fake });
    expect(none).toMatchObject({ proxy: "p1", contacted: false, url: null, state: "unchecked" });
    expect(calls).toBe(0);
    const up = await proxyCheck(p, { name: "p1", url: "http://127.0.0.1:4310/" }, { fetch: fake, now: () => 1000 });
    expect(up).toMatchObject({ contacted: true, ok: true, status: 200, state: "up" });
    for (let i = 0; i < 3; i++) await proxyCheck(p, { name: "p1", url: "http://127.0.0.1:4310/" }, { fetch: fake, now: () => 2000 + i });
    expect(proxyList(p)).toMatchObject({ proxies: [{ name: "p1", state: "down", failCount: 3, recheckAt: 2002 + 60_000 }] });
    const failing: HttpClient = async () => Promise.reject(new Error(`connect failed via http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:8080`));
    const err = await proxyCheck(p, { name: "p1", url: "http://127.0.0.1:4310/" }, { fetch: failing, now: () => 9e9 });
    expect(JSON.stringify(err)).not.toContain(encodeURIComponent(PASS));
    expect(JSON.stringify(err)).toContain("<secret:proxy.p1>");
  });

  test("checkThrough: 407 and 5xx fail, other answers pass; SOCKS cannot be checked", async () => {
    const row: ProxyRow = { name: "p", scheme: "http", host: "127.0.0.1", port: 1, username: null, password: null, bypass: null, state: "unknown", failCount: 0, lastCheckAt: null, lastOkAt: null, latencyMs: null, recheckAt: null, created: 0 };
    const answer =
      (status: number): HttpClient =>
      async () =>
        new Response("", { status });
    expect((await checkThrough(row, "http://x/", answer(404)))?.ok).toBe(true);
    expect((await checkThrough(row, "http://x/", answer(407)))?.ok).toBe(false);
    expect((await checkThrough(row, "http://x/", answer(502)))?.ok).toBe(false);
    expect(await checkThrough({ ...row, scheme: "socks5" }, "http://x/", answer(200))).toBeNull();
  });

  test("account bind / list / set-state", () => {
    const { p, s } = poolHome();
    s.close();
    expect(parseAccountRef("example.a.b@mail.test")).toEqual({ site: "example", user: "a.b@mail.test" });
    expect(codeOf(() => parseAccountRef("nodot"))).toBe("usage");
    expect(accountBind(p, { account: "example.alice", proxy: "system" })).toEqual({ account: "example.alice", site: "example", user: "alice", proxy: "system" });
    expect(codeOf(() => accountBind(p, { account: "example.alice", proxy: "nope" }))).toBe("not-found");
    expect(codeOf(() => accountBind(p, { account: "example.bob", proxy: "p1" }))).toBe("not-found");
    accountBind(p, { account: "example.alice", proxy: "p1" });
    expect(codeOf(() => proxyRemove(p, { name: "p1" }))).toBe("conflict");
    expect(accountList(p, { site: "example" })).toEqual({ accounts: [{ account: "example.alice", site: "example", user: "alice", state: "active", coolUntil: null, proxy: "p1", lastUsedAt: null }] });
    expect(accountSetState(p, { account: "example.alice", state: "disabled" })).toMatchObject({ state: "disabled" });
    expect(codeOf(() => accountSetState(p, { account: "example.alice", state: "needs-human" }))).toBe("usage");
    const st = Store.open(p.config);
    st.patchAccount("example", "alice", { state: "needs-human", failStreak: 2, lastFailAt: 5 });
    st.close();
    expect(accountSetState(p, { account: "example.alice", state: "active" })).toMatchObject({ from: "needs-human", state: "active" });
    const st2 = Store.open(p.config);
    expect(st2.account("example", "alice")).toMatchObject({ state: "active", failStreak: 0, lastFailAt: null });
    st2.close();
  });
});

describe("downstream: the generated client's proxy and replay check --live", () => {
  test("--proxy-env writes TABCAP_PROXY_URL (0600); the result never holds the URL", () => {
    const { home, p, s } = poolHome();
    s.close();
    const ap = accountProxy(p.config, "example", "alice");
    if (ap === null) throw new Error("no proxy");
    const file = join(home, "out", "proxy.env");
    const r = writeProxyEnv(file, ap);
    expect(r).toEqual({ file, proxy: "p1", account: "example.alice", mode: "0600", sensitive: true });
    expect(JSON.stringify(r)).not.toContain(PASS);
    expect(readFileSync(file, "utf8")).toBe(`TABCAP_PROXY_URL='http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:8080'\n`);
    expectMode(file, 0o600);
    const st = Store.open(p.config);
    st.bindAccount("example", "alice", "system");
    st.close();
    expect(accountProxy(p.config, "example", "alice")).toBeNull();
  });

  test("replay check --live sends through the account's proxy; errors show the placeholder", async () => {
    const { home, p, s } = poolHome();
    s.close();
    const bundle = await buildReplayBundle(join(home, "b"));
    const seen: Array<string | undefined> = [];
    const fake: HttpClient = async (_u, init) => {
      seen.push(init.proxy);
      throw new Error(`proxy said no: ${init.proxy ?? ""}`);
    };
    const r = await check({ bundle, against: "http://example.invalid", live: true, site: "example", filter: "/api/feed", rate: 1000, withCookies: false, headers: [], configDir: p.config, fetch: fake, sleep: async () => undefined });
    expect(r.proxy).toBe("p1");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x === `http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:8080`)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(encodeURIComponent(PASS));
    expect(r.rows[0]?.error).toContain("<secret:proxy.p1>");
    expect(existsSync(bundle)).toBe(true);
  });
});

describe("tabcap account add / remove and proxy set-state (CLI side)", () => {
  const BOBPW = "Bob-pass-Zq81x";
  const SEED = "JBSWY3DPEHPK3PXP";
  const none = () => Promise.resolve<string[]>([]);

  test("account add: password from stdin, never in output; duplicate and unknown site refused; --totp-stdin reads two lines", async () => {
    const { p, s } = poolHome();
    s.close();
    const out = await accountAdd(p, { site: "example", user: "bob", passwordStdin: true }, () => Promise.resolve(BOBPW + "\n"));
    expect(out).toMatchObject({ account: "example.bob", site: "example", user: "bob", state: "active", proxy: null });
    expect(JSON.stringify(out)).not.toContain(BOBPW);
    const st = Store.open(p.config);
    expect(st.account("example", "bob")).toMatchObject({ username: "bob", state: "active", proxy: null });
    expect(st.knownSecrets().some((k) => k.value === BOBPW)).toBe(true); // stored, so scrubbed from daemon output
    st.close();
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", user: "bob", passwordStdin: true }, () => Promise.resolve("other-pass-1\n")))).toBe("conflict");
    expect(await codeOfAsync(() => accountAdd(p, { site: "nosuch", user: "bob", passwordStdin: true }, () => Promise.resolve("x-pass-123\n")))).toBe("not-found");
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", passwordStdin: true }, () => Promise.resolve("x-pass-123\n")))).toBe("usage");
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", user: "carol", passwordStdin: true }, () => Promise.resolve("\n")))).toBe("usage");
    // no terminal in the test: without --password-stdin there is no prompt, and nothing is stored
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", user: "carol" }))).toBe("usage");
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", user: "carol", totpStdin: true }, () => Promise.resolve("a\nb\n")))).toBe("usage");
    const t = await accountAdd(p, { site: "example", user: "dave", passwordStdin: true, totpStdin: true }, () => Promise.resolve(`Dave-pass-9x1\n${SEED}\n`));
    expect(JSON.stringify(t)).not.toContain(SEED);
    expect(JSON.stringify(t)).not.toContain("Dave-pass-9x1");
    expect(await codeOfAsync(() => accountAdd(p, { site: "example", user: "erin", passwordStdin: true, totpStdin: true }, () => Promise.resolve("Erin-pass-9x1\n")))).toBe("usage");
    const st2 = Store.open(p.config);
    expect(st2.accounts("example").map((a) => a.username)).toEqual(["alice", "bob", "dave"]);
    expect(st2.knownSecrets().some((k) => k.value === SEED)).toBe(true); // scrubbed from daemon output like any secret
    st2.close();
    const listed = JSON.stringify(accountList(p, { site: "example" }));
    for (const secret of [BOBPW, SEED, "Dave-pass-9x1"]) expect(listed).not.toContain(secret);
  });

  test("account remove: gone with its cookies; unknown → not-found; in use by a session → conflict and nothing changes", async () => {
    const { p, s } = poolHome();
    s.addAccount({ site: "example", username: "bob", password: BOBPW });
    s.saveSession("example", "bob", [], 5);
    s.close();
    expect(await codeOfAsync(() => accountRemove(p, { account: "example.bob" }, () => Promise.resolve(["main"])))).toBe("conflict");
    expect(await codeOfAsync(() => accountRemove(p, { account: "example.zed" }, none))).toBe("not-found");
    expect(await codeOfAsync(() => accountRemove(p, { account: "nodot" }, none))).toBe("usage");
    const st0 = Store.open(p.config);
    expect(st0.account("example", "bob")).not.toBeNull();
    st0.close();
    expect(await accountRemove(p, { account: "example.bob" }, none)).toEqual({ account: "example.bob", removed: true });
    const st = Store.open(p.config);
    expect(st.accounts("example").map((a) => a.username)).toEqual(["alice"]);
    expect(st.site("example")).not.toBeNull();
    expect(st.account("example", "bob")).toBeNull();
    st.close();
    // the inverse really is an inverse: the same user can be added again
    await accountAdd(p, { site: "example", user: "bob", passwordStdin: true }, () => Promise.resolve(BOBPW));
  });

  test("account remove with no daemon running: the live lookup finds no session, so it removes", async () => {
    const { p, s } = poolHome();
    s.addAccount({ site: "example", username: "bob", password: BOBPW });
    s.close();
    expect(await accountRemove(p, { account: "example.bob" })).toEqual({ account: "example.bob", removed: true });
  });

  test("proxy set-state: {proxy, from, state}; disabled is skipped by auto, active makes it eligible again as unknown", () => {
    const { p, s } = poolHome(); // alice is bound to p1
    s.addAccount({ site: "example", username: "bob", password: BOBPW });
    s.updateProxy("p1", { state: "up", failCount: 1, lastOkAt: 7 });
    const H = 3_600_000;
    const pool = new Pool(() => 10 * H);
    expect(pool.pick(s, "example", "auto")?.username).toBe("alice");
    s.close();
    expect(proxySetState(p, { name: "p1", state: "disabled" })).toEqual({ proxy: "p1", from: "up", state: "disabled" });
    const s2 = Store.open(p.config);
    expect(pool.pick(s2, "example", "auto")?.username).toBe("bob"); // alice's proxy is disabled
    expect(codeOf(() => pool.pick(s2, "example", "alice"))).toBe("conflict");
    s2.patchAccount("example", "bob", { state: "disabled" });
    expect(codeOf(() => pool.pick(s2, "example", "auto"))).toBe("conflict"); // nothing left
    s2.close();
    expect(proxySetState(p, { name: "p1", state: "active" })).toEqual({ proxy: "p1", from: "disabled", state: "unknown" });
    const s3 = Store.open(p.config);
    expect(s3.proxy("p1")).toMatchObject({ state: "unknown", failCount: 0, recheckAt: null });
    expect(pool.pick(s3, "example", "auto")?.username).toBe("alice");
    s3.close();
    expect(codeOf(() => proxySetState(p, { name: "p1", state: "down" }))).toBe("usage");
    expect(codeOf(() => proxySetState(p, { name: "nope", state: "active" }))).toBe("not-found");
    expect(JSON.stringify(proxySetState(p, { name: "p1", state: "disabled" }))).not.toContain(PASS);
  });

  test("a hand-disabled proxy keeps `disabled` through a check and is never due for one", async () => {
    const { p, s } = poolHome();
    s.close();
    proxySetState(p, { name: "p1", state: "disabled" });
    const fake: HttpClient = async () => new Response("", { status: 200 });
    expect(await proxyCheck(p, { name: "p1", url: "http://127.0.0.1:4310/" }, { fetch: fake, now: () => 1 })).toMatchObject({ state: "disabled" });
    const st = Store.open(p.config);
    const row = st.proxy("p1");
    st.close();
    expect(row !== null && proxyDue(row, 9e9, 1000)).toBe(false);
  });
});
