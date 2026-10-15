// Console capture (docs/04 §4.1 `console`, 0.2). Sources:
//   Runtime.consoleAPICalled  → source "console"
//   Runtime.exceptionThrown   → source "exception" (with a short stack)
//   Log.entryAdded            → source "network" | "security" | "other"
// Runtime is enabled on every page / iframe / worker session by the attach
// protocol, Log as well (transport/direct/attach.ts), so entries are kept in a
// per-tab ring buffer whether or not the session is recording; the recorder
// additionally writes them as `console` events.
//
// The parsing functions are pure (unit tested). Everything in a CDP event and
// in the page's console output is untrusted data.

import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { Tabs } from "../browser/targets.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";

export const CONSOLE_RING = 500;
export const TEXT_MAX_BYTES = 4096;
const ARG_MAX_CHARS = 200;
const ARGS_MAX = 10;
const STACK_FRAMES = 8;
const STACK_MAX_CHARS = 2000;

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";
export type ConsoleSource = "console" | "exception" | "network" | "security" | "other";

export type ConsoleEntry = {
  ts: number;
  level: ConsoleLevel;
  source: ConsoleSource;
  text: string;
  truncated: boolean;
  args: string[];
  url: string | null;
  /** 1-based, like DevTools and JS stack strings (CDP reports 0-based). */
  line: number | null;
  col: number | null;
  stack: string | null;
};

/** Fixed-capacity FIFO: keeps the last `capacity` items and counts what fell out. */
export class RingBuffer<T> {
  private items: T[] = [];
  private start = 0;
  dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    this.dropped++;
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }

  clear(): void {
    this.items = [];
    this.start = 0;
    this.dropped = 0;
  }
}

/** Cut `s` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

export function isLevel(v: unknown): v is ConsoleLevel {
  return v === "debug" || v === "log" || v === "info" || v === "warn" || v === "error";
}

/** `--level X` keeps X and everything more severe (log and info rank the same). */
export function atLeast(level: ConsoleLevel, min: ConsoleLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/** Runtime.consoleAPICalled `type` → level. */
export function apiLevel(type: string | null): ConsoleLevel {
  switch (type) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
      return "warn";
    case "error":
    case "assert":
      return "error";
    default:
      return "log";
  }
}

/** Log.entryAdded `level` → level. */
function logLevel(level: string | null): ConsoleLevel {
  switch (level) {
    case "verbose":
      return "debug";
    case "warning":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}

/** One RemoteObject as console text: strings raw, primitives printed, objects by description. */
export function remoteText(o: unknown): string {
  if (!isRecord(o)) return "";
  const type = str(o, "type");
  if (type === "string") return str(o, "value") ?? "";
  if (type === "undefined") return "undefined";
  const unser = str(o, "unserializableValue");
  if (unser !== null) return unser;
  if ("value" in o) {
    const v = o["value"];
    if (v === null) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const j = JSON.stringify(v);
    if (typeof j === "string") return j;
  }
  const preview = isRecord(o["preview"]) ? previewText(o["preview"]) : null;
  return preview ?? str(o, "description") ?? str(o, "className") ?? type ?? "";
}

/** DevTools-like one-liner from an ObjectPreview: `{a: 1, b: "x"}`, `[1, 2, …]`. */
function previewText(p: Record<string, unknown>): string | null {
  const props = Array.isArray(p["properties"]) ? p["properties"].filter(isRecord) : null;
  if (props === null) return null;
  const isArray = str(p, "subtype") === "array";
  const parts = props.map((x) => {
    const v = str(x, "value") ?? "";
    const shown = str(x, "type") === "string" ? JSON.stringify(v) : v;
    return isArray ? shown : `${str(x, "name") ?? "?"}: ${shown}`;
  });
  if (p["overflow"] === true) parts.push("…");
  const desc = str(p, "description");
  if (isArray) return `[${parts.join(", ")}]`;
  const body = `{${parts.join(", ")}}`;
  return desc !== null && desc !== "Object" ? `${desc} ${body}` : body;
}

type Where = { url: string | null; line: number | null; col: number | null };

function topFrame(stackTrace: unknown): Where & { fn: string | null } {
  const frames = isRecord(stackTrace) && Array.isArray(stackTrace["callFrames"]) ? stackTrace["callFrames"].filter(isRecord) : [];
  const f = frames[0];
  if (f === undefined) return { url: null, line: null, col: null, fn: null };
  const line = num(f, "lineNumber");
  const col = num(f, "columnNumber");
  const url = str(f, "url");
  return { url: url === "" ? null : url, line: line === null ? null : line + 1, col: col === null ? null : col + 1, fn: str(f, "functionName") };
}

/** "at fn (url:line:col)" lines from a CDP StackTrace, 1-based, at most STACK_FRAMES. */
export function stackText(stackTrace: unknown): string | null {
  const frames = isRecord(stackTrace) && Array.isArray(stackTrace["callFrames"]) ? stackTrace["callFrames"].filter(isRecord) : [];
  if (frames.length === 0) return null;
  const lines = frames.slice(0, STACK_FRAMES).map((f) => {
    const fn = str(f, "functionName") ?? "";
    const loc = `${str(f, "url") ?? ""}:${(num(f, "lineNumber") ?? -1) + 1}:${(num(f, "columnNumber") ?? -1) + 1}`;
    return `    at ${fn === "" ? loc : `${fn} (${loc})`}`;
  });
  if (frames.length > STACK_FRAMES) lines.push(`    … ${frames.length - STACK_FRAMES} more`);
  return lines.join("\n").slice(0, STACK_MAX_CHARS);
}

function entry(o: Omit<ConsoleEntry, "text" | "truncated"> & { text: string }): ConsoleEntry {
  const t = truncateUtf8(o.text, TEXT_MAX_BYTES);
  return { ...o, text: t.text, truncated: t.truncated };
}

function tsOf(p: Record<string, unknown>, fallback: number): number {
  const ts = num(p, "timestamp"); // Runtime.Timestamp: ms since epoch
  return ts !== null && ts > 0 ? ts : fallback;
}

/** Turn one CDP event into a console entry; null when the event is not a console event or is malformed. */
export function parseConsoleEvent(e: CdpEvent, now: number): ConsoleEntry | null {
  const p = e.params;
  if (e.method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(p["args"]) ? p["args"] : [];
    const texts = args.map(remoteText);
    const at = topFrame(p["stackTrace"]);
    return entry({
      ts: tsOf(p, now),
      level: apiLevel(str(p, "type")),
      source: "console",
      text: texts.join(" "),
      args: texts.slice(0, ARGS_MAX).map((a) => (a.length > ARG_MAX_CHARS ? `${a.slice(0, ARG_MAX_CHARS)}…` : a)),
      url: at.url,
      line: at.line,
      col: at.col,
      stack: null,
    });
  }
  if (e.method === "Runtime.exceptionThrown") {
    const d = isRecord(p["exceptionDetails"]) ? p["exceptionDetails"] : null;
    if (d === null) return null;
    const ex = isRecord(d["exception"]) ? d["exception"] : null;
    const desc = ex === null ? null : (str(ex, "description") ?? (ex["value"] === undefined ? null : remoteText(ex)));
    const head = desc === null ? null : (desc.split("\n")[0] ?? null);
    const prefix = str(d, "text") ?? "Uncaught";
    const text = head === null || head === "" ? prefix : prefix.endsWith(head) ? prefix : `${prefix} ${head}`;
    const at = topFrame(d["stackTrace"]);
    const line = num(d, "lineNumber");
    const col = num(d, "columnNumber");
    const url = str(d, "url");
    let stack = stackText(d["stackTrace"]);
    if (stack === null && desc !== null && desc.includes("\n")) stack = desc.split("\n").slice(1, 1 + STACK_FRAMES).join("\n").slice(0, STACK_MAX_CHARS);
    return entry({
      ts: tsOf(p, now),
      level: "error",
      source: "exception",
      text,
      args: [],
      url: url !== null && url !== "" ? url : at.url,
      line: line !== null ? line + 1 : at.line,
      col: col !== null ? col + 1 : at.col,
      stack,
    });
  }
  if (e.method === "Log.entryAdded") {
    const en = isRecord(p["entry"]) ? p["entry"] : null;
    if (en === null) return null;
    const src = str(en, "source");
    const line = num(en, "lineNumber");
    const url = str(en, "url");
    return entry({
      ts: tsOf(en, now),
      level: logLevel(str(en, "level")),
      source: src === "network" ? "network" : src === "security" ? "security" : "other",
      text: str(en, "text") ?? "",
      args: [],
      url: url === "" ? null : url,
      line: line === null ? null : line + 1,
      col: null,
      stack: stackText(en["stackTrace"]),
    });
  }
  return null;
}

/**
 * The message type in chrome-devtools-mcp / Puppeteer terms (`console list
 * --types`): the console API's own type with `warning` → `warn`; uncaught
 * exceptions are `error`; Log entries carry their level (`verbose`, `info`,
 * `warn`, `error`). Only for events parseConsoleEvent accepts.
 */
export function consoleType(e: CdpEvent): string {
  if (e.method === "Runtime.consoleAPICalled") {
    const t = str(e.params, "type") ?? "log";
    return t === "warning" ? "warn" : t;
  }
  if (e.method === "Runtime.exceptionThrown") return "error";
  const en = isRecord(e.params["entry"]) ? e.params["entry"] : null;
  const level = en === null ? null : str(en, "level");
  return level === "warning" ? "warn" : level === "verbose" || level === "info" || level === "error" ? level : "info";
}

/** Types `console list --types` accepts (chrome-devtools-mcp FILTERABLE_MESSAGE_TYPES). */
export const CONSOLE_TYPES: readonly string[] = [
  "log",
  "debug",
  "info",
  "error",
  "warn",
  "dir",
  "dirxml",
  "table",
  "trace",
  "clear",
  "startGroup",
  "startGroupCollapsed",
  "endGroup",
  "assert",
  "profile",
  "profileEnd",
  "count",
  "timeEnd",
  "verbose",
  "issue",
];

/** A buffered message: the entry plus its per-tab message id (1, 2, …; stable while buffered) and type. */
export type StoredConsole = ConsoleEntry & { id: number; type: string };

/** `url:line:col` for display, or null. */
export function whereOf(e: Pick<ConsoleEntry, "url" | "line" | "col">): string | null {
  if (e.url === null) return null;
  return `${e.url}${e.line === null ? "" : `:${e.line}`}${e.line !== null && e.col !== null ? `:${e.col}` : ""}`;
}

export type ConsoleListener = (tabId: string, entry: ConsoleEntry) => void;

/**
 * Daemon-wide collector: one ring buffer per tab (CONSOLE_RING entries). Child
 * sessions (OOPIFs, workers) are mapped to their host tab through the attach
 * tree, so their output lands in the host tab's buffer.
 */
export class ConsoleLog {
  private rings = new Map<string, RingBuffer<StoredConsole>>();
  private seqs = new Map<string, number>();
  private listeners = new Set<ConsoleListener>();
  private off: () => void;

  constructor(
    t: Transport,
    private readonly tabs: Tabs,
    private readonly capacity = CONSOLE_RING,
  ) {
    this.off = t.onEvent((e) => this.onEvent(e));
  }

  dispose(): void {
    this.off();
    this.listeners.clear();
  }

  onEntry(fn: ConsoleListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  ring(tabId: string): RingBuffer<StoredConsole> {
    let r = this.rings.get(tabId);
    if (r === undefined) {
      r = new RingBuffer<StoredConsole>(this.capacity);
      this.rings.set(tabId, r);
    }
    return r;
  }

  private onEvent(e: CdpEvent): void {
    if (e.sessionId === null) return;
    if (e.method !== "Runtime.consoleAPICalled" && e.method !== "Runtime.exceptionThrown" && e.method !== "Log.entryAdded") return;
    const tabId = this.tabs.hostOf(e.sessionId)?.id;
    if (tabId === undefined) return;
    const en = parseConsoleEvent(e, Date.now());
    if (en === null) {
      log.debug("console: malformed event dropped", { method: e.method });
      return;
    }
    const id = (this.seqs.get(tabId) ?? 0) + 1;
    this.seqs.set(tabId, id);
    this.ring(tabId).push({ ...en, id, type: consoleType(e) });
    for (const fn of [...this.listeners]) {
      try {
        fn(tabId, en);
      } catch (err) {
        log.warn("console listener failed", { error: String(err) });
      }
    }
  }
}
