// tabcap handoff wait [--until-url s] [--until-text t] [--until-selector css]
// [--until-cookie name] [--timeout ms] (0.7.5-B, owner 10-20, docs/04 §39).
//
// Without --until-*: waits until the handoff ends some other way (`handoff
// continue`, a challenge handler). With them: ends a verify-page or take-over
// handoff itself once any condition holds that was seen NOT to hold earlier in
// the same handoff, so a condition already true when the human started proves
// nothing. URL and cookie names have a baseline read when the handoff began
// (guard.ts readBaseline), so a wait that starts after the human finished
// still sees them change; text and selector are first seen by the wait.
// Cookies are compared by name; their values are never read out or written.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import type { Tab } from "../browser/targets.ts";
import { cookieArray } from "../capture/cookies.ts";
import { MCP_CONTINUE, MCP_WAIT, handoffView, sessionFlag, type Handoff, type HandoffBaseline } from "../guard.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optNum, optStr, type Args } from "./args.ts";
import { clearNeedsHuman } from "./handoff.ts";
import { saveSiteSession } from "./session.ts";
import { FrameScope, Waker } from "./wait.ts";
import { pollExpression, readPoll } from "./waitspec.ts";

export const HANDOFF_WAIT_DEFAULT_MS = 60_000;
export const HANDOFF_WAIT_MIN_MS = 100;
export const HANDOFF_WAIT_MAX_MS = 600_000;
const POLL_MS = 250;
/** How long a wait gives the baseline read (it started when the handoff did). */
const BASELINE_WAIT_MS = 3000;

export type UntilKind = "url" | "text" | "selector" | "cookie";
export type Until = { kind: UntilKind; value: string; key: string };

const USAGE = "tabcap handoff wait [--until-url <substring>] [--until-text <text>] [--until-selector <css>] [--until-cookie <name>] [--timeout ms]";
const FLAGS: ReadonlyArray<[UntilKind, string]> = [
  ["url", "untilUrl"],
  ["text", "untilText"],
  ["selector", "untilSelector"],
  ["cookie", "untilCookie"],
];

/** The --until-* conditions, in flag order; an empty one is usage. */
export function parseUntil(a: Args): Until[] {
  const out: Until[] = [];
  for (const [kind, name] of FLAGS) {
    const v = optStr(a, name);
    if (v === null) continue;
    if (v === "") throw new TabcapError("usage", `--until-${kind} must not be empty`, `Usage: ${USAGE}`);
    out.push({ kind, value: v, key: `${kind}:${v}` });
  }
  return out;
}

export function handoffWaitTimeout(a: Args): number {
  const t = optNum(a, "timeoutMs");
  return t === null ? HANDOFF_WAIT_DEFAULT_MS : Math.max(HANDOFF_WAIT_MIN_MS, Math.min(Math.round(t), HANDOFF_WAIT_MAX_MS));
}

/**
 * Pure: the conditions the baseline shows not holding when the handoff began
 * (URL: the start URL lacks the substring; cookie: the name was not there).
 */
export function baselineFalse(conds: readonly Until[], start: HandoffBaseline | undefined): string[] {
  if (start === undefined) return [];
  return conds
    .filter((c) => (c.kind === "url" && start.url !== null && !start.url.includes(c.value)) || (c.kind === "cookie" && start.cookies !== null && !start.cookies.includes(c.value)))
    .map((c) => c.key);
}

/**
 * Pure: one round of checks. `holds` is true / false / null (could not tell);
 * `seen` collects keys seen false. Returns the condition that ends the
 * handoff, or whether every condition held without having been seen false
 * (on the wait's first round only: then nothing can prove the human finished).
 */
export function decideRound(conds: readonly Until[], holds: ReadonlyArray<boolean | null>, seen: Set<string>, first: boolean): { fired: Until | null; allAlready: boolean } {
  let fired: Until | null = null;
  let already = 0;
  conds.forEach((c, i) => {
    const h = holds[i] ?? null;
    if (h === false) seen.add(c.key);
    else if (h === true) {
      if (seen.has(c.key)) fired ??= c;
      else already++;
    }
  });
  return { fired, allAlready: fired === null && first && conds.length > 0 && already === conds.length };
}

/** The cookie names Chrome would send to the tab's URL (values are dropped right here). */
export async function cookieNames(t: Transport, tab: Tab): Promise<string[] | null> {
  if (!/^https?:/i.test(tab.url)) return [];
  const r = await t.send("Network.getCookies", { urls: [tab.url] }, tab.sessionId, 2000).catch(() => null);
  if (r === null) return null;
  return cookieArray(r).map((c) => String(c["name"]));
}

/** GuardDeps.baseline: the handoff tab's URL and cookie names now (the handoff just began). */
export async function handoffBaseline(d: Daemon, session: string, tabId: string): Promise<HandoffBaseline> {
  const b = d.browser;
  if (b === null) return { url: null, cookies: null };
  let tab: Tab;
  try {
    tab = b.tabs.pick(session, tabId);
  } catch {
    return { url: null, cookies: null };
  }
  return { url: tab.url, cookies: await cookieNames(b.t, tab) };
}

/** One check of one condition on the handoff's tab; null when it could not be told (navigating, frame gone). */
async function check(t: Transport, tab: Tab, c: Until, scope: FrameScope): Promise<{ holds: boolean | null; detail: Record<string, unknown> }> {
  if (c.kind === "url") return { holds: tab.url.includes(c.value), detail: { url: tab.url } };
  if (c.kind === "cookie") {
    const names = await cookieNames(t, tab);
    return { holds: names === null ? null : names.includes(c.value), detail: {} };
  }
  const spec = c.kind === "text" ? { kind: "text" as const, texts: [c.value] } : { kind: "selector" as const, selector: c.value };
  const expression = pollExpression(spec);
  const frames = c.kind === "text" ? await scope.frames() : [{ sessionId: tab.sessionId, contextId: null, frame: "main" }];
  let known = false;
  for (const f of frames) {
    const r = await t.send("Runtime.evaluate", { expression, returnByValue: true, ...(f.contextId === null ? {} : { contextId: f.contextId }) }, f.sessionId, 2000).catch(() => {
      if (f.contextId !== null) scope.drop(f.sessionId, f.contextId);
      return null;
    });
    if (r === null || isRecord(r["exceptionDetails"])) continue;
    known = true;
    const res = isRecord(r["result"]) ? r["result"] : {};
    const out = readPoll(spec, res["value"]);
    if (out.state === "invalid") throw new TabcapError("usage", `--until-selector is not a valid CSS selector: ${out.message.slice(0, 300)}`, "Fix the selector, e.g. --until-selector '#account-menu'.");
    if (out.state === "matched") return { holds: true, detail: { ...out.detail, ...(c.kind === "text" ? { frame: f.frame } : {}) } };
  }
  return { holds: known ? false : null, detail: {} };
}

const view = (session: string, h: Handoff, started: number) => ({ session, state: h.state, by: h.resumedBy, waitedMs: Date.now() - started, handoff: handoffView(h) });

function stillWaiting(session: string, h: Handoff, message: string, next: string, started: number): TabcapError {
  return new TabcapError("waiting", message, next, { state: "waiting", reason: h.reason, waitedMs: Date.now() - started, handoff: handoffView(h) });
}

/** --until-* look at the handoff's tab; it was closed (the human closed it, a login popup closed itself). */
function tabGone(session: string, h: Handoff, started: number): TabcapError {
  return new TabcapError(
    "no-tab",
    `the handoff's tab ${h.tab} of session "${session}" was closed, so no --until-* condition can be checked there; session "${session}" still waits`,
    `When the user tells you they are done, run \`tabcap handoff continue${sessionFlag(session)}\`; \`tabcap handoff wait${sessionFlag(session)}\` without --until-* waits for that (over MCP: ${MCP_CONTINUE}, ${MCP_WAIT}).`,
    { state: "waiting", reason: h.reason, waitedMs: Date.now() - started, handoff: handoffView(h) },
  );
}

export async function handoffWait(d: Daemon, a: Args, session: string): Promise<unknown> {
  const conds = parseUntil(a);
  const timeoutMs = handoffWaitTimeout(a);
  const started = Date.now();
  const h = d.guard.get(session);
  if (h === null || h.state !== "waiting") return { session, state: h?.state ?? "running", handoff: h === null ? null : handoffView(h) };
  if (conds.length > 0 && h.reason === "stop-rule") {
    throw new TabcapError(
      "usage",
      `session "${session}" waits because a site stop rule fired; that needs a decision, not a condition`,
      `Look at the response (\`tabcap net body ${h.request ?? "<r-N>"}${sessionFlag(session)}\`), decide with the user, then \`tabcap handoff continue${sessionFlag(session)}\`${h.site === null ? "" : ` or \`tabcap guard resume --site ${h.site}\``}; \`tabcap handoff wait${sessionFlag(session)}\` without --until-* waits for that (over MCP: ${MCP_CONTINUE}, ${MCP_WAIT}).`,
    );
  }
  // Owner 10-21: without --until-* this only waits for the human and never touches the tab (it may be closed).
  const b = conds.length > 0 ? d.need() : null;
  const handoffTab = (): Tab => {
    if (b === null) throw new TabcapError("internal", "no browser for the handoff's tab", "This is a bug.");
    const tab = b.tabs.tabs.get(h.tab);
    if (tab === undefined || tab.closed || tab.session !== session) throw tabGone(session, h, started);
    return tab;
  };
  const scope = b === null ? null : new FrameScope(b.t, b.tabs, handoffTab());
  if (h.started !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([h.started, new Promise<void>((r) => (timer = setTimeout(r, BASELINE_WAIT_MS)))]);
    clearTimeout(timer);
  }
  h.seenFalse ??= new Set();
  for (const k of baselineFalse(conds, h.start)) h.seenFalse.add(k);
  const deadline = started + timeoutMs;
  const waker = new Waker();
  const offState = d.guard.onState((s) => {
    if (s === session) waker.wake();
  });
  const offNav = b?.tabs.onNav((x) => {
    if (x.session === session && x.id === h.tab) waker.wake();
  });
  try {
    for (let round = 0; ; round++) {
      if (d.guard.get(session) !== h || h.state !== "waiting") return view(session, h, started);
      if (conds.length > 0 && b !== null && scope !== null) {
        const tab = handoffTab();
        const results: Array<{ holds: boolean | null; detail: Record<string, unknown> }> = [];
        for (const c of conds) results.push(await check(b.t, tab, c, scope));
        if (d.guard.get(session) !== h || h.state !== "waiting") return view(session, h, started);
        const r = decideRound(
          conds,
          results.map((x) => x.holds),
          h.seenFalse,
          round === 0,
        );
        if (r.fired !== null) return await finish(d, session, h, r.fired, results[conds.indexOf(r.fired)]?.detail ?? {}, started);
        if (r.allAlready) {
          const list = conds.map((c) => `--until-${c.kind} ${JSON.stringify(c.value)}`).join(", ");
          throw stillWaiting(
            session,
            h,
            `${list} already ${conds.length === 1 ? "holds" : "hold"} and ${conds.length === 1 ? "was" : "were"} not seen otherwise during this handoff, so it cannot show that the user is done; session "${session}" still waits`,
            `Ask the user; when they tell you they are done, run \`tabcap handoff continue${sessionFlag(session)}\`. Or wait on something that appears only once they are done (the URL after login, a cookie the login sets) (over MCP: ${MCP_CONTINUE}, ${MCP_WAIT}).`,
            started,
          );
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw stillWaiting(
          session,
          h,
          `session "${session}" still waits for the user after ${timeoutMs} ms${conds.length === 0 ? "" : ` (no --until-* condition became true)`}`,
          `Run \`tabcap handoff wait${sessionFlag(session)}\` again (over MCP: ${MCP_WAIT}) to keep waiting, or when the user tells you they are done, \`tabcap handoff continue${sessionFlag(session)}\` (over MCP: ${MCP_CONTINUE}); until then do not act on this site.`,
          started,
        );
      }
      await waker.sleep(Math.min(POLL_MS, left));
    }
  } finally {
    offState();
    offNav?.();
  }
}

/** A condition held: end the handoff like `handoff continue`, except fetch stops stay (they need a decision). */
async function finish(d: Daemon, session: string, h: Handoff, c: Until, detail: Record<string, unknown>, started: number): Promise<Record<string, unknown>> {
  try {
    d.guard.resume(session, "condition", null, { kind: c.kind, value: c.value });
  } catch (e) {
    // the human (or a handler) ended it in the meantime
    if (e instanceof TabcapError && e.code === "not-found") return view(session, h, started);
    throw e;
  }
  const account = clearNeedsHuman(d, session);
  const storeSession = await saveSiteSession(d, session);
  const stops = d.guard.fetchStopsBy(session).map((s) => ({ site: s.site, reason: s.reason, rule: s.rule, request: s.request }));
  return {
    session,
    state: h.state,
    by: "condition",
    condition: { kind: c.kind, value: c.value, ...(c.kind === "cookie" ? {} : detail) },
    waitedMs: Date.now() - started,
    handoff: handoffView(h),
    storeSession,
    ...(account === null ? {} : { account }),
    ...(stops.length === 0 ? {} : { guardStops: stops, next: `Fetches stay stopped (${stops.map((s) => s.site).join(", ")}): look at the response, decide with the user, then \`tabcap guard resume --site <site>\`.` }),
  };
}
