// tabcap snapshot | find, plus ref resolution shared with click / fill.
// 0.4-I: the frame tree is in the header (`frames` lines); `--frames` expands
// every child frame's tree with frame-path refs (`f2/f1/e7`), `--frame f2/f1`
// only that subtree. Refs resolve in the document they were minted in.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { buildAxTree, findCandidates, hitOf, interactiveOnly, rankClickable, renderAxTree, textInputsWithValue, type AxNode, type FindCandidate, type Rendered } from "../browser/ax.ts";
import { inspectPage } from "../adapters/runtime.ts";
import { cutText, headerLines } from "../adapters/view.ts";
import { bindingOf, descendants, frameAt, frameHeaderLines, frameLine, frameList, framesOfTree, frameTree, type FrameNode } from "../browser/frames.ts";
import { parseFramePath, parseRef, sameDoc, type DocIdentity, type FrameBinding } from "../browser/refs.ts";
import { rootDoc } from "../browser/worlds.ts";
import type { Tab } from "../browser/targets.ts";
import { isSensitiveField } from "../secrets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { MAX_OUTPUT_CHARS } from "./page.ts";
import { timeoutOf } from "./navigate.ts";

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
};

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
    maxChars: Math.max(1000, Math.min(optNum(a, "maxChars") ?? MAX_OUTPUT_CHARS, 4_000_000)),
    filePath: filePath === null || filePath === "" ? null : resolve(filePath),
    frames,
    frame,
  };
}

/** One child frame's tree with frame-path refs (Accessibility.getFullAXTree of that frame through its session). */
async function frameRendered(t: Transport, tab: Tab, f: FrameNode, o: SnapshotOptions): Promise<Rendered | string> {
  try {
    const raw = await t.send("Accessibility.getFullAXTree", { frameId: f.frameId }, f.sessionId, 30_000);
    const root = buildAxTree(raw, await passwordIds(t, f.sessionId, raw), { verbose: o.verbose });
    if (root === null) return "(empty)";
    const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
    const binding: FrameBinding = bindingOf(f);
    return renderAxTree(view, (id) => tab.refs.refFor(id, binding), Number.MAX_SAFE_INTEGER);
  } catch (e) {
    return `(unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
  }
}

/**
 * The snapshot of one tab, for `snapshot` and for `--snapshot` on the
 * interactive commands. Call it inside the tab's job (Tabs.run), never around it.
 */
export async function renderSnapshot(d: Daemon, t: Transport, tab: Tab, o: SnapshotOptions): Promise<Record<string, unknown>> {
  const { root, doc } = await axTree(t, tab, o.verbose);
  const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
  const tree = await frameTree(t, tab).catch(() => null);
  let expand: FrameNode[] = [];
  if (o.frame !== null) {
    const sub = tree === null ? null : frameAt(tree.root, o.frame);
    if (sub === null) throw new TabcapError("not-found", `no frame ${o.frame} on tab ${tab.id}`, "Run `tabcap snapshot` and pick a frame path from its `frames` header lines.");
    expand = [sub, ...descendants(sub)];
  } else if (o.frames && tree !== null) expand = descendants(tree.root);
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
    ...(truncated ? { note: `truncated at ${o.maxChars} chars per document (${chars} in all); use --interactive, --file-path, --frame <path> or tabcap find <text>` } : {}),
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
  const { tab: _tab, ...snap } = await renderSnapshot(d, t, tab, { interactive: false, verbose: false, maxChars: MAX_OUTPUT_CHARS, filePath: null, frames: false, frame: null });
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

async function ancestorId(t: Transport, tab: Tab, objectId: string, depth: number): Promise<{ objectId: string; backendNodeId: number } | null> {
  const r = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: ANCESTOR_FN, arguments: [{ value: depth }], returnByValue: false }, tab.sessionId, 5000);
  const res = isRecord(r["result"]) ? r["result"] : null;
  const oid = res === null ? null : str(res, "objectId");
  if (oid === null) return null;
  const d = await t.send("DOM.describeNode", { objectId: oid }, tab.sessionId, 5000);
  const node = isRecord(d["node"]) ? d["node"] : null;
  const id = node === null ? null : node["backendNodeId"];
  return typeof id === "number" && Number.isSafeInteger(id) ? { objectId: oid, backendNodeId: id } : null;
}

/**
 * The DOM element a click on this AX hit should go to, when the AX tree has no
 * control for it (custom checkboxes, `div role=none` buttons, docs/05 s19):
 * a native control / clickable role / cursor:pointer within 4 levels, else an
 * element within 3 levels with a click-type listener (DOMDebugger.getEventListeners).
 */
async function domClickable(t: Transport, tab: Tab, backendNodeId: number): Promise<{ backendId: number; by: string } | null> {
  const r = await t.send("DOM.resolveNode", { backendNodeId }, tab.sessionId, 5000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) return null;
  const up = callResult(await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CLICKABLE_UP_FN, returnByValue: true }, tab.sessionId, 5000));
  if (isRecord(up) && typeof up["depth"] === "number") {
    const el = await ancestorId(t, tab, objectId, up["depth"]);
    return el === null ? null : { backendId: el.backendNodeId, by: str(up, "by") ?? "tag" };
  }
  for (let depth = 0; depth < 3; depth++) {
    const el = await ancestorId(t, tab, objectId, depth);
    if (el === null) return null;
    const l = await t.send("DOMDebugger.getEventListeners", { objectId: el.objectId }, tab.sessionId, 5000).catch(() => null);
    const list = l !== null && Array.isArray(l["listeners"]) ? l["listeners"].filter(isRecord) : [];
    if (list.some((x) => CLICK_EVENTS.has(str(x, "type") ?? ""))) return { backendId: el.backendNodeId, by: "listener" };
  }
  return null;
}

export async function find(d: Daemon, a: Args, session: string): Promise<unknown> {
  const text = reqStr(a, "text", "tabcap find <text>");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      const { root, doc } = await axTree(t, tab);
      const { cands, total } = findCandidates(root, text, FIND_SCAN);
      // docs/05 s19: clickable hits first (AX controls, then DOM signals), document order otherwise.
      const dom = new Map<FindCandidate, { backendId: number; by: string }>();
      let probed = 0;
      for (const c of cands) {
        if (c.clickId !== null || c.node.backendId === null || probed >= FIND_PROBE) continue;
        probed++;
        const hit = await domClickable(t, tab, c.node.backendId).catch(() => null);
        if (hit !== null) dom.set(c, hit);
      }
      const ranked = rankClickable(cands, (c) => c.clickId !== null || dom.has(c));
      const hits = ranked.slice(0, FIND_LIMIT).map((c) => hitOf(c, (id) => tab.refs.refFor(id), dom.get(c) ?? null));
      return { tab: tab.id, url: doc.url, nav: d.navOf(tab), query: text, total, order: "clickable first, then document order", hits };
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
export async function resolveRef(t: Transport, tab: Tab, ref: string): Promise<RefNode> {
  const doc = await docIdentity(t, tab);
  const look = tab.refs.lookup(ref, doc);
  if (!look.ok) {
    if (look.reason === "malformed") throw new TabcapError("usage", `not a ref: ${ref}`, "Refs look like e12, or f2/e7 for an element in a frame; get them from `tabcap snapshot` (`--frames` expands frames) or `tabcap find`.");
    if (look.reason === "unknown") {
      const p = parseRef(ref);
      const as = p === null ? null : tab.refs.minted(p.n);
      if (as !== null) throw new TabcapError("stale-ref", `ref ${ref} is unknown on tab ${tab.id}; e${p?.n ?? ""} was given out as ${as}`, `Use ${as} (the frame path is part of the ref), or run snapshot again.`);
    }
    const why = look.reason === "unknown" ? `ref ${ref} is unknown on tab ${tab.id}` : `ref ${ref} expired: the document changed since the snapshot`;
    throw new TabcapError("stale-ref", why, "run snapshot again (`tabcap snapshot --interactive`) and use the new ref.");
  }
  const sessionId = look.frame === null ? tab.sessionId : look.frame.sessionId;
  if (look.frame !== null && !(await frameCurrent(t, tab, look.frame))) {
    throw new TabcapError("stale-ref", `ref ${ref} expired: frame ${look.frame.path} changed since the snapshot (it navigated, reloaded or was removed)`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
  }
  const r = await t.send("DOM.resolveNode", { backendNodeId: look.backendNodeId }, sessionId, 10_000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) throw new TabcapError("stale-ref", `ref ${ref} is no longer in the page`, "run snapshot again; the element was removed or re-rendered.");
  return { objectId, backendNodeId: look.backendNodeId, sessionId, frame: look.frame };
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

