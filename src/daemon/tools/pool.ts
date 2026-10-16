// Account guard hooks of the daemon (0.4-D, docs/08 §3 0.4; docs/04 §4.2
// `guard` events): the hourly request budget (only when config.json
// pool.budget.requestsPerHour is set), failed logins → needs-human.
// Requests are counted from the recording (the recorder is the only Network
// observer, as for the breaker), per account and hourly window.

import { TabcapError } from "../../shared/envelope.ts";
import { log } from "../../shared/log.ts";
import { BLOCKED_WHILE_WAITING } from "../guard.ts";
import type { Daemon } from "../state.ts";

/** One recorded request of a session: counted for its account; the budget event when this one reached the limit. */
export function noteAccountRequest(d: Daemon, session: string): void {
  const b = d.sites.get(session);
  if (b === undefined || b.account === null || d.store === null) return;
  try {
    const hit = d.pool.noteRequest(d.store, b.site, b.account);
    if (hit === null) return;
    d.recorders.get(session)?.event("guard", { event: "budget", site: b.site, account: b.account, detail: { rule: "requests-per-hour", requests: hit.requests, limit: hit.limit, windowStart: hit.windowStart, decision: "limit-reached" } });
  } catch (e) {
    log.warn("pool: counting the request failed", { session, error: String(e) });
  }
}

/** A page-acting command of a session whose account used its hourly budget: the refusal (and its `guard` event), else null. */
export function budgetBlock(d: Daemon, session: string, action: string): TabcapError | null {
  if (!BLOCKED_WHILE_WAITING.has(action)) return null;
  const b = d.sites.get(session);
  if (b === undefined || b.account === null || d.store === null) return null;
  let budget: { limit: number; requests: number; windowStart: number } | null;
  try {
    budget = d.pool.budget(d.store, b.site, b.account);
  } catch (e) {
    return e instanceof TabcapError ? e : null;
  }
  if (budget === null || budget.requests < budget.limit) return null;
  const until = budget.windowStart + 3_600_000;
  d.recorders.get(session)?.event("guard", { event: "budget", site: b.site, account: b.account, detail: { rule: "requests-per-hour", requests: budget.requests, limit: budget.limit, windowStart: budget.windowStart, decision: "refused", action } });
  return new TabcapError(
    "guard.budget",
    `account ${b.site}.${b.account} used its budget of ${budget.limit} requests this hour (${budget.requests} recorded)`,
    `Wait until ${new Date(until).toISOString()} (the next hourly window), or ask the human to raise pool.budget.requestsPerHour in config.json.`,
    { site: b.site, account: b.account, requests: budget.requests, limit: budget.limit, until },
  );
}
