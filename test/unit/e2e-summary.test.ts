// The CI e2e guard (scripts/e2e-summary.ts): bun's summary block read from a
// tee'd log, so a shard whose files all skipped fails instead of passing.

import { describe, expect, test } from "bun:test";
import { parseSummary, summaryProblem } from "../../scripts/e2e-summary.ts";

// Shapes as bun 1.4.3 prints them (local run) and as a GitHub job log stores them
// (ci run 39592054080, e2e (windows-latest, 1/3)).
const ALL_SKIPPED = ["bun test v1.4.3 (26aa4e1a9)", "", "test/e2e/v02.e2e.test.ts:", "", " 0 pass", " 2 skip", " 0 fail", "Ran 2 tests across 1 file. [6.00ms]", ""].join("\n");
const GREEN_JOB_LOG = [
  "2026-10-21T11:31:23.3011483Z ##[group]test\\e2e\\v081a.e2e.test.ts:",
  "2026-10-21T11:31:24.0000000Z 1     r-20     post_api_login  200->200  pass",
  "2026-10-21T11:31:32.3384344Z  63 pass",
  "2026-10-21T11:31:32.3384761Z  0 fail",
  "2026-10-21T11:31:32.3385244Z  2106 expect() calls",
  "2026-10-21T11:31:32.3385750Z Ran 63 tests across 13 files. [194.42s]",
].join("\r\n");
const COLOURED = ["\x1b[0m\x1b[32m 1 pass\x1b[0m", " \x1b[0m\x1b[33m1 skip\x1b[0m", " \x1b[0m\x1b[35m1 todo\x1b[0m", "\x1b[0m\x1b[2m 0 fail\x1b[0m", " 1 expect() calls", "Ran 3 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m3.00ms\x1b[0m\x1b[2m]\x1b[0m"].join("\n");

describe("e2e summary guard", () => {
  test("a green shard: counts from the block before the Ran line, timestamps and CRLF stripped", () => {
    const s = parseSummary(GREEN_JOB_LOG);
    expect(s).toEqual({ runs: 1, pass: 63, fail: 0, skip: 0, todo: 0 });
    expect(summaryProblem(s)).toBeNull();
  });

  test("every test skipped -> pass 0 fails the job", () => {
    const s = parseSummary(ALL_SKIPPED);
    expect(s).toEqual({ runs: 1, pass: 0, fail: 0, skip: 2, todo: 0 });
    expect(summaryProblem(s)).toBe("bun test passed nothing (2 skipped, 0 failed): every e2e file skipped; are TABCAP_E2E=1 and TABCAP_CHROME set?");
  });

  test("colours, and a flake hunt's several runs add up", () => {
    expect(parseSummary(COLOURED)).toEqual({ runs: 1, pass: 1, fail: 0, skip: 1, todo: 1 });
    expect(parseSummary([ALL_SKIPPED, GREEN_JOB_LOG, ALL_SKIPPED].join("\n"))).toEqual({ runs: 3, pass: 63, fail: 0, skip: 4, todo: 0 });
  });

  test("no summary at all fails; a stray count line outside the block is not counted", () => {
    expect(summaryProblem(parseSummary("bun test v1.4.3\nerror: something broke\n"))).toBe("no bun test summary in the log: the e2e run did not finish");
    const stray = [" 5 pass", "some test output", " 0 pass", " 3 skip", "Ran 3 tests across 1 file. [1.00ms]"].join("\n");
    expect(parseSummary(stray)).toEqual({ runs: 1, pass: 0, fail: 0, skip: 3, todo: 0 });
  });
});
