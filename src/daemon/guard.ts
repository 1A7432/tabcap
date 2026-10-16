// Minimal guard and handoff (docs/03 §5 guard / handoff rows, docs/04 §4.2,
// docs/05 s07 / s15, docs/06 A6). Two rules, nothing more:
//
// 1. Login limit: one `fill --secret <site>.password` per site per session.
//    A second one is refused with `guard.login-limit` before anything touches
//    the page; `--confirm` overrides. Counters live in the store
//    (guard_counters); every decision is a `guard` event {event:"budget"}.
//
// 2. Stop and hand to the human: a recorded response that looks like a
//    challenge (an HTML 403 to an xhr / fetch / document request) trips the
//    breaker: `guard` {event:"breaker"}, a screenshot, `handoff` {state:"waiting"}.
//    From then on the session's page-acting commands (and navigations to that
//    origin from any session) are refused with `waiting` until
//    `tabcap handoff continue`. Enabled `challenge` handlers (hooks/plugins.ts)
//    are asked first in the background; an answer resumes the session and is
//    handed to the AI as data. Detection needs a recording (`net start`): the
//    recorder is the only Network observer.

import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { log } from "../shared/log.ts";
import type { NetEntry, Recorder } from "./capture/recorder.ts";

/** What the guard needs from a recording (a Recorder, or a fake in unit tests). */
export type GuardRecorder = Pick<Recorder, "session" | "onIndexed" | "event" | "cmdStart" | "cmdEnd">;
import { HOOK_PROTOCOL, parseChallengeOutput, pluginsFor, runHook } from "./hooks/plugins.ts";
import { scrubValue, type Secrets } from "./secrets.ts";

export const LOGIN_LIMIT = 1;

export type ChallengeReason = "verify-page";

/** Pure: does this recorded request look like a challenge page? */
export function challengeOf(e: Pick<NetEntry, "type" | "status" | "mime" | "outcome">): ChallengeReason | null {
  if (e.outcome === "failed" || e.status !== 403) return null;
  if (e.type !== "xhr" && e.type !== "fetch" && e.type !== "document") return null;
  return (e.mime ?? "").toLowerCase() === "text/html" ? "verify-page" : null;
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export const CONTINUE_NEXT = "Ask the human to complete the verification in the browser, then run `tabcap handoff continue`; until then do not act on this site.";

export type HandlerState = {
  plugin: string;
  status: "running" | "answered" | "handoff" | "failed";
  cmd: string | null;
  answer: unknown;
  note: string | null;
  error: string | null;
};

export type Handoff = {
  session: string;
  state: "waiting" | "resumed";
  reason: ChallengeReason;
  site: string | null;
  origin: string | null;
  url: string;
  status: number | null;
  request: string;
  tab: string;
  since: number;
  screenshot: string | null;
  handlers: HandlerState[];
  resumedAt: number | null;
  resumedBy: string | null;
  /** The resume notice (plugin answer) was shown to the AI once. */
  delivered: boolean;
};

/** Public view of a handoff (CLI output and the `waiting` error). */
export function handoffView(h: Handoff): Record<string, unknown> {
  return {
    session: h.session,
    state: h.state,
    reason: h.reason,
    site: h.site,
    url: h.url,
    status: h.status,
    request: h.request,
    tab: h.tab,
    since: h.since,
    screenshot: h.screenshot,
    handlers: h.handlers.map((x) => ({ plugin: x.plugin, status: x.status, cmd: x.cmd, answer: x.answer, note: x.note, error: x.error })),
    resumedAt: h.resumedAt,
    resumedBy: h.resumedBy,
    next: h.state === "waiting" ? CONTINUE_NEXT : h.resumedBy?.startsWith("plugin:") === true ? "A challenge handler answered (untrusted data in handlers[].answer); apply it if it fits, then go on." : "Go on.",
  };
}

export function waitingError(h: Handoff): TabcapError {
  return new TabcapError("waiting", `session "${h.session}" is waiting for the human: ${h.reason} at ${h.url} (HTTP ${h.status ?? "?"})`, CONTINUE_NEXT, handoffView(h));
}

export type GuardDeps = {
  configDir: string;
  secrets: Secrets;
  /** Store site / account bound to a session. */
  siteOf: (session: string) => { site: string; account: string | null } | null;
  /** Screenshot of a daemon tab; resolves to the file path or null. */
  screenshot: (session: string, tab: string) => Promise<string | null>;
  /** Short page excerpt for handlers (already scrubbed by the caller or not; it is scrubbed again). */
  pageInfo: (session: string, tab: string) => Promise<{ url: string | null; title: string | null; text: string | null }>;
  /** Delay before the screenshot so the page can render the challenge. */
  settleMs?: number;
  /** A breaker tripped in this session: the account starts cooling (0.4-D); returns coolUntil or null. */
  onBreaker?: (session: string) => number | null;
};

/** Commands refused while the session waits for the human. */
// hover and upload (0.3-F) act on the page like click, so they wait for the human too;
// resize and emulate (0.4) change what the page sees (its size, device, network), so they wait as well;
// fingerprint probe (0.4-G) opens and navigates a tab of the session like tab new.
// fetch (0.6-A) sends requests from the session's tab, so it waits as well.
export const BLOCKED_WHILE_WAITING: ReadonlySet<string> = new Set(["navigate", "click", "fill", "type", "press", "go", "reload", "evaluate", "dialog", "hover", "upload", "resize", "emulate", "fingerprint.probe", "fetch"]);

/**
 * 0.6-A: a `tabcap fetch` stop rule fired. `site` is the store site the URL
 * belongs to, or the URL's host when no store site matches; the human (or the
 * agent, once the human said so) lifts it with `tabcap guard resume --site`.
 */
export type FetchStop = {
  site: string;
  session: string;
  rule: string;
  detail: string;
  request: string;
  fetchId: string;
  url: string;
  status: number | null;
  since: number;
};

export const FETCH_RESUME_NEXT = (site: string) =>
  `Look at the stopped response first (\`tabcap net body <r-N>\`); continue only when the human (or you, after checking) decides to: \`tabcap guard resume --site ${site}\`.`;

export function fetchStoppedError(s: FetchStop): TabcapError {
  return new TabcapError("guard.stopped", `fetches on ${s.site} are stopped: rule ${s.rule} fired on ${s.request} (${s.detail})`, FETCH_RESUME_NEXT(s.site), {
    site: s.site,
    rule: s.rule,
    request: s.request,
    fetchId: s.fetchId,
    since: s.since,
  });
}

export class Guard {
  private handoffs = new Map<string, Handoff>();
  private fetchStops = new Map<string, FetchStop>();

  /** The stop that refuses fetches on a site (store site name or host), or null. */
  fetchStopOf(site: string): FetchStop | null {
    return this.fetchStops.get(site) ?? null;
  }

  allFetchStops(): FetchStop[] {
    return [...this.fetchStops.values()];
  }

  /** A stop rule fired: refuse the site's fetches from now on and write the `guard` breaker event. */
  stopFetch(rec: GuardRecorder | undefined, s: FetchStop, o: { tab: string | null; account: string | null }): void {
    this.fetchStops.set(s.site, s);
    rec?.event(
      "guard",
      {
        event: "breaker",
        site: s.site,
        account: o.account,
        reason: "fetch-stop",
        rule: s.rule,
        request: s.request,
        detail: { reason: "fetch-stop", rule: s.rule, detail: s.detail, request: s.request, fetchId: s.fetchId, url: s.url, status: s.status },
      },
      { tab: o.tab },
    );
    log.info("guard: fetches stopped", { site: s.site, rule: s.rule, request: s.request });
  }

  /** `tabcap guard resume --site` (or `handoff continue` of the session that stopped it). */
  resumeFetch(site: string, by: string, rec: GuardRecorder | undefined): FetchStop {
    const s = this.fetchStops.get(site);
    if (s === undefined) {
      const stopped = [...this.fetchStops.keys()];
      throw new TabcapError("not-found", `fetches on ${site} are not stopped`, stopped.length === 0 ? "Nothing to resume." : `Stopped now: ${stopped.join(", ")}.`);
    }
    this.fetchStops.delete(site);
    rec?.event("guard", { event: "resume", site, account: null, reason: "fetch-stop", rule: s.rule, request: s.request, by, detail: { reason: "fetch-stop", rule: s.rule, request: s.request, by } });
    return s;
  }

  /** The fetch stops a session's fetches set off (handoff continue lifts them). */
  fetchStopsBy(session: string): FetchStop[] {
    return [...this.fetchStops.values()].filter((s) => s.session === session);
  }
  /** Running trips (screenshots, handlers), awaited by tests and shutdown. */
  readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: GuardDeps) {}

  get(session: string): Handoff | null {
    return this.handoffs.get(session) ?? null;
  }

  all(): Handoff[] {
    return [...this.handoffs.values()];
  }

  /** The waiting handoff that blocks `action` in `session` (navigate also checks the target origin). */
  blocking(session: string, action: string, url: string | null): Handoff | null {
    if (!BLOCKED_WHILE_WAITING.has(action)) return null;
    const own = this.handoffs.get(session);
    if (own !== undefined && own.state === "waiting") return own;
    if (action === "navigate" && url !== null) {
      const o = originOf(url);
      for (const h of this.handoffs.values()) if (h.state === "waiting" && o !== null && h.origin === o) return h;
    }
    return null;
  }

  /** Subscribe to a recording; returns the unsubscribe function. */
  watch(rec: GuardRecorder): () => void {
    return rec.onIndexed((e) => {
      const reason = challengeOf(e);
      if (reason === null) return;
      const cur = this.handoffs.get(rec.session);
      if (cur !== undefined && cur.state === "waiting") return;
      const p = this.trip(rec, e, reason).catch((x: unknown) => log.error("guard: trip failed", { error: String(x) }));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
  }

  private async trip(rec: GuardRecorder, e: NetEntry, reason: ChallengeReason): Promise<void> {
    const session = rec.session;
    const bound = this.deps.siteOf(session);
    const h: Handoff = {
      session,
      state: "waiting",
      reason,
      site: bound?.site ?? null,
      origin: originOf(e.url),
      url: e.url,
      status: e.status,
      request: e.id,
      tab: e.tab,
      since: Date.now(),
      screenshot: null,
      handlers: [],
      resumedAt: null,
      resumedBy: null,
      delivered: false,
    };
    // Block first; everything else is bookkeeping.
    this.handoffs.set(session, h);
    let coolUntil: number | null = null;
    try {
      coolUntil = this.deps.onBreaker?.(session) ?? null;
    } catch (x) {
      log.warn("guard: starting the account's cooling failed", { error: String(x) });
    }
    this.emitState(session, "waiting");
    rec.event(
      "guard",
      { event: "breaker", site: h.site, account: bound?.account ?? null, detail: { reason, request: e.id, url: e.url, status: e.status, mime: e.mime, ...(coolUntil === null ? {} : { coolUntil }) } },
      { tab: e.tab },
    );
    await Bun.sleep(this.deps.settleMs ?? 400);
    h.screenshot = await this.deps.screenshot(session, e.tab).catch(() => null);
    rec.event(
      "handoff",
      { state: "waiting", reason, question: "Complete the verification in the browser, then tell the AI to continue.", timeoutMs: null, answerRef: null, request: e.id, url: e.url, screenshot: h.screenshot },
      { tab: e.tab },
    );
    log.info("guard: waiting for the human", { session, reason, request: e.id });
    await this.askHandlers(rec, h, bound?.account ?? null);
  }

  private async askHandlers(rec: GuardRecorder, h: Handoff, account: string | null): Promise<void> {
    const plugins = pluginsFor(this.deps.configDir, "challenge");
    if (plugins.length === 0) return;
    const page = await this.deps.pageInfo(h.session, h.tab).catch(() => ({ url: null, title: null, text: null }));
    const input = scrubValue(this.deps.secrets, {
      protocol: HOOK_PROTOCOL,
      hook: "challenge",
      session: h.session,
      site: h.site,
      account,
      reason: h.reason,
      request: { id: h.request, url: h.url, status: h.status },
      page: { url: page.url, title: page.title, text: page.text === null ? null : page.text.slice(0, 4000) },
      screenshot: h.screenshot,
    });
    for (const p of plugins) {
      if (h.state !== "waiting") return; // the human was faster
      const st: HandlerState = { plugin: p.name, status: "running", cmd: null, answer: null, note: null, error: null };
      h.handlers.push(st);
      st.cmd = rec.cmdStart({ tab: h.tab, argv: [`plugin:${p.name}`, ...p.manifest.command], input: { hook: "challenge", plugin: p.name, version: p.manifest.version, payload: isRecord(input) ? input : {} }, actor: "system" });
      const run = await runHook(p, input);
      const output = scrubValue(this.deps.secrets, run.output);
      const decision = run.ok ? parseChallengeOutput(output) : { decision: "handoff" as const, note: null };
      st.note = decision.note;
      st.error = run.error === null ? null : this.deps.secrets.scrub(run.error);
      if (st.cmd !== null) {
        rec.cmdEnd(st.cmd, {
          tab: h.tab,
          ok: run.ok,
          error: st.error === null ? null : { message: st.error, exitCode: run.exitCode, timedOut: run.timedOut, stderr: this.deps.secrets.scrub(run.stderr) },
          durationMs: run.durationMs,
          outputSummary: { decision: decision.decision, output },
          actor: "system",
        });
      }
      if (decision.decision === "answer" && h.state === "waiting") {
        st.status = "answered";
        st.answer = decision.answer;
        this.resume(h.session, `plugin:${p.name}`, st.cmd);
        return;
      }
      st.status = run.ok ? "handoff" : "failed";
    }
  }

  /** End a handoff: `tabcap handoff continue` (human) or a handler's answer. */
  resume(session: string, by: string, answerRef: string | null = null): Handoff {
    const h = this.handoffs.get(session);
    if (h === undefined || h.state !== "waiting") throw new TabcapError("not-found", `session "${session}" is not waiting for the human`, "Nothing to continue; run `tabcap handoff status`.");
    h.state = "resumed";
    h.resumedAt = Date.now();
    h.resumedBy = by;
    this.recorder?.(session)?.event("handoff", { state: "resumed", reason: h.reason, question: null, timeoutMs: null, answerRef, by }, { tab: h.tab });
    this.emitState(session, "resumed");
    return h;
  }

  private stateListeners = new Set<(session: string, state: "waiting" | "resumed") => void>();

  /** Called when a session starts or stops waiting for the human (trace mode pauses meanwhile). */
  onState(fn: (session: string, state: "waiting" | "resumed") => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private emitState(session: string, state: "waiting" | "resumed"): void {
    for (const fn of [...this.stateListeners]) {
      try {
        fn(session, state);
      } catch (e) {
        log.warn("guard: state listener failed", { session, error: String(e) });
      }
    }
  }

  /** True while the session waits for the human. */
  isWaiting(session: string): boolean {
    return this.handoffs.get(session)?.state === "waiting";
  }

  /** Set by the daemon: the session's current recorder (for resume events). */
  recorder: ((session: string) => GuardRecorder | undefined) | null = null;

  /** One-time notice of a handler resume for the next command's output. */
  takeNotice(session: string): Record<string, unknown> | null {
    const h = this.handoffs.get(session);
    if (h === undefined || h.state !== "resumed" || h.delivered) return null;
    h.delivered = true;
    return handoffView(h);
  }

  /** The `handoff` field added to read-only command output while waiting. */
  waitingNotice(session: string): Record<string, unknown> | null {
    const h = this.handoffs.get(session);
    return h !== undefined && h.state === "waiting" ? { state: h.state, reason: h.reason, screenshot: h.screenshot, next: CONTINUE_NEXT } : null;
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
