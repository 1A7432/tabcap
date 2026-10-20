// L2 for 0.6-I (Chrome for Testing, the real daemon, the range in site.ts):
//   - s54 `net start --bodies api` vs `all` on a page with a 1.5 MiB script:
//     the bundles' blob bytes differ by exactly what the range sent for the
//     script, the stylesheet and the image (`served`);
//   - s55 a site rule (config.json sites.example.guard.consecutiveNon200: 3)
//     trips on the third non-200 in a row (page XHR and `tabcap fetch` mixed),
//     the session waits, page commands and fetches are refused with
//     guard.stopped, `handoff continue` lets it go on. The statuses are the
//     range's own log (`api`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S54_ROWS, S55_STATUSES, startBodiesSite, type BodiesSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "example";
const S = ["--session", "ex"];

let home = "";
let site: BodiesSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
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
  const line = tree.split("\n").find((l) => l.includes(`${role} "${name}"`));
  const m = /\[(e\d+)\]/.exec(line ?? "");
  if (m === null || m[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
}

function manifest(bundle: string): Record<string, unknown> {
  return rec(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
}

/** Record /s54 once with the given --bodies mode; returns the finished bundle. */
async function recordS54(mode: string): Promise<{ bundle: string; list: Record<string, unknown> }> {
  await Bun.sleep(1100); // bundle directories are named by the second
  const bundle = s((await ok("net", "start", "--bodies", mode, ...S))["bundle"]);
  await ok("navigate", `${site.origin}/s54`, ...S);
  await ok("wait", "--text", S54_ROWS.join(","), ...S);
  await ok("net", "wait", "--url", "/s54/api", ...S);
  const list = await ok("net", "list", "--page-size", "0", ...S);
  await ok("net", "stop", ...S);
  return { bundle, list };
}

describe.skipIf(!enabled)("tabcap 0.6-I L2 (body capture by resource type, site-wide stop rules)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6i-"));
    site = startBodiesSite();
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify({ sites: { [SITE]: { guard: { consecutiveNon200: 3 } } } }, null, 2) + "\n");
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s55`, "--user", "s55-user", "--password-stdin"], "s55-Pa55word-e2e\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "ex", "--site", SITE);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    if (process.env["V06I_KEEP"] === undefined) removeHome(home, import.meta.file);
    else console.log(`[v06i] kept ${home}`);
  });

  test("s54: --bodies api keeps the document and the fetch, skips the script / stylesheet / image; the bundle is smaller by exactly their bytes", async () => {
    const all = await recordS54("all");
    const api = await recordS54("api");
    const mAll = manifest(all.bundle);
    const mApi = manifest(api.bundle);
    expect(mAll["record"]).toEqual({ bodies: "all" });
    expect(mApi["record"]).toEqual({ bodies: "api" });
    const skippedBytes = (site.served.get("/s54/big.js") ?? 0) + (site.served.get("/s54/site.css") ?? 0) + (site.served.get("/s54/logo.png") ?? 0);
    expect(site.served.get("/s54/big.js")).toBeGreaterThan(1_500_000);
    const blobAll = Number(rec(mAll["counts"])["blobBytes"]);
    const blobApi = Number(rec(mApi["counts"])["blobBytes"]);
    console.log(`[v06i] blob bytes: --bodies all ${blobAll}, --bodies api ${blobApi}, skipped by the range's sizes ${skippedBytes}`);
    expect(blobAll - blobApi).toBe(skippedBytes);
    // the request events: skipped ones carry body {skipped: "resource-type"} and their status
    const reqs = events(api.bundle).filter((e) => e["kind"] === "request");
    const byPath = (p: string) => reqs.find((e) => new URL(s(e["url"])).pathname === p);
    for (const p of ["/s54/big.js", "/s54/site.css", "/s54/logo.png"]) {
      const r = rec(byPath(p)?.["response"]);
      expect(r["status"]).toBe(200);
      expect(r["body"]).toEqual({ skipped: "resource-type" });
      expect(r["bodyMissing"]).toBeNull();
    }
    for (const p of ["/s54", "/s54/api"]) expect(s(rec(rec(byPath(p)?.["response"])["body"])["blob"])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // net body on the skipped script says why
    const script = s(byPath("/s54/big.js")?.["id"]);
    const why = await tabcap(["net", "body", script, ...S]);
    expect(why.ok).toBe(false);
    expect(why.error).toMatchObject({ code: "not-found", bodies: "api", skipped: "resource-type", type: "script" });
    expect(s(why.error?.["next"])).toContain("--bodies api+script");
    const rows = Array.isArray(api.list["requests"]) ? api.list["requests"].map(rec) : [];
    expect(rows.filter((r) => r["bodySkipped"] === "resource-type").map((r) => r["type"]).sort()).toEqual(["image", "script", "stylesheet"]);
  }, 90_000);

  test("s55: the third non-200 in a row (page XHR, tabcap fetch, page XHR) trips the site rule → waiting, guard.stopped, handoff continue goes on", async () => {
    await Bun.sleep(1100); // bundle directories are named by the second
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${site.origin}/s55`, ...S);
    const button = refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", "加载");
    await ok("click", button, ...S);
    await ok("wait", "--text", "n1=200", ...S);
    await ok("click", button, ...S);
    await ok("wait", "--text", "n2=500", ...S);
    const viaFetch = await ok("fetch", "/s55/api", ...S); // the third request, second non-200
    expect(viaFetch["status"]).toBe(500);
    const third = await tabcap(["click", button, ...S]); // the fourth request, third non-200 in a row
    if (!third.ok) expect(third.error?.["code"]).toBe("guard.stopped");
    expect(site.api.map((a) => a.status)).toEqual([...S55_STATUSES]);
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      status = await ok("handoff", "status", ...S);
      if (status["state"] === "waiting" && typeof rec(status["handoff"])["screenshot"] === "string") break;
      await Bun.sleep(100);
    }
    const h = rec(status["handoff"]);
    expect(status["state"]).toBe("waiting");
    expect(h).toMatchObject({ reason: "stop-rule", site: SITE, rule: "consecutiveNon200:3", status: 500 });
    expect(existsSync(s(h["screenshot"]))).toBe(true);
    expect(s(h["next"])).toContain("tabcap handoff continue");
    // refused: the session's page commands and the site's fetches; nothing reaches the range
    const click = await tabcap(["click", button, ...S]);
    expect(click.error).toMatchObject({ code: "guard.stopped" });
    const fetch = await tabcap(["fetch", "/s55/api", ...S]);
    expect(fetch.error).toMatchObject({ code: "guard.stopped" });
    expect(site.api.length).toBe(4);
    const cont = await ok("handoff", "continue", ...S);
    expect(cont).toMatchObject({ state: "resumed", reason: "stop-rule", fetchResumed: [SITE] });
    const after = await ok("fetch", "/s55/api", ...S);
    expect(after["status"]).toBe(200);
    expect(site.api.map((a) => a.status)).toEqual([...S55_STATUSES, 200]);
    await ok("net", "stop", ...S);
    // the bundle: the tripping request is the fourth /s55/api, a 500; breaker, waiting, resumed
    const evs = events(bundle);
    const apiReqs = evs.filter((e) => e["kind"] === "request" && new URL(s(e["url"])).pathname === "/s55/api");
    expect(apiReqs.map((e) => rec(e["response"])["status"])).toEqual([...S55_STATUSES, 200]);
    const tripped = apiReqs[3];
    expect(h["request"]).toBe(tripped?.["id"]);
    const guard = evs.filter((e) => e["kind"] === "guard" && e["reason"] === "stop-rule");
    expect(guard.map((g) => [g["event"], g["site"], g["rule"], g["request"]])).toEqual([
      ["breaker", SITE, "consecutiveNon200:3", tripped?.["id"]],
      ["resume", SITE, "consecutiveNon200:3", tripped?.["id"]],
    ]);
    const handoffs = evs.filter((e) => e["kind"] === "handoff");
    expect(handoffs.map((e) => [e["state"], e["reason"]])).toEqual([
      ["waiting", "stop-rule"],
      ["resumed", "stop-rule"],
    ]);
  }, 90_000);
});
