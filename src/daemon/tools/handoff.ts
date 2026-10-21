// tabcap handoff status | continue (docs/05 s15, docs/06 A6).

import { TabcapError } from "../../shared/envelope.ts";
import { handoffView } from "../guard.ts";
import type { Daemon } from "../state.ts";
import { optNum, optStr, type Args } from "./args.ts";
import { redactUrl } from "./liveredact.ts";
import { saveSiteSession } from "./session.ts";

export async function handoffStatus(d: Daemon, _a: Args, session: string): Promise<unknown> {
  // 0.7-E: right after the trip the screenshot is still being taken; wait for it (bounded)
  await d.guard.shotTaken(session);
  const h = d.guard.get(session);
  return {
    session,
    state: h?.state ?? "running",
    handoff: h === null ? null : handoffView(h),
    others: d.guard
      .all()
      .filter((x) => x.session !== session && x.state === "waiting")
      .map((x) => ({ session: x.session, state: x.state, reason: x.reason, url: redactUrl(x.url, { scrub: (s) => d.secrets.scrub(s) }) })),
  };
}

/** 0.4-D: ending a handoff also clears the bound account's needs-human state; what was cleared, or null. */
export function clearNeedsHuman(d: Daemon, session: string): { account: string; state: "active"; cleared: "needs-human" } | null {
  const b = d.sites.get(session);
  const cleared = b !== undefined && b.account !== null && d.store !== null && d.pool.clearNeedsHuman(d.store, b.site, b.account);
  return cleared && b !== undefined && b.account !== null ? { account: `${b.site}.${b.account}`, state: "active", cleared: "needs-human" } : null;
}

/**
 * The human finished in the browser and told the AI to go on. A site-bound
 * session saves its cookies in the store now (the verification usually
 * renewed them), so `replay session --site` gets the fresh ones.
 */
export async function handoffContinue(d: Daemon, _a: Args, session: string): Promise<unknown> {
  const account = clearNeedsHuman(d, session);
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

/**
 * 0.7.1-A test-only (docs/04 §37): one trusted input from outside every tabcap
 * input window, as a human's would be. Refused unless the daemon was started
 * with TABCAP_E2E_HUMAN=1; no CLI command, not in MCP. It goes straight to the
 * CDP client (DirectTransport.send would open a window) under focus emulation
 * (a background tab ignores CDP mouse input otherwise, docs/07 §1.1).
 */
export async function e2eHumanInput(d: Daemon, a: Args, session: string): Promise<unknown> {
  if (!d.e2eHuman) throw new TabcapError("usage", "e2e.human-input is a test-only action", "It exists for the end-to-end tests: start the daemon with TABCAP_E2E_HUMAN=1.");
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const event = optStr(a, "event") ?? "pointerdown";
  if (event !== "pointerdown" && event !== "keydown") throw new TabcapError("usage", `bad event ${JSON.stringify(event.slice(0, 40))}`, "Use pointerdown or keydown.");
  const x = optNum(a, "x") ?? 4;
  const y = optNum(a, "y") ?? 4;
  const raw = (method: string, params: Record<string, unknown>) => t.cdp.send(method, params, tab.sessionId, 5000);
  await raw("Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    if (event === "pointerdown") {
      await raw("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await raw("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    } else {
      await raw("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
      await raw("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
    }
  } finally {
    await raw("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
  }
  return { injected: event, tab: tab.id, ...(event === "pointerdown" ? { x, y } : {}) };
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
