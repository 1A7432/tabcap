// docs/04 §53.1–53.3: visibility from DOMSnapshot, icon names, overlay subtrees,
// the ambiguous-target refusal. The DOMSnapshot input follows the shape measured
// on CfT 157 (spike 11-12): a string table, nodes.{parentIndex, nodeType,
// nodeName, nodeValue, backendNodeId, attributes}, layout.{nodeIndex, bounds,
// styles} with styles in LAYOUT_STYLES order.

import { describe, expect, test } from "bun:test";
import { applyLayout, countLines, splitLayer, wantsRef, lineOf, type AxNode } from "../../src/daemon/browser/ax.ts";
import { iconName, inside, LAYOUT_STYLES, parseLayout } from "../../src/daemon/browser/layout.ts";
import { ambiguousError, notVisibleError } from "../../src/daemon/tools/input.ts";
import { noticesOf } from "../../src/daemon/tools/notices.ts";
import { ambiguousOptions, noOption, notSelected, pickOption, selectedMatches } from "../../src/daemon/tools/select.ts";

type N = { id: number; parent: number; name: string; type?: number; value?: string; attrs?: Record<string, string>; box?: [number, number, number, number]; style?: Partial<Record<(typeof LAYOUT_STYLES)[number], string>> };

/** A one-document DOMSnapshot result from a compact node list (parents before children). */
function snap(nodes: N[]): unknown {
  const strings: string[] = [];
  const S = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const layout = { nodeIndex: [] as number[], bounds: [] as number[][], styles: [] as number[][] };
  nodes.forEach((n, i) => {
    if (n.box === undefined) return;
    layout.nodeIndex.push(i);
    layout.bounds.push(n.box);
    layout.styles.push(LAYOUT_STYLES.map((k) => S(n.style?.[k] ?? (k === "opacity" ? "1" : k === "position" ? "static" : "visible"))));
  });
  return {
    strings,
    documents: [
      {
        frameId: S("F"),
        nodes: {
          parentIndex: nodes.map((n) => (n.parent < 0 ? -1 : (index.get(n.parent) ?? -1))),
          nodeType: nodes.map((n) => n.type ?? 1),
          nodeName: nodes.map((n) => S(n.name)),
          nodeValue: nodes.map((n) => S(n.value ?? "")),
          backendNodeId: nodes.map((n) => n.id),
          attributes: nodes.map((n) => Object.entries(n.attrs ?? {}).flatMap(([k, v]) => [S(k), S(v)])),
        },
        layout,
      },
    ],
  };
}

const page: N[] = [
  { id: 1, parent: -1, name: "#document", type: 9, box: [0, 0, 800, 600] },
  { id: 2, parent: 1, name: "BODY", box: [0, 0, 800, 600] },
  { id: 3, parent: 2, name: "BUTTON", box: [10, 10, 80, 30] },
  { id: 4, parent: 2, name: "BUTTON", box: [10, 50, 80, 30], style: { opacity: "0" } },
  { id: 5, parent: 4, name: "#text", type: 3, value: "建账", box: [12, 52, 30, 20] },
  { id: 6, parent: 2, name: "DIV", box: [0, 100, 200, 40], style: { "overflow-x": "hidden", "overflow-y": "hidden" } },
  { id: 7, parent: 6, name: "SPAN", box: [0, 100, 50, 20] },
  { id: 8, parent: 6, name: "SPAN", box: [0, 300, 50, 20] },
  { id: 9, parent: 6, name: "SPAN", box: [0, 300, 50, 20], style: { position: "absolute" } },
  { id: 10, parent: 2, name: "DIV" },
  { id: 11, parent: 2, name: "SPAN", box: [0, 400, 0, 0] },
  { id: 12, parent: 11, name: "A", box: [0, 400, 40, 20] },
  { id: 13, parent: 2, name: "LABEL", box: [0, 500, 60, 20] },
  { id: 14, parent: 13, name: "INPUT", attrs: { type: "checkbox" }, box: [0, 500, 0, 0], style: { opacity: "0" } },
  { id: 15, parent: 2, name: "INPUT", attrs: { type: "checkbox" }, box: [0, 530, 0, 0], style: { opacity: "0" } },
  { id: 16, parent: 2, name: "BUTTON", attrs: { class: "el-button el-button--text" }, box: [100, 10, 20, 20] },
  { id: 17, parent: 16, name: "I", attrs: { class: "el-icon-delete" }, box: [102, 12, 16, 16] },
  { id: 18, parent: 2, name: "BUTTON", attrs: { title: "关闭" }, box: [130, 10, 20, 20] },
  { id: 19, parent: 2, name: "BUTTON", box: [160, 10, 20, 20] },
  { id: 20, parent: 19, name: "svg", box: [160, 10, 20, 20] },
  { id: 21, parent: 20, name: "title" },
  { id: 22, parent: 21, name: "#text", type: 3, value: "Search" },
];

describe("parseLayout visibility (docs/04 §53.3)", () => {
  const l = parseLayout(snap(page));
  const vis = (id: number) => l.get(id)?.vis;
  test("a box: visible; opacity 0 on the node or an ancestor: transparent", () => {
    expect(vis(3)).toBe("visible");
    expect(vis(4)).toBe("transparent");
    expect(vis(5)).toBe("transparent");
  });
  test("outside an overflow:hidden ancestor: clipped, unless positioned; inside it: visible", () => {
    expect(vis(7)).toBe("visible");
    expect(vis(8)).toBe("clipped");
    expect(vis(9)).toBe("visible");
  });
  test("no layout box or under 1 px: nobox", () => {
    expect(vis(10)).toBe("nobox");
    expect(vis(11)).toBe("nobox");
    expect(vis(12)).toBe("visible");
  });
  test("a checkbox drawn by its label counts as visible; an unlabelled hidden one does not", () => {
    expect(vis(14)).toBe("visible");
    expect(vis(15)).toBe("transparent");
  });
  test("malformed input: an empty map, never a throw", () => {
    expect(parseLayout(null).size).toBe(0);
    expect(parseLayout({ documents: [{ nodes: { backendNodeId: "x" } }] }).size).toBe(0);
    expect(parseLayout({ strings: [1, 2], documents: "no" }).size).toBe(0);
  });
  test("parents and containment", () => {
    expect(inside(l, 5, 4)).toBe(true);
    expect(inside(l, 5, 2)).toBe(true);
    expect(inside(l, 3, 4)).toBe(false);
  });
  test("icon names: title, svg <title>, class words; nothing otherwise", () => {
    expect(iconName(l, 16)).toBe("(icon: delete)");
    expect(iconName(l, 18)).toBe("关闭");
    expect(iconName(l, 19)).toBe("Search");
    expect(iconName(l, 3)).toBe("");
  });
});

const ax = (role: string, name: string, backendId: number | null, children: AxNode[] = []): AxNode => ({ role, name, value: null, description: "", backendId, password: false, flags: [], children });

describe("applyLayout (docs/04 §53.3)", () => {
  const l = parseLayout(snap(page));
  const tree = ax("RootWebArea", "T", 1, [
    ax("button", "Go", 3),
    ax("button", "建账", 4, [ax("text", "建账", 5)]),
    ax("generic", "", 11, [ax("link", "more", 12)]),
    ax("generic", "", 10),
    ax("button", "", 16),
    ax("checkbox", "记住", 14),
    ax("text", "far", 8),
  ]);
  test("invisible nodes drop out; a zero-size wrapper of visible content stays; icon buttons get names", () => {
    const out = applyLayout(tree, l, false);
    expect(out?.children.map((c) => `${c.role} ${c.name}`)).toEqual(["button Go", "generic ", "button (icon: delete)", "checkbox 记住"]);
  });
  test("--verbose keeps them marked invisible, without refs", () => {
    const out = applyLayout(tree, l, true);
    const hidden = out?.children.find((c) => c.name === "建账");
    expect(hidden?.invisible).toBe(true);
    expect(hidden !== undefined && wantsRef(hidden)).toBe(false);
    expect(hidden === undefined ? "" : lineOf(hidden, null)).toBe('button "建账" invisible');
  });
  test("an empty layout (DOMSnapshot failed) filters nothing", () => {
    expect(applyLayout(tree, new Map(), false)?.children.length).toBe(7);
  });
});

describe("splitLayer (docs/04 §53.2)", () => {
  const nodes: N[] = [
    { id: 1, parent: -1, name: "#document", type: 9, box: [0, 0, 800, 600] },
    { id: 2, parent: 1, name: "BODY", box: [0, 0, 800, 600] },
    { id: 3, parent: 2, name: "TABLE", box: [0, 0, 800, 6000] },
    { id: 4, parent: 3, name: "TD", box: [0, 0, 80, 20] },
    { id: 5, parent: 2, name: "DIV", box: [0, 0, 800, 600], style: { position: "fixed" } },
    { id: 6, parent: 5, name: "DIV", box: [200, 100, 400, 300] },
    { id: 7, parent: 6, name: "BUTTON", box: [300, 300, 60, 30] },
  ];
  const l = parseLayout(snap(nodes));
  const tree = ax("RootWebArea", "T", 1, [ax("table", "", 3, [ax("cell", "A", 4)]), ax("dialog", "新建账套", 6, [ax("button", "确定", 7)])]);
  test("the overlay's subtrees and the rest; nothing inside: an empty layer", () => {
    const { layer, rest } = splitLayer(tree, l, 5);
    expect(layer.map((n) => n.name)).toEqual(["新建账套"]);
    expect(rest.children.map((n) => n.role)).toEqual(["table"]);
    expect(countLines(rest)).toBe(3);
    expect(splitLayer(tree, l, 99).layer).toEqual([]);
  });
});

describe("refusals (docs/04 §53.1, §53.3)", () => {
  test("ambiguous-target names the element the press would land on and how to get its ref", () => {
    const e = ambiguousError("e412", "ul", { tag: "li", text: "220020 科目20" });
    expect(e.code).toBe("ambiguous-target");
    expect(e.message).toContain("<ul>");
    expect(e.message).toContain('"220020 科目20"');
    expect(e.next).toContain('tabcap find "220020 科目20"');
    expect(e.extra).toEqual({ landedOn: { tag: "li", text: "220020 科目20" } });
  });
  test("not-visible says why and that nothing was done", () => {
    const e = notVisibleError("e9", "opacity 0");
    expect(e.code).toBe("not-visible");
    expect(e.message).toContain("nothing was done");
  });
});

describe("select: picking and reading back (docs/04 §53.4)", () => {
  test("an exact match wins; one containing match is taken; several are ambiguous; --exact takes equals only", () => {
    expect(pickOption(["1001 库存现金", "100101 现金-人民币"], "1001 库存现金", false)).toEqual({ index: 0 });
    expect(pickOption(["S79_TARGET 1001", "S79_DECOY 222123"], "S79_TARGET", false)).toEqual({ index: 0 });
    expect(pickOption(["1001 a", "1001 b"], "1001", false)).toEqual({ ambiguous: [0, 1] });
    expect(pickOption(["1001 a"], "1001", true)).toEqual({ none: true });
    expect(pickOption(["x", "x"], "x", false)).toEqual({ ambiguous: [0, 1] });
    expect(pickOption([], "x", false)).toEqual({ none: true });
  });
  test("read-back: contains by default, equals with --exact, whitespace normalised", () => {
    expect(selectedMatches(" S79_TARGET   1001 ", "S79_TARGET 1001", true)).toBe(true);
    expect(selectedMatches("S79_DECOY 222123", "S79_TARGET", false)).toBe(false);
    expect(selectedMatches("1001 库存现金", "库存", false)).toBe(true);
    expect(selectedMatches("1001 库存现金", "库存", true)).toBe(false);
  });
  test("errors: not-found lists candidates, ambiguous-target lists them, not-selected carries wanted / got / the click's answer", () => {
    expect(noOption("e3", "x", null).code).toBe("not-found");
    expect(noOption("e3", "x", ["a", "b"]).extra).toEqual({ candidates: ["a", "b"] });
    expect(ambiguousOptions("e3", "1001", ["1001 a", "1001 b"]).code).toBe("ambiguous-target");
    const e = notSelected("e3", "S79_TARGET", "S79_DECOY 222123", { via: "layer" });
    expect(e.code).toBe("not-selected");
    expect(e.extra).toEqual({ wanted: "S79_TARGET", got: "S79_DECOY 222123", result: { via: "layer" } });
  });
});

describe("notices (docs/04 §53.5)", () => {
  test("alerts and short new text; a text already an alert is not repeated; scrubbed; at most 10", () => {
    const seen = [
      { kind: "text" as const, text: "S79 名称不能为空" },
      { kind: "alert" as const, text: "  S79 科目为空 " },
      { kind: "text" as const, text: "S79 科目为空" },
      { kind: "alert" as const, text: "S79 科目为空" },
      { kind: "status" as const, text: "token=hunter2" },
    ];
    expect(noticesOf(seen, 2, (s) => s.replace("hunter2", "<secret>"))).toEqual([
      { kind: "alert", text: "S79 科目为空" },
      { kind: "status", text: "token=<secret>" },
      { kind: "text", text: "S79 名称不能为空" },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "alert" as const, text: `a${i}` }));
    expect(noticesOf(many, 0)).toHaveLength(10);
  });
  test("more than 20 new text elements is a page change, not a notice: only live kinds stay", () => {
    expect(noticesOf([{ kind: "text", text: "row 1" }, { kind: "live", text: "3 results" }], 21)).toEqual([{ kind: "live", text: "3 results" }]);
  });
});
