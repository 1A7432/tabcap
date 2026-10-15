import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { exportHar, importHar, type HarDocument } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { blobRefsOf } from "../../src/bundle/redact.ts";
import type { RawEvent } from "../../src/bundle/types.ts";
import { isRecord } from "../../src/shared/json.ts";
import { tsToIso } from "../../src/shared/time.ts";
import { ITEMS_JSON, PNG_BYTES, SAMPLE_FIXTURE_DIR, buildRichBundle, gzippedItems } from "./_fixtures.ts";

const tmp = (p = "tabcap-har-") => mkdtempSync(join(tmpdir(), p));
const sha = (b: Uint8Array | string) => "sha256:" + new Bun.CryptoHasher("sha256").update(b).digest("hex");

async function richReader(): Promise<BundleReader> {
  const dir = tmp("tabcap-rich-");
  await buildRichBundle(dir);
  return BundleReader.open(dir);
}

/** JSON round trip so the HAR is exactly what a file would carry. */
const viaJson = (har: HarDocument): unknown => JSON.parse(JSON.stringify(har));

/** §9.3 property 1 comparison: same fields, seq may be renumbered, numbers within 1 ms. */
function expectEventsEqual(actual: readonly RawEvent[], expected: readonly RawEvent[]): void {
  expect(actual.length).toBe(expected.length);
  const close = (a: unknown, b: unknown): boolean => {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
    if (isRecord(a) && isRecord(b)) {
      const ka = Object.keys(a).filter((k) => k !== "seq");
      const kb = Object.keys(b).filter((k) => k !== "seq");
      return ka.length === kb.length && ka.every((k) => close(a[k], b[k]));
    }
    return a === b;
  };
  actual.forEach((e, i) => {
    const ok = close(e, expected[i]);
    if (!ok) expect(JSON.stringify(e)).toBe(JSON.stringify(expected[i])); // shows the diff
    expect(ok).toBe(true);
  });
}

describe("§9.3 property 1: bundle -> HAR (--embed-events) -> bundle", () => {
  test("§11 sample: events equal line by line", async () => {
    const src = BundleReader.open(SAMPLE_FIXTURE_DIR);
    const { har } = exportHar(src, { embedEvents: true });
    const out = tmp();
    const res = await importHar(viaJson(har), out);
    expect(res.restoredFromEvents).toBe(true);
    const back = BundleReader.open(out);
    expectEventsEqual(back.events, src.events);
    expect(back.events.map((e) => e.seq)).toEqual(src.events.map((e) => e.seq)); // we keep seq, stricter than required
    expect(back.manifest.imported?.from).toBe("har");
  });

  test("rich bundle: events equal; response bodies restored, other blobs listed as lossy", async () => {
    const src = await richReader();
    const { har } = exportHar(src, { embedEvents: true });
    const out = tmp();
    const res = await importHar(viaJson(har), out);
    const back = BundleReader.open(out);
    expectEventsEqual(back.events, src.events);
    // HAR carries response bodies, post data and ws payloads; screenshot and state blobs are not in HAR
    const stateAndShot = new Set<string>();
    for (const e of src.events) if (e.kind === "state" || e.kind === "screenshot") blobRefsOf(e, stateAndShot);
    expect(new Set(res.missingBlobs)).toEqual(stateAndShot);
    expect(res.lossy).toContain("blobs");
    for (const q of back.requests()) {
      const ref = q.response?.body?.blob;
      if (ref !== undefined) expect(back.readBlob(ref)).not.toBeNull();
    }
  });
});

describe("§9.3 property 2: bundle -> HAR (default) -> bundle", () => {
  test("method / url / status / headers / body hash equal per request", async () => {
    const src = await richReader();
    const res = exportHar(src);
    // §9.1: incomplete requests are not exported by default
    const exported = src.requests().filter((q) => q.outcome !== "incomplete");
    expect(res.entries).toBe(exported.length);
    expect(res.skipped.incomplete).toBe(1);
    expect(Object.keys(res.dropped).sort()).toEqual(["action", "nav", "note", "screenshot", "session", "state", "tab"]);

    const out = tmp();
    const imp = await importHar(viaJson(res.har), out);
    expect(imp.restoredFromEvents).toBe(false);
    const back = BundleReader.open(out).requests();
    const key = (q: { method: string; url: string }) => `${q.method} ${q.url}`;
    const byKey = new Map(back.map((q) => [key(q), q]));
    expect(back.length).toBe(exported.length);
    for (const a of exported) {
      const b = byKey.get(key(a));
      if (b === undefined) throw new Error(`missing ${key(a)}`);
      expect(b.method).toBe(a.method);
      expect(b.url).toBe(a.url);
      expect(b.response?.status ?? 0).toBe(a.response?.status ?? 0);
      expect(b.request.headers).toEqual(a.request.headers);
      expect(b.response?.headers ?? {}).toEqual(a.response?.headers ?? {});
      expect(b.response?.body?.blob ?? null).toBe(a.response?.body?.blob ?? null);
      expect(b.actor).toBe("human");
      expect(b.tab).toBe("t1");
    }
  });

  test("HAR shape: pages from root navigations, custom fields, websocket messages", async () => {
    const src = await richReader();
    const { har } = exportHar(src);
    const log = har.log;
    expect(log.creator).toEqual({ name: "tabcap", version: "0.1.0" });
    expect(log.browser).toEqual({ name: "Chrome", version: "155.0.8059.41" });
    // the history nav (n-10) is not a page
    expect(log.pages.map((p) => p.id)).toEqual(["n-3"]);
    expect(log.pages[0]?.pageTimings).toEqual({ onContentLoad: 100.5, onLoad: 200 });
    const e4 = log.entries.find((e) => e._id === "r-4");
    expect(e4?.pageref).toBe("n-3");
    expect(e4?.response.content.text).toBe(ITEMS_JSON);
    expect(e4?.response.httpVersion).toBe("http/2.0");
    expect(e4?.request.cookies.map((c) => c.name)).toEqual(["sid", "theme"]);
    expect(e4?.response.headers.filter((h) => h.name === "set-cookie").length).toBe(2);
    expect(e4?.request.queryString.map((q) => q.name)).toEqual(["page", "sid", "q"]);
    expect(e4?.time).toBeCloseTo(3.3, 6);
    expect(Object.keys(e4 ?? {}).filter((k) => k.startsWith("_")).sort()).toEqual(
      ["_actor", "_bodyMissing", "_cmd", "_fromCache", "_fromServiceWorker", "_id", "_initiator", "_nav", "_protocol", "_resourceType", "_seq", "_tab"],
    );
    const e6 = log.entries.find((e) => e._id === "r-6");
    expect(e6?.response.content.encoding).toBe("base64");
    expect(e6?.response.content.text).toBe(Buffer.from(PNG_BYTES).toString("base64"));
    expect(e6?._fromCache).toBe(true);
    const ws = log.entries.find((e) => e._id === "r-7")?._webSocketMessages;
    expect(ws?.map((m) => [m.type, m.opcode, m.time])).toEqual([
      ["send", 1, 1760500001.25],
      ["receive", 1, 1760500001.26],
    ]);
    const failed = log.entries.find((e) => e._id === "r-11");
    expect(failed?.response.status).toBe(0);
  });

  test("--tab and --types filter entries", async () => {
    const src = await richReader();
    expect(exportHar(src, { types: ["xhr"] }).har.log.entries.map((e) => e._id)).toEqual(["r-4", "r-11"]);
    expect(exportHar(src, { tab: "t9" }).entries).toBe(0);
  });
});

describe("§13 rulings 1-3 (HAR export)", () => {
  test("ruling 1: requests in a history epoch point at the preceding root page", async () => {
    const src = await richReader();
    const { har } = exportHar(src);
    // n-10 is a history nav after the n-3 navigation; r-11 belongs to n-10
    expect(src.requests().find((q) => q.id === "r-11")?.nav).toBe("n-10");
    expect(har.log.entries.find((e) => e._id === "r-11")?.pageref).toBe("n-3");
    expect(har.log.entries.find((e) => e._id === "r-11")?._nav).toBe("n-10");
    const pageIds = new Set(har.log.pages.map((p) => p.id));
    for (const e of har.log.entries) if (e.pageref !== undefined) expect(pageIds.has(e.pageref)).toBe(true);
  });

  test("ruling 2: startedDateTime = ts - (mono - timing.start); ts when the clocks are missing", async () => {
    const src = await richReader();
    const { har } = exportHar(src);
    const r4 = src.requests().find((q) => q.id === "r-4");
    const start = r4?.timing?.start ?? null;
    if (r4 === undefined || start === null || r4.mono === null) throw new Error("fixture r-4 lacks timing");
    expect(har.log.entries.find((e) => e._id === "r-4")?.startedDateTime).toBe(tsToIso(r4.ts - (r4.mono - start)));
    expect(har.log.entries.find((e) => e._id === "r-4")?.startedDateTime).not.toBe(tsToIso(r4.ts));
    const r6 = src.requests().find((q) => q.id === "r-6"); // timing: null
    expect(har.log.entries.find((e) => e._id === "r-6")?.startedDateTime).toBe(tsToIso(r6?.ts ?? 0));
  });

  test("ruling 3: send / wait / receive >= 0 (unknown 0); blocked / dns / connect / ssl -1 when unknown; time -1 when unknown", async () => {
    const src = await richReader();
    const { har } = exportHar(src);
    for (const e of har.log.entries) {
      expect(e.timings.send).toBeGreaterThanOrEqual(0);
      expect(e.timings.wait).toBeGreaterThanOrEqual(0);
      expect(e.timings.receive).toBeGreaterThanOrEqual(0);
    }
    const e6 = har.log.entries.find((e) => e._id === "r-6"); // no timing at all
    expect(e6?.timings).toEqual({ blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 });
    expect(e6?.time).toBe(-1);
    const e4 = har.log.entries.find((e) => e._id === "r-4"); // cdp timing: dns/connect/ssl -1, send 0.4..0.6, headers at 1.9
    expect(e4?.timings).toEqual({ blocked: 0.4, dns: -1, connect: -1, ssl: -1, send: 0.2, wait: 1.3, receive: 1.4 });
  });
});

describe("§9.2 HAR import of DevTools-style HARs", () => {
  const devtoolsHar = (headers: { name: string; value: string }[], content: Record<string, unknown>) => ({
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      pages: [{ startedDateTime: "2026-10-15T01:00:00.000Z", id: "page_1", title: "http://127.0.0.1:4310/", pageTimings: { onContentLoad: 10, onLoad: 20 } }],
      entries: [
        {
          pageref: "page_1",
          startedDateTime: "2026-10-15T01:00:00.100Z",
          time: 5,
          _resourceType: "xhr",
          request: { method: "GET", url: "http://127.0.0.1:4310/api/items", httpVersion: "http/2.0", headers: [{ name: ":authority", value: "127.0.0.1:4310" }, { name: "Accept", value: "*/*" }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 200, statusText: "", httpVersion: "http/2.0", headers, cookies: [], content, redirectURL: "", headersSize: -1, bodySize: -1 },
          cache: {},
          timings: { send: 0, wait: 1, receive: 1 },
        },
      ],
    },
  });

  async function importOne(headers: { name: string; value: string }[], content: Record<string, unknown>) {
    const out = tmp();
    const res = await importHar(devtoolsHar(headers, content), out);
    const r = BundleReader.open(out);
    const q = r.requests()[0];
    if (q === undefined) throw new Error("no request imported");
    return { res, r, q };
  }

  test("base64 gzip body is decoded and decompressed; wireEncoding recorded", async () => {
    const gz = gzippedItems();
    const { q, r, res } = await importOne(
      [{ name: "content-encoding", value: "gzip" }, { name: "content-type", value: "application/json" }, { name: "set-cookie", value: "a=1" }, { name: "Set-Cookie", value: "b=2" }],
      { size: ITEMS_JSON.length, mimeType: "application/json", text: Buffer.from(gz).toString("base64"), encoding: "base64" },
    );
    expect(q.response?.body?.wireEncoding).toBe("gzip");
    expect(q.response?.body?.decodeFailed).toBeUndefined();
    const ref = q.response?.body?.blob ?? "";
    expect(ref).toBe(sha(ITEMS_JSON));
    expect(new TextDecoder().decode(r.readBlob(ref) ?? new Uint8Array())).toBe(ITEMS_JSON);
    // pseudo headers dropped, names lowercased, repeats as array
    expect(q.request.headers).toEqual({ accept: "*/*" });
    expect(q.response?.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(q.type).toBe("xhr");
    expect(q.nav).toBe("n-1");
    expect(r.events.map((e) => [e.seq, e.kind])).toEqual([[1, "nav"], [2, "request"]]);
    expect(r.manifest.imported).toEqual({ from: "har", creator: { name: "WebInspector", version: "537.36" }, lossy: res.lossy });
  });

  test("brotli body is decompressed", async () => {
    const br = new Uint8Array(brotliCompressSync(Buffer.from(ITEMS_JSON, "utf8")));
    const { q, r } = await importOne([{ name: "content-encoding", value: "br" }], { size: ITEMS_JSON.length, mimeType: "application/json", text: Buffer.from(br).toString("base64"), encoding: "base64" });
    expect(q.response?.body?.wireEncoding).toBe("br");
    expect(new TextDecoder().decode(r.readBlob(q.response?.body?.blob ?? "") ?? new Uint8Array())).toBe(ITEMS_JSON);
  });

  test("§13 ruling 4: already-decoded UTF-8 text with content-encoding imports without decodeFailed", async () => {
    for (const ce of ["gzip", "br", "deflate"]) {
      const { q } = await importOne([{ name: "content-encoding", value: ce }], { size: ITEMS_JSON.length, mimeType: "application/json", text: ITEMS_JSON });
      expect(q.response?.body?.decodeFailed).toBeUndefined();
      expect(q.response?.body?.wireEncoding).toBe(ce);
      expect(q.response?.body?.blob).toBe(sha(ITEMS_JSON));
      expect(q.response?.bodyMissing).toBeNull();
    }
  });

  test("§13 ruling 4: undecodable binary with content-encoding keeps decodeFailed", async () => {
    const { q } = await importOne([{ name: "content-encoding", value: "gzip" }], { size: PNG_BYTES.length, mimeType: "image/png", text: Buffer.from(PNG_BYTES).toString("base64"), encoding: "base64" });
    expect(q.response?.body?.decodeFailed).toBe(true);
    expect(q.response?.body?.blob).toBe(sha(PNG_BYTES));
  });

  test("malformed HAR is a typed error with a next step", async () => {
    await expect(importHar({ log: { entries: [{ startedDateTime: "x" }] } }, tmp())).rejects.toMatchObject({ code: "bad-input" });
    await expect(importHar({ nope: 1 }, tmp())).rejects.toThrow(/missing log/);
  });
});
