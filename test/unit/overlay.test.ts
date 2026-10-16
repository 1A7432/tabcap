// 0.3-D overlay adapter, L0: detect and describe on recorded DOM fixtures
// (fixtures/dom/, captured from the overlay range pages in test/e2e/site.ts
// with test/e2e/capture-dom-fixtures.ts on Chrome for Testing 155). Expected
// values come from the scenario definition OVERLAY_EXPECTED next to the pages,
// not from running the adapter.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectAdapter, parseDigest } from "../../src/daemon/adapters/detect.ts";
import { adapterNamed, builtinAdapters } from "../../src/daemon/adapters/registry.ts";
import { coveredError } from "../../src/daemon/adapters/runtime.ts";
import { cutText, headerLines, overlayLine, parseOverlays, type Overlay } from "../../src/daemon/adapters/view.ts";
import { isRecord } from "../../src/shared/json.ts";
import { OVERLAY_EXPECTED, OVERLAY_PAGES, type OverlayPage } from "../e2e/site.ts";

type Fixture = { collected: { nodes: Array<{ tag: string; id: string; cls: string }> } & Record<string, unknown>; digest: unknown; globals: Record<string, boolean> };
const load = (page: string): Fixture => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "dom", `overlay-${page}.json`), "utf8")) as Fixture;

const overlay = adapterNamed("overlay");
if (overlay === undefined || overlay.script === null) throw new Error("overlay adapter missing");
// The page script is one JS expression; classify() is pure, so it runs here on recorded data.
const script: unknown = new Function(`"use strict"; return (\n${overlay.script}\n);`)();
const classify = (data: unknown): unknown => {
  if (!isRecord(script) || typeof script["classify"] !== "function") throw new Error("no classify()");
  return (script["classify"] as (d: unknown) => unknown).call(script, data);
};

/** describe() as the daemon sees it, with node indexes turned into the recorded element ids. */
function describeFixture(page: string): Overlay[] {
  const f = load(page);
  const idOf = (n: unknown) => (typeof n === "number" ? (f.collected.nodes[n]?.id ?? null) : null);
  return parseOverlays(classify(f.collected), idOf);
}

describe("overlay describe on recorded range pages", () => {
  for (const page of OVERLAY_PAGES) {
    test(`${page}: ${OVERLAY_EXPECTED[page].kind}`, () => {
      const want = OVERLAY_EXPECTED[page as OverlayPage];
      const got = describeFixture(page);
      expect(got.length).toBe(1);
      const o = got[0];
      expect(o).toMatchObject({ kind: want.kind, name: want.name, modal: want.modal });
      expect(o?.close.map((b) => b.ref)).toEqual(want.close);
      expect(o?.choices.map((b) => b.ref)).toEqual(want.choices);
      if (want.iframe !== undefined) expect(o?.iframe).toBe(want.iframe);
      if (want.modal) {
        expect(o?.coverage).toBeGreaterThanOrEqual(90);
        expect(o?.covers).toContain("form#f");
      } else expect(o?.coverage).toBeLessThan(90);
    });
  }

  test("negative: a full-viewport app shell and a hidden dialog are not overlays", () => {
    expect(describeFixture("shell")).toEqual([]);
  });

  test("the script never runs at load: unknown act ops answer an error, not an action", () => {
    if (!isRecord(script) || typeof script["act"] !== "function") throw new Error("no act()");
    expect((script["act"] as (op: string) => unknown).call(script, "close")).toEqual({ data: { error: "unknown op close" }, nodes: [] });
  });

  test("act buttons (0.4-I): a whole document's visible buttons, close ones by the dialog rules, the rest as choices", () => {
    if (!isRecord(script) || typeof script["act"] !== "function") throw new Error("no act()");
    const btn = (text: string, label: string, visible = true) => ({
      localName: "button",
      innerText: text,
      value: "",
      getAttribute: (n: string) => (n === "aria-label" ? label : null),
      getBoundingClientRect: () => ({ width: visible ? 24 : 0, height: visible ? 24 : 0 }),
    });
    // the s22 layer page's close button (site.ts: "×" with aria-label 关闭), a list entry, a hidden "x"
    const els = [btn("条目甲", ""), btn("×", "关闭"), btn("x", "", false)];
    const doc = { querySelectorAll: () => els, defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) } };
    const act = script["act"] as (op: string, el: unknown) => unknown;
    const r = act.call(script, "buttons", { ownerDocument: doc, isConnected: true });
    expect(isRecord(r) ? r["data"] : null).toEqual({ close: [{ n: 0, label: "×" }], choices: [{ n: 1, label: "条目甲" }] });
    expect(isRecord(r) ? r["nodes"] : null).toEqual([els[1], els[0]]);
    expect(act.call(script, "buttons", { ownerDocument: doc, isConnected: false })).toEqual({ data: { close: [], choices: [] }, nodes: [] });
  });
});

describe("overlay detect on recorded digests", () => {
  const run = (page: string) => {
    const f = load(page);
    return detectAdapter(overlay, { digest: parseDigest(f.digest), globals: f.globals, headers: null });
  };
  test("layer page: layer.js structure and global", () => {
    const d = run("layer");
    expect(d.evidence).toEqual(["layer.js classes (layui-layer*)", "iframe inside a layui-layer", "global layer (layer.js)"]);
    expect(d.confidence).toBe(0.94);
  });
  test("modal page: aria-modal + role=dialog", () => {
    expect(run("modal").evidence).toEqual(["aria-modal element", "role=dialog element"]);
  });
  test("mask page: no static signature (describe runs anyway: when=always)", () => {
    expect(run("mask")).toMatchObject({ confidence: 0, evidence: [] });
    expect(overlay.hooks.describe).toEqual({ when: "always" });
  });
  test("shell page: the hidden dialog's markup is detected; describe decides visibility", () => {
    expect(run("shell").evidence).toEqual(["aria-modal element", "role=dialog element"]);
  });
  test("builtins: overlay only (scope rule), category overlay, act ops covered and buttons (0.4-I: an iframe layer's inner document)", () => {
    expect(builtinAdapters().map((a) => [a.name, a.category, a.hooks.act?.ops])).toEqual([["overlay", "overlay", ["covered", "buttons"]]]);
  });
});

describe("header block and covered error", () => {
  const modal = describeFixture("modal");
  const consent = describeFixture("consent");
  const timeout = describeFixture("timeout");
  const mask = describeFixture("mask");

  test("header lines: overlays first, refs of close buttons, human decides consent", () => {
    const lines = headerLines({ overlays: [...modal, { ...(consent[0] as Overlay), id: "o2" }], detected: [], error: null });
    expect(lines).toEqual([
      'overlays  o1 dialog "系统提示" covers the whole page (main, h1, form#f) · close dlg1-close "×" / dlg1-later "稍后再说"',
      '          o2 consent "Cookie 提示" 14% of the viewport · the human decides: accept "接受全部" / reject "拒绝" / cset "设置"',
      "detected  none",
    ]);
    expect(overlayLine(timeout[0] as Overlay)).toBe('o1 timeout-prompt "会话即将超时" covers the whole page (main, h1, form#f) · tell the human: keep "继续使用" / quit "退出登录"');
    expect(overlayLine(mask[0] as Overlay)).toContain("· no close button");
  });

  test("header with nothing, with a failed check, with a detected library", () => {
    expect(headerLines({ overlays: [], detected: [], error: null })).toEqual(["overlays  none", "detected  none"]);
    expect(headerLines({ overlays: null, detected: null, error: "boom" })).toEqual(["overlays  ? (check failed: boom)", "detected  ?"]);
    expect(headerLines({ overlays: [], detected: [{ adapter: "fake-ui", category: "widget", confidence: 0.93, evidence: ["class fui-*", "global FakeUI"], unchecked: [] }, { adapter: "overlay", category: "overlay", confidence: 0.6, evidence: ["x"], unchecked: [] }], error: null })[1]).toBe("detected  fake-ui (widget) 0.93: class fui-*, global FakeUI");
  });

  test("covered error: code, close refs in next, never closes", () => {
    const o = modal[0] as Overlay;
    const e = coveredError("e3", { overlay: o, at: { x: 100, y: 40 }, offscreen: false });
    expect(e.code).toBe("covered");
    expect(e.message).toBe('ref e3 is covered by dialog "系统提示" at (100, 40)');
    expect(e.next).toContain('dlg1-close "×", dlg1-later "稍后再说"');
    expect(e.next).toContain("tabcap never closes overlays on its own");
    expect(e.extra["overlay"]).toBe(o);
    const c = coveredError("e9", { overlay: consent[0] as Overlay, at: null, offscreen: true });
    expect(c.next).toContain("the human decides");
    expect(coveredError("e1", { overlay: mask[0] as Overlay, at: null, offscreen: true }).next).toContain("no close button");
  });

  test("page data is untrusted: bad kinds and shapes are dropped, strings capped", () => {
    const got = parseOverlays({ overlays: [{ kind: "rm -rf" }, null, { kind: "mask", name: "x".repeat(500) + "\u0007", coverage: 900, close: "nope", n: -1 }] }, () => "e1");
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({ id: "o1", kind: "mask", coverage: 100, close: [], ref: "e1" });
    expect(got[0]?.name.length).toBe(60);
    expect(parseOverlays("garbage", () => null)).toEqual([]);
  });

  test("cutText keeps whole lines and never splits a surrogate pair", () => {
    expect(cutText("ab\ncd\nef", 6)).toEqual({ text: "ab\ncd", truncated: true });
    expect(cutText("😀😀", 3)).toEqual({ text: "😀", truncated: true });
    expect(cutText("short", 99)).toEqual({ text: "short", truncated: false });
  });
});
