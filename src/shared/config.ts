// ~/.config/tabcap/config.json: written by `tabcap setup`, read by the launcher
// and the account / proxy pool. The file is user-editable, so it is parsed as
// untrusted JSON; keys tabcap does not write itself (e.g. `pool`) survive a
// rewrite by `tabcap setup`. Review wave 3 (docs/04 §44): a file that exists
// but is not a JSON object is an error on every path that reads it, never
// the defaults; `tabcap setup` does not rewrite it. Owner 2026-10-22: one
// leading UTF-8 byte order mark is skipped, and a value of the wrong JSON type
// under a key whose reader ignores it (`kind` in CONFIG_KEYS) is named by
// `configWarnings` after the unknown keys; `tabcap setup` keeps such a value of
// `proxy` / `webdriver` in the file instead of rewriting it as null.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { TabcapError } from "./envelope.ts";
import { isRecord, jsonSyntaxErrorAt, lineColumn, str } from "./json.ts";
import { BODIES_DEFAULT, parseBodiesMode, type BodiesMode } from "./bodies.ts";

export type TabcapConfig = {
  chrome: { executablePath: string; version: string | null; platform: string | null } | null;
  /** Default for `browser start --proxy`: "system" | "none" | <url>. */
  proxy: string | null;
  /** Default for `browser start --webdriver`: "hidden" | "visible" (docs/04 §40). */
  webdriver: string | null;
};

/**
 * The whole config.json as an object; an absent file is `{}`. A file that cannot be read, is not
 * JSON (the message names the file and the line / column of the first syntax error) or is not an
 * object is an error: nothing falls back to the defaults, and `writeConfig` rewrites nothing.
 * One leading byte order mark (U+FEFF, as Windows editors save it) is skipped before parsing, and
 * line / column count from the character after it.
 */
export function readConfigRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new TabcapError("io", `cannot read config.json: ${file}: ${e instanceof Error ? e.message : String(e)}`, "Check that it is a file you can read, or move it away.");
  }
  // JSON.parse refuses a byte order mark; drop one before parsing and before locating a syntax error.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/^JSON Parse error: /, "");
    const at = jsonSyntaxErrorAt(text);
    const where = at === null ? null : lineColumn(text, at);
    const pos = where === null ? "" : ` at line ${where.line}, column ${where.column}`;
    throw new TabcapError(
      "bad-input",
      `config.json is not valid JSON${pos} (${reason}): ${file}`,
      `Fix the file${where === null ? "" : ` at line ${where.line}, column ${where.column}`} (a trailing comma or a missing quote is the usual cause), or move it away to use the defaults; until then commands that read config.json refuse and \`tabcap setup\` does not rewrite it.`,
    );
  }
  if (!isRecord(raw)) {
    const what = raw === null ? "null" : Array.isArray(raw) ? "an array" : `a ${typeof raw}`;
    throw new TabcapError("bad-input", `config.json must be a JSON object, not ${what}: ${file}`, 'Write the settings as one JSON object ({"fetch": {...}, "sites": {...}}), or move the file away to use the defaults.');
  }
  return raw;
}

/**
 * `chrome` (executablePath, version, platform) / `proxy` / `webdriver`. A value of the wrong JSON type is read as
 * absent, like null; `configWarnings` names it (these keys carry a `kind` in CONFIG_KEYS).
 */
export function readConfig(file: string): TabcapConfig {
  const raw = readConfigRaw(file);
  const c = raw[cfgKey("", "chrome")];
  const exe = cfgKey("chrome", "executablePath");
  const chrome =
    isRecord(c) && str(c, exe) !== null
      ? { executablePath: str(c, exe) ?? "", version: str(c, cfgKey("chrome", "version")), platform: str(c, cfgKey("chrome", "platform")) }
      : null;
  return { chrome, proxy: str(raw, cfgKey("", "proxy")), webdriver: str(raw, cfgKey("", "webdriver")) };
}

/**
 * Write `chrome` (executablePath / version / platform) and `proxy` / `webdriver`, keeping every other key of
 * the file (and of `chrome`, e.g. `args`) as it was. A `proxy` / `webdriver` the file has with the wrong JSON
 * type, which `readConfig` reads as null, is kept as it is when `cfg` leaves it null (owner 2026-10-22: `tabcap
 * setup` does not erase what the user wrote, and its `warnings` still name it); otherwise null is written,
 * as before. A file `readConfigRaw` refuses is left exactly as it is (the same error; no backup). The file
 * is written from the parsed object, so a byte order mark the old file started with is not written back.
 */
export function writeConfig(file: string, cfg: { chrome: NonNullable<TabcapConfig["chrome"]>; proxy: string | null; webdriver: string | null }): void {
  const raw = readConfigRaw(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const old = raw[cfgKey("", "chrome")];
  const chrome = { ...(isRecord(old) ? old : {}), ...cfg.chrome };
  const kept = (k: "proxy" | "webdriver", v: string | null): unknown => {
    const was = raw[cfgKey("", k)];
    return v === null && was !== undefined && was !== null && typeof was !== "string" ? was : v;
  };
  writeFileAtomic(file, JSON.stringify({ ...raw, ...cfg, proxy: kept("proxy", cfg.proxy), webdriver: kept("webdriver", cfg.webdriver), chrome }, null, 2) + "\n");
}

/**
 * 0.8.1-A: `chrome.args` / `chrome.dropArgs`, the defaults for `browser start
 * --chrome-arg` / `--drop-chrome-arg` (docs/04 §42). Absent = none; anything
 * but a list of strings is an error (never silently ignored).
 */
export function readChromeArgsConfig(file: string): { add: string[]; drop: string[] } {
  const c = readConfigRaw(file)[cfgKey("", "chrome")];
  const list = (key: ConfigKeyOf<"chrome">): string[] => {
    const v = isRecord(c) ? c[key] : undefined;
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
      throw new TabcapError("bad-input", `config.json chrome.${key} must be a list of strings`, `Write it as "${key}": ["--name=value", …], or remove it.`);
    }
    return v;
  };
  return { add: list(cfgKey("chrome", "args")), drop: list(cfgKey("chrome", "dropArgs")) };
}

// ------------------------------------------------------------ pool (0.4-D)

export type PoolStrategy = "fixed" | "round-robin" | "lru";

/**
 * `config.json` `pool` (docs/08 §3 0.4, owner design 10-16):
 *   {strategy: "fixed"|"round-robin"|"lru",
 *    egress: {mode: "fixed"|"rotate", rotateOn: "per-session"|"every:<N>requests"|"every:<T>min"},
 *    health: {url: null|<url>, intervalS: 300},
 *    budget: {requestsPerHour: null|<n>}}
 * Every key is optional; the defaults are the values above (no hourly budget
 * unless configured). `rotateOn` is checked by the pool (rules.ts).
 */
export type PoolConfig = {
  strategy: PoolStrategy;
  egress: { mode: "fixed" | "rotate"; rotateOn: string };
  health: { url: string | null; intervalS: number };
  budget: { requestsPerHour: number | null };
};

export const POOL_DEFAULTS: PoolConfig = {
  strategy: "fixed",
  egress: { mode: "fixed", rotateOn: "per-session" },
  health: { url: null, intervalS: 300 },
  budget: { requestsPerHour: null },
};

const badPool = (what: string, want: string) => new TabcapError("bad-input", `config.json pool.${what} is invalid`, `Set pool.${what} to ${want}, or remove it for the default.`);

/** Parse `pool` of a config.json object; a wrong value is an error (never silently replaced). */
export function parsePoolConfig(raw: unknown): PoolConfig {
  if (raw === undefined || raw === null) return structuredClone(POOL_DEFAULTS);
  if (!isRecord(raw)) throw badPool("", "an object");
  const out = structuredClone(POOL_DEFAULTS);
  const st = raw[cfgKey("pool", "strategy")];
  if (st !== undefined) {
    if (st !== "fixed" && st !== "round-robin" && st !== "lru") throw badPool("strategy", '"fixed", "round-robin" or "lru"');
    out.strategy = st;
  }
  const eg = raw[cfgKey("pool", "egress")];
  if (eg !== undefined) {
    if (!isRecord(eg)) throw badPool("egress", "an object");
    const mode = eg[cfgKey("pool.egress", "mode")];
    if (mode !== undefined) {
      if (mode !== "fixed" && mode !== "rotate") throw badPool("egress.mode", '"fixed" or "rotate"');
      out.egress.mode = mode;
    }
    const on = eg[cfgKey("pool.egress", "rotateOn")];
    if (on !== undefined) {
      if (typeof on !== "string") throw badPool("egress.rotateOn", '"per-session", "every:<N>requests" or "every:<T>min"');
      out.egress.rotateOn = on;
    }
  }
  const h = raw[cfgKey("pool", "health")];
  if (h !== undefined) {
    if (!isRecord(h)) throw badPool("health", "an object");
    const url = h[cfgKey("pool.health", "url")];
    if (url !== undefined && url !== null) {
      if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url)) throw badPool("health.url", "null or an http(s) URL");
      out.health.url = url;
    }
    const iv = h[cfgKey("pool.health", "intervalS")];
    if (iv !== undefined) {
      if (typeof iv !== "number" || !Number.isFinite(iv) || iv < 10) throw badPool("health.intervalS", "a number of seconds (at least 10)");
      out.health.intervalS = iv;
    }
  }
  const b = raw[cfgKey("pool", "budget")];
  if (b !== undefined) {
    if (!isRecord(b)) throw badPool("budget", "an object");
    const n = b[cfgKey("pool.budget", "requestsPerHour")];
    if (n !== undefined && n !== null) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw badPool("budget.requestsPerHour", "null or a positive integer");
      out.budget.requestsPerHour = n;
    }
  }
  return out;
}

export function readPoolConfig(file: string): PoolConfig {
  return parsePoolConfig(readConfigRaw(file)[cfgKey("", "pool")]);
}

// ------------------------------------------------------------ fetch (0.6-A)

/**
 * `config.json` `fetch` (owner design 10-16): pacing and stop rules of
 * `tabcap fetch`, per host: {minIntervalMs: 3000, concurrency: 1, stopOn: []};
 * `sites.<name>.fetch` overrides any of these keys for one store site.
 * Stop rule syntax is checked when a fetch uses them (daemon/fetch/stoprules.ts).
 */
export type FetchConfig = { minIntervalMs: number; concurrency: number; stopOn: string[] };

export const FETCH_DEFAULTS: FetchConfig = { minIntervalMs: 3000, concurrency: 1, stopOn: [] };

const badFetch = (where: string, what: string, want: string) => new TabcapError("bad-input", `config.json ${where}.${what} is invalid`, `Set ${where}.${what} to ${want}, or remove it for the default.`);

/** Parse one `fetch` object over `base`; a wrong value is an error (never silently replaced). */
export function parseFetchConfig(raw: unknown, base: FetchConfig = FETCH_DEFAULTS, where = "fetch"): FetchConfig {
  const out: FetchConfig = { ...base, stopOn: [...base.stopOn] };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new TabcapError("bad-input", `config.json ${where} is invalid`, `Set ${where} to an object, or remove it.`);
  const iv = raw[cfgKey("fetch", "minIntervalMs")];
  if (iv !== undefined) {
    if (typeof iv !== "number" || !Number.isInteger(iv) || iv < 0 || iv > 3_600_000) throw badFetch(where, "minIntervalMs", "an integer number of ms (0 to 3600000)");
    out.minIntervalMs = iv;
  }
  const c = raw[cfgKey("fetch", "concurrency")];
  if (c !== undefined) {
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 16) throw badFetch(where, "concurrency", "an integer from 1 to 16");
    out.concurrency = c;
  }
  const s = raw[cfgKey("fetch", "stopOn")];
  if (s !== undefined) {
    if (!Array.isArray(s) || !s.every((x) => typeof x === "string")) throw badFetch(where, "stopOn", "a list of stop rule strings");
    out.stopOn = s.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** The fetch settings for a store site (null: none matched): `fetch`, then `sites.<site>.fetch` on top. */
export function fetchConfigFrom(raw: Record<string, unknown>, site: string | null): FetchConfig {
  const global = parseFetchConfig(raw[cfgKey("", "fetch")]);
  if (site === null) return global;
  const sites = raw[cfgKey("", "sites")];
  if (sites === undefined || sites === null) return global;
  if (!isRecord(sites)) throw new TabcapError("bad-input", "config.json sites is invalid", "Set sites to an object {<site>: {fetch: {...}}}, or remove it.");
  const entry = sites[site];
  if (entry === undefined || entry === null) return global;
  if (!isRecord(entry)) throw new TabcapError("bad-input", `config.json sites.${site} is invalid`, `Set sites.${site} to an object, or remove it.`);
  return parseFetchConfig(entry[cfgKey("sites.<site>", "fetch")], global, `sites.${site}.fetch`);
}

export function readFetchConfig(file: string, site: string | null): FetchConfig {
  return fetchConfigFrom(readConfigRaw(file), site);
}

// ------------------------------------------------------------ record (0.6-I)

/** `config.json` `record: {bodies: "all"|"api"|"api+script"|"none"}`: the default of `net start --bodies`. */
export function recordBodiesFrom(raw: Record<string, unknown>): BodiesMode {
  const r = raw[cfgKey("", "record")];
  if (r === undefined || r === null) return BODIES_DEFAULT;
  if (!isRecord(r)) throw new TabcapError("bad-input", "config.json record is invalid", "Set record to an object {bodies: ...}, or remove it.");
  const b = r[cfgKey("record", "bodies")];
  return b === undefined || b === null ? BODIES_DEFAULT : parseBodiesMode(b, "config");
}

export function readRecordBodies(file: string): BodiesMode {
  return recordBodiesFrom(readConfigRaw(file));
}

// ------------------------------------------------------------ site guard (0.6-I)

/**
 * `config.json` `sites.<name>.guard` (owner design 10-16): stop rules the
 * guard checks on every recorded response of the site, in every session:
 * {stopOn: [<rule>…], consecutiveNon200: <N>|null, endOn: [<rule>…]}. Rule
 * syntax is the one of `tabcap fetch --stop-on` (daemon/fetch/stoprules.ts),
 * checked by the guard. 0.7.5-A: `endOn` rules mark "the list has ended"; a
 * response they match skips every stop rule (docs/04 §38).
 */
export type SiteGuardConfig = { stopOn: string[]; consecutiveNon200: number | null; endOn: string[] };

/** Parse one `sites.<site>.guard` object; a wrong value is an error (never silently replaced). */
export function parseSiteGuard(raw: unknown, site: string): SiteGuardConfig {
  const where = `sites.${site}.guard`;
  if (raw === undefined || raw === null) return { stopOn: [], consecutiveNon200: null, endOn: [] };
  if (!isRecord(raw)) throw new TabcapError("bad-input", `config.json ${where} is invalid`, `Set ${where} to an object {stopOn: [...], consecutiveNon200: N, endOn: [...]}, or remove it.`);
  const out: SiteGuardConfig = { stopOn: [], consecutiveNon200: null, endOn: [] };
  const s = raw[cfgKey("sites.<site>.guard", "stopOn")];
  if (s !== undefined && s !== null) {
    if (!Array.isArray(s) || !s.every((x) => typeof x === "string")) throw badFetch(where, "stopOn", "a list of stop rule strings");
    out.stopOn = s.filter((x): x is string => typeof x === "string");
  }
  const n = raw[cfgKey("sites.<site>.guard", "consecutiveNon200")];
  if (n !== undefined && n !== null) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10_000) throw badFetch(where, "consecutiveNon200", "null or an integer from 1 to 10000");
    out.consecutiveNon200 = n;
  }
  const e = raw[cfgKey("sites.<site>.guard", "endOn")];
  if (e !== undefined && e !== null) {
    if (!Array.isArray(e) || !e.every((x) => typeof x === "string")) throw badFetch(where, "endOn", "a list of end rule strings (the stop rule syntax)");
    out.endOn = e.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** Every site's `guard` settings that say something (no rule and no counter: left out). */
export function siteGuardsFrom(raw: Record<string, unknown>): Map<string, SiteGuardConfig> {
  const out = new Map<string, SiteGuardConfig>();
  const sites = raw[cfgKey("", "sites")];
  if (sites === undefined || sites === null) return out;
  if (!isRecord(sites)) throw new TabcapError("bad-input", "config.json sites is invalid", "Set sites to an object {<site>: {guard: {...}}}, or remove it.");
  for (const [name, entry] of Object.entries(sites)) {
    if (entry === undefined || entry === null) continue;
    if (!isRecord(entry)) throw new TabcapError("bad-input", `config.json sites.${name} is invalid`, `Set sites.${name} to an object, or remove it.`);
    const g = parseSiteGuard(entry[cfgKey("sites.<site>", "guard")], name);
    if (g.stopOn.length > 0 || g.consecutiveNon200 !== null || g.endOn.length > 0) out.set(name, g);
  }
  return out;
}

export function readSiteGuards(file: string): Map<string, SiteGuardConfig> {
  return siteGuardsFrom(readConfigRaw(file));
}

// ------------------------------------------------------------ trace (0.6-L)

/**
 * `config.json` `trace` (docs/04 §33): {decode: false, weakRows: true}.
 * `decode` turns on the observe mode of `tabcap trace start` for every
 * session that does not pass an explicit `--decode` / `--no-decode`.
 * `weakRows` (0.6-V, owner decisions 10-17): file single-suspect rows
 * (`evidence.link: "weak"`), the default; `false` turns them off — on real
 * sites every one was wrong — and counts them as `drops.weak` instead.
 */
export type TraceConfig = { decode: boolean; weakRows: boolean };

export const TRACE_DEFAULTS: TraceConfig = { decode: false, weakRows: true };

export function parseTraceConfig(raw: unknown, base: TraceConfig = TRACE_DEFAULTS, where = "trace"): TraceConfig {
  const out: TraceConfig = { ...base };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new TabcapError("bad-input", `config.json ${where} is invalid`, `Set ${where} to an object {decode: true|false, weakRows: true|false}, or remove it.`);
  for (const key of ["decode", "weakRows"] as const) {
    const v = raw[cfgKey("trace", key)];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new TabcapError("bad-input", `config.json ${where}.${key} is invalid`, `Set ${where}.${key} to true or false, or remove it.`);
    out[key] = v;
  }
  return out;
}

export function readTraceConfig(file: string): TraceConfig {
  return parseTraceConfig(readConfigRaw(file)[cfgKey("", "trace")]);
}

// ------------------------------------------------------------ handoff (0.7.1-A)

/**
 * `config.json` `handoff` (docs/04 §37): {detectTakeover: true}. `detectTakeover`
 * arms the passive take-over listener on every owned tab in `direct` mode; it
 * is read at `browser start`. A value that is not a boolean is an error.
 */
export type HandoffConfig = { detectTakeover: boolean };

export const HANDOFF_DEFAULTS: HandoffConfig = { detectTakeover: true };

export function parseHandoffConfig(raw: unknown): HandoffConfig {
  const out: HandoffConfig = { ...HANDOFF_DEFAULTS };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new TabcapError("bad-input", "config.json handoff is invalid", "Set handoff to an object {detectTakeover: true|false}, or remove it.");
  const v = raw[cfgKey("handoff", "detectTakeover")];
  if (v === undefined) return out;
  if (typeof v !== "boolean") throw new TabcapError("bad-input", "config.json handoff.detectTakeover is invalid", "Set handoff.detectTakeover to true or false, or remove it.");
  out.detectTakeover = v;
  return out;
}

export function readHandoffConfig(file: string): HandoffConfig {
  return parseHandoffConfig(readConfigRaw(file)[cfgKey("", "handoff")]);
}

// ------------------------------------------------------------ protection (0.8-A)

/**
 * `config.json` `protection` (docs/04 §41.3; review 10-21, owner decision): {live: true}.
 * `live` turns the once-per-navigation live probe on (the default) or off; it is read
 * at `browser start`. A value that is not a boolean is an error.
 */
export type ProtectionConfig = { live: boolean };

export const PROTECTION_DEFAULTS: ProtectionConfig = { live: true };

export function parseProtectionConfig(raw: unknown): ProtectionConfig {
  const out: ProtectionConfig = { ...PROTECTION_DEFAULTS };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new TabcapError("bad-input", "config.json protection is invalid", "Set protection to an object {live: true|false}, or remove it.");
  const v = raw[cfgKey("protection", "live")];
  if (v === undefined) return out;
  if (typeof v !== "boolean") throw new TabcapError("bad-input", "config.json protection.live is invalid", "Set protection.live to true or false, or remove it.");
  out.live = v;
  return out;
}

export function readProtectionConfig(file: string): ProtectionConfig {
  return parseProtectionConfig(readConfigRaw(file)[cfgKey("", "protection")]);
}

// ------------------------------------------------------------ the key table (review wave 3)

/** The JSON type a key's value must have: a string, or an object (not an array). */
export type ConfigKind = "string" | "object";

/**
 * One key of config.json as the key table shows it (skills/tabcap/references/config.md, generated by
 * `bun run gen:docs`): its type and default as a reader would write them, one sentence, and the
 * docs/04 section that specifies it (null: docs/04 has none). `kind` (owner 2026-10-22) is set only
 * on the keys whose reader reads a value of another JSON type as absent instead of refusing it
 * (`readConfig`): `configWarnings` names such a value; null is the same as an absent key there.
 */
export type ConfigKeyInfo = { type: string; default: string; about: string; doc: string | null; kind?: ConfigKind };

const shown = (v: unknown): string => JSON.stringify(v);

const FETCH_KEYS = {
  minIntervalMs: { type: "integer (ms, 0–3600000)", default: shown(FETCH_DEFAULTS.minIntervalMs), about: "least time between two requests `tabcap fetch` sends to one host (also the floor of `replay check --live`)", doc: "§26" },
  concurrency: { type: "integer (1–16)", default: shown(FETCH_DEFAULTS.concurrency), about: "requests `tabcap fetch` keeps in flight per host", doc: "§26" },
  stopOn: { type: "string[] (stop rules)", default: shown(FETCH_DEFAULTS.stopOn), about: "stop rules checked on every `tabcap fetch` answer; one that matches stops the site's fetches", doc: "§26" },
} as const satisfies Record<string, ConfigKeyInfo>;

const REPLAY_KEYS = {
  schema: { type: '"tabcap-replay-rules/0"', default: "—", about: "may be left out here (a `--rules` file must carry it)", doc: "§31" },
  rules: { type: "rule[] ({match, key, response, prefer})", default: "[]", about: "replay key rules: how `replay serve` / `replay check` / `bundle export fixtures` key and compare requests", doc: "§31" },
} as const satisfies Record<string, ConfigKeyInfo>;

/**
 * Every key config.json has, level by level (`""` is the top level, `<site>` stands for any store
 * site name). The readers above name the keys they read through `cfgKey`, which only takes keys
 * listed here; `configWarnings` reports any other key, and a value that is not of its key's `kind`.
 * `replay` and `sites.<site>.replay` are the replay rules (docs/04 §31): their own parser refuses
 * unknown keys, so they are not warned about.
 */
export const CONFIG_KEYS = {
  "": {
    chrome: { type: "object", default: "—", about: "the browser `tabcap setup` recorded, and Chrome switches for `browser start`", doc: "§42", kind: "object" },
    proxy: { type: '"system" | "none" | "<scheme>://host:port"', default: '"system"', about: "default of `browser start --proxy`; no `user:pass@` (store such a proxy with `tabcap proxy add`)", doc: "§42", kind: "string" },
    webdriver: { type: '"hidden" | "visible"', default: '"hidden"', about: "default of `browser start --webdriver`", doc: "§40", kind: "string" },
    pool: { type: "object", default: "—", about: "how `--account auto` picks accounts, proxy rotation, health checks and hourly budgets", doc: null },
    fetch: { type: "object", default: "—", about: "pacing and stop rules of `tabcap fetch` for every host", doc: "§26" },
    sites: { type: "object (store site name → settings)", default: "{}", about: "settings of one store site: `fetch`, `guard`, `replay`", doc: "§26" },
    record: { type: "object", default: "—", about: "recording defaults", doc: "§5.2" },
    trace: { type: "object", default: "—", about: "defaults of `trace start`", doc: "§33" },
    handoff: { type: "object", default: "—", about: "the human take-over listener", doc: "§37" },
    protection: { type: "object", default: "—", about: "the live protection-family probe", doc: "§41.3" },
    replay: { type: "object ({rules: [...]})", default: "—", about: "replay key rules for every bundle, after the site's own", doc: "§31" },
  },
  chrome: {
    executablePath: { type: "string", default: "—", about: "the Chrome for Testing binary, written by `tabcap setup`; `--executable-path` and `$TABCAP_CHROME` come first", doc: null, kind: "string" },
    version: { type: "string", default: "—", about: "its version, written by `tabcap setup`", doc: null, kind: "string" },
    platform: { type: "string | null", default: "—", about: "the build `tabcap setup` downloaded (mac-arm64, mac-x64, linux64, win64); null for `--executable-path`", doc: null, kind: "string" },
    args: { type: "string[]", default: "[]", about: "Chrome switches added at every `browser start`, before `--chrome-arg`", doc: "§42" },
    dropArgs: { type: "string[]", default: "[]", about: "tabcap's own switches removed at every `browser start`, before `--drop-chrome-arg`", doc: "§42" },
  },
  pool: {
    strategy: { type: '"fixed" | "round-robin" | "lru"', default: shown(POOL_DEFAULTS.strategy), about: "how `session start --account auto` picks one of the site's accounts", doc: null },
    egress: { type: "object", default: "—", about: "when an account's proxy is rotated", doc: null },
    health: { type: "object", default: "—", about: "proxy health checks", doc: null },
    budget: { type: "object", default: "—", about: "hourly request budget per account", doc: "§4.1" },
  },
  "pool.egress": {
    mode: { type: '"fixed" | "rotate"', default: shown(POOL_DEFAULTS.egress.mode), about: "keep one proxy per account, or rotate", doc: null },
    rotateOn: { type: '"per-session" | "every:<N>requests" | "every:<T>min"', default: shown(POOL_DEFAULTS.egress.rotateOn), about: "when `rotate` moves to the next proxy", doc: null },
  },
  "pool.health": {
    url: { type: "null | http(s) URL", default: shown(POOL_DEFAULTS.health.url), about: "address fetched through a proxy by `proxy check` (without `--url`) and the periodic check", doc: null },
    intervalS: { type: "number (seconds, ≥ 10)", default: shown(POOL_DEFAULTS.health.intervalS), about: "time between the periodic checks of one proxy", doc: null },
  },
  "pool.budget": {
    requestsPerHour: { type: "null | integer ≥ 1", default: shown(POOL_DEFAULTS.budget.requestsPerHour), about: "requests per account and hour; past it the account's page commands wait for the next hour", doc: "§4.1" },
  },
  fetch: FETCH_KEYS,
  "sites.<site>": {
    fetch: { type: "object", default: "—", about: "`fetch` keys for this site only, over the global ones (a `stopOn` here replaces the global list)", doc: "§26" },
    guard: { type: "object", default: "—", about: "stop / end rules checked on every recorded response of the site, in every session", doc: "§18" },
    replay: { type: "object ({rules: [...]})", default: "—", about: "replay key rules for bundles of this site, before the global `replay`", doc: "§31" },
  },
  "sites.<site>.fetch": FETCH_KEYS,
  "sites.<site>.guard": {
    stopOn: { type: "string[] (stop rules)", default: "[]", about: "a match stops the site's fetches and hands the session to the human (`waiting`, reason stop-rule)", doc: "§18" },
    consecutiveNon200: { type: "null | integer (1–10000)", default: "null", about: "this many non-2xx responses in a row (by arrival) is a stop", doc: "§18" },
    endOn: { type: "string[] (stop rule syntax)", default: "[]", about: "end rules: \"the list has ended\", checked before every stop rule; a match stops nothing", doc: "§38" },
  },
  record: {
    bodies: { type: '"all" | "api" | "api+script" | "none"', default: shown(BODIES_DEFAULT), about: "default of `net start --bodies`: which response bodies are stored", doc: "§5.2" },
  },
  trace: {
    decode: { type: "boolean", default: shown(TRACE_DEFAULTS.decode), about: "default of `trace start --decode` (observe mode)", doc: "§33" },
    weakRows: { type: "boolean", default: shown(TRACE_DEFAULTS.weakRows), about: "file single-suspect decoded rows (`link: weak`); false counts them as `drops.weak`", doc: "§33" },
  },
  handoff: {
    detectTakeover: { type: "boolean", default: shown(HANDOFF_DEFAULTS.detectTakeover), about: "watch owned tabs for human input; read at `browser start`", doc: "§37" },
  },
  protection: {
    live: { type: "boolean", default: shown(PROTECTION_DEFAULTS.live), about: "probe each navigated page for protection families; read at `browser start`", doc: "§41.3" },
  },
  replay: REPLAY_KEYS,
  "sites.<site>.replay": REPLAY_KEYS,
} as const satisfies Record<string, Record<string, ConfigKeyInfo>>;

export type ConfigLayer = keyof typeof CONFIG_KEYS;
export type ConfigKeyOf<L extends ConfigLayer> = keyof (typeof CONFIG_KEYS)[L] & string;

/** The key `k` of `layer`; the compiler refuses a key CONFIG_KEYS does not list there, so a reader cannot read an unlisted key. */
export function cfgKey<L extends ConfigLayer, K extends ConfigKeyOf<L>>(_layer: L, k: K): K {
  return k;
}

/** Levels whose keys are names (store sites), each value being the level named here. */
const NAMED: Readonly<Record<string, ConfigLayer>> = { sites: "sites.<site>" };
/** Levels whose own parser refuses unknown keys (docs/04 §31). */
const STRICT: ReadonlySet<string> = new Set<string>(["replay", "sites.<site>.replay"]);
const MAX_WARNINGS = 20;

const isLayer = (s: string): s is ConfigLayer => Object.hasOwn(CONFIG_KEYS, s);
const layerKeys = (l: ConfigLayer): string[] => Object.keys(CONFIG_KEYS[l]);
const layerName = (l: ConfigLayer): string => (l === "" ? "the top level" : l);
/** A path step as the warning shows it: plain when it is a plain name, else quoted (and cut). */
const step = (k: string): string => (/^[A-Za-z0-9_$<>.:@-]{1,64}$/.test(k) ? k : JSON.stringify(k.slice(0, 64)));
/** The table entry of key `k` at `layer`; undefined when the level does not list it. */
function keyInfo(layer: ConfigLayer, k: string): ConfigKeyInfo | undefined {
  const table: Readonly<Record<string, ConfigKeyInfo>> = CONFIG_KEYS[layer];
  return Object.hasOwn(table, k) ? table[k] : undefined;
}
const KIND_WORD: Readonly<Record<ConfigKind, string>> = { string: "a string", object: "an object" };
const ofKind = (v: unknown, kind: ConfigKind): boolean => (kind === "string" ? typeof v === "string" : isRecord(v));
/** The JSON type of a parsed value as a warning names it. */
function jsonTypeWord(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

/** Optimal string alignment distance (a swap of two neighbours costs 1). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    const row = d[i] ?? [];
    const prev = d[i - 1] ?? [];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (d[i - 2]?.[j - 2] ?? 0) + 1);
      row[j] = v;
    }
  }
  return d[a.length]?.[b.length] ?? 0;
}

/** The key of `layer` closest to `k` (case ignored), when it is close enough to be a slip. */
function didYouMean(k: string, layer: ConfigLayer): string | null {
  if (k.length > 64) return null;
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of layerKeys(layer)) {
    const dist = editDistance(k.toLowerCase(), c.toLowerCase());
    if (dist < bestD) {
      best = c;
      bestD = dist;
    }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(best.length / 4)) ? best : null;
}

function unknownKey(path: string, k: string, layer: ConfigLayer): string {
  const near = didYouMean(k, layer);
  if (near !== null) return `config.json: unknown key ${path} (did you mean ${near}?)`;
  const lk = k.toLowerCase();
  const elsewhere = Object.keys(CONFIG_KEYS).filter((l): l is ConfigLayer => isLayer(l) && l !== layer && layerKeys(l).some((x) => x.toLowerCase() === lk));
  return elsewhere.length === 0 ? `config.json: unknown key ${path}` : `config.json: unknown key ${path} (known under ${elsewhere.map(layerName).join(", ")})`;
}

/**
 * One warning per key CONFIG_KEYS does not list at its level (a case slip, a typo, a key at the
 * wrong level), with the nearest key of the level or the levels that know it; then (owner
 * 2026-10-22) one per key with a `kind` whose value is of another JSON type (null is not: it reads
 * as absent), `<path> is <type>, not <kind>; ignored`. At most 20 lines in all, unknown keys first,
 * then one line with the count of each kind not listed. Never an error: a level that is not an
 * object is left to its reader (unless its key has a `kind`), and the replay rules subtrees to their
 * own parser. Read-only.
 */
export function configWarnings(raw: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  const wrongType: string[] = [];
  let moreUnknown = 0;
  const walk = (obj: Record<string, unknown>, layer: ConfigLayer, at: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const path = at === "" ? step(k) : `${at}.${step(k)}`;
      const info = keyInfo(layer, k);
      if (info === undefined) {
        if (unknown.length < MAX_WARNINGS) unknown.push(unknownKey(path, k, layer));
        else moreUnknown++;
        continue;
      }
      if (info.kind !== undefined && v !== null && !ofKind(v, info.kind)) wrongType.push(`config.json: ${path} is ${jsonTypeWord(v)}, not ${KIND_WORD[info.kind]}; ignored`);
      if (!isRecord(v)) continue;
      const child = layer === "" ? k : `${layer}.${k}`;
      const named = NAMED[child];
      if (named !== undefined) {
        for (const [name, entry] of Object.entries(v)) if (isRecord(entry)) walk(entry, named, `${path}.${step(name)}`);
      } else if (!STRICT.has(child) && isLayer(child)) walk(v, child, path);
    }
  };
  walk(raw, "", "");
  const listed = wrongType.slice(0, MAX_WARNINGS - unknown.length);
  const moreWrong = wrongType.length - listed.length;
  const rest = [
    ...(moreUnknown > 0 ? [`${moreUnknown} more unknown key${moreUnknown === 1 ? "" : "s"}`] : []),
    ...(moreWrong > 0 ? [`${moreWrong} more key${moreWrong === 1 ? "" : "s"} of the wrong type`] : []),
  ];
  return [...unknown, ...listed, ...(rest.length === 0 ? [] : [`config.json: ${rest.join(" and ")} not listed`])];
}

/** `configWarnings` of the file (none when it is absent); a file `readConfigRaw` refuses is that error. */
export function readConfigWarnings(file: string): string[] {
  return configWarnings(readConfigRaw(file));
}
