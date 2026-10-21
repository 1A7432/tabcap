// L2 for 0.6-F `session export` (Chrome for Testing, the real daemon, the range in site.ts).
// Expected values come from the range, never from tabcap:
//   s07 token variant (startGuardSite, `/s07/login?token=1`): POST /api/login
//   answers set-cookie sid plus {csrf, token} (the site's journal `sids`,
//   `csrfs`, `tokens`); the page keeps the token in localStorage
//   (`access_token`), sets sessionStorage `s07_tab` = "1" and sends
//   `authorization: Bearer <token>` + `x-csrf` with the cookie to /api/data,
//   which answers {data: "data-ok"} only when all three are right.
// The exported httpx client is then run (uv, offline) against `replay serve` of
// the recording (header x-tabcap-replay) and against the range itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { expectMode } from "../unit/_platform.ts";
import { MUST_RUN, need, packageReason, runInPackageAsync, syncPackage } from "../unit/_python.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, type GuardSite } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "range-demo";

let home = "";
let guard: GuardSite;

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
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

describe.skipIf(!enabled)("tabcap 0.6-F L2 (session export --for requests / httpx / playwright on s07)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6f-"));
    guard = startGuardSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login?token=1`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    guard.stop();
    removeHome(home, import.meta.file);
  });

  test("s07 login with a bearer token: the export holds the cookie sid, authorization + x-csrf and the storage keys; 0600; the envelope only counts and names; the httpx client replays /api/data", async () => {
    const S = ["--session", "s07f"];
    const st = await ok("session", "start", "s07f", "--site", SITE);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("net", "wait", "--url", "/api/data", ...S);

    // the range's journal: one login, its sid, csrf and token
    expect([guard.sids.length, guard.csrfs.length, guard.tokens.length]).toEqual([1, 1, 1]);
    const sid = guard.sids[0] ?? "";
    const csrf = guard.csrfs[0] ?? "";
    const token = guard.tokens[0] ?? "";
    expect(token).not.toBe("");
    const values = [sid, csrf, token, LOGIN_PASSWORD];

    // --for requests while recording
    const jsonFile = join(home, "out", "session.json");
    const e = await tabcap(["session", "export", "--for", "requests", "--out", jsonFile, ...S]);
    if (!e.ok) throw new Error(e.raw);
    for (const v of values) expect(e.raw.includes(v)).toBe(false);
    expect(e.data).toMatchObject({ file: jsonFile, for: "requests", origin: guard.origin, mode: "0600", storage: { localStorage: 1, sessionStorage: 1 } });
    expect(e.data["cookies"]).toBe(1);
    expect(e.data["headers"]).toEqual(["authorization", "x-csrf"]);
    // 0.6-P: source.headers is {request, origin, auto}
    expect(rec(e.data["source"])["headers"]).toMatchObject({ origin: guard.origin, auto: false });
    const srcId = s(rec(rec(e.data["source"])["headers"])["request"]);
    expect(srcId).toMatch(/^r-\d+$/);
    expectMode(jsonFile, 0o600);
    expectMode(join(home, "out"), 0o700);
    const doc = rec(JSON.parse(readFileSync(jsonFile, "utf8")));
    expect(doc["schema"]).toBe("tabcap-session-export/0");
    expect(doc["origin"]).toBe(guard.origin);
    expect(recs(doc["cookies"]).map((c) => [c["name"], c["value"], c["domain"], c["httpOnly"]])).toEqual([["sid", sid, "127.0.0.1", true]]);
    expect(doc["headers"]).toEqual({ authorization: `Bearer ${token}`, "x-csrf": csrf });
    expect(doc["storage"]).toEqual({ localStorage: { access_token: token }, sessionStorage: { s07_tab: "1" } });

    // --for playwright: storageState, headers and sessionStorage reported as omitted
    const stateFile = join(home, "out", "state.json");
    const p = await tabcap(["session", "export", "--for", "playwright", "--out", stateFile, ...S]);
    if (!p.ok) throw new Error(p.raw);
    for (const v of values) expect(p.raw.includes(v)).toBe(false);
    expect(p.data).toMatchObject({ headers: [], storage: { localStorage: 1, sessionStorage: 0 }, omitted: { headers: ["authorization", "x-csrf"], sessionStorage: 1 } });
    expectMode(stateFile, 0o600);
    const state = rec(JSON.parse(readFileSync(stateFile, "utf8")));
    expect(recs(state["cookies"]).map((c) => [c["name"], c["value"]])).toEqual([["sid", sid]]);
    expect(state["origins"]).toEqual([{ origin: guard.origin, localStorage: [{ name: "access_token", value: token }] }]);

    await ok("net", "stop", ...S);
    // the headers came from the recorded /api/data request
    const data = BundleReader.open(bundle)
      .requests()
      .filter((r) => r.url === `${guard.origin}/api/data`);
    expect(data.map((r) => r.id)).toEqual([srcId]);
    // the bundle got the usual cmd events: counts and names in outputSummary, no value
    const events = BundleReader.open(bundle).events;
    const starts = events.filter((x) => x.kind === "cmd" && x["phase"] === "start" && rec(x["input"])["action"] === "session.export").map((x) => x["id"]);
    const ends = events.filter((x) => x.kind === "cmd" && x["phase"] === "end" && starts.includes(x["ref"]));
    expect(ends.map((x) => rec(x["outputSummary"])["cookies"])).toEqual([1, 1]);
    for (const x of ends) for (const v of values) expect(JSON.stringify(x).includes(v)).toBe(false);

    // --for httpx after the recording finished (the last bundle of the session), into a generated package
    const pkg = join(home, "pkg");
    await ok("replay", "export-python", bundle, "-o", pkg);
    expect(existsSync(join(pkg, "_tabcap_session.py"))).toBe(true);
    const h = await tabcap(["session", "export", "--for", "httpx", "--out", join(pkg, "example_session"), ...S]);
    if (!h.ok) throw new Error(h.raw);
    for (const v of values) expect(h.raw.includes(v)).toBe(false);
    const mod = join(pkg, "example_session.py");
    expect(h.data).toMatchObject({ file: mod, for: "httpx", cookies: 1, headers: ["authorization", "x-csrf"], source: { headers: { request: srcId, origin: guard.origin, auto: false } } });
    expectMode(mod, 0o600);

    // through uv offline in the package's own .venv; no uv / cache: 待验 locally, a failure under CI
    const PY = packageReason();
    if (PY !== null && !MUST_RUN) {
      console.warn(`[v06f] httpx client run 待验: ${PY}`);
      return;
    }
    need(PY);
    need(syncPackage(pkg));
    const srv = await serve(bundle);
    try {
      const script = [
        "import sys, example_session, _tabcap_session",
        "with example_session.client(base_url=sys.argv[1]) as c:",
        '    r = c.post("/api/data")',
        '    print("replay", r.status_code, r.headers.get("x-tabcap-replay", "").split(";")[0])',
        "with example_session.client() as c:",
        '    r = c.post("/api/data")',
        '    print("range", r.status_code, r.json().get("data"))',
        `s = _tabcap_session.load(${JSON.stringify(jsonFile)})`,
        "with _tabcap_session.client(s) as c:",
        '    r = c.post("/api/data")',
        '    print("helper", r.status_code, r.json().get("data"))',
      ].join("\n");
      const r = await runInPackageAsync(pkg, ["python", "-c", script, srv.url]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out.trim().split(/\r?\n/)).toEqual([`replay 200 ${srcId}`, "range 200 data-ok", "helper 200 data-ok"]); // CRLF on Windows
    } finally {
      await srv.stop();
    }
    // the range saw both client calls with the session (one login only)
    expect(guard.hits.filter((x) => x === "POST /api/data").length).toBe(3);
    expect(guard.sids.length).toBe(1);
  }, 120_000);

  test("no recording in a session: headers {} and source none, with the hint; a non-http tab is refused", async () => {
    const S = ["--session", "s07g"];
    await ok("navigate", `${guard.origin}/s07/login`, ...S);
    const out = join(home, "out", "bare.json");
    const e = await ok("session", "export", "--for", "requests", "--out", out, ...S);
    // 0.6-D (owner 10-16): s07f's account session has its own browser context, so this session without an
    // account (default context) does not see the token s07f's login put into localStorage.
    expect(e).toMatchObject({ headers: [], source: { headers: { request: null, origin: null, auto: false } }, storage: { localStorage: 0, sessionStorage: 0 } });
    expect(s(e["note"])).toContain("net start");
    expect(rec(JSON.parse(readFileSync(out, "utf8")))["headers"]).toEqual({});
    const bad = await tabcap(["session", "export", "--for", "csv", "--out", out, ...S]);
    expect([bad.ok, bad.error?.["code"]]).toEqual([false, "usage"]);
    await ok("navigate", "about:blank", ...S);
    const blank = await tabcap(["session", "export", "--for", "requests", "--out", out, ...S]);
    expect([blank.ok, blank.error?.["code"]]).toEqual([false, "usage"]);
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
