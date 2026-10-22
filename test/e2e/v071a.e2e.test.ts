// L2 for 0.7.1-A human take-over (docs/04 §37, docs/05 s62): the passive
// listener in tabcap's isolated world on the session's tab, tabcap's own CDP
// input excluded by its input windows, the session's `waiting` with reason
// `human-takeover`, `handoff continue`, and the bundle's `handoff` / `action`
// events. A test cannot make real OS input, so the "human" is the test-only
// daemon action `e2e.human-input` (TABCAP_E2E_HUMAN=1): one CDP press that
// bypasses the input windows. Oracle: the s62 page's own log of what reached
// its handlers (isTrusted), its synthetic-event counter, and the server's
// ping count; tabcap's answers are only checked against those and docs/04 §37.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S62_BTN, S62_PING, startTakeoverSite, type TakeoverSite } from "./site.ts";
import { okData, rec, recs, s, tabcap as run, type CliOptions, type Env } from "./_cli.ts";
import { daemonRequest, removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";

let site: TakeoverSite;
const homes: string[] = [];

const HUMAN: CliOptions = { env: { TABCAP_E2E_HUMAN: "1" }, nonJson: "exit" };
const tabcap = (home: string, args: string[]): Promise<Env> => run(home, args, HUMAN);
const ok = async (home: string, ...args: string[]): Promise<Record<string, unknown>> => okData(await tabcap(home, args), args);

/** The test-only daemon action, straight to the daemon's socket or Windows port (no CLI command exists for it). */
async function inject(home: string, session: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const env = await daemonRequest(home, "/command", { action: "e2e.human-input", args, session });
  if (env["ok"] !== true) throw new Error(`e2e.human-input failed: ${JSON.stringify(env)}`);
  return rec(env["data"]);
}

async function until<T>(what: string, fn: () => Promise<T | null>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const refOf = (tree: string, re: RegExp): string => {
  const m = re.exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${re} in ${tree.slice(0, 400)}`);
  return m[1];
};

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => rec(JSON.parse(l)));
}

const manifest = (bundle: string): Record<string, unknown> => rec(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));

async function startHome(config: Record<string, unknown> | null): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "tabcap-e2e071a-"));
  homes.push(home);
  if (config !== null) {
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify(config), { mode: 0o600 });
  }
  await ok(home, "daemon", "start");
  return home;
}

describe.skipIf(!enabled)("tabcap 0.7.1-A L2 (human take-over on s62)", () => {
  let A = "";
  const S = ["--session", "a"];
  let btn = "";
  let ping = "";
  let bundle = "";

  beforeAll(async () => {
    site = startTakeoverSite();
    A = await startHome(null);
    const b = await ok(A, "browser", "start", "--proxy", "none", "--executable-path", CHROME);
    expect(b["detectTakeover"]).toBe(true);
  }, 60_000);

  afterAll(async () => {
    for (const h of homes) await tabcap(h, ["daemon", "stop"]).catch(() => null);
    site.stop();
    for (const h of homes) removeHome(h, import.meta.file);
  });

  test("(1) tabcap's own click --trusted, type --trusted, press-key and hover do not trigger; the page's synthetic events do not either", async () => {
    bundle = s((await ok(A, "net", "start", ...S))["bundle"]);
    await ok(A, "navigate", `${site.origin}/s62`, ...S);
    await Bun.sleep(1500); // the page's untrusted rounds run meanwhile
    const tree = s((await ok(A, "snapshot", "--interactive", ...S))["tree"]);
    btn = refOf(tree, new RegExp(`button "${S62_BTN}" \\[(e\\d+)\\]`));
    ping = refOf(tree, new RegExp(`button "${S62_PING}" \\[(e\\d+)\\]`));
    const box = refOf(tree, /textbox "s62 text" \[(e\d+)\]/);
    expect(await ok(A, "click", btn, "--trusted", ...S)).toMatchObject({ trusted: true });
    await ok(A, "click", box, "--trusted", ...S);
    await ok(A, "type", "ab", "--trusted", ...S);
    await ok(A, "press-key", "Enter", ...S);
    await ok(A, "hover", btn, ...S);
    await Bun.sleep(1000);
    const hs = await ok(A, "handoff", "status", ...S);
    expect(hs).toMatchObject({ session: "a", state: "running", handoff: null });
    const page = rec(await ok(A, "evaluate", "({log: window.__s62, synth: window.__s62synth})", ...S));
    const v = rec(page["value"]);
    console.log(`[v071a] page log ${JSON.stringify(v["log"])}, synthetic rounds ${s(v["synth"])}`);
    // tabcap's own input reached the page as trusted events (so only the windows kept it out)
    const log = Array.isArray(v["log"]) ? v["log"] : [];
    expect(log).toContain("btn:true");
    expect(log).toContain("key:true");
    expect(log).not.toContain("btn:false");
    expect(Number(v["synth"])).toBeGreaterThanOrEqual(1);
    const st = await ok(A, "status");
    expect(rec(recs(st["sessions"]).find((x) => x["session"] === "a"))).toMatchObject({ state: "running", reason: null });
  }, 90_000);

  test("(2) one trusted input outside every window: waiting/human-takeover; acting commands refused; handoff continue resumes; the bundle holds it", async () => {
    // 0.8.2: the ping button's centre is measured here, so a failure late in (1) (CI PR #29: a
    // trusted click on a slow machine) does not send the human's press to (0, 0) as well.
    const at = rec(rec(await ok(A, "evaluate", "(() => { const r = document.getElementById('s62-ping').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()", ...S))["value"]);
    const pingAt = { x: Math.round(Number(at["x"])), y: Math.round(Number(at["y"])) };
    expect(pingAt.x > 0 && pingAt.y > 0).toBe(true);
    expect(await inject(A, "a")).toMatchObject({ injected: "pointerdown", tab: "t1" });
    const hs = await until("the take-over", async () => {
      const h = await ok(A, "handoff", "status", ...S);
      return h["state"] === "waiting" ? h : null;
    });
    const h = rec(hs["handoff"]);
    expect(h).toMatchObject({ reason: "human-takeover", screenshot: null, request: null, tab: "t1", url: `${site.origin}/s62` });
    expect(rec(h["input"])["event"]).toBe("pointerdown");
    const refused = await tabcap(A, ["click", btn, ...S]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({ code: "waiting", reason: "human-takeover" });
    expect(s(refused.error?.["next"])).toContain("tabcap handoff continue");
    const snap = await ok(A, "snapshot", ...S);
    expect(rec(snap["handoff"])).toMatchObject({ state: "waiting", reason: "human-takeover" });
    const st = await ok(A, "status");
    expect(s(st["next"])).toContain("tabcap handoff continue --session a");
    const text = await tabcap(A, ["status", "--text"]);
    console.log(`[v071a] status --text while taken over:\n${text.raw.trimEnd()}`);
    expect(text.raw).toContain("WAITING human-takeover");
    // the human goes on: a press on the ping button (recorded, no second hand-off). The page
    // reports one event per kind per 250 ms (docs/04 §37), so this press comes a little later.
    expect(site.pings()).toBe(0);
    await Bun.sleep(400);
    await inject(A, "a", { x: pingAt.x, y: pingAt.y });
    await until("the human's ping", async () => (site.pings() === 1 ? true : null));
    // net list is read-only: it works while the session waits
    await until("the ping in the recording", async () => ((await tabcap(A, ["net", "list", ...S])).raw.includes("/s62/ping") ? true : null));
    const cont = await ok(A, "handoff", "continue", ...S);
    expect(cont).toMatchObject({ state: "resumed", reason: "human-takeover" });
    expect(await ok(A, "click", ping, "--trusted", ...S)).toMatchObject({ trusted: true });
    await until("the AI's ping", async () => (site.pings() === 2 ? true : null));
    await Bun.sleep(500);
    expect((await ok(A, "handoff", "status", ...S))["state"]).toBe("resumed");
    await ok(A, "net", "stop", ...S);

    expect(manifest(bundle)["mode"]).toMatchObject({ humanRecorder: true });
    const evs = events(bundle);
    const handoffs = evs.filter((e) => e["kind"] === "handoff");
    expect(handoffs.map((e) => [e["state"], e["reason"], e["actor"]])).toEqual([
      ["waiting", "human-takeover", "system"],
      ["resumed", "human-takeover", "system"],
    ]);
    const [waitEv, resumeEv] = handoffs;
    expect(waitEv).toMatchObject({ request: null, screenshot: null, url: `${site.origin}/s62`, tab: "t1", timeoutMs: null });
    expect(rec(waitEv?.["input"])["event"]).toBe("pointerdown");
    expect(resumeEv).toMatchObject({ by: "human" });
    const actions = evs.filter((e) => e["kind"] === "action");
    expect(actions.map((e) => [e["op"], e["event"], e["actor"], e["cmd"], e["trusted"], e["value"]])).toEqual([
      ["input", "pointerdown", "human", null, true, null],
      ["input", "pointerdown", "human", null, true, null],
    ]);
    const pingsRec = evs.filter((e) => e["kind"] === "request" && s(e["url"]).endsWith("/s62/ping"));
    expect(pingsRec.map((e) => e["actor"])).toEqual(["human", "ai"]);
    const from = Number(waitEv?.["seq"]);
    const to = Number(resumeEv?.["seq"]);
    const human = evs.filter((e) => e["actor"] === "human");
    expect(human.length).toBeGreaterThanOrEqual(3);
    for (const e of human) {
      expect(Number(e["seq"])).toBeGreaterThan(from);
      expect(Number(e["seq"])).toBeLessThan(to);
    }
  }, 90_000);

  test("(3) handoff.detectTakeover: false: the same injected input does not trigger", async () => {
    const B = await startHome({ handoff: { detectTakeover: false } });
    try {
      const b = await ok(B, "browser", "start", "--proxy", "none", "--executable-path", CHROME);
      expect(b["detectTakeover"]).toBe(false);
      const dir = s((await ok(B, "net", "start", "--session", "b"))["bundle"]);
      await ok(B, "navigate", `${site.origin}/s62`, "--session", "b");
      await inject(B, "b");
      await inject(B, "b", { event: "keydown" });
      await Bun.sleep(1500);
      expect(await ok(B, "handoff", "status", "--session", "b")).toMatchObject({ state: "running", handoff: null });
      await ok(B, "net", "stop", "--session", "b");
      expect(manifest(dir)["mode"]).toMatchObject({ humanRecorder: false });
      const evs = events(dir);
      expect(evs.filter((e) => e["kind"] === "handoff" || e["kind"] === "action")).toEqual([]);
      expect(evs.filter((e) => e["actor"] === "human")).toEqual([]);
    } finally {
      await tabcap(B, ["daemon", "stop"]).catch(() => null);
    }
  }, 90_000);
});
