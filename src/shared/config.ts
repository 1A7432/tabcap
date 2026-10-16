// ~/.config/tabcap/config.json: written by `tabcap setup`, read by the launcher
// and the account / proxy pool. The file is user-editable, so it is parsed as
// untrusted JSON; keys tabcap does not write itself (e.g. `pool`) survive a
// rewrite by `tabcap setup`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { TabcapError } from "./envelope.ts";
import { isRecord, str, tryParseJson } from "./json.ts";

export type TabcapConfig = {
  chrome: { executablePath: string; version: string | null; platform: string | null } | null;
  /** Default for `browser start --proxy`: "system" | "none" | <url>. */
  proxy: string | null;
};

function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = tryParseJson(readFileSync(file, "utf8"));
  return isRecord(raw) ? raw : {};
}

export function readConfig(file: string): TabcapConfig {
  const raw = readRaw(file);
  const c = raw["chrome"];
  const chrome =
    isRecord(c) && str(c, "executablePath") !== null
      ? { executablePath: str(c, "executablePath") ?? "", version: str(c, "version"), platform: str(c, "platform") }
      : null;
  return { chrome, proxy: str(raw, "proxy") };
}

/** Write `chrome` / `proxy`, keeping every other key of the file as it was. */
export function writeConfig(file: string, cfg: TabcapConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify({ ...readRaw(file), ...cfg }, null, 2) + "\n");
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
  const st = raw["strategy"];
  if (st !== undefined) {
    if (st !== "fixed" && st !== "round-robin" && st !== "lru") throw badPool("strategy", '"fixed", "round-robin" or "lru"');
    out.strategy = st;
  }
  const eg = raw["egress"];
  if (eg !== undefined) {
    if (!isRecord(eg)) throw badPool("egress", "an object");
    const mode = eg["mode"];
    if (mode !== undefined) {
      if (mode !== "fixed" && mode !== "rotate") throw badPool("egress.mode", '"fixed" or "rotate"');
      out.egress.mode = mode;
    }
    const on = eg["rotateOn"];
    if (on !== undefined) {
      if (typeof on !== "string") throw badPool("egress.rotateOn", '"per-session", "every:<N>requests" or "every:<T>min"');
      out.egress.rotateOn = on;
    }
  }
  const h = raw["health"];
  if (h !== undefined) {
    if (!isRecord(h)) throw badPool("health", "an object");
    const url = h["url"];
    if (url !== undefined && url !== null) {
      if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url)) throw badPool("health.url", "null or an http(s) URL");
      out.health.url = url;
    }
    const iv = h["intervalS"];
    if (iv !== undefined) {
      if (typeof iv !== "number" || !Number.isFinite(iv) || iv < 10) throw badPool("health.intervalS", "a number of seconds (at least 10)");
      out.health.intervalS = iv;
    }
  }
  const b = raw["budget"];
  if (b !== undefined) {
    if (!isRecord(b)) throw badPool("budget", "an object");
    const n = b["requestsPerHour"];
    if (n !== undefined && n !== null) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw badPool("budget.requestsPerHour", "null or a positive integer");
      out.budget.requestsPerHour = n;
    }
  }
  return out;
}

export function readPoolConfig(file: string): PoolConfig {
  return parsePoolConfig(readRaw(file)["pool"]);
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
  const iv = raw["minIntervalMs"];
  if (iv !== undefined) {
    if (typeof iv !== "number" || !Number.isInteger(iv) || iv < 0 || iv > 3_600_000) throw badFetch(where, "minIntervalMs", "an integer number of ms (0 to 3600000)");
    out.minIntervalMs = iv;
  }
  const c = raw["concurrency"];
  if (c !== undefined) {
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 16) throw badFetch(where, "concurrency", "an integer from 1 to 16");
    out.concurrency = c;
  }
  const s = raw["stopOn"];
  if (s !== undefined) {
    if (!Array.isArray(s) || !s.every((x) => typeof x === "string")) throw badFetch(where, "stopOn", "a list of stop rule strings");
    out.stopOn = s.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** The fetch settings for a store site (null: none matched): `fetch`, then `sites.<site>.fetch` on top. */
export function fetchConfigFrom(raw: Record<string, unknown>, site: string | null): FetchConfig {
  const global = parseFetchConfig(raw["fetch"]);
  if (site === null) return global;
  const sites = raw["sites"];
  if (sites === undefined || sites === null) return global;
  if (!isRecord(sites)) throw new TabcapError("bad-input", "config.json sites is invalid", "Set sites to an object {<site>: {fetch: {...}}}, or remove it.");
  const entry = sites[site];
  if (entry === undefined || entry === null) return global;
  if (!isRecord(entry)) throw new TabcapError("bad-input", `config.json sites.${site} is invalid`, `Set sites.${site} to an object, or remove it.`);
  return parseFetchConfig(entry["fetch"], global, `sites.${site}.fetch`);
}

export function readFetchConfig(file: string, site: string | null): FetchConfig {
  return fetchConfigFrom(readRaw(file), site);
}
