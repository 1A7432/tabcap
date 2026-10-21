// Pure parts of `tabcap wait` / `tabcap net wait` (unit tested): argument parsing,
// the page-side polling expressions and how their results are read, network
// idle bookkeeping, and request matching. tools/wait.ts wires them to CDP.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { optNum, optStr, type Args } from "./args.ts";

export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 120_000;
export const WAIT_MIN_MS = 100;
export const POLL_MS = 100;
export const IDLE_DEFAULT_MS = 500;
const VALUE_MAX_CHARS = 2000;

export type WaitSpec =
  /** Any of the texts (`--text` may repeat); checked in every frame of the tab. */
  | { kind: "text"; texts: string[] }
  | { kind: "selector"; selector: string }
  | { kind: "url"; url: string }
  | { kind: "idle"; ms: number }
  | { kind: "fn"; expr: string };

/** `--timeout` for wait / net wait: default 10 s, clamped to [100 ms, 120 s]. */
export function waitTimeout(a: Args): number {
  const t = optNum(a, "timeoutMs");
  if (t === null) return WAIT_DEFAULT_MS;
  return Math.max(WAIT_MIN_MS, Math.min(Math.round(t), WAIT_MAX_MS));
}

const USAGE = "tabcap wait --text <t> [--text <t2> …] | --selector <css> | --url <substring> | --idle [ms] | --fn <js> [--timeout ms]";

/** `--text` once (a string) or repeated (a list); null when absent. */
function textsOf(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x): x is string => typeof x === "string")) throw new TabcapError("usage", "--text takes text", `Usage: ${USAGE}`);
  return list;
}

/** Exactly one condition. `idle` may be `true` (flag without a value) or a number of ms. */
export function parseWait(a: Args): WaitSpec {
  const specs: WaitSpec[] = [];
  const texts = textsOf(a["text"]);
  const selector = optStr(a, "selector");
  const url = optStr(a, "url");
  const fn = optStr(a, "fn");
  if (texts !== null) specs.push({ kind: "text", texts });
  if (selector !== null) specs.push({ kind: "selector", selector });
  if (url !== null) specs.push({ kind: "url", url });
  if (fn !== null) specs.push({ kind: "fn", expr: fn });
  const idle = a["idle"];
  if (idle !== undefined && idle !== null && idle !== false) {
    const ms = idle === true ? IDLE_DEFAULT_MS : typeof idle === "number" ? idle : typeof idle === "string" ? Number(idle) : NaN;
    if (!Number.isFinite(ms) || ms < 0) throw new TabcapError("usage", "--idle takes a number of milliseconds", `Usage: ${USAGE}`);
    specs.push({ kind: "idle", ms: Math.round(ms) });
  }
  const [only, ...extra] = specs;
  if (only === undefined) throw new TabcapError("usage", "wait needs a condition", `Usage: ${USAGE}`);
  if (extra.length > 0) throw new TabcapError("usage", `wait takes one condition, got ${specs.map((x) => `--${x.kind}`).join(" ")}`, "Run one `tabcap wait` per condition, one after the other.");
  if (only.kind === "text" && (only.texts.length === 0 || only.texts.some((x) => x === ""))) throw new TabcapError("usage", "--text must not be empty", `Usage: ${USAGE}`);
  if ((only.kind === "url" || only.kind === "selector") && (only.kind === "url" ? only.url : only.selector) === "") {
    throw new TabcapError("usage", `--${only.kind} must not be empty`, `Usage: ${USAGE}`);
  }
  if (only.kind === "fn" && only.expr.trim() === "") throw new TabcapError("usage", "--fn must not be empty", `Usage: ${USAGE}`);
  return only;
}

/** Page-side expression polled for text / selector / fn (returns null until matched). */
export function pollExpression(spec: Extract<WaitSpec, { kind: "text" | "selector" | "fn" }>): string {
  if (spec.kind === "text") {
    // Evaluated in each frame on its own (a frame's innerText leaves out its iframes).
    const ts = JSON.stringify(spec.texts);
    return `(() => { const b = document.body; const s = b ? b.innerText : ""; for (const t of ${ts}) { const i = s.indexOf(t); if (i >= 0) return { text: t, context: s.slice(Math.max(0, i - 40), i + t.length + 40) }; } return null; })()`;
  }
  if (spec.kind === "selector") {
    const sel = JSON.stringify(spec.selector);
    return `(() => { let el; try { el = document.querySelector(${sel}); } catch (e) { return { invalid: String((e && e.message) || e) }; } if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), text: String(el.innerText || el.textContent || "").trim().slice(0, 200), visible: r.width > 0 && r.height > 0 }; })()`;
  }
  // The user's expression goes on its own lines so a trailing comment cannot swallow the wrapper.
  return `(async () => { const v = await (\n${spec.expr}\n); if (!v) return null; let out; try { out = JSON.parse(JSON.stringify(v)); } catch (e) { out = String(v); } return { value: out === undefined ? String(v) : out }; })()`;
}

export type PollOutcome = { state: "pending" } | { state: "matched"; detail: Record<string, unknown> } | { state: "invalid"; message: string };

/** Read the (untrusted) value a poll expression returned. */
export function readPoll(spec: Extract<WaitSpec, { kind: "text" | "selector" | "fn" }>, value: unknown): PollOutcome {
  if (!isRecord(value)) return { state: "pending" };
  if (spec.kind === "selector" && typeof value["invalid"] === "string") return { state: "invalid", message: value["invalid"] };
  if (spec.kind === "text") {
    // Owner 10-21: only a text that was asked for counts (the record is untrusted).
    const hit = value["text"];
    if (typeof hit !== "string" || !spec.texts.includes(hit)) return { state: "pending" };
    return { state: "matched", detail: { text: hit, context: typeof value["context"] === "string" ? value["context"] : null } };
  }
  if (spec.kind === "selector") {
    return {
      state: "matched",
      detail: { selector: spec.selector, tag: typeof value["tag"] === "string" ? value["tag"] : null, text: typeof value["text"] === "string" ? value["text"] : null, visible: value["visible"] === true },
    };
  }
  if (!("value" in value)) return { state: "pending" };
  const json = JSON.stringify(value["value"]) ?? "null";
  return json.length > VALUE_MAX_CHARS
    ? { state: "matched", detail: { valueText: json.slice(0, VALUE_MAX_CHARS), truncated: true } }
    : { state: "matched", detail: { value: value["value"], truncated: false } };
}

/**
 * Requests in flight on one tab, for `wait --idle`. Idle = nothing in flight
 * for N ms. Requests of a document replaced by a root navigation never finish
 * (spike 2), so a commit drops those with a different loaderId.
 */
export class IdleTracker {
  private inflight = new Map<string, { url: string; loaderId: string | null }>();
  private quietSince: number;
  seen = 0;

  constructor(now: number) {
    this.quietSince = now;
  }

  get busy(): number {
    return this.inflight.size;
  }

  begin(key: string, url: string, loaderId: string | null): void {
    if (!this.inflight.has(key)) this.seen++;
    this.inflight.set(key, { url, loaderId });
  }

  end(key: string, now: number): void {
    if (this.inflight.delete(key) && this.inflight.size === 0) this.quietSince = now;
  }

  /** Root frame committed a new document. */
  commit(loaderId: string | null, now: number): void {
    if (loaderId === null) return;
    let dropped = false;
    for (const [k, v] of this.inflight) {
      if (v.loaderId !== null && v.loaderId !== loaderId) {
        this.inflight.delete(k);
        dropped = true;
      }
    }
    if (dropped && this.inflight.size === 0) this.quietSince = now;
  }

  /** How long nothing has been in flight (0 while busy). */
  idleFor(now: number): number {
    return this.inflight.size > 0 ? 0 : Math.max(0, now - this.quietSince);
  }

  outstanding(): string[] {
    return [...this.inflight.values()].map((v) => v.url);
  }
}

export type NetWaitQuery = { url: string; method: string | null };

export function parseNetWait(a: Args): NetWaitQuery {
  const url = optStr(a, "url");
  if (url === null || url === "") throw new TabcapError("usage", "net wait needs --url <substring>", "Usage: tabcap net wait --url <substring> [--method M] [--timeout ms]");
  const method = optStr(a, "method");
  return { url, method: method === null || method === "" ? null : method.toUpperCase() };
}

/** "match" = URL / method fit and a body is stored; "no-body" = fits but nothing was stored. */
export function netMatch(e: { url: string; method: string; blob: string | null }, q: NetWaitQuery): "match" | "no-body" | "no" {
  if (!e.url.includes(q.url)) return "no";
  if (q.method !== null && e.method.toUpperCase() !== q.method) return "no";
  return e.blob === null ? "no-body" : "match";
}

/** Short, readable list for a `next` hint. */
export function listForHint(items: readonly string[], max = 3): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}
