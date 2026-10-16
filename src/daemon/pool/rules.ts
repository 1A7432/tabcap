// Account pool and proxy pool rules (docs/08 §3 0.4, owner design 10-16):
// pure functions over store rows and an injected wall clock, so every state
// machine is unit-tested with a fake clock (test/unit/pool.test.ts).
//
// Proxy:   unknown → up on a successful check; up (or unknown) → down after
//          3 consecutive failures; down is rechecked after 1 / 5 / 15 min
//          (then every 15 min), one success → up; `disabled` only by hand
//          and never checked automatically; no health URL and no --url →
//          nothing is contacted and the state is `unchecked`.
// Account: active → cooling for 30 min on a guard breaker → active once the
//          time has passed; 2 failed logins within 24 h → needs-human, which
//          only `handoff continue` or `account set-state active` clears;
//          `disabled` is never allocated.
// Allocation (`session start --account auto`): fixed = the site's first
//          eligible account, round-robin = the next eligible one after the
//          most recently used, lru = the eligible one with the oldest
//          `last_used_at` (never used first).
// Egress:  fixed = the account's bound proxy; rotate = the next eligible
//          proxy (by name) when the configured trigger has fired, decided at
//          session start (a context's proxy is fixed for its lifetime).

import type { AccountPatch, AccountRow, AccountState, ProxyCheckPatch, ProxyRow, ProxyState } from "../store/db.ts";
import { TabcapError } from "../../shared/envelope.ts";

export const PROXY_DOWN_AFTER = 3;
/** Recheck back-off of a `down` proxy, by consecutive failures beyond PROXY_DOWN_AFTER - 1. */
export const PROXY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const COOLING_MS = 30 * 60_000;
export const FAILED_LOGIN_LIMIT = 2;
export const FAILED_LOGIN_WINDOW_MS = 24 * 3_600_000;

// ------------------------------------------------------------ proxies

export type CheckOutcome = { ok: boolean; latencyMs: number | null };

/** The row update after one health check at `now`. A disabled proxy keeps its state. */
export function proxyAfterCheck(p: Pick<ProxyRow, "state" | "failCount">, r: CheckOutcome, now: number): ProxyCheckPatch {
  const base: ProxyCheckPatch = { lastCheckAt: now, latencyMs: r.latencyMs };
  if (r.ok) {
    return { ...base, lastOkAt: now, failCount: 0, recheckAt: null, ...(p.state === "disabled" ? {} : { state: "up" as ProxyState }) };
  }
  const failCount = p.failCount + 1;
  if (p.state === "disabled") return { ...base, failCount };
  if (failCount < PROXY_DOWN_AFTER) return { ...base, failCount };
  const step = Math.min(failCount - PROXY_DOWN_AFTER, PROXY_BACKOFF_MS.length - 1);
  return { ...base, failCount, state: "down", recheckAt: now + (PROXY_BACKOFF_MS[step] ?? 0) };
}

/** `proxy check` with no URL (none given, none configured): nothing is contacted. */
export function proxyUnchecked(p: Pick<ProxyRow, "state">): ProxyCheckPatch {
  return p.state === "disabled" ? {} : { state: "unchecked" };
}

/** `proxy set-state … active` on a disabled proxy: back to `unknown` with the failure history forgotten (the next check decides). */
export function proxyReactivated(): ProxyCheckPatch {
  return { state: "unknown", failCount: 0, recheckAt: null };
}

/** Is a periodic health check due (daemon loop, only when `pool.health.url` is set)? */
export function proxyDue(p: Pick<ProxyRow, "state" | "lastCheckAt" | "recheckAt">, now: number, intervalMs: number): boolean {
  if (p.state === "disabled") return false;
  if (p.state === "down") return p.recheckAt === null || p.recheckAt <= now;
  return p.lastCheckAt === null || now - p.lastCheckAt >= intervalMs;
}

/** May sessions go out through this proxy? (`down` and `disabled` may not.) */
export function proxyUsable(state: ProxyState): boolean {
  return state !== "down" && state !== "disabled";
}

// ------------------------------------------------------------ accounts

/** The state as of `now`: a cooling account whose time has passed is active again. */
export function accountState(a: Pick<AccountRow, "state" | "coolUntil">, now: number): AccountState {
  if (a.state === "cooling" && (a.coolUntil === null || a.coolUntil <= now)) return "active";
  return a.state;
}

/** A guard breaker on the account's session: cooling for 30 min (a disabled / needs-human account keeps its state). */
export function accountOnBreaker(a: Pick<AccountRow, "state" | "coolUntil">, now: number): AccountPatch {
  const st = accountState(a, now);
  if (st === "disabled" || st === "needs-human") return {};
  return { state: "cooling", coolUntil: now + COOLING_MS };
}

/**
 * One failed login. Failures more than 24 h apart do not add up; the second
 * within 24 h makes the account `needs-human` (a disabled account stays disabled).
 */
export function accountOnFailedLogin(a: Pick<AccountRow, "state" | "failStreak" | "lastFailAt">, now: number): AccountPatch & { failStreak: number; needsHuman: boolean } {
  const within = a.lastFailAt !== null && now - a.lastFailAt <= FAILED_LOGIN_WINDOW_MS;
  const failStreak = within ? a.failStreak + 1 : 1;
  const needsHuman = failStreak >= FAILED_LOGIN_LIMIT && a.state !== "disabled";
  return { failStreak, lastFailAt: now, needsHuman, ...(needsHuman ? { state: "needs-human" as AccountState, coolUntil: null } : {}) };
}

/** `handoff continue` / `account set-state active`: back to active, failures forgotten. */
export function accountCleared(): AccountPatch {
  return { state: "active", coolUntil: null, failStreak: 0, lastFailAt: null };
}

export type Strategy = "fixed" | "round-robin" | "lru";

/**
 * Pick an account for `--account auto`. `accounts` in the site's order (as
 * added); `eligible` says which may be allocated now. Null when none may.
 */
export function allocate<T extends Pick<AccountRow, "username" | "lastUsedAt">>(strategy: Strategy, accounts: readonly T[], eligible: (a: T) => boolean): T | null {
  const ok = accounts.filter(eligible);
  if (ok.length === 0) return null;
  if (strategy === "fixed") return ok[0] ?? null;
  if (strategy === "lru") {
    let best: T | null = null;
    for (const a of ok) if (best === null || (a.lastUsedAt ?? -Infinity) < (best.lastUsedAt ?? -Infinity)) best = a;
    return best;
  }
  // round-robin: the next eligible account after the most recently used one (in site order).
  let lastIdx = -1;
  let lastAt = -Infinity;
  accounts.forEach((a, i) => {
    if (a.lastUsedAt !== null && a.lastUsedAt > lastAt) {
      lastAt = a.lastUsedAt;
      lastIdx = i;
    }
  });
  for (let k = 1; k <= accounts.length; k++) {
    const a = accounts[(lastIdx + k + accounts.length) % accounts.length];
    if (a !== undefined && eligible(a)) return a;
  }
  return null;
}

// ------------------------------------------------------------ egress rotation

export type RotateOn = { kind: "per-session" } | { kind: "requests"; n: number } | { kind: "minutes"; n: number };

/** `per-session` | `every:<N>requests` | `every:<T>min` (no other trigger exists). */
export function parseRotateOn(v: string): RotateOn {
  if (v === "per-session") return { kind: "per-session" };
  const m = /^every:([1-9]\d{0,8})(requests|min)$/.exec(v);
  if (m !== null && m[1] !== undefined) return m[2] === "requests" ? { kind: "requests", n: Number(m[1]) } : { kind: "minutes", n: Number(m[1]) };
  throw new TabcapError("bad-input", `pool.egress.rotateOn ${JSON.stringify(v)} is not a trigger`, 'Use "per-session", "every:<N>requests" or "every:<T>min" in config.json.');
}

/** Egress state of one account (daemon memory): the proxy it goes out through and since when. */
export type Rotation = { current: string; rotatedAt: number; requests: number; sessions: number };

/** Has the trigger fired, so the session starting now gets the next proxy? */
export function rotationDue(on: RotateOn, r: Rotation, now: number): boolean {
  if (on.kind === "per-session") return r.sessions > 0;
  if (on.kind === "requests") return r.requests >= on.n;
  return now - r.rotatedAt >= on.n * 60_000;
}

/** The proxy after `current` in `ring` (names, sorted), skipping unusable ones; `current` itself when nothing else is usable. */
export function nextProxy(ring: readonly string[], current: string, usable: (name: string) => boolean): string {
  const at = ring.indexOf(current);
  for (let k = 1; k <= ring.length; k++) {
    const n = ring[(at + k + ring.length) % ring.length];
    if (n !== undefined && n !== current && usable(n)) return n;
  }
  return current;
}
