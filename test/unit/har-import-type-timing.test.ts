// 0.6-N: HAR import infers a resource type when `_resourceType` is absent and keeps timings.
// Oracle: the fixed table in docs/04 section 9.2 (type priority), docs/04 section 4 (timing field)
// and HAR 1.2 (timings); the mitmproxy sample is test/fixtures/har/mitmproxy-range.har.
// Reproduce: bun test test/unit/har-import-type-timing.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHar, importHar } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { pyCompile } from "./_python.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "tabcap-har-nt-"));
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const mitm: unknown = JSON.parse(readFileSync(new URL("../fixtures/har/mitmproxy-range.har", import.meta.url), "utf8"));

type H = [string, string][];
function entry(o: { url?: string; req?: H; resp?: H; extra?: Record<string, unknown>; time?: number; timings?: Record<string, number> }): Record<string, unknown> {
  const hdr = (h: H) => h.map(([name, value]) => ({ name, value }));
  return {
    startedDateTime: "2026-10-16T10:00:00.000Z",
    time: o.time ?? -1,
    request: { method: "GET", url: o.url ?? "http://127.0.0.1:1/x", httpVersion: "HTTP/1.1", headers: hdr(o.req ?? []), queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: hdr(o.resp ?? []), cookies: [], content: { size: 0, mimeType: "x" }, redirectURL: "", headersSize: -1, bodySize: -1 },
    cache: {},
    timings: o.timings ?? {},
    ...(o.extra ?? {}),
  };
}
const harOf = (entries: unknown[]) => ({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries } });
async function typesOf(entries: unknown[]) {
  const out = tmp();
  await importHar(harOf(entries), out);
  return BundleReader.open(out).requests();
}

describe("0.6-N type inference table", () => {
  test("_resourceType wins over every header and is not marked inferred", async () => {
    const [q] = await typesOf([entry({ req: [["sec-fetch-dest", "script"]], resp: [["content-type", "text/html"]], extra: { _resourceType: "image" } })]);
    expect(q?.type).toBe("image");
    expect(q?.["typeInferred"]).toBeUndefined();
  });

  test("sec-fetch-dest wins over content-type", async () => {
    const cases: [string, H, string][] = [
      ["document", [], "document"],
      ["iframe", [], "document"],
      ["script", [], "script"],
      ["style", [], "stylesheet"],
      ["image", [], "image"],
      ["font", [], "font"],
      ["audio", [], "media"],
      ["video", [], "media"],
      ["empty", [], "fetch"],
      ["empty", [["x-requested-with", "XMLHttpRequest"]], "xhr"],
    ];
    const qs = await typesOf(cases.map(([dest, extra]) => entry({ req: [["Sec-Fetch-Dest", dest], ...extra], resp: [["content-type", "text/plain"]] })));
    expect(qs.map((q) => String(q.type))).toEqual(cases.map((c) => c[2]));
    expect(qs.every((q) => q["typeInferred"] === "sec-fetch")).toBe(true);
  });

  test("an unlisted sec-fetch-dest falls through to content-type", async () => {
    const [q] = await typesOf([entry({ req: [["sec-fetch-dest", "worker"]], resp: [["content-type", "application/json"]] })]);
    expect(q?.type).toBe("xhr");
    expect(q?.["typeInferred"]).toBe("content-type");
  });

  test("content-type table", async () => {
    const cases: [string, string][] = [
      ["text/html; charset=utf-8", "document"],
      ["application/javascript", "script"],
      ["text/javascript", "script"],
      ["text/css", "stylesheet"],
      ["image/png", "image"],
      ["image/svg+xml", "image"],
      ["font/woff2", "font"],
      ["audio/mpeg", "media"],
      ["video/mp4", "media"],
      ["application/json", "xhr"],
      ["application/xml", "xhr"],
      ["text/plain", "xhr"],
      ["application/octet-stream", "other"],
    ];
    const qs = await typesOf(cases.map(([ct]) => entry({ resp: [["content-type", ct]] })));
    expect(qs.map((q) => String(q.type))).toEqual(cases.map((c) => c[1]));
    expect(qs.every((q) => q["typeInferred"] === "content-type")).toBe(true);
  });

  test("a failed request (status 0) has nothing to infer from: other, not marked", async () => {
    const e = entry({});
    (e["response"] as Record<string, unknown>)["status"] = 0;
    const [q] = await typesOf([e]);
    expect(q?.type).toBe("other");
    expect(q?.["typeInferred"]).toBeUndefined();
  });
});

describe("0.6-N timings", () => {
  const T = { blocked: 1, dns: 2, connect: 4, ssl: 3, send: 0.5, wait: 10, receive: 2 };
  const time = 1 + 2 + 4 + 0.5 + 10 + 2; // ssl is inside connect (HAR 1.2)

  test("mapped onto timing: start = startedDateTime, end = start + time, responseStart = end - receive, cdp offsets", async () => {
    const [q] = await typesOf([entry({ time, timings: T })]);
    const ts = Date.parse("2026-10-16T10:00:00.000Z");
    expect(q?.timing).toEqual({
      start: ts,
      responseStart: ts + time - 2,
      end: ts + time,
      cdp: { dnsStart: 1, dnsEnd: 3, connectStart: 3, connectEnd: 7, sslStart: 4, sslEnd: 7, sendStart: 7, sendEnd: 7.5, receiveHeadersEnd: 17.5 },
    });
  });

  test("-1 and absent are unknown and omitted; nothing known gives null and a lossy entry", async () => {
    const out = tmp();
    const res = await importHar(harOf([entry({ time: -1, timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0.2, wait: 1, receive: 0.1 } }), entry({ time: -1, timings: { send: -1, wait: -1, receive: -1 } })]), out);
    const [a, b] = BundleReader.open(out).requests();
    expect(a?.timing?.end).toBeNull();
    expect(a?.timing?.cdp).toEqual({ sendStart: 0, sendEnd: 0.2, receiveHeadersEnd: 1.2 });
    expect(a?.timing?.responseStart).toBeCloseTo(Date.parse("2026-10-16T10:00:00.000Z") + 1.2, 1);
    expect(b?.timing).toBeNull();
    expect(res.lossy).toContain("timing");
  });

  test("round trip: bundle export har of an imported bundle keeps the numbers", async () => {
    const out = tmp();
    await importHar(harOf([entry({ time, timings: T })]), out);
    const { har } = exportHar(BundleReader.open(out));
    const e = har.log.entries[0];
    expect(e?.time).toBeCloseTo(time, 2);
    for (const k of ["blocked", "dns", "connect", "ssl", "send", "wait", "receive"] as const) expect([k, e?.timings[k]]).toEqual([k, expect.closeTo(T[k], 2)]);
    expect(e?.startedDateTime).toBe("2026-10-16T10:00:00.000Z");
  });

  test("round trip on the mitmproxy sample: every known span survives; unknown blocked / dns read back as 0 / -1", async () => {
    const out = tmp();
    await importHar(structuredClone(mitm), out);
    const { har } = exportHar(BundleReader.open(out));
    const src = (mitm as { log: { entries: { time: number; timings: Record<string, number> }[] } }).log.entries;
    har.log.entries.forEach((e, i) => {
      const o = src[i];
      expect(e.time).toBeCloseTo(o?.time ?? NaN, 2);
      for (const k of ["connect", "send", "wait", "receive"]) expect([k, (e.timings as Record<string, number>)[k]]).toEqual([k, expect.closeTo(o?.timings[k] ?? NaN, 2)]);
      expect(e.timings.ssl).toBe(-1);
      expect(e.timings.dns).toBe(-1);
    });
  });
});

describe("0.6-N on the mitmproxy sample", () => {
  test("typeInferred distribution: 5 requests, all content-type (curl sends no sec-fetch headers); types document / xhr", async () => {
    const out = tmp();
    await importHar(structuredClone(mitm), out);
    const r = BundleReader.open(out);
    expect(r.requests().map((q) => [q.type, q["typeInferred"]])).toEqual([
      ["document", "content-type"],
      ["xhr", "content-type"],
      ["document", "content-type"],
      ["xhr", "content-type"],
      ["xhr", "content-type"],
    ]);
    const p = Bun.spawn(["bun", MAIN, "bundle", "info", out], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    expect(JSON.parse(text).data.typeInferred).toEqual({ "sec-fetch": 0, "content-type": 5 });
  });

  test("replay export-python produces a client from the imported fixture", async () => {
    const dir = tmp();
    const b = join(dir, "b");
    await importHar(structuredClone(mitm), b);
    const out = join(dir, "py");
    const p = Bun.spawn(["bun", MAIN, "replay", "export-python", b, "-o", out], { stdout: "pipe", stderr: "pipe" });
    const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(0);
    expect(so + se).not.toContain("no request to generate a client for");
    expect(pyCompile(["client.py"].map((f) => join(out, f)))).toBeNull();
  });
});
