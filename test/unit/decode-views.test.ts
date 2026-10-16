// 0.6-B: the analysis commands read decoded views (step `plugin:<name>` ahead
// of the built-in steps): find, where, deps (inputs from decoded request
// bodies, sources in decoded responses — no request-to-request cycle), recon
// channels, replay check (decoded bodies compared when both sides decode),
// redaction of the views, net show. The bundle is the s42 flow recorded
// without a plugin, then decoded by `bundle decode` with the range plugin.
// Oracle: the s42 plaintexts written by hand in test/e2e/site.ts and the
// JSON paths read off them; the undecoded bundle shows what 0.6-B fixes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeBundle } from "../../src/bundle/decode.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { redactBundle } from "../../src/bundle/redact.ts";
import { DepsGraph, depsOf, type DepsSource } from "../../src/analyze/deps.ts";
import { find } from "../../src/analyze/find.ts";
import { buildDossier, recordedPage } from "../../src/analyze/recon.ts";
import { whereIn } from "../../src/analyze/where.ts";
import { DecodeHost, DecodeSession } from "../../src/daemon/hooks/decode.ts";
import { decodePlugins } from "../../src/daemon/hooks/plugins.ts";
import { requestDetail } from "../../src/daemon/tools/netshow.ts";
import { BlobStore } from "../../src/bundle/blobs.ts";
import { DEFAULT_HEADERS, check } from "../../src/replay/check.ts";
import { S42_ITEMS_JSON, S42_ORDER_JSON, S42_TOKEN, S42_TOKEN_JSON, xorEncode } from "../e2e/site.ts";
import { tmp } from "./_analyze.ts";
import { installXor, s42Bundle } from "./_decode.ts";

const P = "plugin:xor-decode";
let root = "";
let config = "";
let decoded = "";
let plain = "";

beforeAll(async () => {
  root = tmp("tabcap-decv-");
  config = join(root, "config");
  installXor(config);
  plain = await s42Bundle(join(root, "plain"));
  decoded = await s42Bundle(join(root, "decoded"));
  const host = new DecodeHost();
  try {
    await decodeBundle(decoded, new DecodeSession(host, decodePlugins(config)));
  } finally {
    host.close();
  }
}, 20_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hitsOf = (dir: string, text: string) => find(dir, text).hits.map((h) => ({ ref: h.ref, part: h.part, decode: h.decode, path: h.path }));

describe("find", () => {
  test("a value only in the plaintext: chain starts with the plugin step", () => {
    expect(hitsOf(plain, S42_TOKEN)).toEqual([]);
    expect(hitsOf(decoded, S42_TOKEN)).toEqual([
      { ref: "r-3", part: "response", decode: [P], path: "$.token" },
      { ref: "r-5", part: "request-body", decode: [P], path: "$.token" },
    ]);
    const r = find(decoded, "S42-ORDER-0077");
    expect(r.hits.map((h) => [h.ref, h.decode, h.path, h.mime])).toEqual([["r-5", [P], "$.order", "application/json"]]);
    expect(r.searched.decoders[P]).toBe(4);
    expect(r.searched.bodies).toBe(5);
  });

  test("a body whose view has no hit is still searched in the original, never judged encrypted", () => {
    const enc = xorEncode(S42_ITEMS_JSON).slice(0, 24);
    expect(hitsOf(decoded, enc)).toEqual([{ ref: "r-4", part: "response", decode: [], path: null }]);
    expect(find(decoded, "nothing like this anywhere").hints?.suspectEncrypted).toEqual([]);
  });
});

describe("where", () => {
  test("a page cell resolves to the decoded path", () => {
    const w = whereIn(BundleReader.open(decoded), { input: "甲号商品", kind: "text", text: "甲号商品" });
    expect(w.candidates).toEqual([{ request: "r-4", path: "$.items[0].name", chain: [P], match: "exact", score: 1 }]);
    expect(whereIn(BundleReader.open(plain), { input: "甲号商品", kind: "text", text: "甲号商品" }).candidates).toEqual([]);
  });
});

describe("deps", () => {
  const inputs = (dir: string, id: string) => depsOf(DepsGraph.open(dir), dir).requests.find((r) => r.id === id)?.inputs ?? [];
  const primary = (dir: string, id: string, location: string, name: string) => inputs(dir, id).find((i) => i.location === location && (i.path ?? i.name) === name)?.primary ?? null;

  test("inputs come from the decoded request body; sources from decoded responses (no request-to-request cycle)", () => {
    const tokenSrc: DepsSource = { kind: "response", request: "r-3", path: "$.token", decode: [P], match: "exact" };
    expect(primary(decoded, "r-5", "body", "$.token")).toEqual(tokenSrc);
    expect(primary(decoded, "r-5", "body", "$.item")).toEqual({ kind: "response", request: "r-4", path: "$.items[0].id", decode: [P], match: "exact" });
    expect(primary(decoded, "r-5", "header", "x-auth")).toEqual(tokenSrc);
    expect(primary(decoded, "r-4", "header", "x-auth")).toEqual(tokenSrc);
    // before decoding: the body is opaque and x-auth points back at the earlier request (the reported cycle)
    expect(inputs(plain, "r-5").filter((i) => i.location === "body")).toEqual([]);
    expect(primary(plain, "r-5", "header", "x-auth")).toEqual({ kind: "request", request: "r-4", path: "header:x-auth" });
    // (its first send has no producer at all: a single-sample constant)
    expect(primary(plain, "r-4", "header", "x-auth")).toEqual({ kind: "constant", samples: 1 });
  });
});

describe("recon", () => {
  test("channels report the plugin step in decode", () => {
    const reader = BundleReader.open(decoded);
    const d = buildDossier(reader, recordedPage(reader), { now: 0 });
    expect(d.channels.map((c) => [c.method, c.template, c.decode])).toEqual([
      ["GET", "/s42", []],
      ["GET", "/s42/api/token", [P]],
      ["GET", "/s42/api/items", [P]],
      ["POST", "/s42/api/order", [P]],
    ]);
  });
});

describe("replay check", () => {
  test("bodies are compared decoded when both sides decode; a raw difference that decodes the same is not a difference", async () => {
    const answers: Record<string, string> = {
      "/s42/api/token": xorEncode(S42_TOKEN_JSON) + "\n", // other bytes, same plaintext
      "/s42/api/items": xorEncode(S42_ITEMS_JSON.replace("1288.50", "1288.51")),
      "/s42/api/order": xorEncode(S42_ORDER_JSON),
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/s42") return new Response("<p>s42</p>", { headers: { "content-type": "text/html" } });
        const a = answers[p];
        return a === undefined ? new Response("nf", { status: 404 }) : new Response(a, { headers: { "content-type": "text/plain", "x-enc": "xor" } });
      },
    });
    try {
      const res = await check({ bundle: decoded, against: `http://127.0.0.1:${server.port}`, live: false, withCookies: false, headers: DEFAULT_HEADERS, configDir: config });
      const row = (id: string) => res.rows.find((r) => r.id === id);
      expect(row("r-3")?.result).toBe("same");
      expect(row("r-3")?.notes).toEqual([`body compared as decoded by xor-decode (${P})`]);
      expect(row("r-4")?.result).toBe("different");
      expect(row("r-4")?.diffs.body).toEqual({ kind: "json", fields: [{ path: "$.items[0].price", kind: "changed", recorded: JSON.stringify("1288.50"), got: JSON.stringify("1288.51") }], count: 1 });
      expect(row("r-5")?.result).toBe("same");
      // the undecoded recording compares the original bytes: the trailing newline is a difference
      const raw = await check({ bundle: plain, against: `http://127.0.0.1:${server.port}`, live: false, withCookies: false, headers: DEFAULT_HEADERS, configDir: config });
      expect(raw.rows.find((r) => r.id === "r-3")?.diffs.body?.kind).toBe("text");
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

describe("redaction and net show", () => {
  test("a redacted copy redacts the views like bodies (the token key is a sensitive name)", async () => {
    const out = join(root, "redacted");
    await redactBundle(decoded, out, { salt: "00".repeat(16) });
    const r = BundleReader.open(out);
    const tok = r.requests().find((x) => x.id === "r-3")?.response?.decoded;
    const text = tok?.blob ? new TextDecoder().decode(r.readBlob(tok.blob) ?? new Uint8Array()) : "";
    expect(text).toContain('"ttl":600');
    expect(text).not.toContain(S42_TOKEN);
    expect(readFileSync(join(out, "events.jsonl"), "utf8")).not.toContain(S42_TOKEN);
  });

  test("net show lists each side's view", () => {
    const ev = BundleReader.open(decoded).events.find((e) => e["id"] === "r-5");
    if (ev === undefined) throw new Error("no r-5");
    const store = new BlobStore(decoded);
    const d = requestDetail(ev, store, () => "");
    const blob = BundleReader.open(decoded).requests().find((r) => r.id === "r-5")?.response?.decoded?.blob ?? "";
    expect(d["response"]).toMatchObject({ decoded: { by: "xor-decode", version: "1", ok: true, mime: "application/json", bytes: S42_ORDER_JSON.length, blob, path: store.pathOf(blob) } });
    expect(d["request"]).toMatchObject({ decoded: { by: "xor-decode", ok: true, mime: "application/json" } });
  });
});
