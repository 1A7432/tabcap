// L2 for 0.6-J click landing (Chrome for Testing, the real daemon, the range
// in site.ts, docs/05 s56). Expected values come from the range, never from
// tabcap:
//   - ids and texts are literals of startClickTargetSite (S56_*);
//   - which handler ran, and whether its event was trusted, is what the page
//     itself wrote down (window.__s56);
//   - where a trusted click hit is the page's own getBoundingClientRect of
//     the element it should land on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S56_LAY_TEXT, S56_MENU_TEXT, S56_TRUST_TEXT, startClickTargetSite, type Site } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let home = "";
let site: Site;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

const value = async (expr: string, S: string[]): Promise<unknown> => (await ok("evaluate", expr, ...S))["value"];
const log = async (S: string[]): Promise<string[]> => {
  const v = await value("JSON.stringify(window.__s56)", S);
  const parsed: unknown = JSON.parse(s(v));
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

/** The snapshot line of a control with this role and name (and its ref). */
function lineOf(tree: string, role: string, name: string): { line: string; ref: string } {
  const line = tree.split("\n").find((l) => l.includes(`- ${role} ${JSON.stringify(name)} [`)) ?? "";
  const m = /\[(e\d+)\]/.exec(line);
  if (m === null || m[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return { line, ref: m[1] };
}

describe.skipIf(!enabled)("tabcap 0.6-J L2 (docs/05 s56: a click lands on the element that listens)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6j-"));
    site = startClickTargetSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("snapshot --interactive marks the two widgets whose handler sits on a child with landing=\"child\", not the trusted-only one", async () => {
    const S = ["--session", "j1"];
    await ok("navigate", `${site.origin}/s56`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    expect(lineOf(tree, "button", S56_LAY_TEXT).line).toContain('landing="child"');
    expect(lineOf(tree, "menuitem", S56_MENU_TEXT).line).toContain('landing="child"');
    expect(lineOf(tree, "button", S56_TRUST_TEXT).line).not.toContain("landing=");
    // the default snapshot does not inspect
    expect(s((await ok("snapshot", ...S))["tree"])).not.toContain("landing=");
  }, 60_000);

  test("layui (handler on the inner span[lay-event]) and antd / Element (root delegation, cursor:pointer child): the DOM click lands on the child and the handler runs", async () => {
    const S = ["--session", "j2"];
    await ok("navigate", `${site.origin}/s56`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const lay = lineOf(tree, "button", S56_LAY_TEXT).ref;
    const menu = lineOf(tree, "menuitem", S56_MENU_TEXT).ref;

    const a = await ok("click", lay, ...S);
    expect(a).toMatchObject({ ref: lay, trusted: false, effect: "dom" });
    expect(a["target"]).toEqual({ ref: lay, landedOn: { tag: "span", text: S56_LAY_TEXT, selector: "#s56-lay-span" }, reason: "descendant-listener" });
    expect(await log(S)).toEqual(["lay:false"]);

    const b = await ok("click", menu, ...S);
    expect(b).toMatchObject({ ref: menu, trusted: false, effect: "dom" });
    expect(b["target"]).toEqual({ ref: menu, landedOn: { tag: "span", text: S56_MENU_TEXT, selector: "#s56-menu-title" }, reason: "descendant-listener" });
    expect(await log(S)).toEqual(["lay:false", "menu:false"]);
  }, 60_000);

  test("trusted-only handler on the element itself: the DOM click stays on it (effect none, --trusted note); --trusted runs the handler", async () => {
    const S = ["--session", "j3"];
    await ok("navigate", `${site.origin}/s56`, ...S);
    const trust = lineOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", S56_TRUST_TEXT).ref;
    const none = await tabcap(["click", trust, ...S]);
    expect(none.exit).toBe(0);
    expect(none.data).toMatchObject({ ref: trust, trusted: false, effect: "none" });
    expect(none.data["target"]).toBeUndefined();
    expect(none.data["candidates"]).toBeUndefined();
    expect(s(none.data["note"])).toContain("--trusted");
    expect(await log(S)).toEqual([]);
    const t = await ok("click", trust, "--trusted", ...S);
    expect(t).toMatchObject({ ref: trust, trusted: true, eventShape: "full" });
    expect(t["target"]).toBeUndefined();
    expect(await log(S)).toEqual(["trust:true"]);
  }, 60_000);

  test("--trusted uses the same landing: the pointer ends on the inner span (left of the 300 px button's centre)", async () => {
    const S = ["--session", "j4"];
    await ok("navigate", `${site.origin}/s56`, ...S);
    const lay = lineOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", S56_LAY_TEXT).ref;
    const r = await ok("click", lay, "--trusted", ...S);
    expect(r).toMatchObject({ ref: lay, trusted: true, eventShape: "full" });
    expect(rec(r["target"])).toMatchObject({ ref: lay, landedOn: { tag: "span", selector: "#s56-lay-span" }, reason: "descendant-listener" });
    expect(await log(S)).toEqual(["lay:true"]);
    const box = rec(JSON.parse(s(await value("JSON.stringify(document.getElementById('s56-lay-span').getBoundingClientRect())", S))));
    const at = rec(r["at"]);
    const x = Number(at["x"]);
    const y = Number(at["y"]);
    expect(x).toBeGreaterThanOrEqual(Number(box["left"]));
    expect(x).toBeLessThanOrEqual(Number(box["right"]));
    expect(y).toBeGreaterThanOrEqual(Number(box["top"]));
    expect(y).toBeLessThanOrEqual(Number(box["bottom"]));
  }, 60_000);
});
