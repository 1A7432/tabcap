// `tabcap replay export-python <bundle> -o <dir>`: an httpx client package
// generated from a recording (docs/03 §3 步骤 6–7, §5 `replay`; Python is the
// client language, docs/03 §8).
// One function per request group (method + path template, the grouping of
// analyze diff). Parameters follow the diff classes when a group has ≥ 2
// samples (constants baked in, session values from a `Session` loaded from a
// storageState file, timestamps made at call time, varying values become
// arguments); a single sample gives constants, except cookies (session) and
// timestamp-shaped values. Signature-like parameters and encrypted request
// bodies are NOT reproduced (docs/03 §6): those functions raise
// NotImplementedError with a TODO marker. Inputs with a sensitive name (the
// `bundle redact` name rule: passw / token / secret / session / sid / auth /
// api key, and sensitive headers) are never written into any generated file,
// in any mode: they become parameters defaulting to TODO (TODO_SECRET) and
// their recorded values stay out of fixtures. Response JSON → TypedDict per group,
// types inferred from every recorded sample (analyze decoders parse).
// Everything read from the bundle is untrusted: names become identifiers by
// a whitelist, values become literals through escaping functions, never by
// pasting text into code.
// Oracle: the generated tests themselves run against `replay serve` of the
// same bundle (recorded bytes); test/unit/replay-python.test.ts snapshots
// client.py for a synthetic bundle and py_compiles the output.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../bundle/reader.ts";
import { isSensitiveHeader, isSensitiveName } from "../bundle/redact.ts";
import type { RequestEvent } from "../bundle/types.ts";
import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import { classifyGroup, groupRequests, pkey, singleSampleParams, type DiffParam, type GroupAcc, type ParamLocation } from "../analyze/diff.ts";
import { decodeBase64Strict, isBinaryMime, jsonPathIndex, jsonPathKey, parseJsonDoc, shannonEntropy, utf8 } from "../analyze/decoders.ts";
import { looksEncrypted } from "../analyze/find.ts";
import { flattenJson, globMatcher, headerJoined, HOP_BY_HOP, replayableRequests, requestBodyBytes } from "./common.ts";
import { DEFAULT_HEADERS, normHeader } from "./check.ts";
import { DepsGraph, type ResolvedInput } from "../analyze/deps.ts";
import { chainOf, dataBearing, type ChainResult } from "../analyze/chain.ts";
import RUNTIME from "../../templates/python/_runtime.py" with { type: "text" };
import CHAIN_RUNTIME from "../../templates/python/_chain.py" with { type: "text" };
import VERIFY from "../../templates/python/_verify.py" with { type: "text" };
import CONFTEST from "../../templates/python/conftest.py" with { type: "text" };
import TEST_REPLAY from "../../templates/python/test_replay.py" with { type: "text" };
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };
import README from "../../templates/python/README.md" with { type: "text" };

export const TODO_MARK = "TODO: computed in the page; see docs/03 §6";
export const TODO_UNRECORDED = "TODO: not in the recording";
/** Chain mode: a sensitive-named input (password, token …) whose recorded value tabcap never writes out. */
export const TODO_SECRET = "TODO: secret input; pass it in (tabcap never writes it)";
export const VERIFY_SCHEMA = "tabcap-verify/0";
export const GENERATED_TYPES = new Set(["xhr", "fetch", "document"]);
const MAX_BYTES_LITERAL = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_TYPED_KEYS = 200;
const MAX_CONSTANTS = 200;
const NOT_SENT = new Set([...HOP_BY_HOP, "host", "content-length", "cookie", "accept-encoding"]);

// ------------------------------------------------------------ Python literals

/** A Python str literal for any JS string (escapes quotes, backslashes, controls, line separators, lone surrogates). */
export function pyStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] ?? "";
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      out += ch + (s[i + 1] ?? "");
      i++;
    } else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029 || c === 0xfeff || (c >= 0xd800 && c <= 0xdfff)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** A Python bytes literal. */
export function pyBytes(b: Uint8Array): string {
  let out = 'b"';
  for (const x of b) {
    if (x === 0x22) out += '\\"';
    else if (x === 0x5c) out += "\\\\";
    else if (x >= 0x20 && x < 0x7f) out += String.fromCharCode(x);
    else out += `\\x${x.toString(16).padStart(2, "0")}`;
  }
  return out + '"';
}

function pyNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'float("inf")' : n < 0 ? 'float("-inf")' : 'float("nan")';
  return String(n);
}

/** A JSON value as a Python literal; `expr` replaces leaves by path. Depth is bounded by the caller. */
function pyJson(v: unknown, path: string, expr: ReadonlyMap<string, string>, indent: string): string {
  const e = expr.get(path);
  if (e !== undefined) return e;
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNumber(v);
  if (typeof v === "string") return pyStr(v);
  const inner = indent + "    ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x, i) => `${inner}${pyJson(x, jsonPathIndex(path, i), expr, inner)},`).join("\n")}\n${indent}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, x]) => `${inner}${pyStr(k)}: ${pyJson(x, jsonPathKey(path, k), expr, inner)},`).join("\n")}\n${indent}}`;
  }
  return "None";
}

function jsonDepth(v: unknown): number {
  let max = 0;
  const stack: { v: unknown; d: number }[] = [{ v, d: 0 }];
  while (stack.length > 0) {
    const t = stack.pop();
    if (t === undefined) break;
    max = Math.max(max, t.d);
    if (max > MAX_JSON_DEPTH) return max;
    if (Array.isArray(t.v)) for (const x of t.v) stack.push({ v: x, d: t.d + 1 });
    else if (typeof t.v === "object" && t.v !== null) for (const x of Object.values(t.v)) stack.push({ v: x, d: t.d + 1 });
  }
  return max;
}

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type _".split(" "),
);
const RESERVED_ARGS = new Set(["session", "base_url", "url", "params", "headers", "content", "response", "body"]);

/** A safe Python identifier from untrusted text (ASCII letters, digits, underscore). */
export function pyIdent(raw: string, fallback = "x"): string {
  let s = raw
    .replace(/\{n\}/g, "n")
    .replace(/\{id\}/g, "id")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (s === "") s = fallback;
  if (/^[0-9]/.test(s)) s = `p_${s}`;
  if (s.length > 60) s = s.slice(0, 60).replace(/_+$/, "");
  if (KEYWORDS.has(s)) s += "_";
  return s;
}

function pascal(s: string): string {
  return s
    .split("_")
    .filter((p) => p !== "")
    .map((p) => (p[0] ?? "").toUpperCase() + p.slice(1))
    .join("");
}

function unique(base: string, taken: Set<string>): string {
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  taken.add(n);
  return n;
}

// ------------------------------------------------------------ response types

type Shape = { prims: Set<string>; obj: { n: number; fields: Map<string, { shape: Shape; seen: number }> } | null; list: Shape | null; listSeen: boolean; any: boolean };

const newShape = (): Shape => ({ prims: new Set(), obj: null, list: null, listSeen: false, any: false });

function addToShape(s: Shape, v: unknown, depth: number): void {
  if (depth > 8) {
    s.any = true;
    return;
  }
  if (v === null) s.prims.add("None");
  else if (typeof v === "boolean") s.prims.add("bool");
  else if (typeof v === "number") s.prims.add(Number.isInteger(v) ? "int" : "float");
  else if (typeof v === "string") s.prims.add("str");
  else if (Array.isArray(v)) {
    s.listSeen = true;
    for (const x of v.slice(0, 200)) {
      s.list ??= newShape();
      addToShape(s.list, x, depth + 1);
    }
  } else if (typeof v === "object") {
    s.obj ??= { n: 0, fields: new Map() };
    s.obj.n++;
    for (const [k, x] of Object.entries(v)) {
      const f = s.obj.fields.get(k) ?? { shape: newShape(), seen: 0 };
      f.seen++;
      addToShape(f.shape, x, depth + 1);
      s.obj.fields.set(k, f);
    }
  } else s.any = true;
}

/** Python type expressions; nested TypedDicts are appended to `defs` before their user. */
function renderShape(s: Shape, name: string, defs: string[], taken: Set<string>): string {
  if (s.any) return "Any";
  const parts: string[] = [];
  const prims = [...s.prims];
  if (prims.includes("int") && prims.includes("float")) prims.splice(prims.indexOf("int"), 1);
  for (const p of ["str", "int", "float", "bool"]) if (prims.includes(p)) parts.push(p);
  if (s.obj !== null) {
    if (s.obj.fields.size > MAX_TYPED_KEYS) parts.push("dict[str, Any]");
    else {
      const td = unique(name, taken);
      const fields = [...s.obj.fields.entries()].map(([k, f]) => {
        const t = renderShape(f.shape, `${td}_${pascal(pyIdent(k, "field"))}`, defs, taken);
        return `    ${pyStr(k)}: ${f.seen < (s.obj?.n ?? 0) ? `NotRequired[${t}]` : t},`;
      });
      defs.push(fields.length === 0 ? `${td} = TypedDict(${pyStr(td)}, {})` : `${td} = TypedDict(\n    ${pyStr(td)},\n    {\n${fields.map((f) => "    " + f).join("\n")}\n    },\n)`);
      parts.push(td);
    }
  }
  if (s.listSeen) parts.push(s.list === null ? "list[Any]" : `list[${renderShape(s.list, `${name}_Item`, defs, taken)}]`);
  if (prims.includes("None")) parts.push("None");
  return parts.length === 0 ? "Any" : parts.join(" | ");
}

// ------------------------------------------------------------ model

/** Where an argument's value sits in a recorded request of the group (verify() reads every chain step's own values). */
type ArgSource = { kind: "param"; location: ParamLocation; name: string } | { kind: "path"; index: number } | { kind: "body" };

/**
 * `sample`: the first recorded sample's value (passed by the generated test); `hasSample` false when absent there.
 * Chain mode: `todo` is the TODO mark of a parameter defaulting to TODO; `secret` withholds its recorded value.
 */
type Arg = { py: string; type: string; optional: boolean; sample: unknown; hasSample: boolean; note: string; source: ArgSource; todo?: string; secret?: boolean };

type ParamPlan = { location: ParamLocation; name: string; cls: DiffParam["class"]; hints: string[]; expr: string; arg: Arg | null; first: string | null; deps?: string };

/** Chain mode input of planFunction: the deps graph and the inputs of the group's first sample by analyze diff key. */
type DepsPlan = { graph: DepsGraph; inputs: Map<string, ResolvedInput>; fnOf: (request: string) => string | null };

export type GeneratedFunction = {
  name: string;
  method: string;
  template: string;
  origin: string;
  samples: number;
  requests: string[];
  todo: string | null;
  args: Arg[];
  params: ParamPlan[];
  responseType: string;
  fixture: string | null;
  /** Reasons the function raises before sending anything (encrypted / unrecorded bodies, 0.3 signatures). */
  upfront: string[];
};

export type ExportResult = {
  out: string;
  bundle: string;
  functions: { name: string; method: string; template: string; samples: number; todo: string | null; args: string[] }[];
  files: string[];
  skipped: { id: string; reason: string }[];
  skippedCount: number;
  /** Chain mode: the target and its steps, else null (0.3 behaviour). */
  chain: { target: string; steps: string[]; todo: number } | null;
  warnings: string[];
};

type Ctx = { reader: BundleReader; cookieNames: Map<string, string>; warnings: string[] };

function firstSampleValue(g: GroupAcc, loc: ParamLocation, name: string): string | null {
  return g.samples[0]?.params.get(pkey(loc, name)) ?? null;
}

function tsCall(v: string, numeric: boolean): string {
  if (numeric) return /^\d{13}/.test(v) ? '_ts_num("ms")' : '_ts_num("s")';
  const m = /^(\d{10}|\d{13})(?:\.(\d+))?$/.exec(v);
  if (m === null) return '_ts("iso")';
  const unit = (m[1] ?? "").length === 13 ? "ms" : "s";
  const digits = (m[2] ?? "").length;
  return digits === 0 ? `_ts("${unit}")` : `_ts("${unit}", ${digits})`;
}

function pyTypeOf(v: unknown): string {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  return "Any";
}

/** Value of a JSON leaf of the first sample (typed), by the path names of analyze diff. */
function jsonLeaves(doc: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const stack: { v: unknown; p: string }[] = [{ v: doc, p: "$" }];
  while (stack.length > 0) {
    const t = stack.pop();
    if (t === undefined) break;
    if (Array.isArray(t.v)) t.v.forEach((x, i) => stack.push({ v: x, p: jsonPathIndex(t.p, i) }));
    else if (typeof t.v === "object" && t.v !== null) for (const [k, x] of Object.entries(t.v)) stack.push({ v: x, p: jsonPathKey(t.p, k) });
    else out.set(t.p, t.v);
  }
  return out;
}

function encryptedField(doc: unknown): string | null {
  for (const [p, v] of jsonLeaves(doc)) {
    if (typeof v !== "string" || v.length < 344) continue;
    const b = decodeBase64Strict(v);
    if (b !== null && looksEncrypted(b.length, shannonEntropy(b))) return p;
  }
  return null;
}

const isSensitive = (loc: ParamLocation, name: string): boolean => isSensitiveName(name) || (loc === "header" && isSensitiveHeader(name));

function depsNote(i: ResolvedInput, fnOf: (request: string) => string | null): string {
  const extra = [...i.hints, ...(i.covaries.length > 0 ? [`varies with ${i.covaries.join(", ")}`] : [])].join("; ");
  const p = i.primary;
  if (p === null) return `${i.class}${extra === "" ? "" : ` (${extra})`}`;
  const fn = p.request === undefined ? null : fnOf(p.request);
  const who = p.request === undefined ? "" : ` of ${fn ?? "?"} (${p.request})`;
  if (p.kind === "response") return `response${who} ${p.path ?? "(text)"}${(p.decode ?? []).length > 0 ? ` [${(p.decode ?? []).join(",")}]` : ""}`;
  if (p.kind === "set-cookie") return `set-cookie ${p.cookie ?? ""}${who}`;
  if (p.kind === "action") return `recorded user input (action @${p.action ?? ""})`;
  return `${p.kind}${extra === "" ? "" : ` (${extra})`}`;
}

function planFunction(
  key: string,
  g: GroupAcc,
  params: DiffParam[],
  ctx: Ctx,
  typeNames: Set<string>,
  byRef: Map<string, RequestEvent>,
  dp: DepsPlan | null,
  name: string,
): { fn: GeneratedFunction; code: string; types: string[] } {
  const first = byRef.get(g.samples[0]?.ref ?? "");
  if (first === undefined) throw new TabcapError("internal", `group ${key} lost its first request`, "This is a bug.");
  const u = new URL(first.url);
  const argNames = new Set<string>(RESERVED_ARGS);
  const args: Arg[] = [];
  const plans: ParamPlan[] = [];
  const todo: string[] = [];
  const unrecorded: string[] = [];

  const todoArgs: { arg: Arg; why: string }[] = [];
  const mkArg = (raw: string, loc: ParamLocation | "path", type: string, optional: boolean, sample: unknown, hasSample: boolean, note: string, source: ArgSource): Arg => {
    let py = pyIdent(raw, loc);
    if (argNames.has(py)) py = pyIdent(`${loc}_${raw}`, loc);
    py = unique(py, argNames);
    const a: Arg = { py, type, optional, sample, hasSample, note, source };
    args.push(a);
    return a;
  };

  const firstBody = requestBodyBytes(first, ctx.reader);
  const ctype = (headerJoined(first.request.headers, "content-type") ?? "").toLowerCase();
  const bodyText = "bytes" in firstBody ? utf8(firstBody.bytes) : null;
  const bodyDoc = bodyText !== null && (ctype.includes("json") || /^\s*[[{]/.test(bodyText)) ? parseJsonDoc(bodyText) : null;
  const leaves = bodyDoc === null ? new Map<string, unknown>() : jsonLeaves(bodyDoc.value);

  for (const p of params) {
    const v0 = firstSampleValue(g, p.location, p.name);
    const jsonSample = p.location === "json" ? (leaves.has(p.name) ? leaves.get(p.name) : null) : v0;
    const numeric = p.location === "json" && typeof jsonSample === "number";
    const lit = p.location === "json" ? pyJson(jsonSample ?? null, "$", new Map(), "") : v0 === null ? "None" : pyStr(v0);
    let expr = lit;
    let arg: Arg | null = null;
    const src: ArgSource = { kind: "param", location: p.location, name: p.name };
    const di = dp?.inputs.get(pkey(p.location, p.name));
    if (dp !== null && di !== undefined && p.location === "cookie") {
      // Chain mode: cookies travel in the Session's jar (set-cookie of an earlier step, or a storageState for unrecorded ones).
      plans.push({ location: p.location, name: p.name, cls: p.class, hints: [...p.hints], expr: "", arg: null, first: v0, deps: depsNote(di, dp.fnOf) });
      continue;
    }
    if (dp !== null && di !== undefined) {
      // Chain mode: the deps graph decides where it has something to say.
      const sensitive = isSensitive(p.location, p.name);
      const note = depsNote(di, dp.fnOf);
      const sig = p.hints.includes("looks-signature") ? " looks like a signature;" : ":";
      let decided = true;
      if (di.class === "computed-in-page") {
        arg = mkArg(p.name, p.location, "Any", true, jsonSample, v0 !== null, `computed in the page: ${note}`, src);
        arg.todo = TODO_MARK;
        todoArgs.push({ arg, why: `${p.location} ${p.name}${sig} ${note}` });
      } else if (di.class === "response" || di.class === "action") {
        arg = mkArg(p.name, p.location, p.location === "json" ? pyTypeOf(jsonSample) : "str", false, jsonSample, v0 !== null, note, src);
      } else if (di.class === "set-cookie" && di.primary?.cookie !== undefined) {
        expr = numeric ? lit : `session.cookie(${pyStr(di.primary.cookie)}, ${lit})`;
      } else if (sensitive) {
        // a password / token the recording carried as a constant is still not written out
        arg = mkArg(p.name, p.location, "Any", true, jsonSample, v0 !== null, `${note}; secret input`, src);
      } else decided = false;
      if (decided) {
        if (arg !== null) {
          expr = arg.py;
          if (sensitive) {
            arg.secret = true;
            if (arg.todo === undefined) {
              arg.todo = TODO_SECRET;
              arg.optional = true;
              todoArgs.push({ arg, why: `${p.location} ${p.name}: secret input (${note})` });
            }
          }
        }
        plans.push({ location: p.location, name: p.name, cls: "varying", hints: [...p.hints], expr, arg, first: v0, deps: note });
        continue;
      }
    }
    if (p.hints.includes("looks-signature")) todo.push(`${p.location} ${p.name} looks like a signature`);
    if (p.class === "constant") expr = lit;
    else if (p.class === "timestamp") {
      arg = mkArg(p.name, p.location, numeric ? "int | None" : "str | None", true, jsonSample, v0 !== null, "timestamp; made at call time when None", src);
      expr = `${arg.py} if ${arg.py} is not None else ${tsCall(v0 ?? "", numeric)}`;
    } else if (p.class === "session" || p.class === "constant-or-session") {
      if (p.location === "cookie") expr = "";
      else {
        const cookie = v0 === null ? undefined : ctx.cookieNames.get(v0);
        expr = cookie !== undefined ? `session.cookie(${pyStr(cookie)}, ${lit})` : `session.value(${pyStr(`${p.location}:${p.name}`)}, ${lit})`;
        if (numeric) expr = lit; // a numeric session value stays the recorded constant
      }
    } else {
      const optional = v0 === null;
      arg = mkArg(p.name, p.location, p.location === "json" ? pyTypeOf(jsonSample) : "str", optional, jsonSample, v0 !== null, optional ? "varying; absent in the first sample" : "varying", src);
      if (optional) arg.type = `${arg.type} | None`;
      expr = arg.py;
    }
    let cls = p.class;
    if (p.location !== "cookie" && isSensitive(p.location, p.name)) {
      // A sensitive recorded value (password, token …) is never written out, in any mode: the caller passes it.
      const fresh = arg === null;
      if (arg === null) {
        arg = mkArg(p.name, p.location, "Any", true, jsonSample, v0 !== null, "secret input", src);
        expr = arg.py;
        cls = "varying";
      }
      arg.secret = true;
      if (arg.todo === undefined && (fresh || !arg.optional)) {
        arg.todo = TODO_SECRET;
        arg.optional = true;
        todoArgs.push({ arg, why: `${p.location} ${p.name}: secret input` });
      }
    }
    plans.push({ location: p.location, name: p.name, cls, hints: [...p.hints], expr, arg, first: v0 });
  }
  const exprOf = (loc: ParamLocation, n: string) => plans.find((p) => p.location === loc && p.name === n)?.expr;

  // path: template placeholders that differ between samples become arguments
  const segs = u.pathname.split("/");
  const tsegs = g.template.split("/");
  const pathParts: string[] = [];
  let literal = "";
  segs.forEach((seg, i) => {
    const prefix = i === 0 ? "" : "/";
    const tseg = tsegs[i] ?? seg;
    const values = new Set(g.samples.map((s) => byRef.get(s.ref)).map((r) => (r === undefined ? seg : (safePath(r.url).split("/")[i] ?? seg))));
    if ((tseg === "{n}" || tseg === "{id}") && values.size > 1) {
      if (literal + prefix !== "") pathParts.push(pyStr(literal + prefix));
      literal = "";
      const a = mkArg(`path_${i}`, "path", "str", false, seg, true, "path segment", { kind: "path", index: i });
      pathParts.push(a.py);
    } else literal += prefix + seg;
  });
  if (literal !== "" || pathParts.length === 0) pathParts.push(pyStr(literal));

  // query: first sample order, then parameters only later samples carried
  const qNames: string[] = [];
  const qSeen = new Map<string, number>();
  for (const [k] of new URLSearchParams(u.search)) {
    const i = qSeen.get(k) ?? 0;
    qSeen.set(k, i + 1);
    qNames.push(i === 0 ? k : `${k}[${i}]`);
  }
  for (const p of plans) if (p.location === "query" && !qNames.includes(p.name)) qNames.push(p.name);
  const query = qNames.map((n) => `(${pyStr(n.replace(/\[\d+\]$/, ""))}, ${exprOf("query", n) ?? "None"})`);

  // headers: what the client sends (cookies come from the session's jar)
  const hNames = Object.keys(first.request.headers).filter((h) => !h.startsWith(":") && !NOT_SENT.has(h.toLowerCase()));
  for (const p of plans) if (p.location === "header" && !hNames.includes(p.name) && !NOT_SENT.has(p.name)) hNames.push(p.name);
  const headers = hNames.map((h) => `(${pyStr(h)}, ${exprOf("header", h) ?? pyStr(headerJoined(first.request.headers, h) ?? "")})`);

  // body
  let content = "None";
  const bodyLines: string[] = [];
  if ("missing" in firstBody) unrecorded.push(`the request body was not recorded (${firstBody.missing}); record the call again`);
  else if (firstBody.bytes.length > 0) {
    const bodyParams = plans.filter((p) => p.location === "json" || p.location === "form");
    const allConstant = bodyParams.every((p) => p.cls === "constant");
    const sampleHashes = new Set(g.samples.map((s) => byRef.get(s.ref)).map((r) => (r === undefined ? "" : bodyHash(r, ctx))));
    const opaque = bodyDoc === null && !(ctype.includes("x-www-form-urlencoded") || bodyParams.some((p) => p.location === "form"));
    if (bodyDoc !== null) {
      const enc = encryptedField(bodyDoc.value);
      if (enc !== null) todo.push(`request body field ${enc} looks encrypted`);
    } else if (opaque && looksEncrypted(firstBody.bytes.length, shannonEntropy(firstBody.bytes))) todo.push("the request body looks encrypted");
    if (opaque && sampleHashes.size > 1) {
      const a = mkArg("request_body", "form", "bytes", false, { $bytes_b64: Buffer.from(firstBody.bytes).toString("base64") }, true, "opaque body that differs between samples", { kind: "body" });
      content = a.py;
    } else if (allConstant || opaque) {
      content = firstBody.bytes.length <= MAX_BYTES_LITERAL ? pyBytes(firstBody.bytes) : "None";
      if (firstBody.bytes.length > MAX_BYTES_LITERAL) unrecorded.push(`constant request body over ${MAX_BYTES_LITERAL} bytes is not inlined`);
    } else if (bodyDoc !== null) {
      if (jsonDepth(bodyDoc.value) > MAX_JSON_DEPTH) unrecorded.push(`JSON request body nested deeper than ${MAX_JSON_DEPTH} is not generated`);
      else {
        const m = new Map<string, string>();
        for (const p of plans) if (p.location === "json" && p.expr !== "") m.set(p.name, p.expr);
        bodyLines.push(`    body = ${pyJson(bodyDoc.value, "$", m, "    ")}`);
        content = "_json_bytes(body)";
      }
    } else {
      const pairs: string[] = [];
      const seen = new Map<string, number>();
      for (const [k, v] of new URLSearchParams((bodyText ?? "").trim())) {
        const i = seen.get(k) ?? 0;
        seen.set(k, i + 1);
        const n = i === 0 ? k : `${k}[${i}]`;
        pairs.push(`(${pyStr(k)}, ${exprOf("form", n) ?? pyStr(v)})`);
      }
      for (const p of plans) if (p.location === "form" && p.first === null) pairs.push(`(${pyStr(p.name.replace(/\[\d+\]$/, ""))}, ${p.expr})`);
      content = `_form_bytes([${pairs.join(", ")}])`;
    }
  }

  // response type and fixture
  const shape = newShape();
  let jsonSamples = 0;
  for (const s of g.samples) {
    const r = byRef.get(s.ref);
    const body = r === undefined ? null : responseJson(r, ctx);
    if (body !== null) {
      addToShape(shape, body, 0);
      jsonSamples++;
    }
  }
  const typeBase = `${pascal(name)}Response`;
  const typeDefs: string[] = [];
  let responseType = "Any";
  if (jsonSamples > 0) {
    const t = renderShape(shape, typeBase, typeDefs, typeNames);
    if (typeDefs.some((d) => d.startsWith(`${t} = TypedDict(`))) responseType = t;
    else {
      responseType = unique(typeBase, typeNames);
      typeDefs.push(`${responseType} = ${t}`);
    }
  }

  // code
  const sig = [
    "session: Session",
    ...(args.length > 0 ? ["*"] : []),
    ...args.filter((a) => !a.optional).map((a) => `${a.py}: ${a.type}`),
    ...args.filter((a) => a.optional).map((a) => (a.todo !== undefined ? `${a.py}: Any = TODO` : `${a.py}: ${a.type} = None`)),
  ];
  if (args.length === 0) sig.push("*");
  sig.push("base_url: str | None = None");
  const summary = `${g.method} ${docSafe(g.template)} (${g.samples.length} sample(s): ${g.samples.slice(0, 5).map((s) => docSafe(s.ref)).join(", ")}${g.samples.length > 5 ? ", …" : ""}).`;
  const paramDoc = plans
    .filter((p) => p.cls !== "constant" || p.deps !== undefined)
    .map((p) => `    ${p.location} ${docSafe(p.name)}: ${p.deps !== undefined ? docSafe(p.deps) : `${p.cls}${p.hints.length > 0 ? ` (${p.hints.join(", ")})` : ""}`}${p.arg ? ` -> ${p.arg.py}` : ""}`);
  const doc = paramDoc.length === 0 ? [`    """${summary}"""`] : [`    """${summary}`, "", ...paramDoc, `    """`];
  const lines = [`def ${name}(${sig.join(", ")}) -> Reply[${responseType}]:`, ...doc];
  if (todo.length > 0 || unrecorded.length > 0) {
    const mark = todo.length > 0 ? TODO_MARK : TODO_UNRECORDED;
    const why = [...todo, ...unrecorded];
    lines.push(`    # ${mark}`);
    for (const t of why) lines.push(`    #   - ${docSafe(t)}`);
    lines.push(`    raise NotImplementedError(${pyStr(`${mark} (${why.join("; ")})`)})`);
  } else {
    for (const mark of [TODO_MARK, TODO_SECRET]) {
      const these = todoArgs.filter((t) => t.arg.todo === mark);
      if (these.length === 0) continue;
      lines.push(`    # ${mark}`);
      for (const t of these) lines.push(`    #   - ${docSafe(t.why)}`);
      lines.push(`    _need(${pyStr(mark)}, ${these.map((t) => `${t.arg.py}=${t.arg.py}`).join(", ")})`);
    }
    lines.push(
      ...bodyLines,
      `    url = (base_url or ${pyStr(u.origin)}) + ${pathParts.join(" + ")}`,
      `    params: list[tuple[str, str | None]] = [${query.join(", ")}]`,
      ...(headers.length === 0 ? [`    headers: list[tuple[str, str | None]] = []`] : [`    headers: list[tuple[str, str | None]] = [`, ...headers.map((h) => `        ${h},`), `    ]`]),
      `    return Reply(_send(session, ${pyStr(g.method)}, url, params, headers, ${content}))`,
    );
  }
  const fn: GeneratedFunction = {
    name,
    method: g.method,
    template: g.template,
    origin: u.origin,
    samples: g.samples.length,
    requests: g.samples.map((s) => s.ref),
    todo: todo.length > 0 || unrecorded.length > 0 || todoArgs.length > 0 ? [...todo, ...unrecorded, ...todoArgs.map((t) => t.why)].join("; ") : null,
    args,
    params: plans,
    responseType,
    fixture: null,
    upfront: [...todo, ...unrecorded],
  };
  return { fn, code: lines.join("\n"), types: typeDefs };
}

function docSafe(s: string): string {
  return s.replace(/[\\"]/g, "_").replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function bodyHash(r: RequestEvent, ctx: Ctx): string {
  const b = requestBodyBytes(r, ctx.reader);
  return "bytes" in b ? sha256Hex(b.bytes) : "missing";
}

function responseBytes(r: RequestEvent, ctx: Ctx): Uint8Array | null {
  const b = r.response?.body;
  return b ? ctx.reader.readBlob(b.blob) : null;
}

function responseJson(r: RequestEvent, ctx: Ctx): unknown {
  const bytes = responseBytes(r, ctx);
  if (bytes === null || isBinaryMime(r.response?.mimeType)) return null;
  const t = utf8(bytes);
  const d = t === null ? null : parseJsonDoc(t);
  return d === null ? null : d.value;
}

// ------------------------------------------------------------ fixtures

type CaseBody =
  | { kind: "json"; file: string | null; keys: string[] | null; exactKeys: boolean; constants: [string, unknown][] }
  | { kind: "text" | "binary"; file: string | null; sha256: string | null }
  | { kind: "missing"; reason: string };

function fixtureCase(fn: GeneratedFunction, g: GroupAcc, ctx: Ctx, byRef: Map<string, RequestEvent>, fixturesDir: string, files: string[]): Record<string, unknown> {
  const reqs = g.samples.map((s) => byRef.get(s.ref)).filter((r): r is RequestEvent => r !== undefined);
  const first = reqs[0];
  const args: Record<string, unknown> = {};
  for (const a of fn.args) if (a.hasSample && a.secret !== true) args[a.py] = a.sample;
  const unfilled = fn.args.filter((a) => a.todo !== undefined && !(a.py in args)).map((a) => `${a.py}: ${a.todo ?? ""}`);
  const todo = fn.upfront.length > 0 || unfilled.length > 0 ? [...fn.upfront, ...unfilled].join("; ") : null;
  const statuses = [...new Set(reqs.map((r) => r.response?.status).filter((s): s is number => typeof s === "number"))];
  let body: CaseBody = { kind: "missing", reason: first?.response?.bodyMissing?.reason ?? "no body" };
  const firstBytes = first === undefined ? null : responseBytes(first, ctx);
  if (firstBytes !== null && first !== undefined) {
    const json = responseJson(first, ctx);
    const text = utf8(firstBytes);
    const ext = json !== null ? "json" : text !== null && !isBinaryMime(first.response?.mimeType) ? "txt" : "bin";
    const file = `${fn.name}.${ext}`;
    writeFileSync(join(fixturesDir, file), firstBytes);
    files.push(`fixtures/${file}`);
    if (json !== null) {
      const all = reqs.map((r) => responseJson(r, ctx));
      const flats = all.map((v) => (v === null ? null : flattenJson(v)));
      let constants: [string, unknown][] = [];
      const f0 = flats[0];
      if (f0 && flats.every((f) => f !== null)) {
        for (const [p, v] of f0) {
          if (constants.length >= MAX_CONSTANTS) break;
          if (flats.every((f) => f?.get(p) === v)) constants.push([p, v === "[]" ? [] : v === "{}" ? {} : JSON.parse(v)]);
        }
      }
      constants = constants.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const objs = all.filter(isObj);
      const keys = objs.length === all.length && objs.length > 0 ? Object.keys(objs[0] ?? {}).filter((k) => objs.every((o) => k in o)) : null;
      body = { kind: "json", file, keys, exactKeys: reqs.length === 1, constants };
    } else {
      const hashes = new Set(reqs.map((r) => {
        const b = responseBytes(r, ctx);
        return b === null ? "" : sha256Hex(b);
      }));
      body = { kind: ext === "bin" ? "binary" : "text", file, sha256: hashes.size === 1 ? sha256Hex(firstBytes) : null };
    }
  }
  return { function: fn.name, request: fn.requests[0] ?? null, samples: fn.samples, args, status: statuses, todo, body };
}

// ------------------------------------------------------------ export

// ------------------------------------------------------------ verify (chain mode)

/** Reasons a recorded body is empty by design (replay check treats them so too). */
const EMPTY_BY_DESIGN = new Set(["no-content", "not-modified", "redirect"]);
const MAX_VERIFY_FIELDS = 20_000;

type VerifyBody =
  | { kind: "json"; fields: [string, unknown][] }
  | { kind: "text" | "binary"; sha256: string; size: number }
  | { kind: "empty" }
  | { kind: "unverified"; reason: string };

type VerifyStep = {
  request: string;
  method: string;
  path: string;
  function: string | null;
  skip: string | null;
  args: Record<string, unknown>;
  derived: Record<string, { from: string; path: string; as: "text" | "json" }>;
  notes: string[];
  expect: { status: number | null; headers: Record<string, string>; body: VerifyBody };
};

/** What the recording answered, in the terms of replay check (status, selected headers, body per path / hash). */
function expectOf(r: RequestEvent, ctx: Ctx): VerifyStep["expect"] {
  const resp = r.response;
  const headers: Record<string, string> = {};
  for (const name of DEFAULT_HEADERS) {
    const v = resp === null ? null : headerJoined(resp.headers, name);
    if (v !== null) headers[name] = normHeader(name, v, r.url);
  }
  let body: VerifyBody = { kind: "empty" };
  if (resp?.body) {
    const bytes = ctx.reader.readBlob(resp.body.blob);
    const mime = resp.mimeType ?? headerJoined(resp.headers, "content-type");
    const text = bytes === null || isBinaryMime(mime) ? null : utf8(bytes);
    const doc = text === null ? null : parseJsonDoc(text);
    const flat = doc === null ? null : flattenJson(doc.value);
    if (bytes === null) body = { kind: "unverified", reason: "recorded body blob is missing" };
    else if (flat !== null && flat.size <= MAX_VERIFY_FIELDS) body = { kind: "json", fields: [...flat].map(([p, v]): [string, unknown] => [p, v === "[]" ? [] : v === "{}" ? {} : JSON.parse(v)]) };
    else body = { kind: text !== null ? "text" : "binary", sha256: sha256Hex(bytes), size: bytes.length };
  } else if (resp?.bodyMissing && !EMPTY_BY_DESIGN.has(resp.bodyMissing.reason)) body = { kind: "unverified", reason: resp.bodyMissing.reason };
  return { status: resp?.status ?? null, headers, body };
}

/** The value of an argument in one recorded request of its group; `has` false when that request lacks it. */
function argValueIn(a: Arg, r: RequestEvent, params: ReadonlyMap<string, string>, ctx: Ctx): { has: boolean; value: unknown } {
  const src = a.source;
  if (src.kind === "path") {
    const seg = safePath(r.url).split("/")[src.index];
    return seg === undefined ? { has: false, value: null } : { has: true, value: seg };
  }
  const body = requestBodyBytes(r, ctx.reader);
  if (src.kind === "body") return "bytes" in body ? { has: true, value: { $bytes_b64: Buffer.from(body.bytes).toString("base64") } } : { has: false, value: null };
  if (src.location === "json") {
    const text = "bytes" in body ? utf8(body.bytes) : null;
    const doc = text === null ? null : parseJsonDoc(text);
    const leaves = doc === null ? new Map<string, unknown>() : jsonLeaves(doc.value);
    return leaves.has(src.name) ? { has: true, value: leaves.get(src.name) } : { has: false, value: null };
  }
  const v = params.get(pkey(src.location, src.name));
  return v === undefined ? { has: false, value: null } : { has: true, value: v };
}

/** verify_expected.json: every chain step with its recorded arguments, the ones taken from earlier replies, and the recorded answer. */
function verifyExpected(
  chain: ChainResult,
  graph: DepsGraph,
  planned: readonly { fn: GeneratedFunction; group: GroupAcc }[],
  ctx: Ctx,
  byRef: ReadonlyMap<string, RequestEvent>,
  skipped: readonly { id: string; reason: string }[],
): Record<string, unknown> {
  const inChain = new Set(chain.steps.map((s) => s.request));
  const steps: VerifyStep[] = [];
  for (const s of chain.steps) {
    const r = byRef.get(s.request) ?? graph.byId.get(s.request);
    if (r === undefined) continue;
    const p = planned.find((x) => x.group.samples.some((smp) => smp.ref === s.request));
    const base = { request: r.id, method: r.method, path: (() => { try { const u = new URL(r.url); return u.pathname + u.search; } catch { return r.url; } })() };
    if (p === undefined) {
      const why = skipped.find((x) => x.id === r.id)?.reason ?? "not generated";
      steps.push({ ...base, function: null, skip: why, args: {}, derived: {}, notes: [], expect: expectOf(r, ctx) });
      continue;
    }
    const params = p.group.samples.find((smp) => smp.ref === r.id)?.params ?? new Map<string, string>();
    const inputs = graph.inputs(r.id);
    const args: Record<string, unknown> = {};
    const derived: VerifyStep["derived"] = {};
    const notes: string[] = [];
    for (const a of p.fn.args) {
      if (a.source.kind === "param") {
        const k = pkey(a.source.location, a.source.name);
        const di = inputs.find((i) => i.key === k);
        if (di !== undefined) {
          const rp = graph.root(r.id, di).input.primary;
          if (rp?.kind === "response" && rp.request !== undefined) {
            const simple = rp.match === "exact" && rp.path !== undefined && !rp.path.includes(" -> ") && (rp.decode ?? []).every((d) => d === "json-unescape");
            if (simple && inChain.has(rp.request) && rp.path !== undefined) {
              derived[a.py] = { from: rp.request, path: rp.path, as: a.source.location === "json" ? "json" : "text" };
              continue;
            }
            notes.push(`${a.py}: from ${rp.request} response ${rp.path ?? "(text)"} not derived automatically (${simple ? "producer not in the chain" : "decoded or embedded value"}); the recorded value is used`);
          }
        }
      }
      const v = argValueIn(a, r, params, ctx);
      if (!v.has) continue;
      args[a.py] = a.secret === true ? `<secret:${p.fn.name}.${a.py}>` : v.value;
    }
    steps.push({ ...base, function: p.fn.name, skip: null, args, derived, notes, expect: expectOf(r, ctx) });
  }
  const redacted = ctx.reader.manifest.redaction !== null;
  return {
    schema: VERIFY_SCHEMA,
    bundle: ctx.reader.manifest.id,
    target: chain.target,
    redacted,
    note: redacted
      ? "--redacted: the bundle is a redacted copy (tabcap bundle redact); recorded values are «r:…» placeholders, so verify passes only against replay serve of this same copy."
      : "Recorded values are real data of the recording (file mode 0600; do not commit). Sensitive-named inputs are <secret:…> placeholders read from TABCAP_SECRET_* at run time. To share, export from a redacted copy: tabcap bundle redact <bundle> <copy> (--redacted note).",
    headers: [...DEFAULT_HEADERS],
    todo: chain.todo,
    steps,
  };
}

function chainReadme(chain: ChainResult, redacted: boolean): string {
  const todo = chain.todo.map((t) => `- \`${t.request}\` ${t.location} \`${docSafe(t.path ?? t.name).replace(/`/g, "_")}\`：${t.class}${t.hints.length > 0 ? `（${t.hints.join(", ")}）` : ""}${t.covaries.length > 0 ? `，与 ${t.covaries.map((c) => docSafe(c).replace(/`/g, "_")).join(", ")} 同变` : ""}${t.via === undefined ? "" : `，经 \`${t.via}\` 带过来`}`);
  return [
    "",
    "",
    "## 动作链、TODO 与 `verify()`",
    "",
    `这份客户端按动作链生成（\`tabcap analyze deps\` / \`analyze chain\`）：目标 \`${chain.target}\`，${chain.steps.length} 步（${chain.steps.map((s) => `\`${s.request}\``).join(" → ")}）。录制里找不到来源的输入（\`computed-in-page\`）是默认值为 \`TODO\` 的参数；来自前一步响应的值是参数，由调用方或 \`verify()\` 从那一步的回复里取；cookie 由 \`Session\` 的 cookie jar 带。`,
    "",
    "调用方的 agent 按这个顺序做：",
    "",
    "1. 读 `client.py` 里每个 `# TODO` 注释：写着 hints（`looks-signature`、`looks-random` …）和同变的输入（`varies with …`）。",
    "2. 在本目录新建 `todo_inputs.py`，实现 `def fill(function: str, args: dict) -> dict`：按页面里的算法算出 TODO 参数，返回 `{参数名: 值}`。不要改 `client.py`，重新生成会覆盖。",
    "3. 起回放服务器 `tabcap replay serve <证据包> --port 4500`，跑 `python client.py verify --base-url http://127.0.0.1:4500`：逐步重放动作链，每步按 `tabcap replay check` 的比法和录制比（状态码、选定响应头、正文逐路径），打印每步 pass / fail，有失败退出码非 0。没有 `todo_inputs.py` 时用录到的值；有了它，算出的值必须和录到的一致才过，这就是填空对不对的检验。",
    "4. 之后才对真实站点跑（`--base-url` 填源；账号风险自己想清楚，docs/03 §4）。",
    "",
    "名字像密码、token 的输入（与 `tabcap bundle redact` 同一条规则）不写进任何生成的文件：`verify_expected.json` 里是 `<secret:函数.参数>`，运行时从环境变量 `TABCAP_SECRET_<函数_参数，大写>` 取。",
    "",
    redacted
      ? "`verify_expected.json`（0600）来自脱敏副本（--redacted）：值是 «r:…» 占位符，只能对同一个脱敏副本的 `replay serve` 验证。"
      : "`verify_expected.json`（0600）含录到的响应值，是真实数据，不要提交；要分享先 `tabcap bundle redact <证据包> <副本>`，从副本导出（--redacted）。",
    "",
    "待填的 TODO：",
    "",
    todo.length === 0 ? "（无。）" : todo.map((l) => l.replace(/[\r\n]/g, " ")).join("\n"),
  ].join("\n");
}

/** `chain`: true / false forces chain mode on / off; undefined = on when the deps graph links a request to an earlier response. */
export type ExportOptions = { bundle: string; out: string; include?: string | undefined; exclude?: string | undefined; chain?: boolean | undefined };

/** `todoRuntime`: the TODO sentinel and `_need` (chain mode, or any secret TODO parameter); `chainMode` adds verify(). */
export function generateClientSource(fns: { code: string; types: string[] }[], header: string[], chainMode = false, todoRuntime = chainMode): string {
  return [
    ...header,
    RUNTIME.trimEnd(),
    ...(todoRuntime ? [CHAIN_RUNTIME.trimEnd()] : []),
    "",
    "",
    "# ---------------------------------------------------------------- response shapes (inferred from the recording; illustrative)",
    "",
    ...fns.flatMap((f) => (f.types.length === 0 ? [] : [...f.types, ""])),
    "",
    "# ---------------------------------------------------------------- calls",
    "",
    ...fns.flatMap((f) => [f.code, "", ""]),
    ...(chainMode ? [VERIFY.trimEnd(), ""] : []),
  ]
    .join("\n")
    .replace(/\n{3,}$/, "\n")
    .replace(/\n*$/, "\n");
}

export function exportPython(opts: ExportOptions): ExportResult {
  const reader = BundleReader.open(opts.bundle);
  const warnings: string[] = [];
  if (!reader.isComplete()) warnings.push("bundle is not finished (未收尾): recording in progress or interrupted");
  const { requests, skipped } = replayableRequests(reader);
  const include = globMatcher(opts.include);
  const exclude = globMatcher(opts.exclude);
  const chosen: RequestEvent[] = [];
  for (const r of requests) {
    const path = safePath(r.url);
    if (!GENERATED_TYPES.has(r.type)) skipped.push({ id: r.id, reason: `type ${r.type}` });
    else if (include !== null && !include(path)) skipped.push({ id: r.id, reason: "not included" });
    else if (exclude !== null && exclude(path)) skipped.push({ id: r.id, reason: "excluded" });
    else chosen.push(r);
  }
  if (chosen.length === 0) throw new TabcapError("not-found", "no request to generate a client for", "Check --include / --exclude; only xhr, fetch and document requests with a recorded response are used.");
  const byRef = new Map(chosen.map((r) => [r.id, r]));
  const name = reader.manifest.session.name !== "" ? reader.manifest.session.name : reader.manifest.id;
  const { groups, cookieValues } = groupRequests([{ label: "b1", sessionKey: name, requests: chosen, readBlob: (ref) => reader.readBlob(ref) }], (w) => warnings.push(w));

  // cookie value -> cookie name, for session values carried outside the cookie header
  const cookieNames = new Map<string, string>();
  for (const r of chosen) {
    for (const c of (headerJoined(r.request.headers, "cookie") ?? "").split(";")) {
      const eq = c.indexOf("=");
      if (eq > 0) {
        const v = c.slice(eq + 1).trim();
        if (v.length >= 8 && !cookieNames.has(v)) cookieNames.set(v, c.slice(0, eq).trim());
      }
    }
  }
  const ctx: Ctx = { reader, cookieNames, warnings };

  const ordered = [...groups.entries()].sort((a, b) => {
    const sa = byRef.get(a[1].samples[0]?.ref ?? "")?.seq ?? 0;
    const sb = byRef.get(b[1].samples[0]?.ref ?? "")?.seq ?? 0;
    return sa - sb;
  });
  const taken = new Set<string>(["session", "reply", "verify", "todo"]);
  const typeNames = new Set<string>(["Session", "Reply", "T"]);
  const fnNames = new Map<string, string>();
  const fnOfRef = new Map<string, string>();
  for (const [key, g] of ordered) {
    const n = unique(pyIdent(`${g.method}_${g.template === "/" ? "root" : g.template}`, "call"), taken);
    fnNames.set(key, n);
    for (const smp of g.samples) fnOfRef.set(smp.ref, n);
  }

  // Chain mode (0.4-A): the deps graph and the chain to the last data-bearing request.
  const graph = opts.chain === false ? null : DepsGraph.of(reader);
  const linked = graph !== null && chosen.some((r) => graph.inputs(r.id).some((i) => i.primary !== null && (i.primary.kind === "set-cookie" || i.primary.kind === "response")));
  const chainMode = graph !== null && (opts.chain === true || linked);
  let chain: ChainResult | null = null;
  if (graph !== null && chainMode) {
    const target = [...chosen].reverse().find(dataBearing) ?? chosen[chosen.length - 1];
    if (target !== undefined) chain = chainOf(graph, opts.bundle, { request: target.id });
    for (const w of graph.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  const planned: { fn: GeneratedFunction; code: string; types: string[]; group: GroupAcc }[] = [];
  for (const [key, g] of ordered) {
    const params = g.samples.length >= 2 ? (classifyGroup(key, g, cookieValues, 1)?.params ?? []) : singleSampleParams(g);
    let dp: DepsPlan | null = null;
    if (graph !== null && chainMode) {
      const inputs = new Map<string, ResolvedInput>();
      for (const i of graph.inputs(g.samples[0]?.ref ?? "")) inputs.set(i.key, i);
      dp = { graph, inputs, fnOf: (ref) => fnOfRef.get(ref) ?? null };
    }
    planned.push({ ...planFunction(key, g, params, ctx, typeNames, byRef, dp, fnNames.get(key) ?? "call"), group: g });
  }

  mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  const fixturesDir = join(opts.out, "fixtures");
  mkdirSync(fixturesDir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  const header = [
    "# Generated by tabcap replay export-python. Do not edit: regenerate from the bundle.",
    `# bundle ${docSafe(reader.manifest.id)} (session ${docSafe(name)}), ${planned.length} function(s).`,
    `# Functions marked "${TODO_MARK}" raise NotImplementedError:`,
    "# signature-like parameters and encrypted bodies are not reproduced.",
    `# "${TODO_UNRECORDED}": the recording lacks what the call needs.`,
    ...(chainMode
      ? [
          `# Chain mode (tabcap analyze deps / chain): a parameter defaulting to TODO has no source in the recording;`,
          `# pass it (or fill it in todo_inputs.py for verify). verify() replays the chain to ${docSafe(chain?.target ?? "")}:`,
          "#   python client.py verify --base-url http://127.0.0.1:4500",
        ]
      : []),
    `"""Replay client for bundle ${docSafe(reader.manifest.id)}."""`,
  ];
  const write = (rel: string, text: string) => {
    writeFileSync(join(opts.out, rel), text);
    chmodSync(join(opts.out, rel), 0o644);
    files.push(rel);
  };
  const todoRuntime = chainMode || planned.some((p) => p.fn.args.some((a) => a.todo !== undefined));
  write("client.py", generateClientSource(planned, header, chainMode, todoRuntime));
  const cases = planned.map((p) => fixtureCase(p.fn, p.group, ctx, byRef, fixturesDir, files));
  writeFileSync(join(fixturesDir, "index.json"), JSON.stringify({ bundle: reader.manifest.id, session: name, cases }, null, 2) + "\n");
  files.push("fixtures/index.json");
  write("conftest.py", CONFTEST);
  write("test_replay.py", TEST_REPLAY);
  if (chainMode && chain !== null && graph !== null) {
    const expected = verifyExpected(chain, graph, planned, ctx, byRef, skipped);
    write("verify_expected.json", JSON.stringify(expected, null, 2) + "\n");
    chmodSync(join(opts.out, "verify_expected.json"), 0o600);
  }
  const pkgName = pyIdent(`tabcap_replay_${name}`, "tabcap_replay").replace(/_/g, "-");
  const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  const todoList = planned.filter((p) => p.fn.todo !== null).map((p) => `- \`${p.fn.name}\`：${p.fn.todo ?? ""}`);
  const vars = {
    name: pkgName,
    bundleId: docSafe(reader.manifest.id),
    session: docSafe(name).replace(/[`]/g, "_"),
    functionCount: String(planned.length),
    todo: todoList.length === 0 ? "（无：每个函数都能直接调用。）" : todoList.map((l) => l.replace(/[\r\n]/g, " ")).join("\n"),
    chain: chainMode && chain !== null ? chainReadme(chain, reader.manifest.redaction !== null) : "",
  };
  write("pyproject.toml", fill(PYPROJECT, vars));
  write("README.md", fill(README, vars));
  if (planned.some((p) => p.fn.todo !== null)) warnings.push(`${planned.filter((p) => p.fn.todo !== null).length} function(s) raise NotImplementedError (TODO markers in client.py)`);
  return {
    out: opts.out,
    bundle: opts.bundle,
    functions: planned.map((p) => ({ name: p.fn.name, method: p.fn.method, template: p.fn.template, samples: p.fn.samples, todo: p.fn.todo, args: p.fn.args.map((a) => a.py) })),
    files: files.sort(),
    skipped: skipped.slice(0, 200),
    skippedCount: skipped.length,
    chain: chainMode && chain !== null ? { target: chain.target, steps: chain.steps.map((x) => x.request), todo: chain.todo.length } : null,
    warnings,
  };
}
