// L2 for 0.5-C context budget (Chrome for Testing, the real daemon).
// Expected values come from the range (test/e2e/site.ts) and the owner's
// numbers of 2026-10-16, never from tabcap:
//   s20 noise page (startFieldSite /noise): 60 failing port-scan fetches, 10
//       data: images and one GET /api/ok; then 40 page fetches of /api/look
//       (counted by the site's own journal `hits`), so more than 30 requests
//       are shown by default and `net list` must page at 30.
//   s07 (startGuardSite): the login page HTML as the range serves it (fetched
//       here directly from the range) is the oracle for `net body --grep`.
//   Budget: TABCAP_OUTPUT_LIMIT default 16384 bytes; `snapshot` 12000 chars;
//       `tabcap --help` at most 8 KB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startFieldSite, startGuardSite, type GuardSite, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "example";
const LIMIT = 16384;

let home = "";
let field: Site;
let guard: GuardSite;

type Env = { ok: boolean; data: Record<string, unknown>; envelope: Record<string, unknown>; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME, TABCAP_OUTPUT_LIMIT: "" },
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
    return { ok: exit === 0, data: {}, envelope: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), envelope: env, raw: out, exit };
}

async function ok(...args: string[]): Promise<Env> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e;
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

const bytes = (raw: string) => Buffer.byteLength(raw.trimEnd());

describe.skipIf(!enabled)("tabcap 0.5-C L2 (context budget on the range)", () => {
  const S = ["--session", "budget"];
  let bundle = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e5c-"));
    field = startFieldSite();
    guard = startGuardSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "budget", "--site", SITE);
    bundle = s((await ok("net", "start", ...S)).data["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    field.stop();
    guard.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("tabcap --help is the index, at most 8 KB", async () => {
    const r = await tabcap(["--help"]);
    expect(r.exit).toBe(0);
    expect(bytes(r.raw)).toBeLessThanOrEqual(8 * 1024);
    expect(r.raw).toContain("\n  net list  ");
    expect((await tabcap(["help", "net", "list"])).raw).toContain("Example: tabcap net list");
  });

  test("s07 login → data; net body --grep on the login page HTML gives the range's lines with --context 2", async () => {
    await ok("navigate", `${guard.origin}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S)).data["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("net", "wait", "--url", "/api/data", ...S);

    const list = await ok("net", "list", "--grep", "/api/", "--fields", "id,method,url", ...S);
    const rows = recs(list.data["requests"]);
    const apis = rows.map((r) => [r["method"], new URL(s(r["url"])).pathname]);
    expect(apis).toEqual([
      ["POST", "/api/login"],
      ["POST", "/api/data"],
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "method", "url"]);
    expect(list.envelope["filter"]).toMatchObject({ grep: "/api/", fields: ["id", "method", "url"], matches: 2, capped: false });

    // the oracle: the page bytes as the range serves them
    const html = await (await fetch(`${guard.origin}/s07/login`)).text();
    const lines = html.split("\n");
    const hit = lines.findIndex((l) => l.includes("/api/login"));
    expect(hit).toBeGreaterThan(2);
    const page = recs((await ok("net", "list", "--filter", "/s07/login", ...S)).data["requests"])[0];
    // `net body --grep` is the command's own line search (0.5-F owns the flag on net body, not the output filter):
    // one match, 1-based line number, the two lines before and after, straight from the range's bytes.
    const body = await ok("net", "body", s(page?.["id"]), "--grep", "/api/login", "--context", "2", ...S);
    const matches = recs(body.data["matches"]);
    expect(matches.length).toBe(1);
    expect(matches[0]).toMatchObject({ line: hit + 1, text: lines[hit], before: lines.slice(hit - 2, hit), after: lines.slice(hit + 1, hit + 3) });
    expect(body.data["total"]).toBe(1);
    expect(body.envelope["filter"]).toBeUndefined();
    expect(s(body.data["path"])).not.toBe("");
  }, 60_000);

  test("the list page (s20 noise) + 40 fetches: net list pages at 30 with nextPageIdx; snapshot stays under the cap", async () => {
    await ok("navigate", `${field.origin}/noise`, ...S);
    await ok("wait", "--text", "ok 1", ...S);
    const before = field.hits.filter((h) => h === "GET /api/look").length;
    await ok("evaluate", "Promise.all(Array.from({ length: 40 }, () => fetch('/api/look'))).then(() => 1)", "--await", ...S);
    expect(field.hits.filter((h) => h === "GET /api/look").length - before).toBe(40);
    await ok("net", "wait", "--url", "/api/look", ...S);
    let list = await ok("net", "list", ...S);
    for (let i = 0; i < 30 && Number(list.data["matched"]) < 45; i++) {
      await Bun.sleep(200);
      list = await ok("net", "list", ...S);
    }
    // login page, /api/login, /api/data, noise page, /api/ok, 40 × /api/look (failed and data: hidden)
    expect(Number(list.data["matched"])).toBeGreaterThanOrEqual(45);
    expect(recs(list.data["requests"]).length).toBe(30);
    expect(list.data["shown"]).toBe(30);
    expect(list.data["pageSize"]).toBe(30);
    expect(list.data["nextPageIdx"]).toBe(1);
    const all = await ok("net", "list", "--page-size", "0", ...S);
    // compared within one answer: late-written requests can land between the two lists (CI run 39363020490: 45, then 47)
    expect(recs(all.data["requests"]).length).toBe(Number(all.data["matched"]));
    expect(Number(all.data["matched"])).toBeGreaterThanOrEqual(Number(list.data["matched"]));

    const snap = await ok("snapshot", ...S);
    expect(bytes(snap.raw)).toBeLessThanOrEqual(LIMIT);
    expect(s(snap.data["tree"]).length).toBeLessThanOrEqual(12000);
    // a long list on the same page: cut at 12000 chars, still under the output limit, and it says how to get more
    await ok("evaluate", "(() => { const ul = document.createElement('ul'); for (let i = 0; i < 3000; i++) { const li = document.createElement('li'); li.textContent = 'row ' + i; ul.appendChild(li); } document.body.appendChild(ul); return 3000; })()", ...S);
    const long = await ok("snapshot", ...S);
    expect(long.data["truncated"]).toBe(true);
    expect(s(long.data["tree"]).length).toBeLessThanOrEqual(12000);
    expect(s(long.data["note"])).toContain("--max-chars");
    expect(s(long.data["note"])).toContain("--interactive");
    expect(s(long.data["note"])).toContain("--frame");
    expect(bytes(long.raw)).toBeLessThanOrEqual(LIMIT);
  }, 90_000);

  test("a daemon answer over 16 KB while recording: summary + exports/<command>-<seq>.json in the bundle; --full prints it", async () => {
    const big = await ok("evaluate", "'v'.repeat(20000)", ...S);
    expect(big.data).toMatchObject({ truncated: true, bytes: expect.any(Number), summary: { type: "string" } });
    const file = s(big.data["file"]);
    expect(file).toBe(join(bundle, "exports", "evaluate-1.json"));
    const full = await ok("evaluate", "'v'.repeat(20000)", "--full", ...S);
    expect(bytes(full.raw)).toBeGreaterThan(LIMIT);
    // the same answer except the command window id (`cmd`), which differs per call
    const { cmd: _c1, ...saved } = rec(JSON.parse(readFileSync(file, "utf8")));
    const { cmd: _c2, ...printed } = full.data;
    expect(saved).toEqual(printed);
    expect(s(saved["value"]).length).toBe(20000);
    const again = await ok("evaluate", "'v'.repeat(20000)", ...S);
    expect(s(again.data["file"])).toBe(join(bundle, "exports", "evaluate-2.json"));
  }, 60_000);

  test("analyze deps on a bundle whose JSON is over 16 KB: summary + file (cache, nothing records offline); --full returns everything", async () => {
    await ok("net", "stop", ...S);
    const full = await ok("analyze", "deps", bundle, "--full");
    expect(bytes(full.raw)).toBeGreaterThan(LIMIT);
    const r = await ok("analyze", "deps", bundle);
    expect(bytes(r.raw)).toBeLessThanOrEqual(LIMIT);
    expect(r.data["truncated"]).toBe(true);
    const file = s(r.data["file"]);
    expect(dirname(file)).toBe(join(home, "cache", "outputs"));
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(full.data);
    const summary = rec(r.data["summary"]);
    const reqs = recs(full.data["requests"]);
    expect(summary["requests"]).toBe(reqs.length);
    expect(summary["unresolved"]).toBe(recs(full.data["unresolved"]).length);
    // 0.7-C: the summary keeps counts plus the first 10 requests' input counts (docs/04 §24), not every request.
    expect(summary["inputCount"]).toBe(reqs.reduce((n, q) => n + recs(q["inputs"]).length, 0));
    expect(summary["inputs"]).toEqual(Object.fromEntries(reqs.slice(0, 10).map((q) => [s(q["id"]), recs(q["inputs"]).length])));
    // the filters narrow it to something that fits inline
    const sel = await ok("analyze", "deps", bundle, "--select", "requests[*].id");
    expect(sel.envelope["data"]).toEqual(reqs.map((q) => q["id"]));
    expect(sel.envelope["selected"]).toBe("requests[*].id");
  }, 60_000);
});
