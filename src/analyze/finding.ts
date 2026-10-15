// `--save` for analysis commands: append one `finding` event (docs/04 §4.1)
// to a finished bundle. Analysis never runs inside the recorder, so the
// BundleWriter (which refuses finished bundles) is not used; the line is
// appended with seq = last seq + 1 and manifest counts.events is bumped.
// Unfinished bundles are refused: a live recorder owns their seq counter.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { nowMs } from "../shared/time.ts";
import { EVENTS_FILE, writeManifest } from "../bundle/manifest.ts";
import { BundleReader } from "../bundle/reader.ts";
import type { FindingEvent } from "../bundle/types.ts";

export type FindingInput = {
  actor: "ai" | "human";
  tool: FindingEvent["tool"];
  grade: FindingEvent["grade"];
  claim: string;
  /** docs/04 §4.1 evidence items ({request, path} | {ws, frame} | {blob}; find adds {console: seq}). */
  evidence: Record<string, unknown>[];
  input: unknown;
  output: unknown;
};

export type SavedFinding = { bundle: string; seq: number };

export function appendFinding(bundleDir: string, f: FindingInput, now: () => number = nowMs): SavedFinding {
  const reader = BundleReader.open(bundleDir);
  if (!reader.isComplete()) {
    throw new TabcapError("conflict", `bundle ${bundleDir} is not finished (the recording is still running or was interrupted)`, "Stop the recording first (tabcap net stop), then rerun with --save.");
  }
  const path = join(bundleDir, EVENTS_FILE);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lastSeq = reader.events.reduce((m, e) => Math.max(m, e.seq), 0);
  const seq = lastSeq + 1;
  const line = JSON.stringify({ seq, ts: now(), mono: null, kind: "finding", actor: f.actor, tab: null, cmd: null, tool: f.tool, grade: f.grade, claim: f.claim, evidence: f.evidence, input: f.input, output: f.output });
  const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(prefix + line + "\n", "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const m = reader.manifest;
  writeManifest(bundleDir, { ...m, counts: { ...m.counts, events: m.counts.events + 1 } });
  return { bundle: bundleDir, seq };
}
