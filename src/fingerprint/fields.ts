// Signal probe (0.4-G): the values this browser presents, side by side with a
// reference the user captured by hand in their own browser.
// Spec: docs/08 §3 (0.4 line), docs/04 §4.3 (`state what:"env"` with `source`
// and `fields`), docs/07 §5. Oracle: the browser itself — the probe page
// (probe.html) reads every field in the page's own world; references are the
// user's own captures (`tabcap fingerprint serve`, opened by hand), never
// shipped in the repository. Reproduce: `tabcap fingerprint serve`, open the
// printed URL, compare the page's table with `tabcap fingerprint probe --text`.
//
// Analysis only: nothing here changes a value anywhere, and no output says how
// to make two values match (AGENTS.md boundary, owner decision 10-16).

import { createHash } from "node:crypto";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";

export const FINGERPRINT_SCHEMA = "tabcap-fingerprint/0";
export const REF_SCHEMA = "tabcap-fingerprint-ref/0";
/** `state` events written by `fingerprint probe` carry this `source`. */
export const PROBE_SOURCE = "fingerprint-probe";

/**
 * The probe's fixed field list, sorted (code-unit order, as the page sorts).
 * Names are the API names of the trace signal list (src/daemon/trace/signals.ts)
 * in IDL form; one API that yields several values gets its argument in
 * parentheses (`getParameter(VENDOR)`) or the member of its result after `()`
 * (`resolvedOptions().timeZone`). probe.html reads exactly these.
 */
export const FIELD_NAMES: readonly string[] = [
  "Date.prototype.getTimezoneOffset",
  "FontFaceSet.prototype.check",
  "HTMLCanvasElement.prototype.toDataURL",
  "Intl.DateTimeFormat.prototype.resolvedOptions().calendar",
  "Intl.DateTimeFormat.prototype.resolvedOptions().locale",
  "Intl.DateTimeFormat.prototype.resolvedOptions().numberingSystem",
  "Intl.DateTimeFormat.prototype.resolvedOptions().timeZone",
  "Navigator.prototype.deviceMemory",
  "Navigator.prototype.hardwareConcurrency",
  "Navigator.prototype.language",
  "Navigator.prototype.languages",
  "Navigator.prototype.maxTouchPoints",
  "Navigator.prototype.platform",
  "Navigator.prototype.plugins",
  "Navigator.prototype.plugins.length",
  "Navigator.prototype.userAgent",
  "Navigator.prototype.vendor",
  "Navigator.prototype.webdriver",
  "NavigatorUAData.prototype.brands",
  "NavigatorUAData.prototype.getHighEntropyValues(architecture)",
  "NavigatorUAData.prototype.getHighEntropyValues(bitness)",
  "NavigatorUAData.prototype.getHighEntropyValues(formFactors)",
  "NavigatorUAData.prototype.getHighEntropyValues(fullVersionList)",
  "NavigatorUAData.prototype.getHighEntropyValues(model)",
  "NavigatorUAData.prototype.getHighEntropyValues(platformVersion)",
  "NavigatorUAData.prototype.getHighEntropyValues(uaFullVersion)",
  "NavigatorUAData.prototype.getHighEntropyValues(wow64)",
  "NavigatorUAData.prototype.mobile",
  "NavigatorUAData.prototype.platform",
  "OfflineAudioContext.prototype.startRendering",
  "Permissions.prototype.query(geolocation)",
  "Permissions.prototype.query(notifications)",
  "Screen.prototype.availHeight",
  "Screen.prototype.availWidth",
  "Screen.prototype.colorDepth",
  "Screen.prototype.height",
  "Screen.prototype.pixelDepth",
  "Screen.prototype.width",
  "SpeechSynthesis.prototype.getVoices",
  "WebGLRenderingContext.prototype.getParameter(RENDERER)",
  "WebGLRenderingContext.prototype.getParameter(SHADING_LANGUAGE_VERSION)",
  "WebGLRenderingContext.prototype.getParameter(UNMASKED_RENDERER_WEBGL)",
  "WebGLRenderingContext.prototype.getParameter(UNMASKED_VENDOR_WEBGL)",
  "WebGLRenderingContext.prototype.getParameter(VENDOR)",
  "WebGLRenderingContext.prototype.getParameter(VERSION)",
  "WebGLRenderingContext.prototype.getSupportedExtensions",
  "Window.prototype.devicePixelRatio",
  "Window.prototype.matchMedia(prefers-color-scheme)",
  "Window.prototype.matchMedia(prefers-reduced-motion)",
];

/** Inline limit of one field's JSON (bytes); larger values are kept as the sha256 of their JSON text. */
export const VALUE_MAX = 1024;
const ERROR_MAX = 200;
const HASH = /^sha256:[0-9a-f]{64}$/;

export type Scalar = string | number | boolean | null;
export type FieldValue = Scalar | Scalar[];
/** One probe field: a JSON value, a hash (canvas, audio, or a value over 1 KB), or why there is none. */
export type Field = { name: string; value: FieldValue } | { name: string; hash: string } | { name: string; error: string };

export const sha256Text = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function isFieldValue(v: unknown): v is FieldValue {
  return isScalar(v) || (Array.isArray(v) && v.every(isScalar));
}

/** A JSON value as a field: inline up to VALUE_MAX bytes of JSON, else its hash (the page does the same). */
export function capValue(name: string, value: FieldValue): Field {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") <= VALUE_MAX ? { name, value } : { name, hash: sha256Text(json) };
}

export type Normalized = { fields: Field[]; dropped: string[] };

/**
 * Untrusted fields (a page POST, a reference file) → exactly FIELD_NAMES, in
 * order. Unknown names are dropped (listed, at most 20); a known name that is
 * absent gets `error: "not reported"`, a malformed one `error: "malformed field"`.
 */
export function normalizeFields(raw: unknown): Normalized {
  if (!Array.isArray(raw)) throw new TabcapError("bad-input", "fields must be a JSON array", "Post what the probe page sends: {token, fields:[{name, value|hash|error}]}.");
  const known = new Set(FIELD_NAMES);
  const byName = new Map<string, Record<string, unknown>>();
  const dropped: string[] = [];
  for (const e of raw) {
    if (!isRecord(e) || typeof e["name"] !== "string") continue;
    const name = e["name"];
    if (!known.has(name)) {
      if (dropped.length < 20) dropped.push(name.slice(0, 80));
      continue;
    }
    if (!byName.has(name)) byName.set(name, e);
  }
  const fields = FIELD_NAMES.map((name): Field => {
    const e = byName.get(name);
    if (e === undefined) return { name, error: "not reported" };
    const hash = e["hash"];
    if (typeof hash === "string" && HASH.test(hash)) return { name, hash };
    if ("value" in e && isFieldValue(e["value"])) return capValue(name, e["value"]);
    const error = e["error"];
    if (typeof error === "string") return { name, error: error.slice(0, ERROR_MAX) };
    return { name, error: "malformed field" };
  });
  return { fields, dropped };
}

/** Replace text in every string of the fields (the daemon's known-secret substitution). */
export function mapFieldText(fields: readonly Field[], fn: (s: string) => string): Field[] {
  const m = (v: Scalar): Scalar => (typeof v === "string" ? fn(v) : v);
  return fields.map((f): Field => {
    if ("value" in f) return { name: f.name, value: Array.isArray(f.value) ? f.value.map(m) : m(f.value) };
    if ("error" in f) return { name: f.name, error: fn(f.error) };
    return f;
  });
}

// ------------------------------------------------------------- comparison

export type Verdict = "same" | "differs" | "missing" | "extra";
export const VERDICTS: readonly Verdict[] = ["same", "differs", "missing", "extra"];

export type Row = {
  name: string;
  /** This browser's value; a hash is its `sha256:…` string; null when there is none (see `error`). */
  value: FieldValue;
  error?: string;
  ref?: FieldValue;
  refError?: string;
  verdict?: Verdict;
};

export type Summary = Record<Verdict, number>;

type Presented = { kind: "value" | "hash"; json: string } | null;

function presented(f: Field | undefined): Presented {
  if (f === undefined || "error" in f) return null;
  return "hash" in f ? { kind: "hash", json: JSON.stringify(f.hash) } : { kind: "value", json: JSON.stringify(f.value) };
}

const shown = (f: Field | undefined): FieldValue => (f === undefined || "error" in f ? null : "hash" in f ? f.hash : f.value);

/**
 * The verdict of one field. Hashes compare as strings, arrays in order.
 * `missing`: this browser lacks a field the reference has (absent or no
 * value); `extra`: this browser has a field the reference lacks; both
 * lacking reads as `same` (both present nothing). Owner ruling 10-16 (0.4-G2).
 */
export function verdictOf(cur: Field | undefined, ref: Field | undefined): Verdict {
  const a = presented(cur);
  const b = presented(ref);
  if (a === null && b === null) return "same";
  if (a === null) return "missing";
  if (b === null) return "extra";
  return a.kind === b.kind && a.json === b.json ? "same" : "differs";
}

/** Rows for every field of this browser (FIELD_NAMES order), with the reference column and verdicts when a reference is given. */
export function compareFields(cur: readonly Field[], ref: readonly Field[] | null): { fields: Row[]; summary: Summary } {
  const summary: Summary = { same: 0, differs: 0, missing: 0, extra: 0 };
  const curBy = new Map(cur.map((f) => [f.name, f]));
  const refBy = new Map((ref ?? []).map((f) => [f.name, f]));
  const fields = FIELD_NAMES.map((name): Row => {
    const c = curBy.get(name);
    const row: Row = { name, value: shown(c) };
    if (c !== undefined && "error" in c) row.error = c.error;
    else if (c === undefined) row.error = "not reported";
    if (ref === null) return row;
    const r = refBy.get(name);
    row.ref = shown(r);
    if (r !== undefined && "error" in r) row.refError = r.error;
    else if (r === undefined) row.refError = "not reported";
    const v = verdictOf(c, r);
    row.verdict = v;
    summary[v]++;
    return row;
  });
  return { fields, summary };
}

// ------------------------------------------------------------- result

export type RefInfo = { name: string; savedAt: number | null; userAgent: string | null };

export type FingerprintResult = {
  schema: string;
  browser: { version: string | null };
  ref?: RefInfo;
  fields: Row[];
  summary: Summary;
};

export function fingerprintResult(browserVersion: string | null, cur: readonly Field[], ref: { info: RefInfo; fields: readonly Field[] } | null): FingerprintResult {
  const cmp = compareFields(cur, ref === null ? null : ref.fields);
  return { schema: FINGERPRINT_SCHEMA, browser: { version: browserVersion }, ...(ref === null ? {} : { ref: ref.info }), fields: cmp.fields, summary: cmp.summary };
}

/** The userAgent field's value, when it has one (reference metadata). */
export function userAgentOf(fields: readonly Field[]): string | null {
  const f = fields.find((x) => x.name === "Navigator.prototype.userAgent");
  return f !== undefined && "value" in f && typeof f.value === "string" ? f.value : null;
}

// ------------------------------------------------------------- text table

const CELL_MAX = 72;

function cell(v: FieldValue, error: string | undefined): string {
  const s = error !== undefined ? `(${error})` : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
}

/** `--text`: one row per field; with a reference, its column and the verdict. Values only, no advice. */
export function renderFingerprintText(r: unknown): string {
  if (!isRecord(r) || !Array.isArray(r["fields"])) return JSON.stringify(r);
  const rows = r["fields"].filter(isRecord);
  const ref = isRecord(r["ref"]) ? r["ref"] : null;
  const browser = isRecord(r["browser"]) && typeof r["browser"]["version"] === "string" ? r["browser"]["version"] : "?";
  const val = (x: unknown): FieldValue => (isFieldValue(x) ? x : null);
  const errOf = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
  const table = rows.map((x) => {
    const base = [String(x["name"]), cell(val(x["value"]), errOf(x["error"]))];
    return ref === null ? base : [...base, cell(val(x["ref"]), errOf(x["refError"])), String(x["verdict"] ?? "")];
  });
  const head = ref === null ? ["field", "this browser"] : ["field", "this browser", `reference ${String(ref["name"])}`, "verdict"];
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((t) => (t[i] ?? "").length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  const out = [`browser ${browser}` + (ref === null ? "" : `; reference ${String(ref["name"])} saved ${typeof ref["savedAt"] === "number" ? new Date(ref["savedAt"]).toISOString() : "?"}`), "", line(head), ...table.map(line)];
  if (ref !== null && isRecord(r["summary"])) {
    const s = r["summary"];
    out.push("", VERDICTS.map((v) => `${v} ${String(s[v] ?? 0)}`).join(", "));
  }
  return out.join("\n");
}
