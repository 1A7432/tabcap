// Trace mode signal list (docs/04 §4.1 `signal`, 0.4-F).
// Spec: docs/04 §4.1 / §7; mechanism measured in the 10-16 spike (CfT 155,
// NOTES 2026-10-16 · spike · 页面脚本读了哪些信号). Oracle for the names: the
// browser itself — every name is checked with Object.getOwnPropertyDescriptor
// in each realm before a breakpoint goes on it; missing ones are skipped and
// listed by `trace status`. Reproduce: `tabcap trace start`, then
// `tabcap trace status` on any page.
//
// Names only, in IDL form (`Interface.prototype.member`, or a namespace path
// such as `Intl.DateTimeFormat.prototype.resolvedOptions`). No values and no
// reference data live in the repository. Read-only: resolving a name reads
// property descriptors, it never calls a getter and never changes anything.

import { createHash } from "node:crypto";
import { TabcapError } from "../../shared/envelope.ts";

/** The built-in list, embedded as JSON text: `manifest.mode.trace.apis` hashes exactly this text. */
export const DEFAULT_SIGNALS_JSON = JSON.stringify([
  // Navigator
  "Navigator.prototype.userAgent",
  "Navigator.prototype.platform",
  "Navigator.prototype.language",
  "Navigator.prototype.languages",
  "Navigator.prototype.hardwareConcurrency",
  "Navigator.prototype.deviceMemory",
  "Navigator.prototype.plugins",
  "Navigator.prototype.mimeTypes",
  "Navigator.prototype.webdriver",
  "Navigator.prototype.vendor",
  "Navigator.prototype.maxTouchPoints",
  "Navigator.prototype.userAgentData",
  "NavigatorUAData.prototype.getHighEntropyValues",
  "Permissions.prototype.query",
  "MediaDevices.prototype.enumerateDevices",
  // Screen
  "Screen.prototype.width",
  "Screen.prototype.height",
  "Screen.prototype.availWidth",
  "Screen.prototype.availHeight",
  "Screen.prototype.colorDepth",
  "Screen.prototype.pixelDepth",
  // window.devicePixelRatio: traced only when a getter exists on the prototype
  // chain; on CfT 155 it is an own accessor of the global object, so this name
  // is reported as skipped (trace status says why).
  "Window.prototype.devicePixelRatio",
  // Time zone
  "Intl.DateTimeFormat.prototype.resolvedOptions",
  "Date.prototype.getTimezoneOffset",
  // Canvas
  "HTMLCanvasElement.prototype.toDataURL",
  "HTMLCanvasElement.prototype.toBlob",
  "CanvasRenderingContext2D.prototype.getImageData",
  // WebGL
  "WebGLRenderingContext.prototype.getParameter",
  "WebGLRenderingContext.prototype.getExtension",
  "WebGLRenderingContext.prototype.getSupportedExtensions",
  "WebGL2RenderingContext.prototype.getParameter",
  "WebGL2RenderingContext.prototype.getExtension",
  "WebGL2RenderingContext.prototype.getSupportedExtensions",
  // Speech, fonts
  "SpeechSynthesis.prototype.getVoices",
  "FontFaceSet.prototype.check",
]);

export function defaultSignals(): string[] {
  const v: unknown = JSON.parse(DEFAULT_SIGNALS_JSON);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Instrumentation breakpoints recorded as `signal` with `access: "event"`
 * (EventBreakpoints.setInstrumentationBreakpoint). protocol.json does not list
 * the names and a wrong name is accepted silently, so this list is the only
 * place they live; each one was seen firing on CfT 155 in the 10-16 spike
 * (canvasContextCreated for 2d and webgl, webglErrorFired, audioContextCreated,
 * audioContextClosed). Keep it to names that were measured.
 */
export const INSTRUMENTATION_EVENTS: readonly string[] = ["canvasContextCreated", "webglErrorFired", "audioContextCreated", "audioContextClosed"];

/** The instrumentation pause that installs the breakpoints of a new realm (not recorded). */
export const SCRIPT_FIRST_STATEMENT = "scriptFirstStatement";

/** `Debugger.paused` data.eventName of an instrumentation pause. */
export const instrumentationPauseName = (name: string): string => `instrumentation:${name}`;

export const MAX_SIGNALS = 500;
const NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){1,7}$/;

export type SignalList = { names: string[]; source: string; hash: string; warnings: string[] };

export const sha256Text = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/**
 * Parse an untrusted signals.json (`$TABCAP_HOME/config/signals.json` or
 * `trace start --apis <file>`): a JSON array of strings, at most 500 entries.
 * Anything else is refused; a string that is not a dotted IDL-style name is
 * skipped with a warning (names the browser lacks are skipped later, per realm).
 */
export function parseSignalList(text: string, source: string): SignalList {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new TabcapError("bad-input", `${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "Write the signal list as a JSON array of names, e.g. [\"Navigator.prototype.userAgent\"].");
  }
  if (!Array.isArray(v)) throw new TabcapError("bad-input", `${source} must be a JSON array of names`, "e.g. [\"Navigator.prototype.userAgent\", \"Screen.prototype.width\"].");
  if (v.length > MAX_SIGNALS) throw new TabcapError("bad-input", `${source} has ${v.length} entries; at most ${MAX_SIGNALS} are allowed`, "Trim the list.");
  const names: string[] = [];
  const warnings: string[] = [];
  for (const [i, x] of v.entries()) {
    if (typeof x !== "string") throw new TabcapError("bad-input", `${source}[${i}] is not a string`, "Every entry is an API name in IDL form, e.g. \"Navigator.prototype.userAgent\".");
    if (!NAME.test(x) || x.length > 200) {
      warnings.push(`skipped unknown name ${JSON.stringify(x.slice(0, 80))} (${source}[${i}]): not an IDL-style name such as Navigator.prototype.userAgent`);
      continue;
    }
    if (!names.includes(x)) names.push(x);
  }
  return { names, source, hash: sha256Text(text), warnings };
}

export function builtinSignalList(): SignalList {
  return { names: defaultSignals(), source: "built-in", hash: sha256Text(DEFAULT_SIGNALS_JSON), warnings: [] };
}

/**
 * Page-side resolver, run in the realm being instrumented (Debugger.evaluateOnCallFrame
 * in the scriptFirstStatement pause, or Runtime.evaluate). Returns a flat array of
 * triples [function | undefined, "get" | "call" | reason, resolved name]. Only own
 * property descriptors are read: no getter runs. In a worker realm a missing
 * `Navigator.*` name falls back to `WorkerNavigator.*` (the worker's interface).
 */
export function resolverExpression(names: readonly string[]): string {
  return `(() => {
  const gopd = Object.getOwnPropertyDescriptor;
  const out = [];
  const names = ${JSON.stringify(names)};
  const resolve = (n) => {
    const segs = n.split(".");
    let o = globalThis;
    for (let i = 0; i < segs.length - 1; i++) {
      const d = gopd(o, segs[i]);
      if (d === undefined || !("value" in d) || d.value === null || (typeof d.value !== "object" && typeof d.value !== "function")) return [undefined, "missing", n];
      o = d.value;
    }
    const d = gopd(o, segs[segs.length - 1]);
    if (d === undefined) return [undefined, "missing", n];
    if (typeof d.get === "function") return [d.get, "get", n];
    if (typeof d.value === "function") return [d.value, "call", n];
    return [undefined, "not-a-function", n];
  };
  for (const n of names) {
    let r = resolve(n);
    if (r[0] === undefined && n.startsWith("Navigator.") && typeof WorkerGlobalScope === "function") r = resolve("Worker" + n);
    out.push(r[0], r[1], r[2]);
  }
  return out;
})()`;
}

/** Values that are never read (docs/04 §4.1 `signal.value`): cookies, storage, form fields. */
export function notRecorded(api: string): boolean {
  return /^Document\.prototype\.cookie$|^CookieStore\.|Storage\b|^Window\.prototype\.(local|session)Storage$|^HTML(Input|TextArea|Select|Option)Element\.prototype\.(value|checked|selected|selectedIndex|files)$|^FormData\./.test(api);
}

/**
 * The value of an API read once per document in tabcap's isolated world
 * (window realms only). Only argument-free reads of the page's singletons that
 * have no side effect on the page: getters of navigator / screen and two
 * argument-free time-zone calls. Calls that need a receiver or arguments
 * (canvas, WebGL, fonts, permissions) and calls that start work in the page
 * (getVoices loads voices and fires voiceschanged) get no value.
 */
export function valueExpression(api: string): string | null {
  const nav = /^Navigator\.prototype\.([A-Za-z]+)$/.exec(api)?.[1];
  if (nav !== undefined) {
    if (nav === "plugins") return "Array.from(navigator.plugins, (p) => p.name)";
    if (nav === "mimeTypes") return "Array.from(navigator.mimeTypes, (m) => m.type)";
    if (nav === "languages") return "Array.from(navigator.languages)";
    if (nav === "userAgentData") return "navigator.userAgentData ? navigator.userAgentData.toJSON() : null";
    if (["userAgent", "platform", "language", "hardwareConcurrency", "deviceMemory", "webdriver", "vendor", "maxTouchPoints"].includes(nav)) return `navigator.${nav}`;
    return null;
  }
  const scr = /^Screen\.prototype\.(width|height|availWidth|availHeight|colorDepth|pixelDepth)$/.exec(api)?.[1];
  if (scr !== undefined) return `screen.${scr}`;
  if (api === "Intl.DateTimeFormat.prototype.resolvedOptions") return "Intl.DateTimeFormat().resolvedOptions()";
  if (api === "Date.prototype.getTimezoneOffset") return "new Date().getTimezoneOffset()";
  return null;
}

/** Inline limit of `signal.value` (docs/04 §4.1): larger values go to a blob. */
export const VALUE_INLINE_MAX = 1024;

/** Canvas / audio data are kept only as their hash (docs/04 §4.1). */
export function hashBulkData(v: unknown): unknown {
  if (typeof v === "string" && /^data:/i.test(v)) return sha256Text(v);
  if (Array.isArray(v)) return v.map(hashBulkData);
  return v;
}
