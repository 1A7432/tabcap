// tabcap handoff status | continue (docs/05 s15, docs/06 A6).

import { TabcapError } from "../../shared/envelope.ts";
import { handoffView } from "../guard.ts";
import type { Daemon } from "../state.ts";
import { optStr, type Args } from "./args.ts";
import { saveSiteSession } from "./session.ts";

export function handoffStatus(d: Daemon, _a: Args, session: string): unknown {
  const h = d.guard.get(session);
  return {
    session,
    state: h?.state ?? "running",
    handoff: h === null ? null : handoffView(h),
    others: d.guard
      .all()
      .filter((x) => x.session !== session && x.state === "waiting")
      .map((x) => ({ session: x.session, state: x.state, reason: x.reason, url: x.url })),
  };
}

/**
 * The human finished in the browser and told the AI to go on. A site-bound
 * session saves its cookies in the store now (the verification usually
 * renewed them), so `replay session --site` gets the fresh ones.
 */
export async function handoffContinue(d: Daemon, _a: Args, session: string): Promise<unknown> {
  // 0.4-D: `handoff continue` also clears the bound account's needs-human state.
  const b = d.sites.get(session);
  const cleared = b !== undefined && b.account !== null && d.store !== null && d.pool.clearNeedsHuman(d.store, b.site, b.account);
  const account = cleared && b !== undefined ? { account: `${b.site}.${b.account}`, state: "active", cleared: "needs-human" } : null;
  const waiting = d.guard.get(session)?.state === "waiting";
  if (!waiting && account !== null) return { session, state: "running", handoff: null, account };
  const h = d.guard.resume(session, "human");
  // 0.6-A: the human looked at the page; fetch stops this session set off are lifted with the handoff.
  const fetchResumed = d.guard.fetchStopsBy(session).map((s) => d.guard.resumeFetch(s.site, "handoff-continue", d.recorders.get(session)).site);
  const storeSession = await saveSiteSession(d, session);
  return {
    session,
    state: h.state,
    reason: h.reason,
    waitedMs: (h.resumedAt ?? Date.now()) - h.since,
    handoff: handoffView(h),
    storeSession,
    ...(account === null ? {} : { account }),
    ...(fetchResumed.length === 0 ? {} : { fetchResumed }),
  };
}

/** `tabcap guard resume --site <s>` (0.6-A): fetches on the site go out again after a stop rule fired. */
export function guardResume(d: Daemon, a: Args, session: string): unknown {
  const site = optStr(a, "site");
  if (site === null || site.trim() === "") throw new TabcapError("usage", "missing --site", "Usage: tabcap guard resume --site <site>");
  const name = site.trim();
  // The guard `resume` event goes to this session's recording, else to the one whose fetch stopped the site.
  const stop = d.guard.fetchStopOf(name);
  const rec = d.recorders.get(session) ?? (stop === null ? undefined : d.recorders.get(stop.session));
  const s = d.guard.resumeFetch(name, "guard-resume", rec);
  // 0.6-I: a site stop rule also put its session into waiting; the explicit un-trip ends that too.
  const h = s.reason === "stop-rule" ? d.guard.get(s.session) : null;
  const handoffResumed = h !== null && h.state === "waiting" && h.reason === "stop-rule" ? d.guard.resume(s.session, "guard-resume").session : null;
  return {
    site: s.site,
    resumed: true,
    reason: s.reason,
    rule: s.rule,
    request: s.request,
    stoppedSince: s.since,
    stoppedBy: s.session,
    ...(handoffResumed === null ? {} : { handoffResumed }),
  };
}
