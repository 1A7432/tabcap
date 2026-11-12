// docs/04 §53.7 (11-12): `--wait requests` on the action commands. After the
// post-action wait (navigation + quiet DOM) the command also waits for the XHR /
// fetch requests the tab started since the command began (Network
// requestWillBeSent type XHR or Fetch on the tab's own session: no WebSocket,
// EventSource, Ping, nor requests of workers, which have sessions of their own)
// to end (loadingFinished / loadingFailed). The command's --timeout bounds it and
// running out is not an error: the answer says what is still pending. Without a
// recording Network is switched on for the wait only (the ref-counted switch of
// `wait --idle`). Not a "whole network idle" default: a page with a long poll is
// never idle (the 11-11 report: `wait --idle` timed out on a worker request).

import { TabcapError } from "../../shared/envelope.ts";
import { readActionsConfig } from "../../shared/config.ts";
import { isRecord, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { Tab } from "../browser/targets.ts";
import type { Daemon } from "../state.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";
import { optStr, type Args } from "./args.ts";
import { netOff, netOn } from "./wait.ts";

/** Kept free of the command's own deadline, so the answer still gets out. */
export const REQUEST_WAIT_MARGIN_MS = 1500;
/** How long the recorder gets to write the requests that ended, for their ids. */
export const RECORD_GRACE_MS = 1000;
const MAX_PENDING_SHOWN = 5;

export type RequestWait = { d: Daemon; until: number };

/** What `wait.requests` says: requests that ended, those still pending (at most 5 URLs), and their r-N while recording. */
export type RequestsReport = { finished: number; pending?: string[]; ids?: string[] };

/**
 * `--wait dom|requests` (default: config.json actions.wait, else dom) → the request
 * wait of a command that started at `started`, or null. `--wait` is checked even
 * for commands that skip the wait (--no-wait): a bad value is a usage error.
 */
export function requestWaitOf(d: Daemon, a: Args, started: number, timeoutMs: number): RequestWait | null {
  const flag = optStr(a, "wait");
  if (flag !== null && flag !== "dom" && flag !== "requests") throw new TabcapError("usage", `--wait ${flag}?`, "Use --wait requests (also wait for the requests the command started) or --wait dom (the default).");
  const mode = flag ?? readActionsConfig(d.paths.configFile).wait;
  return mode === "requests" ? { d, until: started + Math.max(0, timeoutMs - REQUEST_WAIT_MARGIN_MS) } : null;
}

/** Pure: is this event the start of a request the wait counts? */
export function countsAsCommandRequest(e: Pick<CdpEvent, "method" | "params">): boolean {
  if (e.method !== "Network.requestWillBeSent") return false;
  const type = str(e.params, "type");
  return type === "XHR" || type === "Fetch";
}

export type RequestTracker = { idle: (until: number) => Promise<RequestsReport>; stop: () => Promise<void> };

/** Start tracking before the action; `idle` waits for the tracked requests, `stop` always runs. */
export async function trackRequests(w: RequestWait, t: Transport, tab: Tab): Promise<RequestTracker> {
  const started = Date.now();
  const inflight = new Map<string, string>();
  const ended: string[] = [];
  const off = t.onEvent((e) => {
    if (e.sessionId !== tab.sessionId) return;
    const id = str(e.params, "requestId");
    if (id === null) return;
    if (countsAsCommandRequest(e)) {
      const req = isRecord(e.params["request"]) ? e.params["request"] : {};
      inflight.set(id, str(req, "url") ?? "");
    } else if ((e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") && inflight.has(id)) {
      ended.push(inflight.get(id) ?? "");
      inflight.delete(id);
    }
  });
  let held = false;
  if (!w.d.recorders.has(tab.session)) {
    try {
      await netOn(t, tab.sessionId);
      held = true;
    } catch (e) {
      log.info("--wait requests: Network.enable failed, requests not watched", { tab: tab.id, error: String(e) });
    }
  }
  const stop = async () => {
    off();
    if (held) {
      held = false;
      await netOff(w.d, t, tab).catch(() => undefined);
    }
  };
  return {
    stop,
    idle: async (until) => {
      while (inflight.size > 0 && Date.now() < until) await Bun.sleep(50);
      const pending = [...inflight.values()].map((u) => w.d.secrets.scrub(u).slice(0, 300));
      await stop();
      const out: RequestsReport = { finished: ended.length, ...(pending.length > 0 ? { pending: pending.slice(0, MAX_PENDING_SHOWN) } : {}) };
      const rec = w.d.recorders.get(tab.session);
      if (rec === undefined || ended.length === 0) return out;
      // Their recorded ids: the tab's requests written since the command began, by URL.
      const ids: string[] = [];
      const deadline = Date.now() + RECORD_GRACE_MS;
      for (;;) {
        ids.length = 0;
        const left = [...ended];
        for (const e of rec.index) {
          if (e.tab !== tab.id || e.at < started) continue;
          const k = left.indexOf(e.url);
          if (k < 0) continue;
          left.splice(k, 1);
          ids.push(e.id);
        }
        if (left.length === 0 || Date.now() >= deadline) break;
        await Bun.sleep(50);
      }
      return { ...out, ids };
    },
  };
}
