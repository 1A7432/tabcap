// `tabcap analyze shape <bundle>` (0.6-G, docs/04 §32, docs/09 §10): the
// response and request shape of every endpoint of a recording, inferred from
// the recorded bodies, as a type tree with presence counts. Values are never
// part of the output: only kinds, formats, field names, presence counts and
// at most MAX_ENUM enum literals of fields whose name the redaction name rule
// (bundle/redact.ts isSensitiveName) does not mark as sensitive.
// Spec (0.6-G brief, owner 2026-10-16):
// - endpoint = method + path template as recon computes it (channelTemplate),
//   grouped across all its recorded exchanges;
// - body = the decode plugin's view when there is an ok one (0.6-B), else the
//   recorded bytes through the decode chain down to a JSON document (gzip /
//   deflate / base64 / jsonp / ndjson / sse; the steps are reported);
// - tree {kind, fields?: {name: {type, optional, samples}}, items?, enum?,
//   format?}; several kinds at one place make a `union` with `variants`;
// - bounds: <= MAX_FIELDS fields per endpoint, depth <= MAX_SHAPE_DEPTH,
//   arrays sampled on their first MAX_ARRAY_ITEMS items.
// Oracle: test/unit/shape.test.ts (inference, union, format and diff tables
// over synthetic bundles), test/e2e/v06g.e2e.test.ts (range s06 /api/list and
// its ?v=2 variant, LIST_V1 / LIST_V2 in test/e2e/site.ts).
// Reproduce: bun test test/unit/shape.test.ts

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { BundleReader } from "../bundle/reader.ts";
import { isSensitiveName } from "../bundle/redact.ts";
import type { RequestEvent } from "../bundle/types.ts";
import { TabcapError } from "../shared/envelope.ts";
import {
  STEP_CAP,
  STEP_NAMES,
  baseMime,
  binaryMagic,
  decodeBase64Strict,
  decompress,
  extractJsonp,
  isBinaryMime,
  isGzipMagic,
  isNdjsonMime,
  isPluginStep,
  isZlibHeader,
  jsonPathKey,
  parseFormPairs,
  parseJsonDoc,
  parseSse,
  splitNdjson,
  utf8,
  MAX_DEPTH as DECODE_DEPTH,
  type StepName,
} from "./decoders.ts";
import { headerValues } from "./diff.ts";
import { wirePrefix } from "./find.ts";
import { channelTemplate } from "./recon.ts";
import { decodedPayload } from "./views.ts";

export const SHAPE_SCHEMA = "tabcap-shape/0";
export const SHAPE_JSON = "shape.json";
export const SHAPE_RECEIPT = `exports/${SHAPE_JSON}`;
/** Fields per endpoint (request query + request body + response, all levels). */
export const MAX_FIELDS = 2000;
export const MAX_SHAPE_DEPTH = 32;
export const MAX_ARRAY_ITEMS = 200;
export const MAX_ENUM = 8;
export const MAX_REFS = 10;
const MAX_ENUM_LITERAL = 64;

export type ShapeKind = "object" | "array" | "string" | "number" | "boolean" | "null" | "union";
export type ShapeFormat = "date" | "datetime" | "int" | "float" | "id" | "url" | "email";

export type ShapeField = { type: Shape; optional: boolean; samples: number };
export type Shape = {
  kind: ShapeKind;
  fields?: Record<string, ShapeField>;
  items?: Shape;
  enum?: string[];
  format?: ShapeFormat;
  /** union only: one shape per kind seen, in KIND_ORDER. */
  variants?: Shape[];
};

export type EndpointShape = {
  key: string;
  method: string;
  template: string;
  exchanges: number;
  /** The first MAX_REFS requests of the endpoint. */
  requests: string[];
  status: (number | null)[];
  /** Decode steps applied on the way to the JSON documents (plugin steps first). */
  decode: StepName[];
  request: { query: Shape | null; body: Shape | null };
  response: Shape | null;
  /** Exchanges that contributed: with a query, with a request body shape, with a JSON response. */
  samples: { query: number; body: number; response: number };
  /** Responses with a body that is not JSON after the decode chain (or binary / missing / too large). */
  notJson: number;
  capped: { fields: boolean; depth: boolean; items: boolean };
};

export type ShapeResult = {
  schema: typeof SHAPE_SCHEMA;
  bundle: string;
  session: string;
  generatedAt: number;
  filter: { request: string | null; template: string | null };
  limits: { fields: number; depth: number; arrayItems: number; enum: number };
  endpoints: EndpointShape[];
  /** Endpoints recorded with nothing to shape (no JSON body, no query, no request body): scripts, images, HTML pages. */
  unshaped: string[];
  warnings: string[];
  /** --write: where exports/shape.json went. */
  written?: string;
};

// ------------------------------------------------------------ formats

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const INT = /^-?\d{1,20}$/;
const FLOAT = /^-?\d{1,20}\.\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@.]{1,63}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
/** recon's long-hex rule (recon.ts LONG_HEX): >= 16 hex digits with at least one digit. */
const LONG_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{16,}$/i;
const ENUM_LITERAL = /^[\p{L}\p{N}_.:-]+$/u;

function validDate(y: string, m: string, d: string): boolean {
  const mm = Number(m);
  const dd = Number(d);
  return Number(y) >= 1 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** The format of one string value, or null. */
export function stringFormat(s: string): ShapeFormat | null {
  const dt = DATETIME.exec(s);
  if (dt !== null && validDate(dt[1] ?? "", dt[2] ?? "", dt[3] ?? "")) return "datetime";
  const d = DATE.exec(s);
  if (d !== null && validDate(d[1] ?? "", d[2] ?? "", d[3] ?? "")) return "date";
  if (INT.test(s)) return "int";
  if (FLOAT.test(s)) return "float";
  if (UUID.test(s) || LONG_HEX.test(s)) return "id";
  if (EMAIL.test(s)) return "email";
  if (URL_RE.test(s)) {
    try {
      new URL(s);
      return "url";
    } catch {
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------ inference

type StrAcc = { n: number; values: Set<string>; overflow: boolean; format: ShapeFormat | null | undefined };
type ObjAcc = { n: number; fields: Map<string, Acc> };
type ArrAcc = { n: number; items: Acc | null };
type Acc = { n: number; obj: ObjAcc | null; arr: ArrAcc | null; str: StrAcc | null; num: { n: number; int: boolean } | null; bool: number; nul: number };
type Budget = { fields: number; cappedFields: boolean; cappedDepth: boolean; cappedItems: boolean };

const newAcc = (): Acc => ({ n: 0, obj: null, arr: null, str: null, num: null, bool: 0, nul: 0 });
const newBudget = (): Budget => ({ fields: 0, cappedFields: false, cappedDepth: false, cappedItems: false });

/** Add one sample value to an accumulator (depth: nesting level of `v`, the root is 0). */
function addValue(acc: Acc, v: unknown, depth: number, budget: Budget): void {
  acc.n++;
  if (v === null) {
    acc.nul++;
    return;
  }
  if (Array.isArray(v)) {
    const a = (acc.arr ??= { n: 0, items: null });
    a.n++;
    if (depth >= MAX_SHAPE_DEPTH) {
      if (v.length > 0) budget.cappedDepth = true;
      return;
    }
    if (v.length > MAX_ARRAY_ITEMS) budget.cappedItems = true;
    const n = Math.min(v.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < n; i++) addValue((a.items ??= newAcc()), v[i], depth + 1, budget);
    return;
  }
  switch (typeof v) {
    case "object": {
      const o = (acc.obj ??= { n: 0, fields: new Map() });
      o.n++;
      const entries = Object.entries(v);
      if (depth >= MAX_SHAPE_DEPTH) {
        if (entries.length > 0) budget.cappedDepth = true;
        return;
      }
      for (const [k, x] of entries) {
        let f = o.fields.get(k);
        if (f === undefined) {
          if (budget.fields >= MAX_FIELDS) {
            budget.cappedFields = true;
            continue;
          }
          budget.fields++;
          f = newAcc();
          o.fields.set(k, f);
        }
        addValue(f, x, depth + 1, budget);
      }
      return;
    }
    case "string": {
      const s = (acc.str ??= { n: 0, values: new Set(), overflow: false, format: undefined });
      s.n++;
      if (!s.overflow) {
        s.values.add(v);
        if (s.values.size > MAX_ENUM) {
          s.overflow = true;
          s.values.clear();
        }
      }
      const f = stringFormat(v);
      s.format = s.format === undefined ? f : s.format === f ? f : null;
      return;
    }
    case "number": {
      const num = (acc.num ??= { n: 0, int: true });
      num.n++;
      if (!Number.isInteger(v)) num.int = false;
      return;
    }
    case "boolean":
      acc.bool++;
      return;
    default:
      return;
  }
}

/**
 * Enum literals of a string node, or undefined. Only when: no format, at most
 * MAX_ENUM distinct values, each a short token (letters, digits, `_ . : -`),
 * every distinct value seen twice on average (samples >= 2 x distinct, so the
 * free values of a small sample are not listed), and the field name is not
 * sensitive by the redaction name rule.
 */
function enumOf(s: StrAcc, name: string | null): string[] | undefined {
  if (s.overflow || s.values.size === 0 || s.format !== null || s.n < 2 * s.values.size) return undefined;
  if (name !== null && isSensitiveName(name)) return undefined;
  const vals = [...s.values];
  if (!vals.every((x) => x.length <= MAX_ENUM_LITERAL && ENUM_LITERAL.test(x))) return undefined;
  return vals.sort();
}

function finish(acc: Acc, name: string | null): Shape {
  const kinds: Shape[] = [];
  if (acc.obj !== null) {
    const o = acc.obj;
    const fields = Object.fromEntries([...o.fields].map(([k, f]): [string, ShapeField] => [k, { type: finish(f, k), optional: f.n < o.n, samples: f.n }]));
    kinds.push({ kind: "object", fields });
  }
  if (acc.arr !== null) kinds.push(acc.arr.items === null ? { kind: "array" } : { kind: "array", items: finish(acc.arr.items, name) });
  if (acc.str !== null) {
    const fmt = acc.str.format ?? null;
    const en = enumOf(acc.str, name);
    kinds.push({ kind: "string", ...(fmt === null ? {} : { format: fmt }), ...(en === undefined ? {} : { enum: en }) });
  }
  if (acc.num !== null) kinds.push({ kind: "number", format: acc.num.int ? "int" : "float" });
  if (acc.bool > 0) kinds.push({ kind: "boolean" });
  if (acc.nul > 0) kinds.push({ kind: "null" });
  const only = kinds[0];
  if (kinds.length === 1 && only !== undefined) return only;
  return { kind: "union", variants: kinds };
}

/** Infer one shape from sample values (pure; the inference table of the unit tests). */
export function inferShape(values: readonly unknown[], name: string | null = null): Shape | null {
  if (values.length === 0) return null;
  const acc = newAcc();
  const budget = newBudget();
  for (const v of values) addValue(acc, v, 0, budget);
  return finish(acc, name);
}

// ------------------------------------------------------------ bodies

/** A JSON document reached from bytes through the decode chain, with the steps applied. */
export function jsonDocOf(bytes: Uint8Array, mime: string | null, prefix: readonly StepName[] = []): { value: unknown; steps: StepName[] } | null {
  return docFromBytes(bytes, baseMime(mime), [...prefix], 0);
}

function docFromBytes(b: Uint8Array, mime: string, steps: StepName[], depth: number): { value: unknown; steps: StepName[] } | null {
  if (b.length > STEP_CAP) return null;
  if (depth < DECODE_DEPTH && isGzipMagic(b)) {
    const out = decompress(b, "gzip");
    if (out !== null) return docFromBytes(out, mime, [...steps, "gzip"], depth + 1);
  }
  if (depth < DECODE_DEPTH && isZlibHeader(b)) {
    const out = decompress(b, "deflate");
    if (out !== null) return docFromBytes(out, mime, [...steps, "deflate"], depth + 1);
  }
  const t = utf8(b);
  if (t === null) return null;
  return docFromText(t.startsWith("﻿") ? t.slice(1) : t, mime, steps, depth);
}

function docFromText(t: string, mime: string, steps: StepName[], depth: number): { value: unknown; steps: StepName[] } | null {
  const doc = parseJsonDoc(t);
  if (doc !== null) return { value: doc.value, steps };
  if (depth >= DECODE_DEPTH) return null;
  const jp = extractJsonp(t);
  if (jp !== null) return { value: jp.value, steps: [...steps, "jsonp", "json"] };
  const lines = splitNdjson(t, isNdjsonMime(mime));
  if (lines !== null) {
    const vals = lines.map((l) => parseJsonDoc(l)?.value);
    return { value: vals, steps: [...steps, "ndjson"] };
  }
  const events = parseSse(t, mime === "text/event-stream");
  if (events !== null) {
    const vals = events.map((e) => parseJsonDoc(e));
    if (vals.every((v) => v !== null)) return { value: vals.map((v) => v?.value), steps: [...steps, "sse"] };
  }
  const b64 = decodeBase64Strict(t.trim());
  if (b64 !== null) return docFromBytes(b64, "", [...steps, "base64"], depth + 1);
  return null;
}

function headerString(h: Record<string, string | string[]>, name: string): string | null {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return typeof v === "string" ? v : v.join(", ");
  return null;
}

type Doc = { value: unknown; steps: StepName[] };

/** The response document of an exchange: "none" without a body, "other" when the body is not JSON. */
function responseDoc(reader: BundleReader, r: RequestEvent, imported: boolean): Doc | "none" | "other" {
  const resp = r.response;
  if (resp === null) return "none";
  const view = decodedPayload(reader, resp.decoded);
  if (view !== null) return jsonDocOf(view.bytes, view.mime, view.prefix) ?? "other";
  const body = resp.body;
  if (body === null) return "none";
  const mime = resp.mimeType ?? headerString(resp.headers, "content-type");
  const binaryByType = r.type === "image" || r.type === "font" || r.type === "media";
  if (body.size > STEP_CAP || isBinaryMime(mime) || (binaryByType && baseMime(mime) !== "image/svg+xml")) return "other";
  const bytes = reader.readBlob(body.blob);
  if (bytes === null || bytes.length > STEP_CAP || binaryMagic(bytes) !== null) return "other";
  return jsonDocOf(bytes, mime, wirePrefix(imported, body.wireEncoding, body.decodeFailed === true)) ?? "other";
}

/** The request body as a value: its JSON document, or its form fields as an object of strings; null otherwise. */
function requestDoc(reader: BundleReader, r: RequestEvent): Doc | null {
  const ctype = headerValues(r.request.headers, "content-type")[0] ?? null;
  const view = decodedPayload(reader, r.request.decoded);
  let bytes: Uint8Array | null = null;
  let mime = ctype;
  let prefix: StepName[] = [];
  if (view !== null) {
    bytes = view.bytes;
    mime = view.mime ?? ctype;
    prefix = view.prefix;
  } else {
    const pd = r.request.postData;
    if (pd === null) return null;
    bytes = "inline" in pd ? new TextEncoder().encode(pd.inline) : reader.readBlob(pd.blob);
  }
  if (bytes === null || bytes.length > STEP_CAP) return null;
  const doc = jsonDocOf(bytes, mime, prefix);
  if (doc !== null) return doc;
  const text = utf8(bytes);
  if (text === null) return null;
  const form = parseFormPairs(text.trim(), baseMime(mime) === "application/x-www-form-urlencoded");
  return form === null ? null : { value: form, steps: prefix };
}

/** Query parameters as an object (a repeated name becomes an array of strings); null without a query. */
function queryDoc(url: string): Record<string, string | string[]> | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const out = new Map<string, string | string[]>();
  for (const [k, v] of u.searchParams) {
    const have = out.get(k);
    out.set(k, have === undefined ? v : Array.isArray(have) ? [...have, v] : [have, v]);
  }
  return out.size === 0 ? null : Object.fromEntries(out);
}

// ------------------------------------------------------------ endpoints

/** `GET /api/list` → {method, template}; a lone path matches nothing (the method is part of the key). */
export function parseTemplate(t: string): { method: string; template: string } {
  const s = t.trim();
  const sp = s.indexOf(" ");
  if (sp <= 0) throw new TabcapError("usage", `--template needs "<METHOD> <path template>", got ${JSON.stringify(t)}`, 'Example: --template "GET /api/list" (the key as `analyze shape` lists it)');
  return { method: s.slice(0, sp).toUpperCase(), template: s.slice(sp + 1).trim() };
}

export const endpointKey = (method: string, template: string): string => `${method} ${template}`;

type EndpointAcc = {
  method: string;
  template: string;
  exchanges: number;
  requests: string[];
  status: (number | null)[];
  steps: Set<StepName>;
  query: Acc;
  body: Acc;
  response: Acc;
  notJson: number;
  budget: Budget;
};

export type ShapeOptions = {
  request?: string | undefined;
  template?: string | undefined;
  now?: number;
};

export function shapeOf(reader: BundleReader, opts: ShapeOptions = {}): ShapeResult {
  if (opts.request !== undefined && opts.template !== undefined) throw new TabcapError("usage", "--request and --template exclude each other", "Give one: --request r-N (one exchange) or --template \"GET /path\" (one endpoint).");
  const warnings: string[] = [];
  if (!reader.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted (shapes cover what was written so far)");
  if (reader.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  const imported = reader.manifest.imported !== null && reader.manifest.imported !== undefined;
  let requests = reader.requests();
  if (opts.request !== undefined) {
    const one = requests.find((r) => r.id === opts.request);
    if (one === undefined) throw new TabcapError("not-found", `no request ${opts.request} in ${reader.dir}`, "List the bundle's requests with `tabcap analyze shape <bundle>` (endpoint `requests`) or `tabcap net list`.");
    requests = [one];
  }
  const want = opts.template === undefined ? null : parseTemplate(opts.template);
  const byKey = new Map<string, EndpointAcc>();
  for (const r of requests) {
    const template = channelTemplate(r.url);
    if (want !== null && (r.method.toUpperCase() !== want.method || template !== want.template)) continue;
    const key = endpointKey(r.method, template);
    let e = byKey.get(key);
    if (e === undefined) {
      e = { method: r.method, template, exchanges: 0, requests: [], status: [], steps: new Set(), query: newAcc(), body: newAcc(), response: newAcc(), notJson: 0, budget: newBudget() };
      byKey.set(key, e);
    }
    e.exchanges++;
    if (e.requests.length < MAX_REFS) e.requests.push(r.id);
    const st = r.response?.status ?? null;
    if (!e.status.includes(st)) e.status.push(st);
    const q = queryDoc(r.url);
    if (q !== null) addValue(e.query, q, 0, e.budget);
    const b = requestDoc(reader, r);
    if (b !== null) {
      addValue(e.body, b.value, 0, e.budget);
      for (const s of b.steps) e.steps.add(s);
    }
    const d = responseDoc(reader, r, imported);
    if (d === "other") e.notJson++;
    else if (d !== "none") {
      addValue(e.response, d.value, 0, e.budget);
      for (const s of d.steps) e.steps.add(s);
    }
  }
  if (want !== null && byKey.size === 0) throw new TabcapError("not-found", `no endpoint ${endpointKey(want.method, want.template)} in ${reader.dir}`, "Run `tabcap analyze shape <bundle>` without --template to list the endpoints (key = method + path template).");
  const endpoints: EndpointShape[] = [];
  const unshaped: string[] = [];
  for (const [key, e] of byKey) {
    // An endpoint without anything to shape (a script, an image, an HTML page without a query) is only named.
    if (e.query.n === 0 && e.body.n === 0 && e.response.n === 0 && opts.request === undefined && want === null) {
      unshaped.push(key);
      continue;
    }
    endpoints.push({
      key,
      method: e.method,
      template: e.template,
      exchanges: e.exchanges,
      requests: e.requests,
      status: [...e.status].sort((a, b) => (a ?? -1) - (b ?? -1)),
      decode: [...[...e.steps].filter((s) => isPluginStep(s)).sort(), ...STEP_NAMES.filter((s) => e.steps.has(s))],
      request: { query: e.query.n === 0 ? null : finish(e.query, null), body: e.body.n === 0 ? null : finish(e.body, null) },
      response: e.response.n === 0 ? null : finish(e.response, null),
      samples: { query: e.query.n, body: e.body.n, response: e.response.n },
      notJson: e.notJson,
      capped: { fields: e.budget.cappedFields, depth: e.budget.cappedDepth, items: e.budget.cappedItems },
    });
    if (e.budget.cappedFields) warnings.push(`${key}: more than ${MAX_FIELDS} fields; the rest were not shaped`);
    if (e.budget.cappedDepth) warnings.push(`${key}: nesting deeper than ${MAX_SHAPE_DEPTH}; deeper levels were not shaped`);
  }
  const m = reader.manifest;
  return {
    schema: SHAPE_SCHEMA,
    bundle: reader.dir,
    session: m.session.name !== "" ? m.session.name : m.id,
    generatedAt: opts.now ?? Date.now(),
    filter: { request: opts.request ?? null, template: want === null ? null : endpointKey(want.method, want.template) },
    limits: { fields: MAX_FIELDS, depth: MAX_SHAPE_DEPTH, arrayItems: MAX_ARRAY_ITEMS, enum: MAX_ENUM },
    endpoints,
    unshaped,
    warnings,
  };
}

export function shape(bundleDir: string, opts: ShapeOptions = {}): ShapeResult {
  return shapeOf(BundleReader.open(bundleDir), opts);
}

/** exports/shape.json (0600; the exports directory 0700), overwriting an earlier one. */
export function writeShape(bundleDir: string, r: ShapeResult): string {
  const dir = join(bundleDir, "exports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, SHAPE_JSON);
  const { written: _w, ...data } = r;
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", 0o600);
  return file;
}

// ------------------------------------------------------------ flat view

export type FlatEntry = { type: string; optional: boolean; enum?: string[]; arrays: string[] };
export type Flat = { entries: Map<string, FlatEntry>; emptyArrays: Set<string> };

/** `string(datetime)`, `number(int)`, `object`; a union joins its variants with `|`. */
export function typeText(s: Shape): string {
  if (s.kind === "union") return (s.variants ?? []).map(typeText).join("|");
  return s.format === undefined ? s.kind : `${s.kind}(${s.format})`;
}

const variantsOf = (s: Shape): Shape[] => (s.kind === "union" ? (s.variants ?? []) : [s]);

function flatten(s: Shape, path: string, optional: boolean, arrays: string[], out: Flat): void {
  const vs = variantsOf(s);
  const en = vs.find((v) => v.kind === "string")?.enum;
  out.entries.set(path, { type: typeText(s), optional, ...(en === undefined ? {} : { enum: en }), arrays });
  for (const v of vs) {
    if (v.kind === "object") for (const [k, f] of Object.entries(v.fields ?? {})) flatten(f.type, jsonPathKey(path, k), f.optional, arrays, out);
    if (v.kind === "array") {
      if (v.items === undefined) out.emptyArrays.add(path);
      else flatten(v.items, `${path}[]`, false, [...arrays, path], out);
    }
  }
}

/**
 * Every place of an endpoint's shapes by path: the response from `$`, query
 * parameters as `query:<name>`, the request body from `body:$` (the input
 * labels of analyze deps).
 */
export function flatOf(e: EndpointShape): Flat {
  const out: Flat = { entries: new Map(), emptyArrays: new Set() };
  const q = e.request.query;
  if (q !== null) for (const v of variantsOf(q)) if (v.kind === "object") for (const [k, f] of Object.entries(v.fields ?? {})) flatten(f.type, `query:${k}`, f.optional, [], out);
  if (e.request.body !== null) flatten(e.request.body, "body:$", false, [], out);
  if (e.response !== null) flatten(e.response, "$", false, [], out);
  return out;
}

// ------------------------------------------------------------ text

function shapeLines(label: string, f: Flat): string[] {
  const out: string[] = [];
  for (const [p, e] of f.entries) out.push(`  ${label}${p}  ${e.type}${e.optional ? "  optional" : ""}${e.enum === undefined ? "" : `  enum ${e.enum.join(",")}`}`);
  return out;
}

export function renderShapeText(r: ShapeResult): string {
  const L: string[] = [`shape of ${r.bundle} (session ${r.session}): ${r.endpoints.length} endpoint(s)`];
  for (const e of r.endpoints) {
    L.push("", `${e.key}  exchanges ${e.exchanges} (${e.requests.join(", ")}${e.exchanges > e.requests.length ? ", …" : ""}), status ${e.status.map((s) => s ?? "-").join(",")}, json ${e.samples.response}${e.notJson > 0 ? `, not json ${e.notJson}` : ""}${e.decode.length > 0 ? `, decode ${e.decode.join(",")}` : ""}`);
    L.push(...shapeLines("", flatOf(e)));
  }
  for (const w of r.warnings) L.push(`warning: ${w}`);
  if (r.written !== undefined) L.push(`wrote ${r.written}`);
  return L.join("\n");
}
