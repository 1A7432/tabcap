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
import { SLOW_MS, startSmokeSite, startSite, type Site } from "./site.ts";
import { cliFor, okData, s, type Env } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const PASSWORD = "e2e-Pw-7f3k!Zq";
const S = "e2e";

let home = "";
let site: Site;
let smoke: Site;
const outputs: string[] = [];
// Focus rule: the user may switch apps while the suite runs, so the frontmost
// app is allowed to change; it must never become OUR Chrome for Testing, the
// browser process `browser start` reports (its pid). Another Chrome for Testing
// on the machine (a parallel run, a spike) does not count: the check keys on
// the frontmost app's pid, not its name. Every change of the frontmost app
// process is recorded for diagnostics and printed on failure.
type Front = { pid: number; name: string };
let front: Front | null = null;
let ourPid: number | null = null;
const frontChanges: Array<{ cmd: string; to: Front | null }> = [];
const frontLabel = (f: Front | null): string => (f === null ? "?" : `${f.name} (pid ${f.pid})`);

/** The frontmost macOS app process (System Events' unix id and name), or null when unknown / not permitted / not macOS. */
function frontmostProcess(): Front | null {
  if (process.platform !== "darwin") return null;
  const script = ['tell application "System Events"', "set p to first application process whose frontmost is true", "return (unix id of p as text) & linefeed & (name of p)", "end tell"];
  const p = Bun.spawnSync(["osascript", ...script.flatMap((l) => ["-e", l])], { timeout: 5000, stdout: "pipe", stderr: "pipe" });
  const [pid = "", ...name] = p.stdout.toString().trim().split("\n");
  const n = Number(pid);
  return p.exitCode === 0 && Number.isSafeInteger(n) && n > 0 ? { pid: n, name: name.join("\n") } : null;
}

const cli = cliFor(() => home, { onOutput: (out, stderr) => outputs.push(out, stderr) });

/** A run, with the frontmost app recorded after it (focus rule above). */
async function tabcap(...args: string[]): Promise<Env> {
  const e = await cli.tabcap(args);
  if (front !== null) {
    const now = frontmostProcess();
    if (now?.pid !== front.pid) frontChanges.push({ cmd: args.join(" "), to: now });
    if (now !== null) front = now;
  }
  return e;
}

const ok = async (...args: string[]): Promise<Record<string, unknown>> => okData(await tabcap(...args), args);

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
    // A TABCAP_HOME longer than sun_path allows (bug 10-15): the socket must fall back (Unix only).
    home = join(mkdtempSync(join(tmpdir(), "tabcap-e2e-")), "a-deliberately-long-directory-name-so-config-daemon-sock-exceeds-the-unix-socket-limit");
    site = startSite();
    smoke = startSmokeSite();
  });

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    smoke.stop();
    removeHome(home, import.meta.file);
    rmSync(join(home, ".."), { recursive: true, force: true });
  });

  test("daemon + browser start with --executable-path and --proxy none (no setup)", async () => {
    const d = await ok("daemon", "start");
    expect(d["running"]).toBe(true);
    if (process.platform === "win32") {
      // Windows listens on loopback TCP with a bearer token kept in config/daemon.json (no Unix socket, no POSIX modes).
      expect(d).toMatchObject({ listener: "tcp", socket: null, socketFallback: false });
      const st = await ok("daemon", "status");
      expect(st).toMatchObject({ running: true, listener: "tcp", socket: null, port: d["port"] });
      expect(typeof st["port"]).toBe("number");
      const info: unknown = JSON.parse(readFileSync(join(home, "config", "daemon.json"), "utf8"));
      expect(isRecord(info) && info["listener"] === "tcp" && info["port"] === st["port"]).toBe(true);
      expect(isRecord(info) && typeof info["token"] === "string" && /^[0-9a-f]{64}$/.test(info["token"])).toBe(true);
    } else {
      expect(Buffer.byteLength(join(home, "config", "daemon.sock"))).toBeGreaterThan(104);
      expect(d["socketFallback"]).toBe(true);
      expect(Buffer.byteLength(s(d["socket"]))).toBeLessThanOrEqual(103);
      expect((statSync(s(d["socket"])).mode & 0o777).toString(8)).toBe("600");
      expect(await ok("daemon", "status")).toMatchObject({ running: true, socket: d["socket"] });
    }
    const b = await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    expect(b).toMatchObject({ transport: "direct", channel: "pipe", proxy: "none", executableSource: "flag" });
    expect(typeof b["pid"]).toBe("number");
    ourPid = typeof b["pid"] === "number" ? b["pid"] : null;
    front = frontmostProcess();
    if (front === null) console.log("note: macOS frontmost-app query not available; focus checks skipped");
    // the frontmost app right after the launch is not our browser (null: query not available)
    expect(front?.pid ?? null).not.toBe(ourPid);
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
    const stolen = frontChanges.filter((c) => c.to !== null && c.to.pid === ourPid).map((c) => `${c.cmd} -> ${frontLabel(c.to)}`);
    if (stolen.length > 0) console.log(`frontmost-app changes during the suite (ours: pid ${ourPid ?? "?"}):\n${frontChanges.map((c) => `${c.cmd} -> ${frontLabel(c.to)}`).join("\n")}`);
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
