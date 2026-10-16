// The account's proxy for clients outside the browser (0.4-D, docs/08 §3 0.4:
// "storageState 与 Python 客户端带同一代理"): the generated Python client
// reads TABCAP_PROXY_URL (httpx `Client(proxy=…)`); `replay export-python
// --proxy-env <file>` writes it (0600, never printed); `replay check --live`
// sends through the same proxy. storageState stays as Playwright defines it
// (it has no proxy field).

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { TabcapError } from "../shared/envelope.ts";
import { Secrets } from "../daemon/secrets.ts";
import { Store } from "../daemon/store/db.ts";
import { proxyUrlWithAuth } from "../daemon/pool/proxy.ts";

export type AccountProxy = { site: string; account: string; proxy: string; url: string; scrub: (s: string) => string };

/**
 * The proxy of a site's account (the given one, else the site's first), with
 * its credentialed URL; null when the account goes out through the browser's
 * own network (`system` / `none` / never bound).
 */
export function accountProxy(configDir: string, site: string, account: string | null): AccountProxy | null {
  const store = Store.open(configDir);
  try {
    if (store.site(site) === null) throw new TabcapError("not-found", `no site "${site}" in the store`, "Run `tabcap site list`.");
    const user = account ?? store.accountOf(site);
    const a = user === null ? null : store.account(site, user);
    if (a === null) throw new TabcapError("not-found", `site "${site}" has no account${user === null ? "" : ` "${user}"`}`, `Run \`tabcap account list --site ${site}\`.`);
    if (a.proxy === null || a.proxy === "system" || a.proxy === "none") return null;
    const p = store.proxy(a.proxy);
    if (p === null) throw new TabcapError("not-found", `account ${site}.${a.username} is bound to proxy "${a.proxy}", which does not exist`, "Run `tabcap proxy list`; rebind with `tabcap account bind`.");
    const sec = new Secrets();
    sec.setStored(store.knownSecrets());
    return { site, account: a.username, proxy: p.name, url: proxyUrlWithAuth(p), scrub: (x) => sec.scrub(x) };
  } finally {
    store.close();
  }
}

/** `TABCAP_PROXY_URL='…'` (shell- and dotenv-readable), mode 0600. The URL is never returned. */
export function writeProxyEnv(file: string, ap: AccountProxy): { file: string; proxy: string; account: string; mode: "0600"; sensitive: true } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `TABCAP_PROXY_URL='${ap.url}'\n`, 0o600);
  chmodSync(file, 0o600);
  return { file, proxy: ap.proxy, account: `${ap.site}.${ap.account}`, mode: "0600", sensitive: true };
}
