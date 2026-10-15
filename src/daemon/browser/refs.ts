// Snapshot refs: `e<n>` bound to a backendDOMNodeId within one
// document identity (root frame id + loaderId + url incl. fragment). The same
// node keeps its ref while the document is unchanged; any identity change
// (navigation, reload, hash route) drops the whole table. Numbers only grow,
// so an old ref can never silently point at a node of a newer document.

export type DocIdentity = { frameId: string; loaderId: string; url: string };

export const sameDoc = (a: DocIdentity | null, b: DocIdentity | null): boolean =>
  a !== null && b !== null && a.frameId === b.frameId && a.loaderId === b.loaderId && a.url === b.url;

export type RefLookup =
  | { ok: true; backendNodeId: number }
  | { ok: false; reason: "unknown" | "expired" | "malformed" };

export class RefTable {
  private issued = 0;
  private doc: DocIdentity | null = null;
  private byRef = new Map<string, number>();
  private byNode = new Map<number, string>();

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
    return dropped;
  }

  refFor(backendNodeId: number): string {
    const have = this.byNode.get(backendNodeId);
    if (have !== undefined) return have;
    const ref = `e${++this.issued}`;
    this.byRef.set(ref, backendNodeId);
    this.byNode.set(backendNodeId, ref);
    return ref;
  }

  /** Resolve a ref against the tab's current document identity. */
  lookup(ref: string, current: DocIdentity | null): RefLookup {
    const m = /^e(\d+)$/.exec(ref);
    if (m === null || m[1] === undefined) return { ok: false, reason: "malformed" };
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || n < 1 || n > this.issued) return { ok: false, reason: "unknown" };
    if (current !== null && !sameDoc(this.doc, current)) {
      this.setDocument(current);
      return { ok: false, reason: "expired" };
    }
    const id = this.byRef.get(ref);
    return id === undefined ? { ok: false, reason: "expired" } : { ok: true, backendNodeId: id };
  }
}
