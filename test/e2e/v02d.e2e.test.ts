// L2 for 0.2-D (field report fixes), pages mirroring docs/05 §5 s17–s20 in
// test/e2e/site.ts: popup focus and ownership, --tab / tab use, stale refs after
// a re-render, clickable-first find, port-scan noise in net list, net show,
// needs-await, the net wait look-back, help / --version, §16 rulings.
// Expected values come from the local site (served bytes, TCP probes of the
// scanned ports) and the macOS frontmost-app query, never from tabcap itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontmostApp, isChromeApp } from "../../src/daemon/transport/direct/launcher.ts";
import { isRecord } from "../../src/shared/json.ts";
import { DATA_IMAGES, POST_PAD, SCAN_PORTS, SIGN_HEADER, SIGN_VALUE, startFieldSite, type Site } from "./site.ts";

// POSIX file modes do not exist on Windows (files get the profile's default ACL, docs/08): mode checks skip there.
const POSIX_MODES = process.platform !== "win32";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = "field";

let home = "";
let site: Site;

type Env = { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string; next: string }; raw: string; exit: number };

const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(...args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  const e = env["error"];
  const err = isRecord(e) ? e : null;
  return {
    ok: env["ok"],
    data: isRecord(env["data"]) ? env["data"] : {},
    ...(err === null ? {} : { error: { code: s(err["code"]), message: s(err["message"]), next: s(err["next"]) } }),
    raw: out,
    exit,
  };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(...args);
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

/** Ground truth for s20: which of the scanned ports really refuse connections here. */
async function closedPort(port: number): Promise<boolean> {
  try {
    const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    sock.end();
    return false;
  } catch {
    return true;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...walk(p));
  }
  return out;
}

describe.skipIf(!enabled)("tabcap 0.2-D L2 (field report)", () => {
  let bundle = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e2d-"));
    site = startFieldSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", "--session", S))["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("--version and two-level help", async () => {
    const v = await tabcap("--version");
    expect(v.exit).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.data["tool"]).toBe("tabcap");
    const h = await tabcap("net", "list", "--help");
    expect(h.exit).toBe(0);
    expect(h.raw.startsWith("Usage: tabcap net list")).toBe(true);
    const g = await tabcap("net", "--help");
    expect(g.exit).toBe(0);
    expect(g.raw).toContain("tabcap net show <id>");
  });

  test("s17 popup: foreground handed back, owned, operable with --tab / tab select, closed by session stop", async () => {
    const P = ["--session", "pop"];
    await ok("navigate", `${site.origin}/popup`, ...P);
    const before = frontmostApp();
    const hit = recs((await ok("find", "打开弹窗", ...P))["hits"])[0];
    expect(hit?.["clickable"]).toBeTruthy();
    await ok("click", s(hit?.["clickable"]), ...P);
    const tabs = await until("the popup tab", () => ok("tab", "list", ...P), (d) => recs(d["tabs"]).length === 2);
    const pop = recs(tabs["tabs"])[1];
    expect(pop).toMatchObject({ tab: "t2", owned: true, reason: "popup", opener: "t1", current: false });
    expect(tabs["current"]).toBe("t1");
    // the daemon watches ~2.5 s after the window appears; then the front must be back
    await until("the focus hand-back to finish", () => ok("browser", "status"), (d) => Number(rec(d["popupFocus"])["windows"]) >= 1, 5000);
    await Bun.sleep(3000);
    // The user may switch apps meanwhile: assert only that our Chrome for Testing is not in front.
    if (before !== null && !isChromeApp(before)) {
      // Compare by pid with THIS daemon's browser: another Chrome for Testing may be running in parallel.
      const status = await ok("browser", "status");
      const ourPid = typeof status["pid"] === "number" ? status["pid"] : null;
      expect(ourPid).not.toBeNull();
      const after = frontmostApp();
      if (after?.pid === ourPid) console.log(`frontmost before the popup: ${before.name}; after: ${after?.name} (pid ${ourPid})`);
      if (after !== null) expect(after.pid).not.toBe(ourPid);
      const pf = rec(status["popupFocus"]);
      expect(pf).toMatchObject({ windows: 1, failed: 0 });
    } else console.log(`note: frontmost app is ${before?.name ?? "unknown"}; focus check skipped`);
    // operate the popup with --tab, then make it current
    const snap = await ok("snapshot", "--tab", "t2", ...P);
    expect(snap["tab"]).toBe("t2");
    expect(s(snap["tree"])).toContain("弹窗目标文字");
    const pb = recs((await ok("find", "弹窗按钮", "--tab", "t2", ...P))["hits"])[0];
    await ok("click", s(pb?.["clickable"]), "--tab", "t2", ...P);
    expect((await ok("evaluate", "window.__pb", "--tab", "t2", ...P))["value"]).toBe(1);
    expect((await tabcap("snapshot", "--tab", "t9", ...P)).error?.code).toBe("no-tab");
    expect(await ok("tab", "select", "t2", ...P)).toMatchObject({ current: "t2", opener: "t1" });
    expect((await ok("evaluate", "document.title", ...P))["value"]).toBe("popup target");
    await ok("tab", "select", "t1", ...P);
    const stop = await ok("session", "stop", "pop");
    expect(stop["closed"]).toEqual(["t1", "t2"]);
    expect(stop["released"]).toEqual([]);
    const st = await ok("browser", "status");
    expect(Number(st["tabs"])).toBe(0); // the popup window went with the session (the recording session has no tab yet)
  }, 60_000);

  test("s18 re-render: an old ref is stale-ref (no fake success); a fresh one clicks", async () => {
    await ok("navigate", `${site.origin}/rerender`, "--session", S);
    const hit = recs((await ok("find", "编辑乙", "--session", S))["hits"])[0];
    const old = s(hit?.["clickable"]);
    const r0 = Number((await ok("evaluate", "window.__renders", "--session", S))["value"]);
    await until("a re-render", () => ok("evaluate", "window.__renders", "--session", S), (d) => Number(d["value"]) > r0, 5000);
    const stale = await tabcap("click", old, "--session", S);
    expect(stale.error?.code).toBe("stale-ref");
    expect(stale.error?.next.startsWith("run snapshot again")).toBe(true);
    expect((await tabcap("click", old, "--trusted", "--session", S)).error?.code).toBe("stale-ref");
    expect((await ok("evaluate", "window.__clicks", "--session", S))["value"]).toBe(0);
    await ok("evaluate", "window.__stop()", "--session", S);
    const fresh = recs((await ok("find", "编辑乙", "--session", S))["hits"])[0];
    expect(fresh?.["clickable"]).not.toBe(old);
    await ok("click", s(fresh?.["clickable"]), "--session", S);
    expect((await ok("evaluate", "window.__clicks", "--session", S))["value"]).toBe(1);
  }, 60_000);

  test("s19 custom checkbox and div role=none: clickable hit first, clicking the span toggles the hidden input", async () => {
    await ok("navigate", `${site.origin}/checkbox`, "--session", S);
    const f = await ok("find", "记住密码", "--session", S);
    const hits = recs(f["hits"]);
    expect(hits.map((h) => [h["name"], h["clickable"] !== null])).toEqual([
      ["记住密码", true],
      ["提示：请勾选记住密码以便下次自动登录", false],
    ]);
    expect(["cursor", "listener", "tag"]).toContain(s(hits[0]?.["clickableBy"]));
    await ok("click", s(hits[0]?.["clickable"]), "--session", S);
    expect((await ok("evaluate", "document.getElementById('remember').checked", "--session", S))["value"]).toBe(true);
    const login = recs((await ok("find", "登录", "--session", S))["hits"]);
    expect(login[0]?.["clickable"]).toBeTruthy();
    expect(login.findIndex((h) => h["role"] === "heading")).toBeGreaterThan(0);
    await ok("click", s(login[0]?.["clickable"]), "--session", S);
    expect((await ok("evaluate", "window.__login", "--session", S))["value"]).toBe(1);
  }, 60_000);

  test("s20 port-scan noise: hidden by default with counts, --failed shows them, paging never drops rows", async () => {
    const closed = (await Promise.all(SCAN_PORTS.map(closedPort))).filter((x) => x).length;
    const nav = await ok("navigate", `${site.origin}/noise`, "--session", S);
    const c = s(nav["cmd"]);
    expect(c).toMatch(/^c-\d+$/);
    await ok("wait", "--text", "ok 1", "--session", S);
    const failed = await until("all scans recorded", () => ok("net", "list", "--failed", "--since", c, "--session", S), (d) => Number(d["matched"]) >= closed, 20_000);
    expect(failed["matched"]).toBe(closed);
    expect(recs(failed["requests"]).every((r) => r["outcome"] === "failed")).toBe(true);
    const data = await until("data: images recorded", () => ok("net", "list", "--since", c, "--session", S), (d) => Number(rec(d["hidden"])["data"]) >= DATA_IMAGES, 10_000);
    expect(data["hidden"]).toEqual({ failed: closed, data: DATA_IMAGES });
    const rows = recs(data["requests"]);
    expect(rows.some((r) => s(r["url"]).startsWith("data:") || r["outcome"] === "failed")).toBe(false);
    expect(rows.map((r) => s(r["url"]))).toEqual(expect.arrayContaining([`${site.origin}/noise`, `${site.origin}/api/ok`]));
    expect(data["shown"]).toBe(data["matched"]);
    expect(Number(data["total"])).toBeGreaterThanOrEqual(Number(data["matched"]) + closed + DATA_IMAGES);
    // paging over the failed ones
    const seen: string[] = [];
    let pageIdx: unknown = 0;
    for (let page = 0; pageIdx !== null && page < 10; page++) {
      const p = await ok("net", "list", "--failed", "--since", c, "--page-size", "25", "--page-idx", s(pageIdx), "--session", S);
      seen.push(...recs(p["requests"]).map((r) => s(r["id"])));
      pageIdx = p["nextPageIdx"];
    }
    // the default page holds 30 (0.5-C), so compare with every failed row
    const everyFailed = await ok("net", "list", "--failed", "--since", c, "--page-size", "0", "--session", S);
    expect(recs(failed["requests"]).length).toBe(Math.min(closed, 30));
    expect(seen).toEqual(recs(everyFailed["requests"]).map((r) => s(r["id"])));
    expect(seen).toHaveLength(closed);
    const all = await ok("net", "list", "--all", "--since", c, "--session", S);
    expect(all["hidden"]).toEqual({ failed: 0, data: 0 });
    expect(all["matched"]).toBe(Number(data["matched"]) + closed + DATA_IMAGES);
  }, 90_000);

  test("net show: postData over 2 KB as path + head, signature header, body path, timing, initiator", async () => {
    const nav = await ok("navigate", `${site.origin}/post`, "--session", S);
    await ok("wait", "--text", "posted", "--session", S);
    const post = recs((await ok("net", "list", "--method", "POST", "--since", s(nav["cmd"]), "--session", S))["requests"]);
    expect(post).toHaveLength(1);
    const d = await ok("net", "show", s(post[0]?.["id"]), "--session", S);
    expect(d).toMatchObject({ method: "POST", url: `${site.origin}/api/submit`, status: 200, outcome: "finished", tab: "t1", type: "fetch", actor: "ai" });
    expect(s(d["nav"])).toMatch(/^n-\d+$/);
    const req = rec(d["request"]);
    expect(rec(req["headers"])[SIGN_HEADER]).toBe(SIGN_VALUE);
    const pd = rec(req["postData"]);
    expect(pd["truncated"]).toBe(true);
    expect(s(pd["head"])).toHaveLength(2048);
    expect(Number(pd["size"])).toBeGreaterThan(POST_PAD);
    expect(sha(s(pd["path"]))).toBe(site.served.get("post:/api/submit") ?? "missing");
    const body = rec(rec(d["response"])["body"]);
    expect(sha(s(body["path"]))).toBe(site.served.get("/api/submit") ?? "missing");
    expect(typeof rec(d["timing"])["total"]).toBe("number");
    expect(rec(d["initiator"])["type"]).toBe("script");
    expect(s(rec(d["initiator"])["at"])).toContain(`${site.origin}/post:`);
    expect((await tabcap("net", "show", "r-999999", "--session", S)).error?.code).toBe("not-found");
  }, 60_000);

  test("net show: WebSocket handshake and frame", async () => {
    await ok("navigate", `${site.origin}/ws-page`, "--session", S);
    await ok("wait", "--text", "ws pong:ping-field", "--session", S);
    const frames = recs((await ok("net", "list", "--kind", "ws", "--filter", site.origin.replace("http://", "ws://"), "--session", S))["frames"]);
    const recv = frames.find((f) => f["direction"] === "recv");
    const f = await ok("net", "show", s(recv?.["id"]), "--session", S);
    expect(f).toMatchObject({ kind: "ws", direction: "recv", opcode: 1, phase: "frame" });
    const payload = rec(f["payload"]);
    expect(payload["textHead"]).toBe("pong:ping-field");
    expect(readFileSync(s(payload["path"]), "utf8")).toBe("pong:ping-field");
    const hs = await ok("net", "show", s(f["ws"]), "--session", S);
    expect(hs).toMatchObject({ type: "websocket", status: 101, frames: 2 });
  }, 60_000);

  test("evaluate returning a Promise without --await is needs-await", async () => {
    const e = await tabcap("evaluate", "fetch('/api/ok').then((r) => r.status)", "--session", S);
    expect(e.error).toMatchObject({ code: "needs-await", next: "re-run with --await" });
    expect((await ok("evaluate", "fetch('/api/ok').then((r) => r.status)", "--await", "--session", S))["value"]).toBe(200);
    expect((await ok("evaluate", "({a: [1, 2]})", "--session", S))["value"]).toEqual({ a: [1, 2] });
  }, 60_000);

  test("net wait after click → wait --text looks back to the click (docs/04 §16)", async () => {
    await ok("navigate", `${site.origin}/lookback`, "--session", S);
    const hit = recs((await ok("find", "查询", "--session", S))["hits"])[0];
    const click = await ok("click", s(hit?.["clickable"]), "--session", S);
    await ok("wait", "--text", "look-done", "--session", S);
    await ok("snapshot", "--session", S); // read-only: does not move the look-back point
    const nw = await ok("net", "wait", "--url", "/api/look", "--session", S);
    expect(nw).toMatchObject({ status: 200, alreadyFinished: true, lookBack: { from: "action", action: "click", cmd: click["cmd"] } });
    expect(sha(s(nw["path"]))).toBe(site.served.get("/api/look") ?? "missing");
    const fresh = await tabcap("net", "wait", "--url", "/api/look", "--fresh", "--timeout", "700", "--session", S);
    expect(fresh.error?.code).toBe("timeout");
    expect(fresh.error?.next).toContain(`earlier finished matches before that point: ${s(nw["id"])}`);
    expect(await ok("net", "wait", "--url", "/api/look", "--since", "start", "--session", S)).toMatchObject({ id: nw["id"], lookBack: { from: "start" } });
  }, 60_000);

  test("docs/04 §16: actor ai everywhere, bundle files 0600 in 0700 dirs", async () => {
    // A page request outside every command window. Since 0.3-F commands end only after the DOM
    // settled (post-action wait), so such requests no longer happen by chance: make one.
    await ok("evaluate", "setTimeout(() => fetch('/api/ok'), 300); 1", "--session", S);
    await Bun.sleep(1500);
    await ok("net", "stop", "--session", S);
    const evs = readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
    expect(evs.filter((e) => e["kind"] === "request").length).toBeGreaterThan(80);
    expect(evs.filter((e) => e["actor"] === "human")).toEqual([]);
    expect(evs.some((e) => e["kind"] === "request" && e["cmd"] === null && e["actor"] === "ai")).toBe(true);
    if (POSIX_MODES) {
      expect(statSync(bundle).mode & 0o777).toBe(0o700);
      for (const p of walk(bundle).filter((x) => !x.includes("/exports/"))) expect([p, statSync(p).mode & 0o777]).toEqual([p, statSync(p).isDirectory() ? 0o700 : 0o600]);
    }
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
