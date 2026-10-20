// Protection family rules, schema `tabcap-protection/0` (docs/04 §41.1, owner
// decisions 10-20): one JSON per family, built-in under ./families/, the
// user's under config/protection/. Identification only: a family says which
// vendor a page uses and on what grounds; nothing here helps get past it.
// Rule files are untrusted when they come from disk: unknown keys are refused,
// sizes are capped, every regex must compile, and an error names the file and
// the field. The method (per-rule confidence, `standalone:false` corroboration,
// combinations) follows scrapfly/Antibot-Detector's published approach; none
// of its code or rule data is used (AGENTS.md, docs/14).

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import type { ElementSpec } from "../../daemon/adapters/manifest.ts";

export const PROTECTION_SCHEMA = "tabcap-protection/0";
export const CATEGORIES = ["anti-bot", "captcha", "fingerprint"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Layer = 1 | 2 | 3;

export const MAX_FAMILY_BYTES = 32 * 1024;
const MAX_RULES = 64;
const MAX_REGEX = 512;

export type Rule = { id: string; confidence: number; standalone: boolean; note: string } & (
  | { kind: "cookie"; name: string; nameRegex: boolean; valueShape: RegExp | null; nameRe: RegExp }
  | { kind: "request"; url: RegExp; type: string | null; method: string | null }
  | { kind: "responseHeader"; name: string; value: RegExp | null }
  | { kind: "requestHeader"; name: string }
  | { kind: "challenge"; status: number[] | null; text: RegExp | null }
  | { kind: "requestBody"; url: RegExp | null; text: RegExp }
  | { kind: "global"; path: string[]; condition: "exists" | "function" | "object" | "string" }
  | { kind: "dom"; match: ElementSpec; has: ElementSpec | null }
  | { kind: "frame"; url: RegExp }
  | { kind: "api"; target: string; caller: RegExp | null }
);

export type RuleKind = Rule["kind"];

/** The layer follows from the kind (docs/04 §41.1): traffic, page, trace. */
export function layerOf(kind: RuleKind): Layer {
  if (kind === "global" || kind === "dom" || kind === "frame") return 2;
  if (kind === "api") return 3;
  return 1;
}

export type When = { all: WhenItem[] } | { any: WhenItem[] };
export type WhenItem = { rule: string } | When;
export type Combination = { id: string; name: string; confidence: number; when: When };

export type Family = {
  id: string;
  name: string;
  vendor: string;
  category: Category;
  version: number;
  sources: { url: string; note: string | null }[];
  rules: Rule[];
  combinations: Combination[];
  /** Where it came from: `builtin:<id>` or the file path. */
  origin: string;
};

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS: readonly RuleKind[] = ["cookie", "request", "responseHeader", "requestHeader", "challenge", "requestBody", "global", "dom", "frame", "api"];
const GLOBAL_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5}$/;

type Ctx = { where: string };

function bad(c: Ctx, field: string, why: string): never {
  throw new TabcapError("bad-input", `${c.where}: ${field}: ${why}`, `Fix ${field} in ${c.where} (schema ${PROTECTION_SCHEMA}, docs/04 §41.1).`);
}

function only(o: Record<string, unknown>, keys: readonly string[], c: Ctx, field: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(c, `${field}.${k}`, "unknown key");
}

function reqStr(o: Record<string, unknown>, k: string, c: Ctx, field: string, max = 200): string {
  const v = o[k];
  if (typeof v !== "string" || v === "" || v.length > max) bad(c, `${field}.${k}`, `a non-empty string of at most ${max} characters`);
  return v;
}

function optStr(o: Record<string, unknown>, k: string, c: Ctx, field: string, max = 200): string | null {
  return o[k] === undefined ? null : reqStr(o, k, c, field, max);
}

function regex(src: string, c: Ctx, field: string): RegExp {
  if (src.length > MAX_REGEX) bad(c, field, `a regex of at most ${MAX_REGEX} characters`);
  try {
    return new RegExp(src, "i");
  } catch (e) {
    return bad(c, field, `not a valid regex (${e instanceof Error ? e.message : String(e)})`);
  }
}

function optRegex(o: Record<string, unknown>, k: string, c: Ctx, field: string): RegExp | null {
  const s = optStr(o, k, c, field, MAX_REGEX);
  return s === null ? null : regex(s, c, `${field}.${k}`);
}

function spec(v: unknown, c: Ctx, field: string): ElementSpec {
  if (!isRecord(v)) bad(c, field, "an object");
  only(v, ["tag", "id", "classPrefix", "attr"], c, field);
  const out: ElementSpec = {};
  const tag = optStr(v, "tag", c, field, 64);
  const id = optStr(v, "id", c, field, 128);
  const classPrefix = optStr(v, "classPrefix", c, field, 128);
  if (tag !== null) out.tag = tag.toLowerCase();
  if (id !== null) out.id = id;
  if (classPrefix !== null) out.classPrefix = classPrefix;
  if (v["attr"] !== undefined) {
    const a = v["attr"];
    if (!isRecord(a)) bad(c, `${field}.attr`, "an object");
    only(a, ["name", "value"], c, `${field}.attr`);
    const name = reqStr(a, "name", c, `${field}.attr`, 64).toLowerCase();
    const value = optStr(a, "value", c, `${field}.attr`, 256);
    out.attr = value === null ? { name } : { name, value };
  }
  if (Object.keys(out).length === 0) bad(c, field, "needs at least one of tag, id, classPrefix, attr");
  return out;
}

function parseRule(v: unknown, c: Ctx, field: string): Rule {
  if (!isRecord(v)) bad(c, field, "an object");
  const kind = v["kind"];
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) bad(c, `${field}.kind`, `one of ${KINDS.join(", ")}`);
  const id = reqStr(v, "id", c, field, 64);
  if (!RULE_ID.test(id)) bad(c, `${field}.id`, "kebab-case, at most 64 characters");
  const confidence = v["confidence"];
  if (typeof confidence !== "number" || !Number.isInteger(confidence) || confidence < 1 || confidence > 100) bad(c, `${field}.confidence`, "an integer 1–100");
  const standalone = v["standalone"] === undefined ? true : v["standalone"];
  if (typeof standalone !== "boolean") bad(c, `${field}.standalone`, "true or false");
  const note = reqStr(v, "note", c, field, 300);
  const base = { id, confidence, standalone, note };
  const common = ["kind", "id", "confidence", "standalone", "note"];
  switch (kind as RuleKind) {
    case "cookie": {
      only(v, [...common, "name", "nameRegex", "valueShape"], c, field);
      const name = reqStr(v, "name", c, field, MAX_REGEX);
      const nameRegex = v["nameRegex"] === undefined ? false : v["nameRegex"];
      if (typeof nameRegex !== "boolean") bad(c, `${field}.nameRegex`, "true or false");
      const nameRe = nameRegex ? regex(name, c, `${field}.name`) : new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      return { ...base, kind: "cookie", name, nameRegex, nameRe, valueShape: optRegex(v, "valueShape", c, field) };
    }
    case "request": {
      only(v, [...common, "url", "type", "method"], c, field);
      return { ...base, kind: "request", url: regex(reqStr(v, "url", c, field, MAX_REGEX), c, `${field}.url`), type: optStr(v, "type", c, field, 32), method: optStr(v, "method", c, field, 16)?.toUpperCase() ?? null };
    }
    case "responseHeader": {
      only(v, [...common, "name", "value"], c, field);
      return { ...base, kind: "responseHeader", name: reqStr(v, "name", c, field, 128).toLowerCase(), value: optRegex(v, "value", c, field) };
    }
    case "requestHeader": {
      only(v, [...common, "name"], c, field);
      return { ...base, kind: "requestHeader", name: reqStr(v, "name", c, field, 128).toLowerCase() };
    }
    case "challenge": {
      only(v, [...common, "status", "text"], c, field);
      let status: number[] | null = null;
      if (v["status"] !== undefined) {
        const s = v["status"];
        if (!Array.isArray(s) || s.length === 0 || !s.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 100 && x <= 599)) bad(c, `${field}.status`, "a non-empty array of HTTP status codes");
        status = s as number[];
      }
      const text = optRegex(v, "text", c, field);
      if (status === null && text === null) bad(c, field, "a challenge rule needs status or text");
      return { ...base, kind: "challenge", status, text };
    }
    case "requestBody": {
      only(v, [...common, "url", "text"], c, field);
      return { ...base, kind: "requestBody", url: optRegex(v, "url", c, field), text: regex(reqStr(v, "text", c, field, MAX_REGEX), c, `${field}.text`) };
    }
    case "global": {
      only(v, [...common, "path", "condition"], c, field);
      const path = reqStr(v, "path", c, field, 128);
      if (!GLOBAL_PATH.test(path)) bad(c, `${field}.path`, "a dotted identifier path, at most 6 parts");
      const condition = v["condition"] === undefined ? "exists" : v["condition"];
      if (condition !== "exists" && condition !== "function" && condition !== "object" && condition !== "string") bad(c, `${field}.condition`, "exists, function, object or string");
      return { ...base, kind: "global", path: path.split("."), condition };
    }
    case "dom": {
      only(v, [...common, "match", "has"], c, field);
      return { ...base, kind: "dom", match: spec(v["match"], c, `${field}.match`), has: v["has"] === undefined ? null : spec(v["has"], c, `${field}.has`) };
    }
    case "frame": {
      only(v, [...common, "url"], c, field);
      return { ...base, kind: "frame", url: regex(reqStr(v, "url", c, field, MAX_REGEX), c, `${field}.url`) };
    }
    case "api": {
      only(v, [...common, "target", "caller"], c, field);
      return { ...base, kind: "api", target: reqStr(v, "target", c, field, 128), caller: optRegex(v, "caller", c, field) };
    }
  }
}

function parseWhen(v: unknown, c: Ctx, field: string, ids: ReadonlySet<string>, depth = 0): When {
  if (depth > 4) bad(c, field, "nested deeper than 4 levels");
  if (!isRecord(v)) bad(c, field, "an object with all or any");
  const keys = Object.keys(v);
  if (keys.length !== 1 || (keys[0] !== "all" && keys[0] !== "any")) bad(c, field, "exactly one of all, any");
  const key = keys[0] === "all" ? "all" : "any";
  const list = v[key];
  if (!Array.isArray(list) || list.length === 0 || list.length > 16) bad(c, `${field}.${key}`, "a non-empty array of at most 16 items");
  const items: WhenItem[] = list.map((it, i) => {
    const f = `${field}.${key}[${i}]`;
    if (isRecord(it) && typeof it["rule"] === "string") {
      only(it, ["rule"], c, f);
      if (!ids.has(it["rule"])) bad(c, `${f}.rule`, `no rule named ${it["rule"]}`);
      return { rule: it["rule"] };
    }
    return parseWhen(it, c, f, ids, depth + 1);
  });
  return key === "all" ? { all: items } : { any: items };
}

/** Parse and validate one family. `where` names the file (or `builtin:<id>`) in errors. */
export function parseFamily(raw: unknown, where: string, builtin: boolean): Family {
  const c: Ctx = { where };
  if (!isRecord(raw)) bad(c, "(file)", "a JSON object");
  only(raw, ["schema", "id", "name", "vendor", "category", "version", "sources", "rules", "combinations"], c, "(top)");
  if (raw["schema"] !== PROTECTION_SCHEMA) bad(c, "schema", `must be ${PROTECTION_SCHEMA}`);
  const id = reqStr(raw, "id", c, "(top)", 64);
  if (!ID.test(id)) bad(c, "id", "kebab-case, at most 64 characters");
  const category = raw["category"];
  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) bad(c, "category", CATEGORIES.join(", "));
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) bad(c, "version", "a positive integer");
  const sources: Family["sources"] = [];
  if (raw["sources"] !== undefined) {
    const s = raw["sources"];
    if (!Array.isArray(s) || s.length > 32) bad(c, "sources", "an array of at most 32 items");
    s.forEach((it, i) => {
      if (!isRecord(it)) bad(c, `sources[${i}]`, "an object");
      only(it, ["url", "note"], c, `sources[${i}]`);
      const url = reqStr(it, "url", c, `sources[${i}]`, 500);
      if (!/^https:\/\//.test(url)) bad(c, `sources[${i}].url`, "an https URL");
      sources.push({ url, note: optStr(it, "note", c, `sources[${i}]`, 300) });
    });
  }
  if (builtin && sources.length === 0 && category !== "fingerprint") bad(c, "sources", "a built-in family names its public sources (docs/14)");
  const rawRules = raw["rules"];
  if (!Array.isArray(rawRules) || rawRules.length === 0 || rawRules.length > MAX_RULES) bad(c, "rules", `a non-empty array of at most ${MAX_RULES} rules`);
  const rules = rawRules.map((r, i) => parseRule(r, c, `rules[${i}]`));
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) bad(c, "rules", `duplicate rule id ${r.id}`);
    ids.add(r.id);
  }
  const combinations: Combination[] = [];
  if (raw["combinations"] !== undefined) {
    const list = raw["combinations"];
    if (!Array.isArray(list) || list.length > 16) bad(c, "combinations", "an array of at most 16 items");
    list.forEach((it, i) => {
      const f = `combinations[${i}]`;
      if (!isRecord(it)) bad(c, f, "an object");
      only(it, ["id", "name", "confidence", "when"], c, f);
      const cid = reqStr(it, "id", c, f, 64);
      const conf = it["confidence"];
      if (typeof conf !== "number" || !Number.isInteger(conf) || conf < 1 || conf > 100) bad(c, `${f}.confidence`, "an integer 1–100");
      combinations.push({ id: cid, name: reqStr(it, "name", c, f, 200), confidence: conf, when: parseWhen(it["when"], c, `${f}.when`, ids) });
    });
  }
  return { id, name: reqStr(raw, "name", c, "(top)"), vendor: reqStr(raw, "vendor", c, "(top)"), category: category as Category, version, sources, rules, combinations, origin: where };
}

// ------------------------------------------------------------ confidence limits

/** Rule kinds whose signal another product can also produce (markup, globals, frames, generic bodies). */
const SHARED_KINDS: ReadonlySet<RuleKind> = new Set(["global", "dom", "frame", "challenge", "requestBody", "api"]);

/** Short names that need a value shape before they can stand alone at 100. */
export const SHORT_NAME = 4;

/**
 * The limits a family's confidences must keep (docs/04 §41.1). Returns the
 * violations, empty when the family is within them. Built-in families are
 * checked by the unit tests; user files are not held to them.
 */
export function confidenceViolations(f: Family): string[] {
  const out: string[] = [];
  const cap = f.category === "captcha" ? 60 : 90;
  const byId = new Map(f.rules.map((r) => [r.id, r] as const));
  const proof = (r: Rule): boolean => {
    if (SHARED_KINDS.has(r.kind)) return false;
    if (r.kind === "cookie") return r.valueShape !== null || (!r.nameRegex && r.name.length > SHORT_NAME);
    return true;
  };
  for (const r of f.rules) {
    if (r.confidence === 100 && !proof(r)) out.push(`${r.id}: 100 needs a vendor-only signal (a ${r.kind} rule${r.kind === "cookie" ? " with a short or regex name needs valueShape" : " can only corroborate"})`);
    if (SHARED_KINDS.has(r.kind) && r.kind !== "api" && r.confidence > cap) out.push(`${r.id}: a ${r.kind} rule is at most ${cap} in a ${f.category} family`);
  }
  for (const cmb of f.combinations) {
    if (cmb.confidence === 100) {
      const leaves: string[] = [];
      const walk = (w: When): void => {
        for (const it of "all" in w ? w.all : w.any) {
          if ("rule" in it) leaves.push(it.rule);
          else walk(it);
        }
      };
      walk(cmb.when);
      const weak = leaves.filter((id) => {
        const r = byId.get(id);
        return r === undefined || !proof(r);
      });
      if (weak.length > 0) out.push(`${cmb.id}: a combination reaches 100 only from vendor-only signals (not ${weak.join(", ")})`);
    } else if (cmb.confidence > 95) out.push(`${cmb.id}: a combination below the top tier is at most 95`);
  }
  return out;
}
