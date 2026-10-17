// `tabcap bundle decode <bundle> [--plugin name]` (0.6-B, docs/04 §28): run
// decode plugins over a finished bundle, so a recording made before the
// plugin existed gets decoded views too. For every request whose request /
// response body a plugin takes, the plaintext goes to a new blob and the view
// is appended to the bundle's decoded.jsonl sidecar (bundle/decoded.ts); the
// reader overlays it onto the request events, so every consumer sees it as
// if the recorder had written it.
//
// events.jsonl and manifest.json are never touched (docs/04 §1: a recording
// does not change after the fact; owner ruling 10-16). Unfinished bundles
// are refused. Rules, against the view a reader sees now (inline or the
// sidecar's last entry): a side no selected plugin takes is left alone; an
// identical view is not appended again (`unchanged`), so a re-run appends
// nothing; a new or different `ok` view is appended; a plugin that answers `declined` (None / null: not mine) writes no
// view and is counted as `declined`, not as a failure; a failure never
// replaces an `ok` view (`kept`).
// 0.6-V (owner decisions 10-17): a CORS preflight (per request) and a 0-byte
// side are not sent to any plugin and are counted in `skipped`; a decline by
// the plugin whose `ok:false` view a side shows now appends a `declined` row
// that readers treat as no view (bundle/decoded.ts), counted as `superseded`.

import { TabcapError } from "../shared/envelope.ts";
import { str, num } from "../shared/json.ts";
import { BlobStore } from "./blobs.ts";
import { readManifest } from "./manifest.ts";
import { BundleReader } from "./reader.ts";
import { appendSidecar, declinedRow, parseDecoded, readSidecar, type DecodedView } from "./decoded.ts";
import type { Headers, RequestEvent } from "./types.ts";
import { decodedField, decodeSkip, isPreflightOf, type DecodeDirection, type DecodeJob, type DecodeOutcome } from "../daemon/hooks/decode.ts";

/** What `bundle decode` needs from the decode plugins (hooks/decode.ts DecodeSession). */
export type BundleDecoder = { decode(job: DecodeJob, declined?: (plugin: string, version: string) => void): Promise<DecodeOutcome | null> };

export type DecodedRow = { request: string; direction: DecodeDirection; by: string; ok: boolean; mime: string | null; bytes: number | null; error?: string; kept?: true; superseded?: true };

export type BundleDecodeResult = {
  bundle: string;
  requests: number;
  /** ok views appended to decoded.jsonl */
  decoded: number;
  /** failed views appended (sides with no ok view before) */
  failed: number;
  /** failures not appended because the side already has an ok view */
  kept: number;
  /** sides every matching plugin declined (decode() returned None / null: not mine); no view written, not a failure */
  declined: number;
  /** declines per plugin (a plugin may decline a side another one decoded) */
  declinedBy: Record<string, number>;
  /** 0.6-V: not offered to any plugin — CORS preflight requests, sides with a 0-byte body */
  skipped: { preflight: number; empty: number };
  /** views identical to what the bundle already has, not appended */
  unchanged: number;
  /** 0.6-V: declined rows appended — the declining plugin's own earlier failure on the side is no longer shown */
  superseded: number;
  /** sidecar lines appended by this run */
  appended: number;
  rows: DecodedRow[];
  /** Rows listed (the counts cover all). */
  truncated: boolean;
};

export const MAX_ROWS = 200;

function headerValue(h: Headers, name: string): string | null {
  const v = h[name];
  return typeof v === "string" ? v : (v?.[0] ?? null);
}

/** The bodies of one request the plugins may take, as the recorder offers them.
 * 0.6-V: a CORS preflight offers nothing (`preflight`: once per request), a
 * 0-byte side is left out (`empty`: once per side). */
export function jobsOf(r: RequestEvent, store: BlobStore): { jobs: DecodeJob[]; skipped: { preflight: number; empty: number } } {
  const jobs: DecodeJob[] = [];
  const skipped = { preflight: 0, empty: 0 };
  if (isPreflightOf(r.method, r.initiator?.type, r.request.headers)) {
    skipped.preflight++;
    return { jobs, skipped };
  }
  const base = { id: r.id, url: r.url, method: r.method, requestHeaders: r.request.headers };
  const offer = (job: DecodeJob): void => {
    if (decodeSkip({ ...job, initiatorType: r.initiator?.type }) === "empty") skipped.empty++;
    else jobs.push(job);
  };
  const pd = r.request.postData;
  if (pd !== null) {
    const bytes = "inline" in pd ? new TextEncoder().encode(pd.inline) : store.tryRead(pd.blob);
    if (bytes !== null) offer({ ...base, direction: "request", response: null, body: bytes, mime: headerValue(r.request.headers, "content-type") });
  }
  const resp = r.response;
  if (resp !== null && resp.body !== null) {
    const bytes = store.tryRead(resp.body.blob);
    if (bytes !== null) offer({ ...base, direction: "response", response: { status: resp.status, headers: resp.headers }, body: bytes, mime: resp.mimeType ?? headerValue(resp.headers, "content-type") });
  }
  return { jobs, skipped };
}

const same = (a: DecodedView | undefined, b: DecodedView | undefined): boolean =>
  a !== undefined && b !== undefined && a.by === b.by && a.version === b.version && a.ok === b.ok && a.blob === b.blob && a.mime === b.mime && (a.error ?? null) === (b.error ?? null);

export async function decodeBundle(dir: string, dec: BundleDecoder, now: () => number = Date.now): Promise<BundleDecodeResult> {
  const manifest = readManifest(dir);
  if (manifest.finished === undefined) {
    throw new TabcapError("conflict", `bundle ${dir} is not finished (still recording, or interrupted)`, "Stop the recording first (`tabcap net stop`); bundle decode only works on finished bundles.");
  }
  const reader = BundleReader.open(dir);
  const store = new BlobStore(dir);
  let seq = readSidecar(dir)?.lastSeq ?? 0;
  const result: BundleDecodeResult = { bundle: dir, requests: 0, decoded: 0, failed: 0, kept: 0, declined: 0, declinedBy: {}, skipped: { preflight: 0, empty: 0 }, unchanged: 0, superseded: 0, appended: 0, rows: [], truncated: false };
  const addRow = (row: DecodedRow) => {
    if (result.rows.length < MAX_ROWS) result.rows.push(row);
    else result.truncated = true;
  };
  for (const r of reader.requests()) {
    result.requests++;
    const { jobs, skipped } = jobsOf(r, store);
    result.skipped.preflight += skipped.preflight;
    result.skipped.empty += skipped.empty;
    for (const job of jobs) {
      const declinedNow = new Map<string, string>();
      const out = await dec.decode(job, (name, version) => {
        declinedNow.set(name, version);
        result.declinedBy[name] = (result.declinedBy[name] ?? 0) + 1;
      });
      const old = job.direction === "request" ? r.request.decoded : r.response?.decoded;
      if (out === null) {
        if (declinedNow.size > 0) result.declined++;
        // 0.6-V: the plugin whose failure the side shows now declines it — the
        // stale failure is superseded by a declined row (readers: no view).
        const version = old === undefined || old.ok ? undefined : declinedNow.get(old.by);
        if (old !== undefined && version !== undefined) {
          seq++;
          appendSidecar(dir, { seq, request: r.id, direction: job.direction, decoded: declinedRow(old.by, version, job.direction), at: now() });
          result.appended++;
          result.superseded++;
          addRow({ request: r.id, direction: job.direction, by: old.by, ok: false, mime: null, bytes: null, error: "declined", superseded: true });
        }
        continue;
      }
      if (!out.ok && old !== undefined && old.ok) {
        result.kept++;
        addRow({ request: r.id, direction: job.direction, by: out.by, ok: false, mime: null, bytes: null, error: out.error, kept: true });
        continue;
      }
      const field = await decodedField(out, (b) => store.put(b));
      if (same(parseDecoded(field), old)) {
        result.unchanged++;
        continue;
      }
      seq++;
      appendSidecar(dir, { seq, request: r.id, direction: job.direction, decoded: field, at: now() });
      result.appended++;
      const ok = field["ok"] === true;
      if (ok) result.decoded++;
      else result.failed++;
      const error = str(field, "error");
      addRow({ request: r.id, direction: job.direction, by: out.by, ok, mime: str(field, "mime"), bytes: num(field, "bytes"), ...(error === null ? {} : { error }) });
    }
  }
  return result;
}

/** Compact human rendering (`--text`). */
export function renderBundleDecodeText(r: BundleDecodeResult & { plugins?: unknown }): string {
  const skipped = r.skipped.preflight + r.skipped.empty > 0 ? `, ${r.skipped.preflight} preflight(s) and ${r.skipped.empty} empty bod(ies) not offered` : "";
  const out = [`bundle decode ${r.bundle}: ${r.decoded} view(s) added, ${r.failed} failed, ${r.declined} declined, ${r.superseded} superseded, ${r.kept} kept, ${r.unchanged} unchanged, over ${r.requests} request(s)${skipped}`];
  for (const row of r.rows) out.push(`  ${row.request} ${row.direction} ${row.by} ${row.ok ? `ok ${row.mime ?? "?"} ${row.bytes ?? 0} B` : row.superseded === true ? "declined now: its earlier failure is no longer shown" : `${row.kept === true ? "kept old view; " : ""}failed: ${row.error ?? ""}`}`);
  if (r.truncated) out.push(`  … first ${MAX_ROWS} rows listed`);
  return out.join("\n");
}
