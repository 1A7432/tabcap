// Click landing (0.6-J): where a default `click` on a ref should land.
// UI libraries put the handler on a child of the element the accessibility
// tree exposes (layui's `lay-event` span, a `cursor:pointer` inner element of
// an antd / Element UI control); a DOM click on the outer element bubbles up,
// never down, so the handler never runs. Before the click tabcap looks, read
// only, at the target, its ancestors and its descendants:
//   - listeners: click / mousedown / pointerdown / touchstart on the target
//     and up to 3 ancestor levels (DOMDebugger.getEventListeners; bubbling
//     covers ancestors), and on descendants (depth <= 4, at most 64 nodes,
//     breadth first);
//   - markers on descendants: `lay-event`, `onclick`, `role=button`, `href`,
//     a `data-*` click hook (name contains click / action / event / toggle /
//     handler / command / trigger), `cursor:pointer` that the element itself
//     introduces (its parent's computed cursor is not pointer; an inherited
//     pointer would mark every child of a pointer element).
// Descendants without a box (display:none, visibility:hidden, zero size) are
// never candidates. The decision table (owner's design, 10-16):
//   (a) the target or an ancestor listens → click the target as before;
//   (b) else exactly one descendant listens or is marked → land on it;
//   (c) else several → click the target, report the candidates;
//   (d) else nothing anywhere (delegated at the root: React, Vue) → as before.
// This file is pure: the decision over an inspection, and the page function
// (run in tabcap's isolated world) that builds one. The CDP side is
// tools/landing.ts.

import { isRecord } from "../../shared/json.ts";

/** Listener types that make an element "listen" for a click. */
export const LANDING_EVENTS: ReadonlySet<string> = new Set(["click", "mousedown", "pointerdown", "touchstart"]);
export const LANDING_ANCESTORS = 3;
export const LANDING_DEPTH = 4;
export const LANDING_MAX = 64;

export type LandingDescendant = {
  /** 1: a child of the target … LANDING_DEPTH. */
  depth: number;
  /** Listener types on this element (any; only LANDING_EVENTS count). */
  listens: string[];
  /** Framework markers found on it (see the header). */
  marks: string[];
  visible: boolean;
  tag: string;
  text: string;
  selector: string;
};

export type LandingInspection = {
  /** Listener types on the target itself. */
  target: string[];
  /** Listener types per ancestor level, the parent first. */
  ancestors: string[][];
  /** Descendants in breadth-first order. */
  descendants: LandingDescendant[];
};

export type LandingDecision =
  | { kind: "target"; by: "target" | "ancestor" }
  | { kind: "descendant"; index: number }
  | { kind: "candidates"; indexes: number[] }
  | { kind: "none" };

const clickTypes = (types: readonly string[]): string[] => [...new Set(types.filter((x) => LANDING_EVENTS.has(x)))];

/** Why a descendant is a candidate: its click listener types, then its markers; empty: not a candidate. */
export function candidateBy(d: LandingDescendant): string[] {
  if (!d.visible || d.depth < 1 || d.depth > LANDING_DEPTH) return [];
  return [...clickTypes(d.listens).map((x) => `listener:${x}`), ...d.marks];
}

/** Pure: the decision table above over one inspection. */
export function decideLanding(x: LandingInspection): LandingDecision {
  if (clickTypes(x.target).length > 0) return { kind: "target", by: "target" };
  if (x.ancestors.slice(0, LANDING_ANCESTORS).some((a) => clickTypes(a).length > 0)) return { kind: "target", by: "ancestor" };
  const indexes: number[] = [];
  x.descendants.slice(0, LANDING_MAX).forEach((d, i) => {
    if (candidateBy(d).length > 0) indexes.push(i);
  });
  const first = indexes[0];
  if (indexes.length === 1 && first !== undefined) return { kind: "descendant", index: first };
  if (indexes.length > 1) return { kind: "candidates", indexes };
  return { kind: "none" };
}

/** Untrusted page output → an inspection, or null when it is not one. */
export function parseInspection(v: unknown): LandingInspection | null {
  if (!isRecord(v)) return null;
  const o = v;
  const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((s): s is string => typeof s === "string").slice(0, 64) : []);
  if (!Array.isArray(o["target"]) || !Array.isArray(o["ancestors"]) || !Array.isArray(o["descendants"])) return null;
  const descendants: LandingDescendant[] = [];
  for (const d of o["descendants"].slice(0, LANDING_MAX)) {
    if (!isRecord(d)) return null;
    const r = d;
    const depth = r["depth"];
    if (typeof depth !== "number" || !Number.isInteger(depth)) return null;
    const s = (k: string, max: number): string => {
      const x = r[k];
      return typeof x === "string" ? x.slice(0, max) : "";
    };
    descendants.push({ depth, listens: strs(r["listens"]), marks: strs(r["marks"]), visible: r["visible"] === true, tag: s("tag", 64), text: s("text", 80), selector: s("selector", 300) });
  }
  return { target: strs(o["target"]), ancestors: o["ancestors"].slice(0, LANDING_ANCESTORS).map(strs), descendants };
}

// The inspection of one element in the page (isolated world): `el` the
// target, `listens(n)` the listener types tabcap read for element n (CDP).
// Returns [inspection, descendant elements in the same order].
const INSPECT_CORE = `(el, listens) => {
  const cur = (n) => { try { return getComputedStyle(n).cursor; } catch (e) { return ""; } };
  const DATA = /click|action|event|toggle|handler|command|trigger/;
  const marks = (n) => {
    const m = [];
    if (n.hasAttribute("lay-event")) m.push("lay-event");
    if (n.hasAttribute("onclick")) m.push("onclick");
    if ((n.getAttribute("role") || "").toLowerCase() === "button") m.push("role=button");
    if (n.hasAttribute("href")) m.push("href");
    for (const a of Array.from(n.attributes)) if (a.name.startsWith("data-") && DATA.test(a.name.slice(5))) m.push(a.name);
    if (cur(n) === "pointer" && !(n.parentElement && cur(n.parentElement) === "pointer")) m.push("cursor:pointer");
    return m;
  };
  const visible = (n) => {
    const r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const s = getComputedStyle(n);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const text = (n) => String(n.innerText || n.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const esc = (s) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s);
  const selector = (n) => {
    const parts = [];
    for (let x = n; x && x.nodeType === 1 && parts.length < 8; x = x.parentElement) {
      if (x.id) { parts.unshift("#" + esc(x.id)); break; }
      let s = x.localName + Array.from(x.classList).slice(0, 2).map((c) => "." + esc(c)).join("");
      const p = x.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((k) => k.localName === x.localName);
        if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(x) + 1) + ")";
      }
      parts.unshift(s);
      if (!p || x === x.ownerDocument.body) break;
    }
    return parts.join(" > ").slice(0, 300);
  };
  const ancestors = [];
  for (let a = el.parentElement, i = 0; a && i < ${LANDING_ANCESTORS}; a = a.parentElement, i++) ancestors.push(listens(a));
  const out = [], nodes = [];
  let level = [el];
  for (let depth = 1; depth <= ${LANDING_DEPTH} && level.length > 0 && nodes.length < ${LANDING_MAX}; depth++) {
    const next = [];
    for (const p of level) {
      for (const c of Array.from(p.children)) {
        if (nodes.length >= ${LANDING_MAX}) break;
        nodes.push(c);
        next.push(c);
        out.push({ depth, listens: listens(c), marks: marks(c), visible: visible(c), tag: c.localName, text: text(c), selector: selector(c) });
      }
    }
    level = next;
  }
  return [{ target: listens(el), ancestors, descendants: out }, nodes];
}`;

/**
 * One target (`this`): arguments are the listener types per holder (an array
 * of arrays) and then the holder elements. Returns [JSON inspection, ...the
 * descendant elements] (by reference) so tabcap can bind the one it lands on.
 */
export const INSPECT_FN = `function (types, ...holders) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return [JSON.stringify({ stale: true })];
  const map = new Map();
  holders.forEach((h, i) => { if (h && h.nodeType === 1) map.set(h, Array.isArray(types[i]) ? types[i] : []); });
  const [x, nodes] = (${INSPECT_CORE})(el, (n) => map.get(n) || []);
  return [JSON.stringify(x), ...nodes];
}`;

/**
 * Many targets at once (snapshot --interactive): arguments are the holder
 * listener types, the number of targets, the targets, then the holders.
 * Returns a JSON array of inspections (null for a detached target).
 */
export const INSPECT_MANY_FN = `function (types, count, ...rest) {
  const targets = rest.slice(0, count), holders = rest.slice(count);
  const map = new Map();
  holders.forEach((h, i) => { if (h && h.nodeType === 1) map.set(h, Array.isArray(types[i]) ? types[i] : []); });
  const core = (${INSPECT_CORE});
  return JSON.stringify(targets.map((t) => {
    const el = t && (t.nodeType === 1 ? t : t.parentElement);
    return el && el.isConnected ? core(el, (n) => map.get(n) || [])[0] : null;
  }));
}`;

/** Listener types per backend node id from a DOMDebugger.getEventListeners answer (untrusted); only LANDING_EVENTS kept. */
export function listenersByNode(r: unknown): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const raw = isRecord(r) ? r["listeners"] : null;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  for (const o of list) {
    if (!isRecord(o)) continue;
    const type = o["type"];
    const id = o["backendNodeId"];
    if (typeof type !== "string" || !LANDING_EVENTS.has(type) || typeof id !== "number" || !Number.isSafeInteger(id)) continue;
    const have = out.get(id) ?? [];
    if (!have.includes(type)) have.push(type);
    out.set(id, have);
  }
  return out;
}
