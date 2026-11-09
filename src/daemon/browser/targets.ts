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
// - per-tab command queue with a command timeout, and the dialog lock.

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
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** A page target as `Target.getTargets` reports it; `browserContextId` null when Chrome names none. */
type PageTarget = { targetId: string; url: string; title: string; browserContextId: string | null };

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
    const s: Session = { name, tabs: [], current: null, created: Date.now(), lastClosed: null, recentCurrent: [] };
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
      const why = s.lastClosed !== null ? `session "${name}" tab ${s.lastClosed} was closed` : `session "${name}" has no tab`;
      throw new TabcapError("no-tab", why, "run navigate first: `tabcap navigate <url>` opens a background tab for this session.");
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
      throw new TabcapError("no-tab", `tab ${id} is not an open tab of session "${name}"`, "Run `tabcap tab list` to list this session's tabs.");
    }
    return tab;
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

  /** `tab list --all`: page targets of no session, for `tab adopt`. */
  async others(): Promise<{ target: string; url: string; title: string }[]> {
    return (await this.pageTargets()).filter((x) => this.byTarget(x.targetId) === undefined).map((x) => ({ target: x.targetId.toLowerCase(), url: x.url, title: x.title }));
  }

  /**
   * `tab adopt`: borrow the page target `ref` (a target id or a prefix of at least ADOPT_MIN_PREFIX
   * characters) into the session as its current tab. Nothing moves on screen; every refusal comes
   * before the session is created, so a failed adopt leaves nothing behind.
   */
  async adopt(sessionName: string, ref: string): Promise<{ tab: Tab; already: boolean }> {
    const prefix = ref.toLowerCase();
    if (prefix.length < ADOPT_MIN_PREFIX) throw new TabcapError("usage", `tab adopt needs at least ${ADOPT_MIN_PREFIX} characters of the target, got "${ref}"`, "Copy `target` from `tabcap tab list --all`.");
    const pages = await this.pageTargets();
    const hits = pages.filter((x) => x.targetId.toLowerCase().startsWith(prefix));
    const hit = hits[0];
    if (hit === undefined) throw new TabcapError("not-found", `no tab with target ${ref}`, "Run `tabcap tab list --all` to see the tabs of no session.");
    if (hits.length > 1) throw new TabcapError("usage", `target ${ref} matches ${hits.length} tabs: ${hits.map((x) => x.targetId.toLowerCase()).join(", ")}`, "Give more characters of the target.");
    const held = this.byTarget(hit.targetId);
    if (held !== undefined) {
      if (held.session !== sessionName) throw new TabcapError("conflict", `that tab is ${held.id} of session "${held.session}"`, `Use it there, or \`tabcap session stop ${held.session}\` first.`);
      const s = this.sessions.get(sessionName);
      if (s !== undefined) this.setCurrent(s, held.id);
      return { tab: held, already: true };
    }
    if (!adoptContextOk(this.contexts.get(sessionName), hit.browserContextId, new Set(this.contexts.values()))) {
      throw new TabcapError("conflict", `that tab is in another browser context than session "${sessionName}"`, "A session with its own context (a stored site's account) only takes tabs opened in its own windows; adopt it in a session that has none.");
    }
    const attached = await this.t.waitAttached(hit.targetId, 5000);
    const { session } = this.ensureSession(sessionName);
    const tab = this.register(session.name, attached, false, null, "borrowed");
    await this.fireAdded(tab);
    this.setCurrent(session, tab.id);
    return { tab, already: false };
  }

  private register(sessionName: string, x: AttachedTarget, owned: boolean, opener: string | null = null, reason: Tab["reason"] = opener === null ? "ai-opened" : "popup"): Tab {
    const existing = this.byTarget(x.targetId);
    if (existing !== undefined) return existing;
    const { session } = this.ensureSession(sessionName);
    const tab: Tab = {
      id: `t${++this.tabSeq}`,
      targetId: x.targetId,
      sessionId: x.sessionId,
      session: session.name,
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
    this.tabs.set(tab.id, tab);
    session.tabs.push(tab.id);
    log.info("tab registered", { tab: tab.id, session: session.name, owned, opener });
    return tab;
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
      case "Page.frameNavigated": {
        const f = isRecord(e.params["frame"]) ? e.params["frame"] : null;
        if (f === null || str(f, "parentId") !== null) return;
        tab.url = str(f, "url") ?? tab.url;
        tab.pointer = null; // a new document: the next trusted path starts at 0,0 again
        this.newNav(tab, tab.pendingNavType ?? "navigation");
        tab.pendingNavType = null;
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
