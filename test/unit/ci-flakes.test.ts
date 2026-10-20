// CI failure ledger (scripts/ci-flakes.ts): failed tests read from a
// `gh run view --log-failed` text, one count per (job, test), tallied across runs.

import { describe, expect, test } from "bun:test";
import { failuresFromLog, tally } from "../../scripts/ci-flakes.ts";

const LOG = [
  "e2e (windows-latest, 3/3)\tUNKNOWN STEP\t2026-10-20T09:24:35.9010168Z error: expect(received).toBeGreaterThanOrEqual(expected)",
  "e2e (windows-latest, 3/3)\tUNKNOWN STEP\t2026-10-20T09:24:35.9048175Z (fail) tabcap 0.5-C L2 (context budget on the range) > the list page [6563.51ms]",
  "e2e (windows-latest, 3/3)\tUNKNOWN STEP\t2026-10-20T09:26:29.0166754Z (fail) tabcap 0.5-C L2 (context budget on the range) > the list page [6563.51ms]",
  "e2e (ubuntu-latest, 1/3)\tUNKNOWN STEP\t2026-10-20T09:10:46.1831772Z (fail) tabcap 0.6-J L2 (docs/05 s56) > --trusted uses the same landing [2635.51ms]",
  "e2e (ubuntu-latest, 1/3)\tUNKNOWN STEP\t2026-10-20T09:10:47.0000000Z (pass) something else [1.00ms]",
  "unit (windows-latest)\tL0 unit tests\t2026-10-20T02:52:01.9220922Z (fail) ListEnd ends a paging loop [1787.99ms]\r",
  "not a log line",
].join("\n");

describe("ci-flakes", () => {
  test("one failure per (job, test); timings and the summary repeat dropped", () => {
    expect(failuresFromLog(LOG)).toEqual([
      { job: "e2e (windows-latest, 3/3)", test: "tabcap 0.5-C L2 (context budget on the range) > the list page" },
      { job: "e2e (ubuntu-latest, 1/3)", test: "tabcap 0.6-J L2 (docs/05 s56) > --trusted uses the same landing" },
      { job: "unit (windows-latest)", test: "ListEnd ends a paging loop" },
    ]);
    expect(failuresFromLog("")).toEqual([]);
  });

  test("tally: most failures first, jobs and runs listed once, re-run attempts marked", () => {
    const f = (job: string, t: string) => ({ job, test: t });
    const rows = tally([
      { run: 1, attempt: 1, branch: "main", date: "2026-10-18", failures: [f("e2e (ubuntu-latest, 1/3)", "A")] },
      { run: 2, attempt: 1, branch: "main", date: "2026-10-20", failures: [f("e2e (windows-latest, 3/3)", "A"), f("unit (macos-14)", "B")] },
      { run: 3, attempt: 1, branch: "pr", date: "2026-10-19", failures: [f("e2e (windows-latest, 3/3)", "A")] },
      { run: 3, attempt: 2, branch: "pr", date: "2026-10-19", failures: [] },
    ]);
    expect(rows.map((r) => [r.test, r.count, r.runs, r.last])).toEqual([
      ["A", 3, ["1", "2", "3"], "2026-10-20"],
      ["B", 1, ["2"], "2026-10-20"],
    ]);
    expect(rows[0]?.jobs).toEqual(["e2e (ubuntu-latest, 1/3)", "e2e (windows-latest, 3/3)"]);
  });
});
