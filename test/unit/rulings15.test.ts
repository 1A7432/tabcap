// docs/04 §15 "代码待改" items: cmd start/end pair, response.status null,
// HAR `dropped` for cmd and console, size-tiered entropy thresholds,
// finding.evidence {console}.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { find, entropyThreshold, looksEncrypted } from "../../src/analyze/find.ts";
import { appendFinding } from "../../src/analyze/finding.ts";
import { shannonEntropy } from "../../src/analyze/decoders.ts";
import { exportHar } from "../../src/bundle/har.ts";
import { BundleReader, parseRequest } from "../../src/bundle/reader.ts";
import type { CmdEndEvent, CmdEvent, CmdStartEvent, FindingEvidence } from "../../src/bundle/types.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";
import { ulid } from "../../src/shared/ids.ts";
import { b64, buildBundle, idOf, tmp } from "./_analyze.ts";

const T0 = 1760500000000;
const ENV = { actor: "ai" as const, tab: "t1" };

/** Deterministic pseudo-random bytes (sha256 counter stream). */
function noise(n: number, seed: string): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) out.set(createHash("sha256").update(`${seed}:${i}`).digest().subarray(0, Math.min(32, n - i)), i);
  return out;
}

/** A recording shaped like 0.2-A output: a cmd pair around a navigation-cancelled request and a console line. */
async function recording(dir: string): Promise<void> {
  const w = await BundleWriter.open(dir, {
    now: () => T0 + 5000,
    init: { id: ulid(T0, new Uint8Array(10).fill(15)), created: T0, session: { name: "r15", tabs: [{ tab: "t1", chromeTabId: 1, owned: true, firstUrl: null }] }, mode: { capture: "mixed", trace: false, raw: false } },
  });
  w.append((seq) => ({ ...ENV, ts: T0, mono: 1000, cmd: null, kind: "nav", frame: "root", nav: `n-${seq}`, url: "http://127.0.0.1:4310/", from: null, type: "navigation", loaderId: "L1", loadEvent: null }));
  const start = w.append((seq) => ({ ...ENV, ts: T0 + 10, mono: null, cmd: `c-${seq}`, kind: "cmd", id: `c-${seq}`, phase: "start", argv: ["click", "e4"], input: { ref: "e4" } }));
  const c = typeof start["id"] === "string" ? start["id"] : "";
  const req = (status: number | null, outcome: string, bodyMissing: string | null) => (seq: number) => ({
    ...ENV, ts: T0 + 20 + seq, mono: 1020 + seq, cmd: c, kind: "request", nav: "n-1", id: `r-${seq}`, cdp: null, type: "fetch", method: "GET",
    url: `http://127.0.0.1:4310/api/${seq}`, urlFragment: null, initiator: null,
    request: { headers: {}, headersSource: "event", postData: null },
    response: { status, statusText: "", headers: {}, headersSource: "event", mimeType: null, charset: null, protocol: null, remote: null, fromCache: false, fromServiceWorker: false, fromPrefetch: false, body: null, bodyMissing: bodyMissing === null ? null : { reason: bodyMissing, detail: null } },
    redirect: null, timing: null, outcome, error: outcome === "failed" ? { text: "net::ERR_ABORTED" } : null,
  });
  w.append(req(null, "failed", "navigated"));
  w.append(req(204, "finished", "no-content"));
  w.append({ ...ENV, ts: T0 + 40, mono: null, cmd: c, kind: "console", level: "error", source: "console", text: "boom", args: [], url: null, line: 1, col: 1, stack: null });
  w.append({ ...ENV, ts: T0 + 50, mono: null, cmd: c, kind: "cmd", phase: "end", ref: c, ok: true, error: null, durationMs: 40, outputSummary: { ref: "e4" } });
  await w.close();
}

describe("cmd start / end pair (docs/04 §14, §15)", () => {
  test("the two shapes type-check as CmdEvent and round-trip through the reader", async () => {
    const s: CmdStartEvent = { seq: 2, ts: T0, mono: null, kind: "cmd", actor: "ai", tab: "t1", cmd: "c-2", phase: "start", id: "c-2", argv: ["navigate", "http://x/"], input: {} };
    const e: CmdEndEvent = { seq: 9, ts: T0, mono: null, kind: "cmd", actor: "ai", tab: "t1", cmd: "c-2", phase: "end", ref: "c-2", ok: false, error: { code: "timeout" }, durationMs: 5, outputSummary: null };
    const pair: CmdEvent[] = [s, e];
    expect(pair.map((x) => (x.phase === "start" ? x.id : x.ref))).toEqual(["c-2", "c-2"]);

    const dir = tmp("tabcap-r15-");
    await recording(dir);
    const r = BundleReader.open(dir);
    const cmds = r.events.filter((x) => x.kind === "cmd");
    expect(cmds.map((x) => x["phase"])).toEqual(["start", "end"]);
    const startId = cmds[0]?.["id"];
    expect(cmds[1]?.["ref"]).toBe(startId);
    // every event inside the window points at the start id
    expect(r.events.filter((x) => x.kind === "request" || x.kind === "console").every((x) => x.cmd === startId)).toBe(true);
  });
});

describe("response.status null (docs/04 §14, §15)", () => {
  test("reader keeps null and never coerces it to 0; real numbers stay numbers", async () => {
    const dir = tmp("tabcap-r15-");
    await recording(dir);
    const reqs = BundleReader.open(dir).events.filter((x) => x.kind === "request").map(parseRequest);
    const statuses = reqs.map((q) => (typeof q === "string" ? q : q.response?.status));
    expect(statuses).toEqual([null, 204]);
  });
});

describe("HAR export: cmd and console are dropped (docs/04 §9.1, §15)", () => {
  test("listed in dropped with their counts, no entries for them", async () => {
    const dir = tmp("tabcap-r15-");
    await recording(dir);
    const res = exportHar(BundleReader.open(dir));
    expect(res.dropped).toEqual({ cmd: 2, console: 1 });
    expect(res.entries).toBe(2);
    expect(res.har.log.entries.map((x) => x.request.url)).toEqual(["http://127.0.0.1:4310/api/3", "http://127.0.0.1:4310/api/4"]);
    // HAR needs a number: a null status is written as 0 (HAR 1.2 "no response")
    expect(res.har.log.entries.map((x) => x.response.status)).toEqual([0, 204]);
    expect(exportHar(BundleReader.open(dir), { embedEvents: true }).dropped).toEqual({});
  });
});

describe("entropy thresholds by size (docs/04 §15)", () => {
  test("tiers: >= 1 KiB 7.3, 256 B to 1 KiB 7.0, under 256 B not judged", () => {
    expect([255, 256, 1023, 1024, 1 << 20].map(entropyThreshold)).toEqual([null, 7.0, 7.0, 7.3, 7.3]);
    expect(looksEncrypted(255, 7.99)).toBe(false);
    expect(looksEncrypted(256, 7.01)).toBe(true);
    expect(looksEncrypted(512, 7.0)).toBe(false); // strictly above the threshold
    expect(looksEncrypted(1023, 7.1)).toBe(true);
    expect(looksEncrypted(1024, 7.1)).toBe(false);
    expect(looksEncrypted(1024, 7.31)).toBe(true);
  });

  test("find: a 300 B random payload is now a suspect, a 255 B one is not judged", async () => {
    const mid = noise(300, "mid");
    const small = noise(255, "small");
    // the point of the lower tier: short random data cannot reach 7.3
    expect(shannonEntropy(mid)).toBeGreaterThan(7.0);
    expect(shannonEntropy(mid)).toBeLessThan(7.3);
    expect(shannonEntropy(small)).toBeGreaterThan(7.0);
    const ids: string[] = [];
    const dir = await buildBundle(tmp("tabcap-r15e-"), { name: "entropy", created: T0, seed: 21 }, async (b) => {
      ids.push(idOf(await b.request({ url: "http://127.0.0.1:4310/api/mid", ts: T0 + 10, mime: "text/plain", body: b64(mid) })));
      ids.push(idOf(await b.request({ url: "http://127.0.0.1:4310/api/small", ts: T0 + 20, mime: "text/plain", body: b64(small) })));
    });
    const r = find(dir, "not in there");
    expect(r.hints?.suspectEncrypted.map((s) => [s.ref, s.size])).toEqual([[ids[0] ?? "?", 300]]);
  });
});

describe("finding.evidence {console} (docs/04 §15)", () => {
  test("the union accepts {console: seq}; find --save writes it for a console hit", async () => {
    const ev: FindingEvidence[] = [{ console: 7 }, { request: "r-4", path: "$.a" }, { ws: "r-7", frame: 9 }, { blob: "sha256:00" }];
    expect(ev).toHaveLength(4);
    let seq = 0;
    const dir = await buildBundle(tmp("tabcap-r15c-"), { name: "console", created: T0, seed: 22 }, async (b) => {
      seq = b.console(T0 + 10, "签名校验失败 code=4031").seq;
    });
    const r = find(dir, "code=4031");
    expect(r.hits.map((h) => [h.kind, h.seq])).toEqual([["console", seq]]);
    const saved = appendFinding(dir, { actor: "ai", tool: "find", grade: "实测", claim: "x", evidence: [{ console: seq }], input: {}, output: {} });
    const f = BundleReader.open(dir).events.find((x) => x.seq === saved.seq);
    expect(f?.["evidence"]).toEqual([{ console: seq }]);
  });
});
