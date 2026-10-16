// `tabcap bundle decode <bundle> [--plugin name]` (0.6-B, docs/04 §26): run
// decode plugins over a finished bundle, so a recording made before the
// plugin existed gets decoded views too. For every request whose request /
// response body a plugin takes, the plaintext goes to a new blob and the
// event's side gets `decoded`, exactly as the recorder writes it live.
//
// This is the one command that rewrites events.jsonl: the file is replaced
// atomically (temp + fsync + rename), only request lines that gain or change
// a `decoded` field are re-serialised, every other line stays byte for byte,
// `seq` and ids never change. Unfinished bundles are refused (a recording may
// still be appending). Rules: a side no selected plugin takes keeps what it
// has; a new `ok` view replaces the old one; a failure never replaces an
// existing `ok` view (it is counted as `kept`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, num, str } from "../shared/json.ts";
import { BlobStore } from "./blobs.ts";
import { EVENTS_FILE, blobBytesOnDisk, readManifest, writeFileAtomic, writeManifest } from "./manifest.ts";
import { parseRequest, toRawEvent } from "./reader.ts";
import { parseDecoded } from "./decoded.ts";
import type { Headers, RequestEvent } from "./types.ts";
import { decodedField, type DecodeDirection, type DecodeJob, type DecodeOutcome } from "../daemon/hooks/decode.ts";

/** What `bundle decode` needs from the decode plugins (hooks/decode.ts DecodeSession). */
export type BundleDecoder = { decode(job: DecodeJob): Promise<DecodeOutcome | null> };

export type DecodedRow = { request: string; direction: DecodeDirection; by: string; ok: boolean; mime: string | null; bytes: number | null; error?: string; kept?: true };

export type BundleDecodeResult = {
  bundle: string;
  requests: number;
  decoded: number;
  failed: number;
  kept: number;
  rows: DecodedRow[];
  /** Rows listed (the counts cover all). */
  truncated: boolean;
};

export const MAX_ROWS = 200;

function headerValue(h: Headers, name: string): string | null {
  const v = h[name];
  return typeof v === "string" ? v : (v?.[0] ?? null);
}

/** The bodies of one request the plugins may take, as the recorder offers them. */
function jobsOf(r: RequestEvent, store: BlobStore): DecodeJob[] {
  const jobs: DecodeJob[] = [];
  const base = { id: r.id, url: r.url, method: r.method, requestHeaders: r.request.headers };
  const pd = r.request.postData;
  if (pd !== null) {
    const bytes = "inline" in pd ? new TextEncoder().encode(pd.inline) : store.tryRead(pd.blob);
    if (bytes !== null) jobs.push({ ...base, direction: "request", response: null, body: bytes, mime: headerValue(r.request.headers, "content-type") });
  }
  const resp = r.response;
  if (resp !== null && resp.body !== null) {
    const bytes = store.tryRead(resp.body.blob);
    if (bytes !== null) jobs.push({ ...base, direction: "response", response: { status: resp.status, headers: resp.headers }, body: bytes, mime: resp.mimeType ?? headerValue(resp.headers, "content-type") });
  }
  return jobs;
}

export async function decodeBundle(dir: string, dec: BundleDecoder): Promise<BundleDecodeResult> {
  const manifest = readManifest(dir);
  if (manifest.finished === undefined) {
    throw new TabcapError("conflict", `bundle ${dir} is not finished (still recording, or interrupted)`, "Stop the recording first (`tabcap net stop`); bundle decode rewrites events.jsonl and only works on finished bundles.");
  }
  const eventsPath = join(dir, EVENTS_FILE);
  const text = readFileSync(eventsPath, "utf8");
  const store = new BlobStore(dir);
  const lines = text.split("\n");
  const result: BundleDecodeResult = { bundle: dir, requests: 0, decoded: 0, failed: 0, kept: 0, rows: [], truncated: false };
  const addRow = (row: DecodedRow) => {
    if (result.rows.length < MAX_ROWS) result.rows.push(row);
    else result.truncated = true;
  };
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes('"request"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      continue; // a damaged line stays as it is
    }
    const ev = toRawEvent(obj);
    if (typeof ev === "string" || ev.kind !== "request") continue;
    const r = parseRequest(ev);
    if (typeof r === "string") continue;
    result.requests++;
    let lineChanged = false;
    for (const job of jobsOf(r, store)) {
      const out = await dec.decode(job);
      if (out === null) continue;
      const sideKey = job.direction === "request" ? "request" : "response";
      const side = ev[sideKey];
      if (!isRecord(side)) continue;
      const old = parseDecoded(side["decoded"]);
      if (!out.ok && old !== undefined && old.ok) {
        result.kept++;
        addRow({ request: r.id, direction: job.direction, by: out.by, ok: false, mime: null, bytes: null, error: out.error, kept: true });
        continue;
      }
      const field = await decodedField(out, (b) => store.put(b));
      side["decoded"] = field;
      lineChanged = true;
      const ok = field["ok"] === true;
      if (ok) result.decoded++;
      else result.failed++;
      const error = str(field, "error");
      addRow({ request: r.id, direction: job.direction, by: out.by, ok, mime: str(field, "mime"), bytes: num(field, "bytes"), ...(error === null ? {} : { error }) });
    }
    if (lineChanged) {
      lines[i] = JSON.stringify(ev);
      changed = true;
    }
  }
  if (changed) {
    writeFileAtomic(eventsPath, lines.join("\n"), 0o600);
    writeManifest(dir, { ...manifest, counts: { ...manifest.counts, blobBytes: blobBytesOnDisk(dir) } });
  }
  return result;
}

/** Compact human rendering (`--text`). */
export function renderBundleDecodeText(r: BundleDecodeResult & { plugins?: unknown }): string {
  const out = [`bundle decode ${r.bundle}: ${r.decoded} view(s) stored, ${r.failed} failed, ${r.kept} kept, over ${r.requests} request(s)`];
  for (const row of r.rows) out.push(`  ${row.request} ${row.direction} ${row.by} ${row.ok ? `ok ${row.mime ?? "?"} ${row.bytes ?? 0} B` : `${row.kept === true ? "kept old view; " : ""}failed: ${row.error ?? ""}`}`);
  if (r.truncated) out.push(`  … first ${MAX_ROWS} rows listed`);
  return out.join("\n");
}
