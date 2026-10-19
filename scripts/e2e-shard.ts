// CI e2e shards (owner decision 2026-10-19): the e2e files split into N groups
// of about equal time, one runner each (same-machine parallel runs would bring
// back the timing flakes the e2e tests were hardened against).
//
//   bun scripts/e2e-shard.ts 2/3            this shard's files, one per line
//   bun scripts/e2e-shard.ts --update <ci job log>...
//                                           rewrite test/e2e/timings.json from the
//                                           e2e job logs (bun test prints a header per
//                                           file; a file's time is the gap to the next)
//
// Weights come from test/e2e/timings.json (seconds, the slower OS); a file not in
// it weighs the median, so new files still spread. Greedy longest-first:
// deterministic for the same files and table, every file in exactly one shard.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const E2E = join(ROOT, "test", "e2e");
const TIMINGS = join(E2E, "timings.json");

/** Pure: shard `index` (1-based) of `count` for these files. */
export function shard(files: readonly string[], times: Record<string, number>, index: number, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) throw new Error(`bad shard ${index}/${count}`);
  const known = files.map((f) => times[f]).filter((t): t is number => typeof t === "number" && t > 0).sort((a, b) => a - b);
  const median = known.length > 0 ? (known[Math.floor(known.length / 2)] ?? 1) : 1;
  const weight = (f: string) => (typeof times[f] === "number" && (times[f] ?? 0) > 0 ? (times[f] ?? median) : median);
  const order = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const bins = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < count; i++) if ((bins[i]?.total ?? 0) < (bins[best]?.total ?? 0)) best = i;
    const bin = bins[best];
    if (bin === undefined) continue;
    bin.total += weight(f);
    bin.files.push(f);
  }
  return (bins[index - 1]?.files ?? []).sort();
}

/** Pure: per-file seconds from one e2e job log (GitHub timestamps on every line). */
export function timesFromLog(text: string): Record<string, number> {
  const heads: { at: number; file: string }[] = [];
  let last: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (?:##\[group\])?(test[\\/]e2e[\\/]\S+\.test\.ts):\s*$/.exec(line);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      heads.push({ at: Date.parse(m[1]), file: m[2].replaceAll("\\", "/") });
      continue;
    }
    const r = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) Ran \d+ tests? across/.exec(line);
    if (r !== null && r[1] !== undefined) last = Date.parse(r[1]);
  }
  const out: Record<string, number> = {};
  heads.forEach((h, i) => {
    const end = heads[i + 1]?.at ?? last;
    if (end !== null && end !== undefined && end >= h.at) out[h.file] = Math.round((end - h.at) / 100) / 10;
  });
  return out;
}

function e2eFiles(): string[] {
  return readdirSync(E2E)
    .filter((f) => f.endsWith(".e2e.test.ts"))
    .map((f) => `test/e2e/${f}`)
    .sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--update") {
    const merged: Record<string, number> = {};
    for (const log of args.slice(1)) for (const [f, t] of Object.entries(timesFromLog(readFileSync(log, "utf8")))) merged[f] = Math.max(merged[f] ?? 0, t);
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(TIMINGS, JSON.stringify(sorted, null, 1) + "\n");
    console.error(`wrote ${Object.keys(sorted).length} files to ${TIMINGS}`);
  } else {
    const m = /^(\d+)\/(\d+)$/.exec(args[0] ?? "");
    if (m === null) {
      console.error("usage: bun scripts/e2e-shard.ts <index>/<count> | --update <log>...");
      process.exit(2);
    }
    const times = JSON.parse(readFileSync(TIMINGS, "utf8")) as Record<string, number>;
    for (const f of shard(e2eFiles(), times, Number(m[1]), Number(m[2]))) console.log(f);
  }
}
