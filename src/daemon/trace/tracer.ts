// Trace mode (0.4-F): which page scripts read which browser signals, and from
// where. Read-only, record-only: nothing in the page is modified — no injected
// script, no wrapped getter, no changed value — and no output advises changing
// values. Spec: docs/04 §4.1 `signal`, §7 `mode.trace` / `traceWindows`.
// Oracle / reproduction: the 10-16 spike (CfT 155, NOTES), and the range pages
// of test/e2e/v04f.e2e.test.ts whose expected (api, script, line) pairs are
// literals of the pages themselves.
//
// Mechanism (spike-proven on CfT 155):
// - per CDP session of the trace session's tabs, OOPIFs and dedicated workers:
//   `Debugger.enable`, then (pages and frames) instrumentation breakpoints:
//   `scriptFirstStatement` (installs the API breakpoints of a new realm before
//   its first script runs) plus INSTRUMENTATION_EVENTS (recorded as signals);
// - in the scriptFirstStatement pause, `Debugger.evaluateOnCallFrame` fetches
//   the getter / function of every API (descriptor reads only) and
//   `Debugger.setBreakpointOnFunctionCall` puts one breakpoint on each, then
//   `Debugger.resume`. Same-origin frames in the same process share the
//   breakpoints ("already exists" is fine). `beforeScriptExecution` is never
//   used: commands block in its pause until resume;
// - workers: installed while they wait for the debugger (auto-attach hook);
// - on a pause of ours: resume at once, then aggregate (aggregate.ts);
// - values are read once per document and API in tabcap's isolated world. Blink
//   getters there do not hit main-world breakpoints; JS builtins (Date, Intl)
//   share one breakpoint across all contexts of the process, so pauses whose
//   frames are tabcap's own scripts or isolated-world scripts are not recorded
//   (measured 0.4-F e2e: the value read of getTimezoneOffset paused);
// - while the session waits for the human: `Debugger.setSkipAllPauses`.
// Known gaps: reads issued after a navigation has started are not recorded
// (the old document no longer pauses); Service / Shared Workers are not traced.

import { log } from "../../shared/log.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import type { TraceMode } from "../../bundle/types.ts";
import type { Recorder } from "../capture/recorder.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../transport/types.ts";
import { classifyPause, signalFields, TraceBook, type Aggregate, type BpInfo, type DocRef, type DocSummary, type PauseFrame, type ScriptInfo, type TraceLimits } from "./aggregate.ts";
import { hashBulkData, INSTRUMENTATION_EVENTS, notRecorded, resolverExpression, SCRIPT_FIRST_STATEMENT, VALUE_INLINE_MAX, valueExpression, type SignalList } from "./signals.ts";
import { Armed, attribute, JSON_PARSE_CONDITION, observeRow, OBSERVE_VERSION, PAGE_BY, plaintextOf, PLAINTEXT_CAP, SCOPE_FRAMES, SCOPE_PROPS, sha256Text, SINKS, suspectOf, SUSPECT_WINDOW_MS, TEXT_DECODER_CONDITION, UNATTRIBUTED_CAP, type PageEvidence, type SinkName } from "./observe.ts";
import type { NetEntry } from "../capture/recorder.ts";

export const TRACE_NOTICE = "Trace mode installs debugger breakpoints in the page: scripts run slower and the timing is observable.";
export const TRACE_PAUSED_NOTE = "trace is paused while the session waits for the human (debugger pauses are skipped); `tabcap handoff continue` resumes it";

const GROUP = "tabcap-trace";
const WORLD = "tabcap-trace";
const CMD_MS = 5000;
const VALUE_WAIT_MS = 2000;
const RECENT_DOCS = 50;

/**
 * Page-side, read-only copy of one buffer in a pausing scope (docs/04 §33):
 * the bytes as CSV, "" when over the plaintext cap (evidence only then). The
 * replier is only ever an ArrayBuffer / typed array — a CryptoKey is never
 * passed here. Runs `silent`, touches nothing else.
 */
const BYTES_CSV_FN = `function () {
  const u = this instanceof ArrayBuffer ? new Uint8Array(this) : new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
  return u.byteLength <= ${PLAINTEXT_CAP} ? Array.from(u).join(",") : "";
}`;

type Sess = {
  sid: string;
  target: AttachedTarget | null;
  targetId: string;
  type: "page" | "iframe" | "worker";
  tab: Tab;
  bps: Map<string, BpInfo>;
  apiBp: Map<string, string>;
  contexts: Map<number, { frameId: string | null; origin: string | null; isDefault: boolean }>;
  installed: Set<number>;
  scripts: Map<string, ScriptInfo>;
  tabcapScripts: Set<string>;
  internalScripts: Set<string>;
  evalDepth: number;
  internalDepth: number;
  /** 0.6-L: bpId -> sink of the observe breakpoints this target carries (one per realm). */
  sinkBps: Map<string, SinkName>;
};

type ValueOut = { present: false } | { present: true; text: string };

/** CDP monotonic clock (ms) estimated from CDP events that carry one: offset = cdp - local, the largest seen (least delayed). */
export class MonoClock {
  private offset: number | null = null;
  constructor(private readonly local: () => number = () => performance.now()) {}
  observe(cdpSeconds: number): void {
    const o = cdpSeconds * 1000 - this.local();
    if (this.offset === null || o > this.offset) this.offset = o;
  }
  now(): number | null {
    return this.offset === null ? null : Math.round((this.local() + this.offset) * 1000) / 1000;
  }
}

const CLOCKED = new Set(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.dataReceived", "Page.loadEventFired", "Page.domContentEventFired"]);

export type TracerOptions = {
  session: string;
  t: Transport;
  tabs: Tabs;
  list: SignalList;
  limits: TraceLimits;
  /** The session's recording now (it may change while tracing). */
  recorder: () => Recorder | undefined;
  /** Known-secret replacement for page-provided text. */
  scrub: (s: string) => string;
  /** Start paused (the session already waits for the human). */
  paused: boolean;
  /** 0.6-L observe mode: arm the decode sinks on encrypted responses. */
  decode: boolean;
};

export class Tracer {
  readonly session: string;
  readonly list: SignalList;
  readonly limits: TraceLimits;
  readonly startedAt = Date.now();
  private readonly t: Transport;
  private readonly tabs: Tabs;
  private readonly opts: TracerOptions;
  private readonly book: TraceBook;
  private readonly clock = new MonoClock();
  private sessions = new Map<string, Sess>();
  private docs = new Map<string, DocRef>();
  private values = new Map<string, Map<string, Promise<ValueOut>>>();
  private valueWritten = new Map<string, Set<string>>();
  private worlds = new Map<string, number>();
  private recent: DocSummary[] = [];
  private active = new Set<string>();
  private skippedWindow = new Map<string, string>();
  private skippedWorker = new Map<string, string>();
  private offs: Array<() => void> = [];
  private recOff: { rec: Recorder; off: () => void } | null = null;
  private indexOff: (() => void) | null = null;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;
  paused: boolean;
  /** Reads counted while tracing (all documents, all sessions). */
  hits = 0;

  // ------------------------------------------------------------ observe (0.6-L)

  /** Suspects inside their arming window (docs/04 §33). */
  private readonly armed = new Armed();
  /** Sinks up on every target while decode is on (design fix 10-16, NOTES). */
  private sinksOn = false;
  private pendingSinks: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private unattributedKept = 0;
  private attributedRows = 0;
  private unattributedRows = 0;
  private evidenceHits = 0;
  private sinksInstalled = 0;
  private sinksSkipped = 0;
  private drops = { plaintextMissing: 0, tooLarge: 0, afterStop: 0, unattributedCapped: 0 };
  /**
   * JSON.parse pauses whose plaintext was walked while no suspect was armed
   * yet: a page can decrypt and parse in the same microtask burst the
   * recorder's index push (the arm) is still a few ms away from (s59 xor,
   * spike: the plaintext pause lost the race). Held for `HOLD_MS` and matched
   * as soon as a suspect is armed; the attribution rules are unchanged —
   * only the timing gap is bridged.
   */
  private held: Array<{ scopeShas: string[]; strings: string[]; byteCsvs: string[]; evFrames: PageEvidence["frames"]; at: number }> = [];
  private static readonly HOLD_MS = 10_000;
  private static readonly HOLD_MAX = 8;

  private constructor(o: TracerOptions) {
    this.opts = o;
    this.session = o.session;
    this.t = o.t;
    this.tabs = o.tabs;
    this.list = o.list;
    this.limits = o.limits;
    this.paused = o.paused;
    this.book = new TraceBook(o.limits);
  }

  get mode(): TraceMode {
    return { mechanism: ["fn-breakpoint", "instrumentation"], apis: this.list.hash, stack: this.limits.stack, firstN: this.limits.firstN, maxHits: this.limits.maxHits, ...(this.opts.decode ? { decode: true } : {}) };
  }

  static async start(o: TracerOptions): Promise<Tracer> {
    const tr = new Tracer(o);
    tr.offs.push(
      o.t.onEvent((e) => tr.onEvent(e)),
      o.t.onAttach((x) => tr.onAttach(x)),
      o.t.onDetach((x) => tr.onDetach(x)),
      o.tabs.onTabAdded((tab) => (tab.session === o.session ? tr.enable(tab.sessionId, null, tab.targetId, "page", tab, false) : Promise.resolve())),
    );
    const rec = o.recorder();
    if (rec !== undefined) tr.attachRecorder(rec);
    for (const tab of o.tabs.sessionTabs(o.session)) {
      await tr.enable(tab.sessionId, null, tab.targetId, "page", tab, true);
      for (const child of o.t.targets()) {
        if (child.type !== "iframe" && child.type !== "worker") continue;
        if (child.parentSessionId === null || o.tabs.hostOf(child.parentSessionId)?.id !== tab.id) continue;
        await tr.enable(child.sessionId, child, child.targetId, child.type, tab, true);
      }
    }
    // 0.6-L: with decode on the sinks go up now — a realm's first script runs
    // after its scriptFirstStatement pause has installed them (0.4-F), which
    // is what beats the page to its own first decrypt (NOTES 10-16).
    if (o.decode) tr.ensureSinks();
    return tr;
  }

  /** A recording of the session started (or was there at trace start): open a trace window in it. */
  attachRecorder(rec: Recorder): void {
    if (this.stopped || this.recOff?.rec === rec) return;
    this.recOff?.off();
    this.indexOff?.();
    this.indexOff = null;
    rec.traceOpen(this.mode, `trace window opened: signal reads are recorded (${this.list.names.length} APIs from ${this.list.source}, stack ${this.limits.stack}, firstN ${this.limits.firstN}, maxHits ${this.limits.maxHits})`);
    if (this.paused) rec.event("note", { text: `trace paused: ${TRACE_PAUSED_NOTE}`, refs: [] });
    this.recOff = { rec, off: rec.beforeStop(() => this.flushInto(rec)) };
    // 0.6-L: every finished response body is a suspect candidate while the
    // recording lives; watch the recorder's index push.
    if (this.opts.decode) {
      this.indexOff = rec.onIndexed((e) => this.onEntryIndexed(e));
      // A new recording after a stop: the sinks come back up right away.
      this.ensureSinks();
    }
  }

  // ------------------------------------------------------------ sessions

  private async enable(sid: string, target: AttachedTarget | null, targetId: string, type: Sess["type"], tab: Tab, installNow: boolean): Promise<void> {
    if (this.stopped || this.sessions.has(sid)) return;
    const st: Sess = {
      sid,
      target,
      targetId,
      type,
      tab,
      bps: new Map(),
      apiBp: new Map(),
      contexts: new Map(),
      installed: new Set(),
      scripts: new Map(),
      tabcapScripts: new Set(),
      internalScripts: new Set(),
      evalDepth: 0,
      internalDepth: 0,
      sinkBps: new Map(),
    };
    this.sessions.set(sid, st);
    try {
      await this.t.send("Debugger.enable", {}, sid, CMD_MS);
      if (type !== "worker") {
        for (const name of [SCRIPT_FIRST_STATEMENT, ...INSTRUMENTATION_EVENTS]) await this.t.send("EventBreakpoints.setInstrumentationBreakpoint", { eventName: name }, sid, CMD_MS);
      }
      if (this.paused) await this.t.send("Debugger.setSkipAllPauses", { skip: true }, sid, CMD_MS);
      // Workers are installed while they wait for the debugger (before their first
      // statement); running documents at trace start get their breakpoints now.
      if (type === "worker" || installNow) await this.install(st, null);
      // 0.6-L: a sink breakpoint resolves on the realm's own JSON.parse etc.,
      // and JS built-ins do not share one breakpoint across a target's realms:
      // each realm installs its own — at this target's first statement pause
      // (pages), here on attach (workers). A same-process repeat that reaches
      // `installSinks` anyway fails "already exists" and is tolerated.
      if (this.opts.decode && type === "worker") await this.installSinks(st, null);
    } catch (e) {
      log.warn("trace: enabling a target failed", { type, error: String(e) });
    }
  }

  private async onAttach(x: AttachedTarget): Promise<void> {
    if (this.stopped || x.parentSessionId === null || (x.type !== "iframe" && x.type !== "worker")) return;
    const host = this.tabs.hostOf(x.parentSessionId);
    if (host === undefined || host.session !== this.session) return;
    await this.enable(x.sessionId, x, x.targetId, x.type, host, false);
  }

  private onDetach(x: AttachedTarget): void {
    const st = this.sessions.get(x.sessionId);
    if (st === undefined) return;
    for (const key of this.book.docKeys(st.sid)) this.finishDoc(key);
    this.sessions.delete(x.sessionId);
  }

  /** Mark a tabcap `evaluate` in flight on a target: reads it triggers get `caller.kind: "tabcap"`. */
  async markEval<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const st = this.sessions.get(sessionId);
    if (st === undefined) return fn();
    st.evalDepth++;
    try {
      return await fn();
    } finally {
      st.evalDepth--;
    }
  }

  // ------------------------------------------------------------ events

  private onEvent(e: CdpEvent): void {
    if (this.stopped) return;
    if (CLOCKED.has(e.method)) {
      const ts = num(e.params, "timestamp");
      if (ts !== null) this.clock.observe(ts);
    }
    if (e.sessionId === null) return;
    const st = this.sessions.get(e.sessionId);
    if (st === undefined) return;
    const p = e.params;
    switch (e.method) {
      case "Debugger.paused":
        this.onPaused(st, p);
        return;
      case "Debugger.scriptParsed": {
        const id = str(p, "scriptId");
        if (id === null) return;
        const aux = isRecord(p["executionContextAuxData"]) ? p["executionContextAuxData"] : null;
        const url = str(p, "url") ?? "";
        st.scripts.set(id, { url, ctx: num(p, "executionContextId"), frameId: aux === null ? null : str(aux, "frameId"), isDefault: aux === null ? null : aux["isDefault"] === true });
        if (url === "" && st.internalDepth > 0) st.internalScripts.add(id);
        else if (url === "" && st.evalDepth > 0) st.tabcapScripts.add(id);
        return;
      }
      case "Runtime.executionContextCreated": {
        const c = isRecord(p["context"]) ? p["context"] : null;
        const id = c === null ? null : num(c, "id");
        if (c === null || id === null) return;
        const aux = isRecord(c["auxData"]) ? c["auxData"] : null;
        st.contexts.set(id, { frameId: aux === null ? null : str(aux, "frameId"), origin: str(c, "origin"), isDefault: aux !== null && aux["isDefault"] === true });
        return;
      }
      case "Runtime.executionContextDestroyed": {
        const id = num(p, "executionContextId");
        if (id !== null) this.contextGone(st, id);
        return;
      }
      case "Runtime.executionContextsCleared":
        for (const id of [...new Set([...st.contexts.keys(), ...st.installed])]) this.contextGone(st, id);
        for (const key of this.book.docKeys(st.sid)) this.finishDoc(key);
        return;
    }
  }

  private contextGone(st: Sess, ctx: number): void {
    st.contexts.delete(ctx);
    st.installed.delete(ctx);
    for (const [id, s] of st.scripts) {
      if (s.ctx !== ctx) continue;
      st.scripts.delete(id);
      st.tabcapScripts.delete(id);
      st.internalScripts.delete(id);
    }
    this.finishDoc(`${st.sid}:${ctx}`);
  }

  private resume(sid: string): void {
    // After a navigation the pause is gone already ("Can only perform operation while paused"): fine.
    void this.t.send("Debugger.resume", {}, sid, CMD_MS).catch(() => undefined);
  }

  private onPaused(st: Sess, params: Record<string, unknown>): void {
    // 0.6-L: a pause that hits an observe sink is decided by the observe path
    // (it needs the pausing call frames); every other pause as before.
    const hitIds = Array.isArray(params["hitBreakpoints"]) ? params["hitBreakpoints"].filter((x): x is string => typeof x === "string") : [];
    for (const id of hitIds) {
      const sink = st.sinkBps.get(id);
      if (sink !== undefined) {
        void this.onSinkPause(st, params, sink);
        return;
      }
    }
    const pause = classifyPause(params, st.bps, (id) => st.scripts.get(id));
    if (pause.kind === "install") {
      void this.installInPause(st, pause.frame);
      return;
    }
    this.resume(st.sid);
    if (pause.kind === "other") return;
    const frames = pause.frames;
    // The tracer's own code (install, value reads), and anything running in an
    // isolated world (tabcap's own tools): JS builtins such as
    // Date.prototype.getTimezoneOffset share one breakpoint across every
    // context of the process, isolated worlds included.
    if (frames.some((f) => st.internalScripts.has(f.scriptId) || st.scripts.get(f.scriptId)?.isDefault === false)) return;
    const top = frames[0];
    if (top === undefined) return;
    const doc = this.docOf(st, top);
    const callerKind = frames.some((f) => st.tabcapScripts.has(f.scriptId)) ? "tabcap" : "page";
    const mono = this.clock.now();
    const hits = pause.kind === "event" ? [{ api: pause.api, access: "event" as const, args: pause.args, bpId: null }] : pause.hits.map((h) => ({ api: h.info.api, access: h.info.access, args: null, bpId: h.bpId }));
    for (const h of hits) {
      const r = this.book.record({ doc, api: h.api, access: h.access, args: h.args, frames, callerKind, mono });
      if (!r.counted) continue;
      this.hits++;
      if (r.firstOfApi) this.scheduleValue(st, doc, h.api);
      if (r.truncateNow && h.bpId !== null) this.removeBp(st, h.bpId);
    }
  }

  private docOf(st: Sess, top: PauseFrame): DocRef {
    const info = st.scripts.get(top.scriptId);
    const ctx = info?.ctx ?? null;
    const key = `${st.sid}:${ctx === null ? "?" : ctx}`;
    const have = this.docs.get(key);
    if (have !== undefined) return have;
    const worker = st.type === "worker";
    const frameId = info?.frameId ?? (ctx === null ? null : (st.contexts.get(ctx)?.frameId ?? null)) ?? (st.type === "iframe" ? st.targetId : null);
    const frame = worker ? null : frameId === null || frameId === st.tab.targetId ? "root" : frameId;
    const url = worker || st.type === "iframe" ? (st.target?.url ?? null) : frame === "root" ? st.tab.url : (ctx === null ? null : (st.contexts.get(ctx)?.origin ?? null));
    const ref: DocRef = { key, sessionId: st.sid, tab: st.tab.id, frame, nav: this.opts.recorder()?.navId(st.tab.id) ?? null, url, realm: worker ? "worker" : "window" };
    this.docs.set(key, ref);
    return ref;
  }

  // ------------------------------------------------------------ observe (0.6-L, docs/04 §33)

  /** A finished response was stored: arm its body when it looks like ciphertext (D3). */
  private onEntryIndexed(e: NetEntry): void {
    if (!this.opts.decode || this.stopped) return;
    this.armed.expire(Date.now());
    // A body the decode plugin already turned into a view has nothing to observe.
    if (e.outcome !== "finished" || e.blob === null || e.decoded !== undefined) return;
    const bytes = this.opts.recorder()?.readBlob(e.blob) ?? null;
    if (bytes === null || bytes.length === 0) return;
    const text = Buffer.from(bytes).toString("utf8");
    const s = suspectOf(bytes, text);
    if (s === null) return;
    const shas = [...(s.candidates.whole !== null ? [s.candidates.whole] : []), ...s.candidates.leaves];
    if (shas.length === 0) return;
    this.armed.arm({ request: e.id, url: e.url, at: e.at, shas });
    this.sweepLater(SUSPECT_WINDOW_MS + 50);
    this.ensureSinks();
    // The arm may decide a hold (a pause that won the microtask race).
    void this.matchHeld();
  }

  /** With decode on, the sinks are wanted on every target for as long as the
 * tracer runs (design fix 10-16, NOTES: arming from the index push loses the
 * race with the page's own first decrypt). Sets the intent; `enable` /
 * `install` put them on each target (including realms born later), the
 * per-target `sinksTried` keeps the repeats out. */
  private ensureSinks(): void {
    if (!this.opts.decode || this.sinksOn || this.stopped) return;
    this.sinksOn = true;
  }

  /** Expire the armed list: the suspects that no longer have a window.
   * The sinks stay up while decode is on (design fix 10-16, NOTES): arming
   * from the index push loses the race with the page's own first decrypt —
   * a scriptFirstStatement install wins it, the armed list only attributes. */
  private sweep(): void {
    if (this.stopped) return;
    this.armed.expire(Date.now());
    const live = this.armed.live();
    if (live.length === 0) return;
    const next = Math.min(...live.map((x) => x.expiresAt)) - Date.now();
    this.sweepLater(Math.max(next, 0) + 50);
  }

  private sweepLater(ms: number): void {
    if (this.stopped || this.sweepTimer !== null) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweep();
    }, ms);
  }

  /** Serialize sink teardown (the serial write queue pattern of 0.4-F). */
  private removeSinks(reason: string): Promise<void> {
    const job = this.pendingSinks.then(async () => {
      if (!this.sinksOn || this.stopped) return;
      this.sinksOn = false;
      await Promise.all(
        [...this.sessions.values()].map(async (st) => {
          for (const id of [...st.sinkBps.keys()]) {
            st.sinkBps.delete(id);
            await this.t.send("Debugger.removeBreakpoint", { breakpointId: id }, st.sid, CMD_MS).catch(() => undefined);
          }
        }),
      );
    });
    this.pendingSinks = job.catch((e: unknown) => log.debug("trace: removing sinks failed", { reason, error: String(e) }));
    return this.pendingSinks;
  }

  /**
   * One breakpoint per sink on this target: JSON.parse and TextDecoder gated
   * by their argument conditions (heavy pages parsing / decoding every few
   * bytes must not pause, and the plaintext itself is never that short;
   * SubtleCrypto.decrypt is rare enough without one). A repeat "already
   * exists" — this realm's process shares the JS built-in breakpoint another
   * session installed (0.4-F) — is tolerated; the target is not retried per
   * realm while the sinks stay up.
   */
  private async installSinks(st: Sess, callFrameId: string | null): Promise<void> {
    if (!this.opts.decode || !this.sinksOn || this.stopped) return;
    for (const sink of SINKS) {
      try {
        st.internalDepth++;
        let r: Record<string, unknown>;
        try {
          r =
            callFrameId === null
              ? await this.t.send("Runtime.evaluate", { expression: sink, silent: true }, st.sid, CMD_MS)
              : await this.t.send("Debugger.evaluateOnCallFrame", { callFrameId, expression: sink, silent: true }, st.sid, CMD_MS);
        } finally {
          st.internalDepth--;
        }
        const objectId = isRecord(r["result"]) ? str(r["result"], "objectId") : null;
        if (objectId === null) {
          this.sinksSkipped++;
          continue;
        }
        const condition = sink === "JSON.parse" ? JSON_PARSE_CONDITION : sink === "TextDecoder.prototype.decode" ? TEXT_DECODER_CONDITION : null;
        const bp = await this.t.send("Debugger.setBreakpointOnFunctionCall", { objectId, ...(condition === null ? {} : { condition }) }, st.sid, CMD_MS);
        const id = str(bp, "breakpointId");
        if (id === null) {
          this.sinksSkipped++;
          continue;
        }
        st.sinkBps.set(id, sink);
        this.sinksInstalled++;
        await this.t.send("Runtime.releaseObject", { objectId }, st.sid, CMD_MS).catch(() => undefined);
      } catch (e) {
        // "Breakpoint at specified location already exists." — this realm's
        // process shares the JS built-in breakpoint another session installed
        // (0.4-F); anything else is worth a look.
        log.debug("trace: sink install failed", { sink, target: st.type, error: String(e) });
      }
    }
  }

  /**
   * A hit of an observe sink. Function-call breakpoints see no callee frame
   * (spike exp4: `data:null`, the caller's `arguments` are its own), so the
   * row is built from the caller scopes; the evidence sinks are counted,
   * nothing more (D1). Every exit resumes.
   */
  private async onSinkPause(st: Sess, params: Record<string, unknown>, sink: SinkName): Promise<void> {
    try {
      if (this.stopped) return;
      log.debug("observe: sink pause", { sink, frames: Array.isArray(params["callFrames"]) ? params["callFrames"].length : 0 });
      const frames = (Array.isArray(params["callFrames"]) ? params["callFrames"] : []).filter(isRecord);
      // tabcap's own evaluations and anything in an isolated world: JS builtins
      // share one breakpoint across all contexts of the process (0.4-F measured).
      if (
        frames.length === 0 ||
        frames.some((f) => {
          const id = str(f, "scriptId") ?? "";
          return st.tabcapScripts.has(id) || st.internalScripts.has(id) || (st.scripts.get(id)?.isDefault === false);
        })
      )
        return;
      if (sink !== "JSON.parse") {
        this.evidenceHits++;
        return;
      }
      this.armed.expire(Date.now());
      const rec = this.opts.recorder();
      if (rec === undefined || !rec.recording) {
        this.drops.afterStop++;
        return;
      }
      // The walk must happen inside the pause whatever the armed list says:
      // a page that decrypts and parses in the same microtask burst as its
      // fetch is ahead of the recorder's arm (the index push) — the walked
      // result is held and matched as soon as a suspect is armed.
      const w = await this.walkScopes(st, frames);
      const live = this.armed.live();
      if (live.length === 0) {
        if (this.held.length >= Tracer.HOLD_MAX) this.held.shift();
        this.held.push({ scopeShas: w.scopeShas, strings: w.strings, byteCsvs: w.byteCsvs, evFrames: w.evFrames, at: Date.now() });
        return;
      }
      const attribution = attribute(live, w.scopeShas);
      log.debug("observe: paused", { sink, frames: frames.length, strings: w.strings.length, byteBuffers: w.byteCsvs.length, shas: w.scopeShas.length, attribution: attribution.kind, live: live.length });
      const plaintext = plaintextOf(w.strings, w.byteCsvs);
      const now = Date.now();
      const decided = observeRow({ attribution, scopeShas: w.scopeShas, frames: w.evFrames, plaintext, now, sink }, this.unattributedKept);
      if (!("row" in decided)) {
        if (decided.skip === "plaintext-missing") this.drops.plaintextMissing++;
        else if (decided.skip === "plaintext-too-large") this.drops.tooLarge++;
        else this.drops.unattributedCapped++;
        return;
      }
      await this.fileDecidedRow(decided.row, now);
    } catch (e) {
      log.debug("trace: observe pause failed", { error: String(e) });
    } finally {
      this.resume(st.sid);
    }
  }

  /** Store the plaintext blob, append the sidecar line; the counters say why not. */
  private async fileDecidedRow(row: { request: string | null; direction: "response"; mime: string; text: string; evidence: PageEvidence }, at: number): Promise<void> {
    const rec = this.opts.recorder();
    if (rec === undefined || !rec.recording) {
      this.drops.afterStop++;
      return;
    }
    const put = await rec.putText(row.text);
    if (put === null) {
      this.drops.plaintextMissing++;
      return;
    }
    const view: Record<string, unknown> = { by: PAGE_BY, version: OBSERVE_VERSION, direction: row.direction, mime: row.mime, blob: put.blob, bytes: put.size, ok: true, evidence: row.evidence };
    if ((await rec.appendDecodedSidecar(row.request, view, at)) === null) {
      this.drops.afterStop++;
      return;
    }
    if (row.request === null) {
      this.unattributedRows++;
      this.unattributedKept++;
    } else {
      this.attributedRows++;
      // The request has its plaintext row: later pauses must not duplicate it.
      this.armed.forget(row.request);
    }
  }

  /**
   * A suspect was armed: match the held pauses (docs/04 §33 arm race — the
   * page's own microtask burst wins the first parse; the arm follows and the
   * walked pause is decided then). The attribution rules are unchanged.
   */
  private async matchHeld(): Promise<void> {
    if (this.held.length === 0 || this.stopped) return;
    const now = Date.now();
    this.held = this.held.filter((h) => h.at > now - Tracer.HOLD_MS);
    if (this.held.length === 0) return;
    this.armed.expire(now);
    const live = this.armed.live();
    if (live.length === 0) return;
    const rec = this.opts.recorder();
    if (rec === undefined || !rec.recording) return;
    for (const h of [...this.held]) {
      const attribution = attribute(live, h.scopeShas);
      // No live suspect for this pause: keep it held for a later arm.
      if (attribution.kind === "armed-empty") continue;
      const plaintext = plaintextOf(h.strings, h.byteCsvs);
      const decided = observeRow({ attribution, scopeShas: h.scopeShas, frames: h.evFrames, plaintext, now: h.at, sink: "JSON.parse" }, this.unattributedKept);
      if (!("row" in decided)) {
        if (decided.skip === "plaintext-missing") this.drops.plaintextMissing++;
        else if (decided.skip === "plaintext-too-large") this.drops.tooLarge++;
        else this.drops.unattributedCapped++;
        this.held = this.held.filter((x) => x !== h);
        continue;
      }
      await this.fileDecidedRow(decided.row, h.at);
      this.held = this.held.filter((x) => x !== h);
      this.armed.expire(Date.now());
    }
  }

  /**
   * Read-only walk of the pausing frames' scopes (docs/04 §33): every string
   * value long enough to be a ciphertext leaf (hashed — the scope-string
   * attribution), every ArrayBuffer / typed array copied as CSV through its
   * objectId, never a CryptoKey, and the caller frames for the evidence.
   */
  private async walkScopes(st: Sess, frames: readonly Record<string, unknown>[]): Promise<{ scopeShas: string[]; strings: string[]; byteCsvs: string[]; evFrames: PageEvidence["frames"] }> {
    const scopeShas: string[] = [];
    const strings: string[] = [];
    const byteCsvs: string[] = [];
    const evFrames: PageEvidence["frames"] = [];
    for (const f of frames.slice(0, SCOPE_FRAMES)) {
      const info = st.scripts.get(str(f, "scriptId") ?? "");
      const loc = isRecord(f["location"]) ? f["location"] : null;
      if (evFrames.length < 5) {
        evFrames.push({ url: info?.url ?? "", line: loc === null ? 0 : (num(loc, "lineNumber") ?? 0), column: loc === null ? 0 : (num(loc, "columnNumber") ?? 0), function: str(f, "functionName") || "(anonymous)" });
      }
      const callFrameId = str(f, "callFrameId");
      if (callFrameId === null) continue;
      const scopes = Array.isArray(f["scopeChain"]) ? f["scopeChain"].filter(isRecord) : [];
      for (const s of scopes) {
        const type = str(s, "type");
        if (type !== "local" && type !== "closure") continue;
        const obj = isRecord(s["object"]) ? s["object"] : null;
        const scopeId = obj === null ? null : str(obj, "objectId");
        if (scopeId === null) continue;
        const props = await this.t.send("Runtime.getProperties", { objectId: scopeId, ownProperties: true }, st.sid, CMD_MS);
        const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
        for (const p of list.slice(0, SCOPE_PROPS)) {
          const v = isRecord(p["value"]) ? p["value"] : null;
          if (v === null) continue;
          const kind = str(v, "type");
          if (kind === "string" && typeof v["value"] === "string") {
            const sv = v["value"] as string;
            if (sv.length < 16) continue;
            strings.push(sv);
            scopeShas.push(sha256Text(sv));
          } else if (kind === "object") {
            const sub = str(v, "subtype");
            if (sub !== "arraybuffer" && sub !== "typedarray") continue;
            const oid = str(v, "objectId");
            if (oid === null) continue;
            st.internalDepth++;
            let out: Record<string, unknown>;
            try {
              out = await this.t.send("Runtime.callFunctionOn", { objectId: oid, functionDeclaration: BYTES_CSV_FN, returnByValue: true, silent: true }, st.sid, CMD_MS);
            } finally {
              st.internalDepth--;
            }
            const res = isRecord(out["result"]) ? out["result"] : null;
            if (res !== null && typeof res["value"] === "string" && (res["value"] as string).length > 0) byteCsvs.push(res["value"] as string);
          }
        }
      }
    }
    return { scopeShas, strings, byteCsvs, evFrames };
  }

  // ------------------------------------------------------------ install

  private async installInPause(st: Sess, frame: PauseFrame | null): Promise<void> {
    try {
      const info = frame === null ? undefined : st.scripts.get(frame.scriptId);
      const ctx = info?.ctx ?? null;
      if (frame !== null && frame.callFrameId !== null && ctx !== null && info?.isDefault !== false && !st.installed.has(ctx)) {
        st.installed.add(ctx);
        await this.install(st, frame.callFrameId);
      }
    } catch (e) {
      log.debug("trace: install in pause failed", { error: String(e) });
    } finally {
      this.resume(st.sid);
    }
  }

  /**
   * Put one function-call breakpoint on every API of the list in a realm:
   * the paused frame's realm (callFrameId), else the target's default context.
   */
  private async install(st: Sess, callFrameId: string | null): Promise<void> {
    const expression = resolverExpression(this.list.names);
    let res: Record<string, unknown>;
    st.internalDepth++;
    try {
      res =
        callFrameId === null
          ? await this.t.send("Runtime.evaluate", { expression, objectGroup: GROUP, silent: true }, st.sid, CMD_MS)
          : await this.t.send("Debugger.evaluateOnCallFrame", { callFrameId, expression, objectGroup: GROUP, silent: true }, st.sid, CMD_MS);
    } finally {
      st.internalDepth--;
    }
    const obj = isRecord(res["result"]) ? res["result"] : null;
    const arrId = obj === null ? null : str(obj, "objectId");
    if (arrId === null) return;
    try {
      const props = await this.t.send("Runtime.getProperties", { objectId: arrId, ownProperties: true }, st.sid, CMD_MS);
      const byIndex = new Map<number, Record<string, unknown>>();
      for (const p of Array.isArray(props["result"]) ? props["result"].filter(isRecord) : []) {
        const name = str(p, "name");
        const v = isRecord(p["value"]) ? p["value"] : null;
        if (name !== null && /^\d+$/.test(name) && v !== null) byIndex.set(Number(name), v);
      }
      const jobs: Array<Promise<void>> = [];
      for (let i = 0; i < this.list.names.length; i++) {
        const requested = this.list.names[i] ?? "";
        const fn = byIndex.get(3 * i);
        const kind = byIndex.get(3 * i + 1)?.["value"];
        const resolved = byIndex.get(3 * i + 2)?.["value"];
        const api = typeof resolved === "string" ? resolved : requested;
        const fnId = fn === undefined ? null : str(fn, "objectId");
        if (fnId === null || (kind !== "get" && kind !== "call")) {
          this.noteSkipped(st.type === "worker", requested, typeof kind === "string" ? kind : "missing");
          continue;
        }
        this.active.add(api);
        jobs.push(this.setBp(st, fnId, { api, access: kind }));
      }
      await Promise.all(jobs);
      // 0.6-L: with decode on, every install of this target brings the sinks
      // (sinksTried guards the repeat); a realm born now gets them before its
      // first script runs — what beats the page to its own first decrypt.
      if (this.opts.decode) await this.installSinks(st, callFrameId);
    } finally {
      await this.t.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, st.sid, CMD_MS).catch(() => undefined);
    }
  }

  private async setBp(st: Sess, objectId: string, info: BpInfo): Promise<void> {
    try {
      const r = await this.t.send("Debugger.setBreakpointOnFunctionCall", { objectId }, st.sid, CMD_MS);
      const id = str(r, "breakpointId");
      if (id === null) return;
      st.bps.set(id, info);
      st.apiBp.set(info.api, id);
    } catch {
      // "Breakpoint at specified location already exists.": a realm of the same
      // process (same-origin frame) shares the breakpoint installed before.
    }
  }

  private removeBp(st: Sess, bpId: string): void {
    const info = st.bps.get(bpId);
    st.bps.delete(bpId);
    if (info !== undefined && st.apiBp.get(info.api) === bpId) st.apiBp.delete(info.api);
    void this.t.send("Debugger.removeBreakpoint", { breakpointId: bpId }, st.sid, CMD_MS).catch(() => undefined);
  }

  private noteSkipped(worker: boolean, api: string, reason: string): void {
    const why =
      reason === "missing" && api === "Window.prototype.devicePixelRatio"
        ? "no getter on the prototype chain (window.devicePixelRatio is an own accessor of the global object), not traced"
        : reason === "missing"
          ? "not present in this browser"
          : reason;
    (worker ? this.skippedWorker : this.skippedWindow).set(api, why);
  }

  // ------------------------------------------------------------ values

  private scheduleValue(st: Sess, doc: DocRef, api: string): void {
    let per = this.values.get(doc.key);
    if (per === undefined) {
      per = new Map();
      this.values.set(doc.key, per);
    }
    if (per.has(api)) return;
    if (notRecorded(api)) {
      per.set(api, Promise.resolve({ present: true, text: JSON.stringify("<not-recorded>") }));
      return;
    }
    const expr = doc.realm === "window" ? valueExpression(api) : null;
    if (expr === null) return;
    const frameId = doc.frame === "root" ? st.tab.targetId : doc.frame;
    if (frameId === null) return;
    const p = this.readValue(st, doc, frameId, expr);
    per.set(api, p);
  }

  /** Evaluate in tabcap's isolated world of the frame (unaffected by main-world breakpoints). */
  private async readValue(st: Sess, doc: DocRef, frameId: string, expr: string): Promise<ValueOut> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let ctx = this.worlds.get(doc.key);
        if (ctx === undefined || attempt > 0) {
          const w = await this.t.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false }, st.sid, CMD_MS);
          const id = num(w, "executionContextId");
          if (id === null) return { present: false };
          ctx = id;
          this.worlds.set(doc.key, id);
        }
        st.internalDepth++;
        let r: Record<string, unknown>;
        try {
          r = await this.t.send("Runtime.evaluate", { expression: `JSON.stringify(${expr})`, contextId: ctx, returnByValue: true, silent: true }, st.sid, CMD_MS);
        } finally {
          st.internalDepth--;
        }
        if (isRecord(r["exceptionDetails"])) return { present: false };
        const v = isRecord(r["result"]) ? r["result"]["value"] : undefined;
        if (typeof v !== "string") return { present: false };
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          return { present: false };
        }
        return { present: true, text: this.opts.scrub(JSON.stringify(hashBulkData(parsed))) };
      } catch (e) {
        if (attempt > 0) log.debug("trace: value read failed", { error: String(e) });
      }
    }
    return { present: false };
  }

  // ------------------------------------------------------------ writing

  private finishDoc(key: string): void {
    const s = this.book.summary(key);
    if (s !== null) {
      this.recent.push(s);
      if (this.recent.length > RECENT_DOCS) this.recent.shift();
    }
    const aggs = this.book.finish(key);
    const rec = this.opts.recorder();
    this.queueWrite(aggs, rec, [key]);
  }

  private queueWrite(aggs: Aggregate[], rec: Recorder | undefined, finished: string[]): void {
    const job = this.writing.then(() => this.write(aggs, rec)).finally(() => {
      for (const key of finished) {
        this.values.delete(key);
        this.valueWritten.delete(key);
        this.worlds.delete(key);
        this.docs.delete(key);
      }
    });
    this.writing = job.catch((e: unknown) => log.error("trace: writing signal events failed", { error: String(e) }));
  }

  private async write(aggs: Aggregate[], rec: Recorder | undefined): Promise<void> {
    if (rec === undefined || !rec.recording) return;
    for (const a of aggs) {
      const value = await this.valueFor(a, rec);
      rec.signal(a.doc.tab, signalFields(a, value), a.firstMono);
    }
  }

  /** The (doc, api) value goes on the first aggregate written for it, once. */
  private async valueFor(a: Aggregate, rec: Recorder): Promise<{ present: boolean; value: unknown }> {
    const p = this.values.get(a.doc.key)?.get(a.api);
    const done = this.valueWritten.get(a.doc.key) ?? new Set<string>();
    if (p === undefined || done.has(a.api)) return { present: false, value: undefined };
    const out = await Promise.race([p, Bun.sleep(VALUE_WAIT_MS).then((): ValueOut => ({ present: false }))]);
    if (!out.present) return { present: false, value: undefined };
    done.add(a.api);
    this.valueWritten.set(a.doc.key, done);
    if (Buffer.byteLength(out.text, "utf8") <= VALUE_INLINE_MAX) {
      let v: unknown;
      try {
        v = JSON.parse(out.text);
      } catch {
        v = out.text; // secret replacement cut through an escape: keep the scrubbed text as is
      }
      return { present: true, value: v };
    }
    const blob = await rec.putText(out.text);
    return blob === null ? { present: false, value: undefined } : { present: true, value: blob };
  }

  /** Write what every live document has seen so far into `rec` (its recording is about to stop). */
  async flushInto(rec: Recorder): Promise<void> {
    const aggs = this.book.drain();
    this.queueWrite(aggs, rec, []);
    await this.writing;
    if (this.recOff?.rec === rec) this.recOff = null;
    // 0.6-L: no more bodies will be indexed while this recording is closing;
    // armed suspects of it are worthless (count dropped, sinks come down).
    if (this.opts.decode) {
      this.indexOff?.();
      this.indexOff = null;
      this.drops.afterStop += this.armed.clear("recording stopped");
      this.held = [];
      await this.removeSinks("recording stopped");
    }
  }

  /** Not yet written aggregates as `signal`-shaped objects (trace list while documents are live). */
  pendingEvents(): Record<string, unknown>[] {
    return this.book.peek().map((a) => ({ kind: "signal", tab: a.doc.tab, ...signalFields(a, { present: this.values.get(a.doc.key)?.has(a.api) === true, value: null }) }));
  }

  // ------------------------------------------------------------ handoff, stop, status

  /** Handoff: skip every debugger pause while the session waits for the human, and back. */
  async setPaused(on: boolean): Promise<void> {
    if (this.stopped || this.paused === on) return;
    this.paused = on;
    const rec = this.opts.recorder();
    rec?.event("note", { text: on ? `trace paused: ${TRACE_PAUSED_NOTE}` : "trace resumed: the handoff ended (Debugger.setSkipAllPauses false)", refs: [] });
    await Promise.all([...this.sessions.values()].map((st) => this.t.send("Debugger.setSkipAllPauses", { skip: on }, st.sid, CMD_MS).catch(() => undefined)));
    // Documents that loaded meanwhile skipped their scriptFirstStatement pause.
    if (!on) await Promise.all([...this.sessions.values()].map((st) => this.install(st, null).catch(() => undefined)));
  }

  /** Remove every breakpoint, disable the debugger, write what is left, close the trace window. */
  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
    await Promise.all(
      [...this.sessions.values()].map(async (st) => {
        const send = (m: string, p: Record<string, unknown> = {}) => this.t.send(m, p, st.sid, CMD_MS).catch(() => undefined);
        await Promise.all([...[...st.bps.keys(), ...st.sinkBps.keys()]].map((id) => send("Debugger.removeBreakpoint", { breakpointId: id })));
        if (st.type !== "worker") for (const name of [SCRIPT_FIRST_STATEMENT, ...INSTRUMENTATION_EVENTS]) await send("EventBreakpoints.removeInstrumentationBreakpoint", { eventName: name });
        await send("Debugger.disable");
      }),
    );
    const rec = this.opts.recorder();
    const keys = this.book.docKeys();
    // 0.6-L: the observe sinks down with the API breakpoints.
    this.indexOff?.();
    this.indexOff = null;
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.drops.afterStop += this.armed.clear("trace stopped");
    this.held = [];
    for (const key of keys) {
      const s = this.book.summary(key);
      if (s !== null) this.recent.push(s);
    }
    const aggs = keys.flatMap((k) => this.book.finish(k));
    this.queueWrite(aggs.sort((a, b) => a.order - b.order), rec, keys);
    await this.writing;
    this.recOff?.off();
    this.recOff = null;
    rec?.traceClose(`trace window closed: ${reason}`);
    this.sessions.clear();
  }

  get stoppedNow(): boolean {
    return this.stopped;
  }

  status(): Record<string, unknown> {
    const docs = this.book.summaries();
    if (this.opts.decode) this.armed.expire(Date.now());
    return {
      session: this.session,
      trace: this.paused ? "paused" : "on",
      notice: TRACE_NOTICE,
      ...(this.paused ? { traceNote: TRACE_PAUSED_NOTE } : {}),
      since: this.startedAt,
      settings: { source: this.list.source, apis: this.list.hash, stack: this.limits.stack, firstN: this.limits.firstN, maxHits: this.limits.maxHits },
      requested: this.list.names.length,
      active: [...this.active].sort(),
      skipped: [...this.skippedWindow].map(([api, reason]) => ({ api, reason })),
      skippedInWorkers: [...this.skippedWorker.keys()],
      warnings: this.list.warnings,
      instrumentation: [...INSTRUMENTATION_EVENTS],
      ...(this.opts.decode
        ? {
            decode: {
              armed: this.armed.live().length,
              rows: { attributed: this.attributedRows, unattributed: this.unattributedRows, unattributedKept: this.unattributedKept },
              evidenceHits: this.evidenceHits,
              sinks: { resolved: this.sinksInstalled, skipped: this.sinksSkipped, on: this.sinksOn },
              drops: { ...this.drops },
            },
          }
        : {}),
      targets: [...this.sessions.values()].map((s) => ({ type: s.type, tab: s.tab.id, url: s.type === "page" ? s.tab.url : (s.target?.url ?? null), breakpoints: s.bps.size })),
      hits: this.hits,
      documents: docs,
      finished: this.recent.slice(-20),
      recording: this.opts.recorder()?.dir ?? null,
    };
  }
}
