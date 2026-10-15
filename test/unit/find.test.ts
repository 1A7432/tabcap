// analyze find + decode chain (docs/05 s04 / s05, docs/06 A3).
// Expected chains are the docs/05 s04 table; payloads are produced here by
// real encoders, so every expected value is computed, not typed in.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync, gzipSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { find, normalizeText, renderFindText, type FindHit } from "../../src/analyze/find.ts";
import { decodeBase64Strict, decodeHtmlEntities, parseSse, shannonEntropy, unescapeJsonText } from "../../src/analyze/decoders.ts";
import { importHar } from "../../src/bundle/har.ts";
import { run } from "../../src/cli/main.ts";
import { b64, buildBundle, idOf, tmp } from "./_analyze.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const TARGET = "「靶场 s04 目标文本：全角！」✓🎯";
const enc = (s: string) => new TextEncoder().encode(s);
const T0 = 1760500000000;
/** Widen to unknown so expectations can be written as plain data. */
const plain = (v: unknown): unknown => v;

/** JSON text with every non-ASCII UTF-16 unit written as \uXXXX (s04 f). */
const escapeNonAscii = (s: string) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
/** Numeric character references for every non-ASCII code point, hex and decimal alternating (s04 i). */
const toEntities = (s: string) =>
  [...s].map((c, i) => {
    const cp = c.codePointAt(0) ?? 0;
    if (cp < 0x80) return c === "&" ? "&amp;" : c;
    return i % 2 === 0 ? `&#x${cp.toString(16)};` : `&#${cp};`;
  }).join("");

type Channel = { name: string; url: string; expect: { decode: string[]; path: string | null; innerPath: string | null } };

const CHANNELS: Channel[] = [
  { name: "a plain", url: "/api/s04/a", expect: { decode: [], path: "$.items[2].title", innerPath: null } },
  { name: "b gzip-wire", url: "/api/s04/b", expect: { decode: [], path: "$.title", innerPath: null } },
  { name: "c br-wire", url: "/api/s04/c", expect: { decode: [], path: "$.title", innerPath: null } },
  { name: "d base64-field", url: "/api/s04/d", expect: { decode: ["base64", "json"], path: "$.data", innerPath: "$.title" } },
  { name: "e base64-gzip-field", url: "/api/s04/e", expect: { decode: ["base64", "gzip", "json"], path: "$.data", innerPath: "$.title" } },
  { name: "f unicode-escape", url: "/api/s04/f", expect: { decode: ["json-unescape"], path: "$.title", innerPath: null } },
  { name: "g nested-json-string", url: "/api/s04/g", expect: { decode: ["json-string", "json"], path: "$.payload", innerPath: "$.title" } },
  { name: "h form-urlencoded", url: "/api/s04/h", expect: { decode: ["urldecode"], path: "$.title", innerPath: null } },
  { name: "i html-entities", url: "/api/s04/i", expect: { decode: ["html-entities"], path: null, innerPath: null } },
  { name: "j jsonp", url: "/api/s04/j", expect: { decode: ["jsonp", "json"], path: "$.data.title", innerPath: null } },
  { name: "k sse", url: "/api/s04/k", expect: { decode: ["sse"], path: "$[1].title", innerPath: null } },
  { name: "l ndjson-chunked", url: "/api/s04/l", expect: { decode: ["ndjson"], path: "$[2].title", innerPath: null } },
];

const ORIGIN = "http://127.0.0.1:4310";
let S04 = "";
const ids = new Map<string, string>();

async function buildS04(dir: string): Promise<string> {
  const titled = JSON.stringify({ title: TARGET });
  return buildBundle(dir, { name: "range-s04", created: T0, seed: 4 }, async (b) => {
    let ts = T0 + 100;
    const add = async (url: string, spec: Omit<Parameters<typeof b.request>[0], "url" | "ts">) => {
      const e = await b.request({ url: ORIGIN + url, ts: (ts += 10), ...spec });
      ids.set(url, idOf(e));
      return e;
    };
    await add("/s04/", { type: "document", mime: "text/html", body: `<!doctype html><html><head><title>${TARGET}</title></head><body><div id=app></div></body></html>` });
    await add("/api/s04/a", { mime: "application/json", body: JSON.stringify({ items: [{ title: "甲" }, { title: "乙" }, { title: TARGET }] }) });
    // b / c: the wire carried gzip / br; CDP hands over the decoded bytes (docs/04 §5.2.3).
    await add("/api/s04/b", { mime: "application/json", wireEncoding: "gzip", body: new Uint8Array(gunzipSync(gzipSync(enc(titled)))) });
    await add("/api/s04/c", { mime: "application/json", wireEncoding: "br", body: new Uint8Array(brotliDecompressSync(brotliCompressSync(enc(titled)))) });
    await add("/api/s04/d", { mime: "application/json", body: JSON.stringify({ data: b64(titled) }) });
    await add("/api/s04/e", { mime: "application/json", body: JSON.stringify({ data: b64(new Uint8Array(gzipSync(enc(titled)))) }) });
    await add("/api/s04/f", { mime: "application/json", body: escapeNonAscii(JSON.stringify({ code: 0, title: TARGET })) });
    await add("/api/s04/g", { mime: "application/json", body: JSON.stringify({ code: 0, payload: titled }) });
    await add("/api/s04/h", { mime: "application/x-www-form-urlencoded", body: new URLSearchParams({ title: TARGET, code: "0" }).toString() });
    await add("/api/s04/i", { mime: "text/html", body: `<p class="t">${toEntities(TARGET)}</p>` });
    await add("/api/s04/j", { mime: "application/javascript", body: `cb(${JSON.stringify({ code: 0, data: { title: TARGET } })});` });
    await add("/api/s04/k", {
      type: "eventsource",
      mime: "text/event-stream",
      body: [0, 1, 2].map((i) => `event: msg\ndata: ${JSON.stringify(i === 1 ? { seq: i, title: TARGET } : { seq: i, title: `心跳 ${i}` })}\n\n`).join(""),
    });
    await add("/api/s04/l", {
      mime: "application/x-ndjson",
      body: [0, 1, 2].map((i) => JSON.stringify(i === 2 ? { seq: i, title: TARGET } : { seq: i, title: `分块 ${i}` })).join("\n") + "\n",
    });
    await add("/img/logo.png", { type: "image", mime: "image/png", base64: true, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) });
    await add("/api/s04/slow", { mime: null, body: null, bodyMissing: "navigated" });
  });
}

beforeAll(async () => {
  S04 = await buildS04(tmp("tabcap-s04-"));
}, SLOW_IO_MS);

describe("decoders (unit)", () => {
  test("encoders used by the fixtures round-trip through the decoders", () => {
    expect(new TextDecoder().decode(decodeBase64Strict(b64(TARGET)) ?? new Uint8Array())).toBe(TARGET);
    expect(decodeHtmlEntities(toEntities(TARGET))).toBe(TARGET);
    expect(JSON.parse(escapeNonAscii(JSON.stringify(TARGET)))).toBe(TARGET);
    expect(unescapeJsonText(escapeNonAscii(TARGET))).toBe(TARGET);
    expect(parseSse("data: a\ndata: b\n\nevent: x\ndata: c\n\n", false)).toEqual(["a\nb", "c"]);
  });

  test("strict base64 rejects plain words and malformed padding", () => {
    expect(decodeBase64Strict("username")).toBeNull();
    expect(decodeBase64Strict("abcdefghijk=x")).toBeNull();
    expect(decodeBase64Strict("YWJjZGVmZ2hpams=")).toEqual(enc("abcdefghijk"));
    expect(decodeBase64Strict("YWJj ZGVm\nZ2hp ams=")).toEqual(enc("abcdefghijk")); // wrapped lines
    expect(decodeBase64Strict("YWJjZGVmZ2hpams")).toEqual(enc("abcdefghijk")); // url-safe, unpadded
  });

  test("normalization: NFC, entities, width folding, whitespace", () => {
    expect(normalizeText("Ａ１２３：！　x\n\ty&amp;é")).toBe("Ａ123:! x y&é");
  });

  test("entropy of uniform bytes is 8 bits", () => {
    const b = new Uint8Array(1024).map((_, i) => i % 256);
    expect(shannonEntropy(b)).toBeCloseTo(8, 9);
  });
});

describe("s04-like: one target text through 12 channels (A3.1)", () => {
  test("each channel hit exactly once with the docs/05 s04 decode chain", () => {
    const r = find(S04, TARGET);
    for (const ch of CHANNELS) {
      const ref = ids.get(ch.url);
      const hs = r.hits.filter((h) => h.ref === ref);
      expect({ channel: ch.name, n: hs.length }).toEqual({ channel: ch.name, n: 1 });
      const h = hs[0] as FindHit;
      expect(plain({ channel: ch.name, decode: h.decode, path: h.path, innerPath: h.innerPath, match: h.match })).toEqual({ channel: ch.name, ...ch.expect, match: "exact" });
      expect(h.snippet).toContain(TARGET);
    }
  });

  test("document body is searched (A3.6); binary skipped; missing bodies counted", () => {
    const r = find(S04, TARGET);
    const doc = r.hits.find((h) => h.ref === ids.get("/s04/"));
    expect(doc).toMatchObject({ type: "document", decode: [], path: null, part: "response" });
    expect(r.hits.length).toBe(CHANNELS.length + 1);
    expect(r.searched.bodies).toBe(CHANNELS.length + 1);
    expect(r.searched.skipped.binary).toBe(1);
    expect(r.searched.skippedList[0]).toMatchObject({ ref: ids.get("/img/logo.png"), reason: "binary" });
    expect(r.searched.missing).toEqual({ navigated: 1 });
    expect(r.hints).toBeNull();
    expect(r.searched.decoders).toMatchObject({ base64: 2, gzip: 1, json: 4, "json-string": 1, jsonp: 1, sse: 1, ndjson: 1, urldecode: 1, "html-entities": 1 });
  });

  test("negative control (A3.3): 0 hits, searched summary, no encryption hint", () => {
    const r = find(S04, "靶场 s04 不存在的文字");
    expect(r.hits).toEqual([]);
    expect(r.hints?.suspectEncrypted).toEqual([]);
    expect(r.hints?.missingBodies).toEqual({ total: 1, reasons: { navigated: 1 }, requests: [ids.get("/api/s04/slow") ?? ""] });
    expect(r.searched.bodies).toBe(13);
  });

  test("normalized match: half-width punctuation finds the full-width text", () => {
    const r = find(S04, "靶场  s04 目标文本:全角!");
    expect(r.hits.length).toBe(CHANNELS.length + 1);
    expect(r.hits.every((h) => h.match === "normalized")).toBe(true);
    expect(r.hits.find((h) => h.ref === ids.get("/api/s04/e"))?.decode).toEqual(["base64", "gzip", "json"]);
  });

  test("--ignore-case", () => {
    expect(find(S04, "S04 目标文本").hits.length).toBe(0);
    expect(find(S04, "S04 目标文本", { ignoreCase: true }).hits.length).toBe(CHANNELS.length + 1);
  });
});

describe("HAR-imported bodies report the wire decoding (docs/05 s04 b/c, A3.2)", () => {
  const harWith = (headers: { name: string; value: string }[], content: Record<string, unknown>) => ({
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      pages: [],
      entries: [
        {
          startedDateTime: "2026-10-15T01:00:00.100Z",
          time: 5,
          _resourceType: "xhr",
          request: { method: "GET", url: "http://127.0.0.1:4310/api/s04/b", httpVersion: "http/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 200, statusText: "OK", httpVersion: "http/1.1", headers, cookies: [], content, redirectURL: "", headersSize: -1, bodySize: -1 },
          cache: {},
          timings: { send: 0, wait: 1, receive: 1 },
        },
      ],
    },
  });
  const titled = JSON.stringify({ title: TARGET });

  test("compressed bytes in the HAR (s04-gzip-raw style) -> [gzip]", async () => {
    const out = tmp();
    await importHar(harWith([{ name: "content-encoding", value: "gzip" }], { size: 0, mimeType: "application/json", text: b64(new Uint8Array(gzipSync(enc(titled)))), encoding: "base64" }), out);
    expect(find(out, TARGET).hits.map((h) => [h.decode, h.path])).toEqual([[["gzip"], "$.title"]]);
  });

  test("DevTools style (already decoded text, content-encoding: br) -> [br] (§13 ruling 4)", async () => {
    const out = tmp();
    await importHar(harWith([{ name: "Content-Encoding", value: "br" }], { size: 0, mimeType: "application/json", text: titled }), out);
    expect(find(out, TARGET).hits.map((h) => [h.decode, h.path])).toEqual([[["br"], "$.title"]]);
  });
});

describe("s05-like: encrypted response (A3.4)", () => {
  const TARGET5 = "靶场 s05 机密文本";
  let dir = "";
  const sid = new Map<string, string>();

  beforeAll(async () => {
    const keyBytes = new Uint8Array(createHash("sha256").update("s05-key").digest());
    const iv = new Uint8Array(createHash("sha256").update("s05-iv").digest()).slice(0, 12);
    const plain = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, title: i === 7 ? TARGET5 : `条目 ${i} 普通内容` })) });
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc(plain)));
    // the fixture is real: it decrypts back to a plaintext that holds the target
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct))).toContain(TARGET5);
    expect(ct.length).toBeGreaterThan(1024);
    dir = await buildBundle(tmp("tabcap-s05-"), { name: "range-s05", created: T0, seed: 5 }, async (b) => {
      const k = await b.request({ url: `${ORIGIN}/api/key`, ts: T0 + 100, mime: "application/json", body: JSON.stringify({ alg: "AES-GCM", key: b64(keyBytes), iv: b64(iv) }) });
      const s = await b.request({ url: `${ORIGIN}/api/secret`, ts: T0 + 200, mime: "text/plain", body: b64(ct) });
      const s2 = await b.request({ url: `${ORIGIN}/api/secret2`, ts: T0 + 300, mime: "application/json", body: JSON.stringify({ v: 1, iv: b64(iv), data: b64(ct) }) });
      // high entropy but a known container (zip magic): not a suspect
      const zipLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...ct, ...ct]);
      const z = await b.request({ url: `${ORIGIN}/api/archive`, ts: T0 + 400, mime: "application/octet-stream", body: zipLike });
      sid.set("key", idOf(k)).set("secret", idOf(s)).set("secret2", idOf(s2)).set("archive", idOf(z));
    });
  }, SLOW_IO_MS);

  test("0 hits; suspectEncrypted lists the ciphertexts, not the key or the zip body", () => {
    const r = find(dir, TARGET5);
    expect(r.hits).toEqual([]);
    const sus = r.hints?.suspectEncrypted ?? [];
    expect(plain(sus.map((s) => [s.ref, s.decode, s.path]))).toEqual([
      [sid.get("secret"), ["base64"], null],
      [sid.get("secret2"), ["base64"], "$.data"],
    ]);
    for (const s of sus) expect(s.entropy).toBeGreaterThan(7.3);
    expect(sus.map((s) => s.ref)).not.toContain(sid.get("key"));
    expect(r.hints?.message).toContain(sid.get("secret") ?? "?");
  });
});

describe("ws frames and console (docs/04 §4.1, A3.5)", () => {
  test("hits in a text frame, a gzip binary frame and a console line", async () => {
    const T = "签名校验失败 code=4031";
    let hs = "";
    const seqs: number[] = [];
    const dir = await buildBundle(tmp("tabcap-ws-"), { name: "ws", created: T0, seed: 7 }, async (b) => {
      hs = idOf(await b.request({ url: "ws://127.0.0.1:4310/ws/echo", type: "websocket", status: 101, ts: T0 + 10, mime: null }));
      await b.ws(hs, T0 + 20, "send", { text: '{"op":"sub"}' });
      seqs.push((await b.ws(hs, T0 + 30, "recv", { text: JSON.stringify({ op: "push", msg: T }) })).seq);
      seqs.push((await b.ws(hs, T0 + 40, "recv", { binary: new Uint8Array(gzipSync(enc(JSON.stringify({ op: "bin", msg: T })))) })).seq);
      seqs.push(b.console(T0 + 50, `Error: ${T} at verify()`).seq);
    });
    const r = find(dir, T);
    expect(plain(r.hits.map((h) => [h.kind, h.ref, h.seq, h.decode, h.path]))).toEqual([
      ["ws", hs, seqs[0], [], "$.msg"],
      ["ws", hs, seqs[1], ["gzip"], "$.msg"],
      ["console", null, seqs[2], [], null],
    ]);
    expect(r.hits[0]?.url).toBe("ws://127.0.0.1:4310/ws/echo");
    expect(r.searched).toMatchObject({ wsFrames: 3, console: 1 });
  });
});

describe("hostile bodies do not crash find", () => {
  test("deep nesting, broken JSON, gzip bomb, base64 tower, truncated gzip", async () => {
    let tower = "needle-in-tower";
    for (let i = 0; i < 8; i++) tower = b64(tower);
    const bomb = new Uint8Array(gzipSync(new Uint8Array(33 * 1024 * 1024)));
    const dir = await buildBundle(tmp("tabcap-hostile-"), { name: "hostile", created: T0, seed: 9 }, async (b) => {
      await b.request({ url: `${ORIGIN}/deep`, ts: T0 + 1, mime: "application/json", body: "[".repeat(100_000) + '"deep-leaf"' + "]".repeat(100_000) });
      await b.request({ url: `${ORIGIN}/broken`, ts: T0 + 2, mime: "application/json", body: '{"a": [1, 2, {"b": "unterminated' });
      await b.request({ url: `${ORIGIN}/bomb`, ts: T0 + 3, mime: "application/json", body: JSON.stringify({ data: b64(bomb) }) });
      await b.request({ url: `${ORIGIN}/tower`, ts: T0 + 4, mime: "text/plain", body: tower });
      await b.request({ url: `${ORIGIN}/trunc`, ts: T0 + 5, mime: "application/json", wireEncoding: "gzip", body: new Uint8Array(gzipSync(enc("needle-in-tower"))).slice(0, 12) });
    });
    const r = find(dir, "needle-in-tower");
    expect(r.hits).toEqual([]); // the tower is deeper than MAX_DEPTH (4) and must not be followed
    // a needle that spans JSON syntax only exists in the raw text: text hit, no path
    expect(find(dir, '"deep-leaf"').hits.map((h) => [h.url, h.path])).toEqual([[`${ORIGIN}/deep`, null]]);
    expect(find(dir, "deep-leaf").hits.map((h) => h.path)).toEqual(["$" + "[0]".repeat(100_000)]);
    let shallow = "needle-in-tower";
    for (let i = 0; i < 3; i++) shallow = b64(shallow);
    const dir2 = await buildBundle(tmp("tabcap-hostile2-"), { name: "h2", created: T0, seed: 10 }, async (b) => {
      await b.request({ url: `${ORIGIN}/t3`, ts: T0 + 1, mime: "text/plain", body: shallow });
    });
    expect(find(dir2, "needle-in-tower").hits.map((h) => h.decode)).toEqual([["base64", "base64", "base64"]]);
  });
});

describe("CLI: tabcap analyze find", () => {
  test("JSON envelope, --text rendering snapshot, --save appends a finding", async () => {
    const dir = await buildS04(tmp("tabcap-s04cli-"));
    const j = await run(["analyze", "find", dir, ...TARGET.split(" ")]);
    expect(j.code).toBe(0);
    if (!j.envelope.ok) throw new Error(j.envelope.error.message);
    expect(j.envelope.data).toMatchObject({ query: { text: TARGET }, saved: null });

    const t = await run(["analyze", "find", dir, TARGET, "--text"]);
    expect((t.text ?? "").split(dir).join("<bundle>")).toMatchSnapshot();
    const neg = await run(["analyze", "find", dir, "靶场 s04 不存在的文字", "--text"]);
    expect((neg.text ?? "").split(dir).join("<bundle>")).toMatchSnapshot();

    const s = await run(["analyze", "find", dir, TARGET, "--save"]);
    if (!s.envelope.ok) throw new Error(s.envelope.error.message);
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(last).toMatchObject({ kind: "finding", tool: "find", grade: "实测", actor: "ai", input: { text: TARGET } });
    expect(last.evidence).toContainEqual({ request: ids.get("/api/s04/d"), path: "$.data -> $.title" });
    const info = await run(["bundle", "info", dir]);
    expect(info.envelope).toMatchObject({ ok: true, data: { warnings: [] } });

    expect((await run(["analyze", "find", dir])).code).toBe(2);
    expect((await run(["analyze", "find", dir, "x", "--bogus"])).code).toBe(2);
  });
});
