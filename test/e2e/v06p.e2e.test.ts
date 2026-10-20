// L2 for 0.6-P `tabcap fetch --credentials` and `session export --origin` (Chrome for Testing, the real
// daemon, the s60 range in site.ts; docs/05 s60). Expected values come from the range, never from tabcap:
//   - bodies and statuses: the literals the range answers (S60_*), `served`;
//   - which requests carried the cookie: the range's access log (every request's headers);
//   - the CORS reasons: Chrome's own console messages (ACAO * / ACAC "true, true" with credentials include);
//   - the exported Authorization: the literal the page sends (S60_TOKEN) to origin B.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S60_COOKIE, S60_ME, S60_NEED_COOKIE, S60_PRIVATE, S60_TOKEN, S60_WILD, startCredSite, type CredSite } from "./site.ts";
import { daemonRequest, removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "cr"];

let home = "";
let site: CredSite;
let bundle = "";

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** POST /fetch on the daemon's socket, or its port + token on Windows (what _tabcap_fetch.py does with httpx). */
function endpoint(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return daemonRequest(home, "/fetch", body);
}

function events(): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
}

/** The range's log entry for a request to B at `path` with this cookie state, newest last. */
const bHits = (path: string) => site.log.filter((h) => h.origin === "b" && h.path === path && h.method === "GET");
const hasCookie = (h: { headers: Record<string, string> }) => (h.headers["cookie"] ?? "").includes(`s60b=${S60_COOKIE}`);

/** fetchId → mode a test used, checked against the bundle at the end. */
const modes = new Map<string, string>();

describe.skipIf(!enabled)("tabcap 0.6-P L2 (fetch --credentials, fetch.blocked hint, session export --origin; s60)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6p-"));
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    // pacing is 0.6-A's subject; here many fetches go to one host
    writeFileSync(join(home, "config", "config.json"), JSON.stringify({ fetch: { minIntervalMs: 0 } }) + "\n");
    site = startCredSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "cr");
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    // the page logs in on B (cookie s60b) and calls B's /s60/api/me with its Authorization header
    await ok("navigate", `${site.a}/s60`, ...S);
    await ok("wait", "--text", "s60-me-ok", ...S);
    await ok("net", "wait", "--url", "/s60/api/me", "--since", "start", ...S);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("ACAO * : include (default) is fetch.blocked with the wildcard reason and a --credentials omit hint; omit reads it without a cookie", async () => {
    const blocked = await tabcap(["fetch", `${site.b}/s60/api/wild`, ...S]);
    expect([blocked.ok, blocked.error?.["code"], blocked.error?.["credentials"]]).toEqual([false, "fetch.blocked", "include"]);
    expect(s(blocked.error?.["reason"])).toContain("must not be the wildcard '*' when the request's credentials mode is 'include'");
    const next = s(blocked.error?.["next"]);
    expect(next).toContain("--credentials omit");
    expect(next).toContain("no cookies are sent");
    expect(next).toContain("Origin / Referer");
    modes.set(s(blocked.error?.["fetchId"]), "include");

    const before = bHits("/s60/api/wild").length;
    const r = await ok("fetch", `${site.b}/s60/api/wild`, "--credentials", "omit", ...S);
    expect([r["status"], r["body"]]).toEqual([200, S60_WILD]);
    expect(r["body"]).toBe(site.served.get("b/s60/api/wild"));
    modes.set(s(r["fetchId"]), "omit");
    const hits = bHits("/s60/api/wild");
    // the blocked one reached the server with the cookie (CORS blocks the read, not the request); omit without it
    expect(hits.length).toBe(before + 1);
    expect(hits.map(hasCookie)).toEqual([true, false]);
  }, 60_000);

  test("ACAC 'true, true': include is fetch.blocked with the credentials reason and the same hint", async () => {
    const blocked = await tabcap(["fetch", `${site.b}/s60/api/double`, ...S]);
    expect([blocked.ok, blocked.error?.["code"]]).toEqual([false, "fetch.blocked"]);
    expect(s(blocked.error?.["reason"])).toContain("'Access-Control-Allow-Credentials' header in the response is 'true, true' which must be 'true'");
    expect(s(blocked.error?.["next"])).toContain("--credentials omit");
    modes.set(s(blocked.error?.["fetchId"]), "include");
  }, 60_000);

  test("a cookie-protected endpoint with an exact ACAO + ACAC: include 200 with the cookie, omit 401 without it", async () => {
    const inc = await ok("fetch", `${site.b}/s60/api/private`, ...S);
    expect([inc["status"], inc["body"]]).toEqual([200, S60_PRIVATE]);
    modes.set(s(inc["fetchId"]), "include");
    const omit = await ok("fetch", `${site.b}/s60/api/private`, "--credentials", "omit", ...S);
    expect([omit["status"], omit["body"]]).toEqual([401, S60_NEED_COOKIE]);
    modes.set(s(omit["fetchId"]), "omit");
    expect(bHits("/s60/api/private").map(hasCookie)).toEqual([true, false]);
  }, 60_000);

  test("--batch: per-line credentials, --credentials as the default of lines without their own", async () => {
    const file = join(home, "cred.jsonl");
    const lines = [{ url: `${site.b}/s60/api/wild` }, { url: `${site.b}/s60/api/private`, credentials: "include" }, { url: `${site.b}/s60/api/private` }];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const before = bHits("/s60/api/private").length;
    const b = await tabcap(["fetch", "--batch", file, "--credentials", "omit", ...S]);
    expect(b.exit).toBe(0);
    const envs = b.raw.trim().split("\n").map((l): unknown => JSON.parse(l)).map(rec);
    expect(envs.map((e) => e["ok"])).toEqual([true, true, true]);
    const data = envs.map((e) => rec(e["data"]));
    expect(data.map((d) => [d["status"], d["body"]])).toEqual([
      [200, S60_WILD],
      [200, S60_PRIVATE],
      [401, S60_NEED_COOKIE],
    ]);
    ["omit", "include", "omit"].forEach((m, i) => modes.set(s(data[i]?.["fetchId"]), m));
    expect(bHits("/s60/api/private").slice(before).map(hasCookie)).toEqual([true, false]);
  }, 60_000);

  test("POST /fetch takes credentials; a bad mode is usage", async () => {
    const e = await endpoint({ session: "cr", url: `${site.b}/s60/api/wild`, credentials: "omit" });
    expect(e["ok"]).toBe(true);
    const d = rec(e["data"]);
    expect([d["status"], d["body"]]).toEqual([200, S60_WILD]);
    modes.set(s(d["fetchId"]), "omit");
    const inc = await endpoint({ session: "cr", url: `${site.b}/s60/api/wild`, credentials: "include" });
    expect([inc["ok"], rec(inc["error"])["code"]]).toEqual([false, "fetch.blocked"]);
    expect(s(rec(inc["error"])["next"])).toContain('"credentials": "omit"');
    modes.set(s(rec(inc["error"])["fetchId"]), "include");
    const bad = await endpoint({ session: "cr", url: `${site.b}/s60/api/wild`, credentials: "none" });
    expect([bad["ok"], rec(bad["error"])["code"]]).toEqual([false, "usage"]);
  }, 60_000);

  test("session export --origin <B> (URL or bare host) while the tab is on A: the page's Authorization to B and B's cookie; values only in the file", async () => {
    const out = join(home, "out", "api.json");
    const e = await tabcap(["session", "export", "--for", "requests", "--out", out, "--origin", site.b, ...S]);
    if (!e.ok) throw new Error(e.raw);
    expect(e.raw.includes(S60_TOKEN)).toBe(false);
    expect(e.raw.includes(S60_COOKIE)).toBe(false);
    expect(e.data).toMatchObject({ origin: site.b, headers: ["authorization"], source: { headers: { origin: site.b, auto: false }, storage: site.a } });
    const src = s(rec(rec(e.data["source"])["headers"])["request"]);
    // the oracle: the request the page itself sent to B's /s60/api/me
    const me = events().filter((x) => x["kind"] === "request" && x["url"] === `${site.b}/s60/api/me` && x["method"] === "GET");
    expect(me.map((x) => x["id"])).toEqual([src]);
    expect(site.served.get("b/s60/api/me")).toBe(S60_ME);
    const doc = rec(JSON.parse(readFileSync(out, "utf8")));
    expect(doc["origin"]).toBe(site.b);
    expect(doc["headers"]).toEqual({ authorization: `Bearer ${S60_TOKEN}` });
    expect(recs(doc["cookies"]).map((c) => [c["name"], c["value"]])).toContainEqual(["s60b", S60_COOKIE]);

    const host = new URL(site.b).host;
    const bare = await ok("session", "export", "--for", "requests", "--out", join(home, "out", "api2.json"), "--origin", host, ...S);
    expect(bare).toMatchObject({ origin: site.b, headers: ["authorization"], source: { headers: { request: src } } });
  }, 60_000);

  test("session export without --origin: no auth header to A, so the fallback takes B (source.headers.auto) and says so", async () => {
    const out = join(home, "out", "auto.json");
    const e = await tabcap(["session", "export", "--for", "requests", "--out", out, ...S]);
    if (!e.ok) throw new Error(e.raw);
    expect(e.raw.includes(S60_TOKEN)).toBe(false);
    expect(e.data).toMatchObject({ origin: site.a, headers: ["authorization"], source: { headers: { origin: site.b, auto: true } } });
    expect(s(e.data["note"])).toContain("source.headers.auto");
    const doc = rec(JSON.parse(readFileSync(out, "utf8")));
    expect(doc["origin"]).toBe(site.a);
    expect(doc["headers"]).toEqual({ authorization: `Bearer ${S60_TOKEN}` });
    expect(doc["headersFrom"]).toMatchObject({ origin: site.b, auto: true });
  }, 60_000);

  test("after net stop, the bundle says which mode each fetch used: fetchCredentials on every request event, credentials in the cmd start input", async () => {
    await ok("net", "stop", ...S);
    const evs = events();
    const reqs = evs.filter((e) => e["kind"] === "request" && typeof e["fetchId"] === "string");
    for (const [fetchId, mode] of modes) {
      const mine = reqs.filter((e) => e["fetchId"] === fetchId);
      expect(mine.length).toBeGreaterThan(0);
      for (const e of mine) expect([fetchId, e["fetchCredentials"]]).toEqual([fetchId, mode]);
    }
    // page requests carry no fetch fields
    for (const e of evs.filter((x) => x["kind"] === "request" && x["fetchId"] === undefined)) expect(e["fetchCredentials"]).toBeUndefined();
    const starts = evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "start" && rec(e["input"])["action"] === "fetch").map((e) => rec(e["input"]));
    const single = starts.filter((i) => i["batch"] === undefined).map((i) => i["credentials"]);
    // in command order: wild (default), wild omit, double, private, private omit, then POST /fetch omit, include, "none" (refused)
    expect(single).toEqual(["include", "omit", "include", "include", "omit", "omit", "include", "none"]);
    expect(starts.find((i) => i["batch"] !== undefined)?.["batch"]).toEqual({ requests: 3, credentials: { omit: 2, include: 1 } });
  }, 60_000);
});
