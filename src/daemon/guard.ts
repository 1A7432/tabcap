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
//
// 3. Site stop rules (0.6-I): config.json `sites.<name>.guard.stopOn` (the
//    `tabcap fetch --stop-on` syntax) and `guard.consecutiveNon200`, checked on
//    every final recorded document / xhr / fetch response of the site in the
//    session (page requests, `tabcap fetch`, navigations). A trip writes
//    `guard` {event:"breaker", reason:"stop-rule", rule, request}, refuses the
//    site's fetches and the session's page commands with `guard.stopped`, and
//    puts the session into `waiting` (screenshot, `next`) until `handoff
//    continue` or `guard resume --site`. 0.7.5-A: `guard.endOn` (and a
//    fetch's `--end-on`) run first; a response they match is "the list has
//    ended": a `guard` {event:"end"}, no stop rule, the counter resets.
//
// 4. Human take-over (0.7.1-A, docs/04 §37): the take-over listener
//    (browser/takeover.ts) saw trusted human input on one of the session's
//    tabs outside tabcap's own input windows: `waiting` with reason
//    `human-takeover` (no screenshot, no breaker) until `handoff continue`.
//
// 5. Condition-ended handoffs (0.7.5-B, docs/04 §39): a verify-page or
//    take-over handoff reads its tab's URL and cookie names when it begins
//    (the baseline); `handoff wait --until-*` (tools/handoffwait.ts) ends it
//    when a condition first seen false in this handoff holds.

import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { log } from "../shared/log.ts";
import type { NetEntry, Recorder } from "./capture/recorder.ts";

/** What the guard needs from a recording (a Recorder, or a fake in unit tests). */
export type GuardRecorder = Pick<Recorder, "session" | "onIndexed" | "event" | "cmdStart" | "cmdEnd">;
import { HOOK_PROTOCOL, parseChallengeOutput, pluginsFor, runHook } from "./hooks/plugins.ts";
import { scrubValue, type Secrets } from "./secrets.ts";
import { firstStop, type StopRule } from "./fetch/stoprules.ts";
import { decodeBody } from "./tools/netsearch.ts";
import { redactRuleDetail, redactUrl, type LiveCtx } from "./tools/liveredact.ts";
import { actionsWhere } from "./tools/registry.ts";

export const LOGIN_LIMIT = 1;

export type ChallengeReason = "verify-page" | "stop-rule";

/** Why a session waits for the human: a challenge the guard saw, or (0.7.1-A) the human took over the tab. */
export type HandoffReason = ChallengeReason | "human-takeover";

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

export const CONTINUE_NEXT =
  "Ask the human to complete the verification in the browser; then `tabcap handoff wait --until-url <a URL only reached once they are done>` (or --until-cookie / --until-text) ends it by itself, or run `tabcap handoff continue` when they tell you they are done; until then do not act on this site.";

/** 0.6-I: what to do after a site stop rule put the session into waiting. */
export const STOP_RULE_NEXT = (h: { site: string | null; request: string | null }) =>
  `A site stop rule fired; look at the response first (\`tabcap net body ${h.request ?? "<r-N>"}\`). Go on only when the human (or you, after judging) decides to: \`tabcap handoff continue\`${h.site === null ? "" : ` (or \`tabcap guard resume --site ${h.site}\`)`}; until then do not act on this site.`;

/** 0.7.1-A: what to do after tabcap saw the human operate one of the session's tabs. */
export const TAKEOVER_NEXT =
  "The user is operating this session's tab themselves; do not act on the page (read-only commands still work). When the user says they are done, run `tabcap handoff continue`; or, if you know what they are doing (e.g. logging in), `tabcap handoff wait --until-url <the URL after it>` ends it by itself.";

export const TAKEOVER_QUESTION = "You are using the AI's tab; when you are done, tell the AI to continue (`tabcap handoff continue`).";

/** 0.8-A: "This is <families>; " before the advice, when the tab's page was identified (identification only, docs/04 §41). */
export const protectionPrefix = (h: Pick<Handoff, "protection">): string => (h.protection === undefined || h.protection.length === 0 ? "" : `This is ${h.protection.join(" + ")} (identified, not bypassed; a human handles it). `);

const nextOf = (h: Handoff): string => protectionPrefix(h) + (h.reason === "stop-rule" ? STOP_RULE_NEXT(h) : h.reason === "human-takeover" ? TAKEOVER_NEXT : CONTINUE_NEXT);

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
  reason: HandoffReason;
  site: string | null;
  /** The origin other sessions may not navigate to while this waits (null: no such block, e.g. a take-over). */
  origin: string | null;
  url: string;
  status: number | null;
  /** The recorded request that tripped it; null for a take-over. */
  request: string | null;
  tab: string;
  since: number;
  screenshot: string | null;
  handlers: HandlerState[];
  resumedAt: number | null;
  resumedBy: string | null;
  /** The resume notice (plugin answer) was shown to the AI once. */
  delivered: boolean;
  /** 0.6-I stop-rule handoffs: the rule that fired and what it saw. */
  rule?: string;
  ruleDetail?: string;
  /** 0.7-E: the screenshot being taken (settle delay, then the tab's turn); answers wait for it, bounded. */
  shot?: Promise<void>;
  /** 0.7.1-A take-over: the human input that started it (kind and page time, epoch ms). */
  input?: { event: string; at: number };
  /** 0.7.1-A: human input was seen while waiting ("human-active", docs/04 §16): the recording marks events `actor:"human"`. */
  humanActive?: boolean;
  /** 0.7.5-B: the tab's URL and cookie names when the handoff began (null: unreadable); set once `started` resolves. */
  start?: HandoffBaseline;
  started?: Promise<void>;
  /** 0.7.5-B: `handoff wait` conditions seen not to hold during this handoff (keys like `url:/home`). */
  seenFalse?: Set<string>;
  /** 0.7.5-B: the condition that ended it (`resumedBy: "condition"`). */
  condition?: { kind: string; value: string };
  /** 0.8-A: protection families identified on the tab when it began (names; docs/04 §41.3). */
  protection?: string[];
};

/** 0.7.5-B: what a handoff saw of its tab when it began (cookie names only, never values). */
export type HandoffBaseline = { url: string | null; cookies: string[] | null };

/** 0.7-E: how long an answer waits for a hand-off screenshot still being taken. */
export const SHOT_WAIT_MS = 5000;

/** Live output (docs/04 §8.3): the envelope scrubber replaces known secrets afterwards, so the redaction needs none here. */
const SHOWN: LiveCtx = { scrub: (s) => s };

/** Public view of a handoff (CLI output and the `waiting` error); its url and rule detail redacted (docs/04 §8.3). */
export function handoffView(h: Handoff, c: LiveCtx = SHOWN): Record<string, unknown> {
  return {
    session: h.session,
    state: h.state,
    reason: h.reason,
    site: h.site,
    url: redactUrl(h.url, c),
    status: h.status,
    request: h.request,
    tab: h.tab,
    since: h.since,
    screenshot: h.screenshot,
    handlers: h.handlers.map((x) => ({ plugin: x.plugin, status: x.status, cmd: x.cmd, answer: x.answer, note: x.note, error: x.error })),
    resumedAt: h.resumedAt,
    resumedBy: h.resumedBy,
    ...(h.rule === undefined ? {} : { rule: h.rule, detail: h.ruleDetail === undefined ? null : redactRuleDetail(h.ruleDetail, c) }),
    ...(h.input === undefined ? {} : { input: h.input }),
    ...(h.condition === undefined ? {} : { condition: h.condition }),
    ...(h.protection === undefined || h.protection.length === 0 ? {} : { protection: h.protection }),
    next: h.state === "waiting" ? nextOf(h) : h.resumedBy?.startsWith("plugin:") === true ? "A challenge handler answered (untrusted data in handlers[].answer); apply it if it fits, then go on." : "Go on.",
  };
}

export function waitingError(h: Handoff, c: LiveCtx = SHOWN): TabcapError {
  const url = redactUrl(h.url, c);
  if (h.reason === "stop-rule") {
    const detail = h.ruleDetail === undefined ? `HTTP ${h.status ?? "?"}` : redactRuleDetail(h.ruleDetail, c);
    return new TabcapError("guard.stopped", `session "${h.session}" is stopped: site rule ${h.rule ?? "?"} fired on ${h.request ?? "?"} (${detail})`, protectionPrefix(h) + STOP_RULE_NEXT(h), handoffView(h, c));
  }
  if (h.reason === "human-takeover") {
    return new TabcapError("waiting", `session "${h.session}" is waiting: the user took over tab ${h.tab} (${h.input?.event ?? "input"} at ${url})`, protectionPrefix(h) + TAKEOVER_NEXT, handoffView(h, c));
  }
  return new TabcapError("waiting", `session "${h.session}" is waiting for the human: ${h.reason} at ${url} (HTTP ${h.status ?? "?"})`, protectionPrefix(h) + CONTINUE_NEXT, handoffView(h, c));
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
  /** 0.6-I: the store site rules a recorded response of the session falls under, or null. */
  siteRules?: (session: string, url: string) => { site: string; rules: StopRule[]; consecutiveNon200: number | null; endRules: StopRule[] } | null;
  /** 0.6-I: the stored bytes of a body blob of the session's recording, or null. */
  readBlob?: (session: string, blob: string) => Uint8Array | null;
  /** 0.7.5-B: the tab's URL and cookie names when a handoff begins (docs/04 §39). */
  baseline?: (session: string, tab: string) => Promise<HandoffBaseline>;
  /** 0.8-A: protection families identified on a daemon tab's current page (names, cached; docs/04 §41.3). */
  protectionOf?: (tab: string) => string[];
  /** 0.8-A: the same, probing in the tab's turn when the navigation was not probed yet. */
  identifyTab?: (tab: string) => Promise<string[]>;
};

/** 0.6-I: the response types the site rules look at (page XHR / fetch, `tabcap fetch`, navigations). */
const RULE_TYPES: ReadonlySet<string> = new Set(["document", "xhr", "fetch"]);
/** Bodies that are empty by HTTP (no body to look at, but nothing unknown either). */
const EMPTY_BY_STATUS: ReadonlySet<string> = new Set(["no-content", "not-modified"]);
const BODY_RULES: ReadonlySet<StopRule["kind"]> = new Set(["empty-body", "json", "text"]);

/** Pure: is this recorded request a final response the site rules look at? */
export function ruleSubject(e: Pick<NetEntry, "type" | "status" | "bodyMissing">): boolean {
  return RULE_TYPES.has(e.type) && e.status !== null && e.bodyMissing !== "redirect";
}

/**
 * Pure: the body facts a rule sees, or null when the body is unknown (not
 * finished, skipped by --bodies, too large, gone): then only status rules run.
 */
export function bodyFacts(
  e: Pick<NetEntry, "outcome" | "blob" | "bodyMissing" | "bodySkipped">,
  bytes: Uint8Array | null,
  decode: (b: Uint8Array) => string | null,
): { bytes: number; text: string | null } | null {
  if (e.outcome !== "finished" || e.bodySkipped !== undefined) return null;
  if (e.blob === null) return e.bodyMissing !== null && EMPTY_BY_STATUS.has(e.bodyMissing) ? { bytes: 0, text: "" } : null;
  if (bytes === null) return null;
  return { bytes: bytes.length, text: decode(bytes) };
}

/** One response in the consecutive-non-2xx window: when it arrived (CDP mono ms; null: unknown) and whether it was not 2xx. */
export type ArrivalMark = { mono: number | null; bad: boolean };

/** Responses kept per session and site for the counter (older ones cannot be part of a run that matters any more). */
export const ARRIVAL_WINDOW = 256;

/**
 * Pure (owner ruling 10-16): consecutive non-2xx responses are counted in the
 * order the responses arrived (`timing.end`, the response's completion
 * time), not in the order the recorder wrote them (a response the page never
 * reads is written 1 s late, docs/04 §5.2 rule 9). Inserts `m` into `seq`
 * (sorted by arrival; an unknown time goes last, after equal times) and
 * returns the length of the run of non-2xx responses that contains it (0 for
 * a 2xx). The check still happens when the request is written.
 */
export function insertArrival(seq: ArrivalMark[], m: ArrivalMark): number {
  const key = m.mono ?? Number.POSITIVE_INFINITY;
  let i = seq.length;
  while (i > 0) {
    const prev = seq[i - 1];
    if (prev === undefined || (prev.mono ?? Number.POSITIVE_INFINITY) <= key) break;
    i--;
  }
  seq.splice(i, 0, m);
  while (seq.length > ARRIVAL_WINDOW) {
    seq.shift();
    i--;
  }
  if (!m.bad) return 0;
  let run = 1;
  for (let j = i - 1; j >= 0 && seq[j]?.bad === true; j--) run++;
  for (let j = i + 1; j < seq.length && seq[j]?.bad === true; j++) run++;
  return run;
}

/** The arrival time of a recorded response from its event: `timing.end`, else `responseStart` (unread by the page), else `start`. */
export function arrivalMono(ev: Record<string, unknown> | undefined): number | null {
  const t = ev !== undefined && isRecord(ev["timing"]) ? ev["timing"] : null;
  if (t === null) return null;
  for (const k of ["end", "responseStart", "start"]) {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Commands refused while the session waits for the human: the `blockedWhileWaiting` rows of tools/registry.ts (why each one is there is noted in the table). */
export const BLOCKED_WHILE_WAITING: ReadonlySet<string> = actionsWhere("blockedWhileWaiting");

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
  /** The fetch whose response fired the rule; null for a page request (0.6-I site rule). */
  fetchId: string | null;
  url: string;
  status: number | null;
  since: number;
  /** 0.6-A `fetch-stop` (the fetch's own rule) or 0.6-I `stop-rule` (a site rule; the session also waits). */
  reason: "fetch-stop" | "stop-rule";
};

export const FETCH_RESUME_NEXT = (site: string) =>
  `Look at the stopped response first (\`tabcap net body <r-N>\`); continue only when the human (or you, after checking) decides to: \`tabcap guard resume --site ${site}\`.`;

export function fetchStoppedError(s: FetchStop): TabcapError {
  return new TabcapError("guard.stopped", `fetches on ${s.site} are stopped: ${s.reason === "stop-rule" ? "site " : ""}rule ${s.rule} fired on ${s.request} (${s.detail})`, FETCH_RESUME_NEXT(s.site), {
    site: s.site,
    reason: s.reason,
    rule: s.rule,
    request: s.request,
    fetchId: s.fetchId,
    since: s.since,
  });
}

/** 0.7.5-A: end-rule hits remembered (for the fetch that sent the request and one event each); older ones go first. */
const MAX_END_HITS = 4096;

/** Advisory keys a session remembers (0.6-D: one `challenge` event per page); older ones go first. */
const MAX_ADVISORIES = 256;

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
    rec?.event("guard", { event: "resume", site, account: null, reason: s.reason, rule: s.rule, request: s.request, by, detail: { reason: s.reason, rule: s.rule, request: s.request, by } });
    return s;
  }

  /** 0.6-I: fetches whose call gave its own --stop-on (the per-call override of the site's stopOn). */
  private overrides = new Set<string>();
  /** 0.6-I: recent responses per session and site, in arrival order, for consecutiveNon200. */
  private arrivals = new Map<string, ArrivalMark[]>();
  /** 0.6-I: the stop-rule trip each request caused (for the fetch whose response tripped it). */
  private tripsByRequest = new Map<string, { site: string; rule: string; detail: string }>();

  /** 0.7.5-A: a fetch's own --end-on rules, by fetchId (checked with the site's endOn, before any stop rule). */
  private fetchEnds = new Map<string, StopRule[]>();
  /** 0.7.5-A: the end rule each request matched, by `${session}|${id}` (one `guard` end event each). */
  private endsByRequest = new Map<string, { site: string; rule: string; detail: string }>();

  /** `tabcap fetch --end-on` given: the site rule check runs these on this fetch's responses too. */
  fetchEndRules(fetchId: string, rules: StopRule[]): () => void {
    this.fetchEnds.set(fetchId, rules);
    return () => this.fetchEnds.delete(fetchId);
  }

  /** The end rule request `id` of `session` matched, or null. */
  endHit(session: string, id: string): { site: string; rule: string; detail: string } | null {
    return this.endsByRequest.get(`${session}|${id}`) ?? null;
  }

  /** 0.7.5-A (docs/04 §38): a response matched an end rule; write the `guard` end event once per request. */
  noteEnd(
    rec: GuardRecorder | undefined,
    session: string,
    e: { site: string; request: string; url: string; status: number | null; tab: string | null; fetchId: string | null },
    hit: { rule: string; detail: string },
  ): void {
    const key = `${session}|${e.request}`;
    if (this.endsByRequest.has(key)) return;
    this.endsByRequest.set(key, { site: e.site, ...hit });
    while (this.endsByRequest.size > MAX_END_HITS) {
      const oldest = this.endsByRequest.keys().next().value;
      if (oldest === undefined) break;
      this.endsByRequest.delete(oldest);
    }
    rec?.event(
      "guard",
      {
        event: "end",
        site: e.site,
        account: null,
        rule: hit.rule,
        request: e.request,
        detail: { rule: hit.rule, detail: hit.detail, request: e.request, url: e.url, status: e.status, ...(e.fetchId === null ? {} : { fetchId: e.fetchId }) },
      },
      { tab: e.tab },
    );
    log.info("guard: end rule matched", { session, site: e.site, rule: hit.rule, request: e.request });
  }

  /** `tabcap fetch --stop-on` given: this fetch's responses skip the site's stopOn (the counter still counts). */
  overrideSiteRules(fetchId: string): () => void {
    this.overrides.add(fetchId);
    return () => this.overrides.delete(fetchId);
  }

  /** The site stop rule that request `id` of `session` tripped, or null. */
  stopRuleHit(session: string, id: string): { site: string; rule: string; detail: string } | null {
    return this.tripsByRequest.get(`${session}|${id}`) ?? null;
  }

  /** The fetch stops a session's fetches set off (handoff continue lifts them). */
  fetchStopsBy(session: string): FetchStop[] {
    return [...this.fetchStops.values()].filter((s) => s.session === session);
  }
  /** 0.6-D: pages whose image captcha advisory was recorded, per session. */
  private advisories = new Map<string, Set<string>>();
  /** Running trips (screenshots, handlers), awaited by tests and shutdown. */
  readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: GuardDeps) {}

  get(session: string): Handoff | null {
    return this.handoffs.get(session) ?? null;
  }

  /** The hand-off screenshot: after the settle delay, saved under the data dir's shots/ (recording or not). */
  private takeShot(h: Handoff): Promise<void> {
    const shot = (async () => {
      await Bun.sleep(this.deps.settleMs ?? 400);
      h.screenshot = await this.deps.screenshot(h.session, h.tab).catch(() => null);
      // 0.8-A: a trip during a navigation comes before the page was probed; answers wait for this like for the shot.
      if ((h.protection === undefined || h.protection.length === 0) && this.deps.identifyTab !== undefined) {
        const families = await this.deps.identifyTab(h.tab).catch(() => [] as string[]);
        if (families.length > 0) h.protection = families;
      }
    })();
    h.shot = shot;
    return shot;
  }

  /**
   * 0.7-E: wait (at most `ms`) for the screenshots of waiting hand-offs (one session, or all with
   * null) that are still being taken, so the answer that reports the wait carries the path. Before,
   * an answer right after the trip said `screenshot: null` and the file appeared ~0.5 s later.
   */
  async shotTaken(session: string | null, ms = SHOT_WAIT_MS): Promise<void> {
    const shots = [...this.handoffs.values()].filter((h) => h.state === "waiting" && (session === null || h.session === session)).flatMap((h) => (h.shot === undefined ? [] : [h.shot]));
    if (shots.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(shots), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
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
    return rec.onIndexed((e, ev) => {
      const cur = this.handoffs.get(rec.session);
      if (cur !== undefined && cur.state === "waiting") return;
      const reason = challengeOf(e);
      if (reason === null) {
        this.checkSiteRules(rec, e, ev);
        return;
      }
      this.track(this.trip(rec, e, reason));
    });
  }

  private track(p: Promise<void>): void {
    const q = p.catch((x: unknown) => log.error("guard: trip failed", { error: String(x) }));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }

  /** 0.6-I: check one recorded response against its site's stop rules and non-2xx counter. */
  private checkSiteRules(rec: GuardRecorder, e: NetEntry, ev: Record<string, unknown> | undefined): void {
    if (this.deps.siteRules === undefined || !ruleSubject(e) || e.status === null) return;
    const session = rec.session;
    const sr = this.deps.siteRules(session, e.url);
    if (sr === null) return;
    const status = e.status;
    const rules = e.fetchId !== undefined && this.overrides.has(e.fetchId) ? [] : sr.rules;
    const ends = [...sr.endRules, ...(e.fetchId === undefined ? [] : (this.fetchEnds.get(e.fetchId) ?? []))];
    let facts: { bytes: number; text: string | null } | null | undefined;
    const check = (list: readonly StopRule[]): { rule: string; detail: string } | null => {
      if (list.length === 0) return null;
      if (facts === undefined) {
        const resp = ev !== undefined && isRecord(ev["response"]) ? ev["response"] : {};
        const charset = typeof resp["charset"] === "string" ? resp["charset"] : null;
        const bytes = e.blob === null ? null : (this.deps.readBlob?.(session, e.blob) ?? null);
        facts = bodyFacts(e, bytes, (b) => {
          const t = decodeBody(b, e.mime, () => charset);
          return t === null ? null : this.deps.secrets.scrub(t);
        });
      }
      const usable = facts === null ? list.filter((r) => !BODY_RULES.has(r.kind)) : list;
      return firstStop(usable, { status, bytes: facts?.bytes ?? 0, text: facts?.text ?? null });
    };
    // 0.7.5-A: an end rule first; its response is a normal answer (no stop rule, the counter resets).
    const end = check(ends);
    const hit = end === null ? check(rules) : null;
    const key = `${session}|${sr.site}`;
    let seq = this.arrivals.get(key);
    if (seq === undefined) {
      seq = [];
      this.arrivals.set(key, seq);
    }
    const n = insertArrival(seq, { mono: arrivalMono(ev), bad: end === null && !(status >= 200 && status < 300) });
    if (end !== null) {
      this.noteEnd(rec, session, { site: sr.site, request: e.id, url: e.url, status, tab: e.tab, fetchId: e.fetchId ?? null }, end);
      return;
    }
    const trip =
      hit ??
      (sr.consecutiveNon200 !== null && n >= sr.consecutiveNon200
        ? { rule: `consecutiveNon200:${sr.consecutiveNon200}`, detail: `${n} responses in a row (by arrival) were not 2xx (this one: status ${status})` }
        : null);
    if (trip === null) return;
    this.arrivals.delete(key);
    this.track(this.tripStopRule(rec, e, sr.site, trip));
  }

  /** 0.6-I: a site stop rule fired. Blocking is synchronous; the screenshot follows. */
  private async tripStopRule(rec: GuardRecorder, e: NetEntry, site: string, hit: { rule: string; detail: string }): Promise<void> {
    const session = rec.session;
    const bound = this.deps.siteOf(session);
    const account = bound !== null && bound.site === site ? bound.account : null;
    const since = Date.now();
    const h: Handoff = {
      session,
      state: "waiting",
      reason: "stop-rule",
      site,
      origin: originOf(e.url),
      url: e.url,
      status: e.status,
      request: e.id,
      tab: e.tab,
      since,
      screenshot: null,
      handlers: [],
      resumedAt: null,
      resumedBy: null,
      delivered: false,
      rule: hit.rule,
      ruleDetail: hit.detail,
    };
    // 0.8-A: the families identified on the tab (cached per navigation), shown in the answer, `next` and events.
    const families = this.deps.protectionOf?.(h.tab) ?? [];
    if (families.length > 0) h.protection = families;
    this.handoffs.set(session, h);
    this.fetchStops.set(site, { site, session, rule: hit.rule, detail: hit.detail, request: e.id, fetchId: e.fetchId ?? null, url: e.url, status: e.status, since, reason: "stop-rule" });
    this.tripsByRequest.set(`${session}|${e.id}`, { site, ...hit });
    this.emitState(session, "waiting");
    rec.event(
      "guard",
      {
        event: "breaker",
        ...(h.protection === undefined ? {} : { protection: h.protection }),
        site,
        account,
        reason: "stop-rule",
        rule: hit.rule,
        request: e.id,
        detail: { reason: "stop-rule", rule: hit.rule, detail: hit.detail, request: e.id, url: e.url, status: e.status, ...(e.fetchId === undefined ? {} : { fetchId: e.fetchId }) },
      },
      { tab: e.tab },
    );
    log.info("guard: site stop rule fired", { session, site, rule: hit.rule, request: e.id });
    await this.takeShot(h);
    rec.event(
      "handoff",
      {
        state: "waiting",
        ...(h.protection === undefined ? {} : { protection: h.protection }),
        reason: "stop-rule",
        question: `A stop rule of site ${site} fired (${hit.rule} on ${e.id}); look at the response, then tell the AI whether to continue.`,
        timeoutMs: null,
        answerRef: null,
        request: e.id,
        url: e.url,
        screenshot: h.screenshot,
      },
      { tab: e.tab },
    );
  }

  /** 0.7.5-B: read the handoff's baseline in the background; `handoff wait` awaits `started`. */
  private readBaseline(h: Handoff): void {
    const read = this.deps.baseline;
    if (read === undefined) return;
    h.started = read(h.session, h.tab)
      .then((b) => {
        h.start = b;
      })
      .catch(() => {
        h.start = { url: null, cookies: null };
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
    // 0.8-A: the families identified on the tab (cached per navigation), shown in the answer, `next` and events.
    const families = this.deps.protectionOf?.(h.tab) ?? [];
    if (families.length > 0) h.protection = families;
    this.handoffs.set(session, h);
    this.readBaseline(h);
    let coolUntil: number | null = null;
    try {
      coolUntil = this.deps.onBreaker?.(session) ?? null;
    } catch (x) {
      log.warn("guard: starting the account's cooling failed", { error: String(x) });
    }
    this.emitState(session, "waiting");
    rec.event(
      "guard",
      { event: "breaker", ...(h.protection === undefined ? {} : { protection: h.protection }), site: h.site, account: bound?.account ?? null, detail: { reason, request: e.id, url: e.url, status: e.status, mime: e.mime, ...(coolUntil === null ? {} : { coolUntil }) } },
      { tab: e.tab },
    );
    await this.takeShot(h);
    rec.event(
      "handoff",
      { state: "waiting", ...(h.protection === undefined ? {} : { protection: h.protection }), reason, question: "Complete the verification in the browser, then tell the AI to continue.", timeoutMs: null, answerRef: null, request: e.id, url: e.url, screenshot: h.screenshot },
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

  /** End a handoff: `tabcap handoff continue` (human), a handler's answer, or (0.7.5-B) a `handoff wait` condition. */
  resume(session: string, by: string, answerRef: string | null = null, condition: { kind: string; value: string } | null = null): Handoff {
    const h = this.handoffs.get(session);
    if (h === undefined || h.state !== "waiting") throw new TabcapError("not-found", `session "${session}" is not waiting for the human`, "Nothing to continue; run `tabcap handoff status`.");
    h.state = "resumed";
    h.resumedAt = Date.now();
    h.resumedBy = by;
    // The condition value is the AI's own argument (e.g. --until-text): the same known-secret
    // replacement as the `cmd` event's argv (docs/04 §8.1); the recorder itself only replaces proxy credentials.
    const cond = condition === null ? null : { kind: condition.kind, value: this.deps.secrets.scrub(condition.value) };
    if (cond !== null) h.condition = cond;
    this.recorder?.(session)?.event("handoff", { state: "resumed", reason: h.reason, question: null, timeoutMs: null, answerRef, by, ...(cond === null ? {} : { condition: cond }) }, { tab: h.tab });
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

  /**
   * 0.6-D image captcha advisory: true the first time `key` (tab + page) is
   * seen in the session, so the `guard` {event:"challenge", advisory:true}
   * event is written once per page. Advisory only: never a waiting state.
   */
  firstAdvisory(session: string, key: string): boolean {
    let seen = this.advisories.get(session);
    if (seen === undefined) {
      seen = new Set();
      this.advisories.set(session, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > MAX_ADVISORIES) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  }

  /** True while the session waits for the human. */
  isWaiting(session: string): boolean {
    return this.handoffs.get(session)?.state === "waiting";
  }

  /**
   * 0.7.1-A (docs/04 §37): tabcap saw the human operate tab `o.tab` of the
   * session outside its own input windows. The session waits like for a
   * verify page, without a screenshot (the human is at that tab), without
   * cooling the account or asking challenge handlers, and without blocking
   * other sessions' navigations (`origin` null). Only `handoff continue` ends it.
   * A session that already waits is left as it is (the caller records the input).
   */
  takeover(session: string, o: { tab: string; url: string; event: string; at: number }, rec: GuardRecorder | undefined): Handoff {
    const cur = this.handoffs.get(session);
    if (cur !== undefined && cur.state === "waiting") {
      cur.humanActive = true;
      return cur;
    }
    const h: Handoff = {
      session,
      state: "waiting",
      reason: "human-takeover",
      site: this.deps.siteOf(session)?.site ?? null,
      origin: null,
      url: o.url,
      status: null,
      request: null,
      tab: o.tab,
      since: Date.now(),
      screenshot: null,
      handlers: [],
      resumedAt: null,
      resumedBy: null,
      delivered: false,
      input: { event: o.event, at: o.at },
      humanActive: true,
    };
    // 0.8-A: the families identified on the tab (cached per navigation), shown in the answer, `next` and events.
    const families = this.deps.protectionOf?.(h.tab) ?? [];
    if (families.length > 0) h.protection = families;
    this.handoffs.set(session, h);
    this.readBaseline(h);
    this.emitState(session, "waiting");
    rec?.event(
      "handoff",
      { state: "waiting", ...(h.protection === undefined ? {} : { protection: h.protection }), reason: "human-takeover", question: TAKEOVER_QUESTION, timeoutMs: null, answerRef: null, request: null, url: o.url, screenshot: null, input: { event: o.event, at: o.at } },
      { tab: o.tab },
    );
    log.info("guard: the human took over", { session, tab: o.tab, event: o.event });
    return h;
  }

  /** 0.7.1-A: human input seen while the session waits (any reason): from now on the human is operating. */
  markHumanActive(session: string): void {
    const h = this.handoffs.get(session);
    if (h !== undefined && h.state === "waiting") h.humanActive = true;
  }

  /** docs/04 §16 "human-active": the session waits and the human's input was seen since. */
  isHumanActive(session: string): boolean {
    const h = this.handoffs.get(session);
    return h !== undefined && h.state === "waiting" && h.humanActive === true;
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
    return h !== undefined && h.state === "waiting" ? { state: h.state, reason: h.reason, screenshot: h.screenshot, next: nextOf(h) } : null;
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
