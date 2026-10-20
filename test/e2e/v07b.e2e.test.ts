// L2 for 0.7-B `tabcap status` (owner decision 2026-10-17): the one answer
// over sessions, recordings, waiting states, trace mode, fetch stops and
// plugins, and its rule-generated `conflicts`, on the existing ranges of
// test/e2e/site.ts: the 0.3-A guard site (s07 login entry as the store site,
// s15 verify wall: the 6th /api/limited call answers an HTML 403) and the
// 0.6-B range decode plugin (test/e2e/plugins/xor-decode, enabled only).
// Oracle: the range (its request journal, the wall after LIMIT_OK calls), the
// guard's own answers (`handoff status` still waiting after `guard resume`,
// which is the claim conflict (a) makes) and `trace start --decode`'s
// `decodePlugins`; never status itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { LIMIT_OK, LOGIN_PASSWORD, LOGIN_USER, startGuardSite, type GuardSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PLUGIN = join(import.meta.dir, "plugins", "xor-decode");
const SITE = "range-demo";

let home = "";
let site: GuardSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };

const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

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

const sessionOf = (st: Record<string, unknown>, name: string): Record<string, unknown> => rec(recs(st["sessions"]).find((x) => x["session"] === name));
const codes = (st: Record<string, unknown>, name: string): string[] => recs(st["conflicts"]).filter((c) => c["session"] === name).map((c) => s(c["code"]));
const conflict = (st: Record<string, unknown>, name: string, code: string) => rec(recs(st["conflicts"]).find((c) => c["session"] === name && c["code"] === code));

async function statusText(label: string): Promise<string> {
  const t = await tabcap(["status", "--text"]);
  expect(t.exit).toBe(0);
  console.log(`[v07b] status --text (${label}):\n${t.raw.trimEnd()}`);
  return t.raw;
}

describe.skipIf(!enabled)("tabcap 0.7-B L2 (status and conflicts)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e7b-"));
    site = startGuardSite();
    mkdirSync(join(home, "config", "plugins"), { recursive: true, mode: 0o700 });
    cpSync(PLUGIN, join(home, "config", "plugins", "xor-decode"), { recursive: true });
    await ok("plugin", "enable", "xor-decode");
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("a bound recording session and an unbound one: (c) for the unbound one only", async () => {
    const started = await ok("session", "start", "w", "--site", SITE);
    expect(started).toMatchObject({ site: SITE, account: LOGIN_USER });
    const bundle = s((await ok("net", "start", "--session", "w"))["bundle"]);
    await ok("navigate", `${site.origin}/s15/`, "--session", "w");
    await ok("navigate", `${site.origin}/s15/?bucket=u`, "--session", "u");
    // a plain browsing session on no store site: unbound, but (c) stays quiet (owner 10-17)
    await ok("navigate", "data:text/html,<p>plain</p>", "--session", "plain");
    const st = await ok("status");
    expect(st["schema"]).toBe("tabcap-status/0");
    expect(rec(st["daemon"])).toMatchObject({ running: true });
    expect(rec(st["browser"])).toMatchObject({ running: true, mode: "direct" });
    expect(rec(st["plugins"])).toEqual({ decode: ["xor-decode"], challenge: [] });
    const w = sessionOf(st, "w");
    expect(w).toMatchObject({ site: SITE, account: LOGIN_USER, tabs: 1, state: "running", trace: { state: "off", decode: false, weakRows: null }, guardStops: [] });
    expect(rec(w["recording"])).toMatchObject({ bundle, decodePlugins: ["xor-decode"] });
    const u = sessionOf(st, "u");
    expect(u).toMatchObject({ site: null, account: null, tabSite: SITE, tabs: 1, recording: null, state: "running" });
    expect(codes(st, "w")).toEqual([]);
    expect(codes(st, "u")).toEqual(["unbound-session"]);
    expect(sessionOf(st, "plain")).toMatchObject({ site: null, tabSite: null, tabs: 1 });
    expect(codes(st, "plain")).toEqual([]);
    expect(s(conflict(st, "u", "unbound-session")["next"])).toContain(`tabcap session start u --site ${SITE}`);
    // the claim of (c), checked against tabcap itself: fill --secret in u is refused
    const refused = await tabcap(["fill", "e1", "--secret", `${SITE}.password`, "--session", "u"]);
    expect(refused.ok).toBe(false);
    expect(s(refused.error?.["message"])).toContain("is not bound to a site");
    await ok("session", "stop", "plain");
    await statusText("bound w recording, unbound u");
  }, 60_000);

  test("waiting + a fetch stop on the same site: (a); guard resume lifts the stop but the session still waits", async () => {
    const W = ["--session", "w"];
    for (let i = 1; i <= LIMIT_OK; i++) await ok("fetch", "/api/limited", "--stop-on", "status>=400", ...W);
    const sixth = await tabcap(["fetch", "/api/limited", "--stop-on", "status>=400", ...W]);
    expect(sixth.ok).toBe(false);
    expect(site.hits.filter((h) => h === "GET /api/limited").length).toBe(LIMIT_OK + 1);
    // 0.7-E: no polling: status waits for the screenshot still being taken (it said null for ~0.5 s before)
    const st = await ok("status");
    const w = sessionOf(st, "w");
    // read before toMatchObject: bun's asymmetric matchers can leave themselves in the received object
    const wShot = s(w["screenshot"]);
    expect(wShot).toMatch(/[/\\]shots[/\\]w-t\d+-.*\.png$/);
    expect(existsSync(wShot)).toBe(true);
    expect(w).toMatchObject({ state: "waiting", reason: "verify-page", url: `${site.origin}/s15/` });
    expect(s(st["next"])).toContain("after they finished in the browser: `tabcap handoff continue --session w`");
    expect(recs(w["guardStops"])).toEqual([expect.objectContaining({ site: SITE, rule: "status>=400", reason: "fetch-stop", by: "w" })]);
    expect(recs(st["handoff"])).toEqual([expect.objectContaining({ session: "w", reason: "verify-page", url: `${site.origin}/api/limited`, screenshot: wShot })]);
    expect(codes(st, "w")).toEqual(["waiting-and-fetch-stop"]);
    expect(s(conflict(st, "w", "waiting-and-fetch-stop")["next"])).toContain("tabcap handoff continue --session w");
    const text = await statusText("w waiting, fetches on range-demo stopped");
    expect(text).toContain("w: site range-demo (demo-user)");
    expect(text).toContain(`WAITING verify-page at ${site.origin}/s15/ (screenshot `);
    expect(text).toContain("[waiting-and-fetch-stop]");
    expect(text).toContain("\nnext: session \"w\" waits for the human (verify-page)");
    // the guard itself: guard resume lifts the fetch stop, the wait stays
    expect(await ok("guard", "resume", "--site", SITE, ...W)).toMatchObject({ site: SITE, resumed: true });
    expect((await ok("handoff", "status", ...W))["state"]).toBe("waiting");
    const after = await ok("status");
    expect(sessionOf(after, "w")).toMatchObject({ state: "waiting", guardStops: [] });
    expect(codes(after, "w")).toEqual([]);
    expect(await ok("handoff", "continue", ...W)).toMatchObject({ state: "resumed" });
    const done = await ok("status");
    expect(sessionOf(done, "w")).toMatchObject({ state: "running", reason: null, screenshot: null });
    // nothing waits any more: next is the first conflict's (u is unbound on the store site), no handoff continue
    expect(s(done["next"])).not.toContain("handoff continue");
  }, 90_000);

  test("0.7-E: a navigate that lands on a 403 verify page answers `waiting` with the screenshot path; handoff status has it too", async () => {
    const N = ["--session", "n"];
    await ok("net", "start", ...N);
    const wall = `${site.origin}/api/limited?bucket=nav`;
    for (let i = 1; i <= LIMIT_OK; i++) await ok("navigate", wall, ...N);
    const hit = await tabcap(["navigate", wall, ...N]);
    expect([hit.ok, hit.error?.["code"]]).toEqual([false, "waiting"]);
    const shot = s(hit.error?.["screenshot"]);
    expect(shot).toMatch(/[/\\]shots[/\\]n-t\d+-.*\.png$/);
    expect(existsSync(shot)).toBe(true);
    expect(rec((await ok("handoff", "status", ...N))["handoff"])).toMatchObject({ state: "waiting", reason: "verify-page", screenshot: shot });
    const st = await ok("status");
    expect(sessionOf(st, "n")).toMatchObject({ state: "waiting", url: wall, screenshot: shot });
    expect(s(st["next"])).toContain("`tabcap handoff continue --session n`");
    await statusText("n waiting after a navigate onto the verify page");
    // the wait outlives the recording, the screenshot with it
    await ok("net", "stop", ...N);
    expect(sessionOf(await ok("status"), "n")).toMatchObject({ state: "waiting", recording: null, screenshot: shot });
    expect(await ok("handoff", "continue", ...N)).toMatchObject({ state: "resumed" });
  }, 90_000);

  test("trace start --decode with a decode plugin enabled: (b) and, without a recording, (e)", async () => {
    const U = ["--session", "u"];
    const tr = await ok("trace", "start", "--decode", ...U);
    expect(tr["decodePlugins"]).toEqual(["xor-decode"]);
    const st = await ok("status");
    expect(sessionOf(st, "u")["trace"]).toEqual({ state: "on", decode: true, weakRows: 0 });
    expect(codes(st, "u")).toEqual(["decode-plugin-outranks-page", "unbound-session", "trace-without-recording"]);
    expect(s(conflict(st, "u", "decode-plugin-outranks-page")["next"])).toBe("to observe the page: `tabcap plugin disable xor-decode`");
    await statusText("u observing with xor-decode enabled, not recording");
    // recording: (e) goes, (b) stays; 0.7-E: the recording follows plugin disable from its next body, no restart
    await ok("net", "start", ...U);
    const rec2 = await ok("status");
    expect(codes(rec2, "u")).toEqual(["decode-plugin-outranks-page", "unbound-session"]);
    expect(s(conflict(rec2, "u", "decode-plugin-outranks-page")["next"])).toBe("to observe the page: `tabcap plugin disable xor-decode` (applies from the next body; bodies already decoded keep their plugin view)");
    await ok("trace", "stop", ...U);
    await ok("net", "stop", ...U);
    expect(codes(await ok("status"), "u")).toEqual(["unbound-session"]);
  }, 60_000);
});
