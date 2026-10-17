// 0.7-C progressive disclosure and the output contract: the compact decode
// block of trace status / trace stop (docs/04 §33), and the summaries of
// over-budget answers (src/shared/budget.ts: counts and the first ids, never
// only lengths).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_LIMIT_DEFAULT, SUMMARY_COMMANDS, SUMMARY_FIRST, applyBudget, isBudgeted, summaryOf } from "../../src/shared/budget.ts";
import { bundleList, bundleShorts } from "../../src/shared/paths.ts";
import { decodeBlock, type DecodeCounters } from "../../src/daemon/trace/observe.ts";
import { specOf } from "../../src/cli/commands.ts";

const dir = mkdtempSync(join(tmpdir(), "tabcap-07c-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

describe("cross-bundle answers name bundles by short name (0.7-C)", () => {
  test("short = the directory's basename; a repeated basename gets ~2, ~3", () => {
    expect(bundleShorts(["/a/20261017-x", "/b/20261017-y/", "/c/20261017-x", "/d/20261017-x"])).toEqual(["20261017-x", "20261017-y", "20261017-x~2", "20261017-x~3"]);
    expect(bundleList(["/a/one", "/b/two"])).toEqual([
      { short: "one", dir: "/a/one" },
      { short: "two", dir: "/b/two" },
    ]);
  });
});

// ---------------------------------------------------------------- budget summaries

const N = 400;
const many = <T>(f: (i: number) => T): T[] => Array.from({ length: N }, (_, i) => f(i));
const LONG = "x".repeat(5000);

/** One large synthetic answer per command with its own summary, the keys the summary must carry, and its first rows. */
const CASES: Record<string, { data: Record<string, unknown>; keys: string[]; first?: [string, unknown] }> = {
  "net show": {
    data: { id: "r-1", method: "POST", url: "u", status: 200, request: { headers: Object.fromEntries(many((i) => [`h${i}`, LONG])), postData: { path: "/p", bytes: 9000, head: LONG, truncated: true } }, response: { headers: { a: "1" }, body: { path: "/b", blob: "sha256:x", bytes: 12 } } },
    keys: ["id", "status", "requestHeaders", "requestHeaderNames", "responseHeaders", "postData", "body"],
    first: ["requestHeaderNames", ["h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9"]],
  },
  "net body": {
    data: { id: "r-1", url: "u", path: "/b", bytes: 40000, mime: "text/plain", total: N, shown: N, matches: many((i) => ({ line: i + 1, col: 1, text: LONG })) },
    keys: ["id", "path", "bytes", "total", "matchCount", "matches"],
    first: ["matches", [{ line: 1, col: 1 }]],
  },
  "net grep": {
    data: { regex: "x", total: N, searched: N, more: 0, requests: many((i) => ({ id: `r-${i}`, url: "u", resourceType: "script", count: 1, matches: [{ text: LONG }] })), skipped: [] },
    keys: ["total", "searched", "requestCount", "requests", "skippedCount"],
    first: ["requests", [{ id: "r-0", url: "u", count: 1 }]],
  },
  "analyze find": {
    data: { bundle: "/b", hits: many((i) => ({ ref: `r-${i}`, part: "response", path: "$.a", match: "exact", decode: [], snippet: LONG })), truncated: true, searched: { requests: N, bodies: N, wsFrames: 0, console: 0 }, hints: null },
    keys: ["hitCount", "hits", "searched", "truncated"],
    first: ["hits", [{ ref: "r-0", part: "response", path: "$.a", match: "exact", decode: 0 }]],
  },
  "analyze deps": {
    data: { bundle: "/b", requests: many((i) => ({ id: `r-${i}`, inputs: [{ name: LONG }] })), edges: [], unresolved: many((i) => ({ request: `r-${i}`, location: "query", name: "q" })) },
    keys: ["requests", "inputCount", "inputs", "unresolved", "unresolvedFirst"],
    first: ["unresolvedFirst", [{ request: "r-0", location: "query", name: "q" }]],
  },
  "analyze chain": {
    data: { target: "r-9", steps: many((i) => ({ id: `r-${i}`, needs: [{ hints: LONG }] })), todo: many((i) => ({ request: `r-${i}`, location: "query", name: "q" })), inputs: [] },
    keys: ["target", "stepCount", "steps", "todo", "todoFirst", "inputs"],
    first: ["steps", ["r-0", "r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7", "r-8", "r-9"]],
  },
  "analyze diff": {
    data: { bundles: [{ short: "a", dir: "/x/a", requests: 3 }, { short: "b", dir: "/x/b", requests: 3 }], sessions: 2, groups: many((i) => ({ key: `GET /p${i}`, samples: 2, sessions: 2, params: [{ values: [LONG] }] })), singleSampleGroups: [], summary: { constant: 1 } },
    keys: ["bundles", "groupCount", "groups", "summary"],
    first: ["bundles", [{ short: "a", dir: "/x/a", requests: 3 }, { short: "b", dir: "/x/b", requests: 3 }]],
  },
  "analyze shape": {
    data: { bundle: "/b", endpoints: many((i) => ({ key: `GET /p${i}`, exchanges: 2, notJson: 0, response: { kind: "object", note: LONG } })), unshaped: [] },
    keys: ["endpointCount", "endpoints", "unshaped"],
    first: ["endpoints", [{ key: "GET /p0", exchanges: 2, notJson: 0 }]],
  },
  "analyze schema-diff": {
    data: { bundles: [{ short: "a", dir: "/x/a" }, { short: "b", dir: "/x/b" }], drift: true, summary: { same: 0, drift: N, new: 0, gone: 0 }, endpoints: many((i) => ({ key: `GET /p${i}`, verdict: "drift", added: [LONG], removed: [], changed: [] })) },
    keys: ["drift", "summary", "bundles", "endpointCount", "changed"],
    first: ["changed", [{ key: "GET /p0", verdict: "drift", added: 1, removed: 0, changed: 0 }]],
  },
  "bundle info": {
    data: { dir: "/b", id: "x", complete: true, events: N, counts: { events: N }, kinds: { request: N }, issues: many((i) => ({ line: i + 1, kind: "bad-json", detail: LONG })), warnings: [] },
    keys: ["events", "counts", "kinds", "issueCount", "issues"],
    first: ["issues", [{ line: 1, kind: "bad-json" }]],
  },
  "replay check": {
    data: { bundle: "/b", against: "http://127.0.0.1:1/", totals: { requests: N, same: 0, different: N, errors: 0, unverified: 0, skipped: 0 }, rows: many((i) => ({ id: `r-${i}`, result: "different", diffs: { body: LONG } })), skipped: [] },
    keys: ["totals", "rowCount", "notSame", "skipped"],
    first: ["notSame", [{ id: "r-0", result: "different" }]],
  },
  status: {
    data: {
      schema: "tabcap-status/0",
      daemon: { running: true, pid: 1 },
      browser: { running: true, tabs: 3 },
      sessions: many((i) => ({ session: `s${i}`, state: "running", tabs: 1, recording: { bundle: `/b${i}` }, trace: { state: "off" }, guardStops: [{ reason: LONG }] })),
      plugins: {},
      handoff: [],
      conflicts: many((i) => ({ code: "c", session: `s${i}`, message: LONG })),
    },
    keys: ["daemon", "browser", "sessionCount", "sessions", "conflictCount", "conflicts"],
    first: ["sessions", [{ session: "s0", state: "running", tabs: 1, recording: "/b0", trace: "off" }]],
  },
  "trace list": {
    data: { session: "s", rows: many((i) => ({ api: `A${i}`, script: "u", count: 1, callers: [{ x: LONG }] })), totals: { rows: N, reads: N } },
    keys: ["rowCount", "rows", "totals"],
    first: ["rows", [{ api: "A0", script: "u", count: 1 }]],
  },
  "bundle export fixtures": {
    data: { out: "/o", fixtures: N, files: many((i) => `fixtures/${i}-${LONG.slice(0, 50)}.json`), filesCount: N, skipped: { preflight: 2 }, failed: [], notPreferred: [] },
    keys: ["out", "fixtures", "filesCount", "files", "skipped", "failed"],
  },
  fetch: {
    data: { batch: many((i) => ({ ok: true, data: { id: `r-${i}`, status: 200, body: LONG } })), count: N, failed: 0 },
    keys: ["batch", "count", "failed"],
    first: ["batch", [{ ok: true, id: "r-0", status: 200 }]],
  },
  "console show": { data: { msgid: 3, type: "log", text: LONG, args: many(() => LONG) }, keys: ["msgid", "textChars", "args"] },
};

describe("over-budget summaries keep counts and the first ids (0.7-C)", () => {
  test("every command with its own summary has a case here, and the audited ones have their own summary", () => {
    expect(SUMMARY_COMMANDS.filter((c) => !(c in CASES) && !["recon", "analyze recon", "where"].includes(c))).toEqual([]);
    for (const c of ["net show", "net body", "net grep", "analyze find", "analyze deps", "analyze chain", "analyze diff", "analyze shape", "analyze schema-diff", "bundle info", "replay check", "status", "trace list", "bundle export fixtures"]) expect(SUMMARY_COMMANDS).toContain(c);
  });

  for (const [command, c] of Object.entries(CASES)) {
    test(`${command}: the summary has ${c.keys.join(", ")}`, () => {
      expect(Buffer.byteLength(JSON.stringify(c.data))).toBeGreaterThan(OUTPUT_LIMIT_DEFAULT);
      const s = summaryOf(command, c.data);
      for (const k of c.keys) expect([k, s[k] !== undefined]).toEqual([k, true]);
      // small enough to read: lists cut at SUMMARY_FIRST, long strings by their length
      expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThan(4096);
      for (const v of Object.values(s)) if (Array.isArray(v)) expect(v.length).toBeLessThanOrEqual(SUMMARY_FIRST);
      if (c.first !== undefined) {
        const [k, want] = c.first;
        const got = s[k];
        expect(Array.isArray(got) && Array.isArray(want) ? got.slice(0, want.length) : got).toEqual(want);
      }
    });
  }

  test("through applyBudget: a large bundle info answer becomes {summary, file, bytes, truncated} with its counts", async () => {
    const out = await applyBudget("bundle info", CASES["bundle info"]?.data ?? {}, { limit: 1000, full: false, target: async () => ({ cache: dir }), now: 0 });
    if (!isBudgeted(out)) throw new Error("expected the budget form");
    expect(out.summary).toMatchObject({ events: N, issueCount: N });
    expect(Array.isArray(out.summary["issues"]) ? out.summary["issues"][0] : null).toEqual({ line: 1, kind: "bad-json" });
  });
});
