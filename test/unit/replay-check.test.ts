// replay check comparator (src/replay/check.ts) and its target guard.
// The comparator's oracle is the definition in docs/03 §3 步骤 6:
// same count, same fields (per JSON path, types included), not "looks similar".
// --live is never exercised against a network here: only its refusals.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { check, compareBodies, compareHeaders, compareJson, renderCheckText } from "../../src/replay/check.ts";
import { flattenJson } from "../../src/replay/common.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { run } from "../../src/cli/main.ts";
import { tmp } from "./_analyze.ts";
import { buildReplayBundle } from "./_replay.ts";

let root = "";
let bundle = "";
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  root = tmp("tabcap-replay-c-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("JSON comparison", () => {
  test("every leaf and empty container has a path", () => {
    expect([...(flattenJson({ a: [1, { b: null }], c: {}, d: [], "odd key": "x" }) ?? new Map()).entries()]).toEqual([
      ["$.a[0]", "1"],
      ["$.a[1].b", "null"],
      ["$.c", "{}"],
      ["$.d", "[]"],
      ['$["odd key"]', '"x"'],
    ]);
  });

  test("missing, extra, changed; types differ (1 vs \"1\"); order of keys does not", () => {
    expect(compareJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
    expect(compareJson({ a: 1, b: [1, 2], c: "x" }, { a: "1", b: [1], d: true })).toEqual([
      { path: "$.a", kind: "changed", recorded: "1", got: '"1"' },
      { path: "$.b[1]", kind: "missing", recorded: "2", got: null },
      { path: "$.c", kind: "missing", recorded: '"x"', got: null },
      { path: "$.d", kind: "extra", recorded: null, got: "true" },
    ]);
    expect(compareJson({ a: [] }, { a: [0] })).toEqual([
      { path: "$.a", kind: "missing", recorded: "[]", got: null },
      { path: "$.a[0]", kind: "extra", recorded: null, got: "0" },
    ]);
  });
});

describe("bodies", () => {
  test("JSON per path, text by equality, binary by hash", () => {
    expect(compareBodies(enc('{"a":1}'), "application/json", enc('{ "a" : 1 }'))).toBeNull();
    expect(compareBodies(enc('{"a":1}'), "application/json", enc('{"a":2}'))).toEqual({ kind: "json", fields: [{ path: "$.a", kind: "changed", recorded: "1", got: "2" }], count: 1 });
    expect(compareBodies(enc('{"a":1}'), "application/json", enc("<html>"))).toMatchObject({ kind: "not-json" });
    expect(compareBodies(enc("hello"), "text/plain", enc("hello"))).toBeNull();
    expect(compareBodies(enc("hello"), "text/plain", enc("help!"))).toMatchObject({ kind: "text", firstDiff: 3, recordedSize: 5, gotSize: 5 });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
    expect(compareBodies(png, "image/png", png)).toBeNull();
    expect(compareBodies(png, "image/png", png.slice(0, 4))).toMatchObject({ kind: "binary", recordedSize: 5, gotSize: 4 });
  });

  test("field diffs are capped but counted", () => {
    const a = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const r = compareBodies(enc(JSON.stringify(a)), "application/json", enc("{}"));
    expect(r).toMatchObject({ kind: "json", count: 31 });
    expect(r?.kind === "json" ? r.fields.length : 0).toBe(20);
  });
});

describe("headers", () => {
  test("only selected headers the recording has; location compared as a same-origin path", () => {
    const reader = BundleReader.open(bundle);
    const go = reader.requests().find((r) => r.url.endsWith("/go"));
    if (go === undefined) throw new Error("no /go");
    const h = new Headers({ location: "/final?x=1", "content-type": "text/plain" });
    expect(compareHeaders(["content-type", "location"], go, h, "http://127.0.0.1:4500/go")).toEqual([]);
    const moved = new Headers({ location: "/elsewhere" });
    expect(compareHeaders(["location"], go, moved, "http://127.0.0.1:4500/go")).toEqual([{ name: "location", recorded: "http://127.0.0.1:4310/final?x=1", got: "/elsewhere" }]);
    const items = reader.requests().find((r) => r.url.includes("/api/items"));
    if (items === undefined) throw new Error("no items");
    expect(compareHeaders(["content-type"], items, new Headers({ "content-type": "application/json" }), "http://127.0.0.1:4500/api/items")).toEqual([]);
    expect(compareHeaders(["content-type"], items, new Headers({ "content-type": "text/html" }), "http://127.0.0.1:4500/api/items")).toHaveLength(1);
  });
});

describe("target guard", () => {
  test("non-loopback without --live is refused before anything is sent", async () => {
    await expect(check({ bundle, against: "http://192.0.2.1:80", live: false, withCookies: false, headers: [], configDir: join(root, "cfg") })).rejects.toThrow(/not a loopback address/);
    const r = await run(["replay", "check", bundle, "--against", "https://example.invalid"]);
    expect(r.code).toBe(2);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("--live needs a stored site whose domains include the host; --rate must be positive", async () => {
    const cfg = join(root, "cfg");
    const base = { bundle, live: true, withCookies: false, headers: [], configDir: cfg };
    // the synthetic bundle has no manifest site
    await expect(check({ ...base, against: "http://192.0.2.1" })).rejects.toThrow(/needs a stored site/);
    await expect(check({ ...base, against: "http://192.0.2.1", site: "shop" })).rejects.toThrow(/no site "shop"/);
    const s = Store.open(cfg);
    s.addSite({ name: "shop", entryUrl: "https://shop.invalid/login", domains: ["shop.invalid", "api.shop.invalid"], username: "u", password: "Secret-pass-2" });
    s.close();
    await expect(check({ ...base, against: "http://192.0.2.1", site: "shop" })).rejects.toThrow(/not one of the domains/);
    await expect(check({ ...base, against: "https://api.shop.invalid", site: "shop", rate: 0 })).rejects.toThrow(/--rate/);
  });

  test("live pacing goes through the store's per-site counter", () => {
    const cfg = join(root, "cfg-pace");
    const s = Store.open(cfg);
    s.addSite({ name: "p", entryUrl: "https://p.invalid/", domains: [], username: "u", password: "Secret-pass-3" });
    expect(s.requestCounter("p", "replay-check")).toEqual({ site: "p", scope: "replay-check", requests: 0, lastRequestAt: null });
    s.noteRequest("p", "replay-check", 1000);
    expect(s.noteRequest("p", "replay-check", 3000)).toEqual({ site: "p", scope: "replay-check", requests: 2, lastRequestAt: 3000 });
    // login attempts live in the same table under another scope and are untouched
    expect(s.guardCounter("p", "replay-check").loginAttempts).toBe(0);
    s.close();
  });
});

describe("text table", () => {
  test("rows and totals", () => {
    const text = renderCheckText({
      bundle: "b",
      against: "http://127.0.0.1:4500/",
      live: false,
      headers: ["content-type"],
      totals: { requests: 2, same: 1, different: 1, errors: 0, unverified: 0, skipped: 0 },
      rows: [
        { id: "r-1", method: "GET", path: "/a", status: { recorded: 200, got: 200 }, result: "same", diffs: {}, notes: [] },
        { id: "r-2", method: "GET", path: "/b", status: { recorded: 200, got: 404 }, result: "different", diffs: { status: true }, notes: [] },
      ],
      skipped: [],
      warnings: [],
    });
    expect(text).toContain("id   method  path  status   result\nr-1  GET     /a    200→200  same\nr-2  GET     /b    200→404  different  status 200 → 404\n");
    expect(text).toContain("totals: 2 request(s), 1 same, 1 different, 0 error(s), 0 unverified, 0 skipped");
  });
});
