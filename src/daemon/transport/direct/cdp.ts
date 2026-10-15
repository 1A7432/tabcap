// Minimal CDP client over a message wire (pipe or WebSocket).
// - ids are allocated here; responses are routed by id, events by sessionId;
// - every command has a timeout (default 60 s): a hidden never-painted tab can
//   leave `Input.dispatchMouseEvent` pending forever (docs/07 §1.1);
// - incoming JSON is untrusted: malformed messages are logged and dropped.

import { isRecord } from "../../../shared/json.ts";
import { log } from "../../../shared/log.ts";
import type { CdpEvent, CdpParams, CdpResult } from "../types.ts";

export const CDP_TIMEOUT_MS = 60_000;

/** A bidirectional message channel carrying one JSON text per message. */
export interface Wire {
  send(text: string): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: (reason: string) => void): void;
  close(): void;
}

export class CdpError extends Error {
  readonly method: string;
  /** CDP error code (e.g. -32000), or null for timeouts / closed connection. */
  readonly cdpCode: number | null;
  constructor(method: string, message: string, cdpCode: number | null) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
    this.method = method;
    this.cdpCode = cdpCode;
  }
}

export class CdpTimeoutError extends CdpError {
  constructor(method: string, ms: number) {
    super(method, `no response after ${ms} ms`, null);
    this.name = "CdpTimeoutError";
  }
}

export class CdpClosedError extends CdpError {
  constructor(method: string, reason: string) {
    super(method, `connection closed (${reason})`, null);
    this.name = "CdpClosedError";
  }
}

type Pending = {
  method: string;
  resolve: (r: CdpResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: CdpEvent) => void>();
  private closedReason: string | null = null;
  readonly closed: Promise<string>;
  private resolveClosed: (reason: string) => void = () => undefined;
  /** Method names sent so far, counted (an audit trail for focus-stealing calls). */
  readonly sentCounts = new Map<string, number>();

  constructor(
    private readonly wire: Wire,
    private readonly defaultTimeoutMs: number = CDP_TIMEOUT_MS,
  ) {
    this.closed = new Promise((r) => (this.resolveClosed = r));
    wire.onMessage((text) => this.receive(text));
    wire.onClose((reason) => this.shutdown(reason));
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  send(method: string, params: CdpParams = {}, sessionId: string | null = null, timeoutMs?: number): Promise<CdpResult> {
    if (this.closedReason !== null) return Promise.reject(new CdpClosedError(method, this.closedReason));
    const id = ++this.nextId;
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    this.sentCounts.set(method, (this.sentCounts.get(method) ?? 0) + 1);
    return new Promise<CdpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpTimeoutError(method, ms));
      }, ms);
      this.pending.set(id, { method, resolve, reject, timer });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId !== null) msg["sessionId"] = sessionId;
      try {
        this.wire.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpClosedError(method, e instanceof Error ? e.message : String(e)));
      }
    });
  }

  on(fn: (e: CdpEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Wait for the first event matching `pred`; null on timeout. */
  waitFor(pred: (e: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent | null> {
    return new Promise((resolve) => {
      const off = this.on((e) => {
        if (!pred(e)) return;
        off();
        clearTimeout(timer);
        resolve(e);
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  close(): void {
    this.wire.close();
    this.shutdown("closed by client");
  }

  private receive(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn("cdp: dropped non-JSON message", { head: text.slice(0, 120) });
      return;
    }
    if (!isRecord(msg)) return;
    const id = msg["id"];
    if (typeof id === "number") {
      const p = this.pending.get(id);
      if (p === undefined) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = msg["error"];
      if (isRecord(err)) {
        const m = typeof err["message"] === "string" ? err["message"] : "unknown CDP error";
        const data = typeof err["data"] === "string" ? ` (${err["data"]})` : "";
        p.reject(new CdpError(p.method, m + data, typeof err["code"] === "number" ? err["code"] : null));
      } else {
        const result = msg["result"];
        p.resolve(isRecord(result) ? result : {});
      }
      return;
    }
    const method = msg["method"];
    if (typeof method !== "string") return;
    const params = isRecord(msg["params"]) ? msg["params"] : {};
    const sessionId = typeof msg["sessionId"] === "string" ? msg["sessionId"] : null;
    const ev: CdpEvent = { method, params, sessionId };
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        log.error("cdp: event listener threw", { method, error: String(e) });
      }
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpClosedError(p.method, reason));
    }
    this.pending.clear();
    this.resolveClosed(reason);
  }
}
