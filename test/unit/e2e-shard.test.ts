// CI e2e shards (scripts/e2e-shard.ts): every file in exactly one shard, balanced
// by the timing table, deterministic; timings read from a GitHub job log.

import { describe, expect, test } from "bun:test";
import { shard, timesFromLog } from "../../scripts/e2e-shard.ts";

const files = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `test/e2e/${x}.e2e.test.ts`);
const times: Record<string, number> = Object.fromEntries(files.map((f, i) => [f, (i + 1) * 10]));

describe("e2e shards", () => {
  test("every file exactly once, for 1 to 4 shards", () => {
    for (let n = 1; n <= 4; n++) {
      const all = Array.from({ length: n }, (_, i) => shard(files, times, i + 1, n)).flat();
      expect(all.sort()).toEqual([...files].sort());
    }
  });
  test("balanced by time and deterministic", () => {
    const totals = [1, 2, 3].map((i) => shard(files, times, i, 3).reduce((s, f) => s + (times[f] ?? 0), 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(10);
    expect(shard(files, times, 2, 3)).toEqual(shard([...files].reverse(), times, 2, 3));
  });
  test("a file missing from the table weighs the median and still lands somewhere", () => {
    const extra = [...files, "test/e2e/new.e2e.test.ts"];
    const all = [1, 2, 3].flatMap((i) => shard(extra, times, i, 3));
    expect(all).toContain("test/e2e/new.e2e.test.ts");
    expect(all.length).toBe(extra.length);
  });
  test("bad shard spec", () => {
    expect(() => shard(files, times, 0, 3)).toThrow();
    expect(() => shard(files, times, 4, 3)).toThrow();
  });
});

describe("timings from a job log", () => {
  test("gap between file headers, Windows separators, last file to the summary", () => {
    const log = [
      "2026-10-19T08:38:41.0000000Z ##[group]test\\e2e\\a.e2e.test.ts:",
      "2026-10-19T08:38:42.0000000Z (pass) x [1000.00ms]",
      "2026-10-19T08:38:59.5000000Z ##[group]test\\e2e\\b.e2e.test.ts:",
      "2026-10-19T08:39:10.0000000Z Ran 2 tests across 2 files. [29.00s]",
    ].join("\r\n");
    expect(timesFromLog(log)).toEqual({ "test/e2e/a.e2e.test.ts": 18.5, "test/e2e/b.e2e.test.ts": 10.5 });
  });
});
