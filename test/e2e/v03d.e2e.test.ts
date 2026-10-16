// L2 for 0.3-D: the overlay adapter on the overlay range pages
// (test/e2e/site.ts, six forms + an app-shell negative + a popup page).
// Expected values are the scenario definition OVERLAY_EXPECTED and what the
// pages record themselves (window.__hits counts real clicks per element id),
// never tabcap's own output. tabcap must name the overlay, give close-button
// refs, refuse click / fill on covered targets with `covered`, and never close
// anything itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { OVERLAY_EXPECTED, OVERLAY_PAGES, startOverlaySite, type OverlayPage, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "ov"];

let home = "";
let site: Site;

type Env = { ok: boolean; data: Record<string, unknown>; error?: Record<string, unknown>; raw: string };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(...args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), ...(isRecord(env["error"]) ? { error: env["error"] } : {}), raw: out };
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

const hits = async (): Promise<Record<string, unknown>> => rec((await ok("evaluate", "window.__hits", ...S))["value"]);
/** The clickable ref `find` gives for a named control (refs are per DOM node, so the same node has the same ref). */
async function refOf(text: string): Promise<string> {
  const h = recs((await ok("find", text, ...S))["hits"]).find((x) => x["clickable"] !== null);
  if (h === undefined) throw new Error(`no clickable hit for ${text}`);
  return s(h["clickable"]);
}
const TARGET_TEXT: Record<string, string> = { submit: "提交", under: "下方按钮", "footer-btn": "下载报表" };
const BUTTON_TEXT: Record<string, string> = { "dlg1-later": "稍后再说", "dlg1-ok": "去修改", "dlg2-close": "关闭", keep: "继续使用", quit: "退出登录", accept: "接受全部", reject: "拒绝", cset: "设置" };

describe.skipIf(!enabled)("tabcap 0.3-D L2 (overlay adapter)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3d-"));
    site = startOverlaySite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  for (const page of OVERLAY_PAGES) {
    test(`${page}: outline / snapshot name the overlay; covered click is refused with its close refs; nothing is closed by tabcap`, async () => {
      const want = OVERLAY_EXPECTED[page as OverlayPage];
      await ok("navigate", `${site.origin}/ov/${page}`, ...S);
      const out = await ok("outline", ...S);
      const overlays = recs(out["overlays"]);
      expect(overlays.length).toBe(1);
      const o = overlays[0] ?? {};
      expect(o).toMatchObject({ id: "o1", kind: want.kind, name: want.name, modal: want.modal });
      if (want.iframe !== undefined) expect(o["iframe"]).toBe(want.iframe);
      const close = recs(o["close"]).map((b) => s(b["ref"]));
      const choices = recs(o["choices"]).map((b) => s(b["ref"]));
      expect(close.length).toBe(want.close.length);
      expect(choices.length).toBe(want.choices.length);
      expect(s(out["outline"])).toContain(`overlays  o1 ${want.kind}`);
      // named buttons: the refs are the ones find gives for the expected elements
      for (const [i, id] of want.close.entries()) if (BUTTON_TEXT[id] !== undefined) expect(close[i]).toBe(await refOf(BUTTON_TEXT[id] ?? ""));
      for (const [i, id] of want.choices.entries()) if (BUTTON_TEXT[id] !== undefined) expect(choices[i]).toBe(await refOf(BUTTON_TEXT[id] ?? ""));
      // snapshot carries the same header first, within --max-chars
      const snap = await ok("snapshot", "--interactive", ...S);
      expect(s(snap["tree"]).startsWith(`overlays  o1 ${want.kind}`)).toBe(true);
      expect(recs(snap["overlays"]).map((x) => x["kind"])).toEqual([want.kind]);
      // the covered target: refused, nothing clicked, next names the close refs
      const target = await refOf(TARGET_TEXT[want.covered] ?? "");
      for (const extra of [[], ["--trusted"]]) {
        const c = await tabcap("click", target, ...extra, ...S);
        expect(c.ok).toBe(false);
        expect(c.error?.["code"]).toBe("covered");
        expect(rec(c.error?.["overlay"])).toMatchObject({ kind: want.kind, name: want.name });
        expect(recs(rec(c.error?.["overlay"])["close"]).map((b) => s(b["ref"]))).toEqual(close);
        for (const r of close) expect(s(c.error?.["next"])).toContain(r);
        if (want.kind === "consent" || want.kind === "timeout-prompt") for (const r of choices) expect(s(c.error?.["next"])).toContain(r);
      }
      expect((await hits())[want.covered]).toBeUndefined();
      expect((await ok("outline", ...S))["overlays"]).toHaveLength(1); // still there: tabcap closed nothing
      // a target outside the overlay stays clickable
      if (want.free !== null) {
        const free = await ok("click", await refOf(TARGET_TEXT[want.free] ?? ""), ...S);
        expect(free["overlayCheck"]).toBe("clear");
        expect((await hits())[want.free]).toBe(1);
      }
      // the agent (or, for consent / timeout, the human) closes it; then the target clicks
      const closer = close[0] ?? (want.kind === "timeout-prompt" ? choices[0] : want.kind === "consent" ? choices[0] : null);
      if (closer !== null && closer !== undefined) {
        await ok("click", closer, ...S);
        const closedId = want.close[0] ?? want.choices[0] ?? "";
        expect((await hits())[closedId]).toBe(1);
      } else await ok("evaluate", "document.getElementById('loading').remove()", ...S); // mask: the page finishes loading
      expect((await ok("outline", ...S))["overlays"]).toEqual([]);
      expect(await ok("click", target, ...S)).toMatchObject({ overlayCheck: "clear" });
      expect((await hits())[want.covered]).toBe(1);
    }, 60_000);
  }

  test("fill on a covered field is refused too", async () => {
    await ok("navigate", `${site.origin}/ov/modal`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const q = /textbox "搜索" \[(e\d+)\]/.exec(tree)?.[1] ?? "";
    const f = await tabcap("fill", q, "abc", ...S);
    expect(f.error?.["code"]).toBe("covered");
    expect((await ok("evaluate", "document.getElementById('q').value", ...S))["value"]).toBe("");
  }, 60_000);

  test("negative: app shell + hidden dialog → overlays none, click works", async () => {
    await ok("navigate", `${site.origin}/ov/shell`, ...S);
    const out = await ok("outline", ...S);
    expect(out["overlays"]).toEqual([]);
    expect(s(out["outline"])).toContain("overlays  none");
    expect(await ok("click", await refOf("提交"), ...S)).toMatchObject({ overlayCheck: "clear" });
    expect((await hits())["submit"]).toBe(1);
  }, 60_000);

  test("detected: layer.js structure and global on the layer page; header within --max-chars", async () => {
    await ok("navigate", `${site.origin}/ov/layer`, ...S);
    const snap = await ok("snapshot", "--max-chars", "1000", ...S);
    const det = recs(snap["detected"]).find((d) => d["adapter"] === "overlay");
    expect(det?.["evidence"]).toEqual(["layer.js classes (layui-layer*)", "iframe inside a layui-layer", "global layer (layer.js)"]);
    expect(s(snap["tree"]).length).toBeLessThanOrEqual(1000);
    expect(s(snap["tree"])).toContain("detected  none"); // overlay findings live in overlays; no widget / framework adapter is installed
    const o = await ok("outline", "--max-chars", "500", ...S);
    expect(s(o["outline"]).length).toBeLessThanOrEqual(500);
  }, 60_000);

  test("outline lists the popup under popups with its tab id", async () => {
    const P = ["--session", "ovp"];
    await ok("navigate", `${site.origin}/ov/popup`, ...P);
    const opener = s((await ok("tab", "list", ...P))["current"]);
    const open = recs((await ok("find", "打开参照窗口", ...P))["hits"])[0];
    await ok("click", s(open?.["clickable"]), ...P);
    const tabs = await until("the popup", () => ok("tab", "list", ...P), (d) => recs(d["tabs"]).length === 2);
    const pop = recs(tabs["tabs"]).find((t) => t["reason"] === "popup");
    const id = s(pop?.["tab"]);
    const out = await until("the popup title", () => ok("outline", ...P), (d) => s(d["outline"]).includes("参照选择"));
    expect(recs(out["popups"])).toEqual([{ tab: id, url: `${site.origin}/ov/popup-target`, title: "参照选择", opener }]);
    expect(s(out["outline"])).toContain(`popups    ${id} "参照选择" ${site.origin}/ov/popup-target (opener ${opener})`);
    await ok("session", "stop", "ovp");
  }, 60_000);
});
