// Click landing, the CDP side (0.6-J; the decision and the page function are
// browser/landing.ts). Read only: listeners come from
// DOMDebugger.getEventListeners, everything else from a function run in
// tabcap's isolated world (the page cannot see it). Nothing here changes the
// page and nothing here throws: an inspection that fails is logged and the
// click goes on as before.
//
// DOMDebugger.getEventListeners only reports the listeners of the world the
// node's object belongs to (measured, spike 10-16, CfT 155: an isolated-world
// objectId gives [] for a node with main-world listeners), so listeners are
// read through main-world objects (DOM.resolveNode without a context runs no
// page script); `depth: n` reaches descendants n - 1 levels down (same spike:
// a listener 4 levels below needs depth 5).

import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { INTERACTIVE_ROLES, type AxNode } from "../browser/ax.ts";
import { candidateBy, decideLanding, INSPECT_FN, INSPECT_MANY_FN, LANDING_ANCESTORS, LANDING_DEPTH, listenersByNode, parseInspection, type LandingDescendant } from "../browser/landing.ts";
import type { FrameBinding } from "../browser/refs.ts";
import type { Tab } from "../browser/targets.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Transport } from "../transport/types.ts";
import { docIdentity } from "./snapshot.ts";

const GROUP = "tabcap-landing";
/** snapshot --interactive: at most this many controls per document are inspected. */
export const LANDING_SNAPSHOT_MAX = 300;
/** snapshot --interactive: a document with more listening elements than this is not marked. */
export const LANDING_HOLDERS_MAX = 2000;

export type LandedOn = { tag: string; text: string; selector: string };
export type LandingCandidate = { ref: string; tag: string; text: string; selector: string; by: string[] };

export type Landing =
  | { kind: "target" | "none" }
  | { kind: "descendant"; node: { objectId: string; backendNodeId: number }; landedOn: LandedOn }
  | { kind: "candidates"; candidates: LandingCandidate[] };

const ANCESTORS_FN = `function (max) {
  const out = [];
  let a = (this.nodeType === 1 ? this : this.parentElement);
  a = a ? a.parentElement : null;
  for (let i = 0; a && i < max; a = a.parentElement, i++) out.push(a);
  return out;
}`;

/** The objects of an array RemoteObject, by index (null where an entry is not an object). */
async function items(t: Transport, sid: string, objectId: string): Promise<Array<Record<string, unknown> | null>> {
  const r = await t.send("Runtime.getProperties", { objectId, ownProperties: true }, sid, 5000);
  const list = Array.isArray(r["result"]) ? r["result"].filter(isRecord) : [];
  const out: Array<Record<string, unknown> | null> = [];
  for (const p of list) {
    const name = str(p, "name");
    if (name === null || !/^\d+$/.test(name)) continue;
    out[Number(name)] = isRecord(p["value"]) ? p["value"] : null;
  }
  return Array.from(out, (x) => x ?? null);
}

async function backendOf(t: Transport, sid: string, objectId: string): Promise<number | null> {
  const d = await t.send("DOM.describeNode", { objectId }, sid, 5000).catch(() => null);
  const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
  return node === null ? null : num(node, "backendNodeId");
}

async function resolveIn(t: Transport, sid: string, backendNodeId: number, ctx: number | null): Promise<string | null> {
  const r = await t.send("DOM.resolveNode", { backendNodeId, objectGroup: GROUP, ...(ctx === null ? {} : { executionContextId: ctx }) }, sid, 5000).catch(() => null);
  const o = r !== null && isRecord(r["object"]) ? r["object"] : null;
  return o === null ? null : str(o, "objectId");
}

async function listenersOf(t: Transport, sid: string, mainObjectId: string, depth?: number): Promise<Map<number, string[]>> {
  const r = await t.send("DOMDebugger.getEventListeners", { objectId: mainObjectId, ...(depth === undefined ? {} : { depth }) }, sid, 10_000);
  return listenersByNode(r);
}

const docOf = async (t: Transport, tab: Tab, frame: FrameBinding | null): Promise<FrameDoc> =>
  frame === null ? rootDoc(tab, await docIdentity(t, tab)) : { frameId: frame.frameId, loaderId: frame.loaderId, url: "", sessionId: frame.sessionId };

const landedOf = (d: LandingDescendant): LandedOn => ({ tag: d.tag, text: d.text, selector: d.selector });

/**
 * Where a default click on `node` lands (decision table in browser/landing.ts).
 * `node.objectId` is the main-world object of the target (resolveRef);
 * `mint` gives a ref for a node of the target's document (candidates).
 */
export async function inspectLanding(
  t: Transport,
  tab: Tab,
  node: { objectId: string; backendNodeId: number; sessionId: string; frame: FrameBinding | null },
  mint: (backendNodeId: number) => string,
): Promise<Landing> {
  const sid = node.sessionId;
  try {
    const fdoc = await docOf(t, tab, node.frame);
    // The target and its descendants down to LANDING_DEPTH levels, in one call.
    const below = await listenersOf(t, sid, node.objectId, LANDING_DEPTH + 1);
    return await inWorld(t, tab, fdoc, async (ctx): Promise<Landing> => {
      try {
        const target = await resolveIn(t, sid, node.backendNodeId, ctx);
        if (target === null) return { kind: "none" };
        const anc = await t.send("Runtime.callFunctionOn", { objectId: target, functionDeclaration: ANCESTORS_FN, arguments: [{ value: LANDING_ANCESTORS }], returnByValue: false, objectGroup: GROUP }, sid, 5000);
        const ancObj = isRecord(anc["result"]) ? str(anc["result"], "objectId") : null;
        const ancestors = ancObj === null ? [] : await items(t, sid, ancObj);
        // Holders: elements (isolated-world objects) with the click-type listener types read for them.
        const holders: Array<{ objectId: string; types: string[] }> = [];
        await Promise.all(
          ancestors.map(async (a) => {
            const oid = a === null ? null : str(a, "objectId");
            if (oid === null) return;
            const id = await backendOf(t, sid, oid);
            const main = id === null ? null : await resolveIn(t, sid, id, null);
            if (id === null || main === null) return;
            const types = (await listenersOf(t, sid, main)).get(id) ?? [];
            if (types.length > 0) holders.push({ objectId: oid, types });
          }),
        );
        await Promise.all(
          [...below].map(async ([id, types]) => {
            const oid = await resolveIn(t, sid, id, ctx);
            if (oid !== null) holders.push({ objectId: oid, types });
          }),
        );
        const r = await t.send(
          "Runtime.callFunctionOn",
          { objectId: target, functionDeclaration: INSPECT_FN, arguments: [{ value: holders.map((h) => h.types) }, ...holders.map((h) => ({ objectId: h.objectId }))], returnByValue: false, objectGroup: GROUP },
          sid,
          10_000,
        );
        if (isRecord(r["exceptionDetails"])) return { kind: "none" };
        const resObj = isRecord(r["result"]) ? str(r["result"], "objectId") : null;
        if (resObj === null) return { kind: "none" };
        const got = await items(t, sid, resObj);
        const head = got[0] ?? null;
        const json = head === null ? null : str(head, "value");
        let parsed: unknown = null;
        try {
          parsed = json === null ? null : JSON.parse(json);
        } catch {
          parsed = null;
        }
        const x = parseInspection(parsed);
        if (x === null) return { kind: "none" };
        const decision = decideLanding(x);
        const elementAt = (i: number): string | null => {
          const o = got[i + 1] ?? null;
          return o === null ? null : str(o, "objectId");
        };
        if (decision.kind === "descendant") {
          const d = x.descendants[decision.index];
          const oid = elementAt(decision.index);
          const id = oid === null ? null : await backendOf(t, sid, oid);
          const main = id === null ? null : await t.send("DOM.resolveNode", { backendNodeId: id }, sid, 5000).catch(() => null);
          const mainObj = main !== null && isRecord(main["object"]) ? str(main["object"], "objectId") : null;
          if (d === undefined || id === null || mainObj === null) return { kind: "none" };
          return { kind: "descendant", node: { objectId: mainObj, backendNodeId: id }, landedOn: landedOf(d) };
        }
        if (decision.kind === "candidates") {
          const candidates: LandingCandidate[] = [];
          for (const i of decision.indexes) {
            const d = x.descendants[i];
            const oid = elementAt(i);
            const id = oid === null ? null : await backendOf(t, sid, oid);
            if (d === undefined || id === null) continue;
            candidates.push({ ref: mint(id), ...landedOf(d), by: candidateBy(d) });
          }
          return candidates.length > 0 ? { kind: "candidates", candidates } : { kind: "none" };
        }
        return { kind: decision.kind };
      } finally {
        await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, sid, 3000).catch(() => undefined);
      }
    });
  } catch (e) {
    log.info("click landing: inspection failed, the click goes to the target", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
    return { kind: "none" };
  }
}

/** The controls of a snapshot view that get a landing check (interactive roles with a DOM node), at most LANDING_SNAPSHOT_MAX. */
export function landingTargets(view: AxNode): AxNode[] {
  const out: AxNode[] = [];
  const walk = (n: AxNode) => {
    if (out.length >= LANDING_SNAPSHOT_MAX) return;
    if (n.backendId !== null && INTERACTIVE_ROLES.has(n.role)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(view);
  return out;
}

/**
 * snapshot --interactive: mark the controls of one document's view whose
 * click would land on a descendant (decision (b)) with `landing: "child"`.
 * One listener read for the whole document, one page call for all controls.
 * Never throws; a document that cannot be inspected is left unmarked.
 */
export async function markLanding(t: Transport, tab: Tab, fdoc: FrameDoc, view: AxNode): Promise<void> {
  const targets = landingTargets(view);
  if (targets.length === 0) return;
  const sid = fdoc.sessionId;
  try {
    await inWorld(t, tab, fdoc, async (ctx) => {
      try {
        const doc = await t.send("Runtime.evaluate", { expression: "document", contextId: ctx, returnByValue: false, objectGroup: GROUP }, sid, 5000);
        const docObj = isRecord(doc["result"]) ? str(doc["result"], "objectId") : null;
        const docId = docObj === null ? null : await backendOf(t, sid, docObj);
        const docMain = docId === null ? null : await resolveIn(t, sid, docId, null);
        if (docMain === null) return;
        const all = await listenersOf(t, sid, docMain, -1);
        if (all.size > LANDING_HOLDERS_MAX) {
          log.info("snapshot landing: too many listening elements, not marked", { tab: tab.id, holders: all.size });
          return;
        }
        const holders: Array<{ objectId: string; types: string[] }> = [];
        await Promise.all(
          [...all].map(async ([id, types]) => {
            const oid = await resolveIn(t, sid, id, ctx);
            if (oid !== null) holders.push({ objectId: oid, types });
          }),
        );
        const targetObjs = await Promise.all(targets.map((n) => (n.backendId === null ? Promise.resolve(null) : resolveIn(t, sid, n.backendId, ctx))));
        const r = await t.send(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: INSPECT_MANY_FN,
            executionContextId: ctx,
            arguments: [{ value: holders.map((h) => h.types) }, { value: targets.length }, ...targetObjs.map((o) => (o === null ? { value: null } : { objectId: o })), ...holders.map((h) => ({ objectId: h.objectId }))],
            returnByValue: true,
          },
          sid,
          20_000,
        );
        if (isRecord(r["exceptionDetails"])) return;
        const json = isRecord(r["result"]) ? str(r["result"], "value") : null;
        let list: unknown = null;
        try {
          list = json === null ? null : JSON.parse(json);
        } catch {
          list = null;
        }
        if (!Array.isArray(list)) return;
        targets.forEach((n, i) => {
          const x = parseInspection(list[i]);
          if (x !== null && decideLanding(x).kind === "descendant") n.landing = "child";
        });
      } finally {
        await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, sid, 3000).catch(() => undefined);
      }
    });
  } catch (e) {
    log.info("snapshot landing: inspection failed, not marked", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
  }
}
