// Auto-attach protocol (docs/07 §1.1, measured on Chrome for Testing 155):
// - browser level `Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten}`;
// - on every `Target.attachedToTarget`: Runtime.enable + Log.enable (console
//   capture, any target), Page.enable (pages and frames), attach hooks (Network / Fetch when capturing), nested setAutoAttach
//   on page / iframe sessions, then ALWAYS `Runtime.runIfWaitingForDebugger`
//   (the event's waitingForDebugger flag is unreliable; popups stay frozen otherwise).

import { isRecord, str } from "../../../shared/json.ts";
import { log } from "../../../shared/log.ts";
import type { AttachHook, AttachedTarget, CdpEvent, TargetType } from "../types.ts";
import type { CdpClient } from "./cdp.ts";

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const SETUP_TIMEOUT_MS = 10_000;

function targetType(v: string | null): TargetType {
  switch (v) {
    case "page":
    case "iframe":
    case "service_worker":
    case "shared_worker":
    case "worker":
    case "browser":
      return v;
    default:
      return "other";
  }
}

export class AutoAttacher {
  private bySession = new Map<string, AttachedTarget>();
  private hooks = new Set<AttachHook>();
  private detachListeners = new Set<(t: AttachedTarget) => void>();
  private waiters = new Map<string, Array<(t: AttachedTarget) => void>>();
  /** Targets whose attach setup (hooks + resume) has finished. */
  private ready = new Set<string>();

  constructor(private readonly cdp: CdpClient) {
    cdp.on((e) => this.onEvent(e));
  }

  async start(): Promise<void> {
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", AUTO_ATTACH);
  }

  addHook(h: AttachHook): () => void {
    this.hooks.add(h);
    return () => this.hooks.delete(h);
  }

  onDetach(fn: (t: AttachedTarget) => void): () => void {
    this.detachListeners.add(fn);
    return () => this.detachListeners.delete(fn);
  }

  list(): AttachedTarget[] {
    return [...this.bySession.values()];
  }

  byTarget(targetId: string): AttachedTarget | undefined {
    for (const t of this.bySession.values()) if (t.targetId === targetId && t.type !== "other") return t;
    return undefined;
  }

  waitReady(targetId: string, timeoutMs: number): Promise<AttachedTarget | null> {
    const t = this.byTarget(targetId);
    if (t !== undefined && this.ready.has(t.sessionId)) return Promise.resolve(t);
    return new Promise((resolve) => {
      const list = this.waiters.get(targetId) ?? [];
      const fn = (x: AttachedTarget) => {
        clearTimeout(timer);
        resolve(x);
      };
      list.push(fn);
      this.waiters.set(targetId, list);
      const timer = setTimeout(() => {
        const l = this.waiters.get(targetId);
        if (l !== undefined) this.waiters.set(targetId, l.filter((f) => f !== fn));
        resolve(null);
      }, timeoutMs);
    });
  }

  private onEvent(e: CdpEvent): void {
    if (e.method === "Target.attachedToTarget") void this.attached(e);
    else if (e.method === "Target.detachedFromTarget") this.detached(e);
    else if (e.method === "Target.targetInfoChanged") {
      const info = isRecord(e.params["targetInfo"]) ? e.params["targetInfo"] : null;
      const id = info === null ? null : str(info, "targetId");
      if (info === null || id === null) return;
      for (const t of this.bySession.values()) {
        if (t.targetId !== id) continue;
        t.url = str(info, "url") ?? t.url;
        t.title = str(info, "title") ?? t.title;
      }
    }
  }

  private async attached(e: CdpEvent): Promise<void> {
    const sessionId = str(e.params, "sessionId");
    const info = isRecord(e.params["targetInfo"]) ? e.params["targetInfo"] : null;
    const targetId = info === null ? null : str(info, "targetId");
    if (sessionId === null || info === null || targetId === null) {
      log.warn("attach: malformed attachedToTarget dropped");
      return;
    }
    const t: AttachedTarget = {
      targetId,
      sessionId,
      type: targetType(str(info, "type")),
      url: str(info, "url") ?? "",
      title: str(info, "title") ?? "",
      parentSessionId: e.sessionId,
      openerId: str(info, "openerId"),
    };
    this.bySession.set(sessionId, t);
    const send = (method: string, params: Record<string, unknown> = {}) =>
      this.cdp.send(method, params, sessionId, SETUP_TIMEOUT_MS).catch((err: unknown) => {
        log.debug("attach: setup command failed", { method, targetId, error: String(err) });
      });
    try {
      const steps: Array<Promise<unknown>> = [];
      if (t.type === "page" || t.type === "iframe") {
        steps.push(send("Runtime.enable"), send("Log.enable"), send("Page.enable"));
      } else if (t.type === "service_worker" || t.type === "worker" || t.type === "shared_worker") {
        steps.push(send("Runtime.enable"), send("Log.enable"));
      }
      for (const h of [...this.hooks]) {
        steps.push(
          h(t).catch((err: unknown) => {
            log.warn("attach hook failed", { targetId, error: String(err) });
          }),
        );
      }
      if (t.type === "page" || t.type === "iframe") steps.push(send("Target.setAutoAttach", AUTO_ATTACH));
      await Promise.all(steps);
    } finally {
      await send("Runtime.runIfWaitingForDebugger");
      this.ready.add(sessionId);
      const ws = this.waiters.get(targetId);
      this.waiters.delete(targetId);
      for (const w of ws ?? []) w(t);
    }
  }

  private detached(e: CdpEvent): void {
    const sessionId = str(e.params, "sessionId");
    if (sessionId === null) return;
    const t = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    this.ready.delete(sessionId);
    if (t !== undefined) for (const f of [...this.detachListeners]) f(t);
  }
}
