// L2 for 0.2-A: WebSocket frames, console, wait primitives, docs/04 §14 rulings.
// Same harness as tabcap.e2e.test.ts: CLI envelopes only, temp TABCAP_HOME, --proxy none.
// Expected hashes come from the bytes the local site really served / saw.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { SLOW_API_BODY, SLOW_API_MS, WS_BINARY, WS_MARKER, startLabSite, type Site } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = "v02";

let home = "";
let site: Site & { ws: string[] };

type Env = { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string; next: string } };

const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const shaBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(...args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
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

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
}

describe.skipIf(!enabled)("tabcap 0.2-A L2", () => {
  let bundle = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e02-"));
    site = startLabSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", "--session", S))["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("websocket: handshake request + one ws event per frame, payload hashes match", async () => {
    await ok("navigate", `${site.origin}/ws-page`, "--session", S);
    for (let i = 0; i < 50; i++) {
      const v = (await ok("evaluate", "document.getElementById('st').textContent", "--session", S))["value"];
      if (v === "ws-done") break;
      await Bun.sleep(100);
    }
    await Bun.sleep(300);
    const reqs = recs((await ok("net", "list", "--resource-types", "websocket", "--session", S))["requests"]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ type: "websocket", status: 101, url: `ws://${site.origin.slice("http://".length)}/ws` });
    const hs = s(reqs[0]?.["id"]);
    const list = await ok("net", "list", "--kind", "ws", "--session", S);
    const frames = recs(list["frames"]).filter((f) => f["ws"] === hs && f["phase"] === "frame");
    const sent = frames.filter((f) => f["direction"] === "send");
    const recv = frames.filter((f) => f["direction"] === "recv");
    expect(sent.map((f) => f["opcode"])).toEqual([1, 1, 2]);
    expect(recv.map((f) => f["opcode"])).toEqual([1, 1, 2, 1]);
    expect(sent.map((f) => f["bytes"])).toEqual([7, 7, WS_BINARY.length]);
    const sentHashes: string[] = [];
    for (const f of sent) sentHashes.push(sha(s((await ok("net", "body", s(f["id"]), "--session", S))["path"])));
    const recvHashes: string[] = [];
    for (const f of recv) recvHashes.push(sha(s((await ok("net", "body", s(f["id"]), "--session", S))["path"])));
    expect(sentHashes).toEqual([1, 2, 3].map((n) => site.served.get(`ws:recv:${n}`) ?? "missing"));
    expect(recvHashes).toEqual([1, 2, 3, 4].map((n) => site.served.get(`ws:send:${n}`) ?? "missing"));
    expect(sentHashes[2]).toBe(shaBytes(WS_BINARY));
    const push = await ok("net", "body", s(recv[3]?.["id"]), "--session", S);
    expect(s(push["textPreview"])).toContain(WS_MARKER);
  }, 60_000);

  async function consoleUntil(session: string, pred: (es: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
    let es: Record<string, unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      es = recs((await ok("console", "list", "--include-stack-traces", "--session", session))["entries"]);
      if (pred(es)) break;
      await Bun.sleep(100);
    }
    return es;
  }
  const hasException = (es: Record<string, unknown>[]) => es.some((e) => e["source"] === "exception");

  test("console: log / warn / error and an uncaught exception with a stack (recording session)", async () => {
    await ok("navigate", `${site.origin}/console-page`, "--session", S);
    const es = await consoleUntil(S, hasException);
    const page = `${site.origin}/console-page`;
    const log = es.find((e) => s(e["text"]).startsWith("log-marker"));
    expect(log).toMatchObject({ level: "log", source: "console", text: "log-marker 42 {a: 1}" });
    expect(s(log?.["at"])).toMatch(new RegExp(`^${page.replace(/[.?]/g, "\\$&")}:\\d+:\\d+$`));
    expect(es.find((e) => e["text"] === "warn-marker")).toMatchObject({ level: "warn", source: "console" });
    expect(es.find((e) => e["text"] === "error-marker")).toMatchObject({ level: "error", source: "console" });
    const ex = es.find((e) => e["source"] === "exception");
    expect(ex).toMatchObject({ level: "error" });
    expect(s(ex?.["text"])).toContain("uncaught-marker");
    expect(s(ex?.["stack"])).toContain("explode");
    // --level filters to that level and above; --limit keeps the newest
    const warn = recs((await ok("console", "list", "--level", "warn", "--session", S))["entries"]);
    expect(warn.every((e) => e["level"] === "warn" || e["level"] === "error")).toBe(true);
    expect(warn.some((e) => e["text"] === "warn-marker")).toBe(true);
    expect(recs((await ok("console", "list", "--limit", "1", "--session", S))["entries"])).toHaveLength(1);
    const bad = await tabcap("console", "list", "--level", "loud", "--session", S);
    expect(bad.error).toMatchObject({ code: "usage" });
  }, 60_000);

  test("console: buffered without recording; --clear empties it", async () => {
    const P = ["--session", "plain"];
    await ok("navigate", `${site.origin}/console-page`, ...P);
    const es = await consoleUntil("plain", hasException);
    expect(es.map((e) => e["level"])).toEqual(expect.arrayContaining(["log", "warn", "error"]));
    expect(hasException(es)).toBe(true);
    const cleared = await ok("console", "list", "--clear", ...P);
    expect(cleared["cleared"]).toBe(true);
    expect(recs((await ok("console", "list", ...P))["entries"])).toHaveLength(0);
    await ok("session", "stop", "plain");
  }, 60_000);

  test("wait --text / --selector / --url / --fn succeed and say what matched", async () => {
    await ok("navigate", `${site.origin}/slow-page`, "--session", S);
    const w = await ok("wait", "--text", "slow-done", "--session", S);
    expect(w).toMatchObject({ matched: "text", text: "slow-done" });
    expect(s(w["context"])).toContain("slow-done 7");
    expect(await ok("wait", "--selector", "#out", "--session", S)).toMatchObject({ matched: "selector", tag: "p", visible: true });
    expect(await ok("wait", "--url", "/slow-page", "--session", S)).toMatchObject({ matched: "url", urlContains: "/slow-page" });
    expect(await ok("wait", "--fn", "document.title === 'slow api' && document.title", "--session", S)).toMatchObject({ matched: "fn", value: "slow api" });
  }, 60_000);

  test("wait timeouts and usage errors have the envelope shape", async () => {
    const t0 = Date.now();
    const miss = await tabcap("wait", "--text", "never-there-9f2", "--timeout", "800", "--session", S);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(miss.ok).toBe(false);
    expect(miss.error?.code).toBe("timeout");
    expect(miss.error?.message).toContain("800 ms");
    expect(miss.error?.next).toContain("Still outstanding");
    expect(miss.error?.next).toContain("never-there-9f2");
    const sel = await tabcap("wait", "--selector", "#nope", "--timeout", "300", "--session", S);
    expect(sel.error?.code).toBe("timeout");
    expect((await tabcap("wait", "--fn", "1 +", "--session", S)).error?.code).toBe("usage");
    expect((await tabcap("wait", "--selector", "##", "--session", S)).error?.code).toBe("usage");
    expect((await tabcap("wait", "--text", "a", "--url", "b", "--session", S)).error?.code).toBe("usage");
    expect((await tabcap("wait", "--session", S)).error?.code).toBe("usage");
    const nw = await tabcap("net", "wait", "--url", "/never-requested", "--timeout", "500", "--session", S);
    expect(nw.error?.code).toBe("timeout");
    expect(nw.error?.next).toContain("/never-requested");
  }, 60_000);

  test("wait --idle waits for the slow request; net wait returns its stored body", async () => {
    await ok("navigate", `${site.origin}/slow-page`, "--session", S);
    const idle = await ok("wait", "--idle", "300", "--session", S);
    expect(idle).toMatchObject({ matched: "idle", idleMs: 300, tracking: "recording" });
    expect(Number(idle["waitedMs"])).toBeGreaterThanOrEqual(SLOW_API_MS - 600);
    // the request finished during the previous command: net wait still finds it
    const nw = await ok("net", "wait", "--url", "/slow-api", "--method", "GET", "--session", S);
    expect(nw).toMatchObject({ method: "GET", status: 200, url: `${site.origin}/slow-api`, alreadyFinished: true });
    expect(sha(s(nw["path"]))).toBe(site.served.get("/slow-api") ?? "missing");
    // and one that is still in flight when net wait starts
    await ok("navigate", `${site.origin}/slow-page`, "--session", S);
    const nw2 = await ok("net", "wait", "--url", "/slow-api", "--session", S);
    expect(nw2["alreadyFinished"]).toBe(false);
    expect(nw2["id"]).not.toBe(nw["id"]);
    expect(Number(nw2["bytes"])).toBe(new TextEncoder().encode(SLOW_API_BODY).length);
    expect(sha(s(nw2["path"]))).toBe(site.served.get("/slow-api") ?? "missing");
  }, 60_000);

  test("wait --idle without recording tracks requests from the start of the wait", async () => {
    const P = ["--session", "idle"];
    await ok("navigate", `${site.origin}/slow-page`, ...P);
    expect(await ok("wait", "--idle", "200", ...P)).toMatchObject({ matched: "idle", tracking: "since-wait" });
    expect((await tabcap("net", "wait", "--url", "/slow-api", ...P)).error?.code).toBe("not-found");
    await ok("session", "stop", "idle");
  }, 60_000);

  test("docs/04 §14 rulings: response never null, cmd start/end pairs, navigate nav is a bundle n-<seq>", async () => {
    // a request cut by a navigation before any response: the page's /slow-api fetch
    await ok("navigate", `${site.origin}/slow-page`, "--session", S);
    const nav = await ok("navigate", `${site.origin}/console-page`, "--session", S);
    expect(s(nav["nav"])).toMatch(/^n-\d+$/);
    // net wait must not pick the cut request (no body)
    const st = await ok("daemon", "status");
    const recs0 = recs(st["recordings"]);
    expect(recs0.find((r) => r["session"] === S)).toMatchObject({ bundle, recording: true });
    const counts = recs0.find((r) => r["session"] === S)?.["counts"];
    expect(isRecord(counts) && Number(counts["requests"]) > 0 && Number(counts["wsFrames"]) === 7 && Number(counts["console"]) > 0).toBe(true);
    await Bun.sleep(800); // past the recorder's navigation grace window
    const stop = await ok("net", "stop", "--session", S);
    expect(stop["bundle"]).toBe(bundle);
    const text = readFileSync(join(bundle, "events.jsonl"), "utf8");
    expect(text).not.toContain('"response":null');
    const evs = events(bundle);
    // the cut request: response object with status null and a reason
    const cut = evs.filter((e) => e["kind"] === "request" && s(e["url"]).endsWith("/slow-api") && e["outcome"] === "incomplete");
    expect(cut.length).toBeGreaterThanOrEqual(1);
    expect(cut[cut.length - 1]?.["response"]).toEqual({ status: null, headers: {}, body: null, bodyMissing: { reason: "navigated", detail: null } });
    // cmd: every start has exactly one end, ids are c-<own seq>
    const starts = evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "start");
    const ends = evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "end");
    expect(starts.length).toBeGreaterThan(10);
    for (const st0 of starts) {
      expect(st0["id"]).toBe(`c-${s(st0["seq"])}`);
      expect(st0["cmd"]).toBe(st0["id"]);
      expect(ends.filter((e) => e["ref"] === st0["id"])).toHaveLength(1);
    }
    expect(ends.length).toBe(starts.length);
    // the navigate command's window: its nav event carries cmd = that start id, and the returned nav exists
    const navEv = evs.find((e) => e["kind"] === "nav" && e["nav"] === nav["nav"]);
    expect(navEv).toMatchObject({ seq: Number(s(nav["nav"]).slice(2)), url: `${site.origin}/console-page`, actor: "ai" });
    const navStart = starts.filter((e) => isRecord(e["input"]) && e["input"]["action"] === "navigate" && e["input"]["url"] === `${site.origin}/console-page` && Number(e["seq"]) < Number(navEv?.["seq"])).pop();
    const owning = starts.filter((e) => Number(e["seq"]) < Number(navEv?.["seq"])).pop();
    expect(navEv?.["cmd"]).toBe(s(owning?.["id"]));
    expect(owning?.["id"]).toBe(navStart?.["id"]);
    // events inside a window carry it; ws / console events made it into the bundle
    expect(evs.filter((e) => e["kind"] === "ws" && e["phase"] === "frame")).toHaveLength(7);
    expect(evs.some((e) => e["kind"] === "console" && e["source"] === "exception" && s(e["stack"]).includes("explode"))).toBe(true);
    expect(evs.filter((e) => e["kind"] === "request" && e["type"] === "websocket")).toHaveLength(1);
    // not recording any more: navigate returns nav null
    expect((await ok("navigate", `${site.origin}/console-page`, "--session", S))["nav"]).toBeNull();
    expect(recs((await ok("daemon", "status"))["recordings"])).toHaveLength(0);
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
