import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { bodyErrorReason, charsetOf, isTextMime, mergeHeaders, noBodyReason, normalizeHeaders, requestTiming } from "../../src/daemon/capture/cdpnet.ts";
import { parseKey } from "../../src/daemon/tools/input.ts";
import { Secrets, isSensitiveField } from "../../src/daemon/secrets.ts";
import { pngInfo, pngIsUniform } from "../../src/shared/png.ts";

describe("CDP network helpers (docs/04 §5)", () => {
  test("headers: lowercase, pseudo headers dropped, newline repeats become arrays", () => {
    expect(normalizeHeaders({ "Content-Type": "text/html", ":authority": "x", "Set-Cookie": "a=1\nb=2", n: 3 })).toEqual({ "content-type": "text/html", "set-cookie": ["a=1", "b=2"] });
    expect(normalizeHeaders("junk")).toEqual({});
    expect(mergeHeaders({ a: "1" }, { a: "2", c: "3" })).toEqual({ headers: { a: "2", c: "3" }, source: "merged" });
    expect(mergeHeaders({ a: "1" }, null).source).toBe("event");
  });
  test("body-less responses and failure classification (§5.2 rule 5)", () => {
    expect(noBodyReason("GET", 304)).toBe("not-modified");
    expect(noBodyReason("GET", 204)).toBe("no-content");
    expect(noBodyReason("HEAD", 200)).toBe("no-content");
    expect(noBodyReason("GET", 302)).toBe("redirect");
    expect(noBodyReason("GET", 200)).toBeNull();
    expect(bodyErrorReason("Network.getResponseBody: No resource with given identifier found", true, false)).toBe("navigated");
    expect(bodyErrorReason("No resource with given identifier found", false, false)).toBe("evicted");
    expect(bodyErrorReason("anything", false, true)).toBe("detached");
    expect(bodyErrorReason("weird", false, false)).toBe("unsupported");
  });
  test("charset / text mime", () => {
    expect(charsetOf('text/html; charset="UTF-8"')).toBe("utf-8");
    expect(charsetOf(null)).toBeNull();
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("application/vnd.api+json")).toBe(true);
    expect(isTextMime("image/png")).toBe(false);
  });
});

describe("keys for tabcap press", () => {
  test("named, single chars, modifiers", () => {
    expect(parseKey("Enter")).toEqual({ def: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, modifiers: 0 });
    expect(parseKey("a")?.def).toEqual({ key: "a", code: "KeyA", vk: 65, text: "a" });
    expect(parseKey("Shift+Tab")).toEqual({ def: { key: "Tab", code: "Tab", vk: 9 }, modifiers: 8 });
    expect(parseKey("Control+a")?.def.text).toBeUndefined();
    expect(parseKey("Hyper+a")).toBeNull();
    expect(parseKey("NoSuchKey")).toBeNull();
  });
});

describe("secrets", () => {
  test("known values are replaced raw and JSON-escaped", () => {
    const s = new Secrets();
    s.add('pa"ss\\1');
    s.add("ab"); // too short to replace safely
    const json = JSON.stringify({ v: 'x pa"ss\\1 y', w: "ab" });
    expect(s.scrub(json)).toBe('{"v":"x <masked> y","w":"ab"}');
    expect(isSensitiveField("password", null)).toBe(true);
    expect(isSensitiveField("text", "cc-number")).toBe(true);
    expect(isSensitiveField("text", "one-time-code")).toBe(true);
    expect(isSensitiveField("text", "email")).toBe(false);
  });
});

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(...pixel(x, y));
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out; // CRC left zero: the reader does not check it
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("png", () => {
  test("size and uniform-colour detection", () => {
    const flat = png(4, 3, () => [255, 255, 255, 255]);
    const dot = png(4, 3, (x, y) => (x === 2 && y === 1 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
    expect(pngInfo(flat)).toMatchObject({ width: 4, height: 3 });
    expect(pngIsUniform(flat)).toBe(true);
    expect(pngIsUniform(dot)).toBe(false);
    expect(pngIsUniform(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("request timing on one clock (docs/04 §17)", () => {
  // Values of the /s15/ document request recorded 10-15 (CfT 155, Fetch interception on):
  // responseReceived.timestamp came 0.482 ms after loadingFinished.timestamp.
  const start = 1873827807.052;
  const responseEvent = 1873827808.376;
  const end = 1873827807.894;
  const cdp = { requestTime: 1873827.807444, receiveHeadersStart: 0.282, receiveHeadersEnd: 0.298, sendEnd: 0.1 };

  test("responseStart comes from ResourceTiming (requestTime + receiveHeadersEnd), not the event timestamp", () => {
    const t = requestTiming(start, responseEvent, end, cdp);
    expect(t).toEqual({ start, responseStart: 1873827807.742, end });
    expect((t.responseStart ?? Infinity) <= end).toBe(true);
  });

  test("without ResourceTiming the event timestamp is used, clamped into [start, end]", () => {
    expect(requestTiming(start, responseEvent, end, null)).toEqual({ start, responseStart: end, end });
    expect(requestTiming(start, start - 5, end, undefined)).toEqual({ start, responseStart: start, end });
    expect(requestTiming(start, 1873827807.5, end, { requestTime: "x", receiveHeadersEnd: 1 })).toEqual({ start, responseStart: 1873827807.5, end });
    expect(requestTiming(start, 1873827807.5, end, { requestTime: 1873827.807, receiveHeadersEnd: -1 })).toEqual({ start, responseStart: 1873827807.5, end });
  });

  test("open ends stay open: no end (incomplete) or no response leaves the known points alone", () => {
    expect(requestTiming(start, responseEvent, null, null)).toEqual({ start, responseStart: responseEvent, end: null });
    expect(requestTiming(start, null, end, null)).toEqual({ start, responseStart: null, end });
    expect(requestTiming(null, null, null, cdp)).toEqual({ start: null, responseStart: 1873827807.742, end: null });
  });
});
