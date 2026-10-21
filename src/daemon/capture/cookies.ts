// Cookie snapshots (docs/04 §4.1 `state`, P1: cookies only) and the store's
// saved sessions (docs/04 §8.1 `sessions`). Pure helpers: CDP results are
// untrusted, so only what the spec needs is checked; the array is otherwise
// kept as CDP returned it ("cookies 用 CDP Network.getCookies 的原样数组").
// Oracle: CDP Network.getCookies (`{cookies: Cookie[]}`; with no `urls` it
// answers for the target's current URL and its frames; the `nav` snapshot
// passes the committed URL, see navCookieParams). Reproduce:
// bun test test/unit/state.test.ts; the e2e in test/e2e/v03c.e2e.test.ts reads
// the cookies the local site set.

import { isRecord } from "../../shared/json.ts";
import { hostInSite, siteHosts } from "../../shared/sites.ts";
import type { StateReason, StoreStateFields } from "../../bundle/types.ts";
import type { NavType } from "../browser/targets.ts";

export type { StateReason };

/** The cookie objects of a Network.getCookies / Storage.getCookies result; anything malformed is dropped. */
export function cookieArray(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result["cookies"])) return [];
  return result["cookies"].filter((c): c is Record<string, unknown> => isRecord(c) && typeof c["name"] === "string" && typeof c["value"] === "string" && typeof c["domain"] === "string");
}

/** `state.origin`: the http(s) origin of the tab's URL, else null (about:blank, data:, chrome:). */
export function stateOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * docs/04 §4.1: a cookie snapshot at every root-frame `navigation`-type nav
 * (not history / reload / back_forward, and not the `initial` nav the recorder
 * writes for a page already open when recording starts: that one has the
 * session-start snapshot).
 */
export function navWantsCookies(type: NavType, initial: boolean): boolean {
  return type === "navigation" && !initial;
}

/**
 * Network.getCookies params for the `nav` snapshot: the committed URL itself.
 * Without `urls` Chrome answers for the URLs of the target's frame tree as the
 * browser process knows them, and Page.frameNavigated (sent by the renderer)
 * can arrive before the browser has recorded the commit: the answer is then
 * empty although the jar holds the site's cookies (measured on Linux, CfT /
 * Chromium 155: 2 of 10 runs `[]` while `{urls: [committed]}` at the same
 * moment and the no-urls call 300 ms later both returned the cookie). At a root
 * commit the new document has no subframes yet, so the committed URL is the
 * whole frame tree. Non-http(s) URLs (about:blank, data:) keep the no-urls call.
 */
export function navCookieParams(committed: string): { urls?: string[] } {
  return stateOrigin(committed) === null ? {} : { urls: [committed] };
}

/** The fields of a `state` cookies event (envelope fields are the writer's). */
export function cookieStateFields(origin: string | null, blob: string, count: number, reason: StateReason): StoreStateFields {
  return { what: "cookies", origin, blob, count, reason };
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * URLs to ask Network.getCookies for when saving a site's session: the entry
 * URL, every stored domain over http and https, and the session's tab URLs on
 * the site (shared/sites.ts: one of its hosts or a subdomain, docs/04 §26).
 * Cookies of other sites never enter the site's row.
 */
export function siteCookieUrls(entryUrl: string, domains: readonly string[], tabUrls: readonly string[]): string[] {
  const hosts = siteHosts(entryUrl, domains);
  const entryHost = hostOf(entryUrl);
  const out = new Set<string>();
  if (entryHost !== null) out.add(entryUrl);
  for (const h of hosts) {
    if (h === entryHost) continue;
    out.add(`https://${h}/`);
    out.add(`http://${h}/`);
  }
  for (const u of tabUrls) {
    const h = hostOf(u);
    if (h !== null && hostInSite(h, hosts)) out.add(u);
  }
  return [...out];
}
