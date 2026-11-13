// tabcap evaluate | screenshot | dialog

import { readTab } from "./readtab.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { imageSize, pngIsUniform } from "../../shared/png.ts";
import { log } from "../../shared/log.ts";
import { compactStamp, nowMs } from "../../shared/time.ts";
import { withFocusEmulation } from "../browser/focus.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import type { Tab } from "../browser/targets.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { resolveRef, type RefNode } from "../browser/doc.ts";
import { chainTo, placeChain, rawFrames } from "../browser/frames.ts";

export const MAX_OUTPUT_CHARS = 60_000;
const EVAL_GROUP = "tabcap-evaluate";

const EVAL_USAGE = "tabcap evaluate <expr> [--await] | tabcap evaluate --function '<js function>' [--args '<json array>']";

/** `--args '[1, "x", {"ref":"e12"}]'` → call arguments; {"ref": "e12"} (that key only) stands for an element. */
export function parseEvalArgs(raw: string | null): Array<{ value: unknown } | { ref: string }> {
  if (raw === null) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new TabcapError("usage", `--args is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, `Pass a JSON array, e.g. --args '[1, "x", {"ref":"e12"}]'.`);
  }
  if (!Array.isArray(v)) throw new TabcapError("usage", "--args must be a JSON array", `e.g. --args '[1, "x"]'; ${EVAL_USAGE}`);
  return v.map((x: unknown) => (isRecord(x) && Object.keys(x).length === 1 && typeof x["ref"] === "string" ? { ref: x["ref"] } : { value: x }));
}

/** A tabcap evaluate in flight on the tab: trace mode tags the reads it triggers `caller.kind: "tabcap"` (0.4-F). */
function asTabcap<T>(d: Daemon, session: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const tr = d.tracers.get(session);
  return tr === undefined ? fn() : tr.markEval(sessionId, fn);
}

export async function evaluate(d: Daemon, a: Args, session: string): Promise<unknown> {
  const fn = optStr(a, "function");
  const given = optStr(a, "expression");
  if (fn !== null && given !== null) throw new TabcapError("usage", "give either an expression or --function, not both", `Usage: ${EVAL_USAGE}`);
  if (fn === null && optStr(a, "args") !== null) throw new TabcapError("usage", "--args needs --function", `Usage: ${EVAL_USAGE}`);
  if (fn !== null) return evaluateFunction(d, a, session, fn);
  const expression = reqStr(a, "expression", EVAL_USAGE);
  const awaitPromise = optBool(a, "await");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const budget = timeoutOf(a);
  const release = () => t.send("Runtime.releaseObjectGroup", { objectGroup: EVAL_GROUP }, tab.sessionId, 5000).then(() => undefined, () => undefined);
  return tabs.run(
    tab,
    () => asTabcap(d, session, tab.sessionId, async () => {
      // Without --await, ask for a handle first: a Promise returned by value comes
      // back as a bare {} (no subtype), which reads like a real empty object.
      const r = await t.send("Runtime.evaluate", { expression, returnByValue: awaitPromise, awaitPromise, objectGroup: EVAL_GROUP }, tab.sessionId, budget);
      const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
      if (ex !== null) {
        await release();
        const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
        const what = str(exc, "description") ?? str(ex, "text") ?? "exception";
        throw new TabcapError("page", `the expression threw: ${what.slice(0, 2000)}`, "Fix the expression; it runs in the page's main world like the DevTools console.");
      }
      let res = isRecord(r["result"]) ? r["result"] : {};
      if (!awaitPromise) {
        if (str(res, "subtype") === "promise") {
          await release();
          throw new TabcapError("needs-await", "the expression returned a Promise; without --await its value is not waited for", "re-run with --await");
        }
        const objectId = str(res, "objectId");
        if (objectId !== null) {
          try {
            const v = await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return this; }", returnByValue: true }, tab.sessionId, budget);
            res = { ...(isRecord(v["result"]) ? v["result"] : {}), type: str(res, "type") ?? "object" };
          } finally {
            await release();
          }
        }
      }
      const type = str(res, "type") ?? "undefined";
      let value: unknown = "value" in res ? res["value"] : (str(res, "unserializableValue") ?? str(res, "description") ?? null);
      if (type === "undefined") value = null;
      const text = JSON.stringify(value) ?? "null";
      if (text.length > MAX_OUTPUT_CHARS) {
        return { tab: tab.id, type, valueText: text.slice(0, MAX_OUTPUT_CHARS), truncated: true, chars: text.length, note: `output truncated at ${MAX_OUTPUT_CHARS} chars; return a smaller value` };
      }
      return { tab: tab.id, type, value, truncated: false };
    }),
    { timeoutMs: budget },
  );
}

/**
 * `evaluate --function '(a, b) => …' --args '[…]'` (chrome-devtools-mcp
 * evaluate_script): Runtime.callFunctionOn on the page's global object;
 * element arguments come from refs; a returned promise is awaited.
 */
async function evaluateFunction(d: Daemon, a: Args, session: string, fn: string): Promise<unknown> {
  if (fn.trim() === "") throw new TabcapError("usage", "--function must not be empty", `Usage: ${EVAL_USAGE}`);
  const args = parseEvalArgs(optStr(a, "args"));
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const budget = timeoutOf(a);
  // 0.4-I: element arguments from a frame make the function run in that frame's window (its session);
  // refs of two different documents cannot meet in one call.
  const refArgs = args.filter((x): x is { ref: string } => "ref" in x);
  return tabs.run(
    tab,
    async () => {
      const nodes = new Map<string, RefNode>();
      for (const x of refArgs) if (!nodes.has(x.ref)) nodes.set(x.ref, await resolveRef(t, tab, x.ref));
      const docs = new Set([...nodes.values()].map((n) => `${n.sessionId}|${n.frame?.frameId ?? "root"}`));
      if (docs.size > 1) throw new TabcapError("usage", "the element arguments are in different documents (frames)", "Pass refs of one frame per call (the function runs in that frame's window).");
      const first = [...nodes.values()][0];
      const sid = first === undefined ? tab.sessionId : first.sessionId;
      const release = () => t.send("Runtime.releaseObjectGroup", { objectGroup: EVAL_GROUP }, sid, 5000).then(() => undefined, () => undefined);
      return asTabcap(d, session, sid, async () => {
      try {
        const callArgs: Array<{ value: unknown } | { objectId: string }> = [];
        for (const x of args) callArgs.push("ref" in x ? { objectId: nodes.get(x.ref)?.objectId ?? "" } : { value: x.value });
        let gid: string | null;
        if (first === undefined || first.frame === null) {
          const g = await t.send("Runtime.evaluate", { expression: "globalThis", objectGroup: EVAL_GROUP }, tab.sessionId, budget);
          gid = isRecord(g["result"]) ? str(g["result"], "objectId") : null;
        } else {
          // The frame's own window: the realm the element belongs to.
          const g = await t.send("Runtime.callFunctionOn", { objectId: first.objectId, functionDeclaration: "function () { return (this.ownerDocument || this).defaultView; }", returnByValue: false, objectGroup: EVAL_GROUP }, sid, budget);
          gid = isRecord(g["result"]) ? str(g["result"], "objectId") : null;
        }
        if (gid === null) throw new TabcapError("page", "the page has no global object to call the function on", "Navigate again; the tab may be on an error page.");
        const r = await t.send(
          "Runtime.callFunctionOn",
          { objectId: gid, functionDeclaration: fn, arguments: callArgs, returnByValue: true, awaitPromise: true, objectGroup: EVAL_GROUP, userGesture: true },
          sid,
          budget,
        );
        const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
        if (ex !== null) {
          const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
          const what = str(exc, "description") ?? str(ex, "text") ?? "exception";
          throw new TabcapError("page", `the function threw: ${what.slice(0, 2000)}`, "Fix the function; it runs in the page's main world, e.g. --function '(el) => el.innerText' --args '[{\"ref\":\"e12\"}]'.");
        }
        const res = isRecord(r["result"]) ? r["result"] : {};
        const type = str(res, "type") ?? "undefined";
        const value: unknown = type === "undefined" ? null : "value" in res ? res["value"] : (str(res, "unserializableValue") ?? str(res, "description") ?? null);
        const text = JSON.stringify(value) ?? "null";
        if (text.length > MAX_OUTPUT_CHARS) return { tab: tab.id, type, valueText: text.slice(0, MAX_OUTPUT_CHARS), truncated: true, chars: text.length, note: `output truncated at ${MAX_OUTPUT_CHARS} chars; return a smaller value` };
        return { tab: tab.id, type, value, truncated: false, ...(first?.frame ? { frame: first.frame.path } : {}) };
      } finally {
        await release();
      }
      });
    },
    { timeoutMs: budget },
  );
}

export type ShotFormat = "png" | "jpeg" | "webp";
export const SHOT_SCALE_MIN = 0.1;

/**
 * The visible part of the page as a capture clip in page coordinates (CSS px),
 * for a scaled viewport screenshot: Page.captureScreenshot scales only through
 * `clip.scale`. Null when Chrome's metrics are not usable.
 */
export function viewportClip(metrics: Record<string, unknown>, scale: number): Record<string, number> | null {
  const v = isRecord(metrics["cssVisualViewport"]) ? metrics["cssVisualViewport"] : null;
  if (v === null) return null;
  const x = num(v, "pageX");
  const y = num(v, "pageY");
  const width = num(v, "clientWidth");
  const height = num(v, "clientHeight");
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height, scale };
}

/**
 * Screenshot arguments (chrome-devtools-mcp take_screenshot: format, quality,
 * uid → --ref, fullPage, filePath); `out` / `full` are the pre-0.3 keys.
 */
export function shotOptions(a: Args): { format: ShotFormat; quality: number | null; ref: string | null; fullPage: boolean; filePath: string | null } {
  const format = optStr(a, "format") ?? "png";
  if (format !== "png" && format !== "jpeg" && format !== "webp") throw new TabcapError("usage", `--format ${format}?`, "Use --format png | jpeg | webp.");
  const q = optNum(a, "quality");
  if (q !== null && (q < 0 || q > 100 || !Number.isInteger(q))) throw new TabcapError("usage", "--quality must be a whole number from 0 to 100", "e.g. --format jpeg --quality 80 (png ignores it).");
  const ref = optStr(a, "ref");
  const fullPage = optBool(a, "fullPage") || optBool(a, "full");
  if (ref !== null && fullPage) throw new TabcapError("usage", "Providing both --ref and --full-page is not allowed.", "Use --ref for one element or --full-page for the whole page.");
  return { format, quality: format === "png" ? null : q, ref, fullPage, filePath: optStr(a, "filePath") ?? optStr(a, "out") };
}

/** `--scale` (docs/04 §54.2): shrink only (an image larger than the page's pixels adds nothing); null for none or 1. */
export function shotScale(a: Args): number | null {
  const sc = optNum(a, "scale");
  if (sc !== null && !(sc >= SHOT_SCALE_MIN && sc <= 1)) throw new TabcapError("usage", `--scale must be a number from ${SHOT_SCALE_MIN} to 1`, "e.g. --scale 0.5 for half the width and height.");
  return sc === null || sc === 1 ? null : sc;
}

const SCROLL_OFFSET = "({ x: window.scrollX, y: window.scrollY })";

export async function screenshot(d: Daemon, a: Args, session: string): Promise<unknown> {
  const o = { ...shotOptions(a), scale: shotScale(a) };
  const { t, tabs } = d.need();
  const tab = await readTab(tabs, a, session);
  return tabs.run(
    tab,
    async () => {
      const params: Record<string, unknown> = { format: o.format, fromSurface: true, captureBeyondViewport: o.fullPage || o.ref !== null, ...(o.quality === null ? {} : { quality: o.quality }) };
      if (o.fullPage) {
        const m = await t.send("Page.getLayoutMetrics", {}, tab.sessionId);
        const size = isRecord(m["cssContentSize"]) ? m["cssContentSize"] : null;
        const w = size === null ? null : num(size, "width");
        const h = size === null ? null : num(size, "height");
        if (w !== null && h !== null && w > 0 && h > 0) params["clip"] = { x: 0, y: 0, width: Math.ceil(w), height: Math.min(Math.ceil(h), 16384), scale: 1 };
      }
      if (o.ref !== null) params["clip"] = await elementClip(t, tab, o.ref);
      if (o.scale !== null) {
        const clip = isRecord(params["clip"]) ? params["clip"] : viewportClip(await t.send("Page.getLayoutMetrics", {}, tab.sessionId), o.scale);
        if (clip === null) throw new TabcapError("cdp", "Page.getLayoutMetrics returned no visual viewport, so the screenshot cannot be scaled", "Retry without --scale; if it persists the tab may be on an error page — navigate again.");
        params["clip"] = { ...clip, scale: o.scale };
      }
      const { png: image, focusEmulation } = await captureTab(t, tab.sessionId, params, tab.id);
      const info = imageSize(image);
      const ext = o.format === "jpeg" ? "jpeg" : o.format;
      const path = o.filePath !== null ? resolve(o.filePath) : join(d.paths.shots, `${session}-${tab.id}-${compactStamp(nowMs())}-${randomBytes(3).toString("hex")}.${ext}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, image);
      return { tab: tab.id, path, format: o.format, ...(o.ref === null ? {} : { ref: o.ref }), fullPage: o.fullPage, ...(o.scale === null ? {} : { scale: o.scale }), width: info?.width ?? null, height: info?.height ?? null, bytes: image.length, focusEmulation };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

/**
 * Page-coordinate clip of an element's border box, after scrolling it into view
 * (Puppeteer ElementHandle.screenshot). A frame ref's box is moved by its
 * frame's offset chain into the tab's viewport (0.4-I, docs/07 §1.1).
 */
async function elementClip(t: Transport, tab: Tab, ref: string): Promise<Record<string, number>> {
  const node = await resolveRef(t, tab, ref);
  await t.send("Runtime.callFunctionOn", { objectId: node.objectId, functionDeclaration: "function () { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.scrollIntoView({ block: \"center\", inline: \"center\" }); }", returnByValue: true }, node.sessionId, 5000);
  let off = { x: 0, y: 0 };
  if (node.frame !== null) {
    const chain = chainTo(await rawFrames(t, tab), node.frame.frameId);
    if (chain === null) throw new TabcapError("stale-ref", `ref ${ref} expired: frame ${node.frame.path} is gone`, "run snapshot again (`tabcap snapshot --frames`) and use the new ref.");
    off = (await placeChain(t, chain)).space.at(-1) ?? off;
  }
  const r = await t.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }, node.sessionId, 5000).catch(() => null);
  const model = r !== null && isRecord(r["model"]) ? r["model"] : null;
  const q = model !== null && Array.isArray(model["border"]) ? model["border"].filter((n): n is number => typeof n === "number") : [];
  if (q.length < 8) throw new TabcapError("page", `ref ${ref} has no box (hidden or zero-size)`, "Take a screenshot of the page instead, or snapshot again to find a visible element.");
  const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
  const ys = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
  const sr = await t.send("Runtime.evaluate", { expression: SCROLL_OFFSET, returnByValue: true }, tab.sessionId, 5000);
  const so = isRecord(sr["result"]) && isRecord(sr["result"]["value"]) ? sr["result"]["value"] : {};
  const sx = typeof so["x"] === "number" ? so["x"] : 0;
  const sy = typeof so["y"] === "number" ? so["y"] : 0;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  if (width <= 0 || height <= 0) throw new TabcapError("page", `ref ${ref} has a zero-size box`, "Pick a visible element (snapshot again).");
  return { x: x + off.x + sx, y: y + off.y + sy, width, height, scale: 1 };
}

/**
 * Page.captureScreenshot of one tab. Hidden tabs render via
 * CDPScreenshotNewSurface (measured 10-15). That path has two failure shapes,
 * both answered by focus emulation (docs/07 §1.1 level 2: the page is
 * `visible` for this one capture, so Chrome draws a real frame): a flat-colour
 * image, and an immediate "Unable to capture screenshot" — measured 10-15 on
 * background tabs never captured before, right after their content changed
 * (4 of 15 guard screenshots of the s15 wall; a capture of the same tab a few
 * seconds later worked, and the focus-emulated capture worked 5 of 5). This is
 * the s15 e2e flake: the guard's screenshot came back null.
 */
export async function captureTab(t: Transport, sessionId: string, params: Record<string, unknown>, tabId: string): Promise<{ png: Uint8Array; focusEmulation: boolean }> {
  const capture = async () => {
    const r = await t.send("Page.captureScreenshot", params, sessionId, 30_000);
    const data = str(r, "data");
    if (data === null) throw new TabcapError("cdp", "Page.captureScreenshot returned no data", "Retry; if it persists the tab may be crashed — navigate again.");
    return new Uint8Array(Buffer.from(data, "base64"));
  };
  let png: Uint8Array | null = null;
  let plainError: string | null = null;
  try {
    png = await capture();
  } catch (e) {
    if (!isNoFrameError(e)) throw e;
    plainError = e instanceof Error ? e.message : String(e);
  }
  if (png !== null && pngIsUniform(png) !== true) return { png, focusEmulation: false };
  log.info("screenshot: capturing with focus emulation", { tab: tabId, why: plainError ?? "uniform image" });
  return { png: await withFocusEmulation(t, sessionId, capture), focusEmulation: true };
}

/** Chrome's answer when the hidden view has no frame to copy (page_handler.cc "Unable to capture screenshot"). */
export function isNoFrameError(e: unknown): boolean {
  return e instanceof Error && e.name === "CdpError" && e.message.includes("Unable to capture screenshot");
}

export async function dialog(d: Daemon, a: Args, session: string): Promise<unknown> {
  const op = reqStr(a, "op", "tabcap dialog status|accept|dismiss [--prompt-text t]");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  if (op === "status") return { tab: tab.id, open: tab.dialog !== null, dialog: tab.dialog };
  if (op !== "accept" && op !== "dismiss") throw new TabcapError("usage", `dialog ${op}?`, "Use `tabcap dialog status|accept|dismiss`.");
  const dlg = tab.dialog;
  if (dlg === null) throw new TabcapError("not-found", "no dialog is open on this tab", "Nothing to do; continue with the next command.");
  const text = optStr(a, "text") ?? optStr(a, "promptText");
  return tabs.run(
    tab,
    async () => {
      await t.send("Page.handleJavaScriptDialog", { accept: op === "accept", ...(text === null ? {} : { promptText: text }) }, tab.sessionId, 10_000);
      tab.dialog = null;
      return { tab: tab.id, handled: op, type: dlg.type, message: dlg.message };
    },
    { allowDialog: true, timeoutMs: 15_000 },
  );
}
