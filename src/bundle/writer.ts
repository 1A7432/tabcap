// Bundle writer (docs/04 §2, §3): assigns `seq`, appends one JSON line per
// event, stores blobs, keeps manifest.json fresh.
// - Lines are batched in memory and appended at least every `flushMs` (100 ms)
//   and on close(). Append-only: a crash loses at most the unflushed batch.
// - manifest.json is rewritten (temp + rename) every `manifestMs` (5 s) and on
//   close(); close() stamps `finished`.
// - Extra fields on events are written through unchanged; `seq` is always the
//   first key of the line.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, oneOf } from "../shared/json.ts";
import { log } from "../shared/log.ts";
import { nowMs } from "../shared/time.ts";
import { BlobStore, type PutResult } from "./blobs.ts";
import {
  EVENTS_FILE,
  MANIFEST_FILE,
  blobBytesOnDisk,
  emptyCounts,
  newManifest,
  readManifest,
  writeManifest,
  type NewManifestOptions,
} from "./manifest.ts";
import { parseEventsText } from "./reader.ts";
import type { Actor, Manifest, ManifestCounts, RawEvent, UnsequencedEvent } from "./types.ts";

export type WriterOptions = {
  /** Used when the directory has no manifest yet. `created` defaults to now(). */
  init?: Omit<NewManifestOptions, "created"> & { created?: number };
  /** Start from this manifest instead (copies: redaction, import). */
  manifest?: Manifest;
  now?: () => number;
  flushMs?: number;
  manifestMs?: number;
  sizeCap?: number;
  /** Applied to every events.jsonl line before it is written (known proxy secrets, 0.4-D); must keep the line valid JSON. */
  scrubLine?: (line: string) => string;
};

const ACTORS: readonly Actor[] = ["human", "ai", "system"];

/** Add one event to running counts (same rules as manifest.computeCounts). */
function countEvent(c: ManifestCounts, e: RawEvent): void {
  c.events++;
  if (e.kind !== "request") return;
  c.requests++;
  const resp = e["response"];
  if (!isRecord(resp)) return;
  const body = resp["body"];
  if (isRecord(body) && typeof body["blob"] === "string") c.bodies++;
  const missing = resp["bodyMissing"];
  if (isRecord(missing) && typeof missing["reason"] === "string") {
    c.bodyMissing[missing["reason"]] = (c.bodyMissing[missing["reason"]] ?? 0) + 1;
  }
}

const isActor = (v: unknown): v is Actor => oneOf(ACTORS, v);

/**
 * Validate the envelope and build the stored line object. Envelope fields come
 * first in spec order (§3); every other field follows unchanged.
 */
function toStored(seq: number, body: Record<string, unknown>): RawEvent {
  const bad = (what: string) =>
    new TabcapError("bad-input", `event rejected by writer: ${what}`, "Fix the producer of this event; every event needs ts, mono, kind, actor, tab, cmd (docs/04 §3).");
  const { seq: _ignored, ts, mono, kind, actor, tab, cmd, ...rest } = body;
  if (typeof ts !== "number" || !Number.isFinite(ts)) throw bad("ts must be a finite number");
  if (mono !== null && (typeof mono !== "number" || !Number.isFinite(mono))) throw bad("mono must be a number or null");
  if (typeof kind !== "string" || kind === "") throw bad("kind must be a non-empty string");
  if (!isActor(actor)) throw bad("actor must be human|ai|system");
  if (tab !== null && typeof tab !== "string") throw bad("tab must be a string or null");
  if (cmd !== null && typeof cmd !== "string") throw bad("cmd must be a string or null");
  return { seq, ts, mono, kind, actor, tab, cmd, ...rest };
}

export class BundleWriter {
  readonly dir: string;
  readonly blobs: BlobStore;
  private manifest: Manifest;
  private counts: ManifestCounts;
  private seq: number;
  private pending: string[] = [];
  private fh: FileHandle;
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestTimer: ReturnType<typeof setInterval> | null = null;
  private failure: unknown = null;
  private closed = false;
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly scrubLine: ((line: string) => string) | null;

  private constructor(dir: string, fh: FileHandle, manifest: Manifest, counts: ManifestCounts, lastSeq: number, opts: WriterOptions) {
    this.dir = dir;
    this.fh = fh;
    this.manifest = manifest;
    this.counts = counts;
    this.seq = lastSeq;
    this.now = opts.now ?? nowMs;
    this.flushMs = opts.flushMs ?? 100;
    this.scrubLine = opts.scrubLine ?? null;
    this.blobs = new BlobStore(dir, opts.sizeCap === undefined ? {} : { sizeCap: opts.sizeCap });
    const manifestMs = opts.manifestMs ?? 5000;
    this.manifestTimer = setInterval(() => this.queueManifest(), manifestMs);
    this.manifestTimer.unref();
  }

  /** Create a new bundle directory, or reopen an unfinished one for appending. */
  static async open(dir: string, opts: WriterOptions = {}): Promise<BundleWriter> {
    // docs/04 §16: bundle directory 0700, events.jsonl / manifest.json / blobs 0600.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = opts.now ?? nowMs;
    const eventsPath = join(dir, EVENTS_FILE);
    let manifest: Manifest;
    let counts = emptyCounts();
    let lastSeq = 0;
    let needsNewline = false;
    if (existsSync(join(dir, MANIFEST_FILE))) {
      manifest = readManifest(dir);
      if (manifest.finished !== undefined) {
        throw new TabcapError("conflict", `bundle ${dir} is already finished`, "Record into a new bundle directory; finished bundles are read-only.");
      }
      if (existsSync(eventsPath)) {
        const text = readFileSync(eventsPath, "utf8");
        const parsed = parseEventsText(text);
        for (const e of parsed.events) {
          countEvent(counts, e);
          lastSeq = Math.max(lastSeq, e.seq);
        }
        // Keep append-only: a partial tail line stays as-is and is reported
        // by the reader as a damaged line; new lines start on a fresh line.
        needsNewline = text.length > 0 && !text.endsWith("\n");
      }
      counts.blobBytes = blobBytesOnDisk(dir);
    } else {
      if (existsSync(eventsPath) && statSync(eventsPath).size > 0) {
        throw new TabcapError("conflict", `${dir} has events.jsonl but no manifest.json`, "Use an empty directory for a new bundle.");
      }
      manifest = opts.manifest !== undefined ? structuredClone(opts.manifest) : newManifest({ ...opts.init, created: opts.init?.created ?? now() });
      delete manifest.finished;
      counts = emptyCounts();
    }
    const fh = await open(eventsPath, "a", 0o600);
    if (needsNewline) await fh.write("\n");
    const w = new BundleWriter(dir, fh, manifest, counts, lastSeq, opts);
    w.blobs.ensureRoot();
    w.writeManifestNow();
    return w;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Current manifest snapshot (counts included). */
  snapshot(): Manifest {
    return { ...structuredClone(this.manifest), counts: structuredClone(this.counts) };
  }

  /** Mutate manifest fields (session tabs, mode, notes, sample index ...). */
  updateManifest(fn: (m: Manifest) => void): void {
    fn(this.manifest);
  }

  /**
   * Append an event; the writer assigns the next seq. Pass a function when the
   * event needs its own seq (e.g. `id: "r-" + seq`, `nav: "n-" + seq`).
   */
  append(ev: UnsequencedEvent | ((seq: number) => UnsequencedEvent)): RawEvent {
    this.assertOpen();
    const seq = this.seq + 1;
    const body = typeof ev === "function" ? ev(seq) : ev;
    return this.push(seq, body);
  }

  /** Append an event that already has a seq (restore from HAR `_events`, copies). */
  appendRestored(ev: RawEvent): RawEvent {
    this.assertOpen();
    if (!Number.isSafeInteger(ev.seq) || ev.seq <= this.seq) {
      throw new TabcapError("bad-input", `restored event seq ${ev.seq} is not greater than ${this.seq}`, "Restored events must be in strictly increasing seq order.");
    }
    return this.push(ev.seq, ev);
  }

  private push(seq: number, body: Record<string, unknown>): RawEvent {
    const stored = toStored(seq, body);
    const json = JSON.stringify(stored);
    const line = this.scrubLine === null ? json : this.scrubLine(json);
    this.seq = seq;
    countEvent(this.counts, stored);
    this.pending.push(line + "\n");
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.queueFlush();
      }, this.flushMs); // not unref'd: pending lines must reach disk even if close() is forgotten
    }
    return stored;
  }

  async putBlob(data: Uint8Array | string): Promise<PutResult> {
    this.assertOpen();
    const r = await this.blobs.put(data);
    if (r.outcome === "stored" && !r.existed) this.counts.blobBytes += r.size;
    return r;
  }

  /** Write all pending lines now. */
  async flush(): Promise<void> {
    this.queueFlush();
    await this.chain;
    this.rethrow();
  }

  /** Flush, fsync, stamp `finished` (unless null) and write the manifest. */
  async close(opts: { finished?: number | null } = {}): Promise<Manifest> {
    if (this.closed) return this.snapshot();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.manifestTimer !== null) clearInterval(this.manifestTimer);
    this.flushTimer = null;
    this.manifestTimer = null;
    this.queueFlush();
    await this.chain;
    this.closed = true;
    await this.fh.sync();
    await this.fh.close();
    this.rethrow();
    const finished = opts.finished === undefined ? this.now() : opts.finished;
    if (finished !== null) this.manifest.finished = finished;
    this.writeManifestNow();
    return this.snapshot();
  }

  private queueFlush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    this.pending = [];
    this.chain = this.chain.then(async () => {
      try {
        await this.fh.write(text);
      } catch (e) {
        this.failure ??= e;
        log.error("events.jsonl append failed", { dir: this.dir, error: String(e) });
      }
    });
  }

  private queueManifest(): void {
    this.chain = this.chain.then(() => {
      try {
        this.writeManifestNow();
      } catch (e) {
        log.warn("manifest refresh failed", { dir: this.dir, error: String(e) });
      }
    });
  }

  private writeManifestNow(): void {
    writeManifest(this.dir, this.snapshot());
  }

  private assertOpen(): void {
    if (this.closed) throw new TabcapError("conflict", "bundle writer is closed", "Open a new writer; a closed bundle is final.");
    this.rethrow();
  }

  private rethrow(): void {
    if (this.failure !== null) {
      const e = this.failure;
      throw new TabcapError("io", `events.jsonl write failed: ${e instanceof Error ? e.message : String(e)}`, "Check free disk space and permissions on the bundle directory.");
    }
  }
}
