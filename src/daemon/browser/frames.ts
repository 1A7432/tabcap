// Frame tree of a tab (0.4-I, docs/05 s22, docs/07 §1.1). Measured on Chrome
// for Testing 155 (spike 10-16):
// - the tab session's Page.getFrameTree lists the root and its same-process
//   frames only (frameset frames, same-origin iframes); every out-of-process
//   iframe (OOPIF) is an auto-attached `iframe` target whose own session's
//   Page.getFrameTree starts at that frame (`parentId` = the frame that holds
//   it) and lists its same-process descendants;
// - frame numbering follows the parent document: `iframe, frame` elements in
//   document order, each owner element's DOM.describeNode `frameId` (also
//   for OOPIFs, without contentDocument);
// - DOM.getBoxModel through a session answers in the viewport of that
//   session's local root (the tab for same-process frames, the OOPIF itself
//   otherwise); the frame's viewport starts at its owner element's content
//   box in the parent's space. Input.dispatchMouseEvent and key events on the
//   tab session at top-level coordinates reach elements inside OOPIFs.
// Everything read from CDP and the page is untrusted.

import { isRecord, str } from "../../shared/json.ts";
import type { AttachedTarget, Transport } from "../transport/types.ts";
import { parseFramePath, type FrameBinding } from "./refs.ts";
import type { Tab } from "./targets.ts";
import { inWorld, type FrameDoc } from "./worlds.ts";

/** One frame as CDP knows it. */
export type RawFrame = {
  frameId: string;
  parentId: string | null;
  /** The CDP session that owns the frame's document. */
  sessionId: string;
  /** The frame is a local root of its own target (an out-of-process iframe). */
  oopif: boolean;
  url: string;
  securityOrigin: string;
  loaderId: string;
};

export type FrameOrigin = "same-origin" | "cross-origin";

export type FrameNode = {
  /** `f2/f1`; "" for the root document. */
  path: string;
  frameId: string;
  sessionId: string;
  oopif: boolean;
  url: string;
  /** Relative to the parent frame's security origin. */
  origin: FrameOrigin;
  depth: number;
  title: string;
  loaderId: string;
  children: FrameNode[];
};

/** Frames a snapshot looks at (tree order, root first); later ones are left out and counted. */
export const MAX_FRAMES = 64;
/** Frame lines in the snapshot / outline header; the rest are counted on one line. */
export const MAX_FRAME_LINES = 24;
const MAX_URL = 300;
const MAX_TITLE = 120;

/** Sessions of the tab's out-of-process iframes, children and grandchildren (by the session the attach arrived on). */
export function oopifTargets(targets: readonly AttachedTarget[], rootSessionId: string): AttachedTarget[] {
  const out: AttachedTarget[] = [];
  const seen = new Set<string>([rootSessionId]);
  let frontier = [rootSessionId];
  for (let depth = 0; depth < 16 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const x of targets) {
      if (x.type !== "iframe" || x.parentSessionId === null || !frontier.includes(x.parentSessionId) || seen.has(x.sessionId)) continue;
      seen.add(x.sessionId);
      out.push(x);
      next.push(x.sessionId);
    }
    frontier = next;
  }
  return out;
}

/** The frames of one Page.getFrameTree answer (untrusted JSON); the first is the tree's own root. */
export function framesOfTree(result: unknown, sessionId: string, oopifRoot: boolean): RawFrame[] {
  const out: RawFrame[] = [];
  const walk = (node: unknown, depth: number, isRoot: boolean) => {
    if (!isRecord(node) || depth > 32 || out.length >= MAX_FRAMES * 4) return;
    const f = isRecord(node["frame"]) ? node["frame"] : null;
    const id = f === null ? null : str(f, "id");
    if (f === null || id === null) return;
    out.push({
      frameId: id,
      parentId: str(f, "parentId"),
      sessionId,
      oopif: isRoot && oopifRoot,
      url: (str(f, "url") ?? "") + (str(f, "urlFragment") ?? ""),
      securityOrigin: str(f, "securityOrigin") ?? "",
      loaderId: str(f, "loaderId") ?? "",
    });
    const kids = Array.isArray(node["childFrames"]) ? node["childFrames"] : [];
    for (const c of kids) walk(c, depth + 1, false);
  };
  walk(isRecord(result) ? result["frameTree"] : null, 0, true);
  return out;
}

/** Every frame of the tab: the tab session's tree plus each OOPIF session's tree. Root first. */
export async function rawFrames(t: Transport, tab: Tab): Promise<RawFrame[]> {
  const root = framesOfTree(await t.send("Page.getFrameTree", {}, tab.sessionId, 10_000), tab.sessionId, false);
  const byId = new Map<string, RawFrame>(root.map((f) => [f.frameId, f]));
  for (const x of oopifTargets(t.targets(), tab.sessionId)) {
    const r = await t.send("Page.getFrameTree", {}, x.sessionId, 5000).catch(() => null);
    for (const f of framesOfTree(r, x.sessionId, true)) {
      const have = byId.get(f.frameId);
      // A frame both trees list: the OOPIF session owns its document.
      if (have === undefined || f.oopif) byId.set(f.frameId, f);
    }
  }
  return [...byId.values()];
}

/** Security origin relation of a frame to its parent. */
export const originOf = (child: RawFrame, parent: RawFrame): FrameOrigin => (child.securityOrigin !== "" && child.securityOrigin === parent.securityOrigin ? "same-origin" : "cross-origin");

/**
 * Number the frames (pure). `order`: parent frame id → child frame ids in the
 * parent's document order (owner elements); children the owners did not show
 * (shadow DOM, <object>, a race) follow in frame-tree order. At most
 * MAX_FRAMES frames below the root; `omitted` counts the rest.
 */
export function numberFrames(raw: readonly RawFrame[], order: ReadonlyMap<string, readonly string[]>, titles: ReadonlyMap<string, string> = new Map()): { root: FrameNode; omitted: number } {
  const rootRaw = raw.find((f) => f.parentId === null) ?? raw[0];
  if (rootRaw === undefined) throw new Error("no frames");
  const byParent = new Map<string, RawFrame[]>();
  for (const f of raw) {
    if (f.parentId === null || f.frameId === rootRaw.frameId) continue;
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  let count = 0;
  let omitted = 0;
  const seen = new Set<string>([rootRaw.frameId]);
  const node = (f: RawFrame, path: string, depth: number, origin: FrameOrigin): FrameNode => ({
    path,
    frameId: f.frameId,
    sessionId: f.sessionId,
    oopif: f.oopif,
    url: f.url,
    origin,
    depth,
    title: titles.get(f.frameId) ?? "",
    loaderId: f.loaderId,
    children: [],
  });
  const root = node(rootRaw, "", 0, "same-origin");
  // Breadth first, so a page with many frames keeps its shallow ones.
  const queue: Array<{ n: FrameNode; raw: RawFrame }> = [{ n: root, raw: rootRaw }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    const kids = byParent.get(cur.raw.frameId) ?? [];
    const want = order.get(cur.raw.frameId) ?? [];
    const sorted = [...want.map((id) => kids.find((k) => k.frameId === id)).filter((k): k is RawFrame => k !== undefined), ...kids.filter((k) => !want.includes(k.frameId))];
    let i = 0;
    for (const k of sorted) {
      if (seen.has(k.frameId)) continue;
      seen.add(k.frameId);
      i++;
      if (count >= MAX_FRAMES || cur.n.depth >= 15) {
        omitted++;
        continue;
      }
      count++;
      const child = node(k, `${cur.n.path === "" ? "" : `${cur.n.path}/`}f${i}`, cur.n.depth + 1, originOf(k, cur.raw));
      cur.n.children.push(child);
      queue.push({ n: child, raw: k });
    }
  }
  // Frames under a parent no tree mentions are not reachable from the root: left out, counted.
  omitted += raw.filter((f) => !seen.has(f.frameId)).length;
  return { root, omitted };
}

/** Child frames below `n`, tree order (pre-order), `n` itself not included. */
export function descendants(n: FrameNode): FrameNode[] {
  return n.children.flatMap((c) => [c, ...descendants(c)]);
}

/** The frame at `path` (`f2/f1`), or null. */
export function frameAt(root: FrameNode, path: string): FrameNode | null {
  const idx = parseFramePath(path);
  if (idx === null) return null;
  let cur: FrameNode = root;
  for (let d = 0; d < idx.length; d++) {
    const want = `${d === 0 ? "" : `${cur.path}/`}f${idx[d] ?? 0}`;
    const next = cur.children.find((c) => c.path === want);
    if (next === undefined) return null;
    cur = next;
  }
  return cur;
}

export const bindingOf = (f: FrameNode): FrameBinding => ({ path: f.path, frameId: f.frameId, sessionId: f.sessionId, loaderId: f.loaderId });
export const docOf = (f: FrameNode): FrameDoc => ({ frameId: f.frameId, loaderId: f.loaderId, url: f.url, sessionId: f.sessionId });

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** `f2/f1  <url>  cross-origin  depth 2  "<title>"` (no indentation). */
export function frameLine(f: FrameNode): string {
  return `${f.path}  ${clip(f.url, MAX_URL)}  ${f.origin}  depth ${f.depth}  ${JSON.stringify(clip(f.title.replace(/[\u0000-\u001f\u007f]/g, " "), MAX_TITLE))}`;
}

const FRAMES_LABEL = "frames    ";
const MORE_LABEL = "          ";

/** The `frames` header block: one line per child frame, indented by depth; nothing when the page has no child frames. */
export function frameHeaderLines(root: FrameNode, omitted = 0, max = MAX_FRAME_LINES): string[] {
  const all = descendants(root);
  const lines = all.slice(0, max).map((f, i) => `${i === 0 ? FRAMES_LABEL : MORE_LABEL}${"  ".repeat(Math.max(0, f.depth - 1))}${frameLine(f)}`);
  const more = all.length - Math.min(all.length, max) + omitted;
  if (more > 0) lines.push(`${lines.length === 0 ? FRAMES_LABEL : MORE_LABEL}${more} more frame${more === 1 ? "" : "s"} not listed`);
  return lines;
}

/** The frame list of snapshot / outline JSON output. */
export const frameList = (root: FrameNode): Array<{ path: string; url: string; origin: FrameOrigin; depth: number; title: string }> =>
  descendants(root).map((f) => ({ path: f.path, url: f.url, origin: f.origin, depth: f.depth, title: f.title }));

const RELEASE_GROUP = "tabcap-frames";

/** Title and child-frame ids (owner elements in document order) of one frame document, read in its isolated world. */
async function scanFrame(t: Transport, tab: Tab, f: RawFrame): Promise<{ title: string; children: string[] }> {
  const doc: FrameDoc = { frameId: f.frameId, loaderId: f.loaderId, url: f.url, sessionId: f.sessionId };
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      const r = await t.send("Runtime.evaluate", { expression: `[String(document.title), ...Array.from(document.querySelectorAll("iframe, frame")).slice(0, ${MAX_FRAMES})]`, contextId: ctx, objectGroup: RELEASE_GROUP }, f.sessionId, 5000);
      const res = isRecord(r["result"]) ? r["result"] : null;
      const objectId = res === null ? null : str(res, "objectId");
      if (objectId === null) return { title: "", children: [] };
      const props = await t.send("Runtime.getProperties", { objectId, ownProperties: true }, f.sessionId, 5000);
      const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
      const at = (i: number) => {
        const p = list.find((x) => x["name"] === String(i));
        return p !== undefined && isRecord(p["value"]) ? p["value"] : null;
      };
      const head = at(0);
      const title = head !== null && typeof head["value"] === "string" ? head["value"] : "";
      const children: string[] = [];
      for (let i = 1; i <= MAX_FRAMES; i++) {
        const v = at(i);
        if (v === null) break;
        const oid = str(v, "objectId");
        if (oid === null) continue;
        const d = await t.send("DOM.describeNode", { objectId: oid }, f.sessionId, 5000).catch(() => null);
        const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
        const id = node === null ? null : str(node, "frameId");
        if (id !== null) children.push(id);
      }
      return { title, children };
    });
  } catch {
    return { title: "", children: [] };
  } finally {
    await t.send("Runtime.releaseObjectGroup", { objectGroup: RELEASE_GROUP }, f.sessionId, 3000).catch(() => undefined);
  }
}

/**
 * The tab's frame tree at this moment: CDP frames, titles and document-order
 * numbering. A page without child frames costs one Page.getFrameTree.
 */
export async function frameTree(t: Transport, tab: Tab): Promise<{ root: FrameNode; omitted: number }> {
  const raw = await rawFrames(t, tab);
  if (raw.length <= 1) return numberFrames(raw, new Map());
  const order = new Map<string, string[]>();
  const titles = new Map<string, string>();
  const hasKids = new Set(raw.map((f) => f.parentId).filter((x): x is string => x !== null));
  // Breadth first from the root, at most MAX_FRAMES documents scanned.
  const rootRaw = raw.find((f) => f.parentId === null) ?? raw[0];
  const queue = rootRaw === undefined ? [] : [rootRaw];
  let scanned = 0;
  while (queue.length > 0 && scanned <= MAX_FRAMES) {
    const f = queue.shift();
    if (f === undefined) break;
    scanned++;
    const s = await scanFrame(t, tab, f);
    titles.set(f.frameId, s.title);
    if (hasKids.has(f.frameId)) order.set(f.frameId, s.children);
    queue.push(...raw.filter((k) => k.parentId === f.frameId));
  }
  return numberFrames(raw, order, titles);
}

/** Path from the root to `frameId` (root first), or null when the frame is gone. */
export function chainTo(raw: readonly RawFrame[], frameId: string): RawFrame[] | null {
  const byId = new Map(raw.map((f) => [f.frameId, f]));
  const out: RawFrame[] = [];
  let cur = byId.get(frameId);
  for (let i = 0; cur !== undefined && i < 32; i++) {
    out.unshift(cur);
    if (cur.parentId === null) return out;
    cur = byId.get(cur.parentId);
  }
  return null;
}

export type Point = { x: number; y: number };

/**
 * Where each frame of `chain` (root first) sits: `origin[i]` is the top-level
 * viewport position of chain[i]'s own viewport, `space[i]` the position of the
 * viewport its session's box models are measured in (its local root), and
 * `owner[i]` the backend node id of chain[i]'s owner element in chain[i-1]'s
 * session (null for the root). Throws when an owner has no box.
 */
export async function placeChain(t: Transport, chain: readonly RawFrame[]): Promise<{ origin: Point[]; space: Point[]; owner: Array<number | null> }> {
  const origin: Point[] = [];
  const space: Point[] = [];
  const owner: Array<number | null> = [];
  for (let i = 0; i < chain.length; i++) {
    const f = chain[i];
    const parent = i > 0 ? chain[i - 1] : undefined;
    if (f === undefined) break;
    if (parent === undefined) {
      origin.push({ x: 0, y: 0 });
      space.push({ x: 0, y: 0 });
      owner.push(null);
      continue;
    }
    const o = await t.send("DOM.getFrameOwner", { frameId: f.frameId }, parent.sessionId, 5000);
    const id = o["backendNodeId"];
    if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error(`no owner element for frame ${f.frameId}`);
    const b = await t.send("DOM.getBoxModel", { backendNodeId: id }, parent.sessionId, 5000);
    const model = isRecord(b["model"]) ? b["model"] : null;
    const q = model !== null && Array.isArray(model["content"]) ? model["content"].filter((n): n is number => typeof n === "number") : [];
    if (q.length < 8) throw new Error(`the owner element of frame ${f.frameId} has no box`);
    const parentSpace = space[i - 1] ?? { x: 0, y: 0 };
    const at = { x: Math.min(q[0] ?? 0, q[6] ?? 0) + parentSpace.x, y: Math.min(q[1] ?? 0, q[3] ?? 0) + parentSpace.y };
    origin.push(at);
    // Same process as the parent: box models stay in the parent's space; an OOPIF measures from its own viewport.
    space.push(f.oopif || f.sessionId !== parent.sessionId ? at : parentSpace);
    owner.push(id);
  }
  return { origin, space, owner };
}
