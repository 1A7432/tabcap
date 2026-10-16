// Observe mode (0.6-L, docs/04 §33): in-page decoding. Sites that encrypt API
// bodies decrypt them in their own page JS; a decode plugin needs the key and
// the algorithm, the page already has both. While `trace start --decode` is on,
// three sink breakpoints (JSON.parse — the plaintext source;
// TextDecoder.prototype.decode and SubtleCrypto.prototype.decrypt — evidence
// only, the key material is never read) stay up on every realm, a finished
// response that looks like ciphertext becomes a "suspect" for a 5 s window,
// and the plaintext the page parses is filed as a `decoded` view `by:"page"`
// into the bundle's decoded.jsonl sidecar (0.6-B's format). Nothing in the
// page is modified: breakpoints only.
//
// Attribution (owner decision 10-16, newer than the brief): scope-string —
// a string in the pausing call frames' local / closure scopes whose sha256 is
// one of the armed suspect's ciphertext candidates; single-suspect — exactly
// one suspect armed; otherwise the row is unattributed (`request: null`) with
// the candidates it was confused with. Never by recency.
//
// Reading the plaintext (spike-06l exp4, CfT 155): a function-call breakpoint
// pauses with only the caller frame — the callee's arguments are not exposed
// (data: null, no callee frame, `arguments` is the caller's own). The
// plaintext is recovered from the pausing scope instead: every string value
// that parses as JSON, and every ArrayBuffer / typed array copied read-only
// through its objectId (`Array.from`, bounded to 1 MiB — a CryptoKey object
// is never touched). If no scope value yields the plaintext the row is not
// written (counted as plaintextMissing); a page that keeps the plaintext in
// no reachable local cannot be served by observe mode.
//
// The sinks stay up while decode is on (design fix 10-16, NOTES): arming a
// breakpoint from the recording's index push loses the race with the page's
// own first decrypt — a scriptFirstStatement install has the breakpoints in
// place before the realm's first script runs; the armed list only attributes.
//
// Unit tests decide attribution and expiry from synthetic state; the CDP side
// is thin (three evaluates, getProperties, callFunctionOn).

import { createHash } from "node:crypto";
import { shannonEntropy } from "../../analyze/decoders.ts";
import { looksEncrypted } from "../../analyze/find.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";

export const OBSERVE_VERSION = "observe/0";
export const PAGE_BY = "page";

/** docs/04 §33: a suspect's arming window, from its body capture. */
export const SUSPECT_WINDOW_MS = 5000;
/** Unattributed rows kept per recording (docs/04 §33, D7). */
export const UNATTRIBUTED_CAP = 50;
/** A plaintext over this size is evidence only (no row). */
export const PLAINTEXT_CAP = 1024 * 1024;
/** Caller frames walked for the scope-string match and the plaintext. */
export const SCOPE_FRAMES = 4;
/** Properties read per scope object. */
export const SCOPE_PROPS = 200;
/** Breakpoint condition of the JSON.parse sink (evaluated inside V8). */
export const JSON_PARSE_CONDITION = `typeof arguments[0] === "string" && arguments[0].length >= 32`;
/** Sinks stay up while decode is on (design fix 10-16, NOTES): a body-cap
 * gate for the decoder keeps ordinary byte shuffling out of the pauses too. */
export const TEXT_DECODER_CONDITION = `typeof arguments[0] === "object" && arguments[0] !== null && arguments[0].byteLength >= 32`;

/** The sinks by the IDL-ish name they are resolved by in a realm. */
export const SINKS = ["JSON.parse", "TextDecoder.prototype.decode", "SubtleCrypto.prototype.decrypt"] as const;
export type SinkName = (typeof SINKS)[number];

const BASE64ish = /^[A-Za-z0-9+/=_-]+$/;
const HEXish = /^[0-9a-fA-F]+$/;
/** docs/04 §33: a JSON string leaf this long that looks like base64 / hex. */
const LEAF_MIN = 64;

export const sha256Text = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ------------------------------------------------------------ suspect test (pure)

/** The ciphertext candidates of a response body (whole text, then JSON string leaves). */
export type SuspectCandidates = { whole: string | null; leaves: string[] };

export type SuspectBody = { candidates: SuspectCandidates; jsonLeaf: boolean };

/**
 * A response worth arming for (docs/04 §33): the body `looksEncrypted` (find's
 * entropy rule), or its JSON has a string leaf ≥ 64 chars that looks like
 * base64 / hex. Null when neither. `text` is the body decoded per its charset
 * by the caller; `bytes` the stored body.
 */
export function suspectOf(bytes: Uint8Array, text: string): SuspectBody | null {
  const whole = looksEncrypted(bytes.length, shannonEntropy(bytes)) ? sha256Text(text) : null;
  const leaves: string[] = [];
  let leaf = false;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      for (const s of leavesOf(parsed)) {
        leaf = true;
        leaves.push(sha256Text(s));
      }
    } catch {
      // not JSON: only the whole-body rule applies
    }
  }
  if (whole === null && leaves.length === 0) return null;
  return { candidates: { whole, leaves }, jsonLeaf: leaf };
}

/** String leaves of a JSON value that look like base64 / hex, in document order. */
function* leavesOf(v: unknown): Generator<string> {
  if (typeof v === "string") {
    if (v.length >= LEAF_MIN && (BASE64ish.test(v) || HEXish.test(v))) yield v;
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) yield* leavesOf(x);
    return;
  }
  if (isRecord(v)) {
    for (const x of Object.values(v)) yield* leavesOf(x);
  }
}

// ------------------------------------------------------------ armed state (pure)

export type ArmedSuspect = {
  /** r-<seq> of the response's request event. */
  request: string;
  url: string;
  /** Daemon epoch ms the body was captured (the index push). */
  at: number;
  expiresAt: number;
  /** sha256 of the whole body text (when it looked encrypted) and of each base64 / hex leaf. */
  shas: string[];
};

/** The suspects inside their arming window (docs/04 §33); expiry is lazy. */
export class Armed {
  private list: ArmedSuspect[] = [];

  arm(entry: { request: string; url: string; at: number; shas: string[]; windowMs?: number }): void {
    this.list.push({ request: entry.request, url: entry.url, at: entry.at, expiresAt: entry.at + (entry.windowMs ?? SUSPECT_WINDOW_MS), shas: entry.shas });
  }

  /** Drop expired suspects; called before any decision / status read. *Ages the list.* */
  expire(now: number): void {
    this.list = this.list.filter((s) => s.expiresAt > now);
  }

  /** All live suspects, oldest capture first (already expired by `expire`). */
  live(): readonly ArmedSuspect[] {
    return this.list;
  }

  /** The live suspect one of whose ciphertext hashes is in `shas` (scope-string). */
  bySha(shas: readonly string[]): ArmedSuspect | null {
    for (const s of this.list) if (s.shas.some((h) => shas.includes(h))) return s;
    return null;
  }

  forget(request: string): void {
    this.list = this.list.filter((s) => s.request !== request);
  }

  clear(reason: string): number {
    const n = this.list.length;
    if (n > 0) log.debug("observe: suspects dropped", { reason, count: n });
    this.list = [];
    return n;
  }
}

// ------------------------------------------------------------ attribution (pure)

export type Attribution =
  | { kind: "scope-string"; suspect: ArmedSuspect }
  | { kind: "single-suspect"; suspect: ArmedSuspect }
  | { kind: "unattributed"; candidates: string[] }
  | { kind: "armed-empty" };

/**
 * Owner rule 10-16 (replaces the brief's `sequence` / `recent`): scope-string
 * first, then the only armed suspect when exactly one is live, otherwise
 * unattributed with the live suspects listed as candidates. Never by time.
 */
export function attribute(armed: readonly ArmedSuspect[], scopeShas: readonly string[]): Attribution {
  if (armed.length === 0) return { kind: "armed-empty" };
  const hit = armed.find((s) => s.shas.some((h) => scopeShas.includes(h)));
  if (hit !== undefined) return { kind: "scope-string", suspect: hit };
  if (armed.length === 1) return { kind: "single-suspect", suspect: (armed[0] as ArmedSuspect) };
  return { kind: "unattributed", candidates: armed.map((s) => s.request) };
}

// ------------------------------------------------------------ plaintext candidates (pure)

export type PlainCandidate = { text: string; from: "string" | "bytes" };

/**
 * The plaintext among scope values (spike-06l exp3/exp4: the callee argument
 * is not reachable, the plaintext sits in the caller's locals). Strings are
 * tried as JSON, byte buffers (ArrayBuffer / typed arrays, `Array.from`
 * joined by commas — the form the CDP side copies them in) are decoded UTF-8
 * and tried as JSON. The longest value that parses wins; equally long ties
 * keep the first. Never executes page code: JSON.parse runs in tabcap.
 */
export function plaintextOf(scopeStrings: readonly string[], byteBuffers: readonly string[]): { best: PlainCandidate | null; oversize: boolean } {
  let best: PlainCandidate | null = null;
  let oversize = false;
  const tryIt = (raw: string, from: PlainCandidate["from"]): void => {
    const text = from === "bytes" ? bytesCsvToText(raw) : raw;
    if (text === null || text.length < 32) return;
    if (text.length > PLAINTEXT_CAP) {
      // docs/04 §33: a plaintext over the cap is evidence only (no view).
      oversize = true;
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      return;
    }
    if (best === null || text.length > best.text.length) best = { text, from };
  };
  for (const s of scopeStrings) tryIt(s, "string");
  for (const s of byteBuffers) tryIt(s, "bytes");
  return { best, oversize };
}

/** "1,2,3,…" (Array.from(...).join(",")) → UTF-8 text; null on malformed / huge input. */
export function bytesCsvToText(csv: string): string | null {
  if (csv.length === 0) return "";
  let out: number[] | null = [];
  let n = 0;
  for (let i = 0; i < csv.length; i++) {
    const c = csv.charCodeAt(i);
    if (c === 44) {
      const v = out;
      if (v === null) return null;
      v.push(n);
      n = 0;
      continue;
    }
    if (c < 48 || c > 57) return null;
    n = n * 10 + (c - 48);
    if (n > 255) return null;
  }
  const v = out;
  if (v === null) return null;
  v.push(n);
  return Buffer.from(v).toString("utf8");
}

// ------------------------------------------------------------ row decision (pure)

/** The `decoded` view's `evidence` of a page row (docs/04 §33): where and how
 * the plaintext of one observe pause was matched. */
export type PageEvidence = {
  sink: string;
  /** The scope-string sha that matched (scope-string attributions only). */
  match: string | null;
  frames: Array<{ url: string; line: number; column: number; function: string }>;
  at: number;
  /** Live suspects the pause was confused with (unattributed rows only). */
  candidates?: string[];
};

/**
 * One observe pause decided: what the CDP side gathered. Pure functions below
 * turn this into the row to file, or the reason nothing was.
 */
export type ObserveMatch = {
  attribution: Attribution;
  /** The string-value shas of the pausing call frames' scopes (the walk's hit set). */
  scopeShas: readonly string[];
  /** The caller frames the plaintext was read from (already capped). */
  frames: PageEvidence["frames"];
  plaintext: { best: PlainCandidate | null; oversize: boolean };
  /** Wall clock ms of the decision. */
  now: number;
  sink: SinkName;
};

/** What one decided JSON.parse pause files — the recorder stores the text as
 * the view's blob, assigns seq, appends the sidecar line — or why nothing was. */
export type ObserveRow =
  | { row: { request: string | null; direction: "response"; mime: string; text: string; evidence: PageEvidence } }
  | { skip: "unattributed-capped" }
  | { skip: "plaintext-missing" }
  | { skip: "plaintext-too-large" };

/**
 * docs/04 §33 row decision, JSON.parse pauses only (D1: the evidence sinks
 * are counted and resumed without a row on this path). Attributed plaintext
 * files under the suspect's request; an unattributed row keeps its plaintext
 * (`request: null`, the candidates it was confused with) up to
 * UNATTRIBUTED_CAP per recording (D7); `unattributedKept` is how many the
 * recording already has. A plaintext that cannot be read from the pausing
 * scope, or that no live suspect exists to take, is not filed — the counters
 * say why. Attribution is never by recency.
 */
export function observeRow(m: ObserveMatch, unattributedKept: number): ObserveRow {
  const a = m.attribution;
  if (a.kind === "armed-empty") return { skip: "plaintext-missing" };
  const pt = m.plaintext;
  if (pt.best === null) return pt.oversize ? { skip: "plaintext-too-large" } : { skip: "plaintext-missing" };
  if (a.kind === "unattributed") {
    if (unattributedKept >= UNATTRIBUTED_CAP) return { skip: "unattributed-capped" };
    return {
      row: {
        request: null,
        direction: "response",
        mime: "application/json",
        text: pt.best.text,
        evidence: { sink: m.sink, match: null, frames: m.frames, at: m.now, candidates: a.candidates },
      },
    };
  }
  // scope-string: the first sha of this suspect the walk saw in the scopes.
  const match = a.kind === "scope-string" ? (a.suspect.shas.find((h) => m.scopeShas.includes(h)) ?? null) : null;
  return {
    row: {
      request: a.suspect.request,
      direction: "response",
      mime: "application/json",
      text: pt.best.text,
      evidence: { sink: m.sink, match, frames: m.frames, at: m.now },
    },
  };
}