// "Which store site does a URL belong to" (docs/04 §26 「站点」): one rule in
// src/shared/sites.ts for tabcap fetch / the guard / status (siteOf), the
// session cookie save (siteCookieUrls) and `replay check --live`. The oracle
// is that rule as docs/04 §26 states it: the session-bound site first, then
// the others; the entry URL's host or a stored domain (leading dots dropped,
// lower case), the domain itself or any subdomain of it; IP addresses only
// exactly. The table runs every host through all three paths.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { hostInSite, normalizeDomain, siteHosts, siteOf } from "../../src/shared/sites.ts";
import { siteCookieUrls } from "../../src/daemon/capture/cookies.ts";
import { check } from "../../src/replay/check.ts";
import { siteAdd } from "../../src/cli/site.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { paths } from "../../src/shared/paths.ts";
import type { HttpClient } from "../../src/daemon/pool/proxy.ts";
import { tmp } from "./_analyze.ts";
import { buildReplayBundle } from "./_replay.ts";
import { SLOW_IO_MS } from "./_platform.ts";

type SiteDef = { name: string; entryUrl: string; domains: string[] };

const EX: SiteDef = { name: "ex", entryUrl: "https://www.example.com/login", domains: [".example.com"] };
const LOOP: SiteDef = { name: "loop", entryUrl: "http://127.0.0.1:4310/", domains: ["0.1"] };
const SHOP: SiteDef = { name: "shop", entryUrl: "https://shop.test/", domains: ["  .CDN.Shop.test ", "bad domain!", ""] };

/** host × site → is the host on the site. */
const TABLE: Array<[string, SiteDef, boolean]> = [
  ["www.example.com", EX, true], // entry host
  ["example.com", EX, true], // stored as ".example.com": the leading dot is dropped
  ["api.example.com", EX, true], // a subdomain of a stored domain
  ["a.b.example.com", EX, true],
  ["API.Example.com", EX, true], // URL hosts are lower case
  ["badexample.com", EX, false], // a suffix that is not a label boundary
  ["example.com.evil.test", EX, false],
  ["127.0.0.1", LOOP, true], // entry host, IP: exactly
  ["10.0.0.1", LOOP, false], // an IP address has no subdomains ("0.1" is not a parent of it)
  ["shop.test", SHOP, true],
  ["cdn.shop.test", SHOP, true], // trimmed, lower case, leading dot dropped
  ["img.cdn.shop.test", SHOP, true],
  ["other.test", SHOP, false],
];

let root = "";
let bundle = "";
let cfg = "";

beforeAll(async () => {
  root = tmp("tabcap-sites-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
  cfg = join(root, "cfg");
  const s = Store.open(cfg);
  for (const d of [EX, LOOP, SHOP]) s.addSite({ name: d.name, entryUrl: d.entryUrl, domains: d.domains, username: "u", password: "Site-pass-9xq" });
  s.close();
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

const neverSend: HttpClient = async () => {
  throw new Error("nothing may be sent in this test");
};

/** Does `replay check --live --site <s> --against https://<host>` accept the host? (A filter that matches nothing: nothing is sent.) */
async function liveAccepts(host: string, site: SiteDef): Promise<boolean> {
  try {
    await check({ bundle, against: `https://${host}`, live: true, site: site.name, filter: "/no-such-path", withCookies: false, headers: [], configDir: cfg, fetch: neverSend, sleep: async () => undefined });
    return true;
  } catch (e) {
    if (e instanceof Error && /is not one of the domains of site/.test(e.message)) return false;
    throw e;
  }
}

describe("one site rule, three paths (docs/04 §26)", () => {
  test.each(TABLE)("%s on %o → %p", async (host, site, inSite) => {
    const url = new URL(`https://${host}/x`);
    // tabcap fetch, the guard's site rules, tabcap status
    expect(siteOf([site], null, url).site).toBe(inSite ? site.name : null);
    // the session cookie save: a tab URL on the site is asked for
    const tab = `https://${url.hostname}/page`;
    expect(siteCookieUrls(site.entryUrl, site.domains, [tab]).includes(tab)).toBe(inSite);
    // replay check --live
    expect(await liveAccepts(host, site)).toBe(inSite);
  });

  test("siteHosts: entry host (http(s) only) then the valid domains, normalised, without repeats", () => {
    expect(siteHosts(EX.entryUrl, EX.domains)).toEqual(["www.example.com", "example.com"]);
    expect(siteHosts(SHOP.entryUrl, SHOP.domains)).toEqual(["shop.test", "cdn.shop.test"]);
    expect(siteHosts("ftp://files.test/", ["files.test", "FILES.test", "..files.test"])).toEqual(["files.test"]);
    expect(siteHosts("not a url", [])).toEqual([]);
    expect(normalizeDomain(" ..Api.Example.COM ")).toBe("api.example.com");
    expect(normalizeDomain("my_host.example")).toBe("my_host.example");
    for (const bad of ["", " ", ".", "a b", "example.com/x", "*.example.com", "host:8080", "[::1]"]) expect([bad, normalizeDomain(bad)]).toEqual([bad, null]);
    expect(hostInSite("a.example.com", ["example.com"])).toBe(true);
    expect(hostInSite("127.0.0.1", ["0.0.1"])).toBe(false);
  });

  test("siteOf: the session-bound site first, then store order; no match → the URL's host:port", () => {
    const a: SiteDef = { name: "a", entryUrl: "https://example.com/", domains: [] };
    const b: SiteDef = { name: "b", entryUrl: "https://api.example.com/", domains: [] };
    const u = new URL("https://api.example.com:8443/v1");
    expect(siteOf([a, b], null, u)).toEqual({ key: "a", site: "a" });
    expect(siteOf([a, b], "b", u)).toEqual({ key: "b", site: "b" });
    expect(siteOf([a, b], null, new URL("http://other.test:81/"))).toEqual({ key: "other.test:81", site: null });
  });
});

describe("site add stores domains normalised", () => {
  test("leading dots dropped, lower case, trimmed, repeats once; a value that is not a host name is a usage error", async () => {
    const home = tmp("tabcap-sites-add-");
    const p = paths({ TABCAP_HOME: home });
    const out = await siteAdd(p, { name: "example", url: "https://www.example.com/login", user: "alice", domains: " .Example.com, api.example.com,,EXAMPLE.com", passwordStdin: true }, () => Promise.resolve("Pw-long-enough\n"));
    expect(out).toMatchObject({ domains: ["example.com", "api.example.com"] });
    const s = Store.open(p.config);
    expect(s.site("example")?.domains).toEqual(["example.com", "api.example.com"]);
    s.close();
    let err: unknown = null;
    try {
      await siteAdd(p, { name: "other", url: "https://other.test/", user: "bob", domains: "other.test,bad domain", passwordStdin: true }, () => Promise.resolve("Pw-long-enough\n"));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "usage" });
    expect(String(err)).toContain("bad domain");
    rmSync(home, { recursive: true, force: true });
  });
});
