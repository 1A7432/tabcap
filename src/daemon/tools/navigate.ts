// tabcap navigate | tab new | go back|forward | reload — all wait for readiness
// (docs/07 §1.1), then for the DOM to settle (post-action wait, docs/08 §5;
// --no-wait skips that part).

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS, type NavType, type Tab } from "../browser/targets.ts";
import { protectionField } from "../protection/live.ts";
import type { Daemon } from "../state.ts";
import { confirmState, startReadyWait } from "../transport/direct/ready.ts";
import type { Transport } from "../transport/types.ts";
import { checkSessionName, optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { withPostWait } from "./settle.ts";

/**
 * The readiness wait, then the DOM part of the post-action wait (unless --no-wait),
 * then the once-per-navigation protection probe (0.8-A, docs/04 §41.3): `protection`
 * lists the families identified at confidence ≥ 50, absent when there are none.
 */
async function settled(d: Daemon, t: Transport, tab: Tab, a: Args, nav: () => Promise<NavResult>): Promise<unknown> {
  const { result, wait } = await withPostWait(t, tab, optBool(a, "noWait"), nav, { navigationDone: true });
  return { ...result, wait, ...(await protectionField(d, t, tab)) };
}

const ALLOWED_SCHEMES = new Set(["http:", "https:", "file:", "about:", "data:"]);

export function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TabcapError("usage", `not an absolute URL: ${raw}`, "Pass a full URL including the scheme, e.g. `tabcap navigate http://127.0.0.1:8080/`.");
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new TabcapError("usage", `scheme ${u.protocol} is not allowed`, "Use http(s), file, about or data URLs.");
  return u.href;
}

export function timeoutOf(a: Args): number {
  const t = optNum(a, "timeoutMs");
  return t === null ? DEFAULT_COMMAND_TIMEOUT_MS : Math.max(1000, Math.min(t, 600_000));
}

export type NavResult = { tab: string; url: string; title: string; readyState: string; nav: string | null };

/** Trigger a navigation with `start` and wait until the new document is ready. */
export async function waitNavigation(
  t: Transport,
  tab: Tab,
  expectedUrl: string | null,
  budgetMs: number,
  start: () => Promise<{ loaderId: string | null; sameDocument: boolean }>,
  navOf: () => string | null,
): Promise<NavResult> {
  const until = Date.now() + budgetMs;
  const w = startReadyWait(t, tab.sessionId, tab.targetId, expectedUrl);
  let started: { loaderId: string | null; sameDocument: boolean };
  try {
    started = await start();
  } catch (e) {
    w.cancel();
    throw e;
  }
  w.tracker.setLoaderId(started.loaderId);
  if (!started.sameDocument) {
    const ok = await w.done(Math.max(0, until - Date.now() - 1000));
    if (!ok) {
      throw new TabcapError("timeout", `the page did not become ready (no main-document context) within ${budgetMs} ms`, "Run `tabcap screenshot` to look at the tab; raise --timeout for slow pages.");
    }
  } else w.cancel();
  const st = await confirmState(t, tab.sessionId, Math.max(500, Math.min(10_000, until - Date.now())));
  if (st === null) throw new TabcapError("page", "the page did not answer after navigating", "Run `tabcap snapshot` to check the tab, or navigate again.");
  return { tab: tab.id, url: st.href, title: st.title, readyState: st.readyState, nav: navOf() };
}

export async function navigate(d: Daemon, a: Args, session: string): Promise<unknown> {
  const usage = "tabcap navigate <url> [--session s] [--new-tab | --tab t2] | tabcap tab new <url> [--background]";
  const url = checkUrl(reqStr(a, "url", usage));
  const { t, tabs } = d.need();
  checkSessionName(session);
  const budget = timeoutOf(a);
  const s = tabs.ensureSession(session).session;
  const want = optStr(a, "tab");
  if (want !== null && optBool(a, "newTab")) throw new TabcapError("usage", "--tab and --new-tab exclude each other", `Usage: ${usage}`);
  const cur = s.current === null ? undefined : tabs.tabs.get(s.current);
  const tab = want !== null ? tabs.pick(session, want) : optBool(a, "newTab") || cur === undefined || cur.closed ? await tabs.createTab(session, { background: optBool(a, "background") }) : cur;
  return tabs.run(
    tab,
    () =>
      settled(d, t, tab, a, () => waitNavigation(t, tab, url, budget, async () => {
        tab.pendingNavType = null;
        const r = await t.send("Page.navigate", { url }, tab.sessionId);
        const err = str(r, "errorText");
        if (err !== null && err !== "") {
          throw new TabcapError("page", `navigation to ${url} failed: ${err}`, "Check the URL and that the server is up; with --proxy none only 127.0.0.1 / localhost are reachable.");
        }
        const loaderId = str(r, "loaderId");
        return { loaderId, sameDocument: loaderId === null };
      }, () => d.navOf(tab))),
    { timeoutMs: budget, navigation: true },
  );
}

export async function go(d: Daemon, a: Args, session: string): Promise<unknown> {
  const dir = reqStr(a, "direction", "tabcap go back|forward");
  if (dir !== "back" && dir !== "forward") throw new TabcapError("usage", `go ${dir}?`, "Use `tabcap go back` or `tabcap go forward`.");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const budget = timeoutOf(a);
  return tabs.run(
    tab,
    async () => {
      const h = await t.send("Page.getNavigationHistory", {}, tab.sessionId);
      const idx = num(h, "currentIndex");
      const entries = Array.isArray(h["entries"]) ? h["entries"].filter(isRecord) : [];
      const target = idx === null ? undefined : entries[idx + (dir === "back" ? -1 : 1)];
      const current = idx === null ? undefined : entries[idx];
      const entryId = target === undefined ? null : num(target, "id");
      if (target === undefined || entryId === null) throw new TabcapError("page", `no history entry to go ${dir} to`, "Use `tabcap navigate <url>` instead.");
      const url = str(target, "url") ?? "";
      const sameDoc = current !== undefined && stripHash(str(current, "url") ?? "") === stripHash(url);
      return settled(d, t, tab, a, () => waitNavigation(t, tab, url, budget, async () => {
        tab.pendingNavType = "back_forward" satisfies NavType;
        await t.send("Page.navigateToHistoryEntry", { entryId }, tab.sessionId);
        if (sameDoc) await Bun.sleep(100);
        return { loaderId: null, sameDocument: sameDoc };
      }, () => d.navOf(tab)));
    },
    { timeoutMs: budget, navigation: true },
  );
}

export async function reload(d: Daemon, a: Args, session: string): Promise<unknown> {
  const ignoreCache = optBool(a, "ignoreCache");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const budget = timeoutOf(a);
  return tabs.run(
    tab,
    () =>
      settled(d, t, tab, a, () => waitNavigation(t, tab, tab.url, budget, async () => {
        tab.pendingNavType = "reload";
        await t.send("Page.reload", ignoreCache ? { ignoreCache: true } : {}, tab.sessionId);
        return { loaderId: null, sameDocument: false };
      }, () => d.navOf(tab))),
    { timeoutMs: budget, navigation: true },
  );
}

function stripHash(u: string): string {
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
}
