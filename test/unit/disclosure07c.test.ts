// 0.7-C progressive disclosure and the output contract: the compact decode
// block of trace status / trace stop (docs/04 §33).

import { describe, expect, test } from "bun:test";
import { decodeBlock, type DecodeCounters } from "../../src/daemon/trace/observe.ts";
import { specOf } from "../../src/cli/commands.ts";

const COUNTERS: DecodeCounters = {
  on: true,
  weakRows: true,
  armed: 2,
  held: 3,
  settling: 1,
  attributed: 5,
  weak: 2,
  unattributed: 1,
  unattributedKept: 1,
  evidenceHits: 7,
  recovered: { console: 4, scope: 2 },
  walks: 9,
  sinks: { resolved: 3, skipped: 0, on: true },
  drops: { plaintextMissing: 1, tooLarge: 0, afterStop: 2, unattributedCapped: 0, rawBody: 3, orphan: 1, unpaired: 0, noFit: 1, weak: 0 },
};

describe("decode block (0.7-C)", () => {
  test("compact by default: strong = attributed − weak, pending = held + settling, dropped = every drop counter summed", () => {
    expect(decodeBlock(COUNTERS, false)).toEqual({ on: true, weakRows: true, rows: { strong: 3, weak: 2, unattributed: 1 }, pending: 4, dropped: 8 });
  });

  test("--verbose adds the counters behind it", () => {
    const v = decodeBlock(COUNTERS, true);
    expect(v).toMatchObject({ on: true, weakRows: true, rows: { strong: 3, weak: 2, unattributed: 1, attributed: 5 }, pending: 4, dropped: 8 });
    expect(v).toMatchObject({ armed: 2, held: 3, settling: 1, unattributedKept: 1, evidenceHits: 7, recovered: { console: 4, scope: 2 }, walks: 9, sinks: { resolved: 3, skipped: 0, on: true } });
    expect(v["drops"]).toEqual(COUNTERS.drops);
    // copies, not the tracer's live objects
    expect(v["drops"]).not.toBe(COUNTERS.drops);
  });

  test("trace status and trace stop take --verbose", () => {
    for (const p of ["trace status", "trace stop"]) expect(specOf(p).flags.some((f) => f.flag === "--verbose" && f.kind === "bool")).toBe(true);
  });
});
