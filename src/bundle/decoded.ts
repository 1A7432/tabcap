// Decoded views (0.6-B, docs/04 §28): plaintext a decode plugin produced from
// a request or response body, stored as a blob beside the original and
// referenced from the `request` event as `request.decoded` /
// `response.decoded`:
//   {by, version, direction, mime, blob, bytes, ok, error?, note?}
// `ok: false` records that the plugin was asked and could not decode (blob
// and bytes null, `error` says why). The original body is never changed.
// Readers treat the field as untrusted: a malformed one is ignored. Views
// added after the recording live in the decoded.jsonl sidecar (below).
// 0.6-V: a sidecar row `{by, version, direction, mime:null, blob:null,
// bytes:null, ok:false, declined:true, error:"declined"}` records that plugin
// `by` now declines the side (decode() returned None): it hides that plugin's
// earlier `ok:false` view and is otherwise no view at all (`latestViews`,
// `overlayEvent`).

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isBlobRef } from "../shared/ids.ts";
import { isRecord, num, str } from "../shared/json.ts";

export type DecodedView = {
  by: string;
  version: string;
  direction: "request" | "response";
  mime: string | null;
  blob: string | null;
  bytes: number | null;
  /** True only when the view has a blob to read. */
  ok: boolean;
  error?: string;
  note?: string;
  /** 0.6-V: a `bundle decode` row saying plugin `by` declines this side now (never a view). */
  declined?: true;
  /** Observe-mode rows (`by:"page"`, docs/04 §33) only. */
  evidence?: DecodedEvidence;
};

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The `evidence` of an observe row (docs/04 §33; 0.6-L): where the plaintext
 * was read. Carried through to readers as is; untrusted like the rest.
 */
export type DecodedEvidence = { sink: string; match: string | null; matchForm?: "raw" | "stripped" | "unquoted" | "urldecoded"; link?: "strong" | "weak"; frames: unknown[]; at: number; candidates?: string[] };

const evidenceOf = (v: unknown): DecodedEvidence | undefined => {
  if (!isRecord(v) || typeof v["sink"] !== "string" || typeof v["at"] !== "number") return undefined;
  const out: DecodedEvidence = { sink: v["sink"], match: str(v, "match"), frames: Array.isArray(v["frames"]) ? v["frames"] : [], at: v["at"] };
  // 0.6-L2: "weak" = attributed only because it was the one armed suspect.
  const link = v["link"];
  if (link === "strong" || link === "weak") out.link = link;
  // 0.6-Q: the form of the ciphertext the strong match was found in.
  const form = v["matchForm"];
  if (form === "raw" || form === "stripped" || form === "unquoted" || form === "urldecoded") out.matchForm = form;
  const c = v["candidates"];
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) out.candidates = c as string[];
  return out;
};

/** The `decoded` field of a request / response side, or undefined when absent or malformed. */
export function parseDecoded(v: unknown): DecodedView | undefined {
  if (!isRecord(v)) return undefined;
  const by = str(v, "by");
  const direction = v["direction"];
  if (by === null || !NAME.test(by) || (direction !== "request" && direction !== "response") || typeof v["ok"] !== "boolean") return undefined;
  const blob = isBlobRef(v["blob"]) ? v["blob"] : null;
  const ok = v["ok"] && blob !== null;
  const error = str(v, "error") ?? (ok ? null : "not decoded");
  const note = str(v, "note");
  const evidence = evidenceOf(v["evidence"]);
  const declined = isDeclinedRow(v);
  return {
    by,
    version: str(v, "version") ?? "",
    direction,
    mime: str(v, "mime"),
    blob,
    bytes: num(v, "bytes"),
    ok,
    ...(error === null ? {} : { error }),
    ...(note === null ? {} : { note }),
    ...(declined ? { declined: true as const } : {}),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** 0.6-V: a declined row (`ok:false, declined:true`) — no view; it hides the
 * same plugin's earlier failure. */
export function isDeclinedRow(v: Record<string, unknown>): boolean {
  return v["ok"] === false && v["declined"] === true;
}

/** The `decoded` row `bundle decode` appends when plugin `by` declines a side
 * whose current view is its own `ok:false` view (0.6-V). */
export function declinedRow(by: string, version: string, direction: "request" | "response"): Record<string, unknown> {
  return { by, version, direction, mime: null, blob: null, bytes: null, ok: false, declined: true, error: "declined" };
}

/** `{decoded}` to spread into a parsed side, or {} when there is none. */
export function decodedOf(v: unknown): { decoded?: DecodedView } {
  const d = parseDecoded(v);
  return d === undefined ? {} : { decoded: d };
}

// ------------------------------------------------------------ the sidecar

/**
 * `tabcap bundle decode` never changes events.jsonl (docs/04 §1: a recording
 * does not change after the fact). Views added later — offline decode, and
 * the observe mode of a live recording (0.6-L) — go to `<bundle>/decoded.jsonl`,
 * append-only, one JSON object per line:
 *   {seq, request:"r-N"|null, direction, decoded:{…same shape as inline…}, at}
 * `seq` numbers the sidecar's own lines from 1. The winner per (request,
 * direction): an ok plugin view outranks an ok `by:"page"` view however late
 * the page line is (0.6-L D4); within one rank the last line wins, and it wins
 * over a view written inline while recording. An observe row without an
 * attribution (`request: null`) overlays nothing: the reader lists it apart.
 * A damaged line is skipped and reported.
 */
export const SIDECAR_FILE = "decoded.jsonl";

export type SidecarEntry = { seq: number; request: string | null; direction: "request" | "response"; decoded: Record<string, unknown>; at: number };
export type SidecarIssue = { line: number; detail: string };
export type Sidecar = { entries: SidecarEntry[]; issues: SidecarIssue[]; lastSeq: number };

const REQ_ID = /^r-[1-9][0-9]*$/;

/** docs/04 §33 D4: an ok plugin view (2) outranks an ok page view (1); ok:false stays last-wins (0);
 * 0.6-V: a declined row ranks below everything (-1). */
const viewRank = (v: Record<string, unknown>): number => (isDeclinedRow(v) ? -1 : v["ok"] === true && v["by"] !== "page" ? 2 : v["ok"] === true ? 1 : 0);

/** A failed (not declined) view by plugin `by`: what a declined row of `by` hides (0.6-V). */
const failedBy = (v: Record<string, unknown> | null | undefined, by: unknown): boolean => v !== null && v !== undefined && v["ok"] !== true && !isDeclinedRow(v) && v["by"] === by;

export function parseSidecarText(text: string): Sidecar {
  const entries: SidecarEntry[] = [];
  const issues: SidecarIssue[] = [];
  let lastSeq = 0;
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(line) as unknown;
    } catch {
      issues.push({ line: i + 1, detail: "not JSON (a truncated last line after an interrupted bundle decode?)" });
      return;
    }
    const seq = isRecord(v) ? v["seq"] : undefined;
    const request = isRecord(v) ? v["request"] : undefined;
    const direction = isRecord(v) ? v["direction"] : undefined;
    const decoded = isRecord(v) ? v["decoded"] : undefined;
    const at = isRecord(v) ? v["at"] : undefined;
    const view = parseDecoded(decoded);
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      // 0.6-L D7: an unattributed observe row files its plaintext with
      // `request: null` — kept for the reader, overlaid onto nothing.
      (!(typeof request === "string" && REQ_ID.test(request)) && request !== null) ||
      (direction !== "request" && direction !== "response") ||
      !isRecord(decoded) ||
      view === undefined ||
      view.direction !== direction
    ) {
      issues.push({ line: i + 1, detail: "not a sidecar entry {seq, request, direction, decoded, at}" });
      return;
    }
    lastSeq = Math.max(lastSeq, seq);
    entries.push({ seq, request, direction, decoded, at: typeof at === "number" ? at : 0 });
  });
  return { entries, issues, lastSeq };
}

/** The bundle's sidecar, or null when there is none. */
export function readSidecar(dir: string): Sidecar | null {
  const p = join(dir, SIDECAR_FILE);
  if (!existsSync(p)) return null;
  return parseSidecarText(readFileSync(p, "utf8"));
}

export const sideKey = (request: string, direction: "request" | "response"): string => `${request}\t${direction}`;

/** The winning `decoded` field per (request, direction): the highest-ranked view
 * (an ok plugin view over an ok page view), the last line within a rank. An
 * unattributed row (`request: null`) is not on a request — never a winner.
 * 0.6-V: a declined row wins only over nothing, another declined row, or the
 * same plugin's failure (which it hides); any later view wins over it. */
export function latestViews(s: Sidecar | null): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of s?.entries ?? []) {
    if (e.request === null) continue;
    const key = sideKey(e.request, e.direction);
    const prev = out.get(key);
    if (prev === undefined || viewRank(e.decoded) >= viewRank(prev) || (isDeclinedRow(e.decoded) && failedBy(prev, e.decoded["by"]))) out.set(key, e.decoded);
  }
  return out;
}

/** A request event with the sidecar's views set on its sides (a copy; other events are returned as they are). */
export function overlayEvent<T extends Record<string, unknown>>(e: T, views: ReadonlyMap<string, Record<string, unknown>>): T {
  if (views.size === 0 || e["kind"] !== "request" || typeof e["id"] !== "string") return e;
  const id = e["id"];
  const inlineRank = (side: "request" | "response"): number => {
    const s = isRecord(e[side]) ? e[side] : null;
    const d = s !== null && isRecord(s["decoded"]) ? s["decoded"] : null;
    return d === null ? -1 : viewRank(d);
  };
  const out: Record<string, unknown> = { ...e };
  // D4 applies to an inline view too: an ok plugin view recorded with the
  // event wins over a later page row; within a rank the later line wins.
  // 0.6-V: a declined row is never a view — it removes the same plugin's
  // inline failure and leaves anything else as it is.
  for (const side of ["request", "response"] as const) {
    const v = views.get(sideKey(id, side));
    const s = e[side];
    if (v === undefined || !isRecord(s)) continue;
    if (isDeclinedRow(v)) {
      if (failedBy(isRecord(s["decoded"]) ? s["decoded"] : null, v["by"])) {
        const { decoded: _hidden, ...rest } = s;
        out[side] = rest;
      }
      continue;
    }
    if (viewRank(v) >= inlineRank(side)) out[side] = { ...s, decoded: v };
  }
  return { ...e, ...out };
}

/** Append one sidecar line: a single write on an O_APPEND descriptor, fsynced (atomic per line). */
export function appendSidecar(dir: string, entry: SidecarEntry): void {
  const fd = openSync(join(dir, SIDECAR_FILE), "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
