// Site-wide stop rules (0.6-I, owner design 10-16): config.json
// `sites.<name>.guard: {stopOn: [<rule>…], consecutiveNon200: N, endOn: [<rule>…]}`. The guard
// (guard.ts) checks them on every recorded response of the site; this file
// only finds the rules for a URL (the store site it belongs to, as
// `tabcap fetch` decides it) and validates the config. Rule syntax is the one
// of `tabcap fetch --stop-on` (fetch/stoprules.ts).

import { statSync } from "node:fs";
import { TabcapError } from "../shared/envelope.ts";
import { readSiteGuards, type SiteGuardConfig } from "../shared/config.ts";
import { log } from "../shared/log.ts";
import { parseStopRule, type StopRule } from "./fetch/stoprules.ts";
import { siteOf } from "../shared/sites.ts";
import type { Daemon } from "./state.ts";

/** The parsed rules of one store site; `endRules` (0.7.5-A, docs/04 §38) are checked before the stop rules. */
export type SiteRules = { site: string; rules: StopRule[]; consecutiveNon200: number | null; endRules: StopRule[] };

/** Parse one site's guard settings; a bad rule is the config's fault (bad-input). */
export function parseSiteRules(site: string, g: SiteGuardConfig): SiteRules {
  const parse = (key: "stopOn" | "endOn") =>
    g[key].map((src) => {
      try {
        return parseStopRule(src);
      } catch (e) {
        throw new TabcapError("bad-input", `config.json sites.${site}.guard.${key}: ${e instanceof Error ? e.message : String(e)}`, "Fix the rule in config.json.");
      }
    });
  return { site, rules: parse("stopOn"), consecutiveNon200: g.consecutiveNon200, endRules: parse("endOn") };
}

type Cached = { mtimeMs: number; size: number; rules: Map<string, SiteRules> };
const cache = new Map<string, Cached>();

/** Every site's parsed rules from config.json (re-read when the file changes); throws bad-input on a bad one. */
export function allSiteRules(configFile: string): Map<string, SiteRules> {
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    const s = statSync(configFile);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    st = null;
  }
  if (st === null) return new Map();
  const hit = cache.get(configFile);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rules;
  const rules = new Map<string, SiteRules>();
  for (const [name, g] of readSiteGuards(configFile)) rules.set(name, parseSiteRules(name, g));
  cache.set(configFile, { mtimeMs: st.mtimeMs, size: st.size, rules });
  return rules;
}

/**
 * The rules for a recorded response of `session`, or null: the URL's store
 * site (the session's bound site first, as for `tabcap fetch`) must have a
 * `guard` entry. A broken config.json is logged and checks nothing here
 * (`net start` refuses it up front).
 */
export function siteRulesFor(d: Daemon, session: string, url: string): SiteRules | null {
  let rules: Map<string, SiteRules>;
  try {
    rules = allSiteRules(d.paths.configFile);
  } catch (e) {
    log.warn("guard: config.json site rules are invalid; not checked", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (rules.size === 0 || d.store === null) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const where = siteOf(d.store.listSites(), d.sites.get(session)?.site ?? null, u);
  return where.site === null ? null : (rules.get(where.site) ?? null);
}
