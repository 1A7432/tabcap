// Pure parts of the 0.3-F commands: console types, evaluate --args, image
// sizes, upload paths, key combinations, verbose snapshots and the list /
// body conventions taken from chrome-devtools-mcp.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAxTree, renderAxTree } from "../../src/daemon/browser/ax.ts";
import { consoleType, CONSOLE_TYPES } from "../../src/daemon/capture/console.ts";
import { parseTypes } from "../../src/daemon/tools/console.ts";
import { bodyPreview, listUrl } from "../../src/daemon/tools/formatters.ts";
import { checkUploadFiles, parseKey } from "../../src/daemon/tools/input.ts";
import { parseEvalArgs, shotOptions } from "../../src/daemon/tools/page.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { imageSize } from "../../src/shared/png.ts";
import { isRecord } from "../../src/shared/json.ts";

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof TabcapError ? e.code : "other";
  }
  return "none";
};

describe("console list --types", () => {
  const ev = (method: string, params: Record<string, unknown>) => ({ method, params, sessionId: "S" });
  test("types in chrome-devtools-mcp terms", () => {
    expect(consoleType(ev("Runtime.consoleAPICalled", { type: "warning" }))).toBe("warn");
    expect(consoleType(ev("Runtime.consoleAPICalled", { type: "table" }))).toBe("table");
    expect(consoleType(ev("Runtime.consoleAPICalled", {}))).toBe("log");
    expect(consoleType(ev("Runtime.exceptionThrown", { exceptionDetails: {} }))).toBe("error");
    expect(consoleType(ev("Log.entryAdded", { entry: { level: "warning" } }))).toBe("warn");
    expect(consoleType(ev("Log.entryAdded", { entry: { level: "verbose" } }))).toBe("verbose");
    expect(consoleType(ev("Log.entryAdded", { entry: { level: 7 } }))).toBe("info");
  });
  test("--types is validated", () => {
    expect(parseTypes("error, warn")).toEqual(["error", "warn"]);
    expect(parseTypes(null)).toBeNull();
    expect(parseTypes(" , ")).toBeNull();
    expect(code(() => parseTypes("error,loud"))).toBe("usage");
    expect(CONSOLE_TYPES).toContain("issue");
  });
});

describe("evaluate --args", () => {
  test("a JSON array; {ref} alone is an element", () => {
    expect(parseEvalArgs(null)).toEqual([]);
    expect(parseEvalArgs('[1, "x", null, {"ref": "e3"}, {"ref": "e3", "x": 1}, [2]]')).toEqual([{ value: 1 }, { value: "x" }, { value: null }, { ref: "e3" }, { value: { ref: "e3", x: 1 } }, { value: [2] }]);
    expect(code(() => parseEvalArgs("{"))).toBe("usage");
    expect(code(() => parseEvalArgs('{"a":1}'))).toBe("usage");
  });
});

describe("screenshot options", () => {
  test("format / quality / ref / full page; old keys still read", () => {
    expect(shotOptions({})).toEqual({ format: "png", quality: null, ref: null, fullPage: false, filePath: null });
    expect(shotOptions({ format: "jpeg", quality: 80, filePath: "/x.jpeg" })).toEqual({ format: "jpeg", quality: 80, ref: null, fullPage: false, filePath: "/x.jpeg" });
    expect(shotOptions({ format: "png", quality: 80 }).quality).toBeNull(); // ignored for png, as chrome-devtools-mcp
    expect(shotOptions({ out: "/o.png", full: true })).toMatchObject({ filePath: "/o.png", fullPage: true });
    expect(code(() => shotOptions({ format: "gif" }))).toBe("usage");
    expect(code(() => shotOptions({ format: "jpeg", quality: 101 }))).toBe("usage");
    expect(code(() => shotOptions({ ref: "e1", fullPage: true }))).toBe("usage");
  });

  test("image sizes of PNG, JPEG and WebP", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 200]);
    expect(imageSize(png)).toEqual({ width: 256, height: 200 });
    // SOI, APP0 (len 16), SOF0 (height 300, width 640)
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array<number>(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0x01, 0x2c, 0x02, 0x80, 3, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 300 });
    const riff = (chunk: string, body: number[]) => Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk), 0, 0, 0, 0, ...body]);
    // VP8X: canvas width-1 / height-1 as 24-bit little endian at offsets 24 / 27
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, 99, 0, 0, 49, 0, 0, 0, 0]))).toEqual({ width: 100, height: 50 });
    // VP8L: signature 0x2f, then 14-bit width-1 and height-1
    const bits = 99 | (49 << 14);
    expect(imageSize(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 100, height: 50 });
    expect(imageSize(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(imageSize(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("upload and keys", () => {
  test("upload paths: absolute, existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-up-"));
    const f = join(dir, "a.txt");
    writeFileSync(f, "a");
    expect(checkUploadFiles([f])).toEqual([f]);
    expect(checkUploadFiles(f)).toEqual([f]);
    expect(code(() => checkUploadFiles([]))).toBe("usage");
    expect(code(() => checkUploadFiles(["a.txt"]))).toBe("usage");
    expect(code(() => checkUploadFiles([join(dir, "missing")]))).toBe("not-found");
    expect(code(() => checkUploadFiles([dir]))).toBe("not-found");
    expect(code(() => checkUploadFiles([5]))).toBe("usage");
  });

  test("press-key combinations, including the + key", () => {
    expect(parseKey("Control+Shift+R")).toMatchObject({ modifiers: 2 | 8, def: { key: "R", code: "KeyR" } });
    expect(parseKey("Control++")).toMatchObject({ modifiers: 2, def: { key: "+" } });
    expect(parseKey("+")).toMatchObject({ modifiers: 0, def: { key: "+", text: "+" } });
    expect(parseKey("Shift+Tab")).toMatchObject({ modifiers: 8, def: { key: "Tab" } });
    expect(parseKey("Hyper+a")).toBeNull();
    expect(parseKey("")).toBeNull();
  });
});

describe("chrome-devtools-mcp list and body conventions", () => {
  test("URLs over 255 chars are cut in lists, with a marker", () => {
    expect(listUrl("http://a/")).toEqual({ url: "http://a/" });
    const long = `http://a/${"x".repeat(300)}`;
    const r = listUrl(long);
    expect(r.urlTruncated).toBe(true);
    expect(r.url).toBe(`${long.slice(0, 255)}... <truncated>`);
  });

  test("body previews: 10000 chars, <empty response>, <binary data>", () => {
    expect(bodyPreview(new Uint8Array(), true)).toEqual({ text: "<empty response>", truncated: false, binary: false });
    expect(bodyPreview(Buffer.from("héllo"), true)).toEqual({ text: "héllo", truncated: false, binary: false });
    const big = bodyPreview(Buffer.from("é".repeat(12_000)), true);
    expect([big.text.length, big.truncated]).toEqual([10_000, true]);
    expect(bodyPreview(Uint8Array.from([0xff, 0xfe, 0x00, 0x80]), false)).toEqual({ text: "<binary data>", truncated: false, binary: true });
    expect(bodyPreview(Buffer.from("plain"), false)).toMatchObject({ text: "plain", binary: false });
  });
});

describe("snapshot --verbose (fixtures/ax)", () => {
  const f: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "ax", "home.json"), "utf8"));
  const ax = isRecord(f) ? f["ax"] : null;
  test("keeps more of the tree than the default and adds capability flags", () => {
    const plain = buildAxTree(ax);
    const verbose = buildAxTree(ax, new Set(), { verbose: true });
    if (plain === null || verbose === null) throw new Error("empty tree");
    const p = renderAxTree(plain, () => "e", 1e9);
    const v = renderAxTree(verbose, () => "e", 1e9);
    expect(v.text.split("\n").length).toBeGreaterThan(p.text.split("\n").length);
    expect(v.text).toContain("focusable");
    expect(p.text).not.toContain("focusable");
    expect(p.text).toMatch(/heading "Counter" \[e\] level="1"/);
  });
});
