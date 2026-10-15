import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAxTree, findInTree, interactiveOnly, renderAxTree, textInputsWithValue, type AxNode } from "../../src/daemon/browser/ax.ts";
import { RefTable, type DocIdentity } from "../../src/daemon/browser/refs.ts";

// Oracle: real Accessibility.getFullAXTree results captured from test/e2e/site.ts
// with test/e2e/capture-ax-fixtures.ts (Chrome for Testing 155).
type Fixture = { passwordBackendIds: number[]; ax: unknown };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "ax", `${name}.json`), "utf8")) as Fixture;
const home = load("home");
const filled = load("home-filled");

function tree(f: Fixture): AxNode {
  const t = buildAxTree(f.ax, new Set(f.passwordBackendIds));
  if (t === null) throw new Error("empty tree");
  return t;
}

const DOC: DocIdentity = { frameId: "F1", loaderId: "L1", url: "http://127.0.0.1:PORT/" };

describe("AX filter (fixtures/ax)", () => {
  test("drops InlineTextBox / ListMarker and hoists generic wrappers", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const text = renderAxTree(tree(home), (id) => refs.refFor(id), 60_000).text;
    expect(text).not.toContain("InlineTextBox");
    expect(text).not.toContain("ListMarker");
    expect(text).not.toMatch(/- (generic|none)\b/);
    // button "Add item" sits in two nameless divs: hoisted directly under main;
    // a listitem whose only child is its text collapses into the text
    expect(text).toMatch(/^ {2}- main \[e\d+\]\n {4}- button "Add item" \[e\d+\]$/m);
    // the button's own label text is not repeated as a child
    expect(text).not.toMatch(/button "Add item".*\n\s+- text "Add item"/);
  });

  test("password values never rendered; other values are", () => {
    const refs = new RefTable();
    const text = renderAxTree(tree(filled), (id) => refs.refFor(id), 60_000).text;
    expect(text).toMatch(/textbox "Password" \[e\d+\] \[password\]$/m);
    expect(text).toContain('textbox "Name"');
    expect(text).toContain('value="bob"');
    expect(text).not.toContain("•");
    expect(text).not.toContain("fixture-pass-1");
    expect(text).toMatch(/checkbox "I agree" \[e\d+\] checked/); // states are bare words (chrome-devtools-mcp SnapshotFormatter convention)
  });

  test("password candidates come from text inputs with a value", () => {
    expect(textInputsWithValue(filled.ax)).toEqual(expect.arrayContaining(filled.passwordBackendIds));
  });

  test("--interactive keeps controls and their ancestors only", () => {
    const refs = new RefTable();
    const view = interactiveOnly(tree(home));
    if (view === null) throw new Error("null");
    const text = renderAxTree(view, (id) => refs.refFor(id), 60_000).text;
    for (const want of ['button "Add item"', 'textbox "Name"', 'textbox "Password"', 'checkbox "I agree"', 'link "Go to page two"', "editable"]) expect(text).toContain(want);
    expect(text).not.toContain("heading");
    expect(text).not.toContain('text "apple"');
    expect(text).not.toContain("list");
  });

  test("same node keeps its ref within a document; refs never reused after a change", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const a = renderAxTree(tree(home), (id) => refs.refFor(id), 60_000).text;
    const b = renderAxTree(tree(home), (id) => refs.refFor(id), 60_000).text;
    expect(b).toBe(a);
    const btn = /button "Add item" \[(e\d+)\]/.exec(a)?.[1] ?? "";
    expect(refs.lookup(btn, DOC).ok).toBe(true);
    // new document identity: old refs expire, new refs get new numbers
    const doc2 = { ...DOC, loaderId: "L2" };
    expect(refs.lookup(btn, doc2)).toEqual({ ok: false, reason: "expired" });
    const c = renderAxTree(tree(home), (id) => refs.refFor(id), 60_000).text;
    const btn2 = /button "Add item" \[(e\d+)\]/.exec(c)?.[1] ?? "";
    expect(Number(btn2.slice(1))).toBeGreaterThan(Number(btn.slice(1)));
    expect(refs.lookup("e99999", doc2)).toEqual({ ok: false, reason: "unknown" });
    expect(refs.lookup("button", doc2)).toEqual({ ok: false, reason: "malformed" });
  });

  test("hash change counts as a new document", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const r = refs.refFor(42);
    expect(refs.lookup(r, { ...DOC, url: DOC.url + "#x" })).toEqual({ ok: false, reason: "expired" });
  });

  test("truncation cuts on a line boundary and reports it", () => {
    const refs = new RefTable();
    const full = renderAxTree(tree(home), (id) => refs.refFor(id), 60_000);
    const cut = renderAxTree(tree(home), (id) => refs.refFor(id), 120);
    expect(cut.truncated).toBe(true);
    expect(cut.chars).toBe(full.chars);
    expect(cut.text.length).toBeLessThanOrEqual(120);
    expect(full.text.startsWith(cut.text + "\n")).toBe(true);
  });

  test("find: name match with ancestor path, value match, password never matched", () => {
    const refs = new RefTable();
    const t = tree(filled);
    const r = findInTree(t, "banana", (id) => refs.refFor(id));
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ role: "text", name: "banana", field: "name", path: "main > list" });
    expect(r.hits[0]?.ref).toMatch(/^e\d+$/);
    expect(findInTree(t, "BOB", (id) => refs.refFor(id)).hits[0]).toMatchObject({ role: "textbox", field: "value" });
    const add = findInTree(t, "add item", (id) => refs.refFor(id)).hits[0];
    expect(add?.clickable).toBe(add?.ref ?? "missing");
    expect(findInTree(t, "•", (id) => refs.refFor(id)).total).toBe(0);
  });

  test("malformed input does not throw", () => {
    expect(buildAxTree(null)).toBeNull();
    expect(() => buildAxTree({ nodes: [1, "x", { nodeId: 3 }, { nodeId: 4, childIds: [4] }] })).not.toThrow();
  });
});
