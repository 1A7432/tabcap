// Replay key rules (0.6-C, owner design 2026-10-16; docs/04 §31): one rules
// document says, per request, how `replay serve` builds its match key, how
// `replay check` compares the answers and how `bundle export fixtures` keys
// its fixtures. Schema `tabcap-replay-rules/0`:
//   {schema, rules:[{match:{host?, path?, method?},
//                    key:{ignoreQuery?, ignoreBodyFields?, body?, decodeWith?, caseInsensitiveQuery?},
//                    response:{compare?, ignorePaths?, decodeWith?},
//                    prefer?: "recorded" | "2xx" | "latest"}]}
// The first rule whose `match` fits a request applies; a request no rule fits
// gets the default rule, which is the 0.3-B behaviour (method + path + sorted
// query + sha256 of the body bytes; status + body compared as before).
// Sources: `--rules <file>`; else config.json `sites.<bundle site>.replay`
// rules, then config.json `replay` rules (both `{rules:[…]}`).
// The document is untrusted input: unknown keys are rejected, sizes capped,
// every glob and JSON path is checked before anything is served.
// `prefer` (0.6-S): which recordings of one key answer (replay serve), are
// checked (replay check) and become fixtures (bundle export fixtures):
// "recorded" (default) all in recorded order, cycling; "2xx" only the 2xx
// ones (all when the key has none); "latest" only the last one.
// Oracle: the canonicalisation table in docs/04 §31 (test/unit/replay-rules.test.ts).
// Reproduce: bun test test/unit/replay-rules.test.ts

import { existsSync, readFileSync, statSync } from "node:fs";
import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import { isRecord, tryParseJson } from "../shared/json.ts";
import { baseMime, parseJsonDoc, utf8 } from "../analyze/decoders.ts";
import { parseJsonPath, segMatches, type PathSeg } from "../shared/jsonpath.ts";

export const RULES_SCHEMA = "tabcap-replay-rules/0";
export const MAX_RULES_FILE_BYTES = 1024 * 1024;
export const MAX_RULES = 256;
const MAX_LIST = 64;
const MAX_ITEM_CHARS = 200;
const MAX_JSON_DEPTH = 256;
const MAX_JSON_NODES = 200_000;
/** Canonical body text over this size is shown as `sha256:<hex>` of itself (fixtures, diagnostics). */
export const MAX_KEY_TEXT = 64 * 1024;

export const BODY_MODES = ["raw", "form", "json", "decoded", "none"] as const;
export type BodyMode = (typeof BODY_MODES)[number];
export const COMPARE_MODES = ["status", "status+body", "status+decoded-body"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export const PREFER_MODES = ["recorded", "2xx", "latest"] as const;
export type PreferMode = (typeof PREFER_MODES)[number];

/** A `--prefer` value, or a usage error. */
export function parsePrefer(v: string): PreferMode {
  const m = PREFER_MODES.find((x) => x === v);
  if (m === undefined) throw new TabcapError("usage", `bad --prefer ${JSON.stringify(v.slice(0, 40))}`, `Use one of: ${PREFER_MODES.join(", ")} (docs/04 §31).`);
  return m;
}

/**
 * The recordings of one key that answer under `prefer`, in recorded order
 * (`list` is sorted by seq): all (recorded), the 2xx ones (2xx; all when there
 * are none), or the last one (latest).
 */
export function preferred<T extends { status: number | null }>(list: readonly T[], prefer: PreferMode): T[] {
  if (prefer === "latest") return list.length === 0 ? [] : list.slice(-1);
  if (prefer === "2xx") {
    const ok = list.filter((r) => r.status !== null && r.status >= 200 && r.status < 300);
    return ok.length > 0 ? ok : [...list];
  }
  return [...list];
}

/** A JSON path (`$.a.b[0]`, `$.items[*].ts`, `$["x y"]`; docs/04 §43) or a bare name (a form field, or a top-level JSON key). */
export type FieldPattern = { text: string; segs: PathSeg[]; name: string | null };

export type Rule = {
  /** Where the rule comes from: `rules[0]` (file), `replay.rules[1]`, `sites.example.replay.rules[0]`; `default` when none fits. */
  id: string;
  match: { host: string | null; path: string | null; method: string | null };
  key: { ignoreQuery: string[]; ignoreBodyFields: string[]; body: BodyMode; decodeWith: string | null; caseInsensitiveQuery: boolean };
  response: { compare: CompareMode; ignorePaths: string[]; decodeWith: string | null };
  /** Which recordings of a key answer (0.6-S); "recorded" by default. */
  prefer: PreferMode;
};

export type CompiledRule = Rule & {
  hostRe: RegExp | null;
  pathRe: RegExp | null;
  queryRes: RegExp[];
  bodyFields: FieldPattern[];
  responsePaths: FieldPattern[];
};

export type RulesSource = { kind: "file"; file: string } | { kind: "config"; file: string; site: string | null } | { kind: "none" };

export type RuleSet = { rules: CompiledRule[]; source: RulesSource };

export const DEFAULT_RULE: CompiledRule = compileRule({
  id: "default",
  match: { host: null, path: null, method: null },
  key: { ignoreQuery: [], ignoreBodyFields: [], body: "raw", decodeWith: null, caseInsensitiveQuery: false },
  response: { compare: "status+body", ignorePaths: [], decodeWith: null },
  prefer: "recorded",
});

export const NO_RULES: RuleSet = { rules: [], source: { kind: "none" } };

// ------------------------------------------------------------ validation

const PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const METHOD = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,32}$/;
const HOST_GLOB = /^[A-Za-z0-9.*_:[\]-]{1,260}$/;

const bad = (where: string, msg: string) =>
  new TabcapError("bad-input", `replay rules ${where}: ${msg}`, `Fix the rules (schema ${RULES_SCHEMA}: {rules:[{match:{host, path, method}, key:{ignoreQuery, ignoreBodyFields, body, decodeWith, caseInsensitiveQuery}, response:{compare, ignorePaths, decodeWith}, prefer}]}; docs/04 §31).`);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(where, `unknown key ${JSON.stringify(k)} (known: ${allowed.join(", ")})`);
}

function strList(v: unknown, where: string, check: (s: string) => string | null): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST) throw bad(where, `must be a list of at most ${MAX_LIST} strings`);
  return v.map((x, i) => {
    if (typeof x !== "string" || x === "" || x.length > MAX_ITEM_CHARS) throw bad(`${where}[${i}]`, `must be a string of 1..${MAX_ITEM_CHARS} characters`);
    const why = check(x);
    if (why !== null) throw bad(`${where}[${i}]`, why);
    return x;
  });
}

function optString(v: unknown, where: string, check: (s: string) => string | null): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v === "") throw bad(where, "must be a non-empty string");
  const why = check(v);
  if (why !== null) throw bad(where, why);
  return v;
}

function pluginName(v: unknown, where: string): string | null {
  return optString(v, where, (s) => (PLUGIN_NAME.test(s) ? null : "must be a plugin name ([a-z0-9][a-z0-9_-]{0,63})"));
}

/** Parse a JSON path (docs/04 §43, shared/jsonpath.ts) or a bare name; a string is the reason it is not one. */
export function parseFieldPattern(text: string): FieldPattern | string {
  if (!text.startsWith("$")) {
    if (/[\0\r\n]/.test(text)) return "a name cannot hold NUL or line breaks";
    return { text, segs: [{ kind: "key", key: text }], name: text };
  }
  const r = parseJsonPath(text, { root: "required" });
  if (!r.ok) return `${r.why} of ${text} (paths look like $.a.b[0], $.items[*].ts, $["x y"]; docs/04 §43)`;
  if (r.segs.length === 0) return `${text} names the whole body (use body "none" to leave the body out)`;
  return { text, segs: r.segs, name: null };
}

/** Glob to a regex: `**` any characters, `*` any characters but `/` (path) or any characters (names, hosts), `?` one. */
function globRe(g: string, segmentStar: boolean, flags = ""): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? "";
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += segmentStar ? "[^/]*" : ".*";
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

function compileRule(r: Rule): CompiledRule {
  const ci = r.key.caseInsensitiveQuery;
  const fields = (list: string[]): FieldPattern[] => list.map((t) => parseFieldPattern(t)).filter((p): p is FieldPattern => typeof p !== "string");
  return {
    ...r,
    hostRe: r.match.host === null ? null : globRe(r.match.host.toLowerCase(), false),
    pathRe: r.match.path === null ? null : globRe(r.match.path, true),
    queryRes: r.key.ignoreQuery.map((g) => globRe(ci ? g.toLowerCase() : g, false, ci ? "i" : "")),
    bodyFields: fields(r.key.ignoreBodyFields),
    responsePaths: fields(r.response.ignorePaths),
  };
}

function parseRule(raw: unknown, id: string): CompiledRule {
  if (!isRecord(raw)) throw bad(id, "must be an object {match, key, response, prefer}");
  onlyKeys(raw, ["match", "key", "response", "prefer"], id);
  const m = raw["match"] ?? {};
  const k = raw["key"] ?? {};
  const s = raw["response"] ?? {};
  if (!isRecord(m)) throw bad(`${id}.match`, "must be an object {host?, path?, method?}");
  if (!isRecord(k)) throw bad(`${id}.key`, "must be an object");
  if (!isRecord(s)) throw bad(`${id}.response`, "must be an object");
  onlyKeys(m, ["host", "path", "method"], `${id}.match`);
  onlyKeys(k, ["ignoreQuery", "ignoreBodyFields", "body", "decodeWith", "caseInsensitiveQuery"], `${id}.key`);
  onlyKeys(s, ["compare", "ignorePaths", "decodeWith"], `${id}.response`);
  const host = optString(m["host"], `${id}.match.host`, (x) => (HOST_GLOB.test(x) ? null : "must be a host name or glob (letters, digits, . - _ : [ ] and *)"));
  const path = optString(m["path"], `${id}.match.path`, (x) => (x.startsWith("/") && x.length <= 512 && !/[\s?#]/.test(x) ? null : "must be a path glob starting with / (no query, no spaces, at most 512 characters)"));
  const method = optString(m["method"], `${id}.match.method`, (x) => (METHOD.test(x) ? null : "must be an HTTP method token"));
  const body = k["body"] ?? "raw";
  if (typeof body !== "string" || !BODY_MODES.some((b) => b === body)) throw bad(`${id}.key.body`, `must be one of ${BODY_MODES.map((b) => JSON.stringify(b)).join(", ")}`);
  const bodyMode = BODY_MODES.find((b) => b === body) ?? "raw";
  const keyDecode = pluginName(k["decodeWith"], `${id}.key.decodeWith`);
  if (keyDecode !== null && bodyMode !== "decoded") throw bad(`${id}.key.decodeWith`, 'needs body "decoded"');
  const ci = k["caseInsensitiveQuery"];
  if (ci !== undefined && typeof ci !== "boolean") throw bad(`${id}.key.caseInsensitiveQuery`, "must be true or false");
  const fieldCheck = (x: string) => {
    const p = parseFieldPattern(x);
    return typeof p === "string" ? p : null;
  };
  const ignoreQuery = strList(k["ignoreQuery"], `${id}.key.ignoreQuery`, (x) => (/[\0\r\n]/.test(x) ? "cannot hold NUL or line breaks" : null));
  const ignoreBodyFields = strList(k["ignoreBodyFields"], `${id}.key.ignoreBodyFields`, fieldCheck);
  if (ignoreBodyFields.length > 0 && (bodyMode === "raw" || bodyMode === "none")) throw bad(`${id}.key.ignoreBodyFields`, `needs body "form", "json" or "decoded" (body "${bodyMode}" has no fields)`);
  const compare = s["compare"] ?? "status+body";
  if (typeof compare !== "string" || !COMPARE_MODES.some((c) => c === compare)) throw bad(`${id}.response.compare`, `must be one of ${COMPARE_MODES.map((c) => JSON.stringify(c)).join(", ")}`);
  const compareMode = COMPARE_MODES.find((c) => c === compare) ?? "status+body";
  const respDecode = pluginName(s["decodeWith"], `${id}.response.decodeWith`);
  if (respDecode !== null && compareMode !== "status+decoded-body") throw bad(`${id}.response.decodeWith`, 'needs compare "status+decoded-body"');
  const ignorePaths = strList(s["ignorePaths"], `${id}.response.ignorePaths`, fieldCheck);
  if (ignorePaths.length > 0 && compareMode === "status") throw bad(`${id}.response.ignorePaths`, 'compare "status" compares no body');
  const pr = raw["prefer"] ?? "recorded";
  const prefer = PREFER_MODES.find((x) => x === pr);
  if (prefer === undefined) throw bad(`${id}.prefer`, `must be one of ${PREFER_MODES.map((x) => JSON.stringify(x)).join(", ")}`);
  return compileRule({
    id,
    match: { host, path, method: method === null ? null : method.toUpperCase() },
    key: { ignoreQuery, ignoreBodyFields, body: bodyMode, decodeWith: keyDecode, caseInsensitiveQuery: ci === true },
    response: { compare: compareMode, ignorePaths, decodeWith: respDecode },
    prefer,
  });
}

/** Parse a rules document (`{schema?, rules}`); `prefix` names the rules in ids (`rules`, `replay.rules`, …). */
export function parseRulesDoc(raw: unknown, prefix: string, opts: { requireSchema: boolean; where: string }): CompiledRule[] {
  if (!isRecord(raw)) throw bad(opts.where, "must be a JSON object {schema, rules}");
  onlyKeys(raw, ["schema", "rules"], opts.where);
  if (raw["schema"] !== undefined || opts.requireSchema) {
    if (raw["schema"] !== RULES_SCHEMA) throw bad(`${opts.where}.schema`, `must be ${JSON.stringify(RULES_SCHEMA)}`);
  }
  const list = raw["rules"];
  if (!Array.isArray(list) || list.length > MAX_RULES) throw bad(`${opts.where}.rules`, `must be a list of at most ${MAX_RULES} rules`);
  return list.map((r, i) => parseRule(r, `${prefix}[${i}]`));
}

/** Read and validate a `--rules <file>`. */
export function readRulesFile(file: string): RuleSet {
  if (!existsSync(file)) throw new TabcapError("not-found", `rules file not found: ${file}`, "Check the path of the replay-rules.json file.");
  const st = statSync(file);
  if (!st.isFile()) throw new TabcapError("bad-input", `rules file is not a file: ${file}`, "Pass the path of a replay-rules.json file.");
  if (st.size > MAX_RULES_FILE_BYTES) throw new TabcapError("bad-input", `rules file is over ${MAX_RULES_FILE_BYTES} bytes: ${file}`, "Keep the rules file small; it holds rules, not data.");
  const raw = tryParseJson(readFileSync(file, "utf8"));
  if (raw === undefined) throw new TabcapError("bad-input", `rules file is not valid JSON: ${file}`, `Write a JSON object {"schema": "${RULES_SCHEMA}", "rules": […]}.`);
  return { rules: parseRulesDoc(raw, "rules", { requireSchema: true, where: "file" }), source: { kind: "file", file } };
}

/** Rules from config.json: `sites.<site>.replay` first, then `replay`; none: NO_RULES. */
export function rulesFromConfig(file: string, site: string | null): RuleSet {
  if (!existsSync(file)) return NO_RULES;
  const raw = tryParseJson(readFileSync(file, "utf8"));
  if (!isRecord(raw)) return NO_RULES;
  const out: CompiledRule[] = [];
  if (site !== null) {
    const sites = raw["sites"];
    if (sites !== undefined && sites !== null) {
      if (!isRecord(sites)) throw new TabcapError("bad-input", "config.json sites is invalid", "Set sites to an object {<site>: {replay: {rules: [...]}}}, or remove it.");
      const entry = sites[site];
      if (entry !== undefined && entry !== null) {
        if (!isRecord(entry)) throw new TabcapError("bad-input", `config.json sites.${site} is invalid`, `Set sites.${site} to an object, or remove it.`);
        const r = entry["replay"];
        if (r !== undefined && r !== null) out.push(...parseRulesDoc(r, `sites.${site}.replay.rules`, { requireSchema: false, where: `config.json sites.${site}.replay` }));
      }
    }
  }
  const g = raw["replay"];
  if (g !== undefined && g !== null) out.push(...parseRulesDoc(g, "replay.rules", { requireSchema: false, where: "config.json replay" }));
  return out.length === 0 ? NO_RULES : { rules: out, source: { kind: "config", file, site } };
}

/** `--rules <file>` when given (only that file), else config.json. */
export function loadRules(opts: { file?: string | undefined; configFile: string; site: string | null }): RuleSet {
  return opts.file !== undefined ? readRulesFile(opts.file) : rulesFromConfig(opts.configFile, opts.site);
}

/** What an answer says about the rules in use. */
export function rulesInfo(set: RuleSet): { source: "file" | "config" | "none"; file?: string; site?: string | null; rules: number } {
  const s = set.source;
  if (s.kind === "file") return { source: "file", file: s.file, rules: set.rules.length };
  if (s.kind === "config") return { source: "config", file: s.file, site: s.site, rules: set.rules.length };
  return { source: "none", rules: set.rules.length };
}

// ------------------------------------------------------------ selection

/** The first rule whose match fits (host, path, method), else DEFAULT_RULE. */
export function pickRule(set: RuleSet, req: { url: string; method: string }): CompiledRule {
  if (set.rules.length === 0) return DEFAULT_RULE;
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return DEFAULT_RULE;
  }
  const method = req.method.toUpperCase();
  for (const r of set.rules) {
    if (r.match.method !== null && r.match.method !== method) continue;
    if (r.hostRe !== null && !r.hostRe.test((r.match.host ?? "").includes(":") ? u.host.toLowerCase() : u.hostname.toLowerCase())) continue;
    if (r.pathRe !== null && !r.pathRe.test(u.pathname)) continue;
    return r;
  }
  return DEFAULT_RULE;
}

// ------------------------------------------------------------ canonical query

export type CanonQuery = {
  /** Kept pairs, sorted by name then value (lowercased with caseInsensitiveQuery). */
  pairs: [string, string][];
  /** Dropped by ignoreQuery: name → values joined (to tell which ignored parts differed). */
  ignored: Map<string, string>;
};

const byPair = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

export function canonicalQuery(search: string, rule: CompiledRule): CanonQuery {
  const ci = rule.key.caseInsensitiveQuery;
  const pairs: [string, string][] = [];
  const ignored = new Map<string, string[]>();
  for (const [k0, v0] of new URLSearchParams(search)) {
    const k = ci ? k0.toLowerCase() : k0;
    const v = ci ? v0.toLowerCase() : v0;
    if (rule.queryRes.some((re) => re.test(k))) ignored.set(k, [...(ignored.get(k) ?? []), v]);
    else pairs.push([k, v]);
  }
  return { pairs: pairs.sort(byPair), ignored: new Map([...ignored].map(([k, vs]) => [k, JSON.stringify(vs)])) };
}

export function queryString(pairs: readonly [string, string][]): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** A URL with the rule's ignored query parameters removed (HAR export --rules); the rest is untouched. */
export function dropIgnoredQuery(url: string, rule: CompiledRule): string {
  if (rule.queryRes.length === 0) return url;
  const hash = url.indexOf("#");
  const noFrag = hash < 0 ? url : url.slice(0, hash);
  const frag = hash < 0 ? "" : url.slice(hash);
  const q = noFrag.indexOf("?");
  if (q < 0) return url;
  const ci = rule.key.caseInsensitiveQuery;
  const kept = noFrag
    .slice(q + 1)
    .split("&")
    .filter((part) => {
      if (part === "") return false;
      const eq = part.indexOf("=");
      let name = eq < 0 ? part : part.slice(0, eq);
      try {
        name = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        // keep the raw spelling
      }
      const n = ci ? name.toLowerCase() : name;
      return !rule.queryRes.some((re) => re.test(n));
    });
  return `${noFrag.slice(0, q)}${kept.length === 0 ? "" : `?${kept.join("&")}`}${frag}`;
}

// ------------------------------------------------------------ canonical body

export type CanonBody = {
  mode: BodyMode;
  /** How the bytes were read: form pairs, canonical JSON, raw bytes, or left out. */
  as: "form" | "json" | "raw" | "none";
  /** sha256 of the canonical text (form / json) or of the bytes (raw); "" for none. */
  digest: string;
  /** Canonical text (form / json), or null. */
  text: string | null;
  /** Kept fields: form name or JSON path → value (diagnostics). */
  fields: Map<string, string> | null;
  /** Dropped by ignoreBodyFields: name / path → value. */
  ignored: Map<string, string>;
  /** Why the rule's reading could not be used and raw bytes were keyed instead (not-utf8, not-json, not-decoded: …). */
  fallback: string | null;
};

const PATH_IDENT = /^[A-Za-z_$][\w$]*$/;
const pathKey = (p: string, k: string) => (PATH_IDENT.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);

function ignoredAt(patterns: readonly FieldPattern[], steps: readonly (string | number)[]): boolean {
  return patterns.some((p) => p.segs.length === steps.length && p.segs.every((s, i) => segMatches(s, steps[i] ?? "")));
}

const DROP = Symbol("drop");

/**
 * Canonical JSON: object keys sorted, nodes the patterns name dropped (with
 * everything under them). Null when the document is too deep or too large.
 */
export function canonicalJson(value: unknown, patterns: readonly FieldPattern[]): { value: unknown; fields: Map<string, string>; ignored: Map<string, string> } | null {
  const fields = new Map<string, string>();
  const ignored = new Map<string, string>();
  let nodes = 0;
  const walk = (v: unknown, steps: (string | number)[], path: string): unknown => {
    if (++nodes > MAX_JSON_NODES || steps.length > MAX_JSON_DEPTH) throw new RangeError("too large");
    if (steps.length > 0 && ignoredAt(patterns, steps)) {
      ignored.set(path, JSON.stringify(v) ?? "null");
      return DROP;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      v.forEach((x, i) => {
        const w = walk(x, [...steps, i], `${path}[${i}]`);
        if (w !== DROP) out.push(w);
      });
      if (out.length === 0) fields.set(path, "[]");
      return out;
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        const w = walk(x, [...steps, k], pathKey(path, k));
        if (w !== DROP) out[k] = w;
      }
      if (Object.keys(out).length === 0) fields.set(path, "{}");
      return out;
    }
    fields.set(path, JSON.stringify(v) ?? "null");
    return v;
  };
  try {
    const out = walk(value, [], "$");
    return { value: out === DROP ? null : out, fields, ignored };
  } catch {
    return null;
  }
}

function rawBody(bytes: Uint8Array, mode: BodyMode, fallback: string | null): CanonBody {
  return { mode, as: "raw", digest: sha256Hex(bytes), text: null, fields: null, ignored: new Map(), fallback };
}

function formBody(text: string, mode: BodyMode, patterns: readonly FieldPattern[]): CanonBody {
  const names = new Set(patterns.flatMap((p) => (p.name === null ? [] : [p.name])));
  const kept: [string, string][] = [];
  const ignored = new Map<string, string[]>();
  for (const [k, v] of new URLSearchParams(text)) {
    if (names.has(k)) ignored.set(k, [...(ignored.get(k) ?? []), v]);
    else kept.push([k, v]);
  }
  kept.sort(byPair);
  const canon = queryString(kept);
  const fields = new Map<string, string[]>();
  for (const [k, v] of kept) fields.set(k, [...(fields.get(k) ?? []), v]);
  return {
    mode,
    as: "form",
    digest: sha256Hex(new TextEncoder().encode(canon)),
    text: canon,
    fields: new Map([...fields].map(([k, vs]) => [k, JSON.stringify(vs)])),
    ignored: new Map([...ignored].map(([k, vs]) => [k, JSON.stringify(vs)])),
    fallback: null,
  };
}

function jsonBody(bytes: Uint8Array, text: string, mode: BodyMode, patterns: readonly FieldPattern[]): CanonBody {
  const doc = parseJsonDoc(text);
  if (doc === null) return rawBody(bytes, mode, "not-json");
  const c = canonicalJson(doc.value, patterns);
  if (c === null) return rawBody(bytes, mode, "json-too-large");
  const canon = JSON.stringify(c.value) ?? "null";
  return { mode, as: "json", digest: sha256Hex(new TextEncoder().encode(canon)), text: canon, fields: c.fields, ignored: c.ignored, fallback: null };
}

const FORM_MIME = "application/x-www-form-urlencoded";

/**
 * The body part of a match key under `rule`. `bytes` are the original body;
 * `plain` is the decoded view for body "decoded" (null: could not decode,
 * with the reason). The canonicalisation table (docs/04 §31):
 *   raw      sha256 of the bytes (0.3-B)
 *   form     application/x-www-form-urlencoded pairs, ignored names dropped, sorted
 *   json     canonical JSON (keys sorted), ignored paths dropped; not JSON → raw
 *   decoded  the plaintext: form when its mime says so, else JSON, else its raw bytes;
 *            no plaintext → raw bytes of the original
 *   none     left out of the key
 */
export function canonicalBody(bytes: Uint8Array, rule: CompiledRule, plain: { bytes: Uint8Array; mime: string | null } | { error: string } | null = null): CanonBody {
  const mode = rule.key.body;
  const fields = rule.bodyFields;
  if (mode === "none") return { mode, as: "none", digest: "", text: null, fields: null, ignored: new Map(), fallback: null };
  if (mode === "raw") return rawBody(bytes, mode, null);
  if (mode === "decoded") {
    if (plain === null || "error" in plain) return rawBody(bytes, mode, `not-decoded: ${plain === null ? "no decoded view" : plain.error}`);
    const t = utf8(plain.bytes);
    if (t === null) return rawBody(plain.bytes, mode, null);
    if (baseMime(plain.mime) === FORM_MIME) return formBody(t, mode, fields);
    const j = jsonBody(plain.bytes, t, mode, fields);
    return j.as === "json" ? j : rawBody(plain.bytes, mode, null);
  }
  const text = utf8(bytes);
  if (text === null) return rawBody(bytes, mode, "not-utf8");
  return mode === "form" ? formBody(text, mode, fields) : jsonBody(bytes, text, mode, fields);
}

/** The key text of a canonical body: what fixtures show as `key.body`. */
export function bodyKeyText(b: CanonBody): string | null {
  if (b.as === "none") return null;
  if (b.as === "raw" || b.text === null) return `sha256:${b.digest}`;
  return b.text.length > MAX_KEY_TEXT ? `sha256:${b.digest}` : b.text;
}

/** The body component of a match key. */
export function bodyKeyPart(b: CanonBody): string {
  return b.as === "none" ? "none" : `${b.as}:${b.digest}`;
}

/** Names / paths whose ignored values differ between two sides (present on one only, or different values). */
export function differingIgnored(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const [k, v] of a) if (b.get(k) !== v) out.add(k);
  for (const k of b.keys()) if (!a.has(k)) out.add(k);
  return [...out].sort();
}

/** A response JSON value without the rule's ignorePaths (replay check); too large to walk: unchanged. */
export function stripResponseJson(value: unknown, rule: CompiledRule): unknown {
  if (rule.responsePaths.length === 0) return value;
  const c = canonicalJson(value, rule.responsePaths);
  return c === null ? value : c.value;
}
