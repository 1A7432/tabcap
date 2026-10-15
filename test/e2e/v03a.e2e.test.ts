// L2 for 0.3-A: store, fill --secret, login limit, waiting state, challenge
// handler interface. Pages in test/e2e/site.ts mirror docs/05 s07 (login →
// cookie → data API) and s15 (403 interstitial after 5 calls, a button
// unlocks). Expected values come from the local site (its request journal and
// the login bodies it received) and from docs/05 / docs/06, never from tabcap.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, WALL_CODE, WALL_MARKER, startGuardSite, type GuardSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const FAKE = join(import.meta.dir, "..", "fixtures", "plugins", "fake-verify");
const SITE = "range-demo";
const REF = `<secret:${SITE}.password>`;

let home = "";
let site: GuardSite;
/** Every byte any tabcap command printed (stdout and stderr), for the leak check. */
const printed: string[] = [];

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
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  printed.push(out, err);
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
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${JSON.stringify(e.error)}`);
  return e.data;
}

async function until<T>(what: string, f: () => Promise<T>, good: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!good(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await Bun.sleep(150);
    v = await f();
  }
  return v;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every spelling of the password a file could hold. */
const SPELLINGS = [...new Set([LOGIN_PASSWORD, JSON.stringify(LOGIN_PASSWORD).slice(1, -1), encodeURIComponent(LOGIN_PASSWORD), new URLSearchParams({ p: LOGIN_PASSWORD }).toString().slice(2)])];
const holds = (text: string) => SPELLINGS.some((v) => text.includes(v));

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l): unknown => JSON.parse(l))
    .filter(isRecord);
}

/** A ref from the snapshot text: `- textbox "密码" [e7]`. */
function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

const count = (path: string) => site.hits.filter((h) => h.endsWith(` ${path}`)).length;

describe.skipIf(!enabled)("tabcap 0.3-A L2 (store, secret fill, guard, handoff, handlers)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3a-"));
    site = startGuardSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("store file 0600 in 0700; site list shows names, urls, usernames and refs, never the password", async () => {
    expect(statSync(join(home, "config", "state.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "config")).mode & 0o777).toBe(0o700);
    const l = await ok("site", "list");
    expect(recs(l["sites"])).toEqual([expect.objectContaining({ name: SITE, entryUrl: `${site.origin}/s07/login`, usernames: [LOGIN_USER], secrets: [`${SITE}.username`, `${SITE}.password`] })]);
  });

  let loginBundle = "";
  test("s07: session start --site + fill --secret logs in; evaluate / snapshot show only the reference; second attempt → guard.login-limit", async () => {
    const S = ["--session", "s07"];
    const st = await ok("session", "start", "s07", "--site", SITE);
    expect(st).toMatchObject({ site: SITE, account: LOGIN_USER, entryUrl: `${site.origin}/s07/login` });
    loginBundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const user = refOf(tree, "textbox", "用户名");
    const pw = refOf(tree, "textbox", "密码");
    const go = refOf(tree, "button", "登录");
    expect(await ok("fill", user, "--secret", `${SITE}.username`, ...S)).toMatchObject({ secret: `${SITE}.username` });
    const f = await ok("fill", pw, "--secret", `${SITE}.password`, ...S);
    expect(f).toMatchObject({ secret: `${SITE}.password`, value: REF, masked: true });
    // docs/06 A2.9: reading the field back gives the placeholder
    expect((await ok("evaluate", "document.getElementById('pw').value", ...S))["value"]).toBe(REF);
    const snap = await ok("snapshot", ...S);
    expect(holds(JSON.stringify(snap))).toBe(false);
    await ok("click", go, ...S);
    await ok("wait", "--text", "data-ok", ...S);
    expect(site.loginBodies.length).toBe(1);
    expect(new URLSearchParams(site.loginBodies[0] ?? "").get("password")).toBe(LOGIN_PASSWORD); // the page really got the password
    // docs/06 A6.2: a second login attempt in the same session is refused, and nothing reaches the site
    const before = site.hits.length;
    const again = await tabcap(["fill", pw, "--secret", `${SITE}.password`, ...S]);
    expect(again.ok).toBe(false);
    expect(again.error?.["code"]).toBe("guard.login-limit");
    expect(s(again.error?.["next"])).toContain("--confirm");
    await Bun.sleep(500);
    expect(site.hits.length).toBe(before);
    expect(await ok("fill", pw, "--secret", `${SITE}.password`, "--confirm", ...S)).toMatchObject({ value: REF });
    expect(site.hits.length).toBe(before);
    await ok("net", "stop", ...S);

    const m: unknown = JSON.parse(readFileSync(join(loginBundle, "manifest.json"), "utf8"));
    expect(rec(rec(m)["session"])).toMatchObject({ name: "s07", site: SITE, account: LOGIN_USER });
    const evs = events(loginBundle);
    const reqs = evs.filter((e) => e["kind"] === "request");
    const login = reqs.find((e) => s(e["url"]).endsWith("/api/login"));
    const data = reqs.find((e) => s(e["url"]).endsWith("/api/data"));
    expect(Object.keys(rec(rec(login?.["response"])["headers"]))).toContain("set-cookie");
    expect(s(rec(rec(data?.["request"])["headers"])["cookie"])).toContain("sid=");
    const budget = evs.filter((e) => e["kind"] === "guard").map((e) => [e["event"], rec(e["detail"])["decision"], rec(e["detail"])["attempts"]]);
    expect(budget).toEqual([
      ["budget", "allowed", 1],
      ["budget", "refused", 1],
      ["budget", "confirmed", 2],
    ]);
    const fills = evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "start" && rec(e["input"])["action"] === "fill");
    expect(fills.map((e) => rec(e["input"])["secret"])).toEqual([`${SITE}.username`, `${SITE}.password`, `${SITE}.password`, `${SITE}.password`]);
  }, 90_000);

  test("the password appears only in the login POST body of the bundle; nowhere in the daemon log or any CLI output; redacted HAR and copy drop it", async () => {
    // bundle: only the login request event, and the raw CDP lines of that same POST
    const offenders: string[] = [];
    for (const f of walk(loginBundle)) {
      const text = readFileSync(f).toString("latin1") + readFileSync(f, "utf8");
      if (!holds(text)) continue;
      if (f.endsWith("events.jsonl")) {
        for (const line of readFileSync(f, "utf8").split("\n").filter(holds)) {
          const e: unknown = JSON.parse(line);
          if (!(isRecord(e) && e["kind"] === "request" && s(e["url"]).endsWith("/api/login"))) offenders.push(`events.jsonl: ${line.slice(0, 200)}`);
        }
      } else if (f.endsWith(join("raw", "cdp.jsonl"))) {
        for (const line of readFileSync(f, "utf8").split("\n").filter(holds)) if (!line.includes("/api/login")) offenders.push(`raw: ${line.slice(0, 200)}`);
      } else offenders.push(f);
    }
    expect(offenders).toEqual([]);
    expect(holds(readFileSync(join(loginBundle, "events.jsonl"), "utf8"))).toBe(true); // the fact is kept
    // daemon log and every CLI output so far
    expect(holds(readFileSync(join(home, "config", "daemon.log"), "utf8"))).toBe(false);
    expect(printed.filter(holds)).toEqual([]);
    // redacted exports
    const har = await ok("bundle", "export", "har", loginBundle);
    expect(holds(readFileSync(s(har["out"]), "utf8"))).toBe(false);
    const copy = join(home, "redacted-copy");
    await ok("bundle", "redact", loginBundle, copy);
    for (const f of walk(copy)) expect([f, holds(readFileSync(f, "utf8"))]).toEqual([f, false]);
  }, 60_000);

  let wallBundle = "";
  test("s15: the 6th call gets the 403 wall → waiting with reason and screenshot; nothing reaches the site until handoff continue", async () => {
    const S = ["--session", "s15"];
    wallBundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${site.origin}/s15/`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const load = refOf(tree, "button", "加载");
    for (let i = 1; i <= 5; i++) {
      await ok("click", load, ...S);
      await ok("wait", "--text", `loaded ${i}`, ...S);
    }
    const sixth = await tabcap(["click", load, ...S]); // ok, or already `waiting` if the 403 beat it
    if (!sixth.ok) expect(sixth.error?.["code"]).toBe("waiting");
    const st = await until("the waiting state", () => ok("handoff", "status", ...S), (d) => d["state"] === "waiting" && rec(d["handoff"])["screenshot"] !== null);
    const h = rec(st["handoff"]);
    expect(h).toMatchObject({ state: "waiting", reason: "verify-page", status: 403 });
    expect(existsSync(s(h["screenshot"]))).toBe(true);
    expect(count("/api/limited")).toBe(6);
    // docs/06 A6.1 / A6.3: page commands are refused with state, reason, screenshot and next
    const journal = site.hits.length;
    const refused = await tabcap(["click", load, ...S]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({ code: "waiting", state: "waiting", reason: "verify-page", screenshot: h["screenshot"] });
    expect(s(refused.error?.["next"])).toContain("在浏览器里完成验证");
    expect(s(refused.error?.["next"])).toContain("tabcap handoff continue");
    expect((await tabcap(["evaluate", "fetch('/api/limited').then((r) => r.status)", "--await", ...S])).error?.["code"]).toBe("waiting");
    expect((await tabcap(["navigate", `${site.origin}/s15/?bucket=x`, "--session", "other"])).error?.["code"]).toBe("waiting");
    // read-only commands still answer, and say so
    expect(rec((await ok("snapshot", ...S))["handoff"])).toMatchObject({ state: "waiting", reason: "verify-page" });
    await Bun.sleep(10_000);
    expect(site.hits.length).toBe(journal);
    // the human verifies, then says continue
    const cont = await ok("handoff", "continue", ...S);
    expect(cont).toMatchObject({ state: "resumed", reason: "verify-page" });
    // L2 stand-in for the human's click (A6.4 with a real human is L3)
    await ok("click", refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", "我是人"), ...S);
    await ok("wait", "--text", "verified", ...S);
    await ok("click", load, ...S);
    await ok("wait", "--text", "loaded 1", ...S);
    await ok("net", "stop", ...S);
    const evs = events(wallBundle);
    const urls = evs.filter((e) => e["kind"] === "request").map((e) => new URL(s(e["url"])).pathname);
    expect(urls.filter((u) => u === "/api/limited").length).toBe(7);
    expect(urls.lastIndexOf("/api/verified")).toBeGreaterThan(urls.indexOf("/api/limited"));
    expect(urls.lastIndexOf("/api/limited")).toBeGreaterThan(urls.lastIndexOf("/api/verified"));
    const g = evs.filter((e) => e["kind"] === "guard" || e["kind"] === "handoff").map((e) => [e["kind"], e["event"] ?? e["state"]]);
    expect(g).toEqual([
      ["guard", "breaker"],
      ["handoff", "waiting"],
      ["handoff", "resumed"],
    ]);
    expect(evs.find((e) => e["kind"] === "handoff" && e["state"] === "waiting")).toMatchObject({ reason: "verify-page", timeoutMs: null, answerRef: null });
  }, 120_000);

  test("challenge handler: the test-only fake answers on the test page; its invocation is a scrubbed cmd pair in the bundle", async () => {
    const S = ["--session", "hook"];
    mkdirSync(join(home, "config", "plugins"), { recursive: true, mode: 0o700 });
    cpSync(FAKE, join(home, "config", "plugins", "fake-verify"), { recursive: true });
    const listed = await ok("plugin", "list");
    expect(recs(listed["plugins"])).toEqual([expect.objectContaining({ name: "fake-verify", enabled: false, hooks: ["challenge"], error: null })]);
    await ok("plugin", "enable", "fake-verify");
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${site.origin}/s15/?bucket=hook`, ...S);
    const load = refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", "加载");
    for (let i = 1; i <= 5; i++) {
      await ok("click", load, ...S);
      await ok("wait", "--text", `loaded ${i}`, ...S);
    }
    await tabcap(["click", load, ...S]);
    const st = await until("the handler's answer", () => ok("handoff", "status", ...S), (d) => d["state"] === "resumed");
    const h = rec(st["handoff"]);
    expect(h["resumedBy"]).toBe("plugin:fake-verify");
    const answer = rec(recs(h["handlers"])[0]?.["answer"]);
    expect(answer).toEqual({ code: WALL_CODE });
    // the AI applies the answer like any data
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "验证码"), s(answer["code"]), ...S);
    await ok("click", refOf(tree, "button", "我是人"), ...S);
    await ok("wait", "--text", "verified", ...S);
    await ok("click", load, ...S);
    await ok("wait", "--text", "loaded 1", ...S);
    await ok("net", "stop", ...S);
    const evs = events(bundle);
    const start = evs.find((e) => e["kind"] === "cmd" && e["phase"] === "start" && s(e["argv"]).includes("plugin:fake-verify"));
    expect(start).toMatchObject({ actor: "system", input: { hook: "challenge", plugin: "fake-verify", payload: { protocol: "tabcap-hook/1", hook: "challenge", reason: "verify-page" } } });
    expect(s(rec(rec(start?.["input"])["payload"])["page"])).toContain(WALL_MARKER);
    const end = evs.find((e) => e["kind"] === "cmd" && e["phase"] === "end" && e["ref"] === start?.["id"]);
    expect(end).toMatchObject({ ok: true, actor: "system", outputSummary: { decision: "answer", output: { answer: { code: WALL_CODE } } } });
    expect(evs.find((e) => e["kind"] === "handoff" && e["state"] === "resumed")).toMatchObject({ answerRef: start?.["id"], by: "plugin:fake-verify" });
    expect(count("/api/verified")).toBe(2);
    await ok("plugin", "disable", "fake-verify");
  }, 120_000);

  test("still no password anywhere in CLI output or the daemon log; daemon stop leaves no browser", async () => {
    expect(holds(readFileSync(join(home, "config", "daemon.log"), "utf8"))).toBe(false);
    expect(printed.filter(holds)).toEqual([]);
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
