// "Page ready" (docs/07 §1.1): do not trust Page.frameNavigated alone (often
// missing for a new target's first navigation) nor Page.loadEventFired (may fire
// before Page.enable). Ready = the main document's default execution context
// exists (Runtime.executionContextCreated, isDefault, origin matches the target
// URL or the URL the root frame committed), then one evaluate confirms
// `location.href` and `document.readyState`.
//
// ReadyTracker is the pure part (unit tested); waitReady wires it to CDP.

import { isRecord, str } from "../../../shared/json.ts";
import type { CdpEvent, Transport } from "../types.ts";

export type ReadyInput =
  | { kind: "context"; frameId: string | null; origin: string; isDefault: boolean }
  | { kind: "committed"; frameId: string; parentId: string | null; loaderId: string | null; url: string }
  | { kind: "same-document"; frameId: string; url: string };

/** Origin as Chrome reports it in execution contexts; null for opaque URLs. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    return null;
  } catch {
    return null;
  }
}

export class ReadyTracker {
  private committedOrigins = new Set<string | null>();
  private committed = false;
  private sameDocument = false;
  private contextOk = false;
  private loaderId: string | null = null;

  constructor(
    private readonly rootFrameId: string,
    expectedUrl: string | null,
  ) {
    if (expectedUrl !== null) this.committedOrigins.add(originOf(expectedUrl));
  }

  /** The navigation's loaderId once Page.navigate returned it (null = unknown). */
  setLoaderId(id: string | null): void {
    this.loaderId = id;
  }

  get isReady(): boolean {
    return this.contextOk || this.sameDocument;
  }

  feed(ev: ReadyInput): boolean {
    if (ev.kind === "committed") {
      if (ev.parentId !== null || ev.frameId !== this.rootFrameId) return this.isReady;
      if (this.loaderId !== null && ev.loaderId !== null && ev.loaderId !== this.loaderId) return this.isReady;
      this.committed = true;
      this.committedOrigins.add(originOf(ev.url));
    } else if (ev.kind === "same-document") {
      if (ev.frameId === this.rootFrameId) this.sameDocument = true;
    } else if (ev.isDefault && (ev.frameId === null || ev.frameId === this.rootFrameId)) {
      const origin = ev.origin === "" || ev.origin === "null" || ev.origin === "://" ? null : ev.origin;
      // Opaque origins (about:, data:) only count after the root frame committed.
      if (origin === null ? this.committed : this.committedOrigins.has(origin)) this.contextOk = true;
    }
    return this.isReady;
  }
}

/** Translate a CDP event on the tab's session into tracker input (untrusted params). */
export function toReadyInput(e: CdpEvent): ReadyInput | null {
  if (e.method === "Runtime.executionContextCreated") {
    const c = isRecord(e.params["context"]) ? e.params["context"] : null;
    if (c === null) return null;
    const aux = isRecord(c["auxData"]) ? c["auxData"] : {};
    return { kind: "context", frameId: str(aux, "frameId"), origin: str(c, "origin") ?? "", isDefault: aux["isDefault"] === true };
  }
  if (e.method === "Page.frameNavigated") {
    const f = isRecord(e.params["frame"]) ? e.params["frame"] : null;
    const id = f === null ? null : str(f, "id");
    if (f === null || id === null) return null;
    return { kind: "committed", frameId: id, parentId: str(f, "parentId"), loaderId: str(f, "loaderId"), url: str(f, "url") ?? "" };
  }
  if (e.method === "Page.navigatedWithinDocument") {
    const id = str(e.params, "frameId");
    return id === null ? null : { kind: "same-document", frameId: id, url: str(e.params, "url") ?? "" };
  }
  return null;
}

export type ReadyWait = {
  tracker: ReadyTracker;
  /** Resolves true when ready, false on timeout. */
  done(timeoutMs: number): Promise<boolean>;
  cancel(): void;
};

/** Start listening BEFORE triggering the navigation, so no event is missed. */
export function startReadyWait(t: Transport, sessionId: string, rootFrameId: string, expectedUrl: string | null): ReadyWait {
  const tracker = new ReadyTracker(rootFrameId, expectedUrl);
  let wake: (() => void) | null = null;
  const off = t.onEvent((e) => {
    if (e.sessionId !== sessionId) return;
    const input = toReadyInput(e);
    if (input !== null && tracker.feed(input) && wake !== null) wake();
  });
  return {
    tracker,
    done(timeoutMs) {
      if (tracker.isReady) {
        off();
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(false);
        }, timeoutMs);
        wake = () => {
          clearTimeout(timer);
          off();
          resolve(true);
        };
      });
    },
    cancel: () => off(),
  };
}

export type PageState = { href: string; readyState: string; title: string };

const STATE_EXPR = "({href: location.href, readyState: document.readyState, title: document.title})";

/** Evaluate location / readyState; polls until `complete` or `budgetMs` runs out. */
export async function confirmState(t: Transport, sessionId: string, budgetMs: number): Promise<PageState | null> {
  const until = Date.now() + budgetMs;
  let last: PageState | null = null;
  for (;;) {
    const r = await t.send("Runtime.evaluate", { expression: STATE_EXPR, returnByValue: true }, sessionId, 5000).catch(() => null);
    const res = r !== null && isRecord(r["result"]) ? r["result"] : null;
    const v = res !== null && isRecord(res["value"]) ? res["value"] : null;
    if (v !== null) {
      last = { href: str(v, "href") ?? "", readyState: str(v, "readyState") ?? "", title: str(v, "title") ?? "" };
      if (last.readyState === "complete") return last;
    }
    if (Date.now() >= until) return last;
    await Bun.sleep(50);
  }
}
