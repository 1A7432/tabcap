// Account / proxy pool in the daemon (0.4-D, docs/08 §3 0.4, owner design
// 10-16; docs/07 §1.1 and §4 item 6 for the spike facts).
//
// - One browser context per pool account (an account bound to a proxy name):
//   `Target.createBrowserContext {proxyServer: "host:port", proxyBypassList,
//   disposeOnDetach: false}`; the session's tabs are created in it. Chrome
//   only ever gets host:port.
// - Proxy authentication is answered here, on the browser session:
//   `Fetch.enable {handleAuthRequests: true}` → `Fetch.authRequired`
//   (source "Proxy": credentials picked by `authChallenge.origin`) →
//   `Fetch.continueWithAuth`; every paused request is continued at once.
//   This is instrumentation (AGENTS.md): while it is on, every command output
//   carries `fetchAuth: "on"`.
// - Cookies: restored from the store's `sessions` row with Storage.setCookies
//   {browserContextId} at session start; written back with Storage.getCookies
//   {browserContextId} on every cookie `state` snapshot, at session stop and
//   before the daemon closes the browser (Chrome closes every tab within
//   ~500 ms of the pipe dropping, and a disposed context's cookies are gone).
// Pure rules live in rules.ts; this file is the CDP / store side.

import { readPoolConfig, POOL_DEFAULTS, type PoolConfig } from "../../shared/config.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { cookieArray } from "../capture/cookies.ts";
import type { AccountRow, ProxyRow, Store } from "../store/db.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";
import { checkThrough, chromeProxyServer, patchFor, proxyOrigin, type HttpClient } from "./proxy.ts";
import {
  accountCleared,
  accountOnBreaker,
  accountOnFailedLogin,
  accountState,
  allocate,
  FAILED_LOGIN_LIMIT,
  nextProxy,
  parseRotateOn,
  proxyDue,
  proxyUsable,
  rotationDue,
  type Rotation,
} from "./rules.ts";

export type PoolContext = {
  session: string;
  site: string;
  account: string;
  /** Proxy name the context goes out through. */
  proxy: string;
  browserContextId: string;
  /** `authChallenge.origin` of this proxy (lowercase). */
  origin: string;
  creds: { username: string; password: string } | null;
};

const key = (site: string, user: string) => `${site}\t${user}`;

/** CDP Cookie (Network / Storage.getCookies) → Storage.setCookies CookieParam; null when unusable. */
export function cookieParam(c: Record<string, unknown>): Record<string, unknown> | null {
  const name = str(c, "name");
  const value = str(c, "value");
  const domain = str(c, "domain");
  if (name === null || name === "" || value === null || domain === null || domain === "") return null;
  const out: Record<string, unknown> = { name, value, domain, path: str(c, "path") ?? "/" };
  if (typeof c["secure"] === "boolean") out["secure"] = c["secure"];
  if (typeof c["httpOnly"] === "boolean") out["httpOnly"] = c["httpOnly"];
  const ss = str(c, "sameSite");
  if (ss === "Strict" || ss === "Lax" || ss === "None") out["sameSite"] = ss;
  const exp = c["expires"];
  if (c["session"] !== true && typeof exp === "number" && Number.isFinite(exp) && exp > 0) out["expires"] = exp;
  const pr = str(c, "priority");
  if (pr === "Low" || pr === "Medium" || pr === "High") out["priority"] = pr;
  const sch = str(c, "sourceScheme");
  if (sch === "Unset" || sch === "NonSecure" || sch === "Secure") out["sourceScheme"] = sch;
  const port = c["sourcePort"];
  if (typeof port === "number" && Number.isInteger(port) && port >= -1 && port <= 65535) out["sourcePort"] = port;
  const pk = c["partitionKey"];
  if (isRecord(pk) && typeof pk["topLevelSite"] === "string" && typeof pk["hasCrossSiteAncestor"] === "boolean") out["partitionKey"] = { topLevelSite: pk["topLevelSite"], hasCrossSiteAncestor: pk["hasCrossSiteAncestor"] };
  return out;
}

export class Pool {
  readonly contexts = new Map<string, PoolContext>();
  /** Egress rotation per account (daemon memory; starts again from the bound proxy after a restart). */
  readonly rotation = new Map<string, Rotation>();
  private fetchOn = false;
  private offEvents: (() => void) | null = null;
  private pending = new Set<Promise<unknown>>();
  /** Recent auth answers per proxy origin (a proxy that keeps rejecting gets CancelAuth). */
  private answered = new Map<string, number[]>();
  private config: PoolConfig = structuredClone(POOL_DEFAULTS);
  private configError: TabcapError | null = null;
  private healthRunning = false;

  constructor(readonly now: () => number = Date.now) {}

  /** Is the browser-level Fetch auth handler on (output marker `fetchAuth: "on"`)? */
  get fetchAuth(): boolean {
    return this.fetchOn;
  }

  reloadConfig(file: string): void {
    try {
      this.config = readPoolConfig(file);
      this.configError = null;
    } catch (e) {
      this.configError = e instanceof TabcapError ? e : new TabcapError("bad-input", String(e), "Fix config.json pool.");
    }
  }

  /** The pool config; a malformed `pool` in config.json is an error where it matters. */
  cfg(): PoolConfig {
    if (this.configError !== null) throw this.configError;
    return this.config;
  }

  byAccount(site: string, user: string): PoolContext | undefined {
    for (const c of this.contexts.values()) if (c.site === site && c.account === user) return c;
    return undefined;
  }

  // ---------------------------------------------------------- allocation

  /**
   * Why an account may not be used now, or null. `inUse`: a pool account
   * already has a context (one session per pool account at a time).
   */
  unusable(store: Pick<Store, "proxy">, a: AccountRow, now: number): string | null {
    const st = accountState(a, now);
    if (st === "disabled") return `account ${a.site}.${a.username} is disabled`;
    if (st === "needs-human") return `account ${a.site}.${a.username} needs the human (2 failed logins within 24 h)`;
    if (st === "cooling") return `account ${a.site}.${a.username} is cooling down after a guard breaker until ${new Date(a.coolUntil ?? now).toISOString()}`;
    if (a.proxy !== null && a.proxy !== "system" && a.proxy !== "none") {
      const p = store.proxy(a.proxy);
      if (p === null) return `account ${a.site}.${a.username} is bound to proxy "${a.proxy}", which no longer exists`;
      if (!proxyUsable(p.state) && this.cfg().egress.mode === "fixed") return `proxy "${p.name}" of account ${a.site}.${a.username} is ${p.state}`;
      const ctx = this.byAccount(a.site, a.username);
      if (ctx !== undefined) return `account ${a.site}.${a.username} is in use by session "${ctx.session}"`;
    }
    return null;
  }

  /** `--account <user>|auto` (or the site's first account when null). */
  pick(store: Pick<Store, "accounts" | "proxy">, site: string, accountArg: string | null): AccountRow | null {
    const now = this.now();
    const all = store.accounts(site);
    if (accountArg === "auto") {
      const strategy = this.cfg().strategy;
      const a = allocate(strategy, all, (x) => this.unusable(store, x, now) === null);
      if (a !== null) return a;
      const why = all.map((x) => this.unusable(store, x, now)).filter((x): x is string => x !== null);
      throw new TabcapError("conflict", `no account of site "${site}" can be allocated (${strategy})`, `${why.join("; ") || "the site has no accounts"}. Wait, or ask the human (\`tabcap account list --site ${site}\`).`);
    }
    const a = accountArg === null ? (all[0] ?? null) : (all.find((x) => x.username === accountArg) ?? null);
    if (a === null) {
      if (accountArg === null) return null;
      throw new TabcapError("not-found", `site "${site}" has no account "${accountArg}"`, `Run \`tabcap account list --site ${site}\`.`);
    }
    const why = this.unusable(store, a, now);
    if (why !== null) throw new TabcapError("conflict", why, `Pick another account (\`tabcap account list --site ${site}\`), use --account auto, or ask the human.`);
    return a;
  }

  /**
   * The proxy name a session of this account goes out through (egress
   * policy), and a commit to call once the context exists. system / none /
   * unbound accounts: no pool proxy (null).
   */
  egress(store: Pick<Store, "proxy" | "proxies">, a: AccountRow): { proxy: string | null; commit: () => void } {
    const bound = a.proxy;
    if (bound === null || bound === "system" || bound === "none") return { proxy: null, commit: () => undefined };
    const cfg = this.cfg();
    if (cfg.egress.mode === "fixed") return { proxy: bound, commit: () => undefined };
    const now = this.now();
    const on = parseRotateOn(cfg.egress.rotateOn);
    const k = key(a.site, a.username);
    const usable = (n: string) => {
      const p = store.proxy(n);
      return p !== null && proxyUsable(p.state);
    };
    const cur = this.rotation.get(k) ?? { current: bound, rotatedAt: now, requests: 0, sessions: 0 };
    const ring = store.proxies().map((p) => p.name);
    const due = rotationDue(on, cur, now) || !usable(cur.current);
    const next: Rotation = due ? { current: nextProxy(ring, cur.current, usable), rotatedAt: now, requests: 0, sessions: 0 } : { ...cur };
    if (!usable(next.current)) throw new TabcapError("conflict", `no usable proxy to rotate to for ${a.site}.${a.username}`, "Check `tabcap proxy list` (down / disabled proxies are skipped).");
    return {
      proxy: next.current,
      commit: () => this.rotation.set(k, { ...next, sessions: next.sessions + 1 }),
    };
  }

  // ---------------------------------------------------------- contexts

  /** Create the account's browser context through `proxy`. */
  async open(t: Transport, o: { session: string; site: string; account: string; proxy: ProxyRow }): Promise<PoolContext> {
    const origin = proxyOrigin(o.proxy);
    const creds = o.proxy.password === null ? null : { username: o.proxy.username ?? "", password: o.proxy.password };
    for (const c of this.contexts.values()) {
      // Fetch.authRequired names the proxy origin only, not the context: one origin, one set of credentials.
      if (c.origin === origin && (c.creds?.username !== creds?.username || c.creds?.password !== creds?.password)) {
        throw new TabcapError("conflict", `proxy "${o.proxy.name}" has the same address as proxy "${c.proxy}" (in use by session "${c.session}") but other credentials`, `Stop session "${c.session}" first; Chrome's auth challenge names only the proxy address.`);
      }
    }
    const r = await t.send("Target.createBrowserContext", { proxyServer: chromeProxyServer(o.proxy), ...(o.proxy.bypass === null ? {} : { proxyBypassList: o.proxy.bypass }), disposeOnDetach: false }, null, 10_000);
    const id = str(r, "browserContextId");
    if (id === null) throw new TabcapError("cdp", "Target.createBrowserContext returned no browserContextId", "Retry; if it persists restart the browser.");
    const ctx: PoolContext = { session: o.session, site: o.site, account: o.account, proxy: o.proxy.name, browserContextId: id, origin, creds };
    this.contexts.set(o.session, ctx);
    try {
      await this.syncFetchAuth(t);
    } catch (e) {
      await this.close(t, o.session).catch(() => undefined);
      throw e;
    }
    return ctx;
  }

  /** Restore the account's saved cookies into its context; the number set. */
  async restoreCookies(store: Pick<Store, "savedSession">, t: Transport, ctx: PoolContext): Promise<number> {
    const saved = store.savedSession(ctx.site, ctx.account);
    if (saved === null || saved.username !== ctx.account || !Array.isArray(saved.cookies)) return 0;
    const cookies = saved.cookies.filter(isRecord).map(cookieParam).filter((x): x is Record<string, unknown> => x !== null);
    if (cookies.length === 0) return 0;
    await t.send("Storage.setCookies", { cookies, browserContextId: ctx.browserContextId }, null, 10_000);
    return cookies.length;
  }

  /** Write the context's cookies back to the store; the count, or null when the browser did not answer. */
  async saveCookies(store: Pick<Store, "saveSession">, t: Transport, session: string): Promise<number | null> {
    const ctx = this.contexts.get(session);
    if (ctx === undefined) return null;
    try {
      const cookies = cookieArray(await t.send("Storage.getCookies", { browserContextId: ctx.browserContextId }, null, 5000));
      store.saveSession(ctx.site, ctx.account, cookies, this.now());
      return cookies.length;
    } catch (e) {
      log.warn("pool: saving the context's cookies failed", { session, error: String(e) });
      return null;
    }
  }

  /** Fire-and-forget save (cookie `state` snapshots); awaited by `settle`. */
  saveSoon(store: Pick<Store, "saveSession">, t: Transport, session: string, after?: () => void): void {
    const p = this.saveCookies(store, t, session).then(() => after?.());
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Before the browser goes away: every pool context's cookies into the store. */
  async saveAll(store: Pick<Store, "saveSession">, t: Transport): Promise<void> {
    await this.settle();
    for (const s of [...this.contexts.keys()]) await this.saveCookies(store, t, s);
  }

  /** Dispose the session's context (its tabs close with it). */
  async close(t: Transport, session: string): Promise<boolean> {
    const ctx = this.contexts.get(session);
    if (ctx === undefined) return false;
    this.contexts.delete(session);
    await t.send("Target.disposeBrowserContext", { browserContextId: ctx.browserContextId }, null, 10_000).catch((e: unknown) => log.warn("pool: disposeBrowserContext failed", { session, error: String(e) }));
    await this.syncFetchAuth(t).catch((e: unknown) => log.warn("pool: Fetch.disable failed", { error: String(e) }));
    return true;
  }

  /** The browser is gone: forget contexts and the handler. */
  reset(): void {
    this.contexts.clear();
    this.offEvents?.();
    this.offEvents = null;
    this.fetchOn = false;
  }

  // ---------------------------------------------------------- proxy auth (Fetch, browser session)

  /** Handler on while any context's proxy needs credentials, off otherwise. */
  async syncFetchAuth(t: Transport): Promise<void> {
    const want = [...this.contexts.values()].some((c) => c.creds !== null);
    if (want === this.fetchOn) return;
    if (want) {
      this.offEvents = t.onEvent((e) => this.onEvent(t, e));
      try {
        await t.send("Fetch.enable", { handleAuthRequests: true }, null, 10_000);
      } catch (e) {
        this.offEvents();
        this.offEvents = null;
        throw e;
      }
      this.fetchOn = true;
      log.info("pool: proxy auth handler on (Fetch, browser session)");
    } else {
      this.fetchOn = false;
      this.offEvents?.();
      this.offEvents = null;
      await t.send("Fetch.disable", {}, null, 10_000);
      log.info("pool: proxy auth handler off");
    }
  }

  private onEvent(t: Transport, e: CdpEvent): void {
    if (e.sessionId !== null) return; // page-level Fetch (the recorder) is not ours
    const requestId = str(e.params, "requestId");
    if (requestId === null) return;
    if (e.method === "Fetch.requestPaused") {
      void t.send("Fetch.continueRequest", { requestId }, null, 10_000).catch((x: unknown) => log.debug("pool: continueRequest failed (tolerated)", { error: String(x) }));
      return;
    }
    if (e.method !== "Fetch.authRequired") return;
    const ch = isRecord(e.params["authChallenge"]) ? e.params["authChallenge"] : {};
    const source = str(ch, "source");
    const origin = (str(ch, "origin") ?? "").toLowerCase();
    let response: Record<string, unknown> = { response: "Default" };
    if (source === "Proxy") {
      const ctx = [...this.contexts.values()].find((c) => c.origin === origin && c.creds !== null);
      const now = this.now();
      const recent = (this.answered.get(origin) ?? []).filter((x) => now - x < 10_000);
      if (ctx?.creds == null || recent.length >= 5) {
        if (ctx !== undefined) log.warn("pool: the proxy keeps rejecting the credentials; cancelled", { proxy: ctx.proxy });
        response = { response: "CancelAuth" };
      } else {
        recent.push(now);
        response = { response: "ProvideCredentials", username: ctx.creds.username, password: ctx.creds.password };
      }
      this.answered.set(origin, recent);
    }
    void t.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: response }, null, 10_000).catch((x: unknown) => log.debug("pool: continueWithAuth failed (tolerated)", { error: String(x) }));
  }

  // ---------------------------------------------------------- guard: budget, cooling, failed logins

  /** The account's request budget this hour: null when none is configured. */
  budget(store: Pick<Store, "accountCounter">, site: string, user: string): { limit: number; requests: number; windowStart: number } | null {
    const limit = this.cfg().budget.requestsPerHour;
    if (limit === null) return null;
    const c = store.accountCounter(site, user, this.now());
    return { limit, requests: c.requests, windowStart: c.windowStart };
  }

  /** One recorded request of the account; returns the budget when this request reached it (emit `guard budget` once). */
  noteRequest(store: Pick<Store, "noteAccountRequest">, site: string, user: string): { limit: number; requests: number; windowStart: number } | null {
    const c = store.noteAccountRequest(site, user, this.now());
    const r = this.rotation.get(key(site, user));
    if (r !== undefined) r.requests++;
    const limit = this.configError === null ? this.config.budget.requestsPerHour : null;
    return limit !== null && c.requests === limit ? { limit, requests: c.requests, windowStart: c.windowStart } : null;
  }

  /** A guard breaker in the account's session: cooling starts; returns coolUntil (null: state kept). */
  startCooling(store: Pick<Store, "account" | "patchAccount">, site: string, user: string): number | null {
    const a = store.account(site, user);
    if (a === null) return null;
    const patch = accountOnBreaker(a, this.now());
    store.patchAccount(site, user, patch);
    return patch.coolUntil ?? null;
  }

  /** One failed login (a `--confirm`ed retry): the account's failure count, and whether it now needs the human. */
  failedLogin(store: Pick<Store, "account" | "patchAccount">, site: string, user: string): { failures: number; limit: number; needsHuman: boolean } | null {
    const a = store.account(site, user);
    if (a === null) return null;
    const { needsHuman, ...patch } = accountOnFailedLogin(a, this.now());
    store.patchAccount(site, user, patch);
    return { failures: patch.failStreak, limit: FAILED_LOGIN_LIMIT, needsHuman };
  }

  /** `handoff continue` on a session whose account needs the human: back to active. */
  clearNeedsHuman(store: Pick<Store, "account" | "patchAccount">, site: string, user: string): boolean {
    const a = store.account(site, user);
    if (a === null || a.state !== "needs-human") return false;
    store.patchAccount(site, user, accountCleared());
    return true;
  }

  // ---------------------------------------------------------- health loop

  /** One tick of the periodic health check: only with `pool.health.url`, only due proxies. */
  async healthTick(store: Pick<Store, "proxies" | "proxy" | "updateProxy">, fetchImpl: HttpClient = fetch): Promise<number> {
    if (this.healthRunning || this.configError !== null) return 0;
    const { url, intervalS } = this.config.health;
    if (url === null) return 0;
    this.healthRunning = true;
    let n = 0;
    try {
      for (const p of store.proxies()) {
        if (!proxyDue(p, this.now(), intervalS * 1000)) continue;
        const r = await checkThrough(p, url, fetchImpl);
        const cur = store.proxy(p.name);
        if (cur === null) continue;
        store.updateProxy(p.name, patchFor(cur, r, this.now()));
        n++;
      }
    } finally {
      this.healthRunning = false;
    }
    return n;
  }
}

/**
 * `ext` mode (phase 2: the user's own Chrome, one cookie jar): only accounts
 * bound to `system` (or never bound), and one account at a time. null = fine.
 */
export function extContextError(accountProxy: string | null, account: { site: string; user: string }, others: ReadonlyArray<{ site: string; account: string | null }>): TabcapError | null {
  const own = accountProxy === null || accountProxy === "system";
  const clash = others.some((o) => o.account !== null && (o.site !== account.site || o.account !== account.user));
  if (own && !clash) return null;
  return new TabcapError(
    "ext.no-context",
    own ? `ext mode has one cookie jar: another account is already in use` : `account ${account.site}.${account.user} goes out through proxy "${accountProxy ?? ""}", which needs its own browser context`,
    "Use the direct mode (`tabcap browser start`, Chrome for Testing): it gives each pool account its own browser context and proxy.",
  );
}
