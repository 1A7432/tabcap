import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader, parseEventsText } from "../../src/bundle/reader.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";
import { readManifest } from "../../src/bundle/manifest.ts";
import { REPO_ROOT, SAMPLE_FIXTURE_DIR, SAMPLE_LINES, buildSampleBundle, sampleEvents } from "./_fixtures.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "tabcap-bundle-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("§11 sample (oracle)", () => {
  test("SAMPLE_LINES are still the lines of docs/04 §11", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "04-evidence-bundle-spec-v0.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 11."));
    const lines = section.split("\n").filter((l) => l.startsWith('{"seq"'));
    expect(lines).toEqual([...SAMPLE_LINES]);
  });

  test("writer -> reader round trip equals the sample, seq preserved", async () => {
    const dir = tmp();
    await buildSampleBundle(dir);
    const r = BundleReader.open(dir);
    expect(r.issues).toEqual([]);
    expect(r.truncatedLastLine).toBe(false);
    expect(r.events).toEqual(SAMPLE_LINES.map((l) => JSON.parse(l)));
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.isComplete()).toBe(true);
    expect(r.manifest.format).toBe("evidence-bundle/0");
    expect(r.manifest.counts).toEqual({ events: 8, requests: 3, bodies: 0, blobBytes: 0, bodyMissing: {} });
    // the "..." placeholder field of the sample is an unknown field: kept verbatim
    expect(r.byKind("request").map((e) => e["..."])).toEqual(["…", "…", "…"]);
    expect(r.requests().map((q) => [q.id, q.method, q.outcome])).toEqual([
      ["r-4", "GET", "finished"],
      ["r-6", "POST", "finished"],
      ["r-8", "GET", "failed"],
    ]);
  });

  test("committed fixtures/bundles/sample-v0 equals a fresh build", async () => {
    const dir = tmp();
    await buildSampleBundle(dir);
    for (const f of ["events.jsonl", "manifest.json"]) {
      expect(readFileSync(join(SAMPLE_FIXTURE_DIR, f), "utf8")).toBe(readFileSync(join(dir, f), "utf8"));
    }
  });
});

describe("reader tolerance", () => {
  test("truncated last line is reported, not thrown", async () => {
    const dir = tmp();
    await buildSampleBundle(dir);
    appendFileSync(join(dir, "events.jsonl"), '{"seq":9,"ts":17605000014');
    const r = BundleReader.open(dir);
    expect(r.events.length).toBe(8);
    expect(r.truncatedLastLine).toBe(true);
    expect(r.issues.map((i) => [i.line, i.kind])).toEqual([[9, "truncated-last-line"]]);
  });

  test("damaged middle line is skipped and reported", () => {
    const text = [SAMPLE_LINES[0], "{not json", SAMPLE_LINES[1], '{"seq":3}', ""].join("\n");
    const p = parseEventsText(text);
    expect(p.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p.truncatedLastLine).toBe(false);
    expect(p.issues.map((i) => [i.line, i.kind])).toEqual([
      [2, "bad-json"],
      [4, "bad-envelope"],
    ]);
  });

  test("unknown kinds and fields survive writer -> reader", async () => {
    const dir = tmp();
    const w = await BundleWriter.open(dir, { now: () => 1 });
    const future = { ts: 1, mono: null, kind: "future-kind", actor: "ai" as const, tab: null, cmd: null, deep: { a: [1, { b: null }] }, "x-extra": "y" };
    w.append(future);
    w.append((seq) => ({ ts: 2, mono: 3.25, kind: "request", actor: "human", tab: "t1", cmd: null, id: `r-${seq}`, method: "GET", url: "http://127.0.0.1:4310/", outcome: "finished", _vendor: { z: 1 } }));
    await w.close();
    const r = BundleReader.open(dir);
    expect(r.events[0]).toEqual({ seq: 1, ...future });
    expect(r.events[1]?.["_vendor"]).toEqual({ z: 1 });
    expect(r.requests()[0]?.["_vendor"]).toEqual({ z: 1 });
    expect(r.byKind("future-kind").length).toBe(1);
  });

  test("a different format major is refused", async () => {
    const dir = tmp();
    await buildSampleBundle(dir);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, format: "evidence-bundle/1" }));
    expect(() => BundleReader.open(dir)).toThrow(/not supported/);
  });
});

describe("writer", () => {
  test("batches lines and flushes within ~100 ms without close()", async () => {
    const dir = tmp();
    const w = await BundleWriter.open(dir, { now: () => 1 });
    w.append({ ts: 1, mono: null, kind: "note", actor: "ai", tab: null, cmd: null, text: "a", refs: [] });
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe(""); // still batched
    await sleep(300);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").length).toBe(2);
    await w.close();
  });

  test("manifest is refreshed periodically and stamped finished on close", async () => {
    const dir = tmp();
    const w = await BundleWriter.open(dir, { now: () => 42, manifestMs: 50 });
    expect(readManifest(dir).counts.events).toBe(0);
    w.append({ ts: 1, mono: null, kind: "note", actor: "ai", tab: null, cmd: null, text: "a", refs: [] });
    await sleep(250);
    const mid = readManifest(dir);
    expect(mid.counts.events).toBe(1);
    expect(mid.finished).toBeUndefined();
    const final = await w.close();
    expect(final.finished).toBe(42);
    expect(readManifest(dir).finished).toBe(42);
  });

  test("seq is monotonic and continues when an unfinished bundle is reopened", async () => {
    const dir = tmp();
    const ev = { ts: 1, mono: null, kind: "note", actor: "ai" as const, tab: null, cmd: null, text: "x", refs: [] };
    const w1 = await BundleWriter.open(dir);
    expect([w1.append(ev).seq, w1.append(ev).seq]).toEqual([1, 2]);
    await w1.close({ finished: null });
    const w2 = await BundleWriter.open(dir);
    expect(w2.append(ev).seq).toBe(3);
    await w2.close();
    await expect(BundleWriter.open(dir)).rejects.toThrow(/already finished/);
    expect(BundleReader.open(dir).events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("rejects events with a bad envelope", async () => {
    const w = await BundleWriter.open(tmp());
    // JSON.parse stands in for an untrusted producer
    expect(() => w.append(JSON.parse('{"ts":1,"mono":null,"kind":"note","actor":"robot","tab":null,"cmd":null}'))).toThrow(/actor/);
    expect(() => w.appendRestored({ seq: 0, ts: 1, mono: null, kind: "note", actor: "ai", tab: null, cmd: null })).toThrow(/seq/);
    await w.close();
  });

  test("putBlob counts blob bytes once per distinct blob", async () => {
    const dir = tmp();
    const w = await BundleWriter.open(dir);
    await w.putBlob("12345");
    await w.putBlob("12345");
    await w.putBlob("abc");
    const m = await w.close();
    expect(m.counts.blobBytes).toBe(8);
  });
});

test("sampleEvents parses every sample line", () => {
  expect(sampleEvents().length).toBe(8);
});
