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

export const TRACE_NOTICE = "Trace mode installs debugger breakpoints in the page: scripts run slower and the timing is observable.";
export const TRACE_PAUSED_NOTE = "trace is paused while the session waits for the human (debugger pauses are skipped); `tabcap handoff continue` resumes it";

const GROUP = "tabcap-trace";
const WORLD = "tabcap-trace";
const CMD_MS = 5000;
const VALUE_WAIT_MS = 2000;
const RECENT_DOCS = 50;

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
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;
  paused: boolean;
  /** Reads counted while tracing (all documents, all sessions). */
  hits = 0;

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
    return { mechanism: ["fn-breakpoint", "instrumentation"], apis: this.list.hash, stack: this.limits.stack, firstN: this.limits.firstN, maxHits: this.limits.maxHits };
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
    return tr;
  }

  /** A recording of the session started (or was there at trace start): open a trace window in it. */
  attachRecorder(rec: Recorder): void {
    if (this.stopped || this.recOff?.rec === rec) return;
    this.recOff?.off();
    rec.traceOpen(this.mode, `trace window opened: signal reads are recorded (${this.list.names.length} APIs from ${this.list.source}, stack ${this.limits.stack}, firstN ${this.limits.firstN}, maxHits ${this.limits.maxHits})`);
    if (this.paused) rec.event("note", { text: `trace paused: ${TRACE_PAUSED_NOTE}`, refs: [] });
    this.recOff = { rec, off: rec.beforeStop(() => this.flushInto(rec)) };
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
        await Promise.all([...st.bps.keys()].map((id) => send("Debugger.removeBreakpoint", { breakpointId: id })));
        if (st.type !== "worker") for (const name of [SCRIPT_FIRST_STATEMENT, ...INSTRUMENTATION_EVENTS]) await send("EventBreakpoints.removeInstrumentationBreakpoint", { eventName: name });
        await send("Debugger.disable");
      }),
    );
    const rec = this.opts.recorder();
    const keys = this.book.docKeys();
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
      targets: [...this.sessions.values()].map((s) => ({ type: s.type, tab: s.tab.id, url: s.type === "page" ? s.tab.url : (s.target?.url ?? null), breakpoints: s.bps.size })),
      hits: this.hits,
      documents: docs,
      finished: this.recent.slice(-20),
      recording: this.opts.recorder()?.dir ?? null,
    };
  }
}
