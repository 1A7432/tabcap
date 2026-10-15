// tabcap handoff status | continue (docs/05 s15, docs/06 A6).

import { handoffView } from "../guard.ts";
import type { Daemon } from "../state.ts";
import type { Args } from "./args.ts";
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
  const h = d.guard.resume(session, "human");
  const storeSession = await saveSiteSession(d, session);
  return { session, state: h.state, reason: h.reason, waitedMs: (h.resumedAt ?? Date.now()) - h.since, handoff: handoffView(h), storeSession };
}
