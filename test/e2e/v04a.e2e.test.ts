// L2 for 0.4-A: analyze deps / analyze chain / export-python verify() on real
// recordings of docs/05 s06 and s07 (Chrome for Testing, the real daemon).
// Expected values come from the range sites and docs/05, never from tabcap:
//   s06 (startSearchSite({ sid: true })): the page document sets sid (the
//       site's `sids` / `sidBy` say which response handed it out) and the page
//       copies it into the query; sig = sha256(q|page|t|nonce) in the page.
//       docs/05 s06 P2: sid comes from set-cookie, sig varies with q/page/t/nonce.
//   s07 (startGuardSite): POST /api/login answers set-cookie sid (the site's
//       `sids`) and {csrf}; the page sends x-csrf + the cookie to /api/data.
//       docs/05 s07 P2: deps draws the csrf chain. The generated verify() then
//       replays that chain against `replay serve` of the bundle and must pass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { MUST_RUN, need, packageReason, pyCompile, runInPackageAsync, syncPackage } from "../unit/_python.ts";
import { LOGIN_PASSWORD, LOGIN_USER, SEARCH_BUILD, startGuardSite, startSearchSite, type GuardSite, type SearchSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "range-demo";
/** CI diagnostics: copy this run's daemon / browser logs and bundles here before the temp home is removed. */
const KEEP = process.env["TABCAP_E2E_KEEP"] ?? "";
const SPELLINGS = [...new Set([LOGIN_PASSWORD, JSON.stringify(LOGIN_PASSWORD).slice(1, -1), encodeURIComponent(LOGIN_PASSWORD), new URLSearchParams({ p: LOGIN_PASSWORD }).toString().slice(2)])];

let home = "";
let guard: GuardSite;
let search: SearchSite;

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

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

type Input = { location: string; name: string; path?: string; class: string; primary: Record<string, unknown> | null; sources: Record<string, unknown>[]; hints: string[]; covaries: string[] };

function inputsOf(deps: Record<string, unknown>, id: string): Input[] {
  const q = recs(deps["requests"]).find((r) => r["id"] === id);
  return recs(q?.["inputs"]).map((i) => ({
    location: s(i["location"]),
    name: s(i["name"]),
    ...(typeof i["path"] === "string" ? { path: i["path"] } : {}),
    class: s(i["class"]),
    primary: isRecord(i["primary"]) ? i["primary"] : null,
    sources: recs(i["sources"]),
    hints: Array.isArray(i["hints"]) ? i["hints"].map(s) : [],
    covaries: Array.isArray(i["covaries"]) ? i["covaries"].map(s) : [],
  }));
}

function inputOf(deps: Record<string, unknown>, id: string, location: string, name: string): Input {
  const i = inputsOf(deps, id).find((x) => x.location === location && x.name === name);
  if (i === undefined) throw new Error(`no ${location} ${name} in ${id}`);
  return i;
}

/** Wall time of `analyze deps` over a bundle, in ms (logged for docs/03 §8: native analyze trigger). */
async function timedDeps(bundle: string): Promise<{ data: Record<string, unknown>; ms: number }> {
  const t0 = performance.now();
  const data = await ok("analyze", "deps", bundle);
  return { data, ms: Math.round(performance.now() - t0) };
}

/** The *.log files of config/ and the bundles of a temp TABCAP_HOME (not the Chrome profile). */
function keepHome(from: string, to: string): void {
  for (const sub of ["config", join("data", "bundles")]) {
    const src = join(from, sub);
    if (!existsSync(src)) continue;
    cpSync(src, join(to, sub), { recursive: true, filter: (f) => sub !== "config" || f === src || f.endsWith(".log") });
  }
}

async function serve(dir: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const proc = Bun.spawn(["bun", MAIN, "replay", "serve", dir, "--port", "0", "--once", "120", "--json"], { env: { ...process.env, TABCAP_HOME: home }, stdout: "pipe", stderr: "pipe" });
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
  return {
    url: s(rec(rec(env)["data"])["url"]),
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

describe.skipIf(!enabled)("tabcap 0.4-A L2 (deps, chain, export-python verify on s06 / s07)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4a-"));
    guard = startGuardSite();
    search = startSearchSite({ sid: true });
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    guard.stop();
    search.stop();
    if (KEEP !== "") keepHome(home, join(KEEP, basename(home)));
    rmSync(home, { recursive: true, force: true });
  });

  test("s06: sid comes from the set-cookie of the first page load; sig varies with q, page, t, nonce (docs/05 s06 P2)", async () => {
    const S = ["--session", "s06"];
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    for (const [q, page] of [["apple", "1"], ["banana", "2"]] as const) {
      await ok("navigate", `${search.origin}/s06?q=${q}&page=${page}`, ...S);
      await ok("wait", "--text", `hits ${q}-${page}-a`, ...S);
      await ok("net", "wait", "--url", `/api/search?q=${q}`, ...S);
    }
    await ok("net", "stop", ...S);

    // the site's journal: one sid, handed out with the first page load
    expect(search.sids.length).toBe(1);
    const sid = search.sids[0] ?? "";
    expect(search.sidBy.get(sid)).toBe("/s06?q=apple&page=1");
    const reqs = BundleReader.open(bundle).requests();
    const doc = reqs.find((r) => r.type === "document" && r.url === `${search.origin}/s06?q=apple&page=1`);
    const searches = reqs.filter((r) => new URL(r.url).pathname === "/api/search");
    expect(doc).toBeDefined();
    expect(searches.length).toBe(2);
    for (const r of searches) expect(new URL(r.url).searchParams.get("sid")).toBe(sid);

    const { data: deps, ms } = await timedDeps(bundle);
    console.log(`[v04a] analyze deps s06: ${reqs.length} requests, ${ms} ms`);
    for (const r of searches) {
      for (const where of ["query", "cookie"]) {
        const i = inputOf(deps, r.id, where, "sid");
        expect([r.id, where, i.class, i.primary]).toEqual([r.id, where, "set-cookie", { kind: "set-cookie", request: doc?.id, cookie: "sid" }]);
      }
      const sig = inputOf(deps, r.id, "query", "sig");
      expect(sig.class).toBe("computed-in-page");
      expect(sig.primary).toBeNull();
      expect(sig.hints).toContain("looks-signature");
      expect(sig.covaries).toEqual(["q", "page", "t", "nonce"]);
      expect(inputOf(deps, r.id, "query", "t").class).toBe("timestamp");
      expect(inputOf(deps, r.id, "query", "nonce").class).toBe("computed-in-page");
      for (const [loc, n] of [["query", "client"], ["query", "v"], ["header", "x-client-build"]] as const) expect(inputOf(deps, r.id, loc, n).sources.some((x) => x["kind"] === "constant")).toBe(true);
    }
    expect(SEARCH_BUILD).toBe("2026.10");

    const target = searches[1]?.id ?? "";
    const chain = await ok("analyze", "chain", bundle);
    expect(chain["target"]).toBe(target);
    const steps = recs(chain["steps"]).map((x) => x["request"]);
    expect(steps[0]).toBe(doc?.id);
    expect(steps[steps.length - 1]).toBe(target);
    expect(recs(chain["todo"]).filter((t) => t["request"] === target).map((t) => t["name"])).toEqual(expect.arrayContaining(["sig", "nonce"]));
  }, 90_000);

  test("s07: x-csrf from the login body, sid from its set-cookie; verify() replays login → data against replay serve (docs/05 s07 P2)", async () => {
    const S = ["--session", "s07"];
    const st = await ok("session", "start", "s07", "--site", SITE);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    // the user name typed as plain text (a recorded fill), the password from the store (--secret)
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("net", "stop", ...S);

    // the site's journal: one login, one sid
    expect(guard.loginBodies.length).toBe(1);
    expect(guard.sids.length).toBe(1);
    const sid = guard.sids[0] ?? "";
    const reqs = BundleReader.open(bundle).requests();
    const login = reqs.find((r) => r.url.endsWith("/api/login"));
    const data = reqs.find((r) => r.url.endsWith("/api/data"));
    if (login === undefined || data === undefined) throw new Error("login / data not recorded");
    expect(s(login.response?.headers["set-cookie"])).toContain(`sid=${sid}`);
    expect(s(data.request.headers["cookie"])).toContain(`sid=${sid}`);

    const { data: deps, ms } = await timedDeps(bundle);
    console.log(`[v04a] analyze deps s07: ${reqs.length} requests, ${ms} ms`);
    // Diagnostics for the 10-16 Windows flake (x-csrf primary null once: the two requests' wall
    // clocks disagreed with their monotonic order; deps now orders them on mono). Both clocks.
    const wallStart = data.timing?.start == null || data.mono === null ? data.ts : data.ts - (data.mono - data.timing.start);
    const monoGap = login.mono === null || data.timing?.start == null ? null : Math.round((data.timing.start - login.mono) * 1000) / 1000;
    console.log(`[v04a] s07 login ${login.id} end ts ${login.ts} mono ${login.mono} unreadByPage ${login["unreadByPage"] === true}; data ${data.id} start ts ${wallStart}: wall gap ${Math.round((wallStart - login.ts) * 1000) / 1000} ms, mono gap ${monoGap} ms`);
    expect(inputOf(deps, data.id, "header", "x-csrf").primary).toEqual({ kind: "response", request: login.id, path: "$.csrf", decode: [], match: "exact" });
    expect(inputOf(deps, data.id, "cookie", "sid").primary).toEqual({ kind: "set-cookie", request: login.id, cookie: "sid" });
    expect(inputOf(deps, login.id, "body", "user").class).toBe("action");
    const pw = inputOf(deps, login.id, "body", "password");
    expect(pw.sources.some((x) => x["kind"] === "action")).toBe(false);
    expect(pw.hints).toContain("sensitive-name");
    for (const sp of SPELLINGS) expect(JSON.stringify(deps).includes(sp)).toBe(false);

    const chain = await ok("analyze", "chain", bundle);
    expect(chain["target"]).toBe(data.id);
    expect(recs(chain["steps"]).map((x) => x["request"])).toEqual([login.id, data.id]);

    const out = join(home, "s07-client");
    const e = await ok("replay", "export-python", bundle, "-o", out);
    expect(rec(e["chain"])).toMatchObject({ target: data.id, steps: [login.id, data.id] });
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
    for (const f of walk(out)) for (const sp of SPELLINGS) expect([f, readFileSync(f, "utf8").includes(sp)]).toEqual([f, false]);
    expect(statSync(join(out, "verify_expected.json")).size).toBeGreaterThan(0);

    // through uv offline, in the package's own .venv; no uv / cache: 待验 locally, a failure under CI
    const PY = packageReason();
    if (PY !== null && !MUST_RUN) {
      console.warn(`[v04a] verify() run 待验: ${PY}`);
      return;
    }
    need(PY);
    need(syncPackage(out));
    const srv = await serve(bundle);
    try {
      const p = await runInPackageAsync(out, ["python", "client.py", "verify", "--base-url", srv.url], { TABCAP_SECRET_POST_API_LOGIN_PASSWORD: LOGIN_PASSWORD });
      const text = p.out;
      console.log(`[v04a] verify():\n${text}`);
      expect(p.err).toBe("");
      expect(p.code).toBe(0);
      expect(text).toContain("verify: 2 step(s), 2 pass, 0 fail");
    } finally {
      await srv.stop();
    }
  }, 120_000);

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
