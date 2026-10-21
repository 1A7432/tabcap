// CI e2e guard (ci.yml, after `bun test` of a shard or a flake hunt):
//   bun scripts/e2e-summary.ts <e2e.log>
// Every e2e file is `describe.skipIf(!enabled)`, and a run whose tests all skip
// exits 0, so a shard without TABCAP_CHROME would be green having tested nothing.
// This reads bun's summary block(s) from the tee'd log (plain, coloured, or a
// GitHub job log with timestamps), prints the totals and exits 1 when there is no
// summary or nothing passed. Pure functions are exported for
// test/unit/e2e-summary.test.ts.

import { readFileSync } from "node:fs";

export type Summary = { runs: number; pass: number; fail: number; skip: number; todo: number };

const ANSI = /\x1b\[[0-9;]*m/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /;
const COUNT = /^\s*(\d+) (pass|fail|skip|todo)\s*$/;
// Other lines of the block: "12 expect() calls", "1 error", "2 snapshots, 1 written", ...
const OTHER_COUNT = /^\s*\d+ \S/;
const RAN = /^Ran \d+ tests? across \d+ files?\./;

/**
 * Pure: totals over every summary block in `text`. A block is the count lines
 * right before a "Ran N tests across M files." line; a count line anywhere else
 * (a test printing "3 pass") is not counted.
 */
export function parseSummary(text: string): Summary {
  const total: Summary = { runs: 0, pass: 0, fail: 0, skip: 0, todo: 0 };
  let block: Partial<Record<"pass" | "fail" | "skip" | "todo", number>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").replace(STAMP, "");
    const m = COUNT.exec(line);
    if (m !== null && m[1] !== undefined && (m[2] === "pass" || m[2] === "fail" || m[2] === "skip" || m[2] === "todo")) {
      block[m[2]] = Number(m[1]);
    } else if (RAN.test(line)) {
      total.runs += 1;
      total.pass += block.pass ?? 0;
      total.fail += block.fail ?? 0;
      total.skip += block.skip ?? 0;
      total.todo += block.todo ?? 0;
      block = {};
    } else if (line.trim() !== "" && !OTHER_COUNT.test(line)) {
      block = {};
    }
  }
  return total;
}

/** Pure: why this summary must fail the job, or null. */
export function summaryProblem(s: Summary): string | null {
  if (s.runs === 0) return "no bun test summary in the log: the e2e run did not finish";
  if (s.pass === 0) return `bun test passed nothing (${s.skip} skipped, ${s.fail} failed): every e2e file skipped; are TABCAP_E2E=1 and TABCAP_CHROME set?`;
  return null;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("usage: bun scripts/e2e-summary.ts <e2e.log>");
    process.exit(2);
  }
  const s = parseSummary(readFileSync(file, "utf8"));
  console.log(`e2e summary: ${s.pass} pass, ${s.fail} fail, ${s.skip} skip, ${s.todo} todo over ${s.runs} run(s)`);
  const problem = summaryProblem(s);
  if (problem !== null) {
    console.log(`::error::${problem}`);
    process.exit(1);
  }
}
