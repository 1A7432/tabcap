// Sessions and tabs:
// - a session is a name → its tabs + the current tab; tabs the session opened
//   are `owned`, and so are popups whose opener is an owned tab (docs/04 §16):
//   session stop closes owned tabs only, borrowed ones stay;
// - a tab the human opened belongs to no session until `tab adopt` borrows it
//   (docs/04 §51: explicit, owned: false, never by itself);
// - no fallback: a session without a usable tab is an error, never "some other tab";
// - new tabs are background tabs (`Target.createTarget {background:true}`) unless
//   the browser was started with --foreground;
// - nav epochs live in the evidence bundle only (`n-<seq>`, docs/04 §14): the
//   daemon keeps no numbering of its own, it only tracks the navigation type;
// - per-tab command queue with a command timeout, and the dialog lock;
// - docs/04 §52.1–52.2 (11-12): command windows per session and tab (with or
//   without a recording), and a root navigation nobody of the session made — no
//   window acts on the tab, the page did not ask for it (`Page.frameRequestedNavigation`),
//   the session is not waiting for the human — marks the tab `changed`.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../transport/types.ts";
import { RefTable } from "./refs.ts";
import type { EmulationSettings } from "../tools/emulatespec.ts";

export type NavType = "navigation" | "history" | "reload" | "back_forward";

export type DialogInfo = { type: string; message: string; defaultPrompt: string; url: string; openedAt: number };

export type Tab = {
  id: string;
  targetId: string;
  sessionId: string;
  session: string;
  owned: boolean;
  reason: "ai-opened" | "popup" | "borrowed";
  /** Tab id of the opener (popups), else null. */
  opener: string | null;
  url: string;
  title: string;
  navType: NavType | null;
  /** Monotonic count of committed navigations (root-frame `Page.frameNavigated` and same-document); 0 before the first. */
  navEpoch: number;
  /** Set by go/reload so the next root commit gets the right nav type. */
  pendingNavType: NavType | null;
  loading: boolean;
  refs: RefTable;
  dialog: DialogInfo | null;
  queue: Promise<unknown>;
  closed: boolean;
  dialogWaiters: Set<(d: DialogInfo) => void>;
  /** Where tabcap's last trusted mouse event left the pointer (viewport CSS px); null on a new tab or document. */
  pointer: { x: number; y: number } | null;
  /** What `tabcap emulate` set on this tab ({} = nothing); throttling scales the post-action wait. */
  emulation: EmulationSettings;
};

export type Session = {
  name: string;
  tabs: string[];
  current: string | null;
  created: number;
  lastClosed: string | null;
  /** Tabs that were current, most recent first (0.7.3: fallback when the current tab closes). */
  recentCurrent: string[];
  /** docs/04 §52.5: what the session is for, one line for other agents and the human; null when not given. */
  purpose: string | null;
};

/** docs/04 §52.3: a page target of the browser that is not the asking session's; `held` is the tab of the session that has it. */
export type OtherTab = { target: string; url: string; title: string; held: Tab | null };

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** A page target as `Target.getTargets` reports it; `browserContextId` null when Chrome names none. */
type PageTarget = { targetId: string; url: string; title: string; browserContextId: string | null };

/** docs/04 §52.2: a root navigation of a session tab that neither the session nor the page made. */
export type TabChange = { at: number; from: string; to: string; by: "external" };

/**
 * docs/04 §52.1: `Page.frameStartedNavigating` types that load another document
 * (same-document ones never reach `Page.frameNavigated`). Measured 11-12 (CfT 157):
 * a page's own navigation (script, reload, meta refresh) sends
 * `Page.frameRequestedNavigation` first; `Page.navigate` / `Page.reload` /
 * `Page.navigateToHistoryEntry` from another CDP client does not, and neither does
 * a page's `history.back()` (known gap).
 */
const DOCUMENT_NAV_TYPES: ReadonlySet<string> = new Set(["differentDocument", "historyDifferentDocument", "reload", "reloadBypassingCache", "restore", "restoreWithPost"]);

/** A command window as Tabs sees it: which session, which tab it acts on (null: none at its start), its `tick()` at the start. */
type CmdWindow = { session: string; tab: string | null; started: number };

/**
 * docs/04 §52.1: does a command window act on tab `tabId`? Its own tab, or any tab
 * that joined the session after it began (the tab it opens, a popup it causes).
 * `started` and `joinedAt` are `Tabs.tick()` stamps (a counter: two things in the
 * same millisecond still have an order).
 */
export function windowCovers(w: { session: string; tab: string | null; started: number }, tab: { id: string; session: string }, joinedAt: number): boolean {
  if (w.session !== tab.session) return false;
  return (w.tab !== null && w.tab === tab.id) || joinedAt > w.started;
}

/**
 * docs/04 §52.1: is a root navigation starting now external? Not when the page asked
 * for it, a window of the session acts on the tab, or the session waits for the human
 * (their own navigation then, §37).
 */
export function isExternalStart(o: { pageRequested: boolean; covered: boolean; waiting: boolean; navigationType: string }): boolean {
  if (!DOCUMENT_NAV_TYPES.has(o.navigationType)) return false;
  return !o.pageRequested && !o.covered && !o.waiting;
}

/** Per-tab state of §52.1–52.2. */
type Drift = {
  /** A `Page.frameRequestedNavigation` for the root frame since the last navigation start. */
  requested: boolean;
  /** An external navigation has started and not committed yet. */
  pending: { from: string; at: number } | null;
  /** The tab is in a nav epoch an external navigation opened (until a command of the session acts on it). */
  epoch: boolean;
  changed: TabChange | null;
};

/** docs/04 §52.4: a tab another session took; kept by the old tab id until reported once. */
type Taken = { session: string; by: string; at: number; url: string; target: string; reported: boolean };

/** docs/04 §52.4: the error the old session gets, once, when it names the tab (or it was its current tab). */
export function tabTakenError(tab: string, k: { by: string; at: number; url: string; target: string }): TabcapError {
  return new TabcapError(
    "tab-taken",
    `tab ${tab} was taken by session "${k.by}" at ${new Date(k.at).toISOString()} (it was at ${k.url}); it is no longer this session's`,
    `\`tabcap tab list --all\` shows it under session "${k.by}". To take it back: \`tabcap tab adopt ${k.target.slice(0, ADOPT_MIN_PREFIX)}\`; to go on with another tab of this session: \`tabcap tab select <tab>\`.`,
    { tab, by: k.by, at: new Date(k.at).toISOString(), url: k.url },
  );
}

/** Least length of a `tab adopt` prefix (docs/04 §51). */
export const ADOPT_MIN_PREFIX = 8;

/**
 * docs/04 §51: may a session take a tab of this browser context? A session with its own context
 * takes only that context's tabs; any other session takes none of another session's own context,
 * or `fill --secret` would type one account's password into a page with another's cookies.
 */
export function adoptContextOk(sessionContext: string | undefined, tabContext: string | null, ownContexts: ReadonlySet<string>): boolean {
  if (sessionContext !== undefined) return tabContext === sessionContext;
  return tabContext === null || !ownContexts.has(tabContext);
}

export class Tabs {
  readonly sessions = new Map<string, Session>();
  readonly tabs = new Map<string, Tab>();
  /** Browser context of a session whose account goes out through a pool proxy (0.4-D); absent: the default context. */
  readonly contexts = new Map<string, string>();
  private tabSeq = 0;
  /** Commands running on a tab right now (inside `run`), by daemon tab id (0.9-D: a download that begins then is that command's). */
  private running = new Map<string, number>();
  /** docs/04 §52.1: open command windows (every session, recorded or not), by window id. */
  private windows = new Map<number, CmdWindow>();
  private windowSeq = 0;
  /** docs/04 §52.1: `tick()` when each tab joined its session. */
  private joined = new Map<string, number>();
  private clock = 0;
  private drift = new Map<string, Drift>();
  /** docs/04 §52.4: tabs other sessions took, by the old tab id. */
  private taken = new Map<string, Taken>();
  /** docs/04 §52.4: the session a tab was taken from, by its new tab id. */
  private takenFrom = new Map<string, string>();
  private takenListeners = new Set<(tab: Tab, by: string) => Promise<void>>();
  /** docs/04 §52.1: is the session waiting for the human? The daemon sets it (guard); navigations then are the human's. */
  waitingOf: (session: string) => boolean = () => false;
  private addedListeners = new Set<(tab: Tab) => Promise<void>>();
  private navListeners = new Set<(tab: Tab, e: CdpEvent) => void>();
  private offs: Array<() => void> = [];

  constructor(
    readonly t: Transport,
    readonly foreground: boolean,
  ) {
    this.offs.push(
      t.onEvent((e) => this.onEvent(e)),
      t.onDetach((x) => this.onDetached(x)),
      // Popups: page targets whose opener is one of our tabs join that session;
      // owned when the opener is owned (docs/04 §16), never the current tab by themselves.
      t.onAttach(async (x) => {
        if (x.type !== "page" || x.openerId === null) return;
        const opener = this.byTarget(x.openerId);
        if (opener === undefined) return;
        const tab = this.register(opener.session, x, opener.owned, opener.id);
        await this.fireAdded(tab);
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Called (and awaited) for every tab that joins a session, before it loads anything. */
  onTabAdded(fn: (tab: Tab) => Promise<void>): () => void {
    this.addedListeners.add(fn);
    return () => this.addedListeners.delete(fn);
  }

  /** docs/04 §52.4: called (and awaited) when another session takes a tab, before it joins that session; `tab` is the old one. */
  onTabTaken(fn: (tab: Tab, by: string) => Promise<void>): () => void {
    this.takenListeners.add(fn);
    return () => this.takenListeners.delete(fn);
  }

  /** docs/04 §52.4: the session this tab was taken from, or null. */
  takenFromOf(tabId: string): string | null {
    return this.takenFrom.get(tabId) ?? null;
  }

  /** Root-frame commits and same-document navigations of session tabs (after the epoch moved). */
  onNav(fn: (tab: Tab, e: CdpEvent) => void): () => void {
    this.navListeners.add(fn);
    return () => this.navListeners.delete(fn);
  }

  byTarget(targetId: string): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId && !tab.closed) return tab;
    return undefined;
  }

  bySession(sessionId: string): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId && !tab.closed) return tab;
    return undefined;
  }

  /** Host tab of a CDP session: the tab's own session, or a child (OOPIF, worker) attached under it. */
  hostOf(sessionId: string): Tab | undefined {
    let sid: string | null = sessionId;
    for (let depth = 0; sid !== null && depth < 8; depth++) {
      const tab = this.bySession(sid);
      if (tab !== undefined) return tab;
      const cur: string = sid;
      sid = this.t.targets().find((x) => x.sessionId === cur)?.parentSessionId ?? null;
    }
    return undefined;
  }

  session(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  ensureSession(name: string): { session: Session; created: boolean } {
    const have = this.sessions.get(name);
    if (have !== undefined) return { session: have, created: false };
    const s: Session = { name, tabs: [], current: null, created: Date.now(), lastClosed: null, recentCurrent: [], purpose: null };
    this.sessions.set(name, s);
    return { session: s, created: true };
  }

  sessionTabs(name: string): Tab[] {
    const s = this.sessions.get(name);
    if (s === undefined) return [];
    return s.tabs.map((id) => this.tabs.get(id)).filter((x): x is Tab => x !== undefined && !x.closed);
  }

  /** The session's current tab, or a no-tab error that says what to do. */
  currentTab(name: string): Tab {
    const s = this.sessions.get(name);
    if (s === undefined) throw new TabcapError("no-tab", `session "${name}" does not exist`, "Run `tabcap navigate <url>` (it creates the session) or `tabcap session start <name>`.");
    const tab = s.current === null ? undefined : this.tabs.get(s.current);
    if (tab === undefined || tab.closed) {
      if (s.lastClosed !== null) this.throwTaken(name, s.lastClosed);
      // docs/04 §54.4: the closed tab's last URL, so the caller can open it again; tabcap never reopens a tab by itself.
      const was = s.lastClosed === null ? undefined : this.tabs.get(s.lastClosed);
      const at = was !== undefined && /^https?:/i.test(was.url) ? was.url : null;
      const why = s.lastClosed !== null ? `session "${name}" tab ${s.lastClosed} was closed${at === null ? "" : ` (it was at ${at})`}` : `session "${name}" has no tab`;
      throw new TabcapError(
        "no-tab",
        why,
        at === null
          ? "run navigate first: `tabcap navigate <url>` opens a background tab for this session."
          : "run navigate first: `tabcap navigate <url>` opens a background tab for this session; `lastUrl` is where the closed tab was (tabcap does not reopen a closed tab by itself: the user may have closed it on purpose).",
        at === null ? {} : { lastUrl: at },
      );
    }
    return tab;
  }

  /**
   * `--tab <id>` when given — it must be an open tab of this session (never
   * another session's) — else the session's current tab.
   */
  pick(name: string, id: string | null): Tab {
    if (id === null) return this.currentTab(name);
    const tab = this.tabs.get(id);
    if (tab === undefined || tab.closed || tab.session !== name) {
      this.throwTaken(name, id);
      throw new TabcapError("no-tab", `tab ${id} is not an open tab of session "${name}"`, "Run `tabcap tab list` to list this session's tabs.");
    }
    return tab;
  }

  /** docs/04 §52.4: `tab-taken` the first time the old session names a tab another session took. */
  private throwTaken(session: string, id: string): void {
    const k = this.taken.get(id);
    if (k === undefined || k.session !== session || k.reported) return;
    k.reported = true;
    throw tabTakenError(id, k);
  }

  /** Make one of the session's tabs its current tab (`tabcap tab select`). */
  use(name: string, id: string): Tab {
    const tab = this.pick(name, id);
    const s = this.sessions.get(name);
    if (s !== undefined) this.setCurrent(s, tab.id);
    return tab;
  }

  /** Set the current tab and remember it: closing the current tab falls back to the most recent one still open. */
  private setCurrent(s: Session, id: string): void {
    s.current = id;
    s.recentCurrent = [id, ...s.recentCurrent.filter((x) => x !== id)].slice(0, 64);
  }

  /** Open a new background tab for the session (about:blank, attached, domains enabled). */
  async createTab(sessionName: string, opts: { background?: boolean } = {}): Promise<Tab> {
    const { session } = this.ensureSession(sessionName);
    const browserContextId = this.contexts.get(session.name);
    const r = await this.t.send("Target.createTarget", { url: "about:blank", background: opts.background === true || !this.foreground, ...(browserContextId === undefined ? {} : { browserContextId }) });
    const targetId = str(r, "targetId");
    if (targetId === null) throw new TabcapError("cdp", "Target.createTarget returned no targetId", "Retry; if it persists restart the browser with `tabcap browser stop && tabcap browser start`.");
    const attached = await this.t.waitAttached(targetId, 10_000);
    const tab = this.register(session.name, attached, true);
    await this.fireAdded(tab);
    this.setCurrent(session, tab.id);
    return tab;
  }

  /** The browser's page targets; DevTools and extension pages are not tabs anyone adopts (docs/04 §51). */
  private async pageTargets(): Promise<PageTarget[]> {
    const r = await this.t.send("Target.getTargets", {}, null, 5000);
    const infos = Array.isArray(r["targetInfos"]) ? r["targetInfos"].filter(isRecord) : [];
    return infos.flatMap((i) => {
      const targetId = str(i, "targetId");
      const url = str(i, "url") ?? "";
      if (targetId === null || str(i, "type") !== "page" || url.startsWith("devtools://") || url.startsWith("chrome-extension://")) return [];
      return [{ targetId, url, title: str(i, "title") ?? "", browserContextId: str(i, "browserContextId") }];
    });
  }

  /** `tab list --all` (docs/04 §51, §52.3): every page target that is not `session`'s, with the tab of the session holding it. */
  async others(session: string): Promise<OtherTab[]> {
    return (await this.pageTargets()).flatMap((x) => {
      const held = this.byTarget(x.targetId) ?? null;
      if (held !== null && held.session === session) return [];
      return [{ target: x.targetId.toLowerCase(), url: x.url, title: x.title, held }];
    });
  }

  /** The one page target `ref` names: a target id or a prefix of at least ADOPT_MIN_PREFIX characters (docs/04 §51). */
  private async resolveTarget(ref: string, verb: string): Promise<PageTarget> {
    const prefix = ref.toLowerCase();
    if (prefix.length < ADOPT_MIN_PREFIX) throw new TabcapError("usage", `${verb} needs at least ${ADOPT_MIN_PREFIX} characters of the target, got "${ref}"`, "Copy `target` from `tabcap tab list --all`.");
    const hits = (await this.pageTargets()).filter((x) => x.targetId.toLowerCase().startsWith(prefix));
    const hit = hits[0];
    if (hit === undefined) throw new TabcapError("not-found", `no tab with target ${ref}`, "Run `tabcap tab list --all` to see the browser's other tabs.");
    if (hits.length > 1) throw new TabcapError("usage", `target ${ref} matches ${hits.length} tabs: ${hits.map((x) => x.targetId.toLowerCase()).join(", ")}`, "Give more characters of the target.");
    return hit;
  }

  /** docs/04 §52.3: read-only views of any page target (`--target`), by target id; in no session, with refs of their own. */
  private viewers = new Map<string, Tab>();

  /**
   * docs/04 §52.3: a tab object for reading the page target `ref` without taking it:
   * not in any session, not recorded, no listener, its own ref table (so another
   * session's refs stay as they were), id `@<first 8 of the target>`.
   */
  async viewTarget(ref: string): Promise<Tab> {
    const hit = await this.resolveTarget(ref, "--target");
    let v = this.viewers.get(hit.targetId);
    if (v === undefined || v.closed) {
      const attached = await this.t.waitAttached(hit.targetId, 5000);
      v = this.makeTab(`@${hit.targetId.slice(0, ADOPT_MIN_PREFIX).toLowerCase()}`, attached, "", false, null, "borrowed");
      this.viewers.set(hit.targetId, v);
    }
    v.url = hit.url;
    v.title = hit.title;
    return v;
  }

  /**
   * `tab adopt`: borrow the page target `ref` (a target id or a prefix of at least ADOPT_MIN_PREFIX
   * characters) into the session as its current tab. Nothing moves on screen; every refusal comes
   * before the session is created, so a failed adopt leaves nothing behind.
   */
  async adopt(sessionName: string, ref: string): Promise<{ tab: Tab; already: boolean }> {
    const hit = await this.resolveTarget(ref, "tab adopt");
    const held = this.byTarget(hit.targetId);
    if (held !== undefined && held.session === sessionName) {
      const s = this.sessions.get(sessionName);
      if (s !== undefined) this.setCurrent(s, held.id);
      return { tab: held, already: true };
    }
    // docs/04 §52.4: another session's tab can be taken, without its consent, except while it is busy on it or waits for the human.
    if (held !== undefined && this.waitingOf(held.session)) {
      throw new TabcapError("conflict", `that tab is ${held.id} of session "${held.session}", which is waiting for the human (they may be using it)`, `Wait until session "${held.session}" is resumed (\`tabcap handoff continue --session ${held.session}\`), then adopt it.`);
    }
    if (held !== undefined && (this.busy(held) || this.hasWindowOn(held))) {
      throw new TabcapError("conflict", `that tab is ${held.id} of session "${held.session}", and a command of that session is running on it`, "Try again in a moment, when that command has finished.");
    }
    if (!adoptContextOk(this.contexts.get(sessionName), hit.browserContextId, new Set(this.contexts.values()))) {
      throw new TabcapError("conflict", `that tab is in another browser context than session "${sessionName}"`, "A session with its own context (a stored site's account) only takes tabs opened in its own windows; adopt it in a session that has none.");
    }
    if (held !== undefined) await this.take(held, sessionName, hit.targetId);
    const attached = await this.t.waitAttached(hit.targetId, 5000);
    const { session } = this.ensureSession(sessionName);
    const tab = this.register(session.name, attached, false, null, "borrowed");
    if (held !== undefined) this.takenFrom.set(tab.id, held.session);
    await this.fireAdded(tab);
    this.setCurrent(session, tab.id);
    return { tab, already: false };
  }

  private register(sessionName: string, x: AttachedTarget, owned: boolean, opener: string | null = null, reason: Tab["reason"] = opener === null ? "ai-opened" : "popup"): Tab {
    const existing = this.byTarget(x.targetId);
    if (existing !== undefined) return existing;
    const { session } = this.ensureSession(sessionName);
    const tab = this.makeTab(`t${++this.tabSeq}`, x, session.name, owned, opener, reason);
    this.tabs.set(tab.id, tab);
    this.joined.set(tab.id, this.tick());
    session.tabs.push(tab.id);
    log.info("tab registered", { tab: tab.id, session: session.name, owned, opener });
    return tab;
  }

  private makeTab(id: string, x: AttachedTarget, session: string, owned: boolean, opener: string | null, reason: Tab["reason"]): Tab {
    return {
      id,
      targetId: x.targetId,
      sessionId: x.sessionId,
      session,
      owned,
      reason,
      opener,
      url: x.url,
      title: x.title,
      navType: null,
      navEpoch: 0,
      pendingNavType: null,
      loading: false,
      refs: new RefTable(),
      dialog: null,
      queue: Promise.resolve(),
      closed: false,
      dialogWaiters: new Set(),
      pointer: null,
      emulation: {},
    };
  }

  private async fireAdded(tab: Tab): Promise<void> {
    for (const fn of [...this.addedListeners]) {
      await fn(tab).catch((e: unknown) => log.warn("tabAdded listener failed", { tab: tab.id, error: String(e) }));
    }
  }

  /** Forget a tab (closed, crashed, detached); it leaves its session. */
  markClosed(tab: Tab): void {
    if (tab.closed) return;
    tab.closed = true;
    this.drift.delete(tab.id);
    this.joined.delete(tab.id);
    const s = this.sessions.get(tab.session);
    if (s !== undefined) {
      s.tabs = s.tabs.filter((id) => id !== tab.id);
      if (s.current === tab.id) {
        s.lastClosed = tab.id;
        // 0.7.3: no `tab select` needed after closing the current tab. Borrowed
        // tabs never become the fallback; among owned ones the most recently
        // current wins, else the last opened (docs/04 §16).
        const open = this.sessionTabs(tab.session).filter((x) => x.owned);
        const recent = s.recentCurrent.find((id) => open.some((x) => x.id === id));
        s.current = recent ?? open.at(-1)?.id ?? null;
        if (s.current !== null) this.setCurrent(s, s.current);
      }
    }
  }

  async closeTab(tab: Tab): Promise<void> {
    await this.t.send("Target.closeTarget", { targetId: tab.targetId }, null, 10_000).catch((e: unknown) => {
      log.warn("closeTarget failed", { tab: tab.id, error: String(e) });
    });
    this.markClosed(tab);
  }

  /** Drop a session: close owned tabs, release the others. */
  async dropSession(name: string): Promise<{ closed: string[]; released: string[] }> {
    const closed: string[] = [];
    const released: string[] = [];
    for (const tab of this.sessionTabs(name)) {
      if (tab.owned) {
        await this.closeTab(tab);
        closed.push(tab.id);
      } else {
        this.markClosed(tab);
        released.push(tab.id);
      }
    }
    this.sessions.delete(name);
    return { closed, released };
  }

  /**
   * A pending navigation whose document never arrives makes Chrome defer every
   * other command on the tab's session (Runtime, Page, Network, Accessibility —
   * measured 10-15), so one timed-out command would wedge all later ones.
   * Page.stopLoading answers at once, ends the navigation with ERR_ABORTED and
   * releases the session.
   */
  private async unwedge(tab: Tab): Promise<string> {
    const ok = await this.t.send("Page.stopLoading", {}, tab.sessionId, 3000).then(
      () => true,
      () => false,
    );
    tab.loading = false;
    log.warn("stopped a pending page load after a timeout", { tab: tab.id, ok });
    return ok ? "; the pending page load was stopped so the tab stays usable" : "; stopping the pending page load failed too";
  }

  /**
   * docs/04 §52.1: a command of `session` begins; `tab` is the daemon tab it acts on
   * (`--tab`, else the current tab; null when the session has none). The tab's
   * external nav epoch ends here. Returns the window id for `closeWindow`.
   */
  openWindow(session: string, tab: string | null): number {
    const id = ++this.windowSeq;
    this.windows.set(id, { session, tab, started: this.tick() });
    if (tab !== null) {
      const d = this.drift.get(tab);
      if (d !== undefined) {
        d.epoch = false;
        d.pending = null;
      }
    }
    return id;
  }

  closeWindow(id: number): void {
    this.windows.delete(id);
  }

  /** docs/04 §52.1: an ordering stamp for windows and tab joins (the recorder stamps its command windows with it too). */
  tick(): number {
    return ++this.clock;
  }

  /** The tab's `tick()` stamp when it joined its session; 0 when unknown. */
  joinedAt(tabId: string): number {
    return this.joined.get(tabId) ?? 0;
  }

  /** docs/04 §52.4: a window of the tab's own session names this very tab. */
  private hasWindowOn(tab: Tab): boolean {
    for (const w of this.windows.values()) if (w.session === tab.session && w.tab === tab.id) return true;
    return false;
  }

  /**
   * docs/04 §52.4: `held` leaves its session for `by`. Its session does not fall back to
   * another tab when this was its current one (current becomes null): its next command
   * gets `tab-taken`, never silently another page.
   */
  private async take(held: Tab, by: string, target: string): Promise<void> {
    for (const fn of [...this.takenListeners]) await fn(held, by).catch((e: unknown) => log.warn("tabTaken listener failed", { tab: held.id, error: String(e) }));
    const s = this.sessions.get(held.session);
    const wasCurrent = s?.current === held.id;
    this.markClosed(held);
    if (s !== undefined && wasCurrent) {
      s.current = null;
      s.lastClosed = held.id;
    }
    this.taken.set(held.id, { session: held.session, by, at: Date.now(), url: held.url, target: target.toLowerCase(), reported: false });
    log.info("tab taken", { tab: held.id, from: held.session, by });
  }

  /** docs/04 §52.1: does an open command window of the tab's session act on it? */
  covered(tab: Tab): boolean {
    const at = this.joinedAt(tab.id);
    for (const w of this.windows.values()) if (windowCovers(w, tab, at)) return true;
    return false;
  }

  /** docs/04 §52.1: events on this tab are `actor:"external"` now (an external navigation started, or its epoch). */
  external(tabId: string): boolean {
    const d = this.drift.get(tabId);
    return d !== undefined && (d.pending !== null || d.epoch);
  }

  /** docs/04 §52.2: the tab's unacknowledged external change, or null. */
  changedOf(tabId: string): TabChange | null {
    return this.drift.get(tabId)?.changed ?? null;
  }

  /** docs/04 §52.2: `navigate` / `tab select` on the tab acknowledge the change. */
  acknowledge(tabId: string): void {
    const d = this.drift.get(tabId);
    if (d === undefined) return;
    d.changed = null;
    d.epoch = false;
    d.pending = null;
  }

  private driftOf(tabId: string): Drift {
    let d = this.drift.get(tabId);
    if (d === undefined) {
      d = { requested: false, pending: null, epoch: false, changed: null };
      this.drift.set(tabId, d);
    }
    return d;
  }

  /** 0.9-D (docs/04 §48): a command is running on the tab now (its `run` job has started and not ended). */
  busy(tab: Tab): boolean {
    return (this.running.get(tab.id) ?? 0) > 0;
  }

  /**
   * Run `fn` on the tab's queue with a command timeout. The dialog lock: a tab
   * with an open JavaScript dialog refuses commands; a dialog opening while the
   * command runs ends it with an error saying the action already happened.
   */
  run<T>(tab: Tab, fn: () => Promise<T>, opts: { timeoutMs?: number; allowDialog?: boolean; navigation?: boolean } = {}): Promise<T> {
    const ms = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const job = tab.queue.then(async () => {
      if (tab.closed) throw new TabcapError("no-tab", `tab ${tab.id} was closed`, "run navigate first: `tabcap navigate <url>`.");
      if (tab.dialog !== null && opts.allowDialog !== true) throw dialogError(tab.dialog, false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onDialog: ((d: DialogInfo) => void) | undefined;
      let timerFired = false;
      const timeoutGuard = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timerFired = true;
            const pending = tab.loading || opts.navigation === true;
            void (pending ? this.unwedge(tab) : Promise.resolve("")).then((note) =>
              reject(
                new TabcapError(
                  "timeout",
                  `command did not finish within ${ms} ms${pending ? " (the page never finished loading — is the server answering?)" : ""}${note}`,
                  pending ? "Check that the site responds, then `tabcap navigate <url>` again; raise --timeout for slow pages." : "Check the page with `tabcap snapshot` or `tabcap screenshot`; raise --timeout if the page is just slow.",
                ),
              ),
            );
          }, ms);
        });
      timeoutGuard.catch(() => undefined); // observed via the race below
      const guards: Array<Promise<never>> = [timeoutGuard];
      if (opts.allowDialog !== true) {
        guards.push(
          new Promise<never>((_, reject) => {
            onDialog = (d) => reject(dialogError(d, true));
            tab.dialogWaiters.add(onDialog);
          }),
        );
      }
      this.running.set(tab.id, (this.running.get(tab.id) ?? 0) + 1);
      try {
        return await Promise.race([fn(), ...guards]);
      } catch (e) {
        // Stopping the load makes the command itself fail (ERR_ABORTED); report the timeout instead.
        if (timerFired) throw await timeoutGuard.then(() => e, (x: unknown) => x);
        // A timeout inside the command (readiness wait, a CDP call) while a load is pending: same wedge.
        const timedOut = (e instanceof TabcapError && e.code === "timeout") || (e instanceof Error && e.name === "CdpTimeoutError");
        if (!timerFired && timedOut && (tab.loading || opts.navigation === true)) {
          const note = await this.unwedge(tab);
          throw new TabcapError("timeout", `${e instanceof Error ? e.message : String(e)}${note}`, "Check that the site responds, then `tabcap navigate <url>` again; raise --timeout for slow pages.");
        }
        throw e;
      } finally {
        clearTimeout(timer);
        if (onDialog !== undefined) tab.dialogWaiters.delete(onDialog);
        const n = (this.running.get(tab.id) ?? 1) - 1;
        if (n > 0) this.running.set(tab.id, n);
        else this.running.delete(tab.id);
      }
    });
    tab.queue = job.catch(() => undefined);
    return job;
  }

  private onDetached(x: AttachedTarget): void {
    const tab = this.bySession(x.sessionId);
    if (tab !== undefined) {
      log.info("tab detached", { tab: tab.id });
      this.markClosed(tab);
    }
  }

  private newNav(tab: Tab, type: NavType): void {
    tab.navType = type;
    tab.navEpoch++;
  }

  private onEvent(e: CdpEvent): void {
    if (e.method === "Target.targetDestroyed" || e.method === "Target.targetCrashed") {
      const id = str(e.params, "targetId");
      const tab = id === null ? undefined : this.byTarget(id);
      if (tab !== undefined) this.markClosed(tab);
      const v = id === null ? undefined : this.viewers.get(id);
      if (v !== undefined && id !== null) {
        v.closed = true;
        this.viewers.delete(id);
      }
      return;
    }
    if (e.method === "Target.targetInfoChanged") {
      const info = isRecord(e.params["targetInfo"]) ? e.params["targetInfo"] : null;
      const id = info === null ? null : str(info, "targetId");
      const tab = id === null ? undefined : this.byTarget(id);
      if (tab !== undefined && info !== null) {
        tab.url = str(info, "url") ?? tab.url;
        tab.title = str(info, "title") ?? tab.title;
      }
      return;
    }
    if (e.sessionId === null) return;
    const tab = this.bySession(e.sessionId);
    if (tab === undefined) return;
    switch (e.method) {
      case "Page.frameRequestedNavigation":
        if (str(e.params, "frameId") === tab.targetId) this.driftOf(tab.id).requested = true;
        return;
      case "Page.frameStartedNavigating": {
        if (str(e.params, "frameId") !== tab.targetId) return;
        const d = this.driftOf(tab.id);
        const navigationType = str(e.params, "navigationType") ?? "";
        if (!DOCUMENT_NAV_TYPES.has(navigationType)) return;
        const ext = isExternalStart({ pageRequested: d.requested, covered: this.covered(tab), waiting: this.waitingOf(tab.session), navigationType });
        d.requested = false;
        d.pending = ext ? { from: tab.url, at: Date.now() } : null;
        if (ext) log.info("external navigation started", { tab: tab.id, session: tab.session });
        return;
      }
      case "Page.frameNavigated": {
        const f = isRecord(e.params["frame"]) ? e.params["frame"] : null;
        if (f === null || str(f, "parentId") !== null) return;
        tab.url = str(f, "url") ?? tab.url;
        tab.pointer = null; // a new document: the next trusted path starts at 0,0 again
        this.newNav(tab, tab.pendingNavType ?? "navigation");
        tab.pendingNavType = null;
        // docs/04 §52.2: before the listeners, so the recorder's `nav` event is already `external`.
        const d = this.drift.get(tab.id);
        if (d !== undefined && d.pending !== null) {
          d.changed = { at: d.pending.at, from: d.pending.from, to: tab.url, by: "external" };
          d.epoch = true;
          d.pending = null;
        }
        for (const fn of [...this.navListeners]) fn(tab, e);
        return;
      }
      case "Page.navigatedWithinDocument": {
        if (str(e.params, "frameId") !== tab.targetId) return;
        tab.url = str(e.params, "url") ?? tab.url;
        this.newNav(tab, "history");
        for (const fn of [...this.navListeners]) fn(tab, e);
        return;
      }
      case "Page.frameStartedLoading":
        if (str(e.params, "frameId") === tab.targetId) tab.loading = true;
        return;
      case "Page.frameStoppedLoading":
        if (str(e.params, "frameId") === tab.targetId) tab.loading = false;
        return;
      case "Page.javascriptDialogOpening": {
        const d: DialogInfo = {
          type: str(e.params, "type") ?? "alert",
          message: str(e.params, "message") ?? "",
          defaultPrompt: str(e.params, "defaultPrompt") ?? "",
          url: str(e.params, "url") ?? "",
          openedAt: Date.now(),
        };
        tab.dialog = d;
        for (const w of [...tab.dialogWaiters]) w(d);
        return;
      }
      case "Page.javascriptDialogClosed":
        tab.dialog = null;
        return;
    }
  }
}

export function dialogError(d: DialogInfo, during: boolean): TabcapError {
  const what = `a JavaScript ${d.type} dialog is open: ${JSON.stringify(d.message.slice(0, 200))}`;
  return new TabcapError(
    "dialog",
    during ? `${what} (it opened while the command ran; the triggering action already happened)` : `${what}; other commands on this tab are blocked`,
    "Run `tabcap dialog accept` or `tabcap dialog dismiss` (prompt: `tabcap dialog accept --text <answer>`).",
  );
}
