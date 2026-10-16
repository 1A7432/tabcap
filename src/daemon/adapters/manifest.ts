// Adapter manifests (docs/09 §9): one directory per adapter holding
// `adapter.json` and an optional isolated-world page script. Manifests are
// untrusted data when they come from disk: every field is checked, unknown
// keys are rejected, sizes are capped, and a bad adapter is refused with an
// error that names the file and the field.
//
// Schema `tabcap-adapter/0`:
//   name       kebab-case, equal to the directory name
//   category   widget | overlay | channel | framework
//   version    positive integer
//   script     file name of the page script (`*.js`), required by describe / act / read
//   detect     features, each with a confidence in (0, 1]:
//                class-prefix  {prefix}                    some element has a class starting with it
//                global        {name}                      `name in globalThis` in the page's main world
//                dom           {match, has?}               an element matching `match` (with a descendant matching `has`)
//                header        {name, pattern?}            main-document response header (regex on the value)
//   hooks      detect {script?}, describe {when: always|detected}, act {ops}, read {mode: explicit}, decode {contentTypes}
// All five hooks load and validate; 0.3-D runs detect / describe / act only.

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";

export const ADAPTER_SCHEMA = "tabcap-adapter/0";
export const CATEGORIES = ["widget", "overlay", "channel", "framework"] as const;
export type Category = (typeof CATEGORIES)[number];
export const HOOKS = ["detect", "describe", "act", "read", "decode"] as const;
export type HookName = (typeof HOOKS)[number];

export const MAX_MANIFEST_BYTES = 32 * 1024;
export const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_FEATURES = 64;

/** One element condition of a `dom` feature; at least one key. */
export type ElementSpec = { tag?: string; id?: string; classPrefix?: string; attr?: { name: string; value?: string } };

export type Feature = { label: string; confidence: number } & (
  | { kind: "class-prefix"; prefix: string }
  | { kind: "global"; name: string }
  | { kind: "dom"; match: ElementSpec; has?: ElementSpec }
  | { kind: "header"; name: string; pattern?: string }
);

export type Hooks = {
  detect?: { script: boolean };
  describe?: { when: "always" | "detected" };
  act?: { ops: string[] };
  read?: { mode: "explicit" };
  decode?: { contentTypes: string[] };
};

export type Adapter = {
  name: string;
  category: Category;
  version: number;
  description: string;
  detect: Feature[];
  hooks: Hooks;
  /** Page script source (a JS expression evaluating to an object of hook functions), or null. */
  script: string | null;
  /** Where it came from: `builtin:<name>` or the directory path. */
  source: string;
};

const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CLASS_TOKEN = /^-?[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
const ATTR = /^[a-z][a-z0-9_:-]{0,63}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_FILE = /^[a-z0-9][a-z0-9-]{0,31}\.js$/;
const OP = /^[a-z][a-z0-9-]{0,31}$/;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/;

class Bad extends Error {}

function fail(path: string, why: string): never {
  throw new Bad(`${path}: ${why}`);
}

function only(o: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(path, `unknown key ${JSON.stringify(k)}`);
}

function rec(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) fail(path, "must be an object");
  return v;
}

function text(v: unknown, path: string, re: RegExp | null, max: number): string {
  if (typeof v !== "string") fail(path, "must be a string");
  if (v.length === 0 || v.length > max) fail(path, `must be 1..${max} characters`);
  if (re !== null && !re.test(v)) fail(path, `has an invalid form: ${JSON.stringify(v.slice(0, 80))}`);
  if (/[\u0000-\u001f\u007f]/.test(v)) fail(path, "must not contain control characters");
  return v;
}

function confidence(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) fail(path, "must be a number in (0, 1]");
  return v;
}

function elementSpec(v: unknown, path: string): ElementSpec {
  const o = rec(v, path);
  only(o, ["tag", "id", "classPrefix", "attr"], path);
  const s: ElementSpec = {};
  if (o["tag"] !== undefined) s.tag = text(o["tag"], `${path}.tag`, TAG, 32);
  if (o["id"] !== undefined) s.id = text(o["id"], `${path}.id`, null, 128);
  if (o["classPrefix"] !== undefined) s.classPrefix = text(o["classPrefix"], `${path}.classPrefix`, CLASS_TOKEN, 64);
  if (o["attr"] !== undefined) {
    const a = rec(o["attr"], `${path}.attr`);
    only(a, ["name", "value"], `${path}.attr`);
    const name = text(a["name"], `${path}.attr.name`, ATTR, 64);
    s.attr = a["value"] === undefined ? { name } : { name, value: typeof a["value"] === "string" && a["value"].length <= 256 ? a["value"] : fail(`${path}.attr.value`, "must be a string of at most 256 characters") };
  }
  if (Object.keys(s).length === 0) fail(path, "needs at least one of tag, id, classPrefix, attr");
  return s;
}

function feature(v: unknown, path: string): Feature {
  const o = rec(v, path);
  const kind = o["kind"];
  const base = { confidence: confidence(o["confidence"], `${path}.confidence`) };
  const label = (fallback: string) => (o["label"] === undefined ? fallback : text(o["label"], `${path}.label`, null, 80));
  switch (kind) {
    case "class-prefix": {
      only(o, ["kind", "prefix", "confidence", "label"], path);
      const prefix = text(o["prefix"], `${path}.prefix`, CLASS_TOKEN, 64);
      return { kind, prefix, ...base, label: label(`class ${prefix}*`) };
    }
    case "global": {
      only(o, ["kind", "name", "confidence", "label"], path);
      const name = text(o["name"], `${path}.name`, IDENT, 64);
      return { kind, name, ...base, label: label(`global ${name}`) };
    }
    case "dom": {
      only(o, ["kind", "match", "has", "confidence", "label"], path);
      const match = elementSpec(o["match"], `${path}.match`);
      const f: Feature = { kind, match, ...base, label: label(`dom ${specText(match)}`) };
      if (o["has"] !== undefined) {
        const has = elementSpec(o["has"], `${path}.has`);
        return { kind, match, has, ...base, label: label(`dom ${specText(match)} > … ${specText(has)}`) };
      }
      return f;
    }
    case "header": {
      only(o, ["kind", "name", "pattern", "confidence", "label"], path);
      const name = text(o["name"], `${path}.name`, HEADER, 64);
      if (o["pattern"] === undefined) return { kind, name, ...base, label: label(`header ${name}`) };
      const pattern = text(o["pattern"], `${path}.pattern`, null, 200);
      try {
        new RegExp(pattern, "i");
      } catch {
        fail(`${path}.pattern`, "is not a valid regular expression");
      }
      return { kind, name, pattern, ...base, label: label(`header ${name} ~ /${pattern}/`) };
    }
    default:
      return fail(`${path}.kind`, "must be class-prefix, global, dom or header");
  }
}

export function specText(s: ElementSpec): string {
  let t = s.tag ?? "*";
  if (s.id !== undefined) t += `#${s.id}`;
  if (s.classPrefix !== undefined) t += `.${s.classPrefix}*`;
  if (s.attr !== undefined) t += s.attr.value === undefined ? `[${s.attr.name}]` : `[${s.attr.name}=${JSON.stringify(s.attr.value)}]`;
  return t;
}

function hooks(v: unknown, path: string): Hooks {
  const o = rec(v, path);
  only(o, HOOKS, path);
  const h: Hooks = {};
  if (o["detect"] !== undefined) {
    const d = rec(o["detect"], `${path}.detect`);
    only(d, ["script"], `${path}.detect`);
    if (d["script"] !== undefined && typeof d["script"] !== "boolean") fail(`${path}.detect.script`, "must be true or false");
    h.detect = { script: d["script"] === true };
  }
  if (o["describe"] !== undefined) {
    const d = rec(o["describe"], `${path}.describe`);
    only(d, ["when"], `${path}.describe`);
    const when = d["when"] ?? "detected";
    if (when !== "always" && when !== "detected") fail(`${path}.describe.when`, "must be always or detected");
    h.describe = { when };
  }
  if (o["act"] !== undefined) {
    const d = rec(o["act"], `${path}.act`);
    only(d, ["ops"], `${path}.act`);
    if (!Array.isArray(d["ops"]) || d["ops"].length === 0 || d["ops"].length > 16) fail(`${path}.act.ops`, "must be a list of 1..16 operation names");
    h.act = { ops: d["ops"].map((x, i) => text(x, `${path}.act.ops[${i}]`, OP, 32)) };
  }
  if (o["read"] !== undefined) {
    const d = rec(o["read"], `${path}.read`);
    only(d, ["mode"], `${path}.read`);
    // docs/09 §13.5: reading instance data runs page JS, so it is an explicit mode only.
    if (d["mode"] !== "explicit") fail(`${path}.read.mode`, "must be explicit");
    h.read = { mode: "explicit" };
  }
  if (o["decode"] !== undefined) {
    const d = rec(o["decode"], `${path}.decode`);
    only(d, ["contentTypes"], `${path}.decode`);
    if (!Array.isArray(d["contentTypes"]) || d["contentTypes"].length === 0 || d["contentTypes"].length > 16) fail(`${path}.decode.contentTypes`, "must be a list of 1..16 media types");
    h.decode = { contentTypes: d["contentTypes"].map((x, i) => text(x, `${path}.decode.contentTypes[${i}]`, MIME, 100)) };
  }
  return h;
}

/** Checks a page script without running it: size, no NUL, parses as one expression. */
export function checkScript(src: string, path: string): string {
  if (new TextEncoder().encode(src).length > MAX_SCRIPT_BYTES) fail(path, `is larger than ${MAX_SCRIPT_BYTES} bytes`);
  if (src.includes("\u0000")) fail(path, "contains NUL bytes");
  try {
    // Compiles, never calls: a syntax check of `(<script>)` as an expression.
    new Function(`"use strict"; return (\n${src}\n);`);
  } catch (e) {
    fail(path, `does not parse as a JavaScript expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  return src;
}

/**
 * Validate a parsed manifest plus its script text. `dirName` (disk loads) must
 * equal the manifest name. Throws TabcapError("bad-input") naming the field.
 */
export function parseAdapter(manifest: unknown, script: string | null, source: string, dirName: string | null = null): Adapter {
  try {
    const o = rec(manifest, "adapter.json");
    only(o, ["schema", "name", "category", "version", "description", "script", "detect", "hooks"], "adapter.json");
    if (o["schema"] !== ADAPTER_SCHEMA) fail("adapter.json.schema", `must be ${JSON.stringify(ADAPTER_SCHEMA)}`);
    const name = text(o["name"], "adapter.json.name", NAME, 32);
    if (dirName !== null && dirName !== name) fail("adapter.json.name", `must equal the directory name ${JSON.stringify(dirName)}`);
    const category = o["category"];
    if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) fail("adapter.json.category", `must be one of ${CATEGORIES.join(", ")}`);
    const version = o["version"];
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) fail("adapter.json.version", "must be a positive integer");
    const description = o["description"] === undefined ? "" : text(o["description"], "adapter.json.description", null, 200);
    const detectRaw = o["detect"] ?? [];
    if (!Array.isArray(detectRaw) || detectRaw.length > MAX_FEATURES) fail("adapter.json.detect", `must be a list of at most ${MAX_FEATURES} features`);
    const detect = detectRaw.map((f, i) => feature(f, `adapter.json.detect[${i}]`));
    const h = hooks(o["hooks"] ?? {}, "adapter.json.hooks");
    const scriptFile = o["script"] === undefined ? null : text(o["script"], "adapter.json.script", SCRIPT_FILE, 40);
    const needsScript = h.describe !== undefined || h.act !== undefined || h.read !== undefined || h.decode !== undefined || h.detect?.script === true;
    if (needsScript && scriptFile === null) fail("adapter.json.script", "is required by the describe / act / read / decode / detect.script hooks");
    if (scriptFile !== null && script === null) fail(scriptFile, "is missing");
    if (h.detect === undefined && detect.length > 0) h.detect = { script: false };
    return {
      name,
      category: category as Category,
      version,
      description,
      detect,
      hooks: h,
      script: scriptFile === null || script === null ? null : checkScript(script, scriptFile),
      source,
    };
  } catch (e) {
    if (e instanceof Bad) throw new TabcapError("bad-input", `adapter ${source} rejected: ${e.message}`, "Fix the adapter's adapter.json / script (schema tabcap-adapter/0) or remove the directory.");
    throw e;
  }
}

/** Load one adapter directory from disk (untrusted): `<dir>/adapter.json` and its script. */
export function loadAdapterDir(dir: string): Adapter {
  const source = dir;
  const read = (file: string, max: number): string | null => {
    const p = join(dir, file);
    let size: number;
    try {
      const st = statSync(p);
      if (!st.isFile()) throw new TabcapError("bad-input", `adapter ${source} rejected: ${file} is not a regular file`, "Fix or remove the adapter directory.");
      size = st.size;
    } catch (e) {
      if (e instanceof TabcapError) throw e;
      return null;
    }
    if (size > max) throw new TabcapError("bad-input", `adapter ${source} rejected: ${file} is larger than ${max} bytes`, "Fix or remove the adapter directory.");
    return readFileSync(p, "utf8");
  };
  const mtext = read("adapter.json", MAX_MANIFEST_BYTES);
  if (mtext === null) throw new TabcapError("bad-input", `adapter ${source} rejected: adapter.json is missing`, "Each adapter directory needs an adapter.json (schema tabcap-adapter/0).");
  let manifest: unknown;
  try {
    manifest = JSON.parse(mtext) as unknown;
  } catch (e) {
    throw new TabcapError("bad-input", `adapter ${source} rejected: adapter.json is not JSON (${e instanceof Error ? e.message : String(e)})`, "Fix the JSON syntax of adapter.json.");
  }
  const scriptName = isRecord(manifest) && typeof manifest["script"] === "string" && SCRIPT_FILE.test(manifest["script"]) ? manifest["script"] : null;
  const script = scriptName === null ? null : read(scriptName, MAX_SCRIPT_BYTES);
  return parseAdapter(manifest, script, source, basename(dir));
}

/** Calling a hook the adapter declares but this version does not run (read, decode). */
export function hookNotImplemented(a: Adapter, hook: HookName): TabcapError {
  const next =
    hook === "decode"
      ? 'Body decoding runs through decode plugins (a plugin with "kind": "decode" under the plugins directory, docs/04 §28), not adapter hooks.'
      : "Use snapshot / outline (detect, describe) or click / fill (act) for now.";
  return new TabcapError("unsupported", `adapter ${a.name}: the ${hook} hook is declared and validated, but tabcap 0.3 does not run ${hook} hooks yet`, next);
}
