// L2 for 0.7.5-B `tabcap handoff wait --until-*` (docs/04 §39, docs/05 s65):
// a take-over handoff ends itself when a condition set by the agent becomes
// true after the handoff began (the URL after login, a cookie the login
// sets), refuses a condition that already held, and still returns when the
// human continues elsewhere. The "human" is the test-only daemon action
// `e2e.human-input` (TABCAP_E2E_HUMAN=1), pressing the S65_GO button at the
// viewport's top-left. Oracle: the range's log of /s65/done hits and the
// cookie it set; tabcap's answers are only checked against those and §39.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { startHandoffSite, type HandoffSite } from "./site.ts";
import { daemonRequest } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "a"];

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

let site: HandoffSite;
let home = "";

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME, TABCAP_E2E_HUMAN: "1" },
    stdin: "ignore",
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

/** The "human": one press at the viewport's (4, 4), where S65_GO is. */
async function press(): Promise<void> {
  const env = await daemonRequest(home, "/command", { action: "e2e.human-input", args: {}, session: "a" });
  if (env["ok"] !== true) throw new Error(`e2e.human-input failed: ${JSON.stringify(env)}`);
}

async function waitingTakeover(): Promise<void> {
  const end = Date.now() + 4000;
  for (;;) {
    const st = await ok("handoff", "status", ...S);
    if (st["state"] === "waiting" && rec(st["handoff"])["reason"] === "human-takeover") return;
    if (Date.now() > end) throw new Error(`no take-over: ${JSON.stringify(st)}`);
    await Bun.sleep(100);
  }
}

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => rec(JSON.parse(l)));
}

describe.skipIf(!enabled)("tabcap 0.7.5-B L2 (handoff wait --until-* on s65)", () => {
  let bundle = "";

  beforeAll(async () => {
    site = startHandoffSite();
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e075b-"));
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "a");
    bundle = s((await ok("net", "start", ...S))["bundle"]);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    if (process.env["V075B_KEEP"] === undefined) rmSync(home, { recursive: true, force: true });
    else console.log(`[v075b] kept ${home}`);
  });

  test("1. --until-url: the URL after the login ends the take-over by itself", async () => {
    await ok("navigate", `${site.origin}/s65/login?k=a`, ...S);
    await press();
    await waitingTakeover();
    const r = await ok("handoff", "wait", "--until-url", "/s65/home", "--timeout", "15000", ...S);
    expect(r).toMatchObject({ session: "a", state: "resumed", by: "condition", condition: { kind: "url", value: "/s65/home" } });
    expect(s(rec(r["condition"])["url"])).toContain("/s65/home?k=a");
    expect(site.done).toEqual(["a"]);
    // the next command carries the one-time resume notice (as after handoff continue), the one after it nothing
    expect(rec((await ok("snapshot", ...S))["handoff"])).toMatchObject({ state: "resumed", resumedBy: "condition", condition: { kind: "url", value: "/s65/home" } });
    expect("handoff" in (await ok("snapshot", ...S))).toBe(false);
  }, 30_000);

  test("2. --until-cookie after the human already finished: the baseline (no s65_b when it began) still tells", async () => {
    await ok("navigate", `${site.origin}/s65/login?k=b`, ...S);
    await press();
    await waitingTakeover();
    await Bun.sleep(4000); // the login's redirect has happened: the tab is on /s65/home?k=b
    const r = await tabcap(["handoff", "wait", "--until-cookie", "s65_b", "--timeout", "5000", ...S]);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ state: "resumed", by: "condition", condition: { kind: "cookie", value: "s65_b" } });
    expect(r.raw).not.toContain("s65_b=1");
    expect(site.done).toEqual(["a", "b"]);
  }, 30_000);

  test("3. a condition that already holds is refused at once; 4. the human continuing elsewhere ends a wait", async () => {
    await ok("navigate", `${site.origin}/s65/login?k=c&stay=1`, ...S);
    await press();
    await waitingTakeover();
    const t0 = Date.now();
    const already = await tabcap(["handoff", "wait", "--until-text", "S65_LOGIN_PAGE", "--timeout", "10000", ...S]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(already.error).toMatchObject({ code: "waiting", state: "waiting" });
    expect(s(already.error?.["message"])).toContain("already");
    expect((await ok("handoff", "status", ...S))["state"]).toBe("waiting");
    const pending = tabcap(["handoff", "wait", "--until-url", "/never", "--timeout", "15000", ...S]);
    await Bun.sleep(1000);
    await ok("handoff", "continue", ...S);
    const r = await pending;
    expect(r.data).toMatchObject({ state: "resumed", by: "human" });
    expect(site.done).toEqual(["a", "b"]);
  }, 40_000);

  test("the bundle: handoff resumed by condition (url), condition (cookie), human; no cookie value in any handoff event", async () => {
    await ok("net", "stop", ...S);
    const hs = events(bundle).filter((e) => e["kind"] === "handoff");
    expect(hs.filter((e) => e["state"] === "resumed").map((e) => [e["by"], rec(e["condition"])["kind"] ?? null])).toEqual([
      ["condition", "url"],
      ["condition", "cookie"],
      ["human", null],
    ]);
    expect(hs.filter((e) => e["state"] === "waiting").map((e) => e["reason"])).toEqual(["human-takeover", "human-takeover", "human-takeover"]);
    expect(JSON.stringify(hs)).not.toContain("s65_b=1");
  }, 30_000);
});
