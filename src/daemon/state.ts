// Daemon-wide state: the browser connection (at most one), sessions/tabs,
// recorders, known secrets. Tools receive this object; nothing here talks HTTP.

import { TabcapError } from "../shared/envelope.ts";
import type { Paths } from "../shared/paths.ts";
import type { Recorder } from "./capture/recorder.ts";
import type { Tracer } from "./trace/tracer.ts";
import { Tabs, type Tab } from "./browser/targets.ts";
import type { ConsoleLog } from "./capture/console.ts";
import type { DirectTransport } from "./transport/direct/index.ts";
import type { TakeoverWatch } from "./browser/takeover.ts";
import { Guard } from "./guard.ts";
import { Secrets } from "./secrets.ts";
import type { Store } from "./store/db.ts";
import { Pool } from "./pool/runtime.ts";
import { HostLimiter } from "./fetch/limiter.ts";
import { DecodeHost } from "./hooks/decode.ts";
import { siteRulesFor } from "./siterules.ts";
import { BlobStore } from "../bundle/blobs.ts";
import { readFileSync } from "node:fs";

export type BrowserInfo = {
  transport: "direct";
  channel: "pipe" | "port";
  pid: number;
  version: string;
  userAgent: string;
  executable: string;
  executableSource: string;
  profile: string;
  proxy: string;
  foreground: boolean;
  front: unknown;
  startedAt: number;
};

/**
 * docs/04 §16: `net wait` looks back to the start of the most recent of these;
 * read-only commands (wait, snapshot, find, screenshot, console, net list, tabs …) do not count.
 * Daemon action names: `press` is the CLI's press-key, `navigate` also `tab new`;
 * hover and upload (0.3-F) act on the page like click.
 */
export const ACTION_COMMANDS: ReadonlySet<string> = new Set(["navigate", "click", "fill", "type", "press", "go", "reload", "evaluate", "hover", "upload"]);

export type LastAction = { action: string; at: number; cmd: string | null };

/** `takeover`: the 0.7.1-A take-over listener (null: `handoff.detectTakeover` is off). */
export type Running = { t: DirectTransport; tabs: Tabs; console: ConsoleLog; info: BrowserInfo; takeover: TakeoverWatch | null };

/** `proxy`: the pool proxy name the session goes out through (its own browser context), `system` / `none`, or null (unbound account). */
export type SiteBinding = { site: string; account: string | null; proxy: string | null };

export class Daemon {
  readonly secrets = new Secrets();
  /**
   * Proxy credentials only (0.4-D): replaced in everything the recorder
   * writes (raw/cdp.jsonl, events.jsonl). Site passwords are not: the login
   * POST body stays in the bundle as it was sent (docs/04 §8.1).
   */
  readonly proxySecrets = new Secrets();
  readonly pool = new Pool();
  /** Decode plugin processes (0.6-B): one per plugin, shared by the sessions, killed at shutdown. */
  readonly decodeHost = new DecodeHost();
  /** Credential store (docs/04 §8.1); null only in unit tests that do not need it. */
  store: Store | null = null;
  /** Store site bound to each session by `session start --site`. */
  readonly sites = new Map<string, SiteBinding>();
  readonly guard: Guard;
  browser: Running | null = null;
  /** Why the browser went away, when tabcap knows (0.7.4: Chrome's sandbox could not start); `need()` reports it. */
  browserFailure: TabcapError | null = null;
  readonly recorders = new Map<string, Recorder>();
  /** Last finished recording per session, so `net list/body/show` keep working after `net stop`. */
  readonly lastBundles = new Map<string, Recorder>();
  /** Start of the most recent action command per session (net wait look-back, docs/04 §16). */
  private actions = new Map<string, LastAction>();
  readonly startedAt = Date.now();
  /** 0.7.1-A test-only: TABCAP_E2E_HUMAN=1 at daemon start allows `e2e.human-input` (docs/04 §37). */
  e2eHuman = false;

  constructor(
    readonly paths: Paths,
    deps: { screenshot?: (d: Daemon, session: string, tab: string) => Promise<string | null>; pageInfo?: (d: Daemon, session: string, tab: string) => Promise<{ url: string | null; title: string | null; text: string | null }> } = {},
  ) {
    this.guard = new Guard({
      configDir: paths.config,
      secrets: this.secrets,
      siteOf: (s) => this.sites.get(s) ?? null,
      screenshot: (s, tab) => deps.screenshot?.(this, s, tab) ?? Promise.resolve(null),
      pageInfo: (s, tab) => deps.pageInfo?.(this, s, tab) ?? Promise.resolve({ url: null, title: null, text: null }),
      onBreaker: (s) => this.coolAccount(s),
      // 0.6-I site stop rules: config.json sites.<name>.guard, bodies read from the session's recording.
      siteRules: (s, url) => siteRulesFor(this, s, url),
      readBlob: (s, blob) => {
        const r = this.recorders.get(s);
        const path = r === undefined ? null : new BlobStore(r.dir).pathOf(blob);
        if (path === null) return null;
        try {
          return readFileSync(path);
        } catch {
          return null;
        }
      },
    });
    this.guard.recorder = (s) => this.recorders.get(s);
    // Trace mode skips debugger pauses while a session waits for the human (0.4-F).
    this.guard.onState((s, state) => {
      void this.tracers
        .get(s)
        ?.setPaused(state === "waiting")
        .catch(() => undefined);
    });
  }

  /** Trace mode per session (0.4-F `tabcap trace start`). */
  readonly tracers = new Map<string, Tracer>();

  /** Per-host pacing of `tabcap fetch` (0.6-A, config.json `fetch`). */
  readonly fetchLimiter = new HostLimiter();

  /** Re-read the store's secrets so replacement covers sites added since (`tabcap site add` runs in the CLI). */
  refreshSecrets(): void {
    if (this.store === null) return;
    const all = this.store.knownSecrets();
    this.secrets.setStored(all);
    this.proxySecrets.setStored(all.filter((x) => x.ref.startsWith("proxy.")));
    this.pool.reloadConfig(this.paths.configFile);
  }

  needStore(): Store {
    if (this.store === null) throw new TabcapError("internal", "the credential store is not open", "Restart the daemon (`tabcap daemon stop`, then `tabcap daemon start`).");
    return this.store;
  }

  need(): Running {
    if (this.browser === null) throw this.browserFailure ?? new TabcapError("not-running", "the browser is not running", "Run `tabcap browser start` first.");
    return this.browser;
  }

  /** The tab's nav epoch in its session's recording (`n-<seq>`), or null when not recording. */
  navOf(tab: Tab): string | null {
    return this.recorders.get(tab.session)?.navId(tab.id) ?? null;
  }

  /** Remember an action command's start (read-only commands never move the look-back point). */
  noteAction(session: string, a: LastAction): void {
    if (ACTION_COMMANDS.has(a.action)) this.actions.set(session, a);
  }

  /** The most recent action command of the session, or null. */
  lastAction(session: string): LastAction | null {
    return this.actions.get(session) ?? null;
  }

  /** docs/08 §3 0.4: a guard breaker in an account's session starts its 30-min cooling; returns coolUntil. */
  coolAccount(session: string): number | null {
    const b = this.sites.get(session);
    if (b === undefined || b.account === null || this.store === null) return null;
    return this.pool.startCooling(this.store, b.site, b.account);
  }

  /** Called when the browser connection goes away for any reason. */
  async browserGone(): Promise<void> {
    for (const [name, r] of this.recorders) {
      const res = await r.stop().catch(() => null);
      this.lastBundles.set(name, r);
      void res;
    }
    this.recorders.clear();
    for (const tr of this.tracers.values()) await tr.stop("the browser went away").catch(() => undefined);
    this.tracers.clear();
    this.browser?.tabs.dispose();
    this.browser?.console.dispose();
    this.browser?.takeover?.dispose();
    this.browser = null;
    this.pool.reset();
  }
}
