// L2 for 0.6-H `bundle info --usage` (Chrome for Testing, the real daemon, the range in site.ts).
// Oracle: the two range sites' own access logs (`hits`, "METHOD /path" per request served),
// the s07 login journal (`loginBodies`) and the pacing contract of `tabcap fetch`
// (config fetch.minIntervalMs 3000, docs/04 §26). The report is read from the finished bundle;
// no number comes from tabcap's own counters.
// 0.6-S: rows are per host and actor and loopback hosts (the range) need --all-hosts;
// per-host totals are summed over a host's rows, intervals read from the page / fetch rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, startSearchSite, type GuardSite, type SearchSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "range-demo";

let home = "";
let guard: GuardSite;
let search: SearchSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: null, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

describe.skipIf(!enabled)("tabcap 0.6-H L2 (bundle info --usage over s07 + s06)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6h-"));
    guard = startGuardSite();
    search = startSearchSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    guard.stop();
    search.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("one run over s07 (login, data) and s06 (page + search, three fetches, the last one stopped): the usage numbers equal the range logs", async () => {
    const S = ["--session", "s07h"];
    const st = await ok("session", "start", "s07h", "--site", SITE);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("net", "wait", "--url", "/api/data", ...S);
    await ok("navigate", `${search.origin}/s06?q=usage&page=1`, ...S);
    await ok("wait", "--text", "hits usage-1-a", ...S);
    await ok("net", "wait", "--url", "/api/search", ...S);
    await ok("fetch", `${search.origin}/api/search?q=usage&page=2`, "--timeout", "60000", ...S);
    await ok("fetch", `${search.origin}/api/search?q=usage&page=3`, "--timeout", "60000", ...S);
    const stop = await tabcap(["fetch", `${search.origin}/api/search?q=usage&page=4`, "--stop-on", "status=200", "--timeout", "60000", ...S]);
    expect([stop.ok, stop.error?.["code"]]).toEqual([false, "fetch.stopped"]);
    await ok("net", "stop", ...S);

    // The range logs are the oracle (Chrome's favicon request is part of the traffic; the range answers it 404).
    const guardLog = guard.hits;
    const searchLog = search.hits;
    const count = (log: string[], pred: (h: string) => boolean): number => log.filter(pred).length;
    expect(guard.loginBodies.length).toBe(1);
    expect(count(searchLog, (h) => h.startsWith("GET /api/search"))).toBe(4); // the page's own + three fetches

    const loopOnly = await tabcap(["bundle", "info", bundle, "--usage"]);
    if (!loopOnly.ok) throw new Error(loopOnly.raw);
    expect(recs(loopOnly.data["hosts"])).toEqual([]); // both range origins are loopback
    expect(rec(rec(loopOnly.data["skipped"])["loopback"])["requests"]).toBe(guardLog.length + searchLog.length);

    const e = await tabcap(["bundle", "info", bundle, "--usage", "--all-hosts", "--business-code", "$.data=data-ok"]);
    if (!e.ok) throw new Error(e.raw);
    expect(e.data["schema"]).toBe("tabcap-usage/0");
    expect(rec(e.data["session"])).toMatchObject({ name: "s07h", site: SITE });
    const rows = recs(e.data["hosts"]);
    const sumOf = (host: string): Record<string, unknown> => {
      const mine = rows.filter((h) => h["host"] === host);
      const merged = (key: string): Record<string, number> => {
        const a: Record<string, number> = {};
        for (const h of mine) for (const [k, v] of Object.entries(rec(h[key]))) a[k] = (a[k] ?? 0) + Number(v);
        return a;
      };
      return {
        requests: mine.reduce((n, h) => n + Number(h["requests"]), 0),
        byMethod: merged("byMethod"),
        statuses: merged("statuses"),
        emptyBodies: mine.reduce((n, h) => n + Number(h["emptyBodies"]), 0),
        businessErrors: mine.reduce((n, h) => n + Number(h["businessErrors"]), 0),
        bytesIn: mine.reduce((n, h) => n + Number(h["bytesIn"]), 0),
      };
    };
    const gHost = new URL(guard.origin).host;
    const qHost = new URL(search.origin).host;
    expect([...new Set(rows.map((h) => h["host"]))].sort()).toEqual([gHost, qHost].sort());
    const g = sumOf(gHost);
    const q = sumOf(qHost);
    const qPage = rows.find((h) => h["host"] === qHost && h["actor"] === "page");
    const qFetch = rows.find((h) => h["host"] === qHost && h["actor"] === "fetch");
    if (qPage === undefined || qFetch === undefined) throw new Error(`rows: ${JSON.stringify(rows.map((h) => [h["host"], h["actor"]]))}`);
    expect(qFetch["requests"]).toBe(3); // the three tabcap fetch calls (fetchId)
    expect(qPage["requests"]).toBe(searchLog.length - 3);

    // requests and methods per host = the range's own access log
    expect(g["requests"]).toBe(guardLog.length);
    expect(g["byMethod"]).toEqual({ GET: count(guardLog, (h) => h.startsWith("GET ")), POST: count(guardLog, (h) => h.startsWith("POST ")) });
    expect(rec(g["byMethod"])["POST"]).toBe(2); // /api/login, /api/data
    expect(q["requests"]).toBe(searchLog.length);
    expect(q["byMethod"]).toEqual({ GET: searchLog.length }); // /s06 + favicon + 4 x /api/search
    expect(searchLog.length).toBe(6);
    const icons = (log: string[]): number => count(log, (h) => h.endsWith(" /favicon.ico"));
    expect(g["statuses"]).toEqual({ "200": guardLog.length - icons(guardLog), "404": icons(guardLog) });
    expect(q["statuses"]).toEqual({ "200": searchLog.length - icons(searchLog), "404": icons(searchLog) });
    expect(g["emptyBodies"]).toBe(0);
    expect(q["emptyBodies"]).toBe(0);
    // business rule $.data=data-ok: /api/data passes; the login answer ({csrf}) has no data; every search answer has none
    expect(g["businessErrors"]).toBe(1);
    expect(q["businessErrors"]).toBe(4);

    // intervals, from the pacing contract (fetch.minIntervalMs 3000 between fetches of one host): fetches 2 and 3 start at least
    // 3000 ms after the one before, so the fetch row's two gaps average at least 1200 ms (it is 3000 by the contract), and its
    // 1 s windows hold one fetch each; the page's own requests (document, its XHR, the favicon) are within 1 s of each other.
    expect(Number(qPage["minIntervalMs"])).toBeLessThan(1000);
    expect(Number(qPage["maxBurst1s"])).toBeGreaterThanOrEqual(2);
    expect(Number(qPage["maxBurst1s"])).toBeLessThanOrEqual(3);
    expect(Number(qFetch["meanIntervalMs"])).toBeGreaterThanOrEqual(1200);
    expect(Number(qFetch["maxBurst1s"])).toBe(1);
    expect(Number(g["bytesIn"])).toBeGreaterThan(0);

    // logins: one password fill, by the account bound to the site
    const logins = rec(e.data["logins"]);
    expect(logins["attempts"]).toBe(guard.loginBodies.length);
    expect(Object.values(rec(logins["byAccount"]))).toEqual([1]);
    expect(recs(logins["guardEvents"]).some((x) => x["event"] === "budget" && x["rule"] === "login-limit" && x["decision"] === "allowed")).toBe(true);

    // the stopped fetch: one stop, naming the rule and the recorded request of the fourth /api/search
    const stops = recs(e.data["stops"]);
    expect(stops.length).toBe(1);
    expect(stops[0]).toMatchObject({ kind: "fetch-stop", rule: "status=200" });
    const stopped = BundleReader.open(bundle).requests().find((r) => r.id === stops[0]?.["request"]);
    expect(stopped?.url).toBe(`${search.origin}/api/search?q=usage&page=4`);

    // windows: every request is in exactly one 10-minute window
    const windows = recs(e.data["windows"]);
    expect(windows.reduce((n, w) => n + Number(w["requests"]), 0)).toBe(guardLog.length + searchLog.length);
    for (const w of windows) expect(Number(w["to"]) - Number(w["from"])).toBe(600_000);

    // counts and names only: no secret, sid, csrf or body value in the report
    for (const v of [LOGIN_PASSWORD, ...guard.sids, ...guard.csrfs, "usage-1-a"]) expect(e.raw.includes(v)).toBe(false);

    // --text is one screen
    const t = Bun.spawn(["bun", MAIN, "bundle", "info", bundle, "--usage", "--all-hosts", "--text"], { env: { ...process.env, TABCAP_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(t.stdout).text();
    await t.exited;
    expect(text).toContain(new URL(search.origin).host);
    expect(text.split("\n").length).toBeLessThan(30);
  }, 180_000);

  test("daemon stop leaves no browser process of this TABCAP_HOME", async () => {
    await ok("daemon", "stop");
    let left = "";
    for (let i = 0; i < 50; i++) {
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="])
        .stdout.toString()
        .split("\n")
        .filter((l) => l.includes("Chrome for Testing") && l.includes(home))
        .join("\n")
        .trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
