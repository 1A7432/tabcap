// Human take-over detection (0.7.1-A, docs/04 §37; measurements docs/07 §1.1).
//
// A passive listener in tabcap's own isolated world `tabcap-takeover` on every
// owned tab of a `direct` browser (new tabs and owned popups, installed when
// the tab joins its session, re-installed by Chrome on every new document and
// same-process frame): capture-phase, passive `pointerdown` / `keydown` /
// `wheel` / `touchstart` listeners that report trusted events only, as
// {k: kind, t: page time (epoch ms), tr: true}, one per kind per 250 ms. No
// key values, text, coordinates or targets leave the page; nothing is
// prevented or changed. The binding exists in that world only: the page's own
// scripts cannot call it (`typeof window.__tabcapTakeover` is "undefined" in
// the main world, spike-071a).
//
// tabcap's own CDP input is trusted in the page too, so every `Input.*` the
// daemon sends opens a window (transport/inputwindows.ts); a report that
// reaches the daemon inside a window of its tab (or within the grace after)
// is tabcap's own and ignored. Anything else is the human: the session goes
// to `waiting` with reason `human-takeover` (guard.ts), and while a session
// waits (any reason) every human input is recorded as an `action` event,
// `actor:"human"`.

import { isRecord, tryParseJson } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { GuardRecorder } from "../guard.ts";
import type { DirectTransport } from "../transport/direct/index.ts";
import type { CdpEvent } from "../transport/types.ts";
import type { Tab, Tabs } from "./targets.ts";

export const TAKEOVER_WORLD = "tabcap-takeover";
export const TAKEOVER_BINDING = "__tabcapTakeover";
/** The input kinds that count as the human operating the tab (moving the mouse alone does not). */
export const TAKEOVER_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
export type TakeoverEvent = (typeof TAKEOVER_EVENTS)[number];
/** The page reports one event per kind per this many ms (wheel and typing bursts). */
export const TAKEOVER_COALESCE_MS = 250;

const KINDS: ReadonlySet<string> = new Set(TAKEOVER_EVENTS);
export const isTakeoverEvent = (k: string): k is TakeoverEvent => KINDS.has(k);

/** The listener, evaluated in the `tabcap-takeover` world of every document of an armed tab. */
export const TAKEOVER_SOURCE = `(() => {
  const send = globalThis[${JSON.stringify(TAKEOVER_BINDING)}];
  if (typeof send !== "function" || globalThis.__tabcapTakeoverArmed === true) return;
  globalThis.__tabcapTakeoverArmed = true;
  const last = Object.create(null);
  const on = (e) => {
    if (e.isTrusted !== true) return;
    const k = e.type;
    const t = Math.round(performance.timeOrigin + e.timeStamp);
    const prev = last[k];
    if (typeof prev === "number" && t >= prev && t - prev < ${TAKEOVER_COALESCE_MS}) return;
    last[k] = t;
    try { send(JSON.stringify({ k: k, t: t, tr: true })); } catch (_) {}
  };
  for (const k of ${JSON.stringify(TAKEOVER_EVENTS)}) addEventListener(k, on, { capture: true, passive: true });
})();`;

/** One report of the listener. `at` is the page time of the event (epoch ms), null when absent. */
export type TakeoverReport = { event: string; trusted: boolean; at: number | null };

/** Parse a binding payload (untrusted: it comes from a page process); null when malformed. */
export function parseTakeoverPayload(payload: unknown): TakeoverReport | null {
  if (typeof payload !== "string" || payload.length > 256) return null;
  const v = tryParseJson(payload);
  if (!isRecord(v)) return null;
  const k = v["k"];
  if (typeof k !== "string" || k.length === 0 || k.length > 32) return null;
  const t = v["t"];
  return { event: k, trusted: v["tr"] === true, at: typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.round(t) : null };
}

export type TakeoverDecision = { verdict: "takeover" } | { verdict: "human-input" } | { verdict: "ignore"; why: "untrusted" | "kind" | "tabcap-input" };

/**
 * Pure (docs/04 §37): untrusted → ignore; not one of the four kinds → ignore;
 * inside one of tabcap's own input windows → ignore; the session already
 * waits (any reason) → record it as the human's input; else → take-over.
 */
export function decideTakeover(o: { event: string; trusted: boolean; inWindow: boolean; waiting: boolean }): TakeoverDecision {
  if (!o.trusted) return { verdict: "ignore", why: "untrusted" };
  if (!isTakeoverEvent(o.event)) return { verdict: "ignore", why: "kind" };
  if (o.inWindow) return { verdict: "ignore", why: "tabcap-input" };
  return o.waiting ? { verdict: "human-input" } : { verdict: "takeover" };
}

/** What a decision needs from the daemon (a Daemon, or fakes in unit tests). */
export type TakeoverDeps = {
  guard: {
    isWaiting(session: string): boolean;
    takeover(session: string, o: { tab: string; url: string; event: string; at: number }, rec: GuardRecorder | undefined): unknown;
    markHumanActive(session: string): void;
  };
  recorder: (session: string) => GuardRecorder | undefined;
  navOf: (tab: Tab) => string | null;
};

/** Act on one report: take-over, or record the human's input while the session waits. */
export function onHumanInput(deps: TakeoverDeps, tab: Tab, r: TakeoverReport, receivedAt: number, inWindow: boolean): TakeoverDecision {
  const v = decideTakeover({ event: r.event, trusted: r.trusted, inWindow, waiting: deps.guard.isWaiting(tab.session) });
  if (v.verdict === "ignore") {
    log.debug("takeover: input ignored", { tab: tab.id, event: r.event, why: v.why });
    return v;
  }
  const rec = deps.recorder(tab.session);
  const at = r.at ?? receivedAt;
  if (v.verdict === "takeover") deps.guard.takeover(tab.session, { tab: tab.id, url: tab.url, event: r.event, at }, rec);
  else deps.guard.markHumanActive(tab.session);
  rec?.event(
    "action",
    { op: "input", event: r.event, at, target: null, value: null, phase: "done", error: null, shots: null, nav: deps.navOf(tab), trusted: true },
    { tab: tab.id, actor: "human", cmd: null },
  );
  return v;
}

export type TakeoverSink = (tab: Tab, r: TakeoverReport, receivedAt: number, inWindow: boolean) => void;

/** Arms the listener on owned tabs as they join a session and routes its reports to `sink`. */
export class TakeoverWatch {
  private offs: Array<() => void> = [];
  /** Daemon tab ids the listener was installed on. */
  readonly armed = new Set<string>();

  constructor(
    private readonly t: DirectTransport,
    private readonly tabs: Tabs,
    private readonly sink: TakeoverSink,
    private readonly now: () => number = Date.now,
  ) {
    this.offs.push(
      tabs.onTabAdded((tab) => this.arm(tab)),
      t.onEvent((e) => this.onEvent(e)),
    );
  }

  /** Install the binding and the listener on a tab (its current and every later document). */
  async arm(tab: Tab): Promise<void> {
    if (!tab.owned || this.armed.has(tab.id)) return;
    await this.t.send("Runtime.addBinding", { name: TAKEOVER_BINDING, executionContextName: TAKEOVER_WORLD }, tab.sessionId, 5000);
    await this.t.send("Page.addScriptToEvaluateOnNewDocument", { source: TAKEOVER_SOURCE, worldName: TAKEOVER_WORLD, runImmediately: true }, tab.sessionId, 5000);
    this.armed.add(tab.id);
  }

  private onEvent(e: CdpEvent): void {
    if (e.method !== "Runtime.bindingCalled" || e.sessionId === null || e.params["name"] !== TAKEOVER_BINDING) return;
    const receivedAt = this.now();
    const tab = this.tabs.bySession(e.sessionId);
    if (tab === undefined || !this.armed.has(tab.id)) return;
    const r = parseTakeoverPayload(e.params["payload"]);
    if (r === null) {
      log.debug("takeover: malformed report ignored", { tab: tab.id });
      return;
    }
    try {
      this.sink(tab, r, receivedAt, this.t.inputWindows.covers(e.sessionId, receivedAt));
    } catch (x) {
      log.warn("takeover: handling a report failed", { tab: tab.id, error: String(x) });
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
