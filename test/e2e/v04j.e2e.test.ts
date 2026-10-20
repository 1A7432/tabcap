// L2 for 0.4-J recon dossier v0 (Chrome for Testing, the real daemon).
// Expected values come from the range sites (test/e2e/site.ts), never from tabcap:
//   s07 (startGuardSite): GET /s07/login (document), POST /api/login answers
//       set-cookie sid (HttpOnly) and {csrf}; the page then POSTs /api/data
//       with x-csrf and the cookie.
//   s06 (startSearchSite({ sid: true })): GET /s06?q&page (document); the page
//       fetches GET /api/search and shows "hits <q>-<page>-a,<q>-<page>-b",
//       which the /api/search JSON carries (hits: [...]). Both sites listen on
//       127.0.0.1, so the s07 sid cookie is sent to s06 too (cookies ignore the
//       port) and s06 hands out no sid of its own.
//   Coverage lower bound: the s06 page shows exactly the tokens "hits",
//       "<q>-<page>-a", "<q>-<page>-b" (4+ characters each), all three in the
//       /api/search response: found >= 3, ratio >= 1.
//   s15 (startGuardSite): the 6th /api/limited answers an HTML 403, the guard
//       trips (verify-page) and hands the session to the human.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, LIMIT_OK, startGuardSite, startSearchSite, type GuardSite, type SearchSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "example";
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

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

function dossierOf(path: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(v)) throw new Error("dossier is not an object");
  return v;
}

describe.skipIf(!enabled)("tabcap 0.4-J L2 (recon dossier on s07 + s06, s15)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4j-"));
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
    removeHome(home, import.meta.file);
  });

  test("s07 login → data, then s06 search: channels, coverage, sid and the csrf header, no protection; receipt in the cmd end event", async () => {
    const S = ["--session", "recon"];
    const st = await ok("session", "start", "recon", "--site", SITE);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("navigate", `${search.origin}/s06?q=alpha&page=2`, ...S);
    await ok("wait", "--text", "hits alpha-2-a", ...S);
    await ok("net", "wait", "--url", "/api/search?q=alpha", ...S);

    const out = await ok("recon", ...S);
    expect(out["receipt"]).toEqual({ dossier: "exports/dossier.json" });
    expect(s(out["dossier"])).toBe(join(bundle, "exports", "dossier.json"));
    expect(s(out["markdown"])).toBe(join(bundle, "exports", "dossier.md"));
    const d = dossierOf(s(out["dossier"]));
    expect(d["schema"]).toBe("tabcap-dossier/0");
    expect(rec(d["page"])).toMatchObject({ url: `${search.origin}/s06?q=alpha&page=2`, title: "s06 search", source: "live" });

    // the site's journal: one login, one sid, and s06 handed out none
    expect(guard.sids.length).toBe(1);
    expect(search.sids.length).toBe(0);
    const reqs = BundleReader.open(bundle).requests();
    const login = reqs.find((r) => r.url === `${guard.origin}/api/login`);
    const data = reqs.find((r) => r.url === `${guard.origin}/api/data`);
    if (login === undefined || data === undefined) throw new Error("login / data not recorded");

    // channels: the literal path templates of both sites
    const channels = recs(d["channels"]).map((c) => [c["method"], c["template"], c["type"], c["body"]]);
    for (const want of [
      ["GET", "/s07/login", "document", "html"],
      ["POST", "/api/login", "fetch", "json"],
      ["POST", "/api/data", "fetch", "json"],
      ["GET", "/s06", "document", "html"],
      ["GET", "/api/search", "fetch", "json"],
    ]) expect(channels).toContainEqual(want);
    const searchCh = recs(d["channels"]).find((c) => c["template"] === "/api/search");
    expect(Number(searchCh?.["tokens"])).toBeGreaterThanOrEqual(3);

    // coverage: the three tokens of the s06 page are all in /api/search
    const cov = rec(d["coverage"]);
    expect(Number(cov["found"])).toBeGreaterThanOrEqual(3);
    expect(Number(cov["ratio"])).toBeGreaterThanOrEqual(1);

    // cookies: sid set by the login request, a session cookie, required by the data request
    const cookies = recs(d["cookies"]);
    const sid = cookies.find((c) => c["name"] === "sid" && c["carrier"] === "cookie");
    expect(sid).toMatchObject({ origin: { kind: "set-cookie", request: login.id }, role: "session", flags: { httpOnly: true } });
    expect(recs(sid?.["requiredBy"]).map((x) => [x["request"], x["input"]])).toContainEqual([data.id, "cookie:sid"]);
    // the csrf value: the x-csrf header, from the login response's $.csrf, required by the data request
    const csrf = cookies.find((c) => c["name"] === "x-csrf");
    expect(csrf).toMatchObject({ carrier: "header", role: "csrf", origin: { kind: "deps", class: "response", request: login.id, path: "$.csrf" } });
    expect(recs(csrf?.["requiredBy"]).map((x) => x["request"])).toContain(data.id);

    expect(d["protection"]).toEqual([]);

    // credentials never reach the dossier
    for (const f of [s(out["dossier"]), s(out["markdown"])]) for (const sp of SPELLINGS) expect([f, readFileSync(f, "utf8").includes(sp)]).toEqual([f, false]);

    // --text prints the Markdown dossier
    const text = await tabcap(["recon", "--text", ...S]);
    expect(text.exit).toBe(0);
    expect(text.raw.startsWith("# Recon dossier")).toBe(true);
    expect(text.raw).toContain("| POST | /api/data | fetch | json |");

    await ok("net", "stop", ...S);
    // the cmd end event of recon carries the receipt
    const evs = BundleReader.open(bundle).events;
    const starts = evs.filter((e) => e.kind === "cmd" && e["phase"] === "start" && rec(e["input"])["action"] === "recon").map((e) => e["id"]);
    expect(starts.length).toBe(2);
    for (const id of starts) {
      const end = evs.find((e) => e.kind === "cmd" && e["phase"] === "end" && e["ref"] === id);
      expect(rec(end?.["outputSummary"])["receipt"]).toEqual({ dossier: "exports/dossier.json" });
    }

    // offline: the same bundle, the last recorded document stands in for the page
    const off = await ok("analyze", "recon", bundle);
    const od = dossierOf(s(off["dossier"]));
    expect(rec(od["page"])).toMatchObject({ source: "recorded-document" });
    expect(recs(od["channels"]).map((c) => c["template"])).toEqual(recs(d["channels"]).map((c) => c["template"]));
  }, 120_000);

  test("s15: the guard's challenge detection is listed with what was handed to the human", async () => {
    const S = ["--session", "wall"];
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${guard.origin}/s15/?bucket=recon`, ...S);
    const load = refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", "加载");
    for (let i = 1; i <= LIMIT_OK; i++) {
      await ok("click", load, ...S);
      await ok("wait", "--text", `loaded ${i}`, ...S);
    }
    const sixth = await tabcap(["click", load, ...S]); // ok, or already `waiting` if the 403 beat it
    if (!sixth.ok) expect(sixth.error?.["code"]).toBe("waiting");
    const st = await until("the waiting state", () => ok("handoff", "status", ...S), (x) => x["state"] === "waiting" && rec(x["handoff"])["screenshot"] !== null);
    const h = rec(st["handoff"]);

    // recon is read-only: it runs while the session waits for the human
    const out = await ok("recon", ...S);
    const d = dossierOf(s(out["dossier"]));
    const wall = BundleReader.open(bundle)
      .requests()
      .filter((r) => r.url.includes("/api/limited") && r.response?.status === 403);
    expect(wall.length).toBe(1);
    const wallId = wall[0]?.id ?? "";
    const prot = recs(d["protection"]);
    expect(prot.find((p) => p["source"] === "guard")).toMatchObject({ kind: "verify-page", request: wallId, status: 403, handedToHuman: { screenshot: h["screenshot"] }, grade: "实测" });
    expect(prot.find((p) => p["source"] === "response" && p["signal"] === "html-403")).toMatchObject({ requests: [wallId], grade: "推断" });
    expect(s(d["notes"])).toContain("Identification only");

    await ok("handoff", "continue", ...S);
    await ok("net", "stop", ...S);
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
    expect(readdirSync(home).length).toBeGreaterThan(0);
  }, 30_000);
});
