// L2 for 0.4-I frame-path refs (docs/05 s22; Chrome for Testing, the real
// daemon, the range in site.ts). Expected values come from the range, never
// from tabcap:
//   - frame urls, titles, the menu links, the form's labels, the table cells,
//     the layer's close label and the search answer are literals of
//     startFrameSite (S22_*);
//   - which origin each frame is on, and the document order of the frames,
//     are the page sources' (frameset menu, main; main: search iframe, then
//     the layer); same-origin / cross-origin is relative to the parent frame;
//   - the search request is the one the B server logged (`site.hits`);
//   - pointer positions are checked against what the page itself recorded
//     (clientX / clientY of its own pointer events and its own
//     getBoundingClientRect), not against tabcap's arithmetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { S22_CLOSE_LABEL, S22_LAYER_TITLE, S22_MENU_LINKS, S22_SEARCH_PREFIX, S22_TABLE_CELLS, S22_TITLES, startFrameSite, type FrameSite } from "./site.ts";
import { cliFor, rec, recs, s, until } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";

let home = "";
let site: FrameSite;

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ref on the tree line `- <role> "<name>" [<ref>]`; the ref must start with `prefix` (a frame path, or "" for any). */
function refOn(tree: string, role: string, name: string, prefix: string): string {
  const m = new RegExp(`- ${esc(role)} ${esc(JSON.stringify(name))} \\[(${esc(prefix)}e\\d+)\\]`).exec(tree);
  if (m === null || m[1] === undefined) throw new Error(`no ${role} "${name}" with a ${prefix || "root"} ref in:\n${tree}`);
  return m[1];
}

/** The f2/f1/f1 ref on the tree line that shows a table cell's text (its role is Chrome's; the text is the range's). */
function cellRef(tree: string, text: string): string {
  const line = tree.split("\n").find((l) => l.includes(JSON.stringify(text)) && l.includes("[f2/f1/f1/e"));
  return /\[(f2\/f1\/f1\/e\d+)\]/.exec(line ?? "")?.[1] ?? `(no cell ${text})`;
}

/** The first page-recorded pointer event of `type`, as [type, clientX, clientY, isTrusted, onTarget]. */
function eventOf(v: Record<string, unknown>, type: string, last = false): unknown[] | null {
  const list = (Array.isArray(v["pe"]) ? v["pe"] : []).filter((x: unknown): x is unknown[] => Array.isArray(x) && x[0] === type);
  return (last ? list.at(-1) : list[0]) ?? null;
}

describe.skipIf(!enabled)("tabcap 0.4-I L2 (docs/05 s22 frames: frame-path refs, snapshot --frames, actions in frames)", () => {
  const S = ["--session", "fr"];
  let bundle = "";
  const want = () => [
    { path: "f1", url: `${site.a}/s22/menu`, origin: "same-origin", depth: 1, title: S22_TITLES.menu },
    { path: "f2", url: `${site.a}/s22/main`, origin: "same-origin", depth: 1, title: S22_TITLES.main },
    { path: "f2/f1", url: `${site.b}/s22/form`, origin: "cross-origin", depth: 2, title: S22_TITLES.form },
    { path: "f2/f1/f1", url: `${site.b}/s22/table`, origin: "same-origin", depth: 3, title: S22_TITLES.table },
    { path: "f2/f2", url: `${site.b}/s22/modal`, origin: "cross-origin", depth: 2, title: S22_TITLES.modal },
  ];
  let q = "";
  let go = "";
  let cell = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4i-"));
    site = startFrameSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("navigate /s22 → snapshot: frames are header lines only (path, url, origin, depth, title), no element lines; outline has the same block", async () => {
    await ok("navigate", `${site.a}/s22`, ...S);
    await ok("wait", "--text", S22_TABLE_CELLS[1][0], ...S);
    const snap = await ok("snapshot", ...S);
    expect(snap["frames"]).toEqual(want());
    const tree = s(snap["tree"]);
    const lines = tree.split("\n");
    for (const f of want()) {
      const line = `${f.path}  ${f.url}  ${f.origin}  depth ${f.depth}  ${JSON.stringify(f.title)}`;
      expect(lines.some((l) => l.endsWith(`${"  ".repeat(f.depth - 1)}${line}`) && (l.startsWith("frames    ") || l.startsWith("          ")))).toBe(true);
    }
    // the root document's tree only: no frame-path ref anywhere but the overlay header's close button
    const body = lines.filter((l) => l.startsWith("- ") || l.startsWith("  "));
    expect(body.some((l) => /\[f\d/.test(l))).toBe(false);
    for (const link of S22_MENU_LINKS) expect(tree).not.toContain(link);
    const out = await ok("outline", ...S);
    expect(out["frames"]).toEqual(want());
    for (const f of want()) expect(s(out["outline"])).toContain(`${f.path}  ${f.url}  ${f.origin}  depth ${f.depth}`);
  }, 60_000);

  test("snapshot --frames: every frame expanded with frame-path refs (menu links f1/…, form f2/f1/…, cells f2/f1/f1/…)", async () => {
    const snap = await ok("snapshot", "--frames", ...S);
    const tree = s(snap["tree"]);
    for (const link of S22_MENU_LINKS) refOn(tree, "link", link, "f1/");
    q = refOn(tree, "textbox", "关键词", "f2/f1/");
    go = refOn(tree, "button", "查询", "f2/f1/");
    for (const row of S22_TABLE_CELLS) for (const c of row) expect(cellRef(tree, c)).toMatch(/^f2\/f1\/f1\/e\d+$/);
    cell = cellRef(tree, S22_TABLE_CELLS[1][0]);
    for (const f of want()) expect(tree).toContain(`frame ${f.path}  ${f.url}  ${f.origin}  depth ${f.depth}  ${JSON.stringify(f.title)}`);
    expect(snap["truncated"]).toBe(false);
  }, 60_000);

  test("fill f2/f1/e<q> abc + click f2/f1/e<go>: GET /s22/search?q=abc from the cross-origin frame; outputs and the cmd window carry frame f2/f1", async () => {
    const f = await ok("fill", q, "abc", ...S);
    expect([f["ref"], f["frame"], f["kind"]]).toEqual([q, "f2/f1", "input"]);
    const c = await ok("click", go, ...S);
    expect([c["ref"], c["frame"], c["trusted"]]).toEqual([go, "f2/f1", false]);
    await until("the B server's search hit", async () => site.hits, (h) => h.includes("B GET /s22/search?q=abc"));
    await ok("net", "wait", "--url", "/s22/search", ...S);
    // the page shows the answer (its own DOM, read in the frame through the ref's realm)
    const shown = await until("the search result in the frame", async () => s((await ok("evaluate", "--function", "(el) => el.ownerDocument.getElementById('result').textContent", "--args", JSON.stringify([{ ref: go }]), ...S))["value"]), (v) => v !== "");
    expect(shown).toBe(`${S22_SEARCH_PREFIX}abc`);
    const cmd = s(c["cmd"]);
    expect(cmd).toMatch(/^c-\d+$/);
    await ok("net", "stop", ...S);
    const r = BundleReader.open(bundle);
    const req = r.events.find((e) => e.kind === "request" && e["url"] === `${site.b}/s22/search?q=abc`);
    expect(req === undefined ? null : [req["method"], req["cmd"], rec(req["response"])["status"]]).toEqual(["GET", cmd, 200]);
    // from the OOPIF: the request came in on a child session, not the tab's
    expect(s(rec(req?.["cdp"])["sessionId"])).not.toBe("null");
    const tabDoc = r.events.find((e) => e.kind === "request" && e["url"] === `${site.a}/s22`);
    expect(rec(req?.["cdp"])["sessionId"]).not.toBe(rec(tabDoc?.["cdp"])["sessionId"]);
    const end = r.events.find((e) => e.kind === "cmd" && e["phase"] === "end" && e["ref"] === cmd);
    expect(rec(end?.["outputSummary"])["frame"]).toBe("f2/f1");
    const start = r.events.find((e) => e.kind === "cmd" && e["phase"] === "start" && e["id"] === cmd);
    expect(rec(start?.["input"])["ref"]).toBe(go);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
  }, 60_000);

  test("snapshot --frame f2/f1/f1: only that frame (the root and the other frames are header lines)", async () => {
    const snap = await ok("snapshot", "--frame", "f2/f1/f1", ...S);
    const tree = s(snap["tree"]);
    expect(tree).toContain(`frame f2/f1/f1  ${site.b}/s22/table  same-origin  depth 3  ${JSON.stringify(S22_TITLES.table)}`);
    for (const row of S22_TABLE_CELLS) for (const c of row) expect(tree).toContain(JSON.stringify(c));
    expect(tree).not.toContain('"查询"');
    expect(tree).not.toContain(`RootWebArea ${JSON.stringify(S22_TITLES.top)}`);
    expect(tree.split("\n").filter((l) => l.startsWith("frame ")).length).toBe(1);
    expect(snap["frame"]).toBe("f2/f1/f1");
    const bad = await tabcap(["snapshot", "--frame", "f9", ...S]);
    expect([bad.ok, bad.error?.["code"]]).toEqual([false, "not-found"]);
  }, 60_000);

  test("where f2/f1/f1/e<cell>: the frame document's response carries the cell text", async () => {
    // the frame documents were loaded before this bundle: load the table frame again inside it
    await ok("navigate", `${site.a}/s22`, ...S);
    await ok("wait", "--text", S22_TABLE_CELLS[1][0], ...S);
    await ok("net", "wait", "--url", "/s22/table", ...S);
    const tree = s((await ok("snapshot", "--frame", "f2/f1/f1", ...S))["tree"]);
    cell = cellRef(tree, S22_TABLE_CELLS[1][0]);
    expect(cell).toMatch(/^f2\/f1\/f1\/e\d+$/);
    const list = await ok("net", "list", "--filter", "/s22/table", ...S);
    const tableId = s(recs(list["requests"])[0]?.["id"]);
    expect(tableId).toMatch(/^r-\d+$/);
    const w = await ok("where", cell, ...S);
    expect(rec(w["query"])).toEqual({ input: cell, kind: "ref", ref: cell, text: S22_TABLE_CELLS[1][0] });
    expect(recs(w["candidates"])[0]?.["request"]).toBe(tableId);
  }, 60_000);

  test("trusted input into frames: fill --trusted and click --trusted in the OOPIF, hover on the nested cell; the pointer lands where the page says the element is", async () => {
    const tree = s((await ok("snapshot", "--frames", ...S))["tree"]);
    go = refOn(tree, "button", "查询", "f2/f1/");
    q = refOn(tree, "textbox", "关键词", "f2/f1/");
    cell = cellRef(tree, S22_TABLE_CELLS[1][0]);
    // trusted fill: focus in the OOPIF, Input.insertText through the tab's session
    const f = await ok("fill", q, "xyz", "--trusted", ...S);
    expect([f["frame"], f["trusted"], f["kind"]]).toEqual(["f2/f1", true, "input"]);
    // the page's own records: pointer events with their frame-local client coordinates, and the element's own box
    const arm =
      "(el) => { const w = el.ownerDocument.defaultView; w.__pe = []; for (const [t, k] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['click', 'click']]) el.ownerDocument.addEventListener(t, (e) => w.__pe.push([k, e.clientX, e.clientY, e.isTrusted, e.target === el || el.contains(e.target)]), true); return true; }";
    const read = "(el) => { const r = el.getBoundingClientRect(); return { pe: el.ownerDocument.defaultView.__pe, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }";
    await ok("evaluate", "--function", arm, "--args", JSON.stringify([{ ref: go }]), ...S);
    const c = await ok("click", go, "--trusted", ...S);
    expect([c["frame"], c["trusted"], rec(c["delivered"])["pointerdown"]]).toEqual(["f2/f1", true, true]);
    const g = rec((await ok("evaluate", "--function", read, "--args", JSON.stringify([{ ref: go }]), ...S))["value"]);
    console.log(`[v04i] click --trusted ${go}: page saw ${JSON.stringify(g["pe"])} (centre ${s(g["cx"])}, ${s(g["cy"])}); tabcap at ${JSON.stringify(c["at"])}`);
    const down = eventOf(g, "down");
    expect(down === null ? null : [down[3], down[4]]).toEqual([true, true]);
    expect(Math.abs(Number(down?.[1]) - Number(g["cx"]))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(down?.[2]) - Number(g["cy"]))).toBeLessThanOrEqual(1);
    await until("the trusted search hit", async () => site.hits, (hits) => hits.includes("B GET /s22/search?q=xyz"));

    await ok("evaluate", "--function", arm, "--args", JSON.stringify([{ ref: cell }]), ...S);
    const h = await ok("hover", cell, ...S);
    expect([h["frame"], h["trusted"]]).toEqual(["f2/f1/f1", true]);
    const v = rec((await ok("evaluate", "--function", read, "--args", JSON.stringify([{ ref: cell }]), ...S))["value"]);
    const last = eventOf(v, "move", true);
    expect(last === null ? null : [last[3], last[4]]).toEqual([true, true]);
    expect(Math.abs(Number(last?.[1]) - Number(v["cx"]))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(last?.[2]) - Number(v["cy"]))).toBeLessThanOrEqual(1);
  }, 60_000);

  test("iframe layer: the overlay header gives the close button inside the cross-origin layer iframe as f2/f2/e<n>; clicking it removes the overlay", async () => {
    const snap = await ok("snapshot", ...S);
    const overlays = recs(snap["overlays"]);
    expect(overlays.map((o) => [o["kind"], o["frame"], o["layerFrame"], o["name"]])).toEqual([["iframe-layer", "f2", "f2/f2", S22_LAYER_TITLE]]);
    const close = recs(overlays[0]?.["close"]);
    const ref = s(close[0]?.["ref"]);
    expect(ref).toMatch(/^f2\/f2\/e\d+$/);
    expect(s(snap["tree"])).toContain(`overlays  o1 iframe-layer "${S22_LAYER_TITLE}"`);
    expect(s(snap["tree"])).toContain(ref);
    // the ref is the layer document's button with the page's own label
    const label = await ok("evaluate", "--function", "(el) => el.getAttribute('aria-label')", "--args", JSON.stringify([{ ref }]), ...S);
    expect(label["value"]).toBe(S22_CLOSE_LABEL);
    const c = await ok("click", ref, ...S);
    expect(c["frame"]).toBe("f2/f2");
    const after = await until("the layer gone", () => ok("snapshot", ...S), (x) => recs(x["overlays"]).length === 0);
    expect(s(after["tree"]).startsWith("overlays  none")).toBe(true);
    expect(recs(after["frames"]).map((f) => f["path"])).toEqual(["f1", "f2", "f2/f1", "f2/f1/f1"]);
  }, 60_000);

  test("refs of a frame that navigated expire; a ref with the wrong frame path is refused", async () => {
    const tree = s((await ok("snapshot", "--frame", "f1", ...S))["tree"]);
    const link = refOn(tree, "link", S22_MENU_LINKS[0], "f1/");
    const wrong = link.replace(/^f1\//, "f2/");
    const e1 = await tabcap(["click", wrong, ...S]);
    expect([e1.ok, e1.error?.["code"]]).toEqual([false, "stale-ref"]);
    expect(s(e1.error?.["message"])).toContain(link);
    // the main frame navigates (a menu link targets it): refs minted in main are gone, the menu's stay
    const mainTree = s((await ok("snapshot", "--frame", "f2", ...S))["tree"]);
    const h1 = refOn(mainTree, "heading", "主区域", "f2/");
    await ok("click", link, ...S);
    await until("main navigated", async () => site.hits.filter((x) => x === "A GET /s22/main?p=1").length, (n) => n >= 1);
    await Bun.sleep(300);
    const e2 = await tabcap(["click", h1, ...S]);
    expect([e2.ok, e2.error?.["code"]]).toEqual([false, "stale-ref"]);
    expect(s(e2.error?.["message"])).toContain("frame f2");
    expect((await tabcap(["click", link, ...S])).ok).toBe(true);
  }, 60_000);
});
