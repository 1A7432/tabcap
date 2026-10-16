// tabcap snapshot | find, plus ref resolution shared with click / fill.
// 0.4-I: the frame tree is in the header (`frames` lines); `--frames` expands
// every child frame's tree with frame-path refs (`f2/f1/e7`), `--frame f2/f1`
// only that subtree. Refs resolve in the document they were minted in.
// 0.5-F: `--grep` / `--css` / `--xpath` / `--ref --depth` print only part of
// the tree (browser/axfilter.ts); the header and the ref table stay those of
// the full snapshot.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { buildAxTree, findCandidates, hitOf, interactiveOnly, rankClickable, renderAxTree, textInputsWithValue, type AxNode, type FindCandidate, type RefFor, type Rendered } from "../browser/ax.ts";
import { flattenAx, grepAx, nodesAx, pickLines, subtreeLines } from "../browser/axfilter.ts";
import { inspectPage } from "../adapters/runtime.ts";
import { cutText, headerLines } from "../adapters/view.ts";
import { bindingOf, descendants, frameAt, frameHeaderLines, frameLine, frameList, framesOfTree, frameTree, type FrameNode } from "../browser/frames.ts";
import { parseFramePath, parseRef, sameDoc, type DocIdentity, type FrameBinding } from "../browser/refs.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Tab } from "../browser/targets.ts";
import { isSensitiveField } from "../secrets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { clampInt, compileRegex } from "./textsearch.ts";

/** Default `--max-chars` of `snapshot` (and of `--snapshot` on actions): 0.5-C context budget, owner 10-16. */
export const SNAPSHOT_MAX_CHARS = 12_000;

export async function docIdentity(t: Transport, tab: Tab): Promise<DocIdentity> {
  const r = await t.send("Page.getFrameTree", {}, tab.sessionId, 10_000);
  const tree = isRecord(r["frameTree"]) ? r["frameTree"] : null;
  const f = tree !== null && isRecord(tree["frame"]) ? tree["frame"] : null;
  const id = f === null ? null : str(f, "id");
  if (f === null || id === null) throw new TabcapError("cdp", "Page.getFrameTree returned no root frame", "Navigate again; the tab may have crashed.");
  return { frameId: id, loaderId: str(f, "loaderId") ?? "", url: (str(f, "url") ?? "") + (str(f, "urlFragment") ?? "") };
}

/** Wait (bounded) for an in-flight root navigation, so we never snapshot a half-loaded document. */
export async function settle(tab: Tab, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (tab.loading && Date.now() < until) await Bun.sleep(50);
}

/** Attribute map of a DOM node from DOM.describeNode (untrusted), through the session that owns its document. */
export async function nodeAttributes(t: Transport, sessionId: string, backendNodeId: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await t.send("DOM.describeNode", { backendNodeId }, sessionId, 5000).catch(() => null);
  const node = r !== null && isRecord(r["node"]) ? r["node"] : null;
  const attrs = node !== null && Array.isArray(node["attributes"]) ? node["attributes"] : [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const k = attrs[i];
    const v = attrs[i + 1];
    if (typeof k === "string" && typeof v === "string") out.set(k.toLowerCase(), v);
  }
  return out;
}

type Tree = { root: AxNode; doc: DocIdentity };

/** Text inputs of a raw AX tree that hold a password-like value (their values are never rendered). */
async function passwordIds(t: Transport, sessionId: string, raw: unknown): Promise<Set<number>> {
  const pw = new Set<number>();
  for (const id of textInputsWithValue(raw)) {
    const at = await nodeAttributes(t, sessionId, id);
    if (isSensitiveField(at.get("type") ?? null, at.get("autocomplete") ?? null)) pw.add(id);
  }
  return pw;
}

export async function axTree(t: Transport, tab: Tab, verbose = false): Promise<Tree> {
  await settle(tab, 10_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await docIdentity(t, tab);
    const raw = await t.send("Accessibility.getFullAXTree", {}, tab.sessionId, 30_000);
    const after = await docIdentity(t, tab);
    if (!sameDoc(before, after)) continue; // navigated mid-snapshot: an old tree must never meet a new document
    const pw = await passwordIds(t, tab.sessionId, raw);
    const root = buildAxTree(raw, pw, { verbose });
    if (root === null) throw new TabcapError("page", "the accessibility tree is empty", "Wait for the page to render (`tabcap screenshot`), then snapshot again.");
    tab.refs.setDocument(after);
    return { root, doc: after };
  }
  throw new TabcapError("page", "the page kept navigating during the snapshot", "Wait a moment and run `tabcap snapshot` again.");
}

export type SnapshotOptions = {
  interactive: boolean;
  verbose: boolean;
  maxChars: number;
  filePath: string | null;
  /** --frames: expand every child frame. */
  frames: boolean;
  /** --frame f2/f1: expand only that frame and its descendants (the root document is listed in the header only). */
  frame: string | null;
  /** 0.5-F: --grep / --css / --xpath / --ref; null or absent: the whole tree. */
  search?: SnapSearch | null;
};

/** 0.5-F snapshot filters (browser/axfilter.ts). */
export type SnapSearch =
  | { mode: "grep"; re: RegExp; query: string; context: number; max: number }
  | { mode: "css" | "xpath"; query: string; context: number; max: number }
  | { mode: "ref"; ref: string; depth: number | null };

export const SNAP_MAX_MATCHES = 50;

function snapSearchOf(a: Args): SnapSearch | null {
  const grep = optStr(a, "grep");
  const css = optStr(a, "css");
  const xpath = optStr(a, "xpath");
  const ref = optStr(a, "ref");
  const given = [grep, css, xpath, ref].filter((x) => x !== null);
  const depth = optNum(a, "depth");
  const context = optNum(a, "context");
  const maxMatches = optNum(a, "maxMatches");
  // --depth / --context / --max-matches without the filter they belong to are ignored
  // (MCP hosts may send every schema default).
  if (given.length === 0) return null;
  if (given.length > 1) throw new TabcapError("usage", "give one of --grep, --css, --xpath and --ref", "e.g. tabcap snapshot --grep 'Add to cart' or tabcap snapshot --css 'form#login'");
  if (ref !== null) return { mode: "ref", ref, depth: depth === null ? null : clampInt(depth, 0, 1000) };
  const ctx = clampInt(context, 0, 20);
  const max = Math.max(1, clampInt(maxMatches, SNAP_MAX_MATCHES, 1000));
  if (grep !== null) return { mode: "grep", re: compileRegex(grep, "--grep"), query: grep, context: ctx, max };
  const flag = css !== null ? "--css" : "--xpath";
  const query = css ?? xpath ?? "";
  if (query.trim() === "") throw new TabcapError("usage", `${flag} needs an expression`, "e.g. --css 'table#t tr' or --xpath '//button'");
  return { mode: css !== null ? "css" : "xpath", query, context: ctx, max };
}

export function snapshotOptions(a: Args): SnapshotOptions {
  const filePath = optStr(a, "filePath");
  const frames = optBool(a, "frames");
  const frame = optStr(a, "frame");
  if (frame !== null) {
    const idx = parseFramePath(frame);
    if (idx === null || idx.length === 0) throw new TabcapError("usage", `--frame ${frame}?`, "Give a frame path from the snapshot header, e.g. --frame f2 or --frame f2/f1.");
    if (frames) throw new TabcapError("usage", "give either --frames (every frame) or --frame <path> (one subtree), not both", "e.g. tabcap snapshot --frames, or tabcap snapshot --frame f2/f1");
  }
  return {
    interactive: optBool(a, "interactive"),
    verbose: optBool(a, "verbose"),
    maxChars: Math.max(1000, Math.min(optNum(a, "maxChars") ?? SNAPSHOT_MAX_CHARS, 4_000_000)),
    filePath: filePath === null || filePath === "" ? null : resolve(filePath),
    frames,
    frame,
    search: snapSearchOf(a),
  };
}

/** One child frame's tree with its frame-path ref minting (Accessibility.getFullAXTree of that frame through its session), or why not. */
async function frameView(t: Transport, tab: Tab, f: FrameNode, o: SnapshotOptions): Promise<{ view: AxNode; refFor: RefFor } | string> {
  try {
    const raw = await t.send("Accessibility.getFullAXTree", { frameId: f.frameId }, f.sessionId, 30_000);
    const root = buildAxTree(raw, await passwordIds(t, f.sessionId, raw), { verbose: o.verbose });
    if (root === null) return "(empty)";
    const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
    const binding: FrameBinding = bindingOf(f);
    return { view, refFor: (id) => tab.refs.refFor(id, binding) };
  } catch (e) {
    return `(unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
  }
}

/** One child frame's tree with frame-path refs. */
async function frameRendered(t: Transport, tab: Tab, f: FrameNode, o: SnapshotOptions): Promise<Rendered | string> {
  const v = await frameView(t, tab, f, o);
  return typeof v === "string" ? v : renderAxTree(v.view, v.refFor, Number.MAX_SAFE_INTEGER);
}

type FrameTreeResult = Awaited<ReturnType<typeof frameTree>>;

/** The child frames a snapshot expands: --frame <path> and its descendants, every frame with --frames, else none. */
function framesToExpand(tab: Tab, o: SnapshotOptions, tree: FrameTreeResult | null): FrameNode[] {
  if (o.frame !== null) {
    const sub = tree === null ? null : frameAt(tree.root, o.frame);
    if (sub === null) throw new TabcapError("not-found", `no frame ${o.frame} on tab ${tab.id}`, "Run `tabcap snapshot` and pick a frame path from its `frames` header lines.");
    return [sub, ...descendants(sub)];
  }
  return o.frames && tree !== null ? descendants(tree.root) : [];
}

const frameDocOf = (f: FrameNode): FrameDoc => ({ frameId: f.frameId, loaderId: f.loaderId, url: f.url, sessionId: f.sessionId });

const NO_AX = "(no accessible node)";
const SELECT_GROUP = "tabcap-select";

// --css / --xpath in one document, run in tabcap's isolated world (read-only):
// [total, JSON labels, ...the first `cap` nodes]; attribute nodes (XPath @x)
// stand for their element. Labels are `tag#id.class` for nodes without an AX line.
const SELECT_FN = `function (mode, q, cap) {
  let list = [];
  if (mode === "css") list = Array.from(document.querySelectorAll(q));
  else {
    const r = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < r.snapshotLength; i++) list.push(r.snapshotItem(i));
  }
  const nodes = list.slice(0, cap).map((n) => (n && n.nodeType === 2 ? n.ownerElement : n));
  const label = (n) => {
    if (!n) return "?";
    if (n.nodeType === 3) return "#text";
    if (n.nodeType !== 1) return String(n.nodeName).toLowerCase();
    let s = n.localName;
    if (n.id) s += "#" + n.id;
    for (const c of Array.from(n.classList).slice(0, 4)) s += "." + c;
    return s.slice(0, 200);
  };
  return [list.length, JSON.stringify(nodes.map(label)), ...nodes];
}`;

type Selected = { total: number; nodes: Array<{ backendId: number | null; label: string }> };

/** The DOM nodes a --css / --xpath expression selects in one document: their backend node ids (the AX tree's key) and labels. */
async function selectNodes(t: Transport, tab: Tab, fdoc: FrameDoc, mode: "css" | "xpath", query: string, cap: number): Promise<Selected> {
  return inWorld(t, tab, fdoc, async (ctx) => {
    const r = await t.send(
      "Runtime.callFunctionOn",
      { functionDeclaration: SELECT_FN, executionContextId: ctx, arguments: [{ value: mode }, { value: query }, { value: cap }], returnByValue: false, objectGroup: SELECT_GROUP },
      fdoc.sessionId,
      10_000,
    );
    try {
      const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
      if (ex !== null) {
        const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
        const why = (str(exc, "description") ?? str(ex, "text") ?? "exception").split("\n")[0] ?? "";
        throw new TabcapError("usage", `--${mode} ${query.slice(0, 200)}: ${why.slice(0, 300)}`, mode === "css" ? "Give a CSS selector document.querySelectorAll accepts, e.g. --css 'table#t td'." : "Give an XPath 1.0 expression that selects nodes, e.g. --xpath '//table//td[1]'.");
      }
      const res = isRecord(r["result"]) ? r["result"] : {};
      const oid = str(res, "objectId");
      if (oid === null) return { total: 0, nodes: [] };
      const props = await t.send("Runtime.getProperties", { objectId: oid, ownProperties: true }, fdoc.sessionId, 10_000);
      const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
      const at = (i: number): Record<string, unknown> | null => {
        const p = list.find((x) => x["name"] === String(i));
        return p !== undefined && isRecord(p["value"]) ? p["value"] : null;
      };
      const total = num(at(0) ?? {}, "value") ?? 0;
      let labels: unknown = [];
      try {
        labels = JSON.parse(str(at(1) ?? {}, "value") ?? "[]");
      } catch {
        labels = [];
      }
      const names = Array.isArray(labels) ? labels.map((x) => (typeof x === "string" ? x : "?")) : [];
      const nodes: Selected["nodes"] = [];
      for (let i = 0; i < names.length; i++) {
        const nodeOid = str(at(i + 2) ?? {}, "objectId");
        let backendId: number | null = null;
        if (nodeOid !== null) {
          const dn = await t.send("DOM.describeNode", { objectId: nodeOid }, fdoc.sessionId, 5000).catch(() => null);
          const node = dn !== null && isRecord(dn["node"]) ? dn["node"] : null;
          const id = node === null ? null : node["backendNodeId"];
          backendId = typeof id === "number" && Number.isSafeInteger(id) ? id : null;
        }
        nodes.push({ backendId, label: names[i] ?? "?" });
      }
      return { total, nodes };
    } finally {
      await t.send("Runtime.releaseObjectGroup", { objectGroup: SELECT_GROUP }, fdoc.sessionId, 5000).catch(() => null);
    }
  });
}

/** The error for a ref the table cannot resolve (shared by resolveRef and snapshot --ref). */
function refError(tab: Tab, ref: string, reason: "unknown" | "expired" | "malformed"): TabcapError {
  if (reason === "malformed") return new TabcapError("usage", `not a ref: ${ref}`, "Refs look like e12, or f2/e7 for an element in a frame; get them from `tabcap snapshot` (`--frames` expands frames) or `tabcap find`.");
  if (reason === "unknown") {
    const p = parseRef(ref);
    const as = p === null ? null : tab.refs.minted(p.n);
    if (as !== null) return new TabcapError("stale-ref", `ref ${ref} is unknown on tab ${tab.id}; e${p?.n ?? ""} was given out as ${as}`, `Use ${as} (the frame path is part of the ref), or run snapshot again.`);
  }
  const why = reason === "unknown" ? `ref ${ref} is unknown on tab ${tab.id}` : `ref ${ref} expired: the document changed since the snapshot`;
  return new TabcapError("stale-ref", why, "run snapshot again (`tabcap snapshot --interactive`) and use the new ref.");
}

type Block = { head: string | null; view: AxNode | null; note: string; refFor: RefFor; fdoc: FrameDoc };

/** 0.5-F: a snapshot filtered by --grep / --css / --xpath / --ref; the header and the ref table are the full snapshot's. */
async function renderFiltered(d: Daemon, t: Transport, tab: Tab, o: SnapshotOptions, q: SnapSearch, docs: { root: AxNode; doc: DocIdentity; view: AxNode; tree: FrameTreeResult | null }): Promise<Record<string, unknown>> {
  const { root, doc, view, tree } = docs;
  const rootBlock: Block = { head: null, view, note: "", refFor: (id) => tab.refs.refFor(id), fdoc: rootDoc(tab, doc) };
  const blocks: Block[] = [];
  let refTarget: number | null = null;
  if (q.mode === "ref") {
    // The ref decides the document: its own frame (no --frames needed), else the root document.
    const look = tab.refs.lookup(q.ref, doc);
    if (!look.ok) throw refError(tab, q.ref, look.reason);
    refTarget = look.backendNodeId;
    if (look.frame === null) blocks.push(rootBlock);
    else {
      const f = tree === null ? null : frameAt(tree.root, look.frame.path);
      if (f === null || f.frameId !== look.frame.frameId || f.loaderId !== look.frame.loaderId) {
        throw new TabcapError("stale-ref", `ref ${q.ref} expired: frame ${look.frame.path} changed since the snapshot (it navigated, reloaded or was removed)`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
      }
      const v = await frameView(t, tab, f, o);
      if (typeof v === "string") throw new TabcapError("page", `frame ${f.path} has no tree: ${v}`, "Wait for the frame to load, then snapshot again.");
      blocks.push({ head: `frame ${frameLine(f)}`, view: v.view, note: "", refFor: v.refFor, fdoc: frameDocOf(f) });
    }
  } else {
    if (o.frame === null) blocks.push(rootBlock);
    for (const f of framesToExpand(tab, o, tree)) {
      const v = await frameView(t, tab, f, o);
      const head = `frame ${frameLine(f)}`;
      blocks.push(typeof v === "string" ? { head, view: null, note: v, refFor: rootBlock.refFor, fdoc: frameDocOf(f) } : { head, view: v.view, note: "", refFor: v.refFor, fdoc: frameDocOf(f) });
    }
  }
  // Refs are minted for whole documents in the full snapshot's order (root, frames), then the header's.
  let refs = 0;
  let budget = q.mode === "ref" ? 0 : q.max;
  let total = 0;
  let shown = 0;
  let noAccessible = 0;
  let domRefs = 0;
  let hidden = 0;
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.view === null) {
      texts.push(`${b.head ?? ""}\n${b.note}`);
      continue;
    }
    const flat = flattenAx(b.view, b.refFor);
    refs += flat.refs;
    if (q.mode === "ref") {
      const i = flat.lines.findIndex((l) => l.backendId === refTarget);
      if (i < 0) throw new TabcapError("not-found", `ref ${q.ref} has no line in the current tree${o.interactive ? " (--interactive keeps controls only)" : ""}`, o.interactive ? "Drop --interactive, or run snapshot again." : `The element is not in the accessibility tree (a DOM-backed ref from --css / --xpath has no line): \`tabcap html ${q.ref}\` shows its markup, or run snapshot again.`);
      const sub = subtreeLines(flat.lines, i, q.depth);
      shown = sub.shown;
      hidden = sub.hidden;
      texts.push(b.head === null ? sub.text : `${b.head}\n${sub.text}`);
      continue;
    }
    let take: number[];
    let missing: string[] = [];
    if (q.mode === "grep") {
      const hits = grepAx(flat.lines, q.re);
      total += hits.length;
      take = hits.slice(0, budget);
      budget -= take.length;
      shown += take.length;
    } else {
      // Each selected node is one match: its AX line(s), or a "(no accessible node)" line.
      const sel = await selectNodes(t, tab, b.fdoc, q.mode, q.query, budget);
      total += sel.total;
      budget -= sel.nodes.length;
      shown += sel.nodes.length;
      const r = nodesAx(flat.lines, sel.nodes.flatMap((n) => (n.backendId === null ? [] : [n.backendId])));
      take = r.hits;
      const lost = new Set(r.missing);
      // 0.6-D: a node without an AX line still gets a ref, bound to its backend node id (a DOM-backed ref, same table and expiry).
      missing = sel.nodes
        .filter((n) => n.backendId === null || lost.has(n.backendId))
        .map((n) => {
          if (n.backendId === null) return `<${n.label}>`;
          domRefs++;
          return `<${n.label}> [${b.refFor(n.backendId)}]`;
        });
      noAccessible += missing.length;
    }
    if (take.length === 0 && missing.length === 0) continue;
    const body = [pickLines(flat.lines, take, q.context), ...missing.map((l) => `- ${NO_AX} ${l}`)].filter((x) => x !== "").join("\n");
    texts.push(b.head === null ? body : `${b.head}\n${body}`);
  }
  const page = await inspectPage(t, tab, rootDoc(tab, doc), undefined, tree === null ? null : tree.root);
  const frameLines = tree === null ? ["frames    ? (the frame tree could not be read)"] : frameHeaderLines(tree.root, tree.omitted);
  const header = cutText([...headerLines(page), ...frameLines].join("\n"), Math.floor(o.maxChars / 2)).text;
  const frames = tree === null ? [] : frameList(tree.root);
  const notes: string[] = [];
  let search: Record<string, unknown>;
  if (q.mode === "ref") {
    search = { mode: "ref", ref: q.ref, depth: q.depth, shown, hidden };
    if (hidden > 0) notes.push(`${hidden} deeper line(s) hidden: raise --depth`);
  } else {
    search = { mode: q.mode, query: q.query, matches: total, shown, context: q.context, ...(q.mode === "grep" ? {} : { noAccessible, domRefs }) };
    if (total > shown) notes.push(`${total - shown} more match(es): raise --max-matches (max 1000) or narrow the ${q.mode === "grep" ? "pattern" : "expression"}`);
    if (noAccessible > 0) notes.push(`${noAccessible} node(s) have no accessibility line; ${domRefs} of them got a DOM-backed ref (click, fill, hover, upload, html, screenshot --ref take it; it expires like any ref)`);
  }
  const text = [header, ...(texts.length === 0 ? ["(no matches)"] : texts)].join("\n");
  const head = {
    tab: tab.id,
    url: doc.url,
    title: root.name,
    nav: d.navOf(tab),
    interactive: o.interactive,
    verbose: o.verbose,
    refs: refs + domRefs,
    overlays: page.overlays,
    detected: (page.detected ?? []).filter((x) => x.confidence > 0),
    ...(frames.length > 0 ? { frames } : {}),
    ...(o.frame === null ? {} : { frame: o.frame }),
    search,
  };
  if (o.filePath !== null) {
    mkdirSync(dirname(o.filePath), { recursive: true });
    writeFileSync(o.filePath, `${text}\n`, { mode: 0o600 });
    return { ...head, chars: text.length + 1, truncated: total > shown || hidden > 0, path: o.filePath, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
  }
  const cut = cutText(text, o.maxChars);
  if (cut.truncated) notes.push(`truncated at ${o.maxChars} chars (${text.length} in all); raise --max-chars, use --file-path or narrow the filter`);
  return { ...head, chars: text.length, truncated: cut.truncated || total > shown || hidden > 0, ...(notes.length > 0 ? { note: notes.join("; ") } : {}), tree: cut.text };
}

/**
 * The snapshot of one tab, for `snapshot` and for `--snapshot` on the
 * interactive commands. Call it inside the tab's job (Tabs.run), never around it.
 */
export async function renderSnapshot(d: Daemon, t: Transport, tab: Tab, o: SnapshotOptions): Promise<Record<string, unknown>> {
  const { root, doc } = await axTree(t, tab, o.verbose);
  const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
  const tree = await frameTree(t, tab).catch(() => null);
  if (o.search !== undefined && o.search !== null) return renderFiltered(d, t, tab, o, o.search, { root, doc, view, tree });
  const expand = framesToExpand(tab, o, tree);
  // Refs are minted in document order: the root tree, the expanded frames, then the header's close-button refs.
  const full = o.frame === null ? renderAxTree(view, (id) => tab.refs.refFor(id), Number.MAX_SAFE_INTEGER) : null;
  const blocks: Array<{ head: string; body: Rendered | string }> = [];
  for (const f of expand) blocks.push({ head: `frame ${frameLine(f)}`, body: await frameRendered(t, tab, f, o) });
  const page = await inspectPage(t, tab, rootDoc(tab, doc), undefined, tree === null ? null : tree.root);
  // docs/09 §2.3: overlays first, then the frame tree. The header counts toward --max-chars (at most half of it).
  const frameLines = tree === null ? ["frames    ? (the frame tree could not be read)"] : frameHeaderLines(tree.root, tree.omitted);
  const header = cutText([...headerLines(page), ...frameLines].join("\n"), Math.floor(o.maxChars / 2)).text;
  const refs = (full?.refs ?? 0) + blocks.reduce((n, b) => n + (typeof b.body === "string" ? 0 : b.body.refs), 0);
  const frames = tree === null ? [] : frameList(tree.root);
  const head = {
    tab: tab.id,
    url: doc.url,
    title: root.name,
    nav: d.navOf(tab),
    interactive: o.interactive,
    verbose: o.verbose,
    refs,
    overlays: page.overlays,
    detected: (page.detected ?? []).filter((x) => x.confidence > 0),
    // Only pages with child frames carry the list (a page without frames answers as before 0.4-I).
    ...(frames.length > 0 ? { frames } : {}),
    ...(o.frame === null ? {} : { frame: o.frame }),
  };
  const blockText = (b: { head: string; body: Rendered | string }, max: number): { text: string; truncated: boolean; chars: number } => {
    if (typeof b.body === "string") return { text: `${b.head}\n${b.body}`, truncated: false, chars: b.head.length + 1 + b.body.length };
    const cut = cutText(b.body.text, max);
    return { text: `${b.head}\n${cut.text}${cut.truncated ? "\n(truncated)" : ""}`, truncated: cut.truncated, chars: b.head.length + 1 + b.body.chars };
  };
  if (o.filePath !== null) {
    // --file-path: the whole tree goes to the file (no --max-chars cut), the answer carries the path.
    const parts = [header, ...(full === null ? [] : [full.text]), ...blocks.map((b) => blockText(b, Number.MAX_SAFE_INTEGER).text)];
    const text = `${parts.join("\n")}\n`;
    mkdirSync(dirname(o.filePath), { recursive: true });
    writeFileSync(o.filePath, text, { mode: 0o600 });
    return { ...head, chars: text.length, truncated: false, path: o.filePath };
  }
  const body = full === null ? null : cutText(full.text, o.maxChars - header.length - 1);
  // The size limit applies per frame: each expanded frame may use --max-chars on its own.
  const frameTexts = blocks.map((b) => blockText(b, o.maxChars));
  const chars = header.length + (full === null ? 0 : 1 + full.chars) + frameTexts.reduce((n, x) => n + 1 + x.chars, 0);
  const truncated = (body?.truncated ?? false) || frameTexts.some((x) => x.truncated);
  return {
    ...head,
    chars,
    truncated,
    ...(truncated ? { note: `truncated at ${o.maxChars} chars per document (${chars} in all); for more: --max-chars <n>, --interactive (controls only), --frame <path> (one frame), --file-path <f> (whole tree to a file) or tabcap find <text>` } : {}),
    tree: [header, ...(body === null ? [] : [body.text]), ...frameTexts.map((x) => x.text)].join("\n"),
  };
}

export async function snapshot(d: Daemon, a: Args, session: string): Promise<unknown> {
  const o = snapshotOptions(a);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(tab, () => renderSnapshot(d, t, tab, o), { timeoutMs: timeoutOf(a) });
}

/** `--snapshot` on an interactive command: a default snapshot taken after the action (and its wait). */
export async function snapshotAfter(d: Daemon, t: Transport, tab: Tab, a: Args): Promise<Record<string, unknown>> {
  if (!optBool(a, "snapshot")) return {};
  const { tab: _tab, ...snap } = await renderSnapshot(d, t, tab, { interactive: false, verbose: false, maxChars: SNAPSHOT_MAX_CHARS, filePath: null, frames: false, frame: null });
  return { snapshot: snap };
}

/** Hits returned / candidates looked at / candidates whose DOM is probed for clickability. */
const FIND_LIMIT = 20;
const FIND_SCAN = 200;
const FIND_PROBE = 60;

// Walk up from the hit (text → its element) at most 4 elements, stopping at
// <body>: the first one that is a native control, has a clickable role or an
// onclick attribute ("tag"), or shows cursor:pointer ("cursor"). Returns its depth.
const CLICKABLE_UP_FN = `function () {
  const TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY", "OPTION"]);
  const ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "textbox", "combobox"]);
  let el = this.nodeType === 1 ? this : this.parentElement;
  for (let depth = 0; el && depth < 4 && el !== document.body && el !== document.documentElement; depth++, el = el.parentElement) {
    if (TAGS.has(el.tagName) || ROLES.has(el.getAttribute("role") || "") || el.hasAttribute("onclick")) return { depth, by: "tag" };
    if (getComputedStyle(el).cursor === "pointer") return { depth, by: "cursor" };
  }
  return null;
}`;
const ANCESTOR_FN = `function (depth) {
  let el = this.nodeType === 1 ? this : this.parentElement;
  for (let i = 0; el && i < depth; i++) el = el.parentElement;
  return el && el !== document.body && el !== document.documentElement ? el : null;
}`;
const CLICK_EVENTS = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup"]);

async function ancestorId(t: Transport, sessionId: string, objectId: string, depth: number): Promise<{ objectId: string; backendNodeId: number } | null> {
  const r = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: ANCESTOR_FN, arguments: [{ value: depth }], returnByValue: false }, sessionId, 5000);
  const res = isRecord(r["result"]) ? r["result"] : null;
  const oid = res === null ? null : str(res, "objectId");
  if (oid === null) return null;
  const d = await t.send("DOM.describeNode", { objectId: oid }, sessionId, 5000);
  const node = isRecord(d["node"]) ? d["node"] : null;
  const id = node === null ? null : node["backendNodeId"];
  return typeof id === "number" && Number.isSafeInteger(id) ? { objectId: oid, backendNodeId: id } : null;
}

/**
 * The DOM element a click on this AX hit should go to, when the AX tree has no
 * control for it (custom checkboxes, `div role=none` buttons, docs/05 s19):
 * a native control / clickable role / cursor:pointer within 4 levels, else an
 * element within 3 levels with a click-type listener (DOMDebugger.getEventListeners).
 * `sessionId`: the session that owns the node's document (a frame's, 0.6-D).
 */
async function domClickable(t: Transport, sessionId: string, backendNodeId: number): Promise<{ backendId: number; by: string } | null> {
  const r = await t.send("DOM.resolveNode", { backendNodeId }, sessionId, 5000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) return null;
  const up = callResult(await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CLICKABLE_UP_FN, returnByValue: true }, sessionId, 5000));
  if (isRecord(up) && typeof up["depth"] === "number") {
    const el = await ancestorId(t, sessionId, objectId, up["depth"]);
    return el === null ? null : { backendId: el.backendNodeId, by: str(up, "by") ?? "tag" };
  }
  for (let depth = 0; depth < 3; depth++) {
    const el = await ancestorId(t, sessionId, objectId, depth);
    if (el === null) return null;
    const l = await t.send("DOMDebugger.getEventListeners", { objectId: el.objectId }, sessionId, 5000).catch(() => null);
    const list = l !== null && Array.isArray(l["listeners"]) ? l["listeners"].filter(isRecord) : [];
    if (list.some((x) => CLICK_EVENTS.has(str(x, "type") ?? ""))) return { backendId: el.backendNodeId, by: "listener" };
  }
  return null;
}

/** One document `find` searches: the root (frame null) or a child frame, with its ref minting and session. */
type FindDoc = { frame: FrameNode | null; root: AxNode; refFor: RefFor; sessionId: string };

/**
 * `find <text>` (0.6-D): the root document and every child frame of the frame
 * tree (0.4-I), in tree order; hits in a frame carry `frame` and frame-path
 * refs. A frame whose tree cannot be read is skipped and counted in
 * `framesSkipped`. Clickable hits first over all documents, document order otherwise.
 */
export async function find(d: Daemon, a: Args, session: string): Promise<unknown> {
  const text = reqStr(a, "text", "tabcap find <text>");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      const { root, doc } = await axTree(t, tab);
      const docs: FindDoc[] = [{ frame: null, root, refFor: (id) => tab.refs.refFor(id), sessionId: tab.sessionId }];
      const tree = await frameTree(t, tab).catch(() => null);
      let skipped = 0;
      for (const f of tree === null ? [] : descendants(tree.root)) {
        const v = await frameView(t, tab, f, { interactive: false, verbose: false, maxChars: SNAPSHOT_MAX_CHARS, filePath: null, frames: false, frame: null });
        if (typeof v === "string") {
          skipped++;
          continue;
        }
        docs.push({ frame: f, root: v.view, refFor: v.refFor, sessionId: f.sessionId });
      }
      type Cand = { c: FindCandidate; doc: FindDoc };
      const cands: Cand[] = [];
      let total = 0;
      for (const x of docs) {
        const r = findCandidates(x.root, text, Math.max(0, FIND_SCAN - cands.length));
        total += r.total;
        for (const c of r.cands) cands.push({ c, doc: x });
      }
      // docs/05 s19: clickable hits first (AX controls, then DOM signals), document order otherwise.
      const dom = new Map<Cand, { backendId: number; by: string }>();
      let probed = 0;
      for (const x of cands) {
        if (x.c.clickId !== null || x.c.node.backendId === null || probed >= FIND_PROBE) continue;
        probed++;
        const hit = await domClickable(t, x.doc.sessionId, x.c.node.backendId).catch(() => null);
        if (hit !== null) dom.set(x, hit);
      }
      const ranked = rankClickable(cands, (x) => x.c.clickId !== null || dom.has(x));
      const hits = ranked.slice(0, FIND_LIMIT).map((x) => ({ ...hitOf(x.c, x.doc.refFor, dom.get(x) ?? null), ...(x.doc.frame === null ? {} : { frame: x.doc.frame.path }) }));
      const frames = docs.length - 1;
      return {
        tab: tab.id,
        url: doc.url,
        nav: d.navOf(tab),
        query: text,
        total,
        order: "clickable first, then document order",
        ...(frames + skipped > 0 ? { frames, ...(skipped > 0 ? { framesSkipped: skipped } : {}) } : {}),
        hits,
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

/** A resolved ref: a live JS object of the node in its own document, and the CDP session that owns that document. */
export type RefNode = {
  objectId: string;
  backendNodeId: number;
  /** The session to send every command about this node to (the tab's, or an out-of-process iframe's). */
  sessionId: string;
  /** The child frame the node is in; null: the root document. */
  frame: FrameBinding | null;
};

/** Is the frame a ref was minted in still showing the same document? */
async function frameCurrent(t: Transport, tab: Tab, f: FrameBinding): Promise<boolean> {
  if (f.sessionId !== tab.sessionId && !t.targets().some((x) => x.sessionId === f.sessionId)) return false;
  const r = await t.send("Page.getFrameTree", {}, f.sessionId, 5000).catch(() => null);
  return framesOfTree(r, f.sessionId, false).some((x) => x.frameId === f.frameId && x.loaderId === f.loaderId);
}

/** Resolve `e<n>` / `f<n>/…/e<m>` to a live JS object of the node, or a stale-ref error saying what to do. */
/**
 * Resolve `e<n>` / `f<n>/…/e<m>` to a live JS object of the node, or a stale-ref error saying what to do.
 * `isolated`: the object lives in tabcap's isolated world of that document (0.5-F `html`), so
 * functions called on it never run page code; otherwise the page's main world.
 */
export async function resolveRef(t: Transport, tab: Tab, ref: string, opts: { isolated?: boolean } = {}): Promise<RefNode> {
  const doc = await docIdentity(t, tab);
  const look = tab.refs.lookup(ref, doc);
  if (!look.ok) throw refError(tab, ref, look.reason);
  const sessionId = look.frame === null ? tab.sessionId : look.frame.sessionId;
  if (look.frame !== null && !(await frameCurrent(t, tab, look.frame))) {
    throw new TabcapError("stale-ref", `ref ${ref} expired: frame ${look.frame.path} changed since the snapshot (it navigated, reloaded or was removed)`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
  }
  const backendNodeId = look.backendNodeId;
  let r: Record<string, unknown> | null;
  if (opts.isolated === true) {
    const fdoc: FrameDoc = look.frame === null ? rootDoc(tab, doc) : { frameId: look.frame.frameId, loaderId: look.frame.loaderId, url: "", sessionId };
    r = await inWorld(t, tab, fdoc, (ctx) => t.send("DOM.resolveNode", { backendNodeId, executionContextId: ctx }, sessionId, 10_000)).catch(() => null);
  } else r = await t.send("DOM.resolveNode", { backendNodeId }, sessionId, 10_000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) throw new TabcapError("stale-ref", `ref ${ref} is no longer in the page`, "run snapshot again; the element was removed or re-rendered.");
  return { objectId, backendNodeId, sessionId, frame: look.frame };
}

/** Value of a by-value Runtime.callFunctionOn result, or a page error for exceptions. */
export function callResult(r: Record<string, unknown>): unknown {
  const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
  if (ex !== null) {
    const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
    throw new TabcapError("page", `page script failed: ${(str(exc, "description") ?? str(ex, "text") ?? "exception").slice(0, 500)}`, "run snapshot again and retry; the element may have changed.");
  }
  const res = isRecord(r["result"]) ? r["result"] : {};
  return res["value"];
}

