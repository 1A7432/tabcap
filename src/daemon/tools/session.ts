// tabcap session start|stop|list, tabcap tab list|select|close

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { cookieArray, siteCookieUrls } from "../capture/cookies.ts";
import type { Daemon, SiteBinding } from "../state.ts";
import { extContextError } from "../pool/runtime.ts";
import { checkSiteName, type Store } from "../store/db.ts";
import type { Transport } from "../transport/types.ts";
import { checkSessionName, optBool, optStr, reqStr, type Args } from "./args.ts";
import { stopTrace } from "./trace.ts";

const START_USAGE = "tabcap session start <name> [--site <site>] [--account <user>|auto]";

/**
 * `session start <name> [--site <s>] [--account <user>|auto]` (0.4-D): the
 * account is the given one, the strategy's pick (`auto`), or the site's first.
 * 0.6-D: every account session gets its own browser context (through the
 * account's pool proxy when it has one), with its saved cookies restored; only
 * sessions without an account use the default context. The output and the
 * manifest carry account and proxy names only.
 */
export async function sessionStart(d: Daemon, a: Args): Promise<unknown> {
  const name = checkSessionName(reqStr(a, "name", START_USAGE));
  const siteArg = optStr(a, "site");
  const accountArg = optStr(a, "account");
  if (accountArg !== null && siteArg === null) throw new TabcapError("usage", "--account needs --site", `Usage: ${START_USAGE}`);
  const { t, tabs } = d.need();
  let binding: SiteBinding | null = null;
  let restored: number | null = null;
  if (siteArg !== null) {
    const store = d.needStore();
    const site = store.site(checkSiteName(siteArg));
    // 0.6-R: nothing is made before the checks pass, and the error says so (a later `net start` would make an unbound session).
    if (site === null) {
      throw new TabcapError(
        "not-found",
        `no site named "${siteArg}" in the store; session "${name}" was not started`,
        `Run \`tabcap site list\`, or add it with \`tabcap site add <name> --url <entry> --user <username>\`; then run this \`tabcap session start ${name} --site ${siteArg}\` again before any other command in session "${name}".`,
      );
    }
    const bound = d.sites.get(name);
    if (bound !== undefined && bound.site !== site.name) throw new TabcapError("conflict", `session "${name}" is already bound to site "${bound.site}"`, `Use another session name, or \`tabcap session stop ${name}\` first.`);
    if (bound !== undefined && (accountArg === null || accountArg === bound.account || (accountArg === "auto" && bound.account !== null))) {
      binding = bound; // already started: same binding, nothing new
    } else if (bound !== undefined) {
      throw new TabcapError("conflict", `session "${name}" is already bound to account ${bound.site}.${bound.account ?? "(none)"}`, `Use another session name, or \`tabcap session stop ${name}\` first.`);
    } else {
      const r = await bindAccount(d, t, tabs, name, site.name, accountArg);
      binding = r.binding;
      restored = r.restored;
    }
  }
  const { session, created } = tabs.ensureSession(name);
  if (binding !== null) {
    d.sites.set(name, binding);
    d.recorders.get(name)?.setSite(binding.site, binding.account, binding.proxy);
  }
  const b = d.sites.get(name) ?? null;
  const ctx = d.pool.contexts.get(name);
  return {
    session: session.name,
    created,
    tabs: tabs.sessionTabs(name).map((x) => x.id),
    site: b?.site ?? null,
    account: b?.account ?? null,
    proxy: b?.proxy ?? null,
    ...(binding === null ? {} : { entryUrl: d.needStore().site(binding.site)?.entryUrl ?? null, secrets: [`${binding.site}.username`, `${binding.site}.password`] }),
    ...(ctx === undefined ? {} : { browserContext: "own", cookiesRestored: restored }),
  };
}

/**
 * Pick the account, check it may be used, open its own browser context (0.6-D:
 * every account in the direct mode; through its pool proxy when it has one).
 * `ext` mode has one cookie jar and no contexts (extContextError).
 * 0.6-R: all or nothing — a failure after the context was opened disposes it
 * again, so no account context is left for a later implicit session of the
 * same name (`net start`, `navigate`) to open tabs in without the binding.
 */
export async function bindAccount(
  d: Daemon,
  t: Transport,
  tabs: { sessionTabs(name: string): ReadonlyArray<unknown>; readonly contexts: Map<string, string> },
  session: string,
  site: string,
  accountArg: string | null,
): Promise<{ binding: SiteBinding; restored: number | null }> {
  const store = d.needStore();
  const acc = d.pool.pick(store, site, accountArg);
  if (acc === null) return { binding: { site, account: null, proxy: null }, restored: null };
  const kind: Transport["kind"] = t.kind;
  if (kind === "ext") {
    const err = extContextError(acc.proxy, { site, user: acc.username }, [...d.sites.values()]);
    if (err !== null) throw err;
  }
  const egress = d.pool.egress(store, acc);
  let restored: number | null = null;
  let opened = false;
  try {
    if (kind !== "ext") {
      const row = egress.proxy === null ? null : store.proxy(egress.proxy);
      if (egress.proxy !== null && row === null) throw new TabcapError("not-found", `no proxy named "${egress.proxy}"`, "Run `tabcap proxy list`; rebind the account with `tabcap account bind`.");
      if (tabs.sessionTabs(session).length > 0) {
        throw new TabcapError("conflict", `session "${session}" already has tabs outside account ${site}.${acc.username}'s browser context`, `Start a new session name for this account (its tabs must open in its own context), or \`tabcap session stop ${session}\` first.`);
      }
      const ctx = await d.pool.open(t, { session, site, account: acc.username, proxy: row ?? null });
      opened = true;
      try {
        restored = await d.pool.restoreCookies(store, t, ctx);
      } catch (e) {
        log.warn("pool: restoring the account's cookies failed", { session, error: String(e) });
        restored = null;
      }
      tabs.contexts.set(session, ctx.browserContextId);
    }
    store.patchAccount(site, acc.username, { lastUsedAt: d.pool.now() });
  } catch (e) {
    if (opened) {
      tabs.contexts.delete(session);
      await d.pool.close(t, session).catch((x: unknown) => log.warn("pool: disposing a half-opened account context failed", { session, error: String(x) }));
    }
    throw e;
  }
  // The rotation counters move only once the binding is certain.
  if (kind !== "ext") egress.commit();
  return { binding: { site, account: acc.username, proxy: egress.proxy ?? acc.proxy }, restored };
}

export type SavedSessionInfo = { site: string; account: string; cookies: number; savedAt: number };

/**
 * docs/04 §8.1 `sessions`: save a site account's cookies in the store —
 * Network.getCookies for the site's URLs (entry URL, stored domains, the open
 * tabs on those hosts) on the first tab's CDP session. Returns counts only,
 * never values. Throws on CDP errors (the caller logs).
 */
export async function saveSiteCookies(
  store: Pick<Store, "site" | "saveSession">,
  t: Pick<Transport, "send">,
  bound: { site: string; account: string },
  tabs: ReadonlyArray<{ sessionId: string; url: string }>,
  now = Date.now(),
): Promise<SavedSessionInfo | null> {
  const site = store.site(bound.site);
  const first = tabs[0];
  if (site === null || first === undefined) return null;
  const urls = siteCookieUrls(site.entryUrl, site.domains, tabs.map((x) => x.url));
  const cookies = cookieArray(await t.send("Network.getCookies", { urls }, first.sessionId, 5000));
  store.saveSession(bound.site, bound.account, cookies, now);
  return { site: bound.site, account: bound.account, cookies: cookies.length, savedAt: now };
}

/**
 * Called at `session stop` (before the tabs close) and `handoff continue`.
 * null when the session is not bound to a site with an account, has no open
 * tab, or the browser does not answer (logged). A pool account's context
 * saves all its cookies (Storage.getCookies {browserContextId}).
 */
export async function saveSiteSession(d: Daemon, session: string): Promise<SavedSessionInfo | null> {
  const bound = d.sites.get(session);
  if (bound === undefined || bound.account === null || d.store === null || d.browser === null) return null;
  try {
    let saved: SavedSessionInfo | null;
    if (d.pool.contexts.has(session)) {
      const n = await d.pool.saveCookies(d.store, d.browser.t, session);
      saved = n === null ? null : { site: bound.site, account: bound.account, cookies: n, savedAt: d.pool.now() };
    } else {
      saved = await saveSiteCookies(d.store, d.browser.t, { site: bound.site, account: bound.account }, d.browser.tabs.sessionTabs(session));
    }
    d.refreshSecrets(); // the saved values are secrets from now on
    return saved;
  } catch (e) {
    log.warn("saving the site session failed", { session, site: bound.site, error: String(e) });
    return null;
  }
}

export async function sessionStop(d: Daemon, a: Args): Promise<unknown> {
  const name = checkSessionName(reqStr(a, "name", "tabcap session stop <name>"));
  const { tabs } = d.need();
  if (tabs.session(name) === undefined) throw new TabcapError("not-found", `no session named "${name}"`, "Run `tabcap session list` to see sessions.");
  let bundle: string | null = null;
  // Trace mode ends with the session; what it saw goes into the recording first.
  await stopTrace(d, name, "session stop");
  const r = d.recorders.get(name);
  if (r !== undefined) {
    bundle = (await r.stop()).dir;
    d.recorders.delete(name);
    d.lastBundles.set(name, r);
  }
  // Before the tabs close: their cookies are the session to save (after any write-back the last snapshot started).
  await d.pool.settle();
  const storeSession = await saveSiteSession(d, name);
  const res = await tabs.dropSession(name);
  // 0.4-D: the account's own context goes with the session (its cookies are saved above).
  const disposed = await d.pool.close(d.browser?.t ?? tabs.t, name);
  tabs.contexts.delete(name);
  d.sites.delete(name);
  return { session: name, ...res, bundle, storeSession, ...(disposed ? { browserContext: "disposed" } : {}) };
}

export function sessionList(d: Daemon): unknown {
  if (d.browser === null) return { sessions: [], browser: false };
  const { tabs } = d.browser;
  return {
    sessions: [...tabs.sessions.values()].map((s) => ({
      session: s.name,
      tabs: tabs.sessionTabs(s.name).map((x) => x.id),
      current: s.current,
      recording: d.recorders.has(s.name),
      site: d.sites.get(s.name)?.site ?? null,
      account: d.sites.get(s.name)?.account ?? null,
      proxy: d.sites.get(s.name)?.proxy ?? null,
      handoff: d.guard.get(s.name)?.state ?? null,
    })),
  };
}

/** targetInfoChanged does not always report title changes; refresh the session's tabs once. */
export async function refreshTabInfo(d: Daemon, session: string): Promise<void> {
  const { t, tabs } = d.need();
  const r = await t.send("Target.getTargets", {}, null, 5000).catch(() => null);
  const infos = r !== null && Array.isArray(r["targetInfos"]) ? r["targetInfos"].filter(isRecord) : [];
  for (const tab of tabs.sessionTabs(session)) {
    const info = infos.find((i) => str(i, "targetId") === tab.targetId);
    if (info === undefined) continue;
    tab.url = str(info, "url") ?? tab.url;
    tab.title = str(info, "title") ?? tab.title;
  }
}

export async function tabsList(d: Daemon, _a: Args, session: string): Promise<unknown> {
  const { tabs } = d.need();
  const s = tabs.session(session);
  await refreshTabInfo(d, session);
  return {
    session,
    current: s?.current ?? null,
    tabs: tabs.sessionTabs(session).map((x) => ({
      tab: x.id,
      url: x.url,
      title: x.title,
      owned: x.owned,
      reason: x.reason,
      opener: x.opener,
      current: s?.current === x.id,
      nav: d.navOf(x),
      dialog: x.dialog === null ? null : x.dialog.type,
    })),
  };
}

/**
 * `tab select <tab> [--bring-to-front]`: the
 * session's current tab changes; nothing moves on screen unless
 * --bring-to-front, which is focus ladder level 3 and says so.
 */
export async function tabUse(d: Daemon, a: Args, session: string): Promise<unknown> {
  const id = reqStr(a, "tab", "tabcap tab select <tab> [--bring-to-front]");
  const { t, tabs } = d.need();
  const tab = tabs.use(session, id);
  const base = { session, current: tab.id, url: tab.url, title: tab.title, owned: tab.owned, opener: tab.opener };
  if (!optBool(a, "bringToFront")) return { ...base, broughtToFront: false };
  await tabs.run(tab, () => t.bringToFront(tab.sessionId), { timeoutMs: 15_000 });
  return {
    ...base,
    broughtToFront: true,
    focusLevel: 3,
    warning: "focus ladder level 3: Page.bringToFront activated this tab and made Chrome the frontmost app (it now has the user's screen and keyboard)",
  };
}

export async function tabClose(d: Daemon, a: Args, session: string): Promise<unknown> {
  const id = reqStr(a, "tab", "tabcap tab close <tab>");
  const { tabs } = d.need();
  const tab = tabs.sessionTabs(session).find((x) => x.id === id);
  if (tab === undefined) throw new TabcapError("not-found", `tab ${id} is not in session "${session}"`, "Run `tabcap tab list` to list this session's tabs.");
  await tabs.closeTab(tab);
  return { closed: id, current: tabs.session(session)?.current ?? null };
}
