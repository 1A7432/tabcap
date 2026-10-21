// Which store site a URL belongs to (docs/04 §26 「站点」): the one rule that
// tabcap fetch, the guard's site rules, `tabcap status`, the session cookie
// save (daemon/capture/cookies.ts) and `replay check --live` all use, and the
// normalisation `site add` applies before a domain is stored.
//
// A site's hosts are its entry URL's host (http(s) only) and every stored
// domain that is a host name (trimmed, lower case, leading dots dropped). A
// host is on the site when it is one of them or a subdomain of one; an IP
// address only when it is one of them exactly. Store rows are untrusted:
// a domain that is not a host name is left out, never matched.
// Oracle: docs/04 §26. Reproduce: bun test test/unit/sites.test.ts

/** The parts of a store site the rule reads. */
export type SiteHostsRow = { name: string; entryUrl: string; domains: readonly string[] };

const HOST_NAME = /^[a-z0-9_.-]+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A domain as stored: trimmed, lower case, leading dots dropped; null when it is not a host name. */
export function normalizeDomain(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/^\.+/, "");
  return h !== "" && HOST_NAME.test(h) ? h : null;
}

/** The host of an http(s) URL (lower case), else null. */
function httpHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A site's hosts: the entry URL's host (http(s) only), then every valid domain, without repeats. */
export function siteHosts(entryUrl: string, domains: readonly string[]): string[] {
  const out: string[] = [];
  const entry = httpHost(entryUrl);
  if (entry !== null) out.push(entry);
  for (const d of domains) {
    const h = normalizeDomain(d);
    if (h !== null && !out.includes(h)) out.push(h);
  }
  return out;
}

const isIpLiteral = (h: string): boolean => IPV4.test(h) || h.startsWith("[");

/** Is `host` one of `hosts`, or a subdomain of one (IP addresses: exactly only)? */
export function hostInSite(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((x) => h === x || (!isIpLiteral(h) && !isIpLiteral(x) && h.endsWith(`.${x}`)));
}

/** Which store site a URL belongs to (the session-bound site first, then store order), else its `host:port` as the key. */
export function siteOf(sites: ReadonlyArray<SiteHostsRow>, bound: string | null, url: URL): { key: string; site: string | null } {
  const ordered = [...sites].sort((a, b) => (a.name === bound ? -1 : b.name === bound ? 1 : 0));
  for (const s of ordered) if (hostInSite(url.hostname, siteHosts(s.entryUrl, s.domains))) return { key: s.name, site: s.name };
  return { key: url.host, site: null };
}
