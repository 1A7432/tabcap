// Running adapters in a tab (docs/09 §9). Page scripts run in an isolated
// world (`Page.createIsolatedWorld`): they share the DOM but not the page's
// JavaScript, so the page cannot see or tamper with them and they cannot touch
// the page's globals. Globals are probed in the main world only with
// `name in globalThis` (no getter runs). Every value coming back is untrusted.
//
// Hooks run here: detect (manifest features + digest), describe, act.
// read / decode are validated at load time and refused at call time.
//
// 0.4-I: describe and act run in any document of the tab (root or a child
// frame, through the CDP session that owns it). Refs minted for a child
// frame's nodes carry its frame path (`f2/e7`); an iframe layer's close
// buttons inside its own iframe are reported with that frame's path.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { bindingOf, descendants, docOf, type FrameNode } from "../browser/frames.ts";
import type { FrameBinding } from "../browser/refs.ts";
import type { Tab } from "../browser/targets.ts";
import { inWorld, type FrameDoc } from "../browser/worlds.ts";
import type { Transport } from "../transport/types.ts";
import { DIGEST_FN, DIGEST_MAX, detectAdapter, digestNeeds, globalNames, globalsExpression, parseDigest, type Detection } from "./detect.ts";
import { hookNotImplemented, type Adapter, type HookName } from "./manifest.ts";
import { builtinAdapters } from "./registry.ts";
import { parseButtons, parseOverlay, parseOverlayNodes, type NodeRef, type Overlay } from "./view.ts";
import { CAPTCHA_SCAN_CAP, CAPTCHA_SCAN_FN, detectCaptcha, parseCaptchaScan, type CaptchaHit, type CaptchaScan, type ChallengeView } from "../browser/captcha.ts";

const GROUP = "tabcap-adapters";

function thrown(r: Record<string, unknown>, what: string): void {
  const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
  if (ex === null) return;
  const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
  throw new TabcapError("page", `${what} failed in the page: ${(str(exc, "description") ?? str(ex, "text") ?? "exception").slice(0, 300)}`, "Snapshot again; if it keeps failing the page may block script evaluation.");
}

/** A hook result `[json, ...nodes]` → parsed data + backend node ids (null for nodes that did not resolve). */
async function unpack(t: Transport, sessionId: string, r: Record<string, unknown>, what: string): Promise<{ data: unknown; backendIds: Array<number | null> }> {
  thrown(r, what);
  const res = isRecord(r["result"]) ? r["result"] : {};
  const objectId = str(res, "objectId");
  if (objectId === null) throw new TabcapError("page", `${what} returned no result`, "Snapshot again.");
  const props = await t.send("Runtime.getProperties", { objectId, ownProperties: true }, sessionId, 5000);
  const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
  const at = (i: number) => {
    const p = list.find((x) => x["name"] === String(i));
    return p !== undefined && isRecord(p["value"]) ? p["value"] : null;
  };
  const head = at(0);
  const json = head === null ? null : head["value"];
  if (typeof json !== "string" || json.length > 2_000_000) throw new TabcapError("page", `${what} returned malformed data`, "Snapshot again.");
  let data: unknown;
  try {
    data = JSON.parse(json) as unknown;
  } catch {
    throw new TabcapError("page", `${what} returned malformed JSON`, "Snapshot again.");
  }
  const backendIds: Array<number | null> = [];
  for (let i = 1; i <= 64; i++) {
    const v = at(i);
    if (v === null) break;
    const oid = str(v, "objectId");
    if (oid === null) {
      backendIds.push(null);
      continue;
    }
    const d = await t.send("DOM.describeNode", { objectId: oid }, sessionId, 5000).catch(() => null);
    const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
    const id = node === null ? null : node["backendNodeId"];
    backendIds.push(typeof id === "number" && Number.isSafeInteger(id) ? id : null);
  }
  return { data, backendIds };
}

const release = (t: Transport, sessionId: string) => t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, sessionId, 3000).then(() => undefined, () => undefined);

function needHook(a: Adapter, hook: HookName): void {
  if (hook === "read" || hook === "decode") throw hookNotImplemented(a, hook);
  if (a.hooks[hook] === undefined || a.script === null) throw new TabcapError("unsupported", `adapter ${a.name} has no ${hook} hook`, "Check the adapter's adapter.json hooks.");
}

function needOp(a: Adapter, op: string): void {
  needHook(a, "act");
  if (!(a.hooks.act?.ops ?? []).includes(op)) throw new TabcapError("unsupported", `adapter ${a.name} has no act op ${op}`, "Check the adapter's adapter.json hooks.act.ops.");
}

const wrap = (script: string) => `const A = (\n${script}\n);`;

/** describe(): `{data, nodes}` of the adapter's page script, in the document `doc`. */
export async function runDescribe(t: Transport, tab: Tab, doc: FrameDoc, a: Adapter): Promise<{ data: unknown; backendIds: Array<number | null> }> {
  needHook(a, "describe");
  const script = a.script ?? "";
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      const expression = `(() => { ${wrap(script)} const r = A.describe(); return [JSON.stringify(r && r.data), ...((r && r.nodes) || []).slice(0, 64)]; })()`;
      const r = await t.send("Runtime.evaluate", { expression, contextId: ctx, returnByValue: false, objectGroup: GROUP }, doc.sessionId, 10_000);
      return unpack(t, doc.sessionId, r, `adapter ${a.name} describe`);
    });
  } finally {
    await release(t, doc.sessionId);
  }
}

/** act(op, element): runs with `this` = the element (resolved into the isolated world). */
export async function runAct(t: Transport, tab: Tab, doc: FrameDoc, a: Adapter, op: string, backendNodeId: number): Promise<{ data: unknown; backendIds: Array<number | null> }> {
  needOp(a, op);
  const script = a.script ?? "";
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      const n = await t.send("DOM.resolveNode", { backendNodeId, executionContextId: ctx, objectGroup: GROUP }, doc.sessionId, 5000);
      const obj = isRecord(n["object"]) ? n["object"] : null;
      const objectId = obj === null ? null : str(obj, "objectId");
      if (objectId === null) throw new TabcapError("stale-ref", "the element is no longer in the page", "run snapshot again and use the new ref.");
      const fn = `function (op) { ${wrap(script)} const r = A.act(op, this); return [JSON.stringify(r && r.data), ...((r && r.nodes) || []).slice(0, 64)]; }`;
      const r = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: [{ value: op }], returnByValue: false, objectGroup: GROUP }, doc.sessionId, 10_000);
      return unpack(t, doc.sessionId, r, `adapter ${a.name} act ${op}`);
    });
  } finally {
    await release(t, doc.sessionId);
  }
}

/** act(op, document.documentElement) of the document `doc` (ops that look at a whole document). */
async function runDocAct(t: Transport, tab: Tab, doc: FrameDoc, a: Adapter, op: string): Promise<{ data: unknown; backendIds: Array<number | null> }> {
  needOp(a, op);
  const script = a.script ?? "";
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      const expression = `(() => { ${wrap(script)} const r = A.act(${JSON.stringify(op)}, document.documentElement); return [JSON.stringify(r && r.data), ...((r && r.nodes) || []).slice(0, 64)]; })()`;
      const r = await t.send("Runtime.evaluate", { expression, contextId: ctx, returnByValue: false, objectGroup: GROUP }, doc.sessionId, 10_000);
      return unpack(t, doc.sessionId, r, `adapter ${a.name} act ${op}`);
    });
  } finally {
    await release(t, doc.sessionId);
  }
}

/** detect(): manifest features over a DOM digest (isolated world) and main-world globals. Root document only. */
export async function runDetect(t: Transport, tab: Tab, doc: FrameDoc, adapters: readonly Adapter[], headers: Record<string, string> | null = null): Promise<Detection[]> {
  const withFeatures = adapters.filter((a) => a.detect.length > 0);
  if (withFeatures.length === 0) return adapters.map((a) => detectAdapter(a, { digest: { els: [], total: 0, truncated: false }, globals: null, headers }));
  const { attrs, tags } = digestNeeds(withFeatures);
  const digestRaw = await inWorld(t, tab, doc, async (ctx) => {
    const r = await t.send("Runtime.evaluate", { expression: `(${DIGEST_FN})(${JSON.stringify(attrs)}, ${JSON.stringify(tags)}, ${DIGEST_MAX})`, contextId: ctx, returnByValue: true }, doc.sessionId, 10_000);
    thrown(r, "adapter digest");
    return isRecord(r["result"]) ? r["result"]["value"] : null;
  });
  const digest = parseDigest(digestRaw);
  const names = globalNames(withFeatures);
  let globals: Record<string, boolean> | null = null;
  if (names.length > 0) {
    const r = await t.send("Runtime.evaluate", { expression: globalsExpression(names), returnByValue: true }, doc.sessionId, 5000).catch(() => null);
    const v = r !== null && isRecord(r["result"]) ? r["result"]["value"] : null;
    if (Array.isArray(v) && r !== null && !isRecord(r["exceptionDetails"])) {
      globals = {};
      names.forEach((n, i) => {
        if (globals !== null) globals[n] = v[i] === true;
      });
    }
  }
  return adapters.map((a) => detectAdapter(a, { digest, globals, headers }));
}

export type PageView = { overlays: Overlay[] | null; detected: Detection[] | null; error: string | null; challenge?: ChallengeView | null };

const refMaker = (backendIds: Array<number | null>, refFor: (id: number) => string): NodeRef => (n) => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  const id = backendIds[n];
  return id === undefined || id === null ? null : refFor(id);
};

/** Ref minting for the nodes of one document: root refs, or frame-path refs of a child frame. */
const minter = (tab: Tab, frame: FrameBinding | null) => (id: number) => tab.refs.refFor(id, frame);

/** Child frames whose overlays the header looks at (tree order); deeper or later frames are skipped. */
export const MAX_OVERLAY_FRAMES = 16;
/** Close buttons an overlay lists (host document and the layer's iframe together). */
const MAX_CLOSE = 8;

/** Frame ids of the iframes / frames inside an overlay element (document order, at most 3). */
async function framesInside(t: Transport, tab: Tab, doc: FrameDoc, backendNodeId: number): Promise<string[]> {
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      const n = await t.send("DOM.resolveNode", { backendNodeId, executionContextId: ctx, objectGroup: GROUP }, doc.sessionId, 5000);
      const obj = isRecord(n["object"]) ? n["object"] : null;
      const objectId = obj === null ? null : str(obj, "objectId");
      if (objectId === null) return [];
      const r = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: `function () { return ["[]", ...Array.from(this.querySelectorAll("iframe, frame")).slice(0, 3)]; }`, returnByValue: false, objectGroup: GROUP }, doc.sessionId, 5000);
      const listId = str(isRecord(r["result"]) ? r["result"] : {}, "objectId");
      if (listId === null) return [];
      const props = await t.send("Runtime.getProperties", { objectId: listId, ownProperties: true }, doc.sessionId, 5000);
      const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
      const ids: string[] = [];
      for (const p of list) {
        if (!/^[1-9]$/.test(String(p["name"])) || !isRecord(p["value"])) continue;
        const oid = str(p["value"], "objectId");
        if (oid === null) continue;
        const d = await t.send("DOM.describeNode", { objectId: oid }, doc.sessionId, 5000).catch(() => null);
        const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
        const id = node === null ? null : str(node, "frameId");
        if (id !== null) ids.push(id);
      }
      return ids;
    });
  } catch {
    return [];
  } finally {
    await release(t, doc.sessionId);
  }
}

/**
 * Overlays of one document. Overlays with an iframe (iframe layers) also get
 * the close buttons of the document inside that iframe, with its frame path
 * (0.4-I): layer.js-style layers often draw their close button there.
 */
async function overlaysOf(t: Transport, tab: Tab, doc: FrameDoc, here: FrameNode | null, a: Adapter): Promise<Overlay[]> {
  const frame = here === null || here.path === "" ? null : bindingOf(here);
  const r = await runDescribe(t, tab, doc, a);
  const list = parseOverlayNodes(r.data, refMaker(r.backendIds, minter(tab, frame)));
  for (const { overlay: o, n } of list) {
    if (frame !== null) o.frame = frame.path;
    if (o.iframe === null || here === null || here.children.length === 0) continue;
    const id = typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? (r.backendIds[n] ?? null) : null;
    if (id === null) continue;
    const ids = await framesInside(t, tab, doc, id);
    const layer = ids.map((x) => here.children.find((c) => c.frameId === x)).find((c) => c !== undefined);
    if (layer === undefined) continue;
    o.layerFrame = layer.path;
    if (!(a.hooks.act?.ops ?? []).includes("buttons")) continue;
    try {
      const b = await runDocAct(t, tab, docOf(layer), a, "buttons");
      const inner = isRecord(b.data) ? parseButtons(b.data["close"], refMaker(b.backendIds, minter(tab, bindingOf(layer)))) : [];
      o.close = [...o.close, ...inner].slice(0, MAX_CLOSE);
    } catch (e) {
      log.warn("iframe layer buttons failed", { tab: tab.id, frame: layer.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return list.map((x) => x.overlay);
}

/**
 * Header data for snapshot / outline: detections of every adapter and the
 * overlay adapter's description, of the root document and (0.4-I) of the
 * child frames in `tree`. Never throws: a failing adapter turns into `error`
 * and null fields, so snapshot itself still works; a failing child frame is
 * skipped.
 */
export async function inspectPage(t: Transport, tab: Tab, doc: FrameDoc, adapters: readonly Adapter[] = builtinAdapters(), tree: FrameNode | null = null): Promise<PageView> {
  const view: PageView = { overlays: null, detected: null, error: null };
  try {
    view.detected = await runDetect(t, tab, doc, adapters);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
    log.warn("adapter detect failed", { tab: tab.id, error: view.error });
  }
  const overlay = adapters.find((a) => a.category === "overlay" && a.hooks.describe !== undefined);
  if (overlay === undefined) return { ...view, overlays: [] };
  const conf = view.detected?.find((d) => d.adapter === overlay.name)?.confidence ?? 0;
  const always = overlay.hooks.describe?.when !== "detected";
  let found: Overlay[] = [];
  if (always || conf > 0) {
    try {
      found = await overlaysOf(t, tab, doc, tree, overlay);
    } catch (e) {
      view.error = e instanceof Error ? e.message : String(e);
      log.warn("overlay describe failed", { tab: tab.id, error: view.error });
      return view;
    }
  }
  // Child frames: describe only (detect stays a root-document answer); `when: detected` adapters skip frames.
  if (always && tree !== null) {
    for (const f of descendants(tree).slice(0, MAX_OVERLAY_FRAMES)) {
      try {
        found.push(...(await overlaysOf(t, tab, docOf(f), f, overlay)));
      } catch (e) {
        log.info("overlay describe skipped a frame", { tab: tab.id, frame: f.path, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  view.overlays = found.map((o, i) => ({ ...o, id: `o${i + 1}` }));
  view.challenge = await pageChallenge(t, tab, doc, tree);
  return view;
}

/**
 * 0.6-D: scan one document for an image captcha (browser/captcha.ts) in the
 * isolated world; `target` (a backend node id) also says which form an action
 * acts on. Refs of the image and the input are minted in the document's frame
 * (DOM-backed refs: neither needs an accessibility line). Null when nothing is
 * found; throws on CDP errors.
 */
export async function scanCaptcha(t: Transport, tab: Tab, doc: FrameDoc, frame: FrameBinding | null, target: number | null = null): Promise<{ scan: CaptchaScan; hit: CaptchaHit; view: ChallengeView } | null> {
  try {
    return await inWorld(t, tab, doc, async (ctx) => {
      let r: Record<string, unknown>;
      const args = [{ value: CAPTCHA_SCAN_CAP }, { value: target !== null }];
      if (target !== null) {
        const n = await t.send("DOM.resolveNode", { backendNodeId: target, executionContextId: ctx, objectGroup: GROUP }, doc.sessionId, 5000);
        const obj = isRecord(n["object"]) ? n["object"] : null;
        const objectId = obj === null ? null : str(obj, "objectId");
        if (objectId === null) return null;
        r = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CAPTCHA_SCAN_FN, arguments: args, returnByValue: false, objectGroup: GROUP }, doc.sessionId, 10_000);
      } else {
        r = await t.send("Runtime.callFunctionOn", { executionContextId: ctx, functionDeclaration: CAPTCHA_SCAN_FN, arguments: args, returnByValue: false, objectGroup: GROUP }, doc.sessionId, 10_000);
      }
      const { data, backendIds } = await unpack(t, doc.sessionId, r, "captcha scan");
      const scan = parseCaptchaScan(data);
      const hit = detectCaptcha(scan);
      if (hit === null) return null;
      const ref = (n: number | null): string | null => {
        const id = n === null ? null : (backendIds[n] ?? null);
        return id === null ? null : tab.refs.refFor(id, frame);
      };
      const view: ChallengeView = { kind: "image-captcha", image: ref(hit.image), input: ref(hit.input), advisory: true, ...(frame === null || frame.path === "" ? {} : { frame: frame.path }) };
      return { scan, hit, view };
    });
  } finally {
    await release(t, doc.sessionId);
  }
}

/** The first image captcha of the root document, then of the child frames (tree order); null when none (or the scan failed). */
async function pageChallenge(t: Transport, tab: Tab, doc: FrameDoc, tree: FrameNode | null): Promise<ChallengeView | null> {
  const docs: Array<{ doc: FrameDoc; frame: FrameBinding | null }> = [{ doc, frame: null }];
  if (tree !== null) for (const f of descendants(tree).slice(0, MAX_OVERLAY_FRAMES)) docs.push({ doc: docOf(f), frame: bindingOf(f) });
  for (const x of docs) {
    try {
      const r = await scanCaptcha(t, tab, x.doc, x.frame);
      if (r !== null) return r.view;
    } catch (e) {
      log.info("captcha scan skipped a document", { tab: tab.id, frame: x.frame?.path ?? "", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return null;
}

export type Cover = { overlay: Overlay; at: { x: number; y: number } | null; offscreen: boolean };

/**
 * Ask the overlay adapter whether this element is covered in its own document
 * `doc`; null when it is not (or no overlay adapter is loaded). `frame`: the
 * frame `doc` is, for the refs of the answer (null: the root document).
 */
export async function coveredBy(t: Transport, tab: Tab, doc: FrameDoc, backendNodeId: number, adapters: readonly Adapter[] = builtinAdapters(), frame: FrameBinding | null = null): Promise<Cover | null> {
  const a = adapters.find((x) => x.category === "overlay" && (x.hooks.act?.ops ?? []).includes("covered"));
  if (a === undefined) return null;
  const r = await runAct(t, tab, doc, a, "covered", backendNodeId);
  const d = isRecord(r.data) ? r.data : {};
  if (d["covered"] !== true) return null;
  const overlay = parseOverlay(d["overlay"], refMaker(r.backendIds, minter(tab, frame)), "o1");
  if (overlay === null) return null;
  if (frame !== null) overlay.frame = frame.path;
  const atRaw = isRecord(d["at"]) ? d["at"] : null;
  const at = atRaw !== null && typeof atRaw["x"] === "number" && typeof atRaw["y"] === "number" ? { x: Math.round(atRaw["x"]), y: Math.round(atRaw["y"]) } : null;
  return { overlay, at, offscreen: d["offscreen"] === true };
}

/** The `covered` error click / fill fail with: what covers the target and its close-button refs; tabcap never closes it. */
export function coveredError(ref: string, c: Cover): TabcapError {
  const o = c.overlay;
  const what = `${o.kind}${o.name === "" ? "" : ` "${o.name}"`}${o.frame === undefined ? "" : ` in frame ${o.frame}`}`;
  const where = c.offscreen ? "(the target is off-screen and the overlay covers the whole viewport)" : c.at === null ? "" : `at (${c.at.x}, ${c.at.y})`;
  const list = (bs: Overlay["close"]) => bs.map((b) => (b.ref === null ? `"${b.label}"` : `${b.ref} "${b.label}"`)).join(", ");
  let next: string;
  if (o.kind === "consent") next = `A consent banner covers it: the human decides (choices: ${list(o.choices) || "none found"}). Ask them; tabcap never answers consent on its own.`;
  else if (o.kind === "timeout-prompt") next = `A session-timeout prompt covers it: tell the human${o.choices.length > 0 ? ` (choices: ${list(o.choices)})` : ""}. tabcap never closes overlays on its own.`;
  else if (o.close.length > 0) next = `Close buttons of the overlay: ${list(o.close)}. If closing it is right for the task, click one of them (\`tabcap click ${o.close.find((b) => b.ref !== null)?.ref ?? "<ref>"}\`), then retry; tabcap never closes overlays on its own.`;
  else next = "The overlay has no close button: wait for it to go away (`tabcap wait --fn …`, then retry) or ask the human (`tabcap screenshot`). tabcap never closes overlays on its own.";
  return new TabcapError("covered", `ref ${ref} is covered by ${what} ${where}`.trim(), next, { overlay: o });
}
