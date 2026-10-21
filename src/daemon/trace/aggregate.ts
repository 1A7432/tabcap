// Trace mode bookkeeping (docs/04 §4.1 `signal`, 0.4-F), pure: turns
// `Debugger.paused` payloads into hits and hits into per-document aggregates.
// No CDP here; tracer.ts feeds it and writes what it returns.
//
// Rules (owner design 10-16):
// - one aggregate per (document, api, access, caller location); the caller is
//   the top call frame (a native getter / function has no frame of its own);
// - `callFrames[].url` is empty on CfT 155: script URLs come from the
//   `Debugger.scriptParsed` map by `location.scriptId`;
// - firstN: per (api, caller url:line:col) and per tracer, only the first N
//   aggregates carry a stack; later ones keep `stack: []` and only count;
// - maxHits: after maxHits hits of one API in one document the API's breakpoint
//   is removed for that document (the caller does that), further hits are not
//   counted, and every aggregate of that (document, api) gets truncated: true.

import { isRecord, num, str } from "../../shared/json.ts";
import type { SignalFields, SignalFrame } from "../../bundle/types.ts";
import { INSTRUMENTATION_EVENTS, instrumentationPauseName, SCRIPT_FIRST_STATEMENT } from "./signals.ts";

export type TraceLimits = { stack: number; firstN: number; maxHits: number };

export const DEFAULT_LIMITS: TraceLimits = { stack: 8, firstN: 20, maxHits: 500 };

/** What `Debugger.scriptParsed` told us about a script (url may be "" for eval / tabcap evaluate). */
export type ScriptInfo = { url: string; ctx: number | null; frameId: string | null; isDefault: boolean | null };

/** A breakpoint the tracer installed, by breakpoint id. */
export type BpInfo = { api: string; access: "get" | "call" };

export type PauseFrame = { scriptId: string; url: string; line: number; col: number; callFrameId: string | null };

/** Classification of one `Debugger.paused`. */
export type Pause =
  | { kind: "install"; frame: PauseFrame | null }
  | { kind: "event"; api: string; args: string | null; frames: PauseFrame[] }
  | { kind: "bp"; hits: Array<{ bpId: string; info: BpInfo }>; frames: PauseFrame[] }
  | { kind: "other" };

const ARGS_MAX = 256;

/** Cut a UTF-8 string to at most `max` bytes without splitting a character. */
export function cutBytes(s: string, max: number): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}

function framesOf(raw: unknown, script: (scriptId: string) => ScriptInfo | undefined): PauseFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: PauseFrame[] = [];
  for (const f of raw) {
    if (!isRecord(f)) continue;
    const loc = isRecord(f["location"]) ? f["location"] : null;
    const scriptId = loc === null ? null : str(loc, "scriptId");
    if (loc === null || scriptId === null) continue;
    const own = str(f, "url") ?? "";
    out.push({
      scriptId,
      url: own !== "" ? own : (script(scriptId)?.url ?? ""),
      line: num(loc, "lineNumber") ?? 0,
      col: num(loc, "columnNumber") ?? 0,
      callFrameId: str(f, "callFrameId"),
    });
  }
  return out;
}

/**
 * Classify an untrusted `Debugger.paused` payload. `bps` maps the tracer's own
 * breakpoint ids; pauses that are neither ours nor an instrumentation we asked
 * for (a page `debugger;` statement, anything else) are "other": resume them.
 */
export function classifyPause(params: Record<string, unknown>, bps: ReadonlyMap<string, BpInfo>, script: (scriptId: string) => ScriptInfo | undefined): Pause {
  const reason = str(params, "reason");
  const data = isRecord(params["data"]) ? params["data"] : null;
  const eventName = data === null ? null : str(data, "eventName");
  if (reason === "EventListener" && eventName === instrumentationPauseName(SCRIPT_FIRST_STATEMENT)) {
    return { kind: "install", frame: framesOf(params["callFrames"], script)[0] ?? null };
  }
  if (reason === "EventListener" && eventName !== null && INSTRUMENTATION_EVENTS.some((n) => instrumentationPauseName(n) === eventName)) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {})) if (k !== "eventName") rest[k] = v;
    const args = Object.keys(rest).length === 0 ? null : cutBytes(JSON.stringify(rest), ARGS_MAX);
    return { kind: "event", api: eventName, args, frames: framesOf(params["callFrames"], script) };
  }
  const ids = Array.isArray(params["hitBreakpoints"]) ? params["hitBreakpoints"].filter((x): x is string => typeof x === "string") : [];
  const hits: Array<{ bpId: string; info: BpInfo }> = [];
  for (const id of ids) {
    const info = bps.get(id);
    if (info !== undefined) hits.push({ bpId: id, info });
  }
  if (hits.length > 0) return { kind: "bp", hits, frames: framesOf(params["callFrames"], script) };
  return { kind: "other" };
}

/** The document a hit belongs to (one realm: a window context or a worker). */
export type DocRef = {
  key: string;
  sessionId: string;
  /** Daemon tab id of the host tab. */
  tab: string;
  /** "root" for the tab's main frame, the frame id for iframes, null in workers. */
  frame: string | null;
  /** Bundle nav epoch at the document's first hit (null when not recording). */
  nav: string | null;
  url: string | null;
  realm: "window" | "worker";
};

export type Hit = {
  doc: DocRef;
  api: string;
  access: "get" | "call" | "event";
  args: string | null;
  frames: PauseFrame[];
  callerKind: "page" | "tabcap";
  mono: number | null;
};

export type Aggregate = {
  doc: DocRef;
  api: string;
  access: "get" | "call" | "event";
  args: string | null;
  caller: { kind: "page" | "tabcap"; url: string; scriptId: string; line: number; col: number };
  stack: SignalFrame[];
  count: number;
  firstMono: number | null;
  lastMono: number | null;
  truncated: boolean;
  /** Order of creation inside the tracer (the earliest aggregate of a (doc, api) carries the value). */
  order: number;
};

type DocState = {
  ref: DocRef;
  aggs: Map<string, Aggregate>;
  hits: Map<string, number>;
  truncated: Set<string>;
  total: number;
};

export type RecordResult = {
  counted: boolean;
  /** First counted hit of this API in this document (read its value now). */
  firstOfApi: boolean;
  /** This hit reached maxHits: remove the API's breakpoint for the document. */
  truncateNow: boolean;
};

export type DocSummary = { tab: string; frame: string | null; nav: string | null; url: string | null; realm: "window" | "worker"; hits: number; apis: number; truncated: string[] };

export class TraceBook {
  private docs = new Map<string, DocState>();
  private captures = new Map<string, number>();
  private seq = 0;

  constructor(readonly limits: TraceLimits) {}

  record(h: Hit): RecordResult {
    let d = this.docs.get(h.doc.key);
    if (d === undefined) {
      d = { ref: h.doc, aggs: new Map(), hits: new Map(), truncated: new Set(), total: 0 };
      this.docs.set(h.doc.key, d);
    }
    const seen = d.hits.get(h.api) ?? 0;
    if (seen >= this.limits.maxHits) return { counted: false, firstOfApi: false, truncateNow: false };
    d.hits.set(h.api, seen + 1);
    d.total++;
    const top = h.frames[0];
    const caller = { kind: h.callerKind, url: top?.url ?? "", scriptId: top?.scriptId ?? "", line: top?.line ?? 0, col: top?.col ?? 0 };
    const key = `${h.api}|${h.access}|${caller.kind}|${caller.scriptId}:${caller.line}:${caller.col}`;
    let a = d.aggs.get(key);
    if (a === undefined) {
      const capKey = `${h.api}|${caller.url}:${caller.line}:${caller.col}`;
      const caps = this.captures.get(capKey) ?? 0;
      const withStack = caps < this.limits.firstN;
      if (withStack) this.captures.set(capKey, caps + 1);
      a = {
        doc: d.ref,
        api: h.api,
        access: h.access,
        args: h.args,
        caller,
        stack: withStack ? h.frames.slice(0, this.limits.stack).map((f) => ({ url: f.url, line: f.line, col: f.col })) : [],
        count: 0,
        firstMono: h.mono,
        lastMono: h.mono,
        truncated: d.truncated.has(h.api),
        order: ++this.seq,
      };
      d.aggs.set(key, a);
    }
    a.count++;
    if (h.mono !== null) {
      a.firstMono ??= h.mono;
      a.lastMono = h.mono;
    }
    const truncateNow = seen + 1 === this.limits.maxHits;
    if (truncateNow) {
      d.truncated.add(h.api);
      for (const x of d.aggs.values()) if (x.api === h.api) x.truncated = true;
    }
    return { counted: true, firstOfApi: seen === 0, truncateNow };
  }

  /** Aggregates of a document, oldest first; the document is forgotten. */
  finish(key: string): Aggregate[] {
    const d = this.docs.get(key);
    if (d === undefined) return [];
    this.docs.delete(key);
    return [...d.aggs.values()].sort((a, b) => a.order - b.order);
  }

  /**
   * Aggregates of every live document, oldest first; their counts start again
   * from zero (a recording that stops mid-document gets what it saw), while
   * hit totals, truncation and the documents themselves are kept.
   */
  drain(): Aggregate[] {
    const out: Aggregate[] = [];
    for (const d of this.docs.values()) {
      out.push(...d.aggs.values());
      d.aggs = new Map();
    }
    return out.sort((a, b) => a.order - b.order);
  }

  /** Aggregates of every live document without forgetting them (trace list). */
  peek(): Aggregate[] {
    return [...this.docs.values()].flatMap((d) => [...d.aggs.values()]).sort((a, b) => a.order - b.order);
  }

  docKeys(sessionId: string | null = null): string[] {
    return [...this.docs.values()].filter((d) => sessionId === null || d.ref.sessionId === sessionId).map((d) => d.ref.key);
  }

  has(key: string): boolean {
    return this.docs.has(key);
  }

  isTruncated(key: string, api: string): boolean {
    return this.docs.get(key)?.truncated.has(api) === true;
  }

  summaries(): DocSummary[] {
    return [...this.docs.values()].map((d) => ({ ...summaryRef(d.ref), hits: d.total, apis: d.hits.size, truncated: [...d.truncated] }));
  }

  summary(key: string): DocSummary | null {
    const d = this.docs.get(key);
    return d === undefined ? null : { ...summaryRef(d.ref), hits: d.total, apis: d.hits.size, truncated: [...d.truncated] };
  }
}

function summaryRef(r: DocRef): Pick<DocSummary, "tab" | "frame" | "nav" | "url" | "realm"> {
  return { tab: r.tab, frame: r.frame, nav: r.nav, url: r.url, realm: r.realm };
}

/** Event fields of an aggregate (docs/04 §4.1 `signal`), envelope excluded. */
export function signalFields(a: Aggregate, value: { present: boolean; value: unknown }): SignalFields {
  return {
    frame: a.doc.frame,
    nav: a.doc.nav,
    api: a.api,
    access: a.access,
    args: a.args,
    caller: { ...a.caller },
    stack: a.stack.map((f) => ({ ...f })),
    count: a.count,
    firstMono: a.firstMono,
    lastMono: a.lastMono,
    ...(a.truncated ? { truncated: true } : {}),
    ...(value.present ? { value: value.value } : {}),
  };
}
