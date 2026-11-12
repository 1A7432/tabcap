// docs/04 §53.3 (11-12): what the accessibility tree does not say about a node,
// from one DOMSnapshot.captureSnapshot per snapshot (untrusted JSON):
// - visibility beyond what Chrome's AX tree already drops (display:none,
//   visibility:hidden, hidden): no layout box or smaller than 1 px ("nobox"),
//   opacity 0 on the node or an ancestor ("transparent"), entirely outside an
//   ancestor that clips with overflow hidden / clip ("clipped"; scrollable
//   ancestors do not clip: scrolling shows the node);
// - the DOM parent of every node (overlay subtrees, §53.2) and its attributes
//   (names of icon-only buttons).
// Conservative where CSS is subtle: a positioned (absolute / fixed) node is not
// tested against the overflow of ancestors above it, and a labelled checkbox /
// radio input (commonly drawn as opacity 0 behind a styled label) counts as
// visible.
// Oracle: CDP protocol.json DOMSnapshot.captureSnapshot (documents[].nodes /
// layout, string table); shape measured on CfT 157 (spike 11-12).

import { isRecord } from "../../shared/json.ts";

/** Computed styles requested, in this order (layout.styles indexes follow it). */
export const LAYOUT_STYLES = ["opacity", "overflow-x", "overflow-y", "position"] as const;

export type Visibility = "visible" | "nobox" | "transparent" | "clipped";

export type LayoutNode = {
  parent: number | null;
  type: number;
  name: string;
  attrs: Map<string, string>;
  vis: Visibility;
  children: number[];
  value: string;
};

/** Backend node id → node facts, over every document of the snapshot. */
export type PageLayout = Map<number, LayoutNode>;

type Rect = { x0: number; y0: number; x1: number; y1: number };

const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : -1)) : []);

/** Pure: DOMSnapshot.captureSnapshot result (computedStyles = LAYOUT_STYLES) → layout facts. Malformed parts are skipped. */
export function parseLayout(raw: unknown): PageLayout {
  const out: PageLayout = new Map();
  if (!isRecord(raw)) return out;
  const strings = Array.isArray(raw["strings"]) ? raw["strings"].map((s) => (typeof s === "string" ? s : "")) : [];
  const S = (i: unknown): string => (typeof i === "number" && i >= 0 && i < strings.length ? (strings[i] ?? "") : "");
  const docs = Array.isArray(raw["documents"]) ? raw["documents"].filter(isRecord) : [];
  for (const d of docs) {
    const nodes = isRecord(d["nodes"]) ? d["nodes"] : {};
    const layout = isRecord(d["layout"]) ? d["layout"] : {};
    const parentIndex = numArr(nodes["parentIndex"]);
    const nodeType = numArr(nodes["nodeType"]);
    const nodeName = numArr(nodes["nodeName"]);
    const nodeValue = numArr(nodes["nodeValue"]);
    const backend = numArr(nodes["backendNodeId"]);
    const attributes = Array.isArray(nodes["attributes"]) ? nodes["attributes"] : [];
    const n = backend.length;
    const boxOf = new Map<number, { r: Rect; styles: string[] }>();
    const li = numArr(layout["nodeIndex"]);
    const bounds = Array.isArray(layout["bounds"]) ? layout["bounds"] : [];
    const styles = Array.isArray(layout["styles"]) ? layout["styles"] : [];
    for (let k = 0; k < li.length; k++) {
      const i = li[k] ?? -1;
      if (i < 0 || i >= n || boxOf.has(i)) continue;
      const b = numArr(bounds[k]);
      if (b.length < 4) continue;
      const [x, y, w, h] = b as [number, number, number, number];
      boxOf.set(i, { r: { x0: x, y0: y, x1: x + w, y1: y + h }, styles: numArr(styles[k]).map(S) });
    }
    // Parents come before children in DOMSnapshot order: one pass top-down.
    const transparent: boolean[] = new Array(n).fill(false);
    const clip: Array<Rect | null> = new Array(n).fill(null);
    const childClip: Array<Rect | null> = new Array(n).fill(null);
    const labelFor = new Set<string>();
    const ids: string[] = new Array(n).fill("");
    for (let i = 0; i < n; i++) {
      const a = Array.isArray(attributes[i]) ? numArr(attributes[i]) : [];
      const m = new Map<string, string>();
      for (let j = 0; j + 1 < a.length; j += 2) m.set(S(a[j]).toLowerCase(), S(a[j + 1]));
      const name = S(nodeName[i]).toUpperCase();
      if (name === "LABEL" && m.has("for")) labelFor.add(m.get("for") ?? "");
      ids[i] = m.get("id") ?? "";
      const p = parentIndex[i] ?? -1;
      const box = boxOf.get(i);
      const st = box?.styles ?? [];
      const position = st[3] ?? "";
      transparent[i] = (p >= 0 && (transparent[p] ?? false)) || (box !== undefined && st[0] !== undefined && st[0] !== "" && Number(st[0]) === 0);
      clip[i] = position === "fixed" || position === "absolute" || p < 0 ? null : (childClip[p] ?? null);
      let cc = clip[i] ?? null;
      if (box !== undefined) {
        const ox = st[1] === "hidden" || st[1] === "clip";
        const oy = st[2] === "hidden" || st[2] === "clip";
        if (ox || oy) {
          const base: Rect = cc ?? { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
          cc = { x0: ox ? Math.max(base.x0, box.r.x0) : base.x0, x1: ox ? Math.min(base.x1, box.r.x1) : base.x1, y0: oy ? Math.max(base.y0, box.r.y0) : base.y0, y1: oy ? Math.min(base.y1, box.r.y1) : base.y1 };
        }
      }
      childClip[i] = cc;
      out.set(backend[i] ?? -1, { parent: null, type: nodeType[i] ?? 0, name, attrs: m, vis: "visible", children: [], value: S(nodeValue[i]) });
    }
    for (let i = 0; i < n; i++) {
      const id = backend[i] ?? -1;
      const node = out.get(id);
      if (node === undefined) continue;
      const p = parentIndex[i] ?? -1;
      const pid = p >= 0 ? (backend[p] ?? null) : null;
      node.parent = pid;
      if (pid !== null) out.get(pid)?.children.push(id);
      const box = boxOf.get(i);
      const c = clip[i] ?? null;
      let vis: Visibility = "visible";
      if (transparent[i]) vis = "transparent";
      else if (box === undefined || box.r.x1 - box.r.x0 < 1 || box.r.y1 - box.r.y0 < 1) vis = "nobox";
      else if (c !== null && (box.r.x1 <= c.x0 || box.r.x0 >= c.x1 || box.r.y1 <= c.y0 || box.r.y0 >= c.y1)) vis = "clipped";
      if (vis !== "visible" && node.name === "INPUT" && /^(checkbox|radio)$/i.test(node.attrs.get("type") ?? "")) {
        if (labelFor.has(ids[i] ?? "\u0000") || hasAncestor(out, id, "LABEL")) vis = "visible";
      }
      node.vis = vis;
    }
  }
  return out;
}

function hasAncestor(l: PageLayout, id: number, name: string): boolean {
  let p = l.get(id)?.parent ?? null;
  for (let hops = 0; p !== null && hops < 64; hops++) {
    const n = l.get(p);
    if (n === undefined) return false;
    if (n.name === name) return true;
    p = n.parent;
  }
  return false;
}

/** Is `id` inside the element `ancestor` (or the element itself)? */
export function inside(l: PageLayout, id: number, ancestor: number): boolean {
  let p: number | null = id;
  for (let hops = 0; p !== null && hops < 256; hops++) {
    if (p === ancestor) return true;
    p = l.get(p)?.parent ?? null;
  }
  return false;
}

/** Icon words in class names (docs/04 §53.3), with common synonyms. */
const ICON_WORDS: Array<[RegExp, string]> = [
  [/^(close|times)$/, "close"],
  [/^(delete|trash)$/, "delete"],
  [/^(edit|pencil)$/, "edit"],
  [/^search$/, "search"],
  [/^(more|ellipsis)$/, "more"],
  [/^(add|plus)$/, "add"],
  [/^(refresh|reload)$/, "refresh"],
  [/^download$/, "download"],
  [/^upload$/, "upload"],
];

/**
 * docs/04 §53.3: a name for a button with no accessible name: `title`, then an
 * inner `<svg><title>`, then an icon word from the class names of the element
 * and its descendants (`(icon: close)`); "" when there is nothing.
 */
export function iconName(l: PageLayout, id: number): string {
  const n = l.get(id);
  if (n === undefined) return "";
  const title = (n.attrs.get("title") ?? "").trim();
  if (title !== "") return title.slice(0, 60);
  const seen: number[] = [];
  const queue = [id];
  while (queue.length > 0 && seen.length < 24) {
    const x = queue.shift() ?? -1;
    seen.push(x);
    queue.push(...(l.get(x)?.children ?? []));
  }
  for (const x of seen) {
    const e = l.get(x);
    if (e?.name !== "TITLE") continue;
    const text = e.children.map((c) => l.get(c)?.value ?? "").join("").trim();
    if (text !== "") return text.slice(0, 60);
  }
  for (const x of seen) {
    const cls = l.get(x)?.attrs.get("class") ?? "";
    for (const word of cls.toLowerCase().split(/[\s_-]+/)) {
      for (const [re, w] of ICON_WORDS) if (re.test(word)) return `(icon: ${w})`;
    }
  }
  return "";
}
