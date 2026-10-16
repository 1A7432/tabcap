// Decoded views (0.6-B, docs/04 §28): plaintext a decode plugin produced from
// a request or response body, stored as a blob beside the original and
// referenced from the `request` event as `request.decoded` /
// `response.decoded`:
//   {by, version, direction, mime, blob, bytes, ok, error?, note?}
// `ok: false` records that the plugin was asked and could not decode (blob
// and bytes null, `error` says why). The original body is never changed.
// Readers treat the field as untrusted: a malformed one is ignored. Views
// added after the recording live in the decoded.jsonl sidecar (below).

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
};

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  };
}

/** `{decoded}` to spread into a parsed side, or {} when there is none. */
export function decodedOf(v: unknown): { decoded?: DecodedView } {
  const d = parseDecoded(v);
  return d === undefined ? {} : { decoded: d };
}

// ------------------------------------------------------------ the sidecar

/**
 * `tabcap bundle decode` never changes events.jsonl (docs/04 §1: a recording
 * does not change after the fact). Views it adds go to `<bundle>/decoded.jsonl`,
 * append-only, one JSON object per line:
 *   {seq, request:"r-N", direction, decoded:{…same shape as inline…}, at}
 * `seq` numbers the sidecar's own lines from 1. The last line per (request,
 * direction) wins, and it wins over a view written inline while recording.
 * Readers overlay it onto the request events they return; a damaged line is
 * skipped and reported.
 */
export const SIDECAR_FILE = "decoded.jsonl";

export type SidecarEntry = { seq: number; request: string; direction: "request" | "response"; decoded: Record<string, unknown>; at: number };
export type SidecarIssue = { line: number; detail: string };
export type Sidecar = { entries: SidecarEntry[]; issues: SidecarIssue[]; lastSeq: number };

const REQ_ID = /^r-[1-9][0-9]*$/;

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
      typeof request !== "string" ||
      !REQ_ID.test(request) ||
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

/** The winning `decoded` field per (request, direction): the last entry in file order. */
export function latestViews(s: Sidecar | null): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of s?.entries ?? []) out.set(sideKey(e.request, e.direction), e.decoded);
  return out;
}

/** A request event with the sidecar's views set on its sides (a copy; other events are returned as they are). */
export function overlayEvent<T extends Record<string, unknown>>(e: T, views: ReadonlyMap<string, Record<string, unknown>>): T {
  if (views.size === 0 || e["kind"] !== "request" || typeof e["id"] !== "string") return e;
  const id = e["id"];
  const req = views.get(sideKey(id, "request"));
  const resp = views.get(sideKey(id, "response"));
  if (req === undefined && resp === undefined) return e;
  const out: Record<string, unknown> = { ...e };
  if (req !== undefined && isRecord(e["request"])) out["request"] = { ...e["request"], decoded: req };
  if (resp !== undefined && isRecord(e["response"])) out["response"] = { ...e["response"], decoded: resp };
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
