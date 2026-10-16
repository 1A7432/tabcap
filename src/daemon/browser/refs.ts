// Snapshot refs: `e<n>` bound to a backendDOMNodeId within one
// document identity (root frame id + loaderId + url incl. fragment). The same
// node keeps its ref while the document is unchanged; any identity change
// (navigation, reload, hash route) drops the whole table. Numbers only grow,
// so an old ref can never silently point at a node of a newer document.
//
// Frame-path refs (0.4-I, docs/05 s22): an element inside a child frame is
// `f<n>/e<m>`, nested frames `f<n>/f<k>/e<m>` (n: 1-based index among the
// parent's child frames in document order at snapshot time). Each ref keeps
// the frame it was minted in (frame id, the CDP session that owns the frame's
// document, the frame's loaderId): backend node ids are only unique within one
// renderer process, and a frame that navigated since the snapshot makes its
// refs expire. One counter for all frames, so `m` is unique within the tab's
// table and `e5` never means `f1/e5`.

export type DocIdentity = { frameId: string; loaderId: string; url: string };

export const sameDoc = (a: DocIdentity | null, b: DocIdentity | null): boolean =>
  a !== null && b !== null && a.frameId === b.frameId && a.loaderId === b.loaderId && a.url === b.url;

/** Where a child frame's document lives when a ref is minted: its path, CDP frame id, owning session, loaderId. */
export type FrameBinding = { path: string; frameId: string; sessionId: string; loaderId: string };

export type RefLookup =
  | { ok: true; backendNodeId: number; frame: FrameBinding | null }
  | { ok: false; reason: "unknown" | "expired" | "malformed" };

/** `f2/f1/e5` → frame indexes [2, 1], frame path "f2/f1", element number 5; null when it is not a ref. */
export type ParsedRef = { frames: number[]; path: string; n: number };

const MAX_FRAME_DEPTH = 16;

/** The frame part of a ref (`f2/f1`) → its 1-based indexes; null when malformed. "" is the root document. */
export function parseFramePath(path: string): number[] | null {
  if (path === "") return [];
  const parts = path.split("/");
  if (parts.length > MAX_FRAME_DEPTH) return null;
  const out: number[] = [];
  for (const p of parts) {
    const m = /^f([1-9]\d{0,5})$/.exec(p);
    if (m === null || m[1] === undefined) return null;
    out.push(Number(m[1]));
  }
  return out;
}

/** Ref grammar: `e<m>` (root document) or `f<n>/e<m>`, `f<n>/f<k>/e<m>` … (at most 16 frame levels). */
export function parseRef(ref: string): ParsedRef | null {
  const slash = ref.lastIndexOf("/");
  const path = slash < 0 ? "" : ref.slice(0, slash);
  const last = slash < 0 ? ref : ref.slice(slash + 1);
  const m = /^e(\d+)$/.exec(last);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const frames = parseFramePath(path);
  if (frames === null || (slash >= 0 && frames.length === 0)) return null;
  return { frames, path, n };
}

/** Looks like a ref (for `where`'s ref-or-text default). */
export const isRef = (s: string): boolean => parseRef(s) !== null;

const frameKey = (f: FrameBinding | null): string => (f === null ? "root" : `${f.sessionId}|${f.frameId}|${f.loaderId}`);

export class RefTable {
  private issued = 0;
  private doc: DocIdentity | null = null;
  private byRef = new Map<string, { backendNodeId: number; frame: FrameBinding | null }>();
  private byNode = new Map<string, string>();
  /** Element number → the ref string it was minted as (cleared with the table). */
  private byNum = new Map<number, string>();

  get document(): DocIdentity | null {
    return this.doc;
  }

  get size(): number {
    return this.byRef.size;
  }

  /** Bind the table to `doc`; returns true when an older table was dropped. */
  setDocument(doc: DocIdentity): boolean {
    if (sameDoc(this.doc, doc)) return false;
    const dropped = this.byRef.size > 0;
    this.doc = doc;
    this.byRef.clear();
    this.byNode.clear();
    this.byNum.clear();
    return dropped;
  }

  /** The ref of a node of the root document (`frame` null) or of a child frame (`f<n>/…/e<m>`). */
  refFor(backendNodeId: number, frame: FrameBinding | null = null): string {
    const key = `${frameKey(frame)}|${backendNodeId}`;
    const prefix = frame === null || frame.path === "" ? "" : `${frame.path}/`;
    const have = this.byNode.get(key);
    // Same node, same frame path: the same ref. A frame renumbered by a later snapshot gets a new ref.
    if (have !== undefined && have.slice(0, have.lastIndexOf("/") + 1) === prefix) return have;
    const n = ++this.issued;
    const ref = `${prefix}e${n}`;
    this.byRef.set(ref, { backendNodeId, frame: prefix === "" ? null : frame });
    this.byNode.set(key, ref);
    this.byNum.set(n, ref);
    return ref;
  }

  /** The ref string element number `n` was minted as in the current table, if any (for "did you mean"). */
  minted(n: number): string | null {
    return this.byNum.get(n) ?? null;
  }

  /** Resolve a ref against the tab's current document identity. */
  lookup(ref: string, current: DocIdentity | null): RefLookup {
    const p = parseRef(ref);
    if (p === null) return { ok: false, reason: "malformed" };
    if (p.n > this.issued) return { ok: false, reason: "unknown" };
    if (current !== null && !sameDoc(this.doc, current)) {
      this.setDocument(current);
      return { ok: false, reason: "expired" };
    }
    const hit = this.byRef.get(ref);
    if (hit !== undefined) return { ok: true, backendNodeId: hit.backendNodeId, frame: hit.frame };
    // The number was minted in this table, but under another frame path: a wrong path, not an old one.
    const as = this.byNum.get(p.n);
    return { ok: false, reason: as !== undefined && as !== ref ? "unknown" : "expired" };
  }
}
