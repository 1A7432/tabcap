// L2: drive tabcap only through its CLI JSON envelopes against a local site.
// Needs TABCAP_E2E=1 and TABCAP_CHROME=<Chrome for Testing binary>; uses a temp
// TABCAP_HOME and --proxy none, so nothing outside 127.0.0.1 is contacted.
// Run: TABCAP_CHROME=... bun run test:e2e

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { pngInfo, pngIsUniform } from "../../src/shared/png.ts";
import { frontmostApp } from "../../src/daemon/transport/direct/launcher.ts";
import { SLOW_MS, startSmokeSite, startSite, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PASSWORD = "e2e-Pw-7f3k!Zq";
const S = "e2e";

let home = "";
let site: Site;
let smoke: Site;
const outputs: string[] = [];
// Focus rule: the user may switch apps while the suite runs, so the frontmost
// app is allowed to change; it must never become our Chrome for Testing.
// Every change is recorded for diagnostics and printed on failure.
const CFT_APP = "Google Chrome for Testing";
let front: string | null = null;
const frontChanges: string[] = [];

type Env = { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string; next: string } };

async function tabcap(...args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe" });
  const [out, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  outputs.push(out, stderr);
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  if (front !== null) {
    const now = frontmostApp();
    if (now !== front) frontChanges.push(`${args.join(" ")} -> ${now ?? "?"}`);
    if (now !== null) front = now;
  }
  const e = env["error"];
  const err = isRecord(e) ? e : null;
  return {
    ok: env["ok"],
    data: isRecord(env["data"]) ? env["data"] : {},
    ...(err === null ? {} : { error: { code: s(err["code"]), message: s(err["message"]), next: s(err["next"]) } }),
  };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(...args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${JSON.stringify(e.error)}`);
  return e.data;
}

const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const refOf = (tree: string, re: RegExp): string => {
  const m = re.exec(tree);
  if (m === null || m[1] === undefined) throw new Error(`no ${re} in\n${tree}`);
  return m[1];
};
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe.skipIf(!enabled)("tabcap L2 (direct transport)", () => {
  let bundle = "";

  beforeAll(async () => {
    // A TABCAP_HOME longer than sun_path allows (bug 10-15): the socket must fall back.
    home = join(mkdtempSync(join(tmpdir(), "tabcap-e2e-")), "a-deliberately-long-directory-name-so-config-daemon-sock-exceeds-the-unix-socket-limit");
    site = startSite();
    smoke = startSmokeSite();
  });

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    smoke.stop();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });

  test("daemon + browser start with --executable-path and --proxy none (no setup)", async () => {
    expect(Buffer.byteLength(join(home, "config", "daemon.sock"))).toBeGreaterThan(104);
    const d = await ok("daemon", "start");
    expect(d["running"]).toBe(true);
    expect(d["socketFallback"]).toBe(true);
    expect(Buffer.byteLength(s(d["socket"]))).toBeLessThanOrEqual(103);
    expect((statSync(s(d["socket"])).mode & 0o777).toString(8)).toBe("600");
    expect(await ok("daemon", "status")).toMatchObject({ running: true, socket: d["socket"] });
    const b = await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    expect(b).toMatchObject({ transport: "direct", channel: "pipe", proxy: "none", executableSource: "flag" });
    front = frontmostApp();
    if (front === null) console.log("note: macOS frontmost-app query not available; focus checks skipped");
    expect(front).not.toBe(CFT_APP);
    await ok("net", "start", "--session", S);
  }, 60_000);

  test("navigate waits for readiness", async () => {
    const n = await ok("navigate", `${site.origin}/`, "--session", S);
    expect(n).toMatchObject({ tab: "t1", url: `${site.origin}/`, title: "tabcap e2e home", readyState: "complete" });
    expect(s(n["nav"])).toMatch(/^n-\d+$/);
  }, 60_000);

  test("snapshot --interactive, click (level 1) and click --trusted (level 2)", async () => {
    const snap = await ok("snapshot", "--interactive", "--session", S);
    const tree = s(snap["tree"]);
    const btn = refOf(tree, /button "Add item" \[(e\d+)\]/);
    expect(tree).not.toContain("heading");
    const c1 = await ok("click", btn, "--session", S);
    expect(c1).toMatchObject({ level: 1, trusted: false });
    expect((await ok("evaluate", "[window.__clicks, window.__pointerdowns]", "--session", S))["value"]).toEqual([1, 0]);
    const c2 = await ok("click", btn, "--trusted", "--session", S);
    expect(c2).toMatchObject({ level: 2, trusted: true, delivered: { pointerdown: true, mousedown: true } });
    expect((await ok("evaluate", "[window.__clicks, window.__pointerdowns]", "--session", S))["value"]).toEqual([2, 1]);
    expect((await ok("evaluate", "document.getElementById('count').textContent", "--session", S))["value"]).toBe("2");
  }, 60_000);

  test("fill sets values; the password never comes back", async () => {
    const tree = s((await ok("snapshot", "--interactive", "--session", S))["tree"]);
    const name = refOf(tree, /textbox "Name" \[(e\d+)\]/);
    const pw = refOf(tree, /textbox "Password" \[(e\d+)\]/);
    expect(await ok("fill", name, "bob", "--session", S)).toMatchObject({ kind: "input", masked: false });
    expect(await ok("fill", pw, PASSWORD, "--session", S)).toMatchObject({ kind: "input", inputType: "password", masked: true });
    expect((await ok("evaluate", "document.getElementById('name').value", "--session", S))["value"]).toBe("bob");
    // the page really has the password; the envelope must not
    expect((await ok("evaluate", "document.getElementById('pw').value", "--session", S))["value"]).toBe("<masked>");
    expect((await ok("evaluate", "document.getElementById('pw').value.length", "--session", S))["value"]).toBe(PASSWORD.length);
    const full = s((await ok("snapshot", "--session", S))["tree"]);
    expect(full).toContain('value="bob"');
    expect(full).toMatch(/textbox "Password" \[e\d+\] \[password\]/);
  }, 60_000);

  test("evaluate returns values and reports exceptions with next", async () => {
    expect((await ok("evaluate", "new Promise(r => setTimeout(() => r(6 * 7), 10))", "--await", "--session", S))["value"]).toBe(42);
    const bad = await tabcap("evaluate", "(() => { throw new Error('boom') })()", "--session", S);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatchObject({ code: "page" });
    expect(bad.error?.next).toBeTruthy();
  }, 60_000);

  test("screenshot of the background tab is a real PNG", async () => {
    const shot = await ok("screenshot", "--session", S);
    const path = s(shot["path"]);
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.length).toBeGreaterThan(1024);
    expect(pngInfo(bytes)?.width).toBe(typeof shot["width"] === "number" ? shot["width"] : -1);
    expect(pngIsUniform(bytes)).toBe(false);
    console.log(`screenshot: ${s(shot["width"])}x${s(shot["height"])}, focusEmulation=${s(shot["focusEmulation"])}`);
  }, 60_000);

  test("net list shows the XHR; net body path holds the served bytes", async () => {
    const list = await ok("net", "list", "--resource-types", "xhr", "--session", S);
    const reqs = Array.isArray(list["requests"]) ? list["requests"].filter(isRecord) : [];
    const items = reqs.find((r) => r["url"] === `${site.origin}/api/items`);
    expect(items).toMatchObject({ method: "GET", status: 200, mime: "application/json", outcome: "finished", type: "xhr" });
    const body = await ok("net", "body", s(items?.["id"]), "--session", S);
    expect(sha(s(body["path"]))).toBe(site.served.get("/api/items") ?? "missing");
    expect(s(body["textPreview"])).toContain("items-v1");
  }, 60_000);

  test("spike-2 race: fetch fired in a click handler right before navigating is captured (Fetch path)", async () => {
    const tree = s((await ok("snapshot", "--interactive", "--session", S))["tree"]);
    await ok("click", refOf(tree, /link "Go to page two" \[(e\d+)\]/), "--session", S);
    for (let i = 0; i < 50; i++) {
      const t = await ok("tab", "list", "--session", S);
      const tabs = Array.isArray(t["tabs"]) ? t["tabs"].filter(isRecord) : [];
      if (tabs.some((x) => x["url"] === `${site.origin}/two`)) break;
      await Bun.sleep(100);
    }
    await Bun.sleep(800); // past the recorder's navigation grace window
    expect(site.hits).toContain("POST /api/before-leave");
    const list = await ok("net", "list", "--filter", "before-leave", "--session", S);
    const reqs = Array.isArray(list["requests"]) ? list["requests"].filter(isRecord) : [];
    expect(reqs).toHaveLength(1);
    const body = await ok("net", "body", s(reqs[0]?.["id"]), "--session", S);
    expect(sha(s(body["path"]))).toBe(site.served.get("/api/before-leave") ?? "missing");
  }, 60_000);

  test("smoke page: navigate, net, snapshot, click, body hash", async () => {
    const C = ["--session", "smoke"];
    const n = await ok("navigate", `${smoke.origin}/`, ...C);
    expect(n).toMatchObject({ url: `${smoke.origin}/`, readyState: "complete" });
    await ok("net", "start", ...C);
    const tree = s((await ok("snapshot", "--interactive", ...C))["tree"]);
    await ok("click", refOf(tree, /button "加载列表" \[(e\d+)\]/), ...C);
    let out: unknown = "";
    for (let i = 0; i < 30 && out === ""; i++) {
      out = (await ok("evaluate", "document.getElementById('out').textContent", ...C))["value"];
      if (out === "") await Bun.sleep(100);
    }
    expect(out).toBe("苹果,香蕉,樱桃");
    const reqs = (await ok("net", "list", "--resource-types", "xhr,fetch", ...C))["requests"];
    const items = (Array.isArray(reqs) ? reqs.filter(isRecord) : []).find((r) => r["url"] === `${smoke.origin}/api/items`);
    const body = await ok("net", "body", s(items?.["id"]), ...C);
    expect(sha(s(body["path"]))).toBe(smoke.served.get("/api/items") ?? "missing");
  }, 60_000);

  test("readiness: page without scripts, page with a slow subresource", async () => {
    const C = ["--session", "smoke"];
    expect(await ok("navigate", `${smoke.origin}/plain`, ...C)).toMatchObject({ title: "plain", readyState: "complete" });
    const t0 = Date.now();
    expect(await ok("navigate", `${smoke.origin}/slow`, ...C)).toMatchObject({ title: "slow", readyState: "complete" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SLOW_MS - 100); // waited for the load event
    expect(smoke.hits).toContain("GET /slow.png");
  }, 60_000);

  test("a navigation that never gets its document times out and does not wedge the tab", async () => {
    const C = ["--session", "smoke"];
    const t0 = Date.now();
    const hung = await tabcap("navigate", `${smoke.origin}/hang`, "--timeout", "3000", ...C);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(hung.ok).toBe(false);
    expect(hung.error?.code).toBe("timeout");
    expect(hung.error?.message).toContain("pending page load was stopped");
    // every later command works again, quickly
    const t1 = Date.now();
    expect((await ok("evaluate", "location.pathname", ...C))["value"]).toBe("/slow");
    expect(s((await ok("snapshot", ...C))["tree"])).toContain("slow image");
    await ok("net", "stop", ...C);
    await ok("net", "start", ...C);
    await ok("net", "stop", ...C);
    expect(Date.now() - t1).toBeLessThan(10_000);
    await ok("session", "stop", "smoke");
  }, 60_000);

  test("tabs never lists other sessions; session stop closes owned tabs only", async () => {
    await ok("navigate", `${site.origin}/two`, "--session", "other");
    const mine = await ok("tab", "list", "--session", S);
    const theirs = await ok("tab", "list", "--session", "other");
    const ids = (d: Record<string, unknown>) => (Array.isArray(d["tabs"]) ? d["tabs"].filter(isRecord).map((x) => x["tab"]) : []);
    expect(ids(mine)).toEqual(["t1"]);
    expect(ids(theirs)).toEqual([s(ids(theirs)[0])]);
    expect(ids(theirs)).toHaveLength(1);
    const stop = await ok("session", "stop", S);
    expect(stop["closed"]).toEqual(["t1"]);
    bundle = s(stop["bundle"]);
    expect(ids(await ok("tab", "list", "--session", "other"))).toEqual(ids(theirs));
    const gone = await tabcap("snapshot", "--session", S);
    expect(gone.error).toMatchObject({ code: "no-tab" });
    const manifest: unknown = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    expect(isRecord(manifest) && typeof manifest["finished"] === "number").toBe(true);
    const events = readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
    expect(events.filter((e) => e["kind"] === "cmd").length).toBeGreaterThan(10);
    expect(events.some((e) => e["kind"] === "nav")).toBe(true);
  }, 60_000);

  test("the password appears in no output, log or bundle file", async () => {
    const files = [...walk(bundle), join(home, "config", "daemon.log")];
    for (const f of files) expect(readFileSync(f).includes(PASSWORD)).toBe(false);
    for (const o of outputs) expect(o.includes(PASSWORD)).toBe(false);
  });

  test("our Chrome for Testing never became the frontmost app", () => {
    if (front === null) return;
    const stolen = frontChanges.filter((c) => c.endsWith(`-> ${CFT_APP}`));
    if (stolen.length > 0) console.log(`frontmost-app changes during the suite:\n${frontChanges.join("\n")}`);
    expect(stolen).toEqual([]);
  });

  test("daemon stop leaves no browser process", async () => {
    await ok("daemon", "stop");
    let left = "";
    for (let i = 0; i < 50; i++) {
      // Only browsers of this test's TABCAP_HOME: other tabcap users on the machine may run their own.
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes("Chrome for Testing") && l.includes(home)).join("\n").trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
