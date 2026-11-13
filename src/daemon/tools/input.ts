// tabcap click | fill | type | press — focus ladder levels 1 and 2 (docs/07 §1.1):
// DOM first, trusted CDP input with focus emulation on request,
// delivery probe and occlusion check so a lost click fails honestly.
// Input fidelity (docs/10, owner decisions 10-15): `click --trusted` moves the
// pointer along a path to the target, presses, waits, releases (Chrome builds
// the pointer / mouse events, all isTrusted); `type --trusted` sends one key
// event pair per character. The default paths stay DOM click / one insertText
// and say so in `eventShape`. No input command ever retries on its own.
// 0.3-F (docs/08 §5): `click --dbl-click`, `hover`, `type --submit-key`,
// `press-key`, `upload`; every interactive command waits after the action
// (tools/settle.ts; `--no-wait` skips it) and can bring back a fresh snapshot
// (`--snapshot`).

import { TabcapError } from "../../shared/envelope.ts";
import { accountState, FAILED_LOGIN_LIMIT } from "../pool/rules.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { withFocusEmulation } from "../browser/focus.ts";
import type { Tab } from "../browser/targets.ts";
import { LOGIN_LIMIT } from "../guard.ts";
import { isSensitiveField } from "../secrets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { callResult, docIdentity, resolveRef } from "../browser/doc.ts";
import { snapshotAfter } from "./snapshot.ts";
import { withNotices } from "./notices.ts";
import { requestWaitOf } from "./reqwait.ts";
import { withPostWait } from "./settle.ts";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { coveredBy, coveredError } from "../adapters/runtime.ts";
import { chainTo, placeChain, rawFrames } from "../browser/frames.ts";
import { parseFramePath, type FrameBinding } from "../browser/refs.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import { log } from "../../shared/log.ts";
import { CdpTimeoutError } from "../transport/direct/cdp.ts";
import { keyEventParams, planClick, planTyping, type ClickPlan, type Point, type Rng } from "./inputplan.ts";
import { classifyEffect, watchEffect, type EffectWatch } from "./effect.ts";
import { actionChallenge } from "./challenge.ts";
import { inspectLanding, type Landing } from "./landing.ts";
import type { DirectTransport } from "../transport/direct/index.ts";
import { isExtendedVk, layoutName, planScanKeys, planUnicode, VK, type OsInput, type OsStroke } from "../os/input.ts";
import {
  calibrationStep,
  counting,
  estimates,
  FOCUS_ANSWER_MS,
  FOCUS_EXPR,
  frontCheck,
  giveBack,
  loadOsInput,
  logOs,
  OS_TYPE_DELAY_MS,
  osExclusive,
  parseAt,
  placePointer,
  POINTER_OFF_FN,
  POINTER_READ_FN,
  POINTER_WATCH_FN,
  pressButton,
  sendChord,
  sendStrokes,
  stepInside,
  stoppedError,
  strokesMs,
  takeForeground,
  VIEW_EXPR,
  viewOf,
  type ForegroundReport,
  type FrontCheck,
  type FrontState,
  type PageFocus,
  type StopFlag,
} from "./osinput.ts";

const ELEMENT = "const el = this.nodeType === 1 ? this : this.parentElement;";
// A ref whose node was replaced (framework re-render) can still resolve to the
// detached node; clicking it would "succeed" without touching the page (docs/05 s18).
const LIVE = "if (!el || !el.isConnected) return { stale: true };";

export const CLICK_FN = `function () { ${ELEMENT} ${LIVE}
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 60) };
}`;

// DOM double click: two clicks and a dblclick event (all isTrusted:false).
export const DBLCLICK_FN = `function () { ${ELEMENT} ${LIVE}
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  el.click();
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, detail: 2, view: window }));
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 60) };
}`;

export const SCROLL_FN = `function () { ${ELEMENT} ${LIVE} el.scrollIntoView({ block: "center", inline: "center" }); return { ok: true }; }`;

const OCCLUSION_FN = `function (x, y) { ${ELEMENT}
  const hit = document.elementFromPoint(x, y);
  const ok = !!el && !!hit && (hit === el || el.contains(hit));
  const d = (n) => n ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\\s+/).join(".") : "") : null;
  return { ok, hit: d(hit) };
}`;

// 0.7.3: the same point test for a plain click, after the overlay classifier.
// An ancestor of the target that is a clickable container (the target is its
// label / icon) still counts; anything else on top is `covered`.
const HIT_FN = `function (px, py) { ${ELEMENT} ${LIVE}
  const d = (n) => n ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\\s+/).join(".") : "") : null;
  const clickable = (n) => {
    if (!n || n.nodeType !== 1) return false;
    if (n.matches("a[href], button, label, summary, [role=button], [role=link], [onclick], input, select, textarea")) return true;
    return getComputedStyle(n).cursor === "pointer";
  };
  let x = typeof px === "number" ? px : null, y = typeof py === "number" ? py : null;
  if (x === null || y === null) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { skip: true };
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  const hit = document.elementFromPoint(x, y);
  let ok = hit !== null && (hit === el || el.contains(hit));
  if (!ok && hit !== null && hit.contains(el)) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (clickable(n)) { ok = true; break; }
      if (n === hit) break;
    }
  }
  return { ok, hit: d(hit), x: Math.round(x), y: Math.round(y) };
}`;

// docs/04 §53.1: what a press at (x, y) lands on, and whether that is a different
// clickable element inside a target that is not clickable itself (a whole option
// list whose centre is another option). Same clickable test as HIT_FN, plus the
// roles of options and menu items.
const LANDED_FN = `function (x, y) { ${ELEMENT} ${LIVE}
  const clickable = (n) => {
    if (!n || n.nodeType !== 1) return false;
    if (n.matches("a[href], button, label, summary, input, select, textarea, option, [onclick], [role=button], [role=link], [role=option], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=treeitem], [role=checkbox], [role=radio], [role=switch]")) return true;
    return getComputedStyle(n).cursor === "pointer";
  };
  const hit = document.elementFromPoint(x, y);
  const of = (n) => ({ tag: n.tagName.toLowerCase(), text: String(n.innerText || n.value || "").replace(/\\s+/g, " ").trim().slice(0, 60) });
  if (!hit || hit === el || !el.contains(hit)) return { ambiguous: false, landed: hit ? of(hit) : null };
  let inner = null;
  for (let n = hit; n && n !== el; n = n.parentElement) if (clickable(n)) inner = n;
  return { ambiguous: inner !== null && !clickable(el), landed: of(inner || hit), target: el.tagName.toLowerCase() };
}`;

/** docs/04 §53.1: where a press landed (answer field `landedOn`). */
export type LandedOn = { tag: string; text: string };

const landedOf = (v: unknown): LandedOn | null => (isRecord(v) && typeof v["tag"] === "string" ? { tag: v["tag"], text: str(v, "text") ?? "" } : null);

/** docs/04 §53.1: the refusal; nothing was clicked. */
export function ambiguousError(ref: string, target: string, landed: LandedOn): TabcapError {
  const what = landed.text === "" ? `<${landed.tag}>` : `<${landed.tag}> ${JSON.stringify(landed.text)}`;
  return new TabcapError(
    "ambiguous-target",
    `ref ${ref} is a container (<${target}>, not clickable itself); a press at its centre would land on another clickable element, ${what}; nothing was clicked`,
    landed.text === "" ? "Run `tabcap snapshot` and pick the item's own ref, or use the `clickable` ref of a `tabcap find` hit." : `Use \`tabcap find ${JSON.stringify(landed.text)}\` to get that item's ref, or the \`clickable\` ref of a \`tabcap find\` hit.`,
    { landedOn: landed },
  );
}

/** Run LANDED_FN at (x, y) in the node's document: `ambiguous-target` when the press would land on another clickable element inside a non-clickable target. */
async function landedGate(t: Transport, sessionId: string, objectId: string, ref: string, x: number, y: number): Promise<LandedOn | null> {
  const v = liveOrStale(rec(callResult(await call(t, sessionId, objectId, LANDED_FN, [x, y]))), ref);
  const landed = landedOf(v["landed"]);
  if (v["ambiguous"] === true && landed !== null) throw ambiguousError(ref, str(v, "target") ?? "?", landed);
  return landed;
}

// docs/04 §53.3: is the target visible now (after scrolling it into view)? The
// snapshot's rules (browser/layout.ts) in the page: computed visibility, opacity 0
// on it or an ancestor, no box of its own and none below it, entirely outside an
// ancestor that clips (overflow hidden / clip; not past a positioned element).
// A checkbox / radio with a label is drawn by its label and counts as visible.
export const VISIBLE_FN = `function () { ${ELEMENT} ${LIVE}
  const view = el.ownerDocument.defaultView || window;
  if (el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type) && el.labels && el.labels.length > 0) return { visible: true };
  const boxed = (n) => { const r = n.getBoundingClientRect(); return n.getClientRects().length > 0 && r.width >= 1 && r.height >= 1; };
  const cs = view.getComputedStyle(el);
  if (cs.visibility !== "visible") return { visible: false, why: "visibility: " + cs.visibility };
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (Number(view.getComputedStyle(n).opacity) === 0) return { visible: false, why: n === el ? "opacity 0" : "opacity 0 on an ancestor" };
  }
  if (!boxed(el)) {
    const kids = el.querySelectorAll("*");
    let any = false;
    for (let i = 0; i < kids.length && i < 500 && !any; i++) any = boxed(kids[i]) && view.getComputedStyle(kids[i]).visibility === "visible";
    if (!any) return { visible: false, why: "no box (zero size or not rendered)" };
    return { visible: true };
  }
  const r = el.getBoundingClientRect();
  for (let n = el, p = el.parentElement; p && p.nodeType === 1; n = p, p = p.parentElement) {
    const pos = view.getComputedStyle(n).position;
    if (pos === "fixed" || pos === "absolute") break;
    const pcs = view.getComputedStyle(p);
    const ox = pcs.overflowX === "hidden" || pcs.overflowX === "clip";
    const oy = pcs.overflowY === "hidden" || pcs.overflowY === "clip";
    if (!ox && !oy) continue;
    const pr = p.getBoundingClientRect();
    if ((ox && (r.right <= pr.left || r.left >= pr.right)) || (oy && (r.bottom <= pr.top || r.top >= pr.bottom))) return { visible: false, why: "clipped away by an ancestor with overflow: hidden" };
  }
  return { visible: true };
}`;

/** docs/04 §53.3: the refusal; nothing was done. */
export function notVisibleError(ref: string, why: string): TabcapError {
  return new TabcapError(
    "not-visible",
    `ref ${ref} is not visible (${why}); nothing was done`,
    "Run `tabcap snapshot` to see what is visible now (an element hidden after the snapshot keeps its ref but cannot be acted on); a visible element with the same text may be elsewhere: `tabcap find <text>`.",
    { why },
  );
}

/** docs/04 §53.3: `not-visible` unless the node is visible now. */
export async function visibleGate(t: Transport, sessionId: string, objectId: string, ref: string): Promise<void> {
  const v = liveOrStale(rec(callResult(await call(t, sessionId, objectId, VISIBLE_FN))), ref);
  if (v["visible"] !== true) throw notVisibleError(ref, str(v, "why") ?? "hidden");
}

// Capture-phase probe: did pointerdown / mousedown reach this element?
const PROBE_FN = `function () { ${ELEMENT}
  const st = { pd: false, md: false };
  const h = (e) => { if (el && el.contains(e.target)) { if (e.type === "pointerdown") st.pd = true; else st.md = true; } };
  window.addEventListener("pointerdown", h, true);
  window.addEventListener("mousedown", h, true);
  st.off = () => { window.removeEventListener("pointerdown", h, true); window.removeEventListener("mousedown", h, true); };
  return st;
}`;
const PROBE_READ_FN = `function () { this.off(); return { pointerdown: this.pd, mousedown: this.md }; }`;

export const FILL_FN = `function (text) { ${ELEMENT} ${LIVE}
  el.scrollIntoView({ block: "center" });
  const type = el.getAttribute("type"), ac = el.getAttribute("autocomplete");
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return { kind: "readonly", type, ac };
    el.focus();
    // The element's own prototype setter (a cross-prototype call throws Illegal invocation);
    // bypassing the instance property lets React-style trackers see the change.
    let proto = Object.getPrototypeOf(el), desc;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "value"))) proto = Object.getPrototypeOf(proto);
    if (!desc || !desc.set) return { kind: "nosetter", type, ac };
    desc.set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { kind: "input", type: el.type, ac, matches: el.value === text };
  }
  if (el.isContentEditable) {
    el.focus();
    const s = window.getSelection(); if (s) s.selectAllChildren(el);
    return { kind: "contenteditable", type: null, ac: null };
  }
  return { kind: "unsupported", tag: el.tagName.toLowerCase(), type, ac };
}`;

// Focus + select the current content so Input.insertText replaces it (trusted path).
export const FOCUS_SELECT_FN = `function () { ${ELEMENT} ${LIVE}
  el.scrollIntoView({ block: "center" });
  el.focus();
  const type = el.getAttribute("type"), ac = el.getAttribute("autocomplete");
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return { kind: "input", type: el.type, ac }; }
  if (el.isContentEditable) { const s = window.getSelection(); if (s) s.selectAllChildren(el); return { kind: "contenteditable", type: null, ac: null }; }
  return { kind: "unsupported", tag: el.tagName.toLowerCase(), type, ac };
}`;

// The focused element, through open shadow roots and (0.4-I) same-origin
// frames. `none`: nothing editable has focus (Chrome moves focus to <body>
// when the focused node is removed), so Input.insertText would go nowhere;
// `connected` is the node's own isConnected. `cross`: focus is inside a frame
// this document cannot look into (out of process); the caller continues in
// that frame's session. `el: true` returns the element itself instead.
const activeExpr = (el: boolean) => `(() => {
  let doc = document, el = doc.activeElement;
  for (let hop = 0; hop < 16; hop++) {
    for (let i = 0; el && el.shadowRoot && el.shadowRoot.activeElement && i < 16; i++) el = el.shadowRoot.activeElement;
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) break;
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner) ${el ? "return el;" : `return { cross: true, connected: !!el.isConnected, none: false, tag: el.tagName.toLowerCase(), type: null, ac: null };`}
    doc = inner;
    el = doc.activeElement;
  }
  ${
    el
      ? "return null;"
      : `const top = !el || el === doc.body || el === doc.documentElement;
  const editable = !!el && (el.isContentEditable || doc.designMode === "on");
  return { connected: !!el && el.isConnected, none: top && !editable, tag: el ? el.tagName.toLowerCase() : null, type: el ? el.getAttribute("type") : null, ac: el ? el.getAttribute("autocomplete") : null };`
  }
})()`;
export const ACTIVE_FN = activeExpr(false);
const ACTIVE_FRAME_EL = activeExpr(true);

/** Runtime.callFunctionOn on a node through the session that owns its document. */
async function call(t: Transport, sessionId: string, objectId: string, fn: string, args: unknown[] = [], byValue = true): Promise<Record<string, unknown>> {
  return t.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: byValue, userGesture: true },
    sessionId,
  );
}

/**
 * A node an input command acts on: its JS object, backend id, and (0.4-I) the
 * session owning its document and its frame (absent / null: the root document).
 */
export type InputNode = { objectId: string; backendNodeId: number; sessionId?: string; frame?: FrameBinding | null };

const sessionOf = (tab: Tab, node: InputNode): string => node.sessionId ?? tab.sessionId;
const frameOf = (node: InputNode): FrameBinding | null => node.frame ?? null;

/** `frame` of an input command's output: the frame path of a frame ref (root refs: nothing). */
const frameField = (node: InputNode): Record<string, string> => {
  const f = frameOf(node);
  return f === null ? {} : { frame: f.path };
};

/** An ancestor frame on the way from the root to a ref's frame: its document and the owner element of the next frame down. */
type Ancestor = { doc: FrameDoc; binding: FrameBinding | null; owner: number; origin: Point };

/**
 * Where a frame ref's document sits (docs/07 §1.1): `space` is the top-level
 * position of the viewport its box models are measured in, `origin` the
 * top-level position of the frame's own viewport, `ancestors` the documents
 * above it (root first) with the owner element of the next frame. The root
 * document needs no CDP call.
 */
type Place = { space: Point; origin: Point; ancestors: Ancestor[] };

async function placeOf(t: Transport, tab: Tab, node: InputNode, ref: string): Promise<Place> {
  const f = frameOf(node);
  if (f === null) return { space: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, ancestors: [] };
  const chain = chainTo(await rawFrames(t, tab), f.frameId);
  const depth = parseFramePath(f.path)?.length ?? -1;
  if (chain === null || chain.length !== depth + 1) throw new TabcapError("stale-ref", `ref ${ref} expired: frame ${f.path} is no longer where the snapshot saw it`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
  const at = await placeChain(t, chain);
  const root = await docIdentity(t, tab);
  const parts = f.path.split("/");
  const ancestors: Ancestor[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = chain[i];
    const owner = at.owner[i + 1];
    if (p === undefined || owner === undefined || owner === null) continue;
    const path = parts.slice(0, i).join("/");
    ancestors.push({
      doc: i === 0 ? rootDoc(tab, root) : { frameId: p.frameId, loaderId: p.loaderId, url: p.url, sessionId: p.sessionId },
      binding: i === 0 ? null : { path, frameId: p.frameId, sessionId: p.sessionId, loaderId: p.loaderId },
      owner,
      origin: at.origin[i] ?? { x: 0, y: 0 },
    });
  }
  return { space: at.space.at(-1) ?? { x: 0, y: 0 }, origin: at.origin.at(-1) ?? { x: 0, y: 0 }, ancestors };
}

/**
 * Trusted input into a frame: the point must hit the target in its own
 * document (frame-local coordinates) and, in every ancestor document, the
 * owner element of the frame below. A miss is reported like a covered target.
 */
async function occlusionChain(t: Transport, tab: Tab, node: InputNode, ref: string, to: Point, place: Place): Promise<void> {
  const local = { x: to.x - place.origin.x, y: to.y - place.origin.y };
  const occ = rec(callResult(await call(t, sessionOf(tab, node), node.objectId, OCCLUSION_FN, [local.x, local.y])));
  if (occ["ok"] !== true) {
    throw new TabcapError("page", `ref ${ref} is covered at (${Math.round(to.x)}, ${Math.round(to.y)}) by ${str(occ, "hit") ?? "nothing"}`, "Close the overlay first (snapshot to find it), or use plain `tabcap click <ref>` (DOM click).");
  }
  for (const a of [...place.ancestors].reverse()) {
    const r = await t.send("DOM.resolveNode", { backendNodeId: a.owner }, a.doc.sessionId, 5000).catch(() => null);
    const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
    const oid = obj === null ? null : str(obj, "objectId");
    if (oid === null) throw new TabcapError("stale-ref", `ref ${ref} expired: its frame's owner element is gone`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
    const v = rec(callResult(await call(t, a.doc.sessionId, oid, OCCLUSION_FN, [to.x - a.origin.x, to.y - a.origin.y])));
    if (v["ok"] !== true) {
      const where = a.binding === null ? "the root document" : `frame ${a.binding.path}`;
      throw new TabcapError("page", `ref ${ref} is covered at (${Math.round(to.x)}, ${Math.round(to.y)}) by ${str(v, "hit") ?? "nothing"} in ${where}`, "Close the overlay first (snapshot to find it), or use plain `tabcap click <ref>` (DOM click).");
    }
  }
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** The page function found the node detached (or not an element): stale-ref, never a fake success. */
export function liveOrStale(v: Record<string, unknown>, ref: string): Record<string, unknown> {
  if (v["stale"] === true) throw new TabcapError("stale-ref", `ref ${ref} points at an element that is no longer in the page (it was removed or re-rendered)`, "run snapshot again and use the new ref.");
  return v;
}

/**
 * Scroll the target into view, then ask the overlay adapter whether something
 * covers it (docs/09 §2.3). Covered → `covered` error naming the overlay and its
 * close-button refs; tabcap never closes overlays itself. If the check itself
 * fails the action goes on as before and the output says `overlayCheck: "skipped"`.
 * `deep` (a plain click, 0.7.3): after the classifier, also hit-test the target's
 * centre like the trusted path does, so an overlay the classifier missed still
 * fails as `covered` instead of clicking through it.
 */
export async function overlayGate(t: Transport, tab: Tab, node: InputNode, ref: string, deep = false): Promise<"clear" | "skipped"> {
  liveOrStale(rec(callResult(await call(t, sessionOf(tab, node), node.objectId, SCROLL_FN))), ref);
  await visibleGate(t, sessionOf(tab, node), node.objectId, ref);
  let cover;
  try {
    const f = frameOf(node);
    const root = await docIdentity(t, tab);
    const own: FrameDoc = f === null ? rootDoc(tab, root) : { frameId: f.frameId, loaderId: f.loaderId, url: "", sessionId: f.sessionId };
    cover = await coveredBy(t, tab, own, node.backendNodeId, undefined, f);
    // 0.4-I: a frame ref is also covered when an overlay of an ancestor document covers the frame's owner element.
    if (cover === null && f !== null) {
      const place = await placeOf(t, tab, node, ref);
      for (const a of [...place.ancestors].reverse()) {
        cover = await coveredBy(t, tab, a.doc, a.owner, undefined, a.binding);
        if (cover !== null) break;
      }
    }
  } catch (e) {
    if (e instanceof TabcapError && e.code === "stale-ref") throw e;
    log.warn("overlay check failed", { tab: tab.id, ref, error: e instanceof Error ? e.message : String(e) });
    return "skipped";
  }
  if (cover !== null) throw coveredError(ref, cover);
  if (deep) await hitGate(t, tab, node, ref);
  return "clear";
}

/** The `covered` error of the point test: same shape as the trusted path, same "close the overlay first" next step. */
function hitError(ref: string, hit: string | null, x: number, y: number, where = ""): TabcapError {
  return new TabcapError(
    "covered",
    `ref ${ref} is covered at (${x}, ${y}) by ${hit ?? "nothing"}${where}`,
    "Close the overlay first (snapshot to find it), then retry; tabcap never closes overlays on its own.",
  );
}

/**
 * 0.7.3: hit-test the target's centre (and, for a frame ref, the owner element in
 * every ancestor document) before a plain click. A hit on the target, its
 * descendant, or a clickable ancestor container is clear; anything else is
 * `covered`, exactly the decision the trusted path's targetPoint makes.
 */
async function hitGate(t: Transport, tab: Tab, node: InputNode, ref: string): Promise<void> {
  const sid = sessionOf(tab, node);
  const v = liveOrStale(rec(callResult(await call(t, sid, node.objectId, HIT_FN))), ref);
  if (v["skip"] === true) return; // no box: the DOM click can still act (zero-size / contents)
  const x = num(v, "x") ?? 0;
  const y = num(v, "y") ?? 0;
  if (v["ok"] !== true) throw hitError(ref, str(v, "hit"), Math.round(x), Math.round(y));
  await landedGate(t, sid, node.objectId, ref, x, y);
  const f = frameOf(node);
  if (f === null) return;
  const place = await placeOf(t, tab, node, ref);
  const to = { x: x + place.space.x, y: y + place.space.y };
  for (const a of [...place.ancestors].reverse()) {
    const r = await t.send("DOM.resolveNode", { backendNodeId: a.owner }, a.doc.sessionId, 5000).catch(() => null);
    const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
    const oid = obj === null ? null : str(obj, "objectId");
    if (oid === null) throw new TabcapError("stale-ref", `ref ${ref} expired: its frame's owner element is gone`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
    const at = { x: Math.round(to.x - a.origin.x), y: Math.round(to.y - a.origin.y) };
    const hit = rec(callResult(await call(t, a.doc.sessionId, oid, HIT_FN, [at.x, at.y])));
    if (hit["ok"] !== true) {
      const where = a.binding === null ? " in the root document" : ` in frame ${a.binding.path}`;
      throw hitError(ref, str(hit, "hit"), at.x, at.y, where);
    }
  }
}

/** Centre of the node's content box, after scrolling it into view: CSS px in the viewport of the session's local root (the tab for the root document and same-process frames). */
async function centre(t: Transport, sessionId: string, backendNodeId: number, ref: string): Promise<{ x: number; y: number }> {
  const r = await t.send("DOM.getBoxModel", { backendNodeId }, sessionId, 5000).catch(() => null);
  const model = r !== null && isRecord(r["model"]) ? r["model"] : null;
  const q = model !== null && Array.isArray(model["content"]) ? model["content"].filter((n): n is number => typeof n === "number") : [];
  if (q.length < 8) throw new TabcapError("page", `ref ${ref} has no box (hidden or zero-size)`, "Use plain `tabcap click <ref>` (DOM click), or snapshot again to find a visible element.");
  const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
  const ys = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
  return { x: xs.reduce((s, v) => s + v, 0) / 4, y: ys.reduce((s, v) => s + v, 0) / 4 };
}

/** The marker of the DOM click path (docs/10 §3.1, owner decision D1). */
export const DOM_CLICK_WARNING = "incomplete event sequence: DOM el.click(), a click event only, isTrusted=false, no pointer / mouse sequence";
export const INSERT_WARNING = "incomplete event sequence: no key events (one Input.insertText, like a paste / fill)";

/** Per-call limits of the trusted path (docs/07 §1.1). */
export const PAINT_TIMEOUT_MS = 1000;
export const MOVE_TIMEOUT_MS = 1000;
const PRESS_TIMEOUT_MS = 5000;

/** Animation frames further apart than this: the tab's frames are throttled. */
export const SLOW_FRAME_MS = 100;
/** Frame gaps the paint check measures after the first frame. */
export const FRAME_GAPS = 3;

/**
 * rAF paint check (docs/10 §3.4): only a page that runs an animation frame
 * within 1 s and says `visible` counts as painted. The in-page timer settles
 * the promise when rAF never fires; the CDP timeout is the backstop.
 * `frameMs`: the largest gap over the next FRAME_GAPS animation frames, null
 * when one of them does not come within SLOW_FRAME_MS (see holdFrames; a
 * throttled tab can show two frames close together, then none for ~1 s).
 */
export const PAINT_EXPR = `new Promise((resolve) => {
  let done = false, last = null, max = 0, gaps = 0, timer = null;
  const fin = (raf, frameMs) => { if (!done) { done = true; clearTimeout(timer); resolve({ raf, frameMs, visibility: document.visibilityState }); } };
  const tick = () => {
    const now = performance.now();
    if (last !== null) { max = Math.max(max, now - last); gaps++; }
    last = now;
    if (gaps >= ${FRAME_GAPS}) { fin(true, Math.round(max)); return; }
    clearTimeout(timer);
    timer = setTimeout(() => fin(true, null), ${SLOW_FRAME_MS});
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => { if (last === null) fin(false, null); }, ${PAINT_TIMEOUT_MS});
})`;

export type Paint = { painted: boolean; raf: boolean; visibility: string | null; frameMs: number | null; error: string | null };

export async function paintCheck(t: Transport, sessionId: string): Promise<Paint> {
  try {
    const r = await t.send("Runtime.evaluate", { expression: PAINT_EXPR, awaitPromise: true, returnByValue: true }, sessionId, PAINT_TIMEOUT_MS + FRAME_GAPS * SLOW_FRAME_MS + 1000);
    const v = rec(callResult(r));
    const raf = v["raf"] === true;
    const visibility = str(v, "visibility");
    return { painted: raf && visibility === "visible", raf, visibility, frameMs: num(v, "frameMs"), error: null };
  } catch (e) {
    return { painted: false, raf: false, visibility: null, frameMs: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Painted at full rate: a frame within 1 s, `visible`, the next FRAME_GAPS frames each within SLOW_FRAME_MS. */
const fullRate = (p: Paint): boolean => p.painted && p.frameMs !== null && p.frameMs <= SLOW_FRAME_MS;

/** A tiny screencast: its only job is to make the compositor draw the tab's frames. */
const HOLD_SCREENCAST = { format: "jpeg", quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1 };

export type PointerDeps = { rng: Rng; sleep: (ms: number) => Promise<unknown>; now: () => number; moveTimeoutMs: number };
const DEFAULT_DEPS: PointerDeps = { rng: Math.random, sleep: (ms) => Bun.sleep(ms), now: () => performance.now(), moveTimeoutMs: MOVE_TIMEOUT_MS };

/**
 * With the screencast on, paint checks repeat (POLL apart) until one is at full
 * rate or WAIT has passed since the screencast started (a check that starts
 * inside WAIT still runs to its own end, up to ~1.3 s). CI 10-20 (Linux, run
 * 39398756001): one check right after the screencast started saw no frame
 * within 1 s and the click fell back to the DOM click.
 */
export const HELD_PAINT_WAIT_MS = 3000;
export const HELD_PAINT_POLL_MS = 250;

/**
 * 0.8.2: the screencast's wait ran out without one frame (CI PR #29, Linux, a machine slow at
 * that moment: 4.3 s, no rAF). A screenshot makes the compositor draw one frame; one more
 * check follows. Read-only, takes no focus.
 */
const NUDGE_SHOT = { format: "jpeg", quality: 1 };
export const NUDGE_SHOT_TIMEOUT_MS = 1000;

/** The first paint check when a screencast had to hold the frames (reported as `paint` in the output). */
export type FramesHeld = { raf: boolean; frameMs: number | null; visibility: string | null; held: "screencast" };

export type PaintForInput = { paint: Paint; held: FramesHeld | null; release: () => Promise<void> };

/**
 * Paint check for the trusted mouse path. Chrome acknowledges a mouseMoved only
 * after the page's next animation frame. On Linux (Xvfb, CfT / Chromium 155) a
 * background tab that focus emulation made `visible` is drawn by nobody; once it
 * has put out a few frames with changes (typing, a caret, an animation) its
 * frames drop to 1 per second, so every move waits up to ~1 s and the path ends
 * in `move-timeout`. Measured: rAF 17 ms -> 1017 ms after focusing an input or
 * typing; a Page.startScreencast brings it back to 17 ms for as long as it runs,
 * also under a running animation (a screenshot only until the next few changes).
 * So a `visible` tab whose frames are slow (or missing) gets one tiny screencast
 * that runs until `release`, and paint checks again (up to HELD_PAINT_WAIT_MS); the caller reports it
 * (`paint.held: "screencast"`). macOS draws such tabs at full rate (81/81 e2e
 * without a screencast) and does not take this branch. A hidden tab is left
 * alone (degraded as before), and so is one the screencast does not bring to
 * full rate within HELD_PAINT_WAIT_MS and one nudge screenshot (NUDGE_SHOT): the
 * screencast is stopped and the last check decides.
 */
export async function holdFrames(t: Transport, sessionId: string, clock: Pick<PointerDeps, "now" | "sleep"> = DEFAULT_DEPS): Promise<PaintForInput> {
  const none = async () => undefined;
  const first = await paintCheck(t, sessionId);
  if (first.visibility !== "visible" || fullRate(first)) return { paint: first, held: null, release: none };
  // Frames the screencast sent while we waited (never acked: Chrome sends one, then waits);
  // none at all means the compositor drew nothing, not only that the page's rAF was slow.
  let frames = 0;
  const off = t.onEvent((e) => {
    if (e.method === "Page.screencastFrame" && e.sessionId === sessionId) frames++;
  });
  try {
    await t.send("Page.startScreencast", HOLD_SCREENCAST, sessionId, 3000);
  } catch (e) {
    off();
    log.info("trusted input: frames are slow and a screencast could not start", { raf: first.raf, frameMs: first.frameMs, error: String(e) });
    return { paint: first, held: null, release: none };
  }
  const release = async () => {
    await t.send("Page.stopScreencast", {}, sessionId, 1000).catch((e: unknown) => {
      log.warn("trusted input: screencast did not stop", { error: String(e) });
    });
  };
  const started = clock.now();
  const until = started + HELD_PAINT_WAIT_MS;
  let second = await paintCheck(t, sessionId);
  let checks = 1;
  while (!fullRate(second) && clock.now() + HELD_PAINT_POLL_MS < until) {
    await clock.sleep(HELD_PAINT_POLL_MS);
    second = await paintCheck(t, sessionId);
    checks++;
  }
  let nudged = false;
  if (!fullRate(second)) {
    nudged = await t.send("Page.captureScreenshot", NUDGE_SHOT, sessionId, NUDGE_SHOT_TIMEOUT_MS).then(
      () => true,
      (e: unknown) => {
        log.info("trusted input: the nudge screenshot failed", { error: String(e) });
        return false;
      },
    );
    second = await paintCheck(t, sessionId);
    checks++;
  }
  off();
  // elapsedMs: from the screencast's start to the end of the last check (each check can take ~1.3 s).
  const elapsedMs = Math.round(clock.now() - started);
  log.info("trusted input: slow frames, screencast held", { raf: first.raf, frameMs: first.frameMs, after: second.frameMs, painted: second.painted, checks, elapsedMs, frames, nudged });
  if (fullRate(second)) return { paint: second, held: { raf: first.raf, frameMs: first.frameMs, visibility: first.visibility, held: "screencast" }, release };
  await release();
  return { paint: second, held: null, release: none };
}


/**
 * How long a lost delivery probe waits for the navigation it may have caused.
 * A link click commits in a few frames; the old execution context disappears at
 * that commit, so the Page.frameNavigated record (tab.navEpoch) normally arrives
 * while the failed probe read is still in flight. The wait only runs after a
 * probe read error, never on the normal path.
 */
export const NAVIGATED_PROBE_WAIT_MS = 2000;

export type NavMark = { epoch: number; url: string };

/**
 * Navigation evidence after the press: the tab's committed-navigation counter
 * (`Page.frameNavigated` / same-document, browser/targets.ts) and its URL.
 * Checks the record, never a guess about what the click should do.
 */
export type NavigationProbe = {
  mark: () => NavMark;
  navigated: (mark: NavMark) => boolean;
  wait: (mark: NavMark, timeoutMs: number) => Promise<boolean>;
};

export function tabNavigationProbe(tab: Tab, sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms)): NavigationProbe {
  const navigated = (mark: NavMark): boolean => tab.navEpoch !== mark.epoch || tab.url !== mark.url;
  return {
    mark: () => ({ epoch: tab.navEpoch, url: tab.url }),
    navigated,
    wait: async (mark, timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (!navigated(mark)) {
        if (Date.now() >= until) return false;
        await sleep(25);
      }
      return true;
    },
  };
}

export type PointerResult = { plan: ClickPlan; actualMs: number; delivered: Record<string, unknown> };

/**
 * The trusted click itself: delivery probe, the planned mouseMoved path (each
 * awaited with its own timeout), mousePressed, the gap, mouseReleased, probe
 * read. Only CDP Input events: Chrome synthesises pointerover / move / down /
 * up / click (never a DOM click or dispatchEvent). A move that does not come
 * back in time aborts at once: no press, no retry (`move-timeout`). `onMove`
 * learns every acknowledged position (the tab's pointer memory).
 */
/**
 * The planned mouseMoved path, each move awaited with its own timeout; a move
 * that does not come back in time aborts at once (`move-timeout`), no retry.
 * `onMove` learns every acknowledged position (the tab's pointer memory).
 */
export async function movePath(t: Transport, sessionId: string, ref: string, plan: ClickPlan, deps: PointerDeps, onMove: (p: Point) => void, what = "the click was not pressed"): Promise<number> {
  const t0 = deps.now();
  for (const p of plan.points) {
    const wait = t0 + p.atMs - deps.now();
    if (wait > 0) await deps.sleep(wait);
    try {
      await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0, modifiers: 0, force: 0 }, sessionId, deps.moveTimeoutMs);
    } catch (e) {
      if (e instanceof CdpTimeoutError) {
        throw new TabcapError(
          "move-timeout",
          `a mouse move towards ${ref} got no answer within ${deps.moveTimeoutMs} ms; ${what}`,
          "Nothing was clicked and tabcap did not retry. Check the tab (`tabcap screenshot`); the page may not be painted. Plain `tabcap click <ref>` (DOM click) needs no painting.",
          { at: { x: p.x, y: p.y } },
        );
      }
      throw e;
    }
    onMove({ x: p.x, y: p.y });
  }
  return Math.round(deps.now() - t0);
}

/**
 * The trusted click itself: delivery probe, the planned mouseMoved path,
 * mousePressed, the gap, mouseReleased (twice for a double click: clickCount
 * 1 then 2, Chrome fires dblclick), probe read. Only CDP Input events: Chrome
 * synthesises pointerover / move / down / up / click (never a DOM click or
 * dispatchEvent).
 */
export async function pointerClick(
  t: Transport,
  sessionId: string,
  objectId: string,
  ref: string,
  from: Point,
  to: Point,
  deps: PointerDeps = DEFAULT_DEPS,
  onMove: (p: Point) => void = () => undefined,
  clicks: 1 | 2 = 1,
  /** Session of the target's document for the delivery probe (a frame's); mouse events always go to the tab's session. */
  probeSessionId: string = sessionId,
  /** Navigation record to consult when the probe read fails (see NAVIGATED_PROBE_WAIT_MS). */
  nav: NavigationProbe | null = null,
): Promise<PointerResult> {
  const plan = planClick(from, to, deps.rng);
  const probe = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: PROBE_FN, arguments: [], returnByValue: false, userGesture: true }, probeSessionId);
  callResult(probe);
  const probeId = isRecord(probe["result"]) ? str(probe["result"], "objectId") : null;
  const actualMs = await movePath(t, sessionId, ref, plan, deps, onMove);
  const navMark = nav?.mark() ?? null;
  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    if (clickCount > 1) await deps.sleep(plan.pressGapMs);
    // Playwright's pressure while a button is down (force 0.5) gives pointerdown.pressure 0.5 (s46 oracle).
    await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount, modifiers: 0, force: 0.5 }, sessionId, PRESS_TIMEOUT_MS);
    await deps.sleep(plan.pressGapMs);
    await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount, modifiers: 0 }, sessionId, PRESS_TIMEOUT_MS);
  }
  let got: Record<string, unknown> = {};
  let probeError: unknown = null;
  if (probeId !== null) {
    try {
      const r = await t.send("Runtime.callFunctionOn", { objectId: probeId, functionDeclaration: PROBE_READ_FN, arguments: [], returnByValue: true, userGesture: true }, probeSessionId);
      got = rec(callResult(r));
    } catch (e) {
      probeError = e;
    }
  }
  if (probeError !== null) {
    // The click took the old execution context away (a navigation committed):
    // reading the probe is impossible, but the page did receive the press.
    // Only a recorded navigation makes this delivered; otherwise it stays a
    // failure exactly as before.
    if (nav !== null && navMark !== null && (nav.navigated(navMark) || (await nav.wait(navMark, NAVIGATED_PROBE_WAIT_MS)))) {
      return { plan, actualMs, delivered: { pointerdown: "unknown", mousedown: "unknown", reason: "navigated" } };
    }
    throw notDelivered(ref, probeError);
  }
  if (got["pointerdown"] !== true && got["mousedown"] !== true) throw notDelivered(ref, null);
  return { plan, actualMs, delivered: got };
}

/** The failure of a trusted click that left no delivery evidence; tabcap never retries it. */
function notDelivered(ref: string, probeError: unknown): TabcapError {
  const why = probeError instanceof Error ? `; the delivery probe could not be read (${probeError.message})` : "";
  return new TabcapError(
    "not-delivered",
    `the trusted click on ${ref} did not reach the page (no pointerdown / mousedown${why})`,
    "tabcap did not retry. Look at the page first (`tabcap snapshot` / `tabcap screenshot`), then decide whether to click again; plain `tabcap click <ref>` is a DOM click.",
  );
}

/**
 * The end point of a trusted pointer path in top-level viewport coordinates:
 * the target's content-box centre plus its frame's offset chain (0.4-I), after
 * the occlusion check at that point (in the target's document and, for a frame
 * ref, in every ancestor document at the frame's owner element).
 */
async function targetPoint(t: Transport, tab: Tab, node: InputNode, ref: string, landing: { landed: LandedOn | null } | null = null): Promise<Point> {
  return (await targetPlace(t, tab, node, ref, landing)).to;
}

/** targetPoint, and the same point in the target's own document (`local`: what a mouse event there reports as clientX / clientY). */
async function targetPlace(t: Transport, tab: Tab, node: InputNode, ref: string, landing: { landed: LandedOn | null } | null = null): Promise<{ to: Point; local: Point }> {
  const sid = sessionOf(tab, node);
  const c = await centre(t, sid, node.backendNodeId, ref);
  if (frameOf(node) === null) {
    const occ = rec(callResult(await call(t, sid, node.objectId, OCCLUSION_FN, [c.x, c.y])));
    if (occ["ok"] !== true) {
      throw new TabcapError("page", `ref ${ref} is covered at (${Math.round(c.x)}, ${Math.round(c.y)}) by ${str(occ, "hit") ?? "nothing"}`, "Close the overlay first (snapshot to find it), or use plain `tabcap click <ref>` (DOM click).");
    }
    if (landing !== null) landing.landed = await landedGate(t, sid, node.objectId, ref, c.x, c.y);
    return { to: c, local: c };
  }
  const place = await placeOf(t, tab, node, ref);
  const to = { x: c.x + place.space.x, y: c.y + place.space.y };
  await occlusionChain(t, tab, node, ref, to, place);
  const local = { x: to.x - place.origin.x, y: to.y - place.origin.y };
  if (landing !== null) landing.landed = await landedGate(t, sid, node.objectId, ref, local.x, local.y);
  return { to, local };
}

export type TrustedClick =
  | { kind: "degraded"; paint: Paint; tag: string | null; landed: LandedOn | null }
  | { kind: "clicked"; from: Point; to: Point; result: PointerResult; held: FramesHeld | null; landed: LandedOn | null };

/**
 * Level 2 of the ladder for one click (docs/07 §1.1, docs/10 §3.4): focus
 * emulation on → scroll → paint check (holdFrames: slow frames get a held
 * screencast) → (not painted: DOM click, never a mouse move) → target centre →
 * occlusion check at the end point → pointerClick. The screencast and the
 * emulation are switched off again in every case.
 */
export async function trustedClickOn(t: Transport, tab: Tab, node: InputNode, ref: string, deps: PointerDeps = DEFAULT_DEPS, clicks: 1 | 2 = 1): Promise<TrustedClick> {
  const sid = sessionOf(tab, node);
  return withFocusEmulation(t, tab.sessionId, async () => {
    liveOrStale(rec(callResult(await call(t, sid, node.objectId, SCROLL_FN))), ref);
    // The paint check, focus emulation and mouse events are the top-level tab's (input routes into frames).
    const { paint, held, release } = await holdFrames(t, tab.sessionId, deps);
    try {
      if (!paint.painted) {
        log.info("click --trusted: tab not confirmed painted, DOM click instead", { tab: tab.id, ref, raf: paint.raf, visibility: paint.visibility, error: paint.error });
        const v = liveOrStale(rec(callResult(await call(t, sid, node.objectId, clicks === 2 ? DBLCLICK_FN : CLICK_FN))), ref);
        return { kind: "degraded", paint, tag: str(v, "tag"), landed: landedOf(v) };
      }
      const landing: { landed: LandedOn | null } = { landed: null };
      const to = await targetPoint(t, tab, node, ref, landing);
      const from = tab.pointer ?? { x: 0, y: 0 };
      const result = await pointerClick(
        t,
        tab.sessionId,
        node.objectId,
        ref,
        from,
        to,
        deps,
        (p) => {
          tab.pointer = p;
        },
        clicks,
        sid,
        tabNavigationProbe(tab),
      );
      return { kind: "clicked", from, to, result, held, landed: landing.landed };
    } finally {
      await release();
    }
  });
}

/** 0.6-J: the output fields of a landing decision (b: `target`, c: `candidates`; a / d: nothing). */
export function landingFields(ref: string, l: Landing): Record<string, unknown> {
  if (l.kind === "descendant") return { target: { ref, landedOn: l.landedOn, reason: "descendant-listener" } };
  if (l.kind === "candidates") return { candidates: l.candidates };
  return {};
}

export async function click(d: Daemon, a: Args, session: string): Promise<unknown> {
  if (optBool(a, "os") || optStr(a, "at") !== null) return osClick(d, a, session);
  const ref = reqStr(a, "ref", "tabcap click <ref> [--trusted] [--dbl-click]");
  const trusted = optBool(a, "trusted");
  const clicks = optBool(a, "dblClick") ? 2 : 1;
  const dbl = clicks === 2 ? { dblClick: true } : {};
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const noWait = optBool(a, "noWait");
  return tabs.run(
    tab,
    () =>
      withNotices(d, t, tab, async () => {
        // 0.6-D: the default DOM click is watched for an effect until the post-action wait ends (tools/effect.ts).
        const watched: { w: EffectWatch | null } = { w: null };
        const clicked = withPostWait(t, tab, noWait, async (): Promise<Record<string, unknown>> => {
          const node = await resolveRef(t, tab, ref);
          const overlayCheck = await overlayGate(t, tab, node, ref, !trusted);
          // 0.6-D: an image captcha on the target's form is an advisory in the output (looked at before the click).
          const challenge = await actionChallenge(d, t, tab, node);
          // 0.6-J: land on the element that listens (browser/landing.ts); read only, the same choice for --trusted.
          const landing = await inspectLanding(t, tab, node, (id) => tab.refs.refFor(id, node.frame));
          const aim: InputNode = landing.kind === "descendant" ? { objectId: landing.node.objectId, backendNodeId: landing.node.backendNodeId, sessionId: node.sessionId, frame: node.frame } : node;
          const landed = landingFields(ref, landing);
          if (!trusted) {
            if (!noWait) watched.w = await watchEffect(d, t, tabs, tab, node);
            const v = liveOrStale(rec(callResult(await call(t, node.sessionId, aim.objectId, clicks === 2 ? DBLCLICK_FN : CLICK_FN))), ref);
            return { tab: tab.id, ref, ...frameField(node), level: 1, trusted: false, eventShape: "incomplete", warning: DOM_CLICK_WARNING, tag: str(v, "tag"), landedOn: landedOf(v), ...dbl, overlayCheck, ...landed, ...challenge };
          }
          const r = await trustedClickOn(t, tab, aim, ref, DEFAULT_DEPS, clicks);
          if (r.kind === "degraded") {
            return {
              ...challenge,
              ...landed,
              tab: tab.id,
              ref,
              ...frameField(node),
              level: 1,
              trusted: false,
              eventShape: "incomplete",
              degraded: "not-painted",
              warning: `${DOM_CLICK_WARNING} (--trusted degraded: the tab was not confirmed to paint, so no mouse move was sent)`,
              paint: { raf: r.paint.raf, visibility: r.paint.visibility },
              tag: r.tag,
              landedOn: r.landed,
              ...dbl,
              overlayCheck,
            };
          }
          const xy = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });
          return {
            tab: tab.id,
            ref,
            ...frameField(node),
            level: 2,
            trusted: true,
            eventShape: "full",
            at: xy(r.to),
            trajectory: { from: xy(r.from), to: xy(r.to), points: r.result.plan.points.length, plannedMs: r.result.plan.durationMs, actualMs: r.result.actualMs },
            pressGapMs: r.result.plan.pressGapMs,
            delivered: r.result.delivered,
            landedOn: r.landed,
            ...(r.held === null ? {} : { paint: r.held }),
            ...dbl,
            overlayCheck,
            ...landed,
            ...challenge,
          };
        }, { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) });
        const { result, wait } = await clicked.catch(async (e: unknown) => {
          await watched.w?.stop(true);
          throw e;
        });
        const w = watched.w;
        // 0.7.3: a trusted click that navigated reports the navigation even though
        // the trusted path has no DOM effect watch (the probe can be lost to it).
        const probeNavigated = isRecord(result["delivered"]) && result["delivered"]["reason"] === "navigated";
        const effect = w !== null ? classifyEffect(await w.stop(wait?.dialog === true)) : !noWait && (wait?.navigated === true || probeNavigated) ? ({ effect: "navigation" } as const) : {};
        // url / nav read after the wait: the click may have navigated.
        return { ...result, ...effect, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
      }),
    { timeoutMs: timeoutOf(a) },
  );
}

/**
 * `hover <ref>`: the trusted mouse path of `click --trusted` without the press
 * (focus emulation, paint check with holdFrames, occlusion check at the end
 * point). A tab that does not paint gets no mouse move at all: `not-painted`,
 * nothing moved.
 */
export async function hover(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = reqStr(a, "ref", "tabcap hover <ref>");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      const { result, wait } = await withPostWait(t, tab, optBool(a, "noWait"), async (): Promise<Record<string, unknown>> => {
        const node = await resolveRef(t, tab, ref);
        const overlayCheck = await overlayGate(t, tab, node, ref);
        return withFocusEmulation(t, tab.sessionId, async () => {
          liveOrStale(rec(callResult(await call(t, node.sessionId, node.objectId, SCROLL_FN))), ref);
          const { paint, held, release } = await holdFrames(t, tab.sessionId);
          try {
            if (!paint.painted) {
              throw new TabcapError(
                "not-painted",
                `tab ${tab.id} is not confirmed painted (requestAnimationFrame ${paint.raf ? "ran" : "did not run"}, visibility ${paint.visibility ?? "unknown"}); no mouse move was sent`,
                "Nothing was hovered. Check the tab with `tabcap screenshot`, then run hover again; tabcap did not retry.",
              );
            }
            const to = await targetPoint(t, tab, node, ref);
            const from = tab.pointer ?? { x: 0, y: 0 };
            const plan = planClick(from, to, DEFAULT_DEPS.rng);
            const actualMs = await movePath(t, tab.sessionId, ref, plan, DEFAULT_DEPS, (p) => {
              tab.pointer = p;
            }, "the pointer stopped short of the element");
            const xy = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });
            return {
              tab: tab.id,
              ref,
              ...frameField(node),
              level: 2,
              trusted: true,
              at: xy(to),
              trajectory: { from: xy(from), to: xy(to), points: plan.points.length, plannedMs: plan.durationMs, actualMs },
              ...(held === null ? {} : { paint: held }),
              overlayCheck,
            };
          } finally {
            await release();
          }
        });
      });
      return { ...result, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

const FILL_USAGE = "tabcap fill <ref> <text> [--trusted] | tabcap fill <ref> --secret <site>.password|username [--confirm]";

/** `<site>.password` / `<site>.username` → parts; anything else is a usage error. */
export function parseSecretRef(ref: string): { site: string; field: "password" | "username" } {
  const m = /^([A-Za-z0-9_-]{1,64})\.(password|username)$/.exec(ref);
  if (m === null || m[1] === undefined || (m[2] !== "password" && m[2] !== "username")) {
    throw new TabcapError("usage", `bad secret reference: ${JSON.stringify(ref)}`, "Use <site>.password or <site>.username with a site from `tabcap site list`.");
  }
  return { site: m[1], field: m[2] };
}

/**
 * 0.6-R: `fill --secret` needs a session bound with `session start --site`
 * (the binding picks the account and its browser context). A session made
 * implicitly (`net start`, `navigate`, or after a failed `session start
 * --site`) is not bound: refused before the page is touched. fill always has
 * a tab here, and an account's tabs must open in its own context, so the way
 * out is stop, then start bound.
 */
export function unboundSecretError(session: string, bound: { site: string } | undefined, site: string): TabcapError | null {
  if (bound !== undefined) return null;
  return new TabcapError(
    "not-found",
    `session "${session}" is not bound to a site, so --secret ${site}.* has no account to fill from (sessions made by net start / navigate, or left after a failed session start --site, are unbound)`,
    `Run \`tabcap session stop ${session}\` (it closes the session's tabs and finishes its recording), then \`tabcap session start ${session} --site ${site}\`, navigate again and fill.`,
    { session, site },
  );
}

/**
 * docs/06 A6.2: one `fill --secret <site>.password` per site per session. Checked
 * before the page is touched; `--confirm` overrides. Each decision is a `guard` event.
 * 0.4-D: a `--confirm`ed retry means the human judged the previous login failed:
 * it counts as a failed login of the account; the second within 24 h makes the
 * account `needs-human`, and from then on its password is not filled until
 * `handoff continue` or `account set-state <site>.<user> active`.
 */
function loginGate(d: Daemon, session: string, site: string, confirm: boolean, tab: string): () => void {
  const store = d.needStore();
  let before = store.guardCounter(site, session);
  // A counter from an earlier session of the same name (older than this one) does not count.
  const created = d.browser?.tabs.session(session)?.created ?? 0;
  if (before.lastAttemptAt !== null && before.lastAttemptAt < created) {
    store.resetGuard(site, session);
    before = store.guardCounter(site, session);
  }
  const bound = d.sites.get(session);
  const account = (bound?.site === site ? bound.account : null) ?? store.accountOf(site);
  const rec = d.recorders.get(session);
  const needsHuman = (failures: number | null, decision: "refused" | "needs-human") => {
    rec?.event("guard", { event: "budget", site, account, detail: { rule: "failed-logins", failures, limit: FAILED_LOGIN_LIMIT, decision } }, { tab });
    return new TabcapError(
      "guard.login-limit",
      `account ${site}.${account ?? "?"} needs the human: ${FAILED_LOGIN_LIMIT} failed logins within 24 h`,
      `Do not log in again: ask the human to check the account in the browser; they clear it with \`tabcap handoff continue\` (in this session) or \`tabcap account set-state ${site}.${account ?? "<user>"} active\`.`,
      { site, account, state: "needs-human" },
    );
  };
  const row = account === null ? null : store.account(site, account);
  if (row !== null && accountState(row, d.pool.now()) === "needs-human") throw needsHuman(row.failStreak, "refused");
  const limited = before.loginAttempts >= LOGIN_LIMIT;
  if (limited && !confirm) {
    rec?.event("guard", { event: "budget", site, account, detail: { rule: "login-limit", attempts: before.loginAttempts, limit: LOGIN_LIMIT, decision: "refused" } }, { tab });
    throw new TabcapError(
      "guard.login-limit",
      `this session already tried to log in to "${site}" (${before.loginAttempts} attempt${before.loginAttempts === 1 ? "" : "s"}); a second attempt can lock the account`,
      "Do not retry on your own: check the page (snapshot / screenshot) and ask the human. If they say retry, run the same fill again with --confirm.",
      { site, attempts: before.loginAttempts, limit: LOGIN_LIMIT },
    );
  }
  if (limited && account !== null) {
    const f = d.pool.failedLogin(store, site, account);
    // The budget event only when the limit is reached (docs/04 §4.2: budget hit).
    if (f?.needsHuman === true) throw needsHuman(f.failures, "needs-human");
  }
  // Counted only once the value is really in the field.
  return () => {
    const after = store.noteLoginAttempt(site, session);
    if (account !== null) store.noteAccountLogin(site, account, d.pool.now());
    rec?.event("guard", { event: "budget", site, account, detail: { rule: "login-limit", attempts: after.loginAttempts, limit: LOGIN_LIMIT, decision: limited ? "confirmed" : "allowed" } }, { tab });
  };
}

/** A stored value for `fill --secret` / `type --os --secret`: `counted` is called once the value is really in the field (passwords only). */
type SecretUse = { site: string; field: "password" | "username"; value: string; counted: (() => void) | null };

/** Look a `<site>.<field>` reference up for this session; the login gate runs for a password (before the page is touched). */
function useSecret(d: Daemon, session: string, secretRef: string, confirm: boolean, tab: string): SecretUse {
  const secret = parseSecretRef(secretRef);
  const store = d.needStore();
  if (store.site(secret.site) === null) throw new TabcapError("not-found", `no site named "${secret.site}" in the store`, "Run `tabcap site list`; the human adds sites with `tabcap site add`.");
  const unbound = unboundSecretError(session, d.sites.get(session), secret.site);
  if (unbound !== null) throw unbound;
  const v = store.secretValue(secret.site, secret.field, d.sites.get(session)?.site === secret.site ? d.sites.get(session)?.account : null);
  if (v === null) throw new TabcapError("not-found", `site "${secret.site}" has no ${secret.field}`, "Ask the human to re-add the site with `tabcap site add`.");
  return { ...secret, value: v, counted: secret.field === "password" ? loginGate(d, session, secret.site, confirm, tab) : null };
}

export async function fill(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = reqStr(a, "ref", FILL_USAGE);
  const secretRef = optStr(a, "secret");
  const given = typeof a["text"] === "string" ? a["text"] : null;
  if (secretRef !== null && given !== null) throw new TabcapError("usage", "give either text or --secret, not both", `Usage: ${FILL_USAGE}`);
  if (secretRef === null && given === null) throw new TabcapError("usage", "missing text", `Usage: ${FILL_USAGE}`);
  const trusted = optBool(a, "trusted");
  const confirm = optBool(a, "confirm");
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const used = secretRef === null ? null : useSecret(d, session, secretRef, confirm, tab.id);
  const text = used?.value ?? given ?? "";
  const counted = used?.counted ?? null;
  const secret = used === null ? null : { site: used.site, field: used.field };
  return tabs.run(
    tab,
    () =>
      withNotices(d, t, tab, async () => {
        const { result, wait } = await withPostWait(t, tab, optBool(a, "noWait"), () => fillOn(d, t, tab, ref, text, { trusted, secret, secretRef, counted }), { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) });
        return { ...result, wait, ...(await snapshotAfter(d, t, tab, a)) };
      }),
    { timeoutMs: timeoutOf(a) },
  );
}

async function fillOn(
  d: Daemon,
  t: Transport,
  tab: Tab,
  ref: string,
  text: string,
  o: { trusted: boolean; secret: { site: string; field: "password" | "username" } | null; secretRef: string | null; counted: (() => void) | null },
): Promise<Record<string, unknown>> {
  const { trusted, secret, secretRef, counted } = o;
  const node = await resolveRef(t, tab, ref);
  const overlayCheck = await overlayGate(t, tab, node, ref);
  const challenge = await actionChallenge(d, t, tab, node);
  let v: Record<string, unknown>;
  // Input.insertText goes to the tab's session: Chrome routes it to the focused frame (0.4-I, measured).
  if (!trusted) {
    v = liveOrStale(rec(callResult(await call(t, node.sessionId, node.objectId, FILL_FN, [text]))), ref);
    if (v["kind"] === "contenteditable") await t.send("Input.insertText", { text }, tab.sessionId, 10_000);
  } else {
    v = await withFocusEmulation(t, tab.sessionId, async () => {
      const r = liveOrStale(rec(callResult(await call(t, node.sessionId, node.objectId, FOCUS_SELECT_FN))), ref);
      if (r["kind"] === "input" || r["kind"] === "contenteditable") await t.send("Input.insertText", { text }, tab.sessionId, 10_000);
      return r;
    });
  }
  const masked = secret?.field === "password" || isSensitiveField(str(v, "type"), str(v, "ac"));
  // Store values are replaced with <secret:…> already; only ad-hoc passwords need <masked>.
  if (masked && secret === null) d.secrets.add(text);
  const kind = str(v, "kind");
  if (kind !== "input" && kind !== "contenteditable") {
    const why = kind === "readonly" ? "the field is disabled or read-only" : kind === "nosetter" ? "the element has no value setter" : `<${str(v, "tag") ?? "?"}> is not a text field`;
    throw new TabcapError("page", `cannot fill ${ref}: ${why}`, "run snapshot again and pick a textbox ref (use `tabcap click` for buttons and `tabcap press-key` for keys).");
  }
  counted?.();
  return {
    tab: tab.id,
    ref,
    ...frameField(node),
    level: trusted ? 2 : 1,
    trusted,
    kind,
    inputType: str(v, "type"),
    masked,
    length: text.length,
    overlayCheck,
    ...(secret === null ? {} : { secret: secretRef, value: `<secret:${secretRef ?? ""}>` }),
    ...(v["matches"] === false ? { warning: "the field normalised the value (e.g. type=number)" } : {}),
    ...challenge,
  };
}

/**
 * docs/04 §17: `type` has no ref, so it checks the focused element instead: a
 * detached one, or focus fallen back to <body> (the field was removed or
 * re-rendered), is `stale-ref` rather than a silent no-op. Returns whether the
 * field is password-like.
 */
export function activeFieldOf(v: Record<string, unknown>): { sensitive: boolean } {
  if (v["connected"] !== true || v["none"] === true) {
    throw new TabcapError(
      "stale-ref",
      v["connected"] !== true && v["none"] !== true ? "the focused element is no longer in the page (it was removed or re-rendered)" : "no editable element has focus (the focused field was removed or re-rendered, or nothing was focused)",
      "run snapshot again, then `tabcap click <ref>` or `tabcap fill <ref> <text>` to focus the field.",
    );
  }
  return { sensitive: isSensitiveField(str(v, "type"), str(v, "ac")) };
}

/**
 * Is the focused field password-like? Follows focus into frames: same-origin
 * ones in the page, out-of-process ones through their own session (0.4-I), so
 * text typed into a password field of an iframe is masked too.
 */
async function activeIsSensitive(t: Transport, tab: Tab): Promise<boolean> {
  let sessionId = tab.sessionId;
  for (let hop = 0; hop < 8; hop++) {
    const r = await t.send("Runtime.evaluate", { expression: ACTIVE_FN, returnByValue: true }, sessionId, 5000);
    const v = rec(callResult(r));
    if (v["cross"] !== true) return activeFieldOf(v).sensitive;
    const o = await t.send("Runtime.evaluate", { expression: ACTIVE_FRAME_EL, returnByValue: false }, sessionId, 5000).catch(() => null);
    const oid = o !== null && isRecord(o["result"]) ? str(o["result"], "objectId") : null;
    const d = oid === null ? null : await t.send("DOM.describeNode", { objectId: oid }, sessionId, 5000).catch(() => null);
    const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
    const frameId = node === null ? null : str(node, "frameId");
    const next = frameId === null ? undefined : t.targets().find((x) => x.targetId === frameId);
    // The frame cannot be followed: unknown field, not password-like as far as tabcap can see.
    if (next === undefined) return activeFieldOf(v).sensitive;
    sessionId = next.sessionId;
  }
  return false;
}

/** Most a `--delay` may be (ms between two characters). */
export const MAX_TYPE_DELAY_MS = 10_000;

export async function typeText(d: Daemon, a: Args, session: string): Promise<unknown> {
  if (optBool(a, "os") || optBool(a, "osText")) return osType(d, a, session);
  if (optStr(a, "secret") !== null) throw new TabcapError("usage", "--secret on type needs --os (or --os-text)", "To put a stored value into a field without operating-system input use `tabcap fill <ref> --secret <site>.password`.");
  const text = typeof a["text"] === "string" ? a["text"] : null;
  if (text === null || text === "") throw new TabcapError("usage", "missing text", "Usage: tabcap type <text> [--trusted [--delay ms] | --insert] (types into the focused element; use `tabcap click <ref>` or `tabcap fill` first)");
  const trusted = optBool(a, "trusted");
  const insert = optBool(a, "insert");
  const delay = optNum(a, "delay");
  if (trusted && insert) throw new TabcapError("usage", "give either --trusted (one key event per character) or --insert (one insertText), not both", "Usage: tabcap type <text> [--trusted [--delay ms] | --insert]");
  if (delay !== null && !trusted) throw new TabcapError("usage", "--delay only applies to --trusted (per-key typing)", "Usage: tabcap type <text> --trusted --delay <ms>");
  if (delay !== null && (delay < 0 || delay > MAX_TYPE_DELAY_MS)) throw new TabcapError("usage", `--delay must be between 0 and ${MAX_TYPE_DELAY_MS} ms`, "Usage: tabcap type <text> --trusted --delay <ms>");
  const delayMs = delay ?? 0;
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const submitSpec = optStr(a, "submitKey");
  const submit = submitSpec === null ? null : parseKey(submitSpec);
  if (submitSpec !== null && submit === null) throw unknownKey(submitSpec);
  return tabs.run(
    tab,
    () =>
      withNotices(d, t, tab, async () => {
        const { result, wait } = await withPostWait(t, tab, optBool(a, "noWait"), () =>
          withFocusEmulation(t, tab.sessionId, async (): Promise<Record<string, unknown>> => {
            const masked = await activeIsSensitive(t, tab);
            if (masked) d.secrets.add(text);
            let out: Record<string, unknown>;
            if (!trusted) {
              await t.send("Input.insertText", { text }, tab.sessionId, 10_000);
              out = { tab: tab.id, level: 2, trusted: true, eventShape: "insert", warning: INSERT_WARNING, length: text.length, masked };
            } else {
              const r = await typeKeys(t, tab.sessionId, text, delayMs);
              out = { tab: tab.id, level: 2, trusted: true, eventShape: "keys", keys: r.keys, inserted: r.inserted, delayMs, length: text.length, masked };
            }
            if (submit !== null) {
              await pressKeyOn(t, tab.sessionId, submit);
              out["submitKey"] = submitSpec;
            }
            return out;
          }),
          { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) },
        );
        return { ...result, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
      }),
    { timeoutMs: timeoutOf(a) },
  );
}

/**
 * docs/10 §3.2: one keyDown (with text) + keyUp per character that has a key on
 * the US layout, Input.insertText for each other character; `delayMs` between
 * two characters. Chrome builds keydown / keypress / beforeinput / textInput /
 * input / keyup. Needs focus emulation (docs/07 §1.1). The characters are never
 * logged; a failure stops at once (no retry).
 */
export async function typeKeys(t: Transport, sessionId: string, text: string, delayMs: number, sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms)): Promise<{ keys: number; inserted: number }> {
  let keys = 0;
  let inserted = 0;
  const strokes = planTyping(text);
  for (const [i, k] of strokes.entries()) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    if (k.kind === "insert") {
      await t.send("Input.insertText", { text: k.char }, sessionId, 10_000);
      inserted++;
      continue;
    }
    const p = keyEventParams(k);
    await t.send("Input.dispatchKeyEvent", p.down, sessionId, 5000);
    await t.send("Input.dispatchKeyEvent", p.up, sessionId, 5000);
    keys++;
  }
  return { keys, inserted };
}

type KeyDef = { key: string; code: string; vk: number; text?: string };

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

/** "Enter", "a", "Shift+Tab", "Control+a" → key definition + CDP modifier bits. */
export function parseKey(spec: string): { def: KeyDef; modifiers: number } | null {
  // "Control++": the key is "+" itself (chrome-devtools-mcp press_key accepts it).
  const plusKey = spec === "+" || spec.endsWith("++");
  const rest = spec === "+" ? "" : plusKey ? spec.slice(0, -2) : spec;
  const parts = plusKey && rest === "" ? [] : rest.split("+");
  const name = plusKey ? "+" : parts.pop();
  if (name === undefined || name === "") return null;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  let def = NAMED_KEYS[name];
  if (def === undefined && name.length === 1) {
    const up = name.toUpperCase();
    if (/[A-Z]/.test(up)) def = { key: name, code: `Key${up}`, vk: up.charCodeAt(0), text: name };
    else if (/[0-9]/.test(name)) def = { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
    else def = { key: name, code: "", vk: 0, text: name };
  }
  if (def === undefined) return null;
  // With Control / Alt / Meta held the key produces no text.
  if ((modifiers & 7) !== 0 && def.text !== undefined) def = { key: def.key, code: def.code, vk: def.vk };
  return { def, modifiers };
}

const unknownKey = (spec: string) =>
  new TabcapError("usage", `unknown key: ${spec}`, `Use one of ${Object.keys(NAMED_KEYS).join(", ")}, a single character, or Modifier+Key (Shift+Tab, Control+a, Control+Shift+R; modifiers Control, Shift, Alt, Meta).`);

/** keyDown (or rawKeyDown for keys without text) + keyUp, modifiers as CDP bits. Needs focus emulation. */
export async function pressKeyOn(t: Transport, sessionId: string, k: { def: KeyDef; modifiers: number }): Promise<void> {
  const base = { key: k.def.key, code: k.def.code, windowsVirtualKeyCode: k.def.vk, nativeVirtualKeyCode: k.def.vk, modifiers: k.modifiers };
  await t.send("Input.dispatchKeyEvent", { type: k.def.text === undefined ? "rawKeyDown" : "keyDown", ...base, ...(k.def.text === undefined ? {} : { text: k.def.text, unmodifiedText: k.def.text }) }, sessionId, 5000);
  await t.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId, 5000);
}

export async function press(d: Daemon, a: Args, session: string): Promise<unknown> {
  const spec = reqStr(a, "key", "tabcap press-key <key>");
  const k = parseKey(spec);
  if (k === null) throw unknownKey(spec);
  if (optBool(a, "os")) return osPress(d, a, session, spec, k);
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    () =>
      withNotices(d, t, tab, async () => {
        const { result, wait } = await withPostWait(t, tab, optBool(a, "noWait"), () =>
          withFocusEmulation(t, tab.sessionId, async () => {
            await pressKeyOn(t, tab.sessionId, k);
            return { tab: tab.id, level: 2, trusted: true, key: spec };
          }),
          { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) },
        );
        return { ...result, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
      }),
    { timeoutMs: timeoutOf(a) },
  );
}

// ---------------------------------------------------------------- --os (docs/16)

/** One `--os` command's hold on the operating system: `take` makes the tab the keyboard's target (once), `check` asks again. */
type OsRun = { os: OsInput; pid: number; stop: StopFlag; root: FrameDoc; take: () => Promise<void>; check: () => Promise<FrontCheck> };

/** Past this share of the command's time limit the keys would outlive the command, so nothing is sent. */
const OS_TIME_MARGIN_MS = 3000;
/** Scan codes of the left Shift / Control / Alt keys (set 1), used when the layout names none. */
const SCAN_FALLBACK = { shift: 0x2a, control: 0x1d, alt: 0x38 } as const;
/** How long a press has to show up in the page. */
const OS_PRESS_SEEN_MS = 2000;

/**
 * Run one `--os` command on a tab (docs/16 §3). One at a time in the whole
 * daemon (one keyboard, one pointer). The whole command is one of tabcap's own
 * input windows, so the take-over listener does not read its trusted events as
 * the human's; every record the system took is counted (`browser status`
 * inputs.os); and when the command took the foreground it is handed back at
 * the end (`foreground` in the answer). The page is asked about focus in
 * tabcap's isolated world, with focus emulation switched off first (a
 * `--trusted` command whose switch-off failed would make every tab say yes).
 */
function withOs<T extends Record<string, unknown>>(t: DirectTransport, tab: Tab, base: OsInput, stop: StopFlag, fn: (o: OsRun) => Promise<T>): Promise<T & { foreground: ForegroundReport }> {
  return osExclusive(() => withOsNow(t, tab, base, stop, fn));
}

async function withOsNow<T extends Record<string, unknown>>(t: DirectTransport, tab: Tab, base: OsInput, stop: StopFlag, fn: (o: OsRun) => Promise<T>): Promise<T & { foreground: ForegroundReport }> {
  // The command gave up while it waited for another `--os` command to end.
  if (stop.stopped) throw stoppedError(null);
  const os = counting(base, (n) => {
    t.osInputs += n;
  });
  await t.send("Emulation.setFocusEmulationEnabled", { enabled: false }, tab.sessionId, 2000).catch(() => undefined);
  const root = rootDoc(tab, await docIdentity(t, tab));
  const focused: PageFocus = async () => callResult(await inWorld(t, tab, root, (ctx) => t.send("Runtime.evaluate", { expression: FOCUS_EXPR, contextId: ctx, returnByValue: true }, tab.sessionId, FOCUS_ANSWER_MS))) === true;
  const w = t.inputWindows.begin(tab.sessionId);
  const state: { front: FrontState | null } = { front: null };
  const run: OsRun = {
    os,
    pid: t.pid,
    stop,
    root,
    take: async () => {
      state.front ??= await takeForeground(os, () => t.bringToFront(tab.sessionId), focused, t.pid);
    },
    check: () => frontCheck(os, focused, t.pid),
  };
  try {
    const out = await fn(run);
    const foreground = giveBack(os, state.front, t.pid, t.restoreFront);
    logOs("done", { tab: tab.id, ...foreground });
    return { ...out, foreground };
  } catch (e) {
    try {
      giveBack(os, state.front, t.pid, t.restoreFront);
    } catch (x) {
      log.warn("os input: handing the foreground back failed", { error: String(x) });
    }
    throw e;
  } finally {
    t.inputWindows.end(w);
  }
}

type OsLayout = { name: string; keyFor: (codeUnit: number) => ReturnType<OsInput["keyFor"]>; scanCode: (vk: number) => number };

/** The keyboard layout of the foreground window's thread: keys are looked up the way that window will read them. */
function layoutOf(os: OsInput): OsLayout {
  const id = os.layout(os.foreground()?.thread ?? 0);
  return { name: layoutName(id), keyFor: (u) => os.keyFor(u, id), scanCode: (vk) => os.scanCode(vk, id) };
}

/** `press-key` / `--submit-key` as operating-system strokes: held modifiers (Control, Alt, Shift) and the key. */
export function osChordOf(k: { def: KeyDef; modifiers: number }, spec: string, lay: Pick<OsLayout, "keyFor" | "scanCode" | "name">): { mods: number[]; key: OsStroke } {
  const bad = (why: string) => new TabcapError("usage", `${JSON.stringify(spec)} cannot be pressed with --os: ${why}`, "Nothing was sent. Use a key this keyboard layout has, or press it without --os.");
  if ((k.modifiers & 4) !== 0) throw bad("Meta (the Windows key) is not sent");
  let vk = k.def.vk;
  let shift = (k.modifiers & 8) !== 0;
  // A single character without Control / Alt is the key that types it, Shift included ("A", "?").
  // With Control / Alt a letter or digit is its own key; punctuation has no key code of its own and is looked up too ("Control++").
  if (k.def.key.length === 1 && ((k.modifiers & 3) === 0 || vk === 0)) {
    const found = lay.keyFor(k.def.key.charCodeAt(0));
    if (found === null) throw bad(`keyboard layout ${lay.name} has no key for it`);
    if (found.ctrl || found.alt) throw bad(`it needs AltGr on keyboard layout ${lay.name}`);
    if (found.dead) throw bad(`it is a dead key on keyboard layout ${lay.name}`);
    vk = found.vk;
    shift = shift || found.shift;
  }
  if (vk === 0) throw bad("it has no key code");
  const scan = lay.scanCode(vk);
  if (scan === 0) throw bad(`its key has no scan code on keyboard layout ${lay.name}`);
  const mods: number[] = [];
  if ((k.modifiers & 2) !== 0) mods.push(lay.scanCode(VK.control) || SCAN_FALLBACK.control);
  if ((k.modifiers & 1) !== 0) mods.push(lay.scanCode(VK.alt) || SCAN_FALLBACK.alt);
  if (shift) mods.push(lay.scanCode(VK.shift) || SCAN_FALLBACK.shift);
  return { mods, key: { kind: "scan", scan, extended: isExtendedVk(vk), shift: false } };
}

const capsLockError = () => new TabcapError("unsupported", "Caps Lock is on: keys sent by scan code would come out in the other case; nothing was sent", "Turn Caps Lock off (tabcap does not press it for you) and run the command again.");

const OS_TYPE_USAGE = "tabcap type <text> --os [--delay ms] | tabcap type --os --secret <site>.password|username [--confirm] | tabcap type <text> --os-text";

/** A text that cannot be typed whole is not typed at all. `hide`: the text is a secret or goes into a password field, so the character is named by position only. */
export function untypableError(plan: { index: number; why: "no-key" | "needs-altgr" | "dead-key" | "no-scan-code" }, text: string, layout: string, hide: boolean): TabcapError {
  const which = hide ? `character ${plan.index + 1}` : `character ${plan.index + 1} (U+${text.charCodeAt(plan.index).toString(16).padStart(4, "0")})`;
  const why =
    plan.why === "no-key"
      ? `has no key on keyboard layout ${layout}`
      : plan.why === "needs-altgr"
        ? `needs AltGr on keyboard layout ${layout}, which tabcap does not press`
        : plan.why === "dead-key"
          ? `is a dead key on keyboard layout ${layout} (it would change the next character instead of being typed)`
          : `is on a key without a scan code on keyboard layout ${layout}`;
  return new TabcapError(
    "usage",
    `${which} ${why}; nothing was sent`,
    "Switch the browser window to a keyboard layout that has every character (an input method must be in its English mode), or use --os-text: it sends the characters themselves, which a control that reads scan codes does not see.",
    { index: plan.index, layout },
  );
}

/**
 * `type --os` / `type --os-text` (docs/16 §2–§4): the text, or a stored value
 * (`--secret`, the only way a password is given), as operating-system key
 * strokes into whatever has focus in the tab. The plan is made and checked
 * whole before the first key; a foreground change stops it between two keys.
 */
async function osType(d: Daemon, a: Args, session: string): Promise<unknown> {
  const unicode = optBool(a, "osText");
  const given = typeof a["text"] === "string" && a["text"] !== "" ? a["text"] : null;
  const secretRef = optStr(a, "secret");
  if (optBool(a, "trusted") || optBool(a, "insert")) throw new TabcapError("usage", "--os / --os-text is its own way of typing: leave out --trusted and --insert", `Usage: ${OS_TYPE_USAGE}`);
  if (secretRef !== null && given !== null) throw new TabcapError("usage", "give either text or --secret, not both", `Usage: ${OS_TYPE_USAGE}`);
  if (secretRef === null && given === null) throw new TabcapError("usage", "missing text", `Usage: ${OS_TYPE_USAGE}`);
  const delay = optNum(a, "delay");
  if (delay !== null && (delay < 0 || delay > MAX_TYPE_DELAY_MS)) throw new TabcapError("usage", `--delay must be between 0 and ${MAX_TYPE_DELAY_MS} ms`, `Usage: ${OS_TYPE_USAGE}`);
  const delayMs = delay ?? OS_TYPE_DELAY_MS;
  const submitSpec = optStr(a, "submitKey");
  const submit = submitSpec === null ? null : parseKey(submitSpec);
  if (submitSpec !== null && submit === null) throw unknownKey(submitSpec);
  const base = loadOsInput();
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const used = secretRef === null ? null : useSecret(d, session, secretRef, optBool(a, "confirm"), tab.id);
  const text = used?.value ?? given ?? "";
  const limit = timeoutOf(a);
  const stop: StopFlag = { stopped: false };
  return tabs
    .run(
      tab,
      () =>
        withNotices(d, t, tab, async () => {
          const { result, wait, foreground } = await withOs(t, tab, base, stop, (o) =>
            withPostWait(
              t,
              tab,
              optBool(a, "noWait"),
              async (): Promise<Record<string, unknown>> => {
                if (!unicode && o.os.capsLock()) throw capsLockError();
                await o.take();
                const sensitive = await activeIsSensitive(t, tab);
                const masked = used?.field === "password" || sensitive;
                if (masked && used === null) d.secrets.add(text);
                const lay = layoutOf(o.os);
                const plan = unicode ? planUnicode(text, lay) : planScanKeys(text, lay);
                if (!plan.ok) throw untypableError(plan, text, lay.name, masked || used !== null);
                const chord = submit === null || submitSpec === null ? null : osChordOf(submit, submitSpec, lay);
                const needMs = strokesMs(plan.strokes, delayMs);
                if (needMs + OS_TIME_MARGIN_MS > limit - (Date.now() - cmdStarted)) {
                  throw new TabcapError("usage", `${plan.strokes.length} keys ${delayMs} ms apart take about ${Math.ceil(needMs / 1000)} s, more than is left of this command's time limit; nothing was sent`, `Raise --timeout (now ${limit} ms) or lower --delay.`);
                }
                const keys = await sendStrokes(o.os, plan.strokes, { delayMs, shiftScan: lay.scanCode(VK.shift) || SCAN_FALLBACK.shift, check: o.check, browserPid: o.pid, stop });
                used?.counted?.();
                const out: Record<string, unknown> = {
                  tab: tab.id,
                  input: "os",
                  level: 3,
                  trusted: true,
                  eventShape: "os",
                  keyMode: unicode ? "unicode" : "scan",
                  keys,
                  delayMs,
                  layout: lay.name,
                  length: text.length,
                  masked,
                  ...(used === null ? {} : { secret: secretRef, value: `<secret:${secretRef ?? ""}>` }),
                };
                if (chord !== null) {
                  await sendChord(o.os, chord.mods, chord.key, { check: o.check, browserPid: o.pid, stop });
                  out["submitKey"] = submitSpec;
                }
                return out;
              },
              { requests: requestWaitOf(d, a, cmdStarted, limit) },
            ),
          );
          return { ...result, foreground, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
        }),
      { timeoutMs: limit },
    )
    .finally(() => {
      stop.stopped = true;
    });
}

/** `press-key <key> --os`: one key, with Control / Alt / Shift held around it, as operating-system strokes. */
async function osPress(d: Daemon, a: Args, session: string, spec: string, k: { def: KeyDef; modifiers: number }): Promise<unknown> {
  const base = loadOsInput();
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const stop: StopFlag = { stopped: false };
  return tabs
    .run(
      tab,
      () =>
        withNotices(d, t, tab, async () => {
          const { result, wait, foreground } = await withOs(t, tab, base, stop, (o) =>
            withPostWait(
              t,
              tab,
              optBool(a, "noWait"),
              async (): Promise<Record<string, unknown>> => {
                if (k.def.key.length === 1 && (k.modifiers & 3) === 0 && o.os.capsLock()) throw capsLockError();
                await o.take();
                const lay = layoutOf(o.os);
                const chord = osChordOf(k, spec, lay);
                await sendChord(o.os, chord.mods, chord.key, { check: o.check, browserPid: o.pid, stop });
                return { tab: tab.id, input: "os", level: 3, trusted: true, eventShape: "os", key: spec, layout: lay.name };
              },
              { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) },
            ),
          );
          return { ...result, foreground, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
        }),
      { timeoutMs: timeoutOf(a) },
    )
    .finally(() => {
      stop.stopped = true;
    });
}

const OS_CLICK_USAGE = "tabcap click <ref> --os | tabcap click --os --at <x>,<y>";

// What is at a viewport point of the root document (`--at`): inside the viewport, a frame, and the element's tag and text (never a field's value).
const AT_FN = `function (x, y) {
  const view = this.defaultView;
  const inside = x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight;
  const hit = inside ? this.elementFromPoint(x, y) : null;
  const frame = !!hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME");
  return { inside, frame, width: view.innerWidth, height: view.innerHeight, landed: hit ? { tag: hit.tagName.toLowerCase(), text: String(hit.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60) } : null };
}`;

function osNotDelivered(what: string, probeError: unknown): TabcapError {
  const why = probeError instanceof Error ? `; the page's record could not be read (${probeError.message})` : "";
  return new TabcapError(
    "not-delivered",
    `the press on ${what} did not reach the page (no pointerdown / mousedown${why})`,
    "tabcap did not retry. Look at the page first (`tabcap snapshot` / `tabcap screenshot`): the button did go down on the screen, on whatever was under the pointer.",
  );
}

type OsPress = { moves: number; corrections: number; pressGapMs: number; delivered: Record<string, unknown> };

/**
 * The pointer part of `click --os` (docs/16 §3): watch the document that owns
 * `objectId` (a node or document as resolved in tabcap's isolated world) for trusted pointer events, put the pointer on `local` (that
 * document's client coordinates; `top` is the same point in the tab's viewport,
 * for the first guess), let `hit` veto the spot the page reported, press, and
 * read what arrived. A press that takes the document away counts as delivered
 * only with a recorded navigation, as for `click --trusted`.
 */
async function osPointerPress(t: Transport, tab: Tab, o: OsRun, sid: string, objectId: string, top: Point, local: Point, hit: ((p: Point) => Promise<void>) | null, what: string): Promise<OsPress> {
  const view = viewOf(callResult(await inWorld(t, tab, o.root, (ctx) => t.send("Runtime.evaluate", { expression: VIEW_EXPR, contextId: ctx, returnByValue: true }, tab.sessionId, 5000))));
  if (view === null) throw new TabcapError("page", "the page did not say where its window is on the screen", "Check the tab with `tabcap screenshot`; nothing was pressed.");
  const screen = o.os.screen();
  const made = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: POINTER_WATCH_FN, arguments: [], returnByValue: false }, sid, 5000);
  callResult(made);
  const watchId = isRecord(made["result"]) ? str(made["result"], "objectId") : null;
  if (watchId === null) throw new TabcapError("page", "the page's pointer record could not be set up", "run snapshot again and retry; nothing was pressed.");
  const readRaw = async () => rec(callResult(await t.send("Runtime.callFunctionOn", { objectId: watchId, functionDeclaration: POINTER_READ_FN, arguments: [], returnByValue: true }, sid, 5000)));
  const read = async () => {
    const v = await readRaw();
    return { n: num(v, "n") ?? 0, x: num(v, "x") ?? 0, y: num(v, "y") ?? 0 };
  };
  const nav = tabNavigationProbe(tab);
  try {
    const size = await readRaw();
    const step = stepInside(calibrationStep(screen), local, { w: num(size, "w") ?? view.iw, h: num(size, "h") ?? view.ih });
    const placed = await placePointer(o.os, read, local, estimates(top, view, screen), step, o.stop);
    if (hit !== null) await hit(placed.at);
    const mark = nav.mark();
    const pressGapMs = await pressButton(o.os, { check: o.check, browserPid: o.pid, stop: o.stop });
    const until = Date.now() + OS_PRESS_SEEN_MS;
    for (;;) {
      let got: Record<string, unknown>;
      try {
        got = await readRaw();
      } catch (e) {
        if (nav.navigated(mark) || (await nav.wait(mark, NAVIGATED_PROBE_WAIT_MS))) return { moves: placed.moves, corrections: placed.corrections, pressGapMs, delivered: { pointerdown: "unknown", mousedown: "unknown", reason: "navigated" } };
        throw osNotDelivered(what, e);
      }
      if (got["pointerdown"] === true || got["mousedown"] === true) return { moves: placed.moves, corrections: placed.corrections, pressGapMs, delivered: { pointerdown: got["pointerdown"] === true, mousedown: got["mousedown"] === true } };
      if (Date.now() >= until) throw osNotDelivered(what, null);
      await Bun.sleep(50);
    }
  } finally {
    await t.send("Runtime.callFunctionOn", { objectId: watchId, functionDeclaration: POINTER_OFF_FN, arguments: [], returnByValue: true }, sid, 2000).catch(() => undefined);
  }
}

const xyOf = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** The node as an object of tabcap's isolated world of its own document: functions called on it run no page code and the page cannot reach them. */
async function isolatedOf(t: Transport, tab: Tab, node: InputNode, ref: string, root: FrameDoc): Promise<string> {
  const f = frameOf(node);
  const sid = sessionOf(tab, node);
  const fdoc: FrameDoc = f === null ? root : { frameId: f.frameId, loaderId: f.loaderId, url: "", sessionId: f.sessionId };
  const r = await inWorld(t, tab, fdoc, (ctx) => t.send("DOM.resolveNode", { backendNodeId: node.backendNodeId, executionContextId: ctx }, sid, 5000)).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) throw new TabcapError("stale-ref", `ref ${ref} is no longer in the page`, "run snapshot again; the element was removed or re-rendered.");
  return objectId;
}

/** `click <ref> --os`: the gates of a click, then the foreground, then the pointer on the element's centre in its own document. */
async function osClickRef(d: Daemon, t: Transport, tab: Tab, o: OsRun, ref: string): Promise<Record<string, unknown>> {
  const node = await resolveRef(t, tab, ref);
  const overlayCheck = await overlayGate(t, tab, node, ref);
  const challenge = await actionChallenge(d, t, tab, node);
  const landing = await inspectLanding(t, tab, node, (id) => tab.refs.refFor(id, node.frame));
  const aim: InputNode = landing.kind === "descendant" ? { objectId: landing.node.objectId, backendNodeId: landing.node.backendNodeId, sessionId: node.sessionId, frame: node.frame } : node;
  await o.take();
  const sid = sessionOf(tab, aim);
  // The tab may have been a background tab until now: scroll and measure once it is the one shown.
  liveOrStale(rec(callResult(await call(t, sid, aim.objectId, SCROLL_FN))), ref);
  const landed: { landed: LandedOn | null } = { landed: null };
  const place = await targetPlace(t, tab, aim, ref, landed);
  const own = await isolatedOf(t, tab, aim, ref, o.root);
  const hit = async (p: Point): Promise<void> => {
    const occ = rec(callResult(await call(t, sid, own, OCCLUSION_FN, [p.x, p.y])));
    if (occ["ok"] === true) return;
    throw new TabcapError("not-delivered", `the pointer is on ${str(occ, "hit") ?? "nothing"} at (${Math.round(p.x)}, ${Math.round(p.y)}), not on ref ${ref}; nothing was pressed`, "tabcap did not retry. Run `tabcap snapshot` and check what covers the element.");
  };
  const r = await osPointerPress(t, tab, o, sid, own, place.to, place.local, hit, `ref ${ref}`);
  return {
    tab: tab.id,
    ref,
    ...frameField(node),
    input: "os",
    level: 3,
    trusted: true,
    eventShape: "os",
    at: xyOf(place.to),
    pointer: { moves: r.moves, corrections: r.corrections },
    pressGapMs: r.pressGapMs,
    delivered: r.delivered,
    landedOn: landed.landed,
    overlayCheck,
    ...landingFields(ref, landing),
    ...challenge,
  };
}

/** `click --os --at x,y`: a point of the tab's viewport in the root document (a point inside a frame cannot be read back there: use a ref). */
async function osClickAt(t: Transport, tab: Tab, o: OsRun, at: Point): Promise<Record<string, unknown>> {
  const got = await inWorld(t, tab, o.root, (ctx) => t.send("Runtime.evaluate", { expression: "document", contextId: ctx, returnByValue: false }, tab.sessionId, 5000));
  callResult(got);
  const docId = isRecord(got["result"]) ? str(got["result"], "objectId") : null;
  if (docId === null) throw new TabcapError("page", "the page's document could not be reached", "run `tabcap snapshot` and retry; nothing was pressed.");
  const v = rec(callResult(await call(t, tab.sessionId, docId, AT_FN, [at.x, at.y])));
  if (v["inside"] !== true) {
    throw new TabcapError("usage", `--at ${at.x},${at.y} is outside the page's viewport (${num(v, "width") ?? "?"} × ${num(v, "height") ?? "?"} CSS px)`, "Give a point inside the viewport (see `tabcap screenshot`); scroll the page first when the target is further down.");
  }
  if (v["frame"] === true) {
    throw new TabcapError("unsupported", `--at ${at.x},${at.y} is inside a frame: tabcap cannot read the pointer back from the root document there, so nothing was pressed`, "Use the element's ref instead: `tabcap snapshot --frames`, then `tabcap click <ref> --os`.");
  }
  await o.take();
  const r = await osPointerPress(t, tab, o, tab.sessionId, docId, at, at, null, `(${at.x}, ${at.y})`);
  return { tab: tab.id, input: "os", level: 3, trusted: true, eventShape: "os", at: xyOf(at), pointer: { moves: r.moves, corrections: r.corrections }, pressGapMs: r.pressGapMs, delivered: r.delivered, landedOn: landedOf(v["landed"]) };
}

/** `click --os` (docs/16 §2): a real pointer press through the operating system, on a ref or a viewport point. */
async function osClick(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = optStr(a, "ref");
  const atSpec = optStr(a, "at");
  const usage = (msg: string) => new TabcapError("usage", msg, `Usage: ${OS_CLICK_USAGE}`);
  if (!optBool(a, "os")) throw usage("--at is a screen point for operating-system input: it needs --os");
  if (optBool(a, "trusted")) throw usage("give either --trusted (CDP input) or --os (operating-system input), not both");
  if (optBool(a, "dblClick")) throw usage("--dbl-click is not available with --os");
  const hasRef = ref !== null && ref !== "";
  if (hasRef === (atSpec !== null)) throw usage(hasRef ? "give either a ref or --at, not both" : "missing ref (or --at <x>,<y>)");
  const at = atSpec === null ? null : parseAt(atSpec);
  const base = loadOsInput();
  const cmdStarted = Date.now();
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const noWait = optBool(a, "noWait");
  const stop: StopFlag = { stopped: false };
  return tabs
    .run(
      tab,
      () =>
        withNotices(d, t, tab, async () => {
          const { result, wait, foreground } = await withOs(t, tab, base, stop, (o) =>
            withPostWait(t, tab, noWait, () => (at === null ? osClickRef(d, t, tab, o, ref ?? "") : osClickAt(t, tab, o, at)), { requests: requestWaitOf(d, a, cmdStarted, timeoutOf(a)) }),
          );
          const delivered = result["delivered"];
          const navigated = !noWait && (wait?.navigated === true || (isRecord(delivered) && delivered["reason"] === "navigated"));
          return { ...result, ...(navigated ? { effect: "navigation" } : {}), foreground, url: tab.url, nav: d.navOf(tab), wait, ...(await snapshotAfter(d, t, tab, a)) };
        }),
      { timeoutMs: timeoutOf(a) },
    )
    .finally(() => {
      stop.stopped = true;
    });
}

/** Puppeteer's "Multiple file uploads only work with <input type=file multiple>" check, and the paths. */
export function checkUploadFiles(raw: unknown): string[] {
  const files = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  if (files.length === 0) throw new TabcapError("usage", "missing <files>", "Usage: tabcap upload <ref> <file> [file …]");
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== "string" || f === "") throw new TabcapError("usage", "file paths must be non-empty strings", "Usage: tabcap upload <ref> <file> [file …]");
    if (!isAbsolute(f)) throw new TabcapError("usage", `not an absolute path: ${f}`, "The tabcap CLI resolves relative paths against its working directory; other clients must send absolute paths.");
    if (!existsSync(f) || !statSync(f).isFile()) throw new TabcapError("not-found", `no such file: ${f}`, "Check the path; upload sends local files that already exist.");
    out.push(f);
  }
  return out;
}

const FILE_INPUT_FN = `function () { ${ELEMENT} ${LIVE}
  const file = el instanceof HTMLInputElement && el.type === "file";
  return { file, multiple: file && el.multiple, tag: el.tagName.toLowerCase() };
}`;

/** How long a clicked element has to open its file chooser (chrome-devtools-mcp: 3000 ms). */
const FILE_CHOOSER_MS = 3000;

/**
 * `upload <ref> <files…>`: DOM.setFileInputFiles on an `<input type=file>`;
 * any other element is clicked (DOM click with a user gesture) while the file
 * chooser is intercepted, and the chooser it opens is answered with the files
 * (chrome-devtools-mcp upload_file). No native dialog ever shows.
 */
export async function upload(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = reqStr(a, "ref", "tabcap upload <ref> <file> [file …]");
  const files = checkUploadFiles(a["files"]);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const multipleError = () => new TabcapError("usage", `${files.length} files given, but the input takes one (Multiple file uploads only work with <input type=file multiple>)`, "Upload one file, or pick an input that has the multiple attribute.");
  return tabs.run(
    tab,
    async () => {
      const node = await resolveRef(t, tab, ref);
      const kind = liveOrStale(rec(callResult(await call(t, node.sessionId, node.objectId, FILE_INPUT_FN))), ref);
      let method: "input" | "file-chooser";
      if (kind["file"] === true) {
        if (files.length > 1 && kind["multiple"] !== true) throw multipleError();
        await t.send("DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId }, node.sessionId, 10_000);
        method = "input";
      } else {
        const chooser = await withFileChooser(t, node.sessionId, async () => {
          liveOrStale(rec(callResult(await call(t, node.sessionId, node.objectId, CLICK_FN))), ref);
        });
        if (chooser === null) {
          throw new TabcapError(
            "page",
            `Failed to upload file. The element ${ref} (<${str(kind, "tag") ?? "?"}>) could not accept the file directly, and clicking it did not trigger a file chooser.`,
            "Pick the <input type=file> itself (snapshot --verbose shows it) or the button that opens the file dialog.",
          );
        }
        if (files.length > 1 && chooser.mode === "selectSingle") throw multipleError();
        await t.send("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId }, node.sessionId, 10_000);
        method = "file-chooser";
      }
      return { tab: tab.id, ref, ...frameField(node), method, files: files.length, paths: files, ...(await snapshotAfter(d, t, tab, a)) };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

/**
 * Run `click` with file chooser interception on, on the session of the
 * clicked element's document (a frame ref's own session); the chooser it
 * opened (backend node, mode), or null after FILE_CHOOSER_MS.
 */
async function withFileChooser(t: Transport, sessionId: string, click: () => Promise<void>): Promise<{ backendNodeId: number; mode: string } | null> {
  let resolveOpened: (v: { backendNodeId: number; mode: string }) => void = () => undefined;
  const opened = new Promise<{ backendNodeId: number; mode: string }>((r) => {
    resolveOpened = r;
  });
  const off = t.onEvent((e) => {
    if (e.sessionId !== sessionId || e.method !== "Page.fileChooserOpened") return;
    const id = e.params["backendNodeId"];
    if (typeof id === "number" && Number.isSafeInteger(id)) resolveOpened({ backendNodeId: id, mode: str(e.params, "mode") ?? "selectSingle" });
  });
  await t.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId, 5000);
  try {
    await click();
    return await Promise.race([opened, Bun.sleep(FILE_CHOOSER_MS).then(() => null)]);
  } finally {
    off();
    await t.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId, 5000).catch(() => undefined);
  }
}
