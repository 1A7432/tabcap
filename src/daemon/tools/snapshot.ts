// tabcap snapshot | find, plus ref resolution shared with click / fill.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { buildAxTree, findCandidates, hitOf, interactiveOnly, rankClickable, renderAxTree, textInputsWithValue, type AxNode, type FindCandidate } from "../browser/ax.ts";
import { inspectPage } from "../adapters/runtime.ts";
import { cutText, headerLines } from "../adapters/view.ts";
import { sameDoc, type DocIdentity } from "../browser/refs.ts";
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

/** Attribute map of a DOM node from DOM.describeNode (untrusted). */
export async function nodeAttributes(t: Transport, tab: Tab, backendNodeId: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await t.send("DOM.describeNode", { backendNodeId }, tab.sessionId, 5000).catch(() => null);
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

export async function axTree(t: Transport, tab: Tab, verbose = false): Promise<Tree> {
  await settle(tab, 10_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await docIdentity(t, tab);
    const raw = await t.send("Accessibility.getFullAXTree", {}, tab.sessionId, 30_000);
    const after = await docIdentity(t, tab);
    if (!sameDoc(before, after)) continue; // navigated mid-snapshot: an old tree must never meet a new document
    const pw = new Set<number>();
    for (const id of textInputsWithValue(raw)) {
      const at = await nodeAttributes(t, tab, id);
      if (isSensitiveField(at.get("type") ?? null, at.get("autocomplete") ?? null)) pw.add(id);
    }
    const root = buildAxTree(raw, pw, { verbose });
    if (root === null) throw new TabcapError("page", "the accessibility tree is empty", "Wait for the page to render (`tabcap screenshot`), then snapshot again.");
    tab.refs.setDocument(after);
    return { root, doc: after };
  }
  throw new TabcapError("page", "the page kept navigating during the snapshot", "Wait a moment and run `tabcap snapshot` again.");
}

export type SnapshotOptions = { interactive: boolean; verbose: boolean; maxChars: number; filePath: string | null };

export function snapshotOptions(a: Args): SnapshotOptions {
  const filePath = optStr(a, "filePath");
  return {
    interactive: optBool(a, "interactive"),
    verbose: optBool(a, "verbose"),
    maxChars: Math.max(1000, Math.min(optNum(a, "maxChars") ?? MAX_OUTPUT_CHARS, 4_000_000)),
    filePath: filePath === null || filePath === "" ? null : resolve(filePath),
  };
}

/**
 * The snapshot of one tab, for `snapshot` and for `--snapshot` on the
 * interactive commands. Call it inside the tab's job (Tabs.run), never around it.
 */
export async function renderSnapshot(d: Daemon, t: Transport, tab: Tab, o: SnapshotOptions): Promise<Record<string, unknown>> {
  const { root, doc } = await axTree(t, tab, o.verbose);
  const view = o.interactive ? (interactiveOnly(root) ?? root) : root;
  // Tree refs are minted first (document order), then the header's close-button refs.
  const full = renderAxTree(view, (id) => tab.refs.refFor(id), Number.MAX_SAFE_INTEGER);
  const page = await inspectPage(t, tab, doc);
  // docs/09 §2.3: overlays first. The header counts toward --max-chars (at most half of it).
  const header = cutText(headerLines(page).join("\n"), Math.floor(o.maxChars / 2)).text;
  const head = {
    tab: tab.id,
    url: doc.url,
    title: root.name,
    nav: d.navOf(tab),
    interactive: o.interactive,
    verbose: o.verbose,
    refs: full.refs,
    overlays: page.overlays,
    detected: (page.detected ?? []).filter((x) => x.confidence > 0),
  };
  if (o.filePath !== null) {
    // --file-path: the whole tree goes to the file (no --max-chars cut), the answer carries the path.
    const text = `${header}\n${full.text}\n`;
    mkdirSync(dirname(o.filePath), { recursive: true });
    writeFileSync(o.filePath, text, { mode: 0o600 });
    return { ...head, chars: text.length, truncated: false, path: o.filePath };
  }
  const body = cutText(full.text, o.maxChars - header.length - 1);
  const chars = header.length + 1 + full.chars;
  return {
    ...head,
    chars,
    truncated: body.truncated,
    ...(body.truncated ? { note: `truncated at ${o.maxChars} of ${chars} chars; use --interactive, --file-path or tabcap find <text>` } : {}),
    tree: `${header}\n${body.text}`,
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
  const { tab: _tab, ...snap } = await renderSnapshot(d, t, tab, { interactive: false, verbose: false, maxChars: MAX_OUTPUT_CHARS, filePath: null });
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

/** Resolve `e<n>` to a live JS object of the node, or a stale-ref error saying what to do. */
export async function resolveRef(t: Transport, tab: Tab, ref: string): Promise<{ objectId: string; backendNodeId: number }> {
  const doc = await docIdentity(t, tab);
  const look = tab.refs.lookup(ref, doc);
  if (!look.ok) {
    if (look.reason === "malformed") throw new TabcapError("usage", `not a ref: ${ref}`, "Refs look like e12; get them from `tabcap snapshot` or `tabcap find`.");
    const why = look.reason === "unknown" ? `ref ${ref} is unknown on tab ${tab.id}` : `ref ${ref} expired: the document changed since the snapshot`;
    throw new TabcapError("stale-ref", why, "run snapshot again (`tabcap snapshot --interactive`) and use the new ref.");
  }
  const r = await t.send("DOM.resolveNode", { backendNodeId: look.backendNodeId }, tab.sessionId, 10_000).catch(() => null);
  const obj = r !== null && isRecord(r["object"]) ? r["object"] : null;
  const objectId = obj === null ? null : str(obj, "objectId");
  if (objectId === null) throw new TabcapError("stale-ref", `ref ${ref} is no longer in the page`, "run snapshot again; the element was removed or re-rendered.");
  return { objectId, backendNodeId: look.backendNodeId };
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

