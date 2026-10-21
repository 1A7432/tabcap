// Document helpers over CDP that tools and the live protection probe share
// (moved out of tools/snapshot.ts, review wave 2: they made snapshot a
// library that challenge / landing / navigate / protection/live imported
// back, a runtime import cycle). Behaviour unchanged: the root document's
// identity, the bounded wait for a root navigation, ref resolution (main or
// isolated world, stale-ref errors) and the by-value result of a
// Runtime.callFunctionOn. CDP answers are untrusted.
// Oracle: CDP protocol.json (Page.getFrameTree, DOM.resolveNode,
// Runtime.callFunctionOn). Reproduce: bun test test/unit/browser-doc.test.ts

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import type { Transport } from "../transport/types.ts";
import { framesOfTree } from "./frames.ts";
import { parseRef, type DocIdentity, type FrameBinding } from "./refs.ts";
import type { Tab } from "./targets.ts";
import { inWorld, rootDoc, type FrameDoc } from "./worlds.ts";

/** The tab's root document: frame id, loaderId and URL with its fragment (a ref table is bound to it). */
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

/** The error for a ref the tab's table does not resolve: a usage error when it is not a ref, else stale-ref with what to do. */
export function refError(tab: Tab, ref: string, reason: "unknown" | "expired" | "malformed"): TabcapError {
  if (reason === "malformed") return new TabcapError("usage", `not a ref: ${ref}`, "Refs look like e12, or f2/e7 for an element in a frame; get them from `tabcap snapshot` (`--frames` expands frames) or `tabcap find`.");
  if (reason === "unknown") {
    const p = parseRef(ref);
    const as = p === null ? null : tab.refs.minted(p.n);
    if (as !== null) return new TabcapError("stale-ref", `ref ${ref} is unknown on tab ${tab.id}; e${p?.n ?? ""} was given out as ${as}`, `Use ${as} (the frame path is part of the ref), or run snapshot again.`);
  }
  const why = reason === "unknown" ? `ref ${ref} is unknown on tab ${tab.id}` : `ref ${ref} expired: the document changed since the snapshot`;
  return new TabcapError("stale-ref", why, "run snapshot again (`tabcap snapshot --interactive`) and use the new ref.");
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
