// JSON envelope shared by the CLI and the daemon API.
// Every command prints exactly one envelope on stdout. Errors always carry
// `next`: a short, actionable "what to do next" sentence (docs/03 §5, 接口).

export type ErrorCode =
  | "usage" // bad command line / unknown command
  | "not-found" // file, bundle or blob does not exist
  | "bad-input" // malformed external input (HAR, bundle, JSON)
  | "unsupported" // valid input we do not handle (e.g. future format major)
  | "conflict" // target already exists / bundle already finished
  | "io" // filesystem failure
  | "not-running" // daemon or browser is not running
  | "no-tab" // the session has no usable tab
  | "stale-ref" // snapshot ref unknown / expired / gone from the page
  | "dialog" // a JavaScript dialog blocks the tab
  | "timeout" // command or CDP call took too long
  | "cdp" // the browser rejected a CDP command
  | "page" // page-side failure (navigation error, script exception)
  | "needs-await" // evaluate returned a Promise without --await
  | "not-delivered" // trusted input did not reach the page
  | "move-timeout" // click --trusted: a mouse move got no answer in time; nothing was pressed, no retry
  | "not-painted" // hover: the tab is not confirmed painted, so no mouse move was sent
  | "covered" // an overlay (dialog, mask, layer, consent, timeout prompt) covers the target; `overlay` names it and its close-button refs
  | "waiting" // the session is handed to the human (guard / handoff); run `tabcap handoff continue` after they finish
  | "guard.login-limit" // a second login attempt in the same session (docs/06 A6.2); --confirm overrides
  | "guard.budget" // the account used its configured hourly request budget (config.json pool.budget); page commands wait for the next hour
  | "guard.stopped" // a `tabcap fetch` stop rule fired on this site; further fetches wait for `tabcap guard resume --site <s>`
  | "fetch.stopped" // this fetch's response tripped a stop rule (it is recorded; the site is now stopped)
  | "fetch.blocked" // the page's CORS rules blocked this fetch (the console reason is attached)
  | "ext.no-context" // ext mode cannot give this account its own browser context (proxy-bound, or a second account): use the direct mode
  | "daemon-version" // the daemon runs another tabcap version than this CLI: restart it (RESTART_DAEMON)
  | "internal"; // bug

/** How to get a daemon that runs the installed version (after `tabcap update`, and on `daemon-version`). */
export const RESTART_DAEMON = "tabcap daemon stop && tabcap daemon start";

/**
 * Owner 10-21: the CLI's version, sent in every POST /command body, differs from the daemon's.
 * `extra` names both, so a script can tell which side is behind.
 */
export function daemonVersionFail(daemon: string, cli: string): FailEnvelope {
  return fail("daemon-version", `the daemon runs tabcap ${daemon}, this CLI is tabcap ${cli}`, `Restart the daemon so it runs this CLI's version: \`${RESTART_DAEMON}\` (that also stops its browser and finishes its recordings).`, { daemonVersion: daemon, cliVersion: cli });
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
  /** `--select` path (0.5-C output filters). */
  selected?: string;
  /** What the output filters did (`--select` / `--grep` / `--fields`). */
  filter?: Record<string, unknown>;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  next: string;
  /** Extra machine-readable fields of some codes (`waiting`: state, reason, screenshot …). */
  [field: string]: unknown;
}

export interface FailEnvelope {
  ok: false;
  error: ErrorBody;
}

export type Envelope<T> = OkEnvelope<T> | FailEnvelope;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, next: string, extra: Record<string, unknown> = {}): FailEnvelope {
  return { ok: false, error: { ...extra, code, message, next } };
}

/** Typed error thrown by library code; the CLI turns it into a FailEnvelope. */
export class TabcapError extends Error {
  readonly code: ErrorCode;
  readonly next: string;
  readonly extra: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, next: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "TabcapError";
    this.code = code;
    this.next = next;
    this.extra = extra;
  }
}

/** Convert anything thrown into a FailEnvelope without losing TabcapError details. */
export function toFail(err: unknown): FailEnvelope {
  if (err instanceof TabcapError) return fail(err.code, err.message, err.next, err.extra);
  const message = err instanceof Error ? err.message : String(err);
  return fail("internal", message, "This is a bug; rerun with TABCAP_LOG=debug and report the output.");
}
