// tabcap snapshot | find. Ref resolution shared with click / fill lives in
// browser/doc.ts.
// 0.4-I: the frame tree is in the header (`frames` lines); `--frames` expands
// every child frame's tree with frame-path refs (`f2/f1/e7`), `--frame f2/f1`
// only that subtree. Refs resolve in the document they were minted in.
// 0.5-F: `--grep` / `--css` / `--xpath` / `--ref --depth` print only part of
// the tree (browser/axfilter.ts); the header and the ref table stay those of
// the full snapshot.

import { readTab } from "./readtab.ts";
import { protectionField } from "../protection/live.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { markLanding } from "./landing.ts";
import { LAYOUT_STYLES, parseLayout, type PageLayout } from "../browser/layout.ts";
import { log } from "../../shared/log.ts";
import { applyLayout, countLines, nameRows, splitLayer, buildAxTree, findCandidates, hitOf, interactiveOnly, rankClickable, renderAxTree, textInputsWithValue, type AxNode, type FindCandidate, type RefFor, type Rendered } from "../browser/ax.ts";
import { flattenAx, grepAx, nodesAx, pickLines, subtreeLines } from "../browser/axfilter.ts";
import { inspectPage } from "../adapters/runtime.ts";
import { cutText, headerLines, type Overlay } from "../adapters/view.ts";
import { bindingOf, descendants, frameAt, frameHeaderLines, frameLine, frameList, frameTree, type FrameNode } from "../browser/frames.ts";
import { parseFramePath, sameDoc, type DocIdentity, type FrameBinding } from "../browser/refs.ts";
import { callResult, docIdentity, refError, settle } from "../browser/doc.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Tab } from "../browser/targets.ts";
import { isSensitiveField } from "../secrets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { clampInt, compileRegex } from "./textsearch.ts";
import { adviseChallenge } from "./challenge.ts";

/** Default `--max-chars` of `snapshot` (and of `--snapshot` on actions): 0.5-C context budget, owner 10-16. */
export const SNAPSHOT_MAX_CHARS = 12_000;

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

type Tree = { root: AxNode; doc: DocIdentity; layout: PageLayout };

/** docs/04 §53.3: one DOMSnapshot of the session's documents (browser/layout.ts); empty (nothing filtered) when it fails. */
export async function pageLayout(t: Transport, sessionId: string): Promise<PageLayout> {
  try {
    const raw = await t.send("DOMSnapshot.captureSnapshot", { computedStyles: [...LAYOUT_STYLES], includeDOMRects: false, includePaintOrder: false }, sessionId, 30_000);
    return parseLayout(raw);
  } catch (e) {
    log.info("snapshot: DOMSnapshot failed, visibility not checked", { error: e instanceof Error ? e.message : String(e) });
    return new Map();
  }
}

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
    const layout = await pageLayout(t, tab.sessionId);
    const after = await docIdentity(t, tab);
    if (!sameDoc(before, after)) continue; // navigated mid-snapshot: an old tree must never meet a new document
    const pw = await passwordIds(t, tab.sessionId, raw);
    const built = buildAxTree(raw, pw, { verbose });
    const root = built === null ? null : applyLayout(built, layout, verbose);
    if (root !== null) nameRows(root, layout);
    if (root === null) throw new TabcapError("page", "the accessibility tree is empty", "Wait for the page to render (`tabcap screenshot`), then snapshot again.");
    tab.refs.setDocument(after);
    return { root, doc: after, layout };
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
  /** docs/04 §53.3: with a modal overlay, also show what is behind it (default: folded to one line). */
  behind?: boolean;
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
    behind: optBool(a, "behind"),
  };
}

/** One child frame's tree with its frame-path ref minting (Accessibility.getFullAXTree of that frame through its session), or why not. */
async function frameView(t: Transport, tab: Tab, f: FrameNode, o: SnapshotOptions): Promise<{ view: AxNode; refFor: RefFor } | string> {
  try {
    const raw = await t.send("Accessibility.getFullAXTree", { frameId: f.frameId }, f.sessionId, 30_000);
    const built = buildAxTree(raw, await passwordIds(t, f.sessionId, raw), { verbose: o.verbose });
    const flayout = await pageLayout(t, f.sessionId);
    const root = built === null ? null : applyLayout(built, flayout, o.verbose);
    if (root !== null) nameRows(root, flayout);
    if (root === null) return "(empty)";
    const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
    // 0.6-J: controls whose click lands on a descendant get `landing="child"`.
    if (o.interactive) await markLanding(t, tab, frameDocOf(f), view);
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
    ...(page.challenge === undefined || page.challenge === null ? {} : { challenge: page.challenge }),
    ...(frames.length > 0 ? { frames } : {}),
    ...(o.frame === null ? {} : { frame: o.frame }),
    search,
  };
  await adviseChallenge(d, t, tab, page.challenge);
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
  const { root, doc, layout } = await axTree(t, tab, o.verbose);
  const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
  // 0.6-J: controls whose click lands on a descendant get `landing="child"` (the root document's, when it is shown).
  if (o.interactive && o.frame === null) await markLanding(t, tab, rootDoc(tab, doc), view);
  const tree = await frameTree(t, tab).catch(() => null);
  if (o.search !== undefined && o.search !== null) return renderFiltered(d, t, tab, o, o.search, { root, doc, view, tree });
  const expand = framesToExpand(tab, o, tree);
  // docs/04 §53.2: the overlays are known before the tree is drawn (the top one goes first),
  // so refs are minted header first (overlay elements, close buttons), then the tree, then the frames.
  const page = await inspectPage(t, tab, rootDoc(tab, doc), undefined, tree === null ? null : tree.root);
  const top = o.frame === null ? topLayer(tab, doc, page.overlays, view, layout) : null;
  const refFor: RefFor = (id) => tab.refs.refFor(id);
  let full: Rendered | null = null;
  let layerText: string | null = null;
  const order: string[] = [];
  let folded: { overlay: string; lines: number } | null = null;
  if (o.frame === null && top === null) full = renderAxTree(view, refFor, Number.MAX_SAFE_INTEGER);
  else if (top !== null) {
    const parts = top.layer.map((n) => renderAxTree(n, refFor, Number.MAX_SAFE_INTEGER));
    layerText = parts.map((p) => p.text).join("\n");
    order.push(`order     ${top.overlay.id} first`);
    const fold = top.overlay.modal && o.behind !== true;
    if (fold) {
      const n = countLines(top.rest);
      const line = `… ${n} lines behind ${top.overlay.id} (--behind to show)`;
      folded = { overlay: top.overlay.id, lines: n };
      full = { text: line, truncated: false, chars: line.length, refs: 0 };
    } else full = renderAxTree(top.rest, refFor, Number.MAX_SAFE_INTEGER);
    full = { ...full, refs: full.refs + parts.reduce((n, p) => n + p.refs, 0) };
  }
  const blocks: Array<{ head: string; body: Rendered | string }> = [];
  for (const f of expand) blocks.push({ head: `frame ${frameLine(f)}`, body: await frameRendered(t, tab, f, o) });
  // docs/09 §2.3: overlays first, then the frame tree. The header counts toward --max-chars (at most half of it).
  const frameLines = tree === null ? ["frames    ? (the frame tree could not be read)"] : frameHeaderLines(tree.root, tree.omitted);
  const header = cutText([...headerLines(page), ...order, ...frameLines].join("\n"), Math.floor(o.maxChars / 2)).text;
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
    // 0.6-D: an image captcha advisory, only when there is one.
    ...(page.challenge === undefined || page.challenge === null ? {} : { challenge: page.challenge }),
    // Only pages with child frames carry the list (a page without frames answers as before 0.4-I).
    ...(frames.length > 0 ? { frames } : {}),
    ...(o.frame === null ? {} : { frame: o.frame }),
    // 0.8-A: identified protection families (≥ 50), probed once per navigation (docs/04 §41.3).
    ...(await protectionField(d, t, tab)),
    // docs/04 §53.2 / §53.3: the top overlay's lines come first; behind a modal one the rest is folded.
    ...(top === null ? {} : { first: top.overlay.id }),
    ...(folded === null ? {} : { behind: folded }),
  };
  await adviseChallenge(d, t, tab, page.challenge);
  const blockText = (b: { head: string; body: Rendered | string }, max: number): { text: string; truncated: boolean; chars: number } => {
    if (typeof b.body === "string") return { text: `${b.head}\n${b.body}`, truncated: false, chars: b.head.length + 1 + b.body.length };
    const cut = cutText(b.body.text, max);
    return { text: `${b.head}\n${cut.text}${cut.truncated ? "\n(truncated)" : ""}`, truncated: cut.truncated, chars: b.head.length + 1 + b.body.chars };
  };
  if (o.filePath !== null) {
    // --file-path: the whole tree goes to the file (no --max-chars cut), the answer carries the path.
    const parts = [header, ...(layerText === null ? [] : [layerText]), ...(full === null ? [] : [full.text]), ...blocks.map((b) => blockText(b, Number.MAX_SAFE_INTEGER).text)];
    const text = `${parts.join("\n")}\n`;
    mkdirSync(dirname(o.filePath), { recursive: true });
    writeFileSync(o.filePath, text, { mode: 0o600 });
    return { ...head, chars: text.length, truncated: false, path: o.filePath };
  }
  // docs/04 §53.2: the top overlay's lines are cut last; the rest of the tree gives way first.
  const budget = o.maxChars - header.length - 1;
  const layerCut = layerText === null ? null : cutText(layerText, budget);
  const restBudget = layerCut === null ? budget : budget - layerCut.text.length - 1;
  const restCut = full === null ? null : cutText(full.text, Math.max(0, restBudget));
  const body = layerCut === null && restCut === null ? null : { text: [...(layerCut === null ? [] : [layerCut.text]), ...(restCut === null || restCut.text === "" ? [] : [restCut.text])].join("\n"), truncated: (layerCut?.truncated ?? false) || (restCut?.truncated ?? false) };
  // The size limit applies per frame: each expanded frame may use --max-chars on its own.
  const frameTexts = blocks.map((b) => blockText(b, o.maxChars));
  const chars = header.length + (layerText === null ? 0 : 1 + layerText.length) + (full === null ? 0 : 1 + full.chars) + frameTexts.reduce((n, x) => n + 1 + x.chars, 0);
  const truncated = (body?.truncated ?? false) || frameTexts.some((x) => x.truncated);
  return {
    ...head,
    chars,
    truncated,
    ...(truncated ? { note: `truncated at ${o.maxChars} chars per document (${chars} in all); for more: --max-chars <n>, --interactive (controls only), --frame <path> (one frame), --file-path <f> (whole tree to a file) or tabcap find <text>` } : {}),
    tree: [header, ...(body === null ? [] : [body.text]), ...frameTexts.map((x) => x.text)].join("\n"),
  };
}

/**
 * docs/04 §53.2: the overlay whose subtree a snapshot shows first: the first
 * root-document overlay (modal ones come first) whose element has accessible
 * nodes inside it; null when there is none.
 */
function topLayer(tab: Tab, doc: DocIdentity, overlays: Overlay[] | null, view: AxNode, layout: PageLayout): { overlay: Overlay; layer: AxNode[]; rest: AxNode } | null {
  for (const ov of overlays ?? []) {
    if (ov.frame !== undefined || ov.ref === null) continue;
    const look = tab.refs.lookup(ov.ref, doc);
    if (!look.ok || look.frame !== null) continue;
    const { layer, rest } = splitLayer(view, layout, look.backendNodeId);
    if (layer.length > 0) return { overlay: ov, layer, rest };
  }
  return null;
}

export async function snapshot(d: Daemon, a: Args, session: string): Promise<unknown> {
  const o = snapshotOptions(a);
  const { t, tabs } = d.need();
  const tab = await readTab(tabs, a, session);
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

/**
 * docs/04 §53.1: the element a text hit's words are in (the text node's parent),
 * as a backend node id; null when it cannot be resolved or is <body> / <html>.
 * The nearest ancestor with an accessible line can be a whole list (Element's
 * dropdown `ul`), whose centre is another option.
 */
async function textElement(t: Transport, sessionId: string, backendNodeId: number): Promise<number | null> {
  const r = await t.send("DOM.resolveNode", { backendNodeId }, sessionId, 5000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) return null;
  const el = await ancestorId(t, sessionId, objectId, 0).catch(() => null);
  return el === null ? null : el.backendNodeId;
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
  const text = reqStr(a, "text", "tabcap find <text> [--within <text>]");
  const within = optStr(a, "within");
  const { t, tabs } = d.need();
  const tab = await readTab(tabs, a, session);
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
        const r = findCandidates(x.root, text, Math.max(0, FIND_SCAN - cands.length), within === null || within.trim() === "" ? null : within);
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
      const hits: Array<Record<string, unknown>> = [];
      for (const x of ranked.slice(0, FIND_LIMIT)) {
        const h = hitOf(x.c, x.doc.refFor, dom.get(x) ?? null);
        // docs/04 §53.1: a text hit's ref is the element holding the text, never a far ancestor.
        if (x.c.node.role === "text" && x.c.node.backendId !== null) {
          const el = await textElement(t, x.doc.sessionId, x.c.node.backendId);
          h.ref = el === null ? null : x.doc.refFor(el);
        }
        hits.push({ ...h, ...(x.doc.frame === null ? {} : { frame: x.doc.frame.path }) });
      }
      const frames = docs.length - 1;
      return {
        tab: tab.id,
        url: doc.url,
        nav: d.navOf(tab),
        query: text,
        ...(within === null ? {} : { within }),
        total,
        order: "clickable first, then document order",
        ...(frames + skipped > 0 ? { frames, ...(skipped > 0 ? { framesSkipped: skipped } : {}) } : {}),
        hits,
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
