/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Post-action wait (docs/08 §5), the pure state machine; tools/settle.ts drives
// it over CDP. Reimplemented after chrome-devtools-mcp's WaitForHelper
// (src/utils/WaitForHelper.ts, commit e9000381f414bf5fd5fb83a9164fabfb8e0987b3,
// read 2026-10-15; the page-side stable-DOM observer follows its
// waitForStableDom). Modifications for tabcap: an explicit state machine over
// CDP events instead of Puppeteer's waitForNavigation; after an
// action, wait for a navigation if one starts within 100 ms, then for 100 ms
// without DOM changes, each phase bounded by 3000 ms; every number scaled by
// the CPU throttling rate, the navigation timeout by the network preset's
// multiplier. A JavaScript dialog ends the wait at once (the renderer is
// paused). The machine never fails: a phase that runs out is reported in
// `timedOut` and the command still answers.

export type PostWaitConfig = {
  /** A navigation must start within this long after the action. */
  expectNavMs: number;
  /** The started navigation must finish within this long. */
  navTimeoutMs: number;
  /** "Stable DOM": no mutation for this long … */
  quietMs: number;
  /** … within this long. */
  domTimeoutMs: number;
};

/** WaitForHelper's numbers (3000 / 100 / 100 / 3000 ms) scaled like there. */
export function postWaitConfig(cpuRate = 1, networkMult = 1): PostWaitConfig {
  const cpu = Number.isFinite(cpuRate) && cpuRate >= 1 ? cpuRate : 1;
  const net = Number.isFinite(networkMult) && networkMult >= 1 ? networkMult : 1;
  return { expectNavMs: 100 * cpu, navTimeoutMs: 3000 * net, quietMs: 100 * cpu, domTimeoutMs: 3000 * cpu };
}

export type PostWaitEvent =
  | { type: "action-done" }
  /** The tab's main frame started a cross-document navigation (or one was requested). */
  | { type: "nav-started" }
  /** The main frame finished loading (load event / stopped loading). */
  | { type: "nav-finished" }
  | { type: "dialog" }
  /** The DOM check answered: quiet, or not quiet within domTimeoutMs. */
  | { type: "dom-quiet" }
  | { type: "dom-timeout" }
  /** A phase deadline passed (the driver sends it at `deadline()`). */
  | { type: "tick" };

export type Phase = "action" | "expect-nav" | "navigating" | "dom" | "done";

export type PostWaitState = {
  phase: Phase;
  /** When the current phase began (driver clock, ms). */
  since: number;
  navStarted: boolean;
  navFinished: boolean;
  dialog: boolean;
  /** null until the DOM phase answered. */
  domQuiet: boolean | null;
  timedOut: Array<"navigation" | "dom">;
};

export function initialState(now: number): PostWaitState {
  return { phase: "action", since: now, navStarted: false, navFinished: false, dialog: false, domQuiet: null, timedOut: [] };
}

const to = (s: PostWaitState, phase: Phase, now: number, patch: Partial<PostWaitState> = {}): PostWaitState => ({ ...s, ...patch, phase, since: now });

/** One transition. Unknown or late events leave the state as it is. */
export function step(s: PostWaitState, ev: PostWaitEvent, now: number, cfg: PostWaitConfig): PostWaitState {
  if (s.phase === "done") return s;
  if (ev.type === "dialog") return to(s, "done", now, { dialog: true });
  switch (s.phase) {
    case "action":
      if (ev.type === "nav-started") return { ...s, navStarted: true };
      if (ev.type === "nav-finished") return s.navStarted ? { ...s, navFinished: true } : s;
      if (ev.type === "action-done") {
        if (!s.navStarted) return to(s, "expect-nav", now);
        return s.navFinished ? to(s, "dom", now) : to(s, "navigating", now);
      }
      return s;
    case "expect-nav":
      if (ev.type === "nav-started") return to(s, "navigating", now, { navStarted: true });
      if (ev.type === "tick" && now - s.since >= cfg.expectNavMs) return to(s, "dom", now);
      return s;
    case "navigating":
      if (ev.type === "nav-finished") return to(s, "dom", now, { navFinished: true });
      if (ev.type === "tick" && now - s.since >= cfg.navTimeoutMs) return to(s, "dom", now, { timedOut: [...s.timedOut, "navigation"] });
      return s;
    case "dom":
      if (ev.type === "dom-quiet") return to(s, "done", now, { domQuiet: true });
      if (ev.type === "dom-timeout") return to(s, "done", now, { domQuiet: false, timedOut: [...s.timedOut, "dom"] });
      if (ev.type === "nav-started") return { ...s, navStarted: true };
      return s;
  }
}

/** When the driver must send `tick` next (null: wait for an event, or run the DOM check). */
export function deadline(s: PostWaitState, cfg: PostWaitConfig): number | null {
  if (s.phase === "expect-nav") return s.since + cfg.expectNavMs;
  if (s.phase === "navigating") return s.since + cfg.navTimeoutMs;
  return null;
}

export type PostWaitReport = { navigated: boolean; domQuiet: boolean | null; dialog: boolean; timedOut: Array<"navigation" | "dom">; ms: number };

export function report(s: PostWaitState, startedAt: number, now: number): PostWaitReport {
  return { navigated: s.navStarted, domQuiet: s.domQuiet, dialog: s.dialog, timedOut: s.timedOut, ms: Math.round(now - startedAt) };
}

/**
 * Page-side "stable DOM" check (WaitForHelper.waitForStableDom): resolves true
 * after `quietMs` without a childList / attribute mutation under the body,
 * false when `maxMs` passes first. Only an observer; it changes nothing.
 */
export function stableDomExpression(quietMs: number, maxMs: number): string {
  const q = Math.max(1, Math.round(quietMs));
  const m = Math.max(q, Math.round(maxMs));
  return `new Promise((resolve) => {
  let done = false, timer = 0;
  const target = document.body || document.documentElement;
  const finish = (v) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(cap); obs.disconnect(); resolve(v); } };
  const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => finish(true), ${q}); });
  const cap = setTimeout(() => finish(false), ${m});
  timer = setTimeout(() => finish(true), ${q});
  if (target) obs.observe(target, { childList: true, subtree: true, attributes: true });
})`;
}
