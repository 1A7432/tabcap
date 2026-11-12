// tabcap select <ref> <text> (docs/04 §53.4, 11-12): open a dropdown, pick an
// option by its text, and read the control back.
// - native <select>: the option by text, selectedIndex, input + change events
//   (as Playwright's selectOption);
// - otherwise click <ref> open, then find the options: first ARIA (aria-controls /
//   aria-owns of the control or its input → role=option inside), else the layer
//   this click made visible (positioned elements visible after the click that
//   were not before; the topmost when several): Element UI's el-select has no
//   ARIA at all (measured on 2.15.14). The option is the smallest visible element
//   whose text matches, climbed to its nearest clickable ancestor in the layer.
// - read back after the post-action wait: the control's value (an input inside
//   it), its aria-activedescendant's text, or its visible text; not the wanted
//   text → `not-selected` with the click's answer in `error.result`.
// Never presses Escape or clicks outside: that closes Element's el-dialog too.
// Not done (backlog): multiple selection, cascaders, remote options.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { callResult, resolveRef } from "../browser/doc.ts";
import type { Tab } from "../browser/targets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optStr, reqStr, type Args } from "./args.ts";
import { CLICK_FN, liveOrStale, overlayGate, trustedClickOn, type InputNode, type LandedOn } from "./input.ts";
import { timeoutOf } from "./navigate.ts";
import { withPostWait } from "./settle.ts";
import { snapshotAfter } from "./snapshot.ts";

const USAGE = "tabcap select <ref> <text> [--exact] [--trusted]";
const GROUP = "tabcap-select-option";
/** How long the option list may take to show up after the opening click. */
export const LAYER_WAIT_MS = 1500;
const MAX_LISTED = 10;

/** Normalised visible text: whitespace runs to one space, trimmed. */
export const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Pure: does the shown value satisfy the wanted text (`exact`: equal, else contains)? */
export function selectedMatches(got: string, wanted: string, exact: boolean): boolean {
  const g = norm(got);
  const w = norm(wanted);
  return exact ? g === w : g.includes(w);
}

/**
 * Pure: pick the option among matches (texts in document order): an exact
 * match first (one: it; several: ambiguous), else with `exact` none, else the
 * one containing match or ambiguous.
 */
export function pickOption(texts: readonly string[], wanted: string, exact: boolean): { index: number } | { ambiguous: number[] } | { none: true } {
  const w = norm(wanted);
  const eq = texts.map((t, i) => [norm(t), i] as const).filter(([t]) => t === w).map(([, i]) => i);
  if (eq.length === 1) return { index: eq[0] ?? 0 };
  if (eq.length > 1) return { ambiguous: eq };
  if (exact) return { none: true };
  const inc = texts.map((t, i) => [norm(t), i] as const).filter(([t]) => t.includes(w)).map(([, i]) => i);
  if (inc.length === 1) return { index: inc[0] ?? 0 };
  return inc.length === 0 ? { none: true } : { ambiguous: inc };
}

// Native <select>: the option whose text matches (exact first), selected with input + change.
const NATIVE_FN = `function (wanted, exact) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return { stale: true };
  if (el.tagName !== "SELECT") return { native: false };
  const n = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const w = n(wanted);
  const opts = Array.from(el.options);
  let i = opts.findIndex((o) => n(o.text) === w);
  if (i < 0 && !exact) {
    const inc = opts.map((o, k) => [n(o.text), k]).filter(([t]) => t.includes(w));
    if (inc.length > 1) return { native: true, ambiguous: inc.slice(0, ${MAX_LISTED}).map(([t]) => t) };
    if (inc.length === 1) i = inc[0][1];
  }
  if (i < 0) return { native: true, none: opts.slice(0, ${MAX_LISTED}).map((o) => n(o.text)) };
  if (el.disabled || opts[i].disabled) return { native: true, disabled: true };
  el.focus();
  el.selectedIndex = i;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { native: true, text: n(opts[i].text), value: el.value };
}`;

// Positioned, visible elements near the control and directly under <body> (an
// array object; the second call compares against it). Bounded: body's subtrees to
// depth 4, the control's ancestors' subtrees (4 up) to depth 6, at most 4000 looks.
const LAYERS_JS = `
  const view = window;
  const shown = (x) => { const cs = view.getComputedStyle(x); if (cs.display === "none" || cs.visibility !== "visible" || Number(cs.opacity) === 0) return false; const r = x.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const positioned = (x) => { const cs = view.getComputedStyle(x); return cs.position === "fixed" || cs.position === "absolute"; };
  const layers = () => {
    const out = [];
    const seen = new Set();
    let looks = 0;
    const walk = (x, depth) => {
      if (!x || x.nodeType !== 1 || depth < 0 || looks > 4000 || seen.has(x)) return;
      seen.add(x); looks++;
      if (x !== document.body && positioned(x) && shown(x) && String(x.innerText || "").trim() !== "") { out.push(x); return; }
      for (const c of x.children) walk(c, depth - 1);
    };
    for (const c of document.body.children) walk(c, 4);
    for (let up = el.parentElement, k = 0; up && k < 4 && up !== document.body; up = up.parentElement, k++) for (const c of up.children) walk(c, 6);
    return out;
  };`;

const BEFORE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return [];
  ${LAYERS_JS}
  return layers();
}`;

// After the opening click: the option container (ARIA first, else the new layer)
// and the matching options. Returns [json, ...elements]: json.options[i].n indexes
// the elements after it; json.layer is the container's index or -1.
const FIND_FN = `function (before, wanted, exact) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return [JSON.stringify({ stale: true })];
  ${LAYERS_JS}
  const n = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const nodes = [];
  const idx = (x) => { let i = nodes.indexOf(x); if (i < 0) { nodes.push(x); i = nodes.length - 1; } return i; };
  const clickable = (x) => x.matches("a[href], button, label, option, [onclick], [role=option], [role=menuitem], [role=button], [role=treeitem]") || view.getComputedStyle(x).cursor === "pointer";
  let via = null, box = null, opts = [];
  const ids = [];
  for (const x of [el, el.querySelector("input, [role=combobox]"), el.closest("[role=combobox]")]) {
    if (!x) continue;
    for (const a of ["aria-controls", "aria-owns"]) for (const id of String(x.getAttribute(a) || "").split(/\\s+/)) if (id) ids.push(id);
  }
  for (const id of ids) {
    const c = document.getElementById(id);
    if (!c || !shown(c)) continue;
    const o = Array.from(c.querySelectorAll("[role=option]")).filter(shown);
    if (o.length > 0) { via = "aria"; box = c; opts = o; break; }
  }
  if (box === null) {
    const old = new Set(Array.isArray(before) ? before : []);
    const fresh = layers().filter((x) => !old.has(x) && !x.contains(el));
    if (fresh.length > 0) {
      const z = (x) => { const v = parseInt(view.getComputedStyle(x).zIndex, 10); return Number.isFinite(v) ? v : 0; };
      fresh.sort((a, b) => z(b) - z(a) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
      box = fresh[0];
      via = "layer";
      const all = Array.from(box.querySelectorAll("*")).filter((x) => shown(x) && n(x.innerText) !== "");
      const w = n(wanted);
      const hits = all.filter((x) => (exact ? n(x.innerText) === w : n(x.innerText).includes(w)));
      const minimal = hits.filter((x) => !hits.some((y) => y !== x && x.contains(y)));
      for (const m of minimal) {
        let pick = m;
        for (let up = m, k = 0; up && up !== box && k < 5; up = up.parentElement, k++) if (clickable(up)) { pick = up; break; }
        if (!opts.includes(pick)) opts.push(pick);
      }
      if (opts.length === 0) {
        // nothing matched: list what is there (the smallest elements with text)
        const leaves = all.filter((x) => !all.some((y) => y !== x && x.contains(y)));
        return [JSON.stringify({ via, layer: idx(box), options: [], listed: leaves.slice(0, ${MAX_LISTED}).map((x) => n(x.innerText).slice(0, 80)) }), ...nodes];
      }
    }
  }
  if (box === null) return [JSON.stringify({ via: null, layer: -1, options: [] })];
  if (via === "aria") {
    const w = n(wanted);
    const m = opts.filter((x) => (exact ? n(x.innerText || x.textContent) === w : n(x.innerText || x.textContent).includes(w)));
    if (m.length === 0) return [JSON.stringify({ via, layer: idx(box), options: [], listed: opts.slice(0, ${MAX_LISTED}).map((x) => n(x.innerText || x.textContent).slice(0, 80)) }), ...nodes];
    opts = m;
  }
  const out = opts.slice(0, 50).map((x) => ({ n: idx(x), text: n(x.innerText || x.textContent).slice(0, 200) }));
  return [JSON.stringify({ via, layer: idx(box), options: out }), ...nodes];
}`;

// The value the control shows now: an input's value (the control or one inside
// it), else its aria-activedescendant's text, else its visible text.
const READ_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return { stale: true };
  const n = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  if (el.tagName === "SELECT") return { got: el.selectedIndex >= 0 ? n(el.options[el.selectedIndex].text) : "" };
  const input = el.matches("input, textarea") ? el : el.querySelector("input, textarea");
  if (input && n(input.value) !== "") return { got: n(input.value) };
  const ad = el.getAttribute("aria-activedescendant");
  const act = ad ? document.getElementById(ad) : null;
  if (act) return { got: n(act.innerText || act.textContent) };
  return { got: n(el.innerText || (input ? input.value : "")).slice(0, 500) };
}`;

const SHOWN_FN = `function () { const cs = getComputedStyle(this); const r = this.getBoundingClientRect(); return this.isConnected && cs.display !== "none" && cs.visibility === "visible" && r.width >= 1 && r.height >= 1; }`;

type Found = { via: "aria" | "layer" | null; layer: number; options: Array<{ n: number; text: string }>; listed?: string[]; stale?: boolean };

async function callOn(t: Transport, sessionId: string, objectId: string, fn: string, args: unknown[], byValue: boolean): Promise<Record<string, unknown>> {
  return t.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fn, arguments: args.map((v) => (isRecord(v) && typeof v["objectId"] === "string" ? { objectId: v["objectId"] } : { value: v })), returnByValue: byValue, userGesture: true, objectGroup: GROUP },
    sessionId,
    10_000,
  );
}

/** [json, ...elements] → the parsed json and the element object ids. */
async function unpackNodes(t: Transport, sessionId: string, r: Record<string, unknown>): Promise<{ data: unknown; ids: Array<string | null> }> {
  callResult({ ...r, result: { value: null } });
  const oid = isRecord(r["result"]) ? str(r["result"], "objectId") : null;
  if (oid === null) return { data: null, ids: [] };
  const props = await t.send("Runtime.getProperties", { objectId: oid, ownProperties: true }, sessionId, 10_000);
  const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
  const at = (i: number) => {
    const p = list.find((x) => x["name"] === String(i));
    return p !== undefined && isRecord(p["value"]) ? p["value"] : null;
  };
  let data: unknown = null;
  try {
    data = JSON.parse(str(at(0) ?? {}, "value") ?? "null");
  } catch {
    data = null;
  }
  const ids: Array<string | null> = [];
  for (let i = 1; i < list.length; i++) {
    const v = at(i);
    if (v === null) break;
    ids.push(str(v, "objectId"));
  }
  return { data, ids };
}

const foundOf = (v: unknown): Found => {
  const r = isRecord(v) ? v : {};
  const via = r["via"] === "aria" || r["via"] === "layer" ? r["via"] : null;
  const options = Array.isArray(r["options"]) ? r["options"].filter(isRecord).map((o) => ({ n: typeof o["n"] === "number" ? o["n"] : -1, text: str(o, "text") ?? "" })) : [];
  const listed = Array.isArray(r["listed"]) ? r["listed"].filter((x): x is string => typeof x === "string") : undefined;
  return { via, layer: typeof r["layer"] === "number" ? r["layer"] : -1, options, ...(listed === undefined ? {} : { listed }), ...(r["stale"] === true ? { stale: true } : {}) };
};

/** docs/04 §53.4: candidates the text matched more than one of. */
export function ambiguousOptions(ref: string, wanted: string, texts: readonly string[]): TabcapError {
  return new TabcapError(
    "ambiguous-target",
    `${texts.length} options of ${ref} match ${JSON.stringify(wanted)} and none equals it; nothing was picked`,
    "Give the whole option text, or add --exact.",
    { candidates: texts.slice(0, MAX_LISTED) },
  );
}

/** docs/04 §53.4: no option list, or no option with the text. */
export function noOption(ref: string, wanted: string, listed: readonly string[] | null): TabcapError {
  if (listed === null) {
    return new TabcapError(
      "not-found",
      `clicking ${ref} showed no option list (no aria-controls list, no new layer within ${LAYER_WAIT_MS} ms)`,
      `Open it yourself (\`tabcap click ${ref}\`), look with \`tabcap snapshot\`, then click the option's ref.`,
    );
  }
  return new TabcapError("not-found", `no option of ${ref} matches ${JSON.stringify(wanted)}`, listed.length > 0 ? "Pick one of `candidates` (the list may scroll: type a filter first if the control has one)." : "The list is empty; check the page with `tabcap snapshot`.", {
    candidates: listed.slice(0, MAX_LISTED),
  });
}

/** docs/04 §53.4: the control shows something else after the pick. */
export function notSelected(ref: string, wanted: string, got: string, result: Record<string, unknown>): TabcapError {
  return new TabcapError(
    "not-selected",
    `after picking ${JSON.stringify(wanted)}, ${ref} shows ${JSON.stringify(got.slice(0, 200))}`,
    "The dropdown shows another value; look with `tabcap snapshot`, then try again with --exact or --trusted.",
    { wanted, got: got.slice(0, 200), result },
  );
}

async function inputNodeOf(t: Transport, base: InputNode, objectId: string): Promise<InputNode> {
  const sid = base.sessionId ?? "";
  const d = await t.send("DOM.describeNode", { objectId }, sid, 5000);
  const node = isRecord(d["node"]) ? d["node"] : null;
  const id = node === null ? null : node["backendNodeId"];
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new TabcapError("stale-ref", "the option disappeared before it was clicked", "Run the select again.");
  return { objectId, backendNodeId: id, sessionId: sid, frame: base.frame ?? null };
}

/** One click (DOM, or trusted via the click ladder): the landedOn of it. */
async function clickOnce(t: Transport, tab: Tab, node: InputNode, ref: string, trusted: boolean): Promise<{ tag: string | null; text: string } | LandedOn | null> {
  await overlayGate(t, tab, node, ref, !trusted);
  if (!trusted) {
    const r = callResult(await callOn(t, node.sessionId ?? tab.sessionId, node.objectId, CLICK_FN, [], true));
    const v = liveOrStale(isRecord(r) ? r : {}, ref);
    return { tag: str(v, "tag"), text: str(v, "text") ?? "" };
  }
  const r = await trustedClickOn(t, tab, node, ref);
  return r.landed;
}

export async function select(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ref = reqStr(a, "ref", USAGE);
  const wanted = typeof a["text"] === "string" ? a["text"] : null;
  if (wanted === null || norm(wanted) === "") throw new TabcapError("usage", "missing option text", `Usage: ${USAGE}`);
  const exact = optBool(a, "exact");
  const trusted = optBool(a, "trusted");
  const noWait = optBool(a, "noWait");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      let control: InputNode | null = null;
      let layerId: string | null = null;
      const { result, wait } = await withPostWait(t, tab, noWait, async (): Promise<Record<string, unknown>> => {
        const node = await resolveRef(t, tab, ref);
        control = node;
        const sid = node.sessionId;
        try {
          const nat = callResult(await callOn(t, sid, node.objectId, NATIVE_FN, [wanted, exact], true));
          const nv = liveOrStale(isRecord(nat) ? nat : {}, ref);
          if (nv["native"] === true) {
            await overlayGate(t, tab, node, ref);
            if (Array.isArray(nv["ambiguous"])) throw ambiguousOptions(ref, wanted, nv["ambiguous"].filter((x): x is string => typeof x === "string"));
            if (Array.isArray(nv["none"])) throw noOption(ref, wanted, nv["none"].filter((x): x is string => typeof x === "string"));
            if (nv["disabled"] === true) throw new TabcapError("page", `${ref} or the option is disabled`, "Nothing was picked; check the form with `tabcap snapshot`.");
            return { tab: tab.id, ref, via: "native", selected: { text: str(nv, "text") ?? "", option: null }, landedOn: null };
          }
          // Remember the layers before opening, click the control open, wait for the list.
          const b = await callOn(t, sid, node.objectId, BEFORE_FN, [], false);
          const beforeId = isRecord(b["result"]) ? str(b["result"], "objectId") : null;
          await clickOnce(t, tab, node, ref, trusted);
          const until = Date.now() + LAYER_WAIT_MS;
          let found: Found = { via: null, layer: -1, options: [] };
          let ids: Array<string | null> = [];
          for (;;) {
            const r = await callOn(t, sid, node.objectId, FIND_FN, [beforeId === null ? [] : { objectId: beforeId }, wanted, exact], false);
            const u = await unpackNodes(t, sid, r);
            found = foundOf(u.data);
            ids = u.ids;
            if (found.stale === true) liveOrStale({ stale: true }, ref);
            if (found.via !== null || Date.now() >= until) break;
            await Bun.sleep(100);
          }
          if (found.via === null) throw noOption(ref, wanted, null);
          if (found.options.length === 0) throw noOption(ref, wanted, found.listed ?? []);
          const pick = pickOption(found.options.map((o) => o.text), wanted, exact);
          if ("none" in pick) throw noOption(ref, wanted, found.options.map((o) => o.text));
          if ("ambiguous" in pick) throw ambiguousOptions(ref, wanted, pick.ambiguous.map((i) => found.options[i]?.text ?? ""));
          const opt = found.options[pick.index];
          const optObj = opt === undefined ? null : (ids[opt.n] ?? null);
          if (opt === undefined || optObj === null) throw new TabcapError("stale-ref", "the option disappeared before it was clicked", "Run the select again.");
          layerId = found.layer >= 0 ? (ids[found.layer] ?? null) : null;
          const optNode = await inputNodeOf(t, node, optObj);
          const optRef = tab.refs.refFor(optNode.backendNodeId, node.frame);
          await callOn(t, sid, optObj, "function () { this.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }", [], true);
          const landedOn = await clickOnce(t, tab, optNode, optRef, trusted);
          return { tab: tab.id, ref, via: found.via, selected: { text: opt.text, option: optRef }, landedOn, trusted };
        } finally {
          // The layer's object stays alive until the read-back below.
          if (layerId === null) await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, sid, 3000).catch(() => undefined);
        }
      });
      const c = control as InputNode | null;
      let got = "";
      let layerOpen = false;
      if (c !== null) {
        const sid = c.sessionId ?? tab.sessionId;
        const v = await callOn(t, sid, c.objectId, READ_FN, [], true).then((r) => callResult(r)).catch(() => null);
        got = isRecord(v) ? (str(v, "got") ?? "") : "";
        const lid = layerId as string | null;
        if (lid !== null) {
          const s = await callOn(t, sid, lid, SHOWN_FN, [], true).then((r) => callResult(r)).catch(() => false);
          layerOpen = s === true;
          await t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, sid, 3000).catch(() => undefined);
        }
      }
      const out = { ...result, value: d.secrets.scrub(got), ...(layerOpen ? { layerOpen: true } : {}), url: tab.url, nav: d.navOf(tab), wait };
      if (!selectedMatches(got, wanted, exact)) throw notSelected(ref, wanted, d.secrets.scrub(got), out);
      return { ...out, ...(await snapshotAfter(d, t, tab, a)) };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
