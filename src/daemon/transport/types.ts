// Transport interface (docs/07 §1, docs/08 §2): the only thing `browser/`,
// `tools/` and `capture/` know about the browser connection. It speaks CDP:
// send a command (optionally on a flattened session), receive events, and see
// targets attach / detach. `direct` (pipe or port to our own Chrome for
// Testing) implements it now; `ext` (extension relay) in phase 2.

export type CdpParams = Record<string, unknown>;
export type CdpResult = Record<string, unknown>;

/** One CDP event. `sessionId` is null for browser-level events. Params are untrusted. */
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId: string | null };

export type TargetType = "page" | "iframe" | "service_worker" | "shared_worker" | "worker" | "browser" | "other";

export type AttachedTarget = {
  targetId: string;
  sessionId: string;
  type: TargetType;
  url: string;
  title: string;
  /** Session the attach event arrived on: null = browser level, else the host page / frame. */
  parentSessionId: string | null;
  openerId: string | null;
};

/**
 * Runs while a freshly attached target is still paused (waitForDebuggerOnStart),
 * before `Runtime.runIfWaitingForDebugger`. Use it to enable domains that must
 * see the very first request (Network, Fetch).
 */
export type AttachHook = (t: AttachedTarget) => Promise<void>;

export interface Transport {
  readonly kind: "direct" | "ext";
  send(method: string, params?: CdpParams, sessionId?: string | null, timeoutMs?: number): Promise<CdpResult>;
  /** Subscribe to every CDP event; returns an unsubscribe function. */
  onEvent(fn: (e: CdpEvent) => void): () => void;
  onAttach(hook: AttachHook): () => void;
  onDetach(fn: (t: AttachedTarget) => void): () => void;
  /** Attach explicitly (targets that auto-attach did not pick up). */
  attach(targetId: string): Promise<AttachedTarget>;
  detach(sessionId: string): Promise<void>;
  /** Resolves once `targetId` is attached and resumed; rejects on timeout. */
  waitAttached(targetId: string, timeoutMs: number): Promise<AttachedTarget>;
  targets(): AttachedTarget[];
  /** Resolves when the connection is gone (browser exited or pipe closed). */
  readonly closed: Promise<string>;
}
