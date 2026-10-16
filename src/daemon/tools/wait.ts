// tabcap wait --text | --selector | --url | --idle [ms] | --fn   and   tabcap net wait --url [--method]
//
// - text / selector / fn poll the page every 100 ms (Runtime.evaluate, short
//   per-call timeout, so a busy page cannot stall the wait); text is checked
//   in every frame: the main world of the main frame, an isolated world in
//   each same-process iframe, the main world of each out-of-process iframe
//   (docs/08 §5, chrome-devtools-mcp wait_for); `--text` may repeat (any);
// - url is event-driven (root commits and same-document navigations wake it);
// - idle counts the tab's requests in flight from Network events (seeded from
//   the recorder when the session records; otherwise Network is enabled for the
//   duration of the wait and only requests started after that are seen);
// - net wait resolves when the recorder writes a matching request with its
//   body stored (loadingFinished or Fetch-rescued).
// Waits do not hold the tab's command queue. Every timeout is the envelope
// error `timeout` whose `next` names what was still outstanding.

import { BlobStore } from "../../bundle/blobs.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { dialogError, type Tab, type Tabs } from "../browser/targets.ts";
import type { NetEntry } from "../capture/recorder.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optBool, optStr, type Args } from "./args.ts";
import { lookBack, type LookBack } from "./netquery.ts";
import {
  IdleTracker,
  listForHint,
  netMatch,
  parseNetWait,
  parseWait,
  pollExpression,
  POLL_MS,
  readPoll,
  WAIT_MAX_MS,
  waitTimeout,
  type WaitSpec,
} from "./waitspec.ts";

/** Sleep that an event can cut short. */
export class Waker {
  private fn: (() => void) | null = null;

  wake(): void {
    const f = this.fn;
    this.fn = null;
    f?.();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fn = null;
        resolve();
      }, Math.max(0, ms));
      this.fn = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function guard(tab: Tab): void {
  if (tab.closed) throw new TabcapError("no-tab", `tab ${tab.id} was closed while waiting`, "run navigate first: `tabcap navigate <url>`.");
  if (tab.dialog !== null) throw dialogError(tab.dialog, false);
}

const raise = (ms: number) => (ms >= WAIT_MAX_MS ? "" : `, or raise --timeout (max ${WAIT_MAX_MS})`);

function timeoutError(what: string, ms: number, outstanding: string, look: string): TabcapError {
  return new TabcapError("timeout", `${what} did not happen within ${ms} ms`, `Still outstanding: ${outstanding}. ${look}${raise(ms)}.`);
}

/** Network.enable for idle tracking on a session that is not recording; ref-counted. */
const netRefs = new Map<string, number>();

/** A wait on this CDP session has Network enabled for its idle tracking right now. */
export function networkHeldByWait(sid: string): boolean {
  return (netRefs.get(sid) ?? 0) > 0;
}

export async function netOn(t: Transport, sid: string): Promise<void> {
  const n = netRefs.get(sid) ?? 0;
  netRefs.set(sid, n + 1);
  if (n === 0) await t.send("Network.enable", {}, sid, 5000);
}

export async function netOff(d: Daemon, t: Transport, tab: Tab): Promise<void> {
  const n = (netRefs.get(tab.sessionId) ?? 1) - 1;
  if (n > 0) {
    netRefs.set(tab.sessionId, n);
    return;
  }
  netRefs.delete(tab.sessionId);
  // A recording started meanwhile needs Network on, and so does emulated throttling (tools/device.ts); leave it.
  if (d.recorders.has(tab.session) || tab.closed || tab.emulation.networkConditions !== undefined) return;
  await t.send("Network.disable", {}, tab.sessionId, 5000).catch(() => undefined);
}

export async function wait(d: Daemon, a: Args, session: string): Promise<unknown> {
  const spec = parseWait(a);
  const timeoutMs = waitTimeout(a);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  guard(tab);
  const started = Date.now();
  const done = (detail: Record<string, unknown>) => ({ tab: tab.id, matched: spec.kind, ...detail, url: tab.url, waitedMs: Date.now() - started, timeoutMs });
  switch (spec.kind) {
    case "url":
      return done(await waitUrl(tabs, tab, spec.url, started + timeoutMs, timeoutMs));
    case "idle":
      return done(await waitIdle(d, t, tabs, tab, spec.ms, started + timeoutMs, timeoutMs));
    default:
      return done(await waitPoll(t, tab, spec, started + timeoutMs, timeoutMs, new FrameScope(t, tabs, tab)));
  }
}

/** Where to look for text: the tab's frames, each as (CDP session, execution context or the main world). */
export class FrameScope {
  /** `${session}|${frame}|${loader}` → isolated world context id, or null when it cannot be made. */
  private worlds = new Map<string, number | null>();

  constructor(
    private readonly t: Transport,
    private readonly tabs: Tabs,
    private readonly tab: Tab,
  ) {}

  async frames(): Promise<Array<{ sessionId: string; contextId: number | null; frame: string }>> {
    const out: Array<{ sessionId: string; contextId: number | null; frame: string }> = [{ sessionId: this.tab.sessionId, contextId: null, frame: "main" }];
    const oopifs = this.t.targets().filter((x) => x.type === "iframe" && this.tabs.hostOf(x.sessionId) === this.tab);
    for (const sid of [this.tab.sessionId, ...oopifs.map((x) => x.sessionId)]) {
      const r = await this.t.send("Page.getFrameTree", {}, sid, 2000).catch(() => null);
      const tree = r !== null && isRecord(r["frameTree"]) ? r["frameTree"] : null;
      if (tree === null) continue;
      const own = isRecord(tree["frame"]) ? tree["frame"] : null;
      // An out-of-process iframe's own document: its session's main world.
      if (sid !== this.tab.sessionId && own !== null) out.push({ sessionId: sid, contextId: null, frame: str(own, "url") ?? "iframe" });
      for (const f of childFrames(tree)) {
        const id = str(f, "id");
        if (id === null) continue;
        const key = `${sid}|${id}|${str(f, "loaderId") ?? ""}`;
        if (!this.worlds.has(key)) {
          const w = await this.t.send("Page.createIsolatedWorld", { frameId: id, worldName: "tabcap-wait", grantUniveralAccess: false }, sid, 2000).catch(() => null);
          const ctx = w === null ? null : w["executionContextId"];
          this.worlds.set(key, typeof ctx === "number" ? ctx : null);
        }
        const ctx = this.worlds.get(key);
        if (typeof ctx === "number") out.push({ sessionId: sid, contextId: ctx, frame: str(f, "url") ?? "iframe" });
      }
    }
    return out;
  }

  /** A context died (navigation): forget it so the next poll makes a new one. */
  drop(sessionId: string, contextId: number): void {
    for (const [k, v] of this.worlds) if (v === contextId && k.startsWith(`${sessionId}|`)) this.worlds.delete(k);
  }
}

/** Every descendant frame of a Page.getFrameTree node (untrusted JSON). */
function childFrames(node: Record<string, unknown>, depth = 0): Record<string, unknown>[] {
  if (depth > 16 || !Array.isArray(node["childFrames"])) return [];
  return node["childFrames"].filter(isRecord).flatMap((c) => [...(isRecord(c["frame"]) ? [c["frame"]] : []), ...childFrames(c, depth + 1)]);
}

async function waitPoll(t: Transport, tab: Tab, spec: Extract<WaitSpec, { kind: "text" | "selector" | "fn" }>, deadline: number, timeoutMs: number, scope: FrameScope): Promise<Record<string, unknown>> {
  const expression = pollExpression(spec);
  if (spec.kind === "fn") {
    // Syntax errors are permanent: report them now instead of polling to the timeout.
    const c = await t.send("Runtime.compileScript", { expression, sourceURL: "", persistScript: false }, tab.sessionId, 5000);
    const ex = isRecord(c["exceptionDetails"]) ? c["exceptionDetails"] : null;
    if (ex !== null) {
      const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
      throw new TabcapError("usage", `--fn does not parse: ${(str(exc, "description") ?? str(ex, "text") ?? "syntax error").slice(0, 500)}`, "Pass one JavaScript expression, e.g. --fn 'window.app && window.app.ready'.");
    }
  }
  let lastError: string | null = null;
  let polls = 0;
  for (;;) {
    guard(tab);
    const left = deadline - Date.now();
    const targets = spec.kind === "text" ? await scope.frames() : [{ sessionId: tab.sessionId, contextId: null, frame: "main" }];
    polls++;
    for (const f of targets) {
      const r = await t
        .send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(f.contextId === null ? {} : { contextId: f.contextId }) }, f.sessionId, Math.max(200, Math.min(3000, left)))
        .catch((e: unknown) => {
          if (f.frame === "main") lastError = e instanceof Error ? e.message : String(e);
          if (f.contextId !== null) scope.drop(f.sessionId, f.contextId);
          return null;
        });
      if (r === null) continue;
      const ex = isRecord(r["exceptionDetails"]) ? r["exceptionDetails"] : null;
      if (ex !== null) {
        const exc = isRecord(ex["exception"]) ? ex["exception"] : {};
        if (f.frame === "main") lastError = (str(exc, "description") ?? str(ex, "text") ?? "exception").split("\n")[0] ?? "exception";
      } else {
        const res = isRecord(r["result"]) ? r["result"] : {};
        const out = readPoll(spec, res["value"]);
        if (out.state === "matched") return { ...out.detail, ...(spec.kind === "text" ? { frame: f.frame } : {}), polls };
        if (out.state === "invalid") throw new TabcapError("usage", `--selector is not a valid CSS selector: ${out.message.slice(0, 300)}`, "Fix the selector, e.g. --selector '#result .item'.");
        if (f.frame === "main") lastError = null;
      }
    }
    if (Date.now() >= deadline) {
      const what = spec.kind === "text" ? `text ${spec.texts.map((x) => JSON.stringify(x)).join(" or ")}` : spec.kind === "selector" ? `selector ${JSON.stringify(spec.selector)}` : `--fn ${JSON.stringify(spec.expr.slice(0, 120))}`;
      const why = lastError === null ? (spec.kind === "fn" ? "it stayed falsy" : "not on the page") : `last check failed: ${lastError.slice(0, 200)}`;
      throw timeoutError(`wait for ${what}`, timeoutMs, `${what} on ${tab.url} (${why}, ${polls} checks)`, "Look at the page with `tabcap snapshot` or `tabcap screenshot`");
    }
    await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function waitUrl(tabs: Tabs, tab: Tab, sub: string, deadline: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const waker = new Waker();
  const off = tabs.onNav((x) => {
    if (x === tab) waker.wake();
  });
  try {
    for (;;) {
      guard(tab);
      if (tab.url.includes(sub)) return { urlContains: sub };
      const left = deadline - Date.now();
      if (left <= 0) throw timeoutError(`wait for a URL containing ${JSON.stringify(sub)}`, timeoutMs, `a navigation to a URL containing ${JSON.stringify(sub)} (the tab is at ${tab.url})`, "Check the page with `tabcap snapshot`; the action may not have navigated");
      // Root commits and same-document navigations wake us; the tick covers URL changes reported only via targetInfoChanged.
      await waker.sleep(Math.min(POLL_MS, left));
    }
  } finally {
    off();
  }
}

async function waitIdle(d: Daemon, t: Transport, tabs: Tabs, tab: Tab, ms: number, deadline: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const rec = d.recorders.get(tab.session);
  const tracker = new IdleTracker(Date.now());
  const waker = new Waker();
  if (rec !== undefined) for (const q of rec.inflightOf(tab.id)) tracker.begin(q.key, `${q.method} ${q.url}`, q.loaderId);
  const off = t.onEvent((e) => {
    if (e.sessionId === null || tabs.hostOf(e.sessionId) !== tab) return;
    const p = e.params;
    const rid = str(p, "requestId");
    const key = `${e.sessionId}|${rid ?? ""}`;
    if (e.method === "Network.requestWillBeSent" && rid !== null) {
      const req = isRecord(p["request"]) ? p["request"] : {};
      tracker.begin(key, `${str(req, "method") ?? "GET"} ${str(req, "url") ?? ""}`, str(p, "loaderId"));
    } else if ((e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") && rid !== null) {
      tracker.end(key, Date.now());
    } else if (e.method === "Page.frameNavigated" && e.sessionId === tab.sessionId) {
      const f = isRecord(p["frame"]) ? p["frame"] : null;
      if (f !== null && str(f, "parentId") === null) tracker.commit(str(f, "loaderId"), Date.now());
    } else return;
    waker.wake();
  });
  let enabled = false;
  try {
    if (rec === undefined) {
      await netOn(t, tab.sessionId);
      enabled = true;
    }
    for (;;) {
      guard(tab);
      const now = Date.now();
      const quiet = tracker.idleFor(now);
      if (quiet >= ms) return { idleMs: ms, requestsSeen: tracker.seen, tracking: rec !== undefined ? "recording" : "since-wait" };
      const left = deadline - now;
      if (left <= 0) {
        const busy = tracker.outstanding();
        throw timeoutError(
          `wait for ${ms} ms of network idle`,
          timeoutMs,
          busy.length > 0 ? `${busy.length} request(s) in flight: ${listForHint(busy)}` : `a quiet period of ${ms} ms (requests kept starting)`,
          "Long-polling, streaming or EventSource requests never finish; wait for text or a selector instead",
        );
      }
      await waker.sleep(Math.min(POLL_MS, left, tracker.busy > 0 ? POLL_MS : ms - quiet));
    }
  } finally {
    off();
    if (enabled) await netOff(d, t, tab);
  }
}

export async function netWait(d: Daemon, a: Args, session: string): Promise<unknown> {
  const q = parseNetWait(a);
  const timeoutMs = waitTimeout(a);
  const rec = d.recorders.get(session);
  if (rec === undefined) throw new TabcapError("not-found", `session "${session}" is not recording`, "Run `tabcap net start` before the action, then `tabcap net wait --url <substring>`.");
  const tabId = optStr(a, "tab");
  if (tabId !== null) d.need().tabs.pick(session, tabId);
  const started = Date.now();
  const look = lookBack({ sinceArg: optStr(a, "since"), fresh: optBool(a, "fresh"), now: started, recordingStart: rec.startedAt, last: d.lastAction(session), cmdStart: (id) => rec.cmdStarts.get(id) ?? null });
  const store = new BlobStore(rec.dir);
  const result = (e: NetEntry, already: boolean) => ({
    id: e.id,
    tab: e.tab,
    method: e.method,
    url: e.url,
    status: e.status,
    mime: e.mime,
    size: e.size,
    blob: e.blob,
    path: e.blob === null ? null : store.pathOf(e.blob),
    outcome: e.outcome,
    alreadyFinished: already,
    lookBack: { from: look.from, cmd: look.cmd, action: look.action },
    waitedMs: Date.now() - started,
    timeoutMs,
  });
  const fits = (e: NetEntry) => tabId === null || e.tab === tabId;
  const noBody: NetEntry[] = [];
  // A request that finished since the look-back point still counts
  // (`click → wait --text → net wait` must not miss a fast response).
  for (let i = rec.index.length - 1; i >= 0; i--) {
    const e = rec.index[i];
    if (e === undefined || e.at < look.since || !fits(e)) continue;
    const m = netMatch(e, q);
    if (m === "match") return result(e, true);
    if (m === "no-body") noBody.push(e);
  }
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      off();
      clearTimeout(timer);
      clearInterval(watch);
    };
    const off = rec.onIndexed((e) => {
      if (!fits(e)) return;
      const m = netMatch(e, q);
      if (m === "match") {
        cleanup();
        resolve(result(e, false));
      } else if (m === "no-body") noBody.push(e);
    });
    const watch = setInterval(() => {
      if (rec.recording) return;
      cleanup();
      reject(new TabcapError("not-found", `the recording of session "${session}" stopped while waiting`, "Run `tabcap net start` again, repeat the action, then `tabcap net wait`."));
    }, 200);
    const timer = setTimeout(() => {
      cleanup();
      const what = `${q.method ?? "any method"} ${JSON.stringify(q.url)}`;
      const inflight = rec
        .inflightOf(tabId)
        .filter((x) => x.url.includes(q.url) && (q.method === null || x.method.toUpperCase() === q.method))
        .map((x) => `${x.method} ${x.url}`);
      const earlier = rec.index.filter((e) => e.at < look.since && fits(e) && netMatch(e, q) === "match").map((e) => `${e.id} (${e.status ?? "no status"})`);
      const parts = [`a request matching ${what} finishing with a stored body after ${lookLabel(look)}`];
      if (inflight.length > 0) parts.push(`still in flight: ${listForHint(inflight)}`);
      if (noBody.length > 0) parts.push(`matched without a body: ${listForHint(noBody.map((e) => `${e.id} (${e.bodyMissing ?? "no body"})`))}`);
      if (earlier.length > 0) parts.push(`earlier finished matches before that point: ${listForHint(earlier.reverse())} — \`tabcap net show <id>\`, or accept them with --since start`);
      reject(timeoutError(`net wait for ${what}`, timeoutMs, parts.join("; "), "Check `tabcap net list --filter <substring>`; the action may not have sent the request"));
    }, timeoutMs);
  });
}

function lookLabel(l: LookBack): string {
  if (l.from === "action") return `the start of the last action (${l.action ?? "?"}${l.cmd === null ? "" : ` ${l.cmd}`})`;
  if (l.from === "cmd") return `the start of ${l.cmd ?? "?"}`;
  if (l.from === "fresh") return "the wait began (--fresh)";
  return "the start of the recording";
}
