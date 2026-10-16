// Accessibility-tree snapshot, pure functions over the raw
// `Accessibility.getFullAXTree` result (untrusted JSON):
// - InlineTextBox and ListMarker dropped; ignored nodes, nameless none/generic and LabelText hoisted;
// - nameless single-child wrappers collapsed, empty wrappers dropped;
// - text equal to its parent's name dropped (button "Go" > text "Go");
// - inner editor content of text inputs dropped (it mirrors the value);
// - `interactive` keeps controls and their ancestors only;
// - values of password fields are never rendered;
// - `verbose` (snapshot --verbose) keeps nameless wrappers and text that
//   repeats its parent's name, and adds capability flags (focusable …).
// Line format (docs/08 §5, after chrome-devtools-mcp's SnapshotFormatter, see
// tools/formatters.ts): `- role "name" [e12] value="…" checked focused
// level="2" description="…"` — states are bare words, other attributes
// attr="value"; refs stay tabcap's `[e12]`.

import { isRecord } from "../../shared/json.ts";
import { booleanPropertyMap } from "../tools/formatters.ts";

export type AxNode = {
  role: string;
  name: string;
  value: string | null;
  description: string;
  backendId: number | null;
  password: boolean;
  flags: string[];
  children: AxNode[];
  /** 0.6-J, snapshot --interactive: a click on this control lands on a descendant (tools/landing.ts). */
  landing?: "child";
};

type Raw = {
  id: string;
  ignored: boolean;
  role: string;
  name: string;
  value: string | null;
  description: string;
  backendId: number | null;
  childIds: string[];
  parentId: string | null;
  props: Map<string, unknown>;
};

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "editable",
]);
const HOIST_ROLES = new Set(["none", "generic", "LabelText", "GenericContainer"]);
const WRAPPER_ROLES = new Set(["paragraph", "listitem", "group", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "div"]);
const TEXT_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

function axValue(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const x = v["value"];
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  return null;
}

function parseRaw(n: unknown): Raw | null {
  if (!isRecord(n) || typeof n["nodeId"] !== "string") return null;
  const props = new Map<string, unknown>();
  if (Array.isArray(n["properties"])) {
    for (const p of n["properties"]) {
      if (isRecord(p) && typeof p["name"] === "string" && isRecord(p["value"])) props.set(p["name"], p["value"]["value"]);
    }
  }
  const backend = n["backendDOMNodeId"];
  return {
    id: n["nodeId"],
    ignored: n["ignored"] === true,
    role: axValue(n["role"]) ?? "",
    name: axValue(n["name"]) ?? "",
    value: axValue(n["value"]),
    description: axValue(n["description"]) ?? "",
    backendId: typeof backend === "number" && Number.isSafeInteger(backend) ? backend : null,
    childIds: Array.isArray(n["childIds"]) ? n["childIds"].filter((c): c is string => typeof c === "string") : [],
    parentId: typeof n["parentId"] === "string" ? n["parentId"] : null,
    props,
  };
}

function flagsOf(r: Raw, verbose: boolean): string[] {
  const f: string[] = [];
  const p = r.props;
  if (verbose) {
    // SnapshotFormatter: the capability word next to the state it maps from.
    if (p.get("focusable") === true) f.push("focusable");
    for (const [state, able] of Object.entries(booleanPropertyMap)) {
      if (state === "focused") continue;
      if (typeof p.get(state) === "boolean" && !(state === "selected" && r.role === "option")) f.push(able);
    }
  }
  if (p.get("checked") === "true" || p.get("checked") === true) f.push("checked");
  if (p.get("checked") === "mixed") f.push("mixed");
  if (p.get("selected") === true) f.push("selected");
  if (p.get("expanded") === true) f.push("expanded");
  if (p.get("expanded") === false) f.push("collapsed");
  if (p.get("disabled") === true) f.push("disabled");
  if (p.get("readonly") === true) f.push("readonly");
  if (p.get("required") === true) f.push("required");
  if (p.get("focused") === true) f.push("focused");
  const level = p.get("level");
  if (typeof level === "number") f.push(`level=${level}`);
  return f;
}

/** Raw AX nodes of an ignored / malformed input → empty tree root. */
export function buildAxTree(rawResult: unknown, passwordIds: ReadonlySet<number> = new Set(), opts: { verbose?: boolean } = {}): AxNode | null {
  const verbose = opts.verbose === true;
  const list = isRecord(rawResult) && Array.isArray(rawResult["nodes"]) ? rawResult["nodes"] : [];
  const byId = new Map<string, Raw>();
  for (const n of list) {
    const r = parseRaw(n);
    if (r !== null && !byId.has(r.id)) byId.set(r.id, r);
  }
  const root = [...byId.values()].find((r) => r.parentId === null) ?? byId.values().next().value;
  if (root === undefined) return null;
  const seen = new Set<string>();

  const build = (r: Raw, inEditable: boolean): AxNode[] => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    if (r.role === "InlineTextBox" || r.role === "ListMarker") return [];
    const editable = typeof r.props.get("editable") === "string";
    // The first editable node is the control; everything inside mirrors its value.
    const editorRoot = editable && !inEditable;
    const isTextInput = TEXT_INPUT_ROLES.has(r.role) || editorRoot;
    let kids: AxNode[] = [];
    if (!isTextInput) {
      for (const cid of r.childIds) {
        const c = byId.get(cid);
        if (c !== undefined) kids.push(...build(c, inEditable || editable));
      }
    }
    if (r.ignored) return kids;
    if (r.role === "StaticText") return r.name.trim() === "" ? [] : [leaf("text", r.name, r)];
    let role = r.role;
    if (editorRoot && !TEXT_INPUT_ROLES.has(role)) role = "editable";
    if (!verbose) {
      if (HOIST_ROLES.has(role) && r.name === "") return kids;
      if (r.name !== "") kids = kids.filter((k) => !(k.role === "text" && k.name.trim() === r.name.trim()));
      if (r.name === "" && WRAPPER_ROLES.has(role)) {
        if (kids.length <= 1) return kids;
      }
    }
    const password = r.backendId !== null && passwordIds.has(r.backendId);
    return [
      {
        role,
        name: r.name,
        value: password ? null : r.value,
        description: r.description,
        backendId: r.backendId,
        password,
        flags: flagsOf(r, verbose),
        children: kids,
      },
    ];
  };
  const leaf = (role: string, name: string, r: Raw): AxNode => ({
    role,
    name,
    value: null,
    description: "",
    backendId: r.backendId,
    password: false,
    flags: [],
    children: [],
  });

  const out = build(root, false);
  if (out.length === 1 && out[0] !== undefined) return out[0];
  return { role: "RootWebArea", name: "", value: null, description: "", backendId: null, password: false, flags: [], children: out };
}

/** Keep interactive nodes and their ancestors. */
export function interactiveOnly(n: AxNode, isRoot = true): AxNode | null {
  const kids = n.children.map((c) => interactiveOnly(c, false)).filter((c): c is AxNode => c !== null);
  if (isRoot || INTERACTIVE_ROLES.has(n.role) || kids.length > 0) return { ...n, children: kids };
  return null;
}

/** Text inputs whose AX value is non-empty: candidates for the password check. */
export function textInputsWithValue(rawResult: unknown): number[] {
  const list = isRecord(rawResult) && Array.isArray(rawResult["nodes"]) ? rawResult["nodes"] : [];
  const ids: number[] = [];
  for (const n of list) {
    const r = parseRaw(n);
    if (r !== null && r.backendId !== null && (TEXT_INPUT_ROLES.has(r.role) || r.props.has("editable")) && r.value !== null && r.value !== "") ids.push(r.backendId);
  }
  return ids;
}

export type RefFor = (backendNodeId: number) => string;

const MAX_VALUE = 200;

/** One snapshot line without its indentation and "- " (exported for the 0.5-F filters). */
export function lineOf(n: AxNode, ref: string | null): string {
  let s = n.role === "text" ? `text ${JSON.stringify(n.name)}` : n.role;
  if (n.role !== "text" && n.name !== "") s += ` ${JSON.stringify(n.name)}`;
  if (ref !== null) s += ` [${ref}]`;
  if (n.password) s += " [password]";
  if (n.value !== null && n.value !== "") {
    const v = n.value.length > MAX_VALUE ? n.value.slice(0, MAX_VALUE) + "…" : n.value;
    s += ` value=${JSON.stringify(v)}`;
  }
  for (const f of n.flags) {
    const eq = f.indexOf("=");
    s += eq < 0 ? ` ${f}` : ` ${f.slice(0, eq)}=${JSON.stringify(f.slice(eq + 1))}`;
  }
  if (n.landing !== undefined) s += ` landing=${JSON.stringify(n.landing)}`;
  if (n.description !== "" && n.role !== "text") {
    const d = n.description.length > MAX_VALUE ? n.description.slice(0, MAX_VALUE) + "…" : n.description;
    s += ` description=${JSON.stringify(d)}`;
  }
  return s;
}

/** Refs go to element nodes (not text, not the document root). */
export function wantsRef(n: AxNode): boolean {
  return n.backendId !== null && n.role !== "text" && n.role !== "RootWebArea";
}

export type Rendered = { text: string; truncated: boolean; chars: number; refs: number };

/** Indented text tree, cut at `maxChars` on a line boundary. */
export function renderAxTree(root: AxNode, refFor: RefFor, maxChars: number): Rendered {
  const lines: string[] = [];
  let refs = 0;
  const walk = (n: AxNode, depth: number) => {
    const ref = wantsRef(n) && n.backendId !== null ? refFor(n.backendId) : null;
    if (ref !== null) refs++;
    lines.push(`${"  ".repeat(depth)}- ${lineOf(n, ref)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  const full = lines.join("\n");
  if (full.length <= maxChars) return { text: full, truncated: false, chars: full.length, refs };
  let cut = full.lastIndexOf("\n", maxChars);
  if (cut <= 0) {
    cut = maxChars;
    const code = full.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // never split a surrogate pair
  }
  return { text: full.slice(0, cut), truncated: true, chars: full.length, refs };
}

export type FindHit = {
  ref: string | null;
  role: string;
  name: string;
  field: "name" | "value" | "description";
  match: string;
  path: string;
  /** Ref of the element to click for this hit: an interactive AX ancestor, or a DOM element found by `find` (cursor / click listener). */
  clickable: string | null;
  /** Why `clickable` is set: "role" (AX control), or the DOM signal: "tag", "cursor", "listener". */
  clickableBy?: string | null;
};

/** One text match before refs are minted (so ranking can look at the DOM first). */
export type FindCandidate = {
  node: AxNode;
  field: FindHit["field"];
  match: string;
  path: string;
  /** backendId of the nearest ancestor-or-self that gets a ref. */
  ownId: number | null;
  /** backendId of the nearest interactive (AX role) ancestor-or-self. */
  clickId: number | null;
};

/** Case-insensitive substring search: name → value → description, document order; at most `cap` candidates. */
export function findCandidates(root: AxNode, query: string, cap: number): { cands: FindCandidate[]; total: number } {
  const q = query.toLowerCase();
  const cands: FindCandidate[] = [];
  let total = 0;
  const label = (n: AxNode) => (n.name === "" ? n.role : `${n.role} ${JSON.stringify(n.name)}`);
  const walk = (n: AxNode, anc: AxNode[]) => {
    let field: FindHit["field"] | null = null;
    let match = "";
    if (n.name.toLowerCase().includes(q)) [field, match] = ["name", n.name];
    else if (!n.password && n.value !== null && n.value.toLowerCase().includes(q)) [field, match] = ["value", n.value];
    else if (n.description.toLowerCase().includes(q)) [field, match] = ["description", n.description];
    if (field !== null) {
      total++;
      if (cands.length < cap) {
        const chain = [...anc, n].reverse();
        const own = chain.find((x) => wantsRef(x));
        const click = chain.find((x) => wantsRef(x) && INTERACTIVE_ROLES.has(x.role));
        cands.push({
          node: n,
          field,
          match: match.length > MAX_VALUE ? match.slice(0, MAX_VALUE) + "…" : match,
          path: anc.filter((a) => a.role !== "RootWebArea").map(label).join(" > "),
          ownId: own?.backendId ?? null,
          clickId: click?.backendId ?? null,
        });
      }
    }
    for (const c of n.children) walk(c, [...anc, n]);
  };
  walk(root, []);
  return { cands, total };
}

/** Stable partition: items `isClickable` says yes to first, document order kept within each group. */
export function rankClickable<T>(items: readonly T[], isClickable: (x: T) => boolean): T[] {
  return [...items.filter(isClickable), ...items.filter((x) => !isClickable(x))];
}

/** Hit with refs; `dom` is an element found clickable in the DOM when the AX tree has no control. */
export function hitOf(c: FindCandidate, refFor: RefFor, dom: { backendId: number; by: string } | null = null): FindHit {
  const clickId = c.clickId ?? dom?.backendId ?? null;
  return {
    ref: c.ownId === null ? null : refFor(c.ownId),
    role: c.node.role,
    name: c.node.name,
    field: c.field,
    match: c.match,
    path: c.path,
    clickable: clickId === null ? null : refFor(clickId),
    clickableBy: c.clickId !== null ? "role" : (dom?.by ?? null),
  };
}

/** Case-insensitive substring search: name → value → description; up to `limit` hits. */
export function findInTree(root: AxNode, query: string, refFor: RefFor, limit = 20): { hits: FindHit[]; total: number } {
  const { cands, total } = findCandidates(root, query, limit);
  return { hits: cands.map((c) => hitOf(c, refFor)), total };
}
