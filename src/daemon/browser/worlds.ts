// Isolated worlds (`Page.createIsolatedWorld`) per frame document: scripts
// tabcap runs there share the DOM but not the page's JavaScript, so the page
// cannot see or tamper with them. One world per (world name, session, frame,
// loader) and tab, made on first use and made again when its context is gone.
// `tabcap-adapters` serves snapshots, waits and probes; `tabcap fetch` keeps its
// own `tabcap-fetch` world (review 10-21: before, every fetch made a new one).

import { TabcapError } from "../../shared/envelope.ts";
import type { Transport } from "../transport/types.ts";
import type { DocIdentity } from "./refs.ts";
import type { Tab } from "./targets.ts";

/** A document of the tab: the root document or a child frame's, with the CDP session that owns it. */
export type FrameDoc = DocIdentity & { sessionId: string };

/** The root document of a tab as a FrameDoc. */
export const rootDoc = (tab: Tab, doc: DocIdentity): FrameDoc => ({ ...doc, sessionId: tab.sessionId });

export const WORLD = "tabcap-adapters";
const worlds = new WeakMap<Tab, Map<string, { key: string; ctx: number }>>();
/** Frames a tab keeps worlds for; older entries go first (a page that makes many frames). */
const MAX_WORLDS = 64;

async function worldOf(t: Transport, tab: Tab, doc: FrameDoc, fresh: boolean, world: string): Promise<number> {
  const slot = `${world}|${doc.sessionId}|${doc.frameId}`;
  const key = doc.loaderId;
  let map = worlds.get(tab);
  if (map === undefined) {
    map = new Map();
    worlds.set(tab, map);
  }
  const have = map.get(slot);
  if (!fresh && have !== undefined && have.key === key) return have.ctx;
  const r = await t.send("Page.createIsolatedWorld", { frameId: doc.frameId, worldName: world, grantUniveralAccess: false }, doc.sessionId, 5000);
  const ctx = r["executionContextId"];
  if (typeof ctx !== "number" || !Number.isSafeInteger(ctx)) throw new TabcapError("cdp", "Page.createIsolatedWorld returned no context", "Snapshot again; the page may be navigating.");
  map.delete(slot);
  map.set(slot, { key, ctx });
  while (map.size > MAX_WORLDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return ctx;
}

/** Run `fn(ctx)` in the document's isolated world `world`; a vanished context (navigation, reload) is recreated once. */
export async function inWorld<T>(t: Transport, tab: Tab, doc: FrameDoc, fn: (ctx: number) => Promise<T>, world: string = WORLD): Promise<T> {
  try {
    return await fn(await worldOf(t, tab, doc, false, world));
  } catch (e) {
    if (!(e instanceof Error) || !/context/i.test(e.message)) throw e;
    return fn(await worldOf(t, tab, doc, true, world));
  }
}
