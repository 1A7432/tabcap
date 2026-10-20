// Live protection identification (docs/04 §41.3): once per navigation of a
// tab, the light probe (probe.ts) runs and its evidence goes through the same
// identify() as recon. The result is cached per tab and navigation epoch, so
// navigate / snapshot / status / the guard read one answer per page. When the
// set of families changes and the session records, one `protection` event goes
// into the bundle. No recording is needed; a recording adds nothing here (its
// headers and statuses are recon's job, which reads the whole bundle).

import { join } from "node:path";
import { DIGEST_FN, DIGEST_MAX, parseDigest } from "../adapters/detect.ts";
import { inWorld, rootDoc } from "../browser/worlds.ts";
import type { Tab } from "../browser/targets.ts";
import { navCookieParams } from "../capture/cookies.ts";
import type { Daemon } from "../state.ts";
import { callResult, docIdentity } from "../tools/snapshot.ts";
import type { Transport } from "../transport/types.ts";
import { identify, type Detection, type Evidence, type Identification } from "../../analyze/protection/identify.ts";
import { loadFamilies } from "../../analyze/protection/registry.ts";
import type { Family } from "../../analyze/protection/rules.ts";
import { log } from "../../shared/log.ts";
import { GLOBALS_FN, MAX_FRAMES, MAX_RESOURCES, RESOURCES_FN, globalPaths, parseCookies, parseGlobals, parseResources } from "./probe.ts";

/** A family is shown in command answers from this confidence on (owner 10-20). */
export const LIVE_MIN = 50;

export type LiveHint = { name: string; category: string; confidence: number };

type Cached = { epoch: number; url: string; found: Identification };
const cache = new WeakMap<Tab, Cached>();
/** The family ids last written into the bundle per tab (a `protection` event only when they change). */
const written = new WeakMap<Tab, string>();

/** The ElementSpec attributes and tags the families' dom rules need in the digest. */
function digestNeedsOf(families: readonly Family[]): { attrs: string[]; tags: string[] } {
  const attrs = new Set<string>(["class", "id"]);
  const tags = new Set<string>(["iframe", "script"]);
  for (const f of families) {
    for (const r of f.rules) {
      if (r.kind !== "dom") continue;
      for (const s of [r.match, r.has]) {
        if (s === null) continue;
        if (s.attr !== undefined) attrs.add(s.attr.name);
        if (s.tag !== undefined) tags.add(s.tag);
      }
    }
  }
  return { attrs: [...attrs].sort(), tags: [...tags].sort() };
}

async function part<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log.debug("protection probe: part failed", { what, error: String(e) });
    return null;
  }
}

/** The probe itself: cookies (names; values only to check shapes), resources and frames, globals, DOM digest. */
export async function probeTab(t: Transport, tab: Tab, families: readonly Family[]): Promise<Evidence> {
  const doc = await docIdentity(t, tab);
  const fd = rootDoc(tab, doc);
  const paths = globalPaths(families);
  const needs = digestNeedsOf(families);
  const cookies = await part("cookies", async () => parseCookies(await t.send("Network.getCookies", navCookieParams(doc.url), tab.sessionId, 5000)));
  const loaded = await part("resources", () => inWorld(t, tab, fd, async (ctx) => parseResources(callResult(await t.send("Runtime.evaluate", { expression: `(${RESOURCES_FN})(${MAX_RESOURCES}, ${MAX_FRAMES})`, contextId: ctx, returnByValue: true }, fd.sessionId, 10_000)))));
  const dom = await part("dom", () => inWorld(t, tab, fd, async (ctx) => parseDigest(callResult(await t.send("Runtime.evaluate", { expression: `(${DIGEST_FN})(${JSON.stringify(needs.attrs)}, ${JSON.stringify(needs.tags)}, ${DIGEST_MAX})`, contextId: ctx, returnByValue: true }, fd.sessionId, 10_000)))));
  const globals = paths.length === 0 ? {} : await part("globals", async () => parseGlobals(callResult(await t.send("Runtime.evaluate", { expression: `(${GLOBALS_FN})(${JSON.stringify(paths)})`, returnByValue: true }, fd.sessionId, 5000)), paths));
  return { cookies, resources: loaded?.resources ?? null, frames: loaded?.frames ?? null, dom, globals };
}

export function familiesFor(d: Daemon): { families: Family[]; warnings: string[] } {
  return loadFamilies(join(d.paths.config, "protection"));
}

/** The identification for the tab's current navigation, probing once per navigation. Never throws: a failed probe is an empty answer. */
export async function liveIdentify(d: Daemon, t: Transport, tab: Tab): Promise<Identification> {
  const have = cache.get(tab);
  if (have !== undefined && have.epoch === tab.navEpoch && have.url === tab.url) return have.found;
  let found: Identification = { detections: [], fingerprinting: [] };
  try {
    const { families } = familiesFor(d);
    found = identify(families, await probeTab(t, tab, families));
  } catch (e) {
    log.debug("protection probe failed", { tab: tab.id, error: String(e) });
  }
  cache.set(tab, { epoch: tab.navEpoch, url: tab.url, found });
  record(d, tab, found.detections);
  return found;
}

/** The families shown in answers (≥ LIVE_MIN; fingerprinting needs trace mode, not shown live). */
export function liveHints(found: Identification): LiveHint[] {
  return found.detections.filter((x) => x.category !== "fingerprint" && x.confidence >= LIVE_MIN).map((x) => ({ name: x.name, category: x.category, confidence: x.confidence }));
}

/** The cached hint names for a tab (status, guard): no probe, empty when this navigation was not probed yet. */
export function cachedNames(tab: Tab | undefined): string[] {
  if (tab === undefined) return [];
  const have = cache.get(tab);
  if (have === undefined || have.epoch !== tab.navEpoch || have.url !== tab.url) return [];
  return liveHints(have.found).map((h) => h.name);
}

/** Answer field: `{protection: [...]}` when anything ≥ LIVE_MIN was identified, else nothing. */
export async function protectionField(d: Daemon, t: Transport, tab: Tab): Promise<{ protection?: LiveHint[] }> {
  const hints = liveHints(await liveIdentify(d, t, tab));
  return hints.length === 0 ? {} : { protection: hints };
}

function record(d: Daemon, tab: Tab, detections: readonly Detection[]): void {
  const rec = d.recorders.get(tab.session);
  if (rec === undefined) return;
  const shown = detections.filter((x) => x.category !== "fingerprint");
  const key = shown.map((x) => `${x.family}:${x.confidence}`).join(",");
  if ((written.get(tab) ?? "") === key) return;
  written.set(tab, key);
  rec.event("protection", { nav: d.navOf(tab), url: tab.url, detections: shown.map((x) => ({ family: x.family, name: x.name, category: x.category, confidence: x.confidence, matched: x.matched })) }, { tab: tab.id });
}

/**
 * For the guard (docs/04 §41.3): the family names of a daemon tab's page, probing in the
 * tab's turn when this navigation was not probed yet (a trip during a navigation comes
 * before `navigate` probed). Never throws.
 */
export async function namesForGuard(d: Daemon, tabId: string): Promise<string[]> {
  const b = d.browser;
  const tab = b?.tabs.tabs.get(tabId);
  if (b === null || tab === undefined || tab.closed) return [];
  const have = cachedNames(tab);
  if (have.length > 0) return have;
  try {
    return liveHints(await b.tabs.run(tab, () => liveIdentify(d, b.t, tab), { timeoutMs: 15_000, allowDialog: true })).map((h) => h.name);
  } catch {
    return [];
  }
}
