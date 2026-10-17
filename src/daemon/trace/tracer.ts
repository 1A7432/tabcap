// Trace mode (0.4-F): which page scripts read which browser signals, and from
// where. Record-only: no page state is changed — no injected script, no
// wrapped getter, no changed value — and no output advises changing values.
// The observe mode (0.6-L, `--decode`) additionally calls the page's native
// `console.dirxml` from a breakpoint condition (observe.ts says exactly what
// that touches). Spec: docs/04 §4.1 `signal`, §7 `mode.trace` / `traceWindows`.
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
import { addBounded, Armed, attribute, consoleSites, dropRawBody, evidenceFrames, frameScriptId, GRACE_MS, heldVerdict, heldWaits, HOLD_MAX, HOLD_MS, jsonParseLogpoint, passHeld, OBJECT_PROBES, observeRow, OBSERVE_VERSION, PAGE_BY, pauseSite, plaintextOf, PLAINTEXT_CAP, PLAINTEXT_MIN, rawBodyExcluded, SCOPE_FRAMES, SCOPE_PROPS, SCOPE_STRING_MIN, settleOutcome, decodeBlock, sha256Text, SINKS, suspectOf, suspectShas, SUSPECT_WINDOW_MS, takeLogged, TEXT_DECODER_CONDITION, utf8Bytes, type LoggedPlain, type PageEvidence, type PlainCandidate, type Settling, type SinkName } from "./observe.ts";
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
  /** 0.6-V: file single-suspect rows (`link: "weak"`); config.json
   * `trace.weakRows`; absent or true files them, false counts them as `drops.weak`. */
  weakRows?: boolean;
  /** 0.6-L2: register the observe log-point marker so the recorder's console
   * capture drops the plaintext it carries; returns an unregister callback. */
  suppressConsole?: (marker: string) => () => void;
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
  /** When `sweepTimer` fires (0.6-L2: an earlier deadline replaces a later one —
   * the 500 ms settle must not wait for a 5 s suspect window). */
  private sweepDue: number | null = null;
  private unattributedKept = 0;
  private attributedRows = 0;
  /** Of the attributed rows, those with `link: "weak"` (single-suspect). */
  private weakRows = 0;
  private unattributedRows = 0;
  private evidenceHits = 0;
  private sinksInstalled = 0;
  private sinksSkipped = 0;
  private walks = 0;
  private recovered = { console: 0, scope: 0 };
  private drops = { plaintextMissing: 0, tooLarge: 0, afterStop: 0, unattributedCapped: 0, rawBody: 0, orphan: 0, unpaired: 0, noFit: 0, weak: 0 };
  /** Requests that already have a page row (0.6-L2): one row per response. */
  private filedRequests = new Set<string>();
  /**
   * Single-suspect rows waiting out a short settle (0.6-L2): single-suspect is a
   * weak link (only one armed, no cryptographic scope-string match), so a page
   * that fetches and parses an unrelated plain response while a suspect is armed
   * (s59's /api/plain control) could be mis-filed before that response's own
   * body reaches the raw-body set. Scope-string rows file at once; these wait
   * `SETTLE_MS`, then file only if still not a recorded raw body and the request
   * has no row yet. 0.6-Q: unattributed rows settle too (`request` null, their
   * candidates kept): an envelope parsed while other suspects are armed, before
   * its own body was indexed, is dropped once that body arrives (item C).
   * 0.6-V: with `weakRows` false a single-suspect row still settles
   * and is counted as `drops.weak` where it would have been filed.
   */
  private settle: Array<Settling & { from: PlainCandidate["from"]; frames: PageEvidence["frames"] }> = [];
  private static readonly SETTLE_MS = 500;
  /** 0.6-L2: the per-trace log-point marker (random); its console messages carry
   * the plaintext and are dropped by the recorder's console capture. */
  private readonly nonce: string;
  private unsuppressConsole: (() => void) | null = null;
  /**
   * The plaintext each JSON.parse breakpoint logged (0.6-L2): the log-point in
   * the condition emits `console.dirxml(nonce, arg)` on `Runtime.consoleAPICalled`
   * strictly before the pause of the same parse (spike E6), per session. The
   * pause takes the line whose caller frame is its own top frame (spike E10,
   * `takeLogged`) to pair the exact argument with the scope it paused in.
   * `oversize` is a parse over the cap (the log-point sent null).
   */
  private pendingPlain = new Map<string, LoggedPlain[]>();
  private static readonly PENDING_MAX = 64;
  /** sha256 of every recorded response body text (0.6-L2): a plaintext candidate
   * that is one of these is the page parsing a raw body (envelope, plain
   * control), not a decrypted plaintext. Bounded: the oldest bodies are evicted
   * first, so a long recording keeps excluding its newest envelopes. */
  private rawShas = new Set<string>();
  private static readonly RAW_SHAS_MAX = 8192;
  /**
   * JSON.parse pauses whose plaintext was logged while no suspect was armed
   * yet: a page can decrypt and parse in the same microtask burst the
   * recorder's index push (the arm) is still a few ms away from (s59 xor,
   * spike: the plaintext pause lost the race). Held for `HOLD_MS` and matched
   * as soon as a suspect is armed; the attribution rules are unchanged —
   * only the timing gap is bridged. `consolePlain` is the log-point argument
   * when the guard was in force. 0.6-W (owner decision A): every pause
   * without a scope-string match is held, not only those that met no suspect
   * — other suspects being live says nothing about whether this one's own has
   * been armed yet (an XHR `onload` parses before the index push); it is
   * decided after GRACE_MS against the suspects live then (`heldVerdict`).
   * At most HOLD_MAX (256), HOLD_MS (10 s) before an orphan.
   */
  private held: Array<{ scopeShas: string[]; strings: string[]; byteCsvs: string[]; consolePlain: { text: string | null; oversize: boolean } | null; evFrames: PageEvidence["frames"]; at: number; textSha: string | null }> = [];
  /** matchHeld runs one at a time (an arm during its awaits asks for another pass). */
  private matching: Promise<void> | null = null;
  private matchAgain = false;

  private constructor(o: TracerOptions) {
    this.opts = o;
    this.session = o.session;
    this.t = o.t;
    this.tabs = o.tabs;
    this.list = o.list;
    this.limits = o.limits;
    this.paused = o.paused;
    this.book = new TraceBook(o.limits);
    // 0.6-L2: a random marker the log-point carries; the recorder's console
    // capture drops its messages so the plaintext never reaches `console list`.
    this.nonce = o.decode ? `tabcap-observe-${crypto.randomUUID()}` : "";
    if (o.decode && o.suppressConsole !== undefined) this.unsuppressConsole = o.suppressConsole(this.nonce);
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
    rec.traceOpen(
      this.mode,
      this.opts.decode
        ? "trace window opened: observe mode (--decode), the plaintext the page parses is filed by \"page\"; no signal breakpoints"
        : `trace window opened: signal reads are recorded (${this.list.names.length} APIs from ${this.list.source}, stack ${this.limits.stack}, firstN ${this.limits.firstN}, maxHits ${this.limits.maxHits})`,
    );
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
        for (const name of this.instrumentation()) await this.t.send("EventBreakpoints.setInstrumentationBreakpoint", { eventName: name }, sid, CMD_MS);
      }
      if (this.paused) await this.t.send("Debugger.setSkipAllPauses", { skip: true }, sid, CMD_MS);
      // Workers are installed while they wait for the debugger (before their first
      // statement); running documents at trace start get their breakpoints now.
      // 0.6-L: `install` brings the observe sinks too — a sink breakpoint
      // resolves on the realm's own JSON.parse etc., and JS built-ins do not
      // share one breakpoint across a target's realms: each realm installs its
      // own, at its first statement pause (pages) or here (workers). A
      // same-process repeat fails "already exists" and is tolerated.
      if (type === "worker" || installNow) await this.install(st, null);
    } catch (e) {
      log.warn("trace: enabling a target failed", { type, error: String(e) });
    }
  }

  /** The instrumentation breakpoints of a page / frame target: scriptFirstStatement
   * (the install channel) and, for signal tracing, the recorded events. The
   * observe mode traces no signals (owner decision 10-16, 0.6-L2): only the
   * install channel. */
  private instrumentation(): string[] {
    return this.opts.decode ? [SCRIPT_FIRST_STATEMENT] : [SCRIPT_FIRST_STATEMENT, ...INSTRUMENTATION_EVENTS];
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
      case "Runtime.consoleAPICalled":
        if (this.opts.decode) this.onConsole(st, p);
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

  /**
   * A JSON.parse log-point fired (0.6-L2): `console.dirxml(nonce, arg)` reaches
   * us on `Runtime.consoleAPICalled` before the pause of the same parse (spike
   * E6). Queue the exact argument per session for the pause to pair with its
   * scope; `null` means the argument was over the cap (oversize). Anything
   * whose first argument is not our marker is a page's own console call.
   */
  private onConsole(st: Sess, params: Record<string, unknown>): void {
    const args = Array.isArray(params["args"]) ? params["args"] : [];
    const first = isRecord(args[0]) ? args[0] : null;
    if (first === null || first["type"] !== "string" || first["value"] !== this.nonce) return;
    // While the session waits for the human the pauses are skipped: a line now
    // has no pause to pair with.
    if (this.paused) return;
    const payload = isRecord(args[1]) ? args[1] : null;
    const text = payload !== null && payload["type"] === "string" && typeof payload["value"] === "string" ? (payload["value"] as string) : null;
    const q = this.pendingPlain.get(st.sid) ?? [];
    if (q.length >= Tracer.PENDING_MAX) {
      q.shift();
      this.drops.unpaired++;
    }
    q.push({ text, oversize: text === null, at: Date.now(), sites: consoleSites(params) });
    this.pendingPlain.set(st.sid, q);
  }

  /** A finished response was stored: arm its body when it looks like ciphertext (D3). */
  private onEntryIndexed(e: NetEntry): void {
    if (!this.opts.decode || this.stopped) return;
    this.armed.expire(Date.now());
    if (e.outcome !== "finished" || e.blob === null) return;
    const bytes = this.opts.recorder()?.readBlob(e.blob) ?? null;
    if (bytes === null || bytes.length === 0) return;
    const text = Buffer.from(bytes).toString("utf8");
    // 0.6-L2: every recorded body text is a raw-body sha — a plaintext candidate
    // that equals one is the page parsing a raw body (the envelope, the plain
    // control), not a decrypted plaintext.
    const rawSha = sha256Text(text);
    addBounded(this.rawShas, rawSha, Tracer.RAW_SHAS_MAX);
    // 0.6-Q item C: a pause that parsed this very body before it was indexed
    // (the envelope race) is waiting in the settle or the hold — drop it now.
    const st = dropRawBody(this.settle, rawSha);
    const hd = dropRawBody(this.held, rawSha);
    if (st.dropped + hd.dropped > 0) {
      this.settle = st.kept;
      this.held = hd.kept;
      this.drops.rawBody += st.dropped + hd.dropped;
    }
    // A body the decode plugin already turned into a view has nothing to observe.
    if (e.decoded !== undefined) return;
    const s = suspectOf(bytes, text);
    if (s === null) return;
    // The ciphertext candidates, then the raw body text (0.6-L2: a page holding
    // the raw response text while it decrypts links its parse to it).
    this.armed.arm({ request: e.id, url: e.url, at: e.at, hashes: suspectShas(s, text), bound: s.bound });
    this.sweepLater(SUSPECT_WINDOW_MS + 50);
    this.ensureSinks();
    // The arm may decide a hold (a pause that won the microtask race).
    void this.matchHeld();
  }

  /** With decode on, the sinks are wanted on every target for as long as the
 * tracer runs (design fix 10-16, NOTES: arming from the index push loses the
 * race with the page's own first decrypt). Sets the intent — `enable` /
 * `install` put them on each target and on realms born later — and puts them
 * on the targets already traced (0.6-L2: a recording started after
 * `trace start --decode` on a loaded page had no sinks until the next
 * document). */
  private ensureSinks(): void {
    if (!this.opts.decode || this.sinksOn || this.stopped) return;
    this.sinksOn = true;
    for (const st of this.sessions.values()) void this.installSinks(st, null);
  }

  /** Expire the armed list: the suspects that no longer have a window.
   * The sinks stay up while decode is on (design fix 10-16, NOTES): arming
   * from the index push loses the race with the page's own first decrypt —
   * a scriptFirstStatement install wins it, the armed list only attributes. */
  private sweep(): void {
    if (this.stopped) return;
    this.armed.expire(Date.now());
    this.expireHeld(Date.now());
    void this.settleFlush(false);
    // 0.6-W: held pauses whose grace has elapsed are decided now.
    void this.matchHeld();
    const live = this.armed.live();
    const waits = [...live.map((x) => x.expiresAt), ...this.settle.map((s) => s.at + Tracer.SETTLE_MS), ...heldWaits(this.held, Date.now())];
    if (waits.length === 0) return;
    this.sweepLater(Math.max(Math.min(...waits) - Date.now(), 0) + 50);
  }

  /** Held pauses whose window elapsed without a suspect are orphans (0.6-L2,
   * owner decision 10-16: count only, no row, `find` untouched). */
  private expireHeld(now: number): void {
    const cut = now - HOLD_MS;
    const expired = this.held.filter((h) => h.at <= cut);
    if (expired.length > 0) this.drops.orphan += expired.length;
    this.held = this.held.filter((h) => h.at > cut);
  }

  private sweepLater(ms: number): void {
    if (this.stopped) return;
    const due = Date.now() + ms;
    if (this.sweepTimer !== null) {
      if (this.sweepDue !== null && this.sweepDue <= due) return;
      clearTimeout(this.sweepTimer);
    }
    this.sweepDue = due;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweepDue = null;
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
        const condition = sink === "JSON.parse" ? jsonParseLogpoint(this.nonce, PLAINTEXT_CAP) : sink === "TextDecoder.prototype.decode" ? TEXT_DECODER_CONDITION : null;
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
   * A hit of an observe sink. A function-call breakpoint sees no callee frame
   * (spike exp4: `data:null`, the caller's `arguments` are its own), so the
   * plaintext comes from the JSON.parse log-point (the exact argument, queued
   * on `Runtime.consoleAPICalled` before this pause), with the pausing scope
   * walked only to match the ciphertext. The evidence sinks are counted,
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
          // 0.6-V: the script id is the call frame's `location.scriptId`.
          const id = frameScriptId(f) ?? "";
          return st.tabcapScripts.has(id) || st.internalScripts.has(id) || (st.scripts.get(id)?.isDefault === false);
        })
      ) {
        // Still consume this parse's log line so the queue stays paired.
        if (sink === "JSON.parse") this.takePending(st.sid, frames[0]);
        return;
      }
      if (sink !== "JSON.parse") {
        this.evidenceHits++;
        return;
      }
      const consolePlain = this.takePending(st.sid, frames[0]);
      const rec = this.opts.recorder();
      if (rec === undefined || !rec.recording) {
        this.drops.afterStop++;
        return;
      }
      const evFrames = this.framesOf(st, frames);
      // Walk the pausing scope for the scope-string match (which ciphertext this
      // plaintext came from — the evidence, and the disambiguation when several
      // suspects are armed). 0.6-L2: when the log-point already gave the exact
      // plaintext, the walk hashes the scope strings only and skips the costly
      // read-only byte-buffer copy — the scope is no longer the plaintext source.
      const w = await this.walkScopeStrings(st, frames, consolePlain === null);
      this.walks++;
      const plaintext = this.plaintextFrom(consolePlain, w);
      // The armed list is read after the walk's awaits (0.6-L2 fix): an arm that
      // lands during the walk has already run its matchHeld — a pause held on a
      // list read before the walk would never be matched.
      this.armed.expire(Date.now());
      const live = this.armed.live();
      const attribution = attribute(live, w.scopeShas, plaintext.best === null ? null : utf8Bytes(plaintext.best.text));
      log.debug("observe: paused", { sink, frames: frames.length, console: consolePlain !== null, shas: w.scopeShas.length, attribution: attribution.kind, live: live.length });
      // 0.6-W: only a scope-string match (or a pause with nothing to file and
      // suspects to tell it so) is decided now; anything else waits for its
      // own arm — the page may have parsed before tabcap indexed the body —
      // and is decided after GRACE_MS against the suspects live then.
      const now = Date.now();
      if (heldVerdict(attribution.kind, now, now, false, plaintext.best !== null) === "decide") {
        await this.decideRow(attribution, w.scopeShas, evFrames, plaintext, now);
        return;
      }
      if (this.held.length >= HOLD_MAX) this.held.shift();
      const textSha = plaintext.best === null ? null : sha256Text(plaintext.best.text);
      this.held.push({ scopeShas: w.scopeShas, strings: w.strings, byteCsvs: w.byteCsvs, consolePlain, evFrames, at: Date.now(), textSha });
      this.sweepLater(GRACE_MS + 50);
    } catch (e) {
      log.debug("trace: observe pause failed", { error: String(e) });
    } finally {
      this.resume(st.sid);
    }
  }

  /** The log line of this pause's parse (same session, its caller frame is the
   * pause's top frame — `takeLogged`), or null: the guard failed for it. */
  private takePending(sid: string, top: Record<string, unknown> | undefined): { text: string | null; oversize: boolean } | null {
    const q = this.pendingPlain.get(sid);
    if (q === undefined || q.length === 0) return null;
    const { hit, rest, stale } = takeLogged(q, pauseSite(top), Date.now());
    this.drops.unpaired += stale;
    this.pendingPlain.set(sid, rest);
    return hit === null ? null : { text: hit.text, oversize: hit.oversize };
  }

  /** The plaintext of a pause: the log-point argument when the guard was in
   * force, else the longest JSON-parsing scope value (fallback). */
  private plaintextFrom(consolePlain: { text: string | null; oversize: boolean } | null, w: { strings: readonly string[]; byteCsvs: readonly string[] }): { best: PlainCandidate | null; oversize: boolean } {
    if (consolePlain !== null) {
      if (consolePlain.text !== null && consolePlain.text.length >= PLAINTEXT_MIN) return { best: { text: consolePlain.text, from: "console" }, oversize: false };
      return { best: null, oversize: consolePlain.oversize };
    }
    return plaintextOf(w.strings, w.byteCsvs);
  }

  /** Decide one JSON.parse pause's row and file it; the counters say why not.
   * The raw-body exclusion runs here (not before the hold): a page that parses
   * the envelope and the plaintext in the same microtask burst can hold both
   * before the arm populates the raw-body set — by filing time it is populated. */
  private async decideRow(attribution: ReturnType<typeof attribute>, scopeShas: readonly string[], frames: PageEvidence["frames"], plaintext: { best: PlainCandidate | null; oversize: boolean }, now: number): Promise<void> {
    // A plaintext that is a recorded raw body (the envelope, the plain control)
    // is the page parsing a raw body, not a decrypted plaintext.
    if (plaintext.best !== null && rawBodyExcluded(plaintext.best.text, this.rawShas)) {
      this.drops.rawBody++;
      return;
    }
    const decided = observeRow({ attribution, scopeShas, frames, plaintext, now, sink: "JSON.parse" }, this.unattributedKept);
    if (!("row" in decided)) {
      if (decided.skip === "plaintext-missing") this.drops.plaintextMissing++;
      else if (decided.skip === "plaintext-too-large") this.drops.tooLarge++;
      else if (decided.skip === "no-fit") this.drops.noFit++;
      else this.drops.unattributedCapped++;
      return;
    }
    const row = decided.row;
    // Single-suspect (weak) and unattributed rows settle (see `settle`); the
    // strong scope-string rows file at once.
    if ((attribution.kind === "single-suspect" || attribution.kind === "unattributed") && plaintext.best !== null) {
      if (row.request !== null && this.filedRequests.has(row.request)) return;
      const candidates = attribution.kind === "unattributed" ? attribution.candidates : null;
      this.settle.push({ request: row.request, candidates, text: plaintext.best.text, textSha: sha256Text(plaintext.best.text), from: plaintext.best.from, frames: row.evidence.frames, at: now });
      this.sweepLater(Tracer.SETTLE_MS + 50);
      return;
    }
    if (plaintext.best?.from === "console") this.recovered.console++;
    else this.recovered.scope++;
    await this.fileDecidedRow(row, now);
  }

  /** Store the plaintext blob, append the sidecar line; the counters say why not. */
  private async fileDecidedRow(row: { request: string | null; direction: "response"; mime: string; text: string; evidence: PageEvidence }, at: number): Promise<void> {
    // One row per request: the suspect is forgotten and the request marked
    // before the awaits so a parse that slips into the async gap (s59's control
    // during the real plaintext's write) cannot take the same suspect again.
    if (row.request !== null) {
      if (this.filedRequests.has(row.request)) return;
      this.filedRequests.add(row.request);
      this.armed.forget(row.request);
    }
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
      if (row.evidence.link === "weak") this.weakRows++;
    }
  }

  /** File the weak and unattributed rows whose settle has elapsed (0.6-L2;
   * unattributed 0.6-Q): drop those that turned out to be a recorded raw body,
   * whose request already has a row (a scope-string match won), or — for an
   * unattributed row — that would pass the cap (`settleOutcome`). `all`
   * flushes every pending row (trace / recording stop) so a weak axios-style
   * match is not lost on a quick stop. */
  private async settleFlush(all = false): Promise<void> {
    if (this.settle.length === 0) return;
    const cut = Date.now() - Tracer.SETTLE_MS;
    const due = all ? this.settle : this.settle.filter((s) => s.at <= cut);
    this.settle = all ? [] : this.settle.filter((s) => s.at > cut);
    for (const s of due) {
      const out = settleOutcome(s, this.rawShas, this.filedRequests, this.unattributedKept, this.opts.weakRows !== false);
      if (out === "filed") continue;
      if (out === "weak") {
        this.drops.weak++;
        continue;
      }
      if (out === "rawBody") {
        this.drops.rawBody++;
        continue;
      }
      if (out === "capped") {
        this.drops.unattributedCapped++;
        continue;
      }
      if (s.from === "console") this.recovered.console++;
      else this.recovered.scope++;
      const evidence: PageEvidence =
        s.request === null
          ? { sink: "JSON.parse", match: null, frames: s.frames, at: s.at, candidates: s.candidates ?? [] }
          : { sink: "JSON.parse", match: null, link: "weak", frames: s.frames, at: s.at };
      await this.fileDecidedRow({ request: s.request, direction: "response", mime: "application/json", text: s.text, evidence }, s.at);
    }
  }

  /**
   * A suspect was armed: match the held pauses (docs/04 §33 arm race — the
   * page's own microtask burst wins the first parse; the arm follows and the
   * walked pause is decided then). The attribution rules are unchanged.
   */
  private matchHeld(): Promise<void> {
    if (this.matching !== null) {
      this.matchAgain = true;
      return this.matching;
    }
    this.matching = (async () => {
      try {
        do {
          this.matchAgain = false;
          await this.matchHeldOnce();
        } while (this.matchAgain && !this.stopped);
      } finally {
        this.matching = null;
      }
    })();
    return this.matching;
  }

  /** One pass over the held pauses (`passHeld`); each is taken off the list
   * before its decision's awaits, and the armed list is re-read per pause (a
   * row just filed forgot its suspect). 0.6-W: a scope-string match is decided
   * at once, anything else only after its grace (`heldVerdict`); `force`
   * (trace stop, recording stop) decides every pending pause — one that meets
   * no live suspect then is an orphan. */
  private async matchHeldOnce(force = false): Promise<void> {
    if (this.held.length === 0 || (this.stopped && !force)) return;
    this.expireHeld(Date.now());
    const rec = this.opts.recorder();
    if (rec === undefined || !rec.recording) {
      // Unreachable in practice (a pause after the recording stopped is never
      // held), but a forced pass must not leave pauses uncounted.
      if (force) {
        this.drops.afterStop += this.held.length;
        this.held = [];
      }
      return;
    }
    await passHeld({
      entries: [...this.held],
      still: (h) => this.held.includes(h),
      judge: (h) => {
        this.armed.expire(Date.now());
        const live = this.armed.live();
        // No live suspect: no plaintext needed to say so.
        if (live.length === 0) return { kind: "armed-empty" as const, hasPlaintext: false, ctx: null };
        const plaintext = this.plaintextFrom(h.consolePlain, { strings: h.strings, byteCsvs: h.byteCsvs });
        const attribution = attribute(live, h.scopeShas, plaintext.best === null ? null : utf8Bytes(plaintext.best.text));
        return { kind: attribution.kind, hasPlaintext: plaintext.best !== null, ctx: { attribution, plaintext } };
      },
      take: (h) => {
        this.held = this.held.filter((x) => x !== h);
      },
      decide: async (h, ctx) => {
        if (ctx !== null) await this.decideRow(ctx.attribution, h.scopeShas, h.evFrames, ctx.plaintext, h.at);
      },
      orphan: () => {
        this.drops.orphan++;
      },
      now: () => Date.now(),
      force,
    });
  }

  /** Trace stop / recording stop (0.6-W): after any pass in flight, decide
   * every held pause now, so the weak and unattributed rows it makes join the
   * settle queue the forced settle flush files next (the caller's next step). */
  private async decideHeldNow(): Promise<void> {
    while (this.matching !== null) await this.matching;
    const job = this.matchHeldOnce(true);
    this.matching = job;
    try {
      await job;
    } finally {
      if (this.matching === job) this.matching = null;
    }
  }

  /** The caller frames for a pause's evidence (docs/04 §33, ≤5): cheap, no CDP.
   * 0.6-V: the frame's own `url`, then the scriptParsed map by `location.scriptId`. */
  private framesOf(st: Sess, frames: readonly Record<string, unknown>[]): PageEvidence["frames"] {
    return evidenceFrames(frames, (id) => st.scripts.get(id)?.url);
  }

  /**
   * Read-only walk of the pausing frames' scopes (docs/04 §33): every string
   * value long enough to be a ciphertext leaf (hashed — the scope-string
   * attribution), every ArrayBuffer / typed array copied as CSV through its
   * objectId (the fallback plaintext when the log-point was suppressed), never
   * a CryptoKey. `block` scopes are walked too (0.6-L2, spike E3: a plaintext
   * assigned to a block-scoped `const` sits in a `block`, not a `local`). Plain
   * objects (className `Object`) held in those scopes are read one level down
   * for the hash only (0.6-L2: `env.data` of `JSON.parse(decrypt(env.data))`),
   * at most OBJECT_PROBES per pause; `getProperties` with `ownProperties`
   * returns accessors without calling them. Arrays are not entered (their
   * `getProperties` lists every index), nor other classes (DOM, Proxy, Map …).
   */
  private async walkScopeStrings(st: Sess, frames: readonly Record<string, unknown>[], wantBytes: boolean): Promise<{ scopeShas: string[]; strings: string[]; byteCsvs: string[] }> {
    const scopeShas: string[] = [];
    const strings: string[] = [];
    const byteCsvs: string[] = [];
    const probes: string[] = [];
    for (const f of frames.slice(0, SCOPE_FRAMES)) {
      const callFrameId = str(f, "callFrameId");
      if (callFrameId === null) continue;
      const scopes = Array.isArray(f["scopeChain"]) ? f["scopeChain"].filter(isRecord) : [];
      for (const s of scopes) {
        const type = str(s, "type");
        if (type !== "local" && type !== "closure" && type !== "block") continue;
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
            if (sv.length < SCOPE_STRING_MIN) continue;
            strings.push(sv);
            scopeShas.push(sha256Text(sv));
          } else if (kind === "object") {
            const sub = str(v, "subtype");
            const cls = str(v, "className");
            const probe = str(v, "objectId");
            if (sub === null && cls === "Object" && probe !== null) {
              if (probes.length < OBJECT_PROBES && !probes.includes(probe)) probes.push(probe);
              continue;
            }
            if (!wantBytes || (sub !== "arraybuffer" && sub !== "typedarray")) continue;
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
    for (const objectId of probes) {
      let props: Record<string, unknown>;
      try {
        props = await this.t.send("Runtime.getProperties", { objectId, ownProperties: true }, st.sid, CMD_MS);
      } catch {
        continue; // one object gone is no reason to lose the pause
      }
      const list = Array.isArray(props["result"]) ? props["result"].filter(isRecord) : [];
      for (const p of list.slice(0, SCOPE_PROPS)) {
        const v = isRecord(p["value"]) ? p["value"] : null;
        if (v === null || str(v, "type") !== "string" || typeof v["value"] !== "string") continue;
        const sv = v["value"] as string;
        if (sv.length >= SCOPE_STRING_MIN) scopeShas.push(sha256Text(sv));
      }
    }
    return { scopeShas, strings, byteCsvs };
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
    if (this.list.names.length > 0) await this.installSignals(st, callFrameId);
    // 0.6-L: with decode on, every install brings the sinks ("already exists"
    // on a repeat is tolerated); a realm born now gets them before its first
    // script runs — what beats the page to its own first decrypt.
    if (this.opts.decode) await this.installSinks(st, callFrameId);
  }

  private async installSignals(st: Sess, callFrameId: string | null): Promise<void> {
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
      // 0.6-W: pauses still in their grace are decided first, then filed.
      await this.decideHeldNow();
      await this.settleFlush(true);
      this.drops.afterStop += this.armed.clear("recording stopped");
      this.held = [];
      this.settle = [];
      this.filedRequests.clear();
      this.pendingPlain.clear();
      this.rawShas.clear();
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
    // 0.6-L2: while the session waits for the human, pauses are skipped so
    // nothing is filed; drop any plaintext the log-point queued meanwhile so it
    // is not paired with a later parse's scope when the handoff ends.
    if (on) this.pendingPlain.clear();
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
        if (st.type !== "worker") for (const name of this.instrumentation()) await send("EventBreakpoints.removeInstrumentationBreakpoint", { eventName: name });
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
      this.sweepDue = null;
    }
    // 0.6-W: pauses still in their grace are decided first, then filed.
    await this.decideHeldNow();
    await this.settleFlush(true);
    this.drops.afterStop += this.armed.clear("trace stopped");
    this.held = [];
    this.settle = [];
    this.filedRequests.clear();
    this.pendingPlain.clear();
    this.rawShas.clear();
    this.unsuppressConsole?.();
    this.unsuppressConsole = null;
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

  /** 0.7-B `tabcap status`: the observe mode (`--decode`) is on. */
  get observing(): boolean {
    return this.opts.decode;
  }

  /** 0.7-B `tabcap status`: observe rows filed with `evidence.link: "weak"` so far. */
  get weakRowCount(): number {
    return this.weakRows;
  }

  /** Parses not decided yet (0.7-C `pending`): held pauses plus rows still settling. */
  get pendingParses(): number {
    return this.held.length + this.settle.length;
  }

  /** The observe mode's `decode` block (`decodeBlock`: compact, or with `verbose` the counters behind it); null without --decode. */
  decodeStatus(verbose = false): Record<string, unknown> | null {
    if (!this.opts.decode) return null;
    this.armed.expire(Date.now());
    return decodeBlock(
      {
        on: this.sinksOn && !this.stopped,
        weakRows: this.opts.weakRows !== false,
        armed: this.armed.live().length,
        held: this.held.length,
        settling: this.settle.length,
        attributed: this.attributedRows,
        weak: this.weakRows,
        unattributed: this.unattributedRows,
        unattributedKept: this.unattributedKept,
        evidenceHits: this.evidenceHits,
        recovered: this.recovered,
        walks: this.walks,
        sinks: { resolved: this.sinksInstalled, skipped: this.sinksSkipped, on: this.sinksOn },
        drops: this.drops,
      },
      verbose,
    );
  }

  status(verbose = false): Record<string, unknown> {
    const docs = this.book.summaries();
    const decode = this.decodeStatus(verbose);
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
      instrumentation: this.opts.decode ? [] : [...INSTRUMENTATION_EVENTS],
      ...(decode === null ? {} : { decode }),
      targets: [...this.sessions.values()].map((s) => ({ type: s.type, tab: s.tab.id, url: s.type === "page" ? s.tab.url : (s.target?.url ?? null), breakpoints: s.bps.size })),
      hits: this.hits,
      documents: docs,
      finished: this.recent.slice(-20),
      recording: this.opts.recorder()?.dir ?? null,
    };
  }
}
