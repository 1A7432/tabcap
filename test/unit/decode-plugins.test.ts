// 0.6-B decode plugins: manifest validation (untrusted input), the
// tabcap-decode/1 protocol against a fake plugin process (framing, timeouts,
// crashes, oversized answers, disable after MAX_FAILURES), the recorder's
// `decoded` field and blob (fake CDP transport, the range plugin), and
// `bundle decode` on a bundle recorded without a plugin (views go to the
// decoded.jsonl sidecar; events.jsonl never changes, owner ruling 10-16).
// Oracles: docs/04 §28 (shapes, written before the code in the brief), the
// fake plugin's documented behaviour (test/fixtures/plugins/fake-decode), and
// the s42 plaintexts written by hand in test/e2e/site.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { decodeBundle, renderBundleDecodeText } from "../../src/bundle/decode.ts";
import { SIDECAR_FILE, declinedRow, latestViews, overlayEvent, parseDecoded, parseSidecarText } from "../../src/bundle/decoded.ts";
import { BlobStore } from "../../src/bundle/blobs.ts";
import { decodedEntry } from "../../src/daemon/tools/net.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { DecodeHost, DecodeSession, MAX_FAILURES, decodeMatches, decodeSkip, parseDecodeReply, resolveDecodeCommand, type DecodeJob, type DecodePlugin } from "../../src/daemon/hooks/decode.ts";
import { MAX_PLUGIN_MANIFEST_BYTES, decodePlugins, listPlugins, liveDecodePlugins, parseManifest, pluginsFor, setEnabled } from "../../src/daemon/hooks/plugins.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";
import { S42_ITEMS_JSON, S42_ORDER_JSON, S42_POST_JSON, S42_TOKEN_JSON, xorEncode } from "../e2e/site.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { S42_ORIGIN as ORIGIN, installXor, s42Bundle } from "./_decode.ts";

const FAKE = join(import.meta.dir, "..", "fixtures", "plugins", "fake-decode");

const GOOD = {
  name: "dec",
  kind: "decode",
  version: "2",
  description: "d",
  match: { host: ["127.0.0.1", "*.example.test"], path: ["/api/*"], contentTypes: ["text/plain", "application/*"], direction: "both" },
  command: ["./run.sh", "--flag"],
  timeoutMs: 800,
  maxBytes: 4096,
};

describe("decode manifests (untrusted input)", () => {
  test("the documented shape parses; defaults for path / contentTypes / direction / timeoutMs / maxBytes", () => {
    expect(parseManifest(GOOD, "dec")).toEqual({
      name: "dec",
      version: "2",
      description: "d",
      hooks: [],
      command: ["./run.sh", "--flag"],
      timeoutMs: 800,
      decode: { match: { host: ["127.0.0.1", "*.example.test"], path: ["/api/*"], contentTypes: ["text/plain", "application/*"], direction: "both" }, maxBytes: 4096 },
    });
    const min = parseManifest({ name: "dec", kind: "decode", version: "1", match: { host: ["127.0.0.1"] }, command: ["uv", "run", "runner.py"] }, "dec");
    expect(min.decode).toEqual({ match: { host: ["127.0.0.1"], path: ["/**"], contentTypes: ["*/*"], direction: "response" }, maxBytes: 8 * 1024 * 1024 });
    expect(min.timeoutMs).toBe(5000);
  });

  test("unknown keys, bad values and commands outside the directory are refused", () => {
    const bad: Record<string, unknown>[] = [
      { ...GOOD, extra: 1 },
      { ...GOOD, hooks: ["challenge"] },
      { ...GOOD, version: undefined },
      { ...GOOD, version: "x".repeat(65) },
      { ...GOOD, match: { ...GOOD.match, method: ["GET"] } },
      { ...GOOD, match: { ...GOOD.match, host: [] } },
      { ...GOOD, match: { path: ["/x"] } },
      { ...GOOD, match: { ...GOOD.match, host: ["exa mple"] } },
      { ...GOOD, match: { ...GOOD.match, path: ["api/*"] } },
      { ...GOOD, match: { ...GOOD.match, path: ["/a?b=1"] } },
      { ...GOOD, match: { ...GOOD.match, contentTypes: ["text/plain; charset=utf-8"] } },
      { ...GOOD, match: { ...GOOD.match, direction: "sideways" } },
      { ...GOOD, match: { ...GOOD.match, host: Array.from({ length: 33 }, () => "a") } },
      { ...GOOD, command: [] },
      { ...GOOD, command: ["sub/run"] },
      { ...GOOD, command: ["./a\0b"] },
      { ...GOOD, timeoutMs: 50 },
      { ...GOOD, timeoutMs: 60_001 },
      { ...GOOD, maxBytes: 0 },
      { ...GOOD, maxBytes: 33 * 1024 * 1024 },
      { ...GOOD, kind: "encode" },
      { ...GOOD, description: "x".repeat(501) },
    ];
    bad.forEach((b) => expect(() => parseManifest(b, "dec")).toThrow("plugin manifest"));
  });

  test("argv: ./ elements resolve inside the directory, never outside; bare program names go to PATH", () => {
    expect(resolveDecodeCommand("/p/x", ["./run.sh", "./conf/a.json", "-v"])).toEqual([resolve("/p/x/run.sh"), resolve("/p/x/conf/a.json"), "-v"]);
    expect(resolveDecodeCommand("/p/x", ["uv", "run", "--project", ".", "runner.py"])).toEqual(["uv", "run", "--project", ".", "runner.py"]);
    expect(() => resolveDecodeCommand("/p/x", ["./run.sh", "../y/key"])).toThrow("outside");
    expect(() => resolveDecodeCommand("/p/x", ["../y/run"])).toThrow("outside");
  });

  test("listing: oversized manifests are refused unread; decode plugins are not challenge handlers; only enabled ones decode", () => {
    const config = join(tmp("tabcap-decm-"), "config");
    const install = (name: string, text: string) => {
      mkdirSync(join(config, "plugins", name), { recursive: true, mode: 0o700 });
      writeFileSync(join(config, "plugins", name, "manifest.json"), text);
    };
    install("dec", JSON.stringify(GOOD));
    install("huge", JSON.stringify({ ...GOOD, name: "huge", description: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES) }));
    expect(listPlugins(config).find((p) => p.name === "huge")?.error).toBe(`manifest.json is over ${MAX_PLUGIN_MANIFEST_BYTES} bytes`);
    expect(decodePlugins(config)).toEqual([]);
    setEnabled(config, "dec", true);
    expect(decodePlugins(config).map((p) => [p.name, p.version, p.timeoutMs])).toEqual([["dec", "2", 800]]);
    expect(pluginsFor(config, "challenge")).toEqual([]);
  });

  test("0.7-E: a recording's live set follows plugin enable / disable; used keeps every plugin it has had", () => {
    const config = join(tmp("tabcap-decl-"), "config");
    mkdirSync(join(config, "plugins", "dec"), { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "plugins", "dec", "manifest.json"), JSON.stringify(GOOD));
    const s = new DecodeSession(new DecodeHost(), liveDecodePlugins(config));
    const at = { url: "http://127.0.0.1/api/x", mime: "text/plain", direction: "response" as const };
    expect(s.empty).toBe(true);
    expect(s.matching(at)).toEqual([]);
    setEnabled(config, "dec", true);
    expect(s.empty).toBe(false);
    expect(s.matching(at).map((p) => p.name)).toEqual(["dec"]);
    setEnabled(config, "dec", false);
    expect(s.matching(at)).toEqual([]);
    expect(s.used).toEqual(["dec"]);
    // A fixed list stays fixed.
    expect(new DecodeSession(new DecodeHost(), [fake()]).used).toEqual(["fake"]);
  });
});

describe("matching by host / path / content type / direction", () => {
  const m = { host: ["127.0.0.1", "*.example.test"], path: ["/s42/api/*", "/v2/**"], contentTypes: ["text/plain", "application/*"], direction: "response" as const };
  test("globs and media types", () => {
    expect(decodeMatches(m, "http://127.0.0.1:9/s42/api/token?x=1", "text/plain; charset=utf-8", "response")).toBe(true);
    expect(decodeMatches(m, "http://a.b.example.test/v2/x/y", "application/octet-stream", "response")).toBe(true);
    expect(decodeMatches(m, "http://127.0.0.1:9/s42/api/a/b", "text/plain", "response")).toBe(false); // * stays in one segment
    expect(decodeMatches(m, "http://localhost/s42/api/token", "text/plain", "response")).toBe(false);
    expect(decodeMatches(m, "http://127.0.0.1/s42/api/token", "text/html", "response")).toBe(false);
    expect(decodeMatches(m, "http://127.0.0.1/s42/api/token", null, "response")).toBe(false);
    expect(decodeMatches(m, "http://127.0.0.1/s42/api/token", "text/plain", "request")).toBe(false);
    expect(decodeMatches({ ...m, direction: "both" }, "http://127.0.0.1/s42/api/token", "text/plain", "request")).toBe(true);
    expect(decodeMatches(m, "not a url", "text/plain", "response")).toBe(false);
  });
});

const fake = (o: Partial<DecodePlugin> = {}): DecodePlugin => ({
  name: "fake",
  dir: FAKE,
  version: "0",
  command: [process.execPath, "./fake.ts"],
  timeoutMs: 1500,
  decode: { match: { host: ["127.0.0.1"], path: ["/**"], contentTypes: ["*/*"], direction: "both" }, maxBytes: 1024 * 1024 },
  ...o,
});

const job = (text: string, o: Partial<DecodeJob> = {}): DecodeJob => ({
  direction: "response",
  id: "r-7",
  url: `${ORIGIN}/api/x`,
  method: "GET",
  requestHeaders: { accept: "*/*", cookie: "sid=s3cret", authorization: "Bearer t0ken", "x-enc": "xor" },
  response: { status: 200, headers: { "content-type": "text/plain", "set-cookie": ["a=1"], "x-enc": "xor" } },
  body: new TextEncoder().encode(text),
  mime: "text/plain",
  ...o,
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("protocol tabcap-decode/1 against a fake plugin process", () => {
  let host: DecodeHost;
  beforeEach(() => {
    host = new DecodeHost();
  });
  afterEach(() => host.close());

  test("one long-lived process answers line by line; credentials are never sent", async () => {
    const s = new DecodeSession(host, [fake()]);
    const a = await s.decode(job("hello"));
    const b = await s.decode(job("world"));
    expect(a).toMatchObject({ by: "fake", version: "0", direction: "response", ok: true, mime: "text/plain" });
    expect(a?.ok === true ? text(a.body) : null).toBe("HELLO");
    expect(b?.ok === true ? text(b.body) : null).toBe("WORLD");
    expect(a?.ok === true && b?.ok === true ? a.note === b.note : false).toBe(true); // same pid
    expect(host.starts("fake")).toBe(1);
    const h = await s.decode(job("headers"));
    expect(h?.ok === true ? JSON.parse(text(h.body)) : null).toEqual({ request: ["accept", "x-enc"], response: ["content-type", "x-enc"] });
  });

  test("declined is an answer, not a failure: null, no failure counted, reported per plugin", async () => {
    const disabled: string[] = [];
    const s = new DecodeSession(host, [fake()], { onDisabled: (n) => disabled.push(n) });
    const seen: string[] = [];
    for (let i = 0; i < MAX_FAILURES + 1; i++) expect(await s.decode(job("decline"), (n) => seen.push(n))).toBeNull();
    expect(seen).toEqual(Array(MAX_FAILURES + 1).fill("fake"));
    expect(disabled).toEqual([]);
    expect(s.isDisabled("fake")).toBe(false);
    expect(host.starts("fake")).toBe(1);
    // a later plugin that takes the body still wins after an earlier one declined
    const a = fake({ name: "a-first" });
    const b = fake({ name: "b-second" });
    const t = new DecodeSession(host, [a, b]);
    const order: string[] = [];
    expect(await t.decode(job("decline"), (n) => order.push(n))).toBeNull();
    expect(order).toEqual(["a-first", "b-second"]);
    expect((await t.decode(job("hello")))?.ok).toBe(true);
  });

  test("ok:false is an answer, not a failure: the plugin stays enabled", async () => {
    const disabled: string[] = [];
    const s = new DecodeSession(host, [fake()], { onDisabled: (n) => disabled.push(n) });
    for (let i = 0; i < MAX_FAILURES + 1; i++) expect(await s.decode(job("fail"))).toMatchObject({ ok: false, error: "cannot decode this one" });
    expect(disabled).toEqual([]);
    expect(host.starts("fake")).toBe(1);
  });

  test("timeout, crash, garbage, wrong id and an oversized line each kill the process; the next call restarts it", async () => {
    const s = new DecodeSession(host, [fake()], { maxFailures: 99 });
    expect(await s.decode(job("hang"))).toMatchObject({ ok: false, error: "timed out after 1500 ms" });
    expect(await s.decode(job("crash"))).toMatchObject({ ok: false, error: "exited with code 3" });
    expect(await s.decode(job("garbage"))).toMatchObject({ ok: false, error: "answer is not one JSON line" });
    expect(await s.decode(job("wrongid"))).toMatchObject({ ok: false });
    const big = await s.decode(job("big"));
    expect(big?.ok === false ? big.error : "").toContain("answer line over");
    const after = await s.decode(job("fine"));
    expect(after?.ok === true ? text(after.body) : null).toBe("FINE");
    expect(host.starts("fake")).toBe(6);
  }, 20_000);

  test(`${MAX_FAILURES} failures disable the plugin for the session (once), later bodies are not offered`, async () => {
    const disabled: Array<[string, string]> = [];
    const s = new DecodeSession(host, [fake()], { onDisabled: (n, r) => disabled.push([n, r]) });
    for (let i = 0; i < MAX_FAILURES; i++) await s.decode(job("crash"));
    expect(disabled).toEqual([["fake", "3 failures, last: exited with code 3"]]);
    expect(s.isDisabled("fake")).toBe(true);
    expect(await s.decode(job("hello"))).toBeNull();
    // another session of the same daemon still uses it
    const other = await new DecodeSession(host, [fake()]).decode(job("hello"));
    expect(other?.ok).toBe(true);
  }, 20_000);

  test("bodies over maxBytes are not sent; a plugin that cannot start fails without throwing; no match is null", async () => {
    const s = new DecodeSession(host, [fake({ decode: { match: { host: ["127.0.0.1"], path: ["/**"], contentTypes: ["*/*"], direction: "both" }, maxBytes: 3 } })]);
    expect(await s.decode(job("hello"))).toMatchObject({ ok: false, error: "body of 5 bytes is over maxBytes 3; not sent" });
    expect(host.starts("fake")).toBe(0);
    const missing = await new DecodeSession(host, [fake({ name: "gone", command: ["./no-such-file"] })]).decode(job("x"));
    expect(missing?.ok).toBe(false);
    expect(await s.decode(job("hello", { url: "http://localhost/api/x" }))).toBeNull();
  });

  test("answers are validated", () => {
    expect(parseDecodeReply(null, 1, 10)).toBe("answer is not a JSON object");
    expect(parseDecodeReply({ id: 2, ok: true }, 1, 10)).toContain("is not 1");
    expect(parseDecodeReply({ id: 1, ok: "yes" }, 1, 10)).toBe("answer has no boolean ok");
    expect(parseDecodeReply({ id: 1, ok: true, body: { encoding: "hex", data: "00" } }, 1, 10)).toContain("encoding");
    expect(parseDecodeReply({ id: 1, ok: true, body: { encoding: "base64", data: "%%%" } }, 1, 10)).toBe("answer body is not base64");
    expect(parseDecodeReply({ id: 1, ok: true, body: { encoding: "utf8", data: "x".repeat(11) } }, 1, 10)).toContain("over maxBytes 10");
    expect(parseDecodeReply({ id: 1, ok: true, mime: "a\nb", body: { encoding: "utf8", data: "x" } }, 1, 10)).toMatchObject({ ok: true, mime: null, note: null });
    expect(parseDecodeReply({ id: 1, ok: false }, 1, 10)).toEqual({ ok: false, error: "the plugin reported a failure" });
    // declined (decode() returned None / null) is an answer of its own, not ok:false and not a protocol failure
    expect(parseDecodeReply({ id: 1, declined: true }, 1, 10)).toEqual({ declined: true });
    expect(parseDecodeReply({ id: 2, declined: true }, 1, 10)).toContain("is not 1");
    expect(parseDecodeReply({ id: 1, declined: "yes" }, 1, 10)).toBe("answer has no boolean ok");
  });
});

// ------------------------------------------------------------ recorder

function fakeChrome(bodies: Record<string, string>) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}) => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getResponseBody") {
        const id = typeof params["requestId"] === "string" ? params["requestId"] : "";
        return { body: Buffer.from(bodies[id] ?? "").toString("base64"), base64Encoded: true };
      }
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => target(),
    detach: async () => undefined,
    waitAttached: async () => target(),
    targets: () => [],
  };
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const l of [...listeners]) l({ method, params, sessionId: "S1" });
  };
  return { t, emit };
}


describe("recorder: decoded views beside the original bodies", () => {
  test("the range plugin's plaintext is a blob referenced as request.decoded / response.decoded; the originals are untouched", async () => {
    const config = join(tmp("tabcap-decr-"), "config");
    installXor(config);
    const host = new DecodeHost();
    const notes: string[] = [];
    const session = new DecodeSession(host, decodePlugins(config), { onDisabled: (n) => notes.push(n) });
    const encOrder = xorEncode(S42_ORDER_JSON);
    const encPost = xorEncode(S42_POST_JSON);
    const { t, emit } = fakeChrome({ R1: encOrder, R2: "<p>plain</p>" });
    const tabs = new Tabs(t, false);
    await tabs.createTab("dec");
    const dir = join(tmp("tabcap-decb-"), "b");
    const rec = await Recorder.start({ session: "dec", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, decode: session });
    emit("Network.requestWillBeSent", {
      requestId: "R1",
      loaderId: "L1",
      type: "Fetch",
      timestamp: 10,
      wallTime: 1760600000,
      request: { url: `${ORIGIN}/s42/api/order`, method: "POST", headers: { "content-type": "text/plain", "x-enc": "xor" }, postData: encPost, hasPostData: true },
    });
    emit("Network.responseReceived", { requestId: "R1", type: "Fetch", timestamp: 10.1, response: { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-enc": "xor" }, mimeType: "text/plain" } });
    emit("Network.loadingFinished", { requestId: "R1", timestamp: 10.2 });
    emit("Network.requestWillBeSent", { requestId: "R2", loaderId: "L1", type: "Fetch", timestamp: 11, wallTime: 1760600001, request: { url: `${ORIGIN}/s42/page`, method: "GET", headers: {} } });
    emit("Network.responseReceived", { requestId: "R2", type: "Fetch", timestamp: 11.1, response: { status: 200, headers: { "content-type": "text/html" }, mimeType: "text/html" } });
    emit("Network.loadingFinished", { requestId: "R2", timestamp: 11.2 });
    await Bun.sleep(50);
    await rec.stop();
    await host.close();

    const reader = BundleReader.open(dir);
    // the page body is written first: the order waits for the plugin
    const order = reader.requests().find((r) => r.url.endsWith("/s42/api/order"));
    const page = reader.requests().find((r) => r.url.endsWith("/s42/page"));
    const blobText = (ref: unknown) => (typeof ref === "string" ? new TextDecoder().decode(reader.readBlob(ref) ?? new Uint8Array()) : null);
    const raw = reader.events.find((e) => e.kind === "request" && e["url"] === `${ORIGIN}/s42/api/order`);
    const side = (k: string): Record<string, unknown> => {
      const v = raw?.[k];
      return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
    };
    const rawResp = side("response");
    const rawReq = side("request");
    // shapes exactly as docs/04 §28
    expect(rawResp["decoded"]).toEqual({ by: "xor-decode", version: "1", direction: "response", mime: "application/json", blob: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bytes: S42_ORDER_JSON.length, ok: true });
    expect(rawReq["decoded"]).toEqual({ by: "xor-decode", version: "1", direction: "request", mime: "application/json", blob: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bytes: S42_POST_JSON.length, ok: true });
    expect(blobText(order?.response?.decoded?.blob)).toBe(S42_ORDER_JSON);
    expect(blobText(order?.request.decoded?.blob)).toBe(S42_POST_JSON);
    // the originals stay what the page saw
    expect(blobText(order?.response?.body?.blob)).toBe(encOrder);
    expect(order?.request.postData).toEqual({ inline: encPost });
    // a body no plugin takes has no decoded field at all
    expect(page?.response?.decoded).toBeUndefined();
    expect(Object.keys(page?.request ?? {})).not.toContain("decoded");
    expect(notes).toEqual([]);
    // the live index carries the response view (net body)
    expect(rec.index.find((e) => e.url.endsWith("/order"))?.decoded).toMatchObject({ by: "xor-decode", mime: "application/json" });
  }, 20_000);

  test("a body the plugin declines (None / null) gets no decoded field, no note, no failure", async () => {
    const host = new DecodeHost();
    const notes: string[] = [];
    const session = new DecodeSession(host, [fake()], { onDisabled: (n) => notes.push(n) });
    const { t, emit } = fakeChrome({ R1: "decline", R2: "hello" });
    const tabs = new Tabs(t, false);
    await tabs.createTab("dec");
    const dir = join(tmp("tabcap-decn-"), "b");
    const rec = await Recorder.start({ session: "dec", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, decode: session });
    for (const [id, ts] of [["R1", 10], ["R2", 11]] as const) {
      emit("Network.requestWillBeSent", { requestId: id, loaderId: "L1", type: "Fetch", timestamp: ts, wallTime: 1760600000 + ts, request: { url: `${ORIGIN}/api/${id}`, method: "GET", headers: {} } });
      emit("Network.responseReceived", { requestId: id, type: "Fetch", timestamp: ts + 0.1, response: { status: 200, headers: { "content-type": "text/plain" }, mimeType: "text/plain" } });
      emit("Network.loadingFinished", { requestId: id, timestamp: ts + 0.2 });
    }
    await Bun.sleep(50);
    await rec.stop();
    await host.close();
    const reader = BundleReader.open(dir);
    const declined = reader.requests().find((r) => r.url.endsWith("/api/R1"));
    const taken = reader.requests().find((r) => r.url.endsWith("/api/R2"));
    expect(declined?.response?.decoded).toBeUndefined();
    expect(taken?.response?.decoded).toMatchObject({ ok: true, by: "fake" });
    expect(notes).toEqual([]);
    expect(session.isDisabled("fake")).toBe(false);
  }, 20_000);

  test("a plugin disabled after repeated failures leaves a note event and failed views say why", async () => {
    const host = new DecodeHost();
    let rec: Recorder | null = null;
    const session = new DecodeSession(host, [fake({ timeoutMs: 300 })], { onDisabled: (n, r) => void rec?.note(`decode plugin ${n} disabled for this session: ${r}`, { plugin: n }) });
    const bodies: Record<string, string> = {};
    for (let i = 0; i < MAX_FAILURES + 1; i++) bodies[`R${i}`] = "crash";
    const { t, emit } = fakeChrome(bodies);
    const tabs = new Tabs(t, false);
    await tabs.createTab("dis");
    const dir = join(tmp("tabcap-decn-"), "b");
    rec = await Recorder.start({ session: "dis", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, decode: session });
    for (let i = 0; i < MAX_FAILURES + 1; i++) {
      emit("Network.requestWillBeSent", { requestId: `R${i}`, loaderId: "L1", type: "Fetch", timestamp: 10 + i, wallTime: 1760600000 + i, request: { url: `${ORIGIN}/api/${i}`, method: "GET", headers: {} } });
      emit("Network.responseReceived", { requestId: `R${i}`, type: "Fetch", timestamp: 10.1 + i, response: { status: 200, headers: { "content-type": "text/plain" }, mimeType: "text/plain" } });
      emit("Network.loadingFinished", { requestId: `R${i}`, timestamp: 10.2 + i });
      await Bun.sleep(400);
    }
    await rec.stop();
    await host.close();
    const reader = BundleReader.open(dir);
    const views = reader.requests().map((r) => r.response?.decoded ?? null);
    expect(views.slice(0, MAX_FAILURES).map((v) => [v?.ok, v?.error])).toEqual(Array.from({ length: MAX_FAILURES }, () => [false, "exited with code 3"]));
    expect(views[MAX_FAILURES]).toBeNull();
    const notes = reader.byKind("note").filter((e) => e["plugin"] === "fake");
    expect(notes.map((e) => e["text"])).toEqual([`decode plugin fake disabled for this session: ${MAX_FAILURES} failures, last: exited with code 3`]);
  }, 30_000);
});

// ------------------------------------------------------------ bundle decode

describe("bundle decode: views for a bundle recorded before the plugin existed (decoded.jsonl sidecar)", () => {
  const sidecarLines = (dir: string): Record<string, unknown>[] =>
    existsSync(join(dir, SIDECAR_FILE))
      ? readFileSync(join(dir, SIDECAR_FILE), "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => {
            const v: unknown = JSON.parse(l);
            return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
          })
      : [];

  test("a plugin that declines (None / null) writes no view and is counted as declined, not failed; a re-run declines again", async () => {
    const root = tmp("tabcap-decdn-");
    const dir = await buildBundle(join(root, "b"), { name: "dn", created: 1760600000000, seed: 7 }, async (b) => {
      await b.request({ url: `${ORIGIN}/api/a`, type: "fetch", mime: "text/plain", body: "decline", ts: 1760600000010 });
      await b.request({ url: `${ORIGIN}/api/b`, type: "fetch", mime: "text/plain", body: "decline", ts: 1760600000020 });
      await b.request({ url: `${ORIGIN}/api/c`, type: "fetch", mime: "text/plain", body: "hello", ts: 1760600000030 });
      await b.request({ url: `${ORIGIN}/api/d`, type: "fetch", mime: "text/plain", body: "fail", ts: 1760600000040 });
    });
    const host = new DecodeHost();
    try {
      const run = () => decodeBundle(dir, new DecodeSession(host, [fake()]));
      const res = await run();
      expect([res.requests, res.decoded, res.failed, res.declined, res.appended]).toEqual([4, 1, 1, 2, 2]);
      expect(res.declinedBy).toEqual({ fake: 2 });
      expect(res.rows.map((r) => [r.request, r.ok])).toEqual([["r-4", true], ["r-5", false]]);
      expect(sidecarLines(dir).length).toBe(2);
      const reader = BundleReader.open(dir);
      expect(reader.requests().filter((r) => r.response?.decoded !== undefined).map((r) => r.url.slice(-1))).toEqual(["c", "d"]);
      const again = await run();
      expect([again.decoded, again.failed, again.declined, again.unchanged, again.appended]).toEqual([0, 0, 2, 2, 0]);
      expect(renderBundleDecodeText(again)).toContain("2 declined");
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("appends request / response views to the sidecar; not one byte of events.jsonl or manifest.json changes; the reader overlays them; a re-run appends nothing", async () => {
    const root = tmp("tabcap-decbd-");
    const config = join(root, "config");
    installXor(config);
    const dir = await s42Bundle(join(root, "b"));
    const eventsBefore = readFileSync(join(dir, "events.jsonl"));
    const manifestBefore = readFileSync(join(dir, "manifest.json"));
    expect(BundleReader.open(dir).decodedSidecar).toBe(false);
    const host = new DecodeHost();
    try {
      const res = await decodeBundle(dir, new DecodeSession(host, decodePlugins(config)), () => 1760700000000);
      expect([res.requests, res.decoded, res.failed, res.kept, res.unchanged, res.appended]).toEqual([4, 4, 0, 0, 0, 4]);
      expect(res.rows.map((r) => [r.request, r.direction, r.ok])).toEqual([
        ["r-3", "response", true],
        ["r-4", "response", true],
        ["r-5", "request", true],
        ["r-5", "response", true],
      ]);
      expect(readFileSync(join(dir, "events.jsonl")).equals(eventsBefore)).toBe(true);
      expect(readFileSync(join(dir, "manifest.json")).equals(manifestBefore)).toBe(true);
      const lines = sidecarLines(dir);
      expect(lines.map((l) => [l["seq"], l["request"], l["direction"], l["at"]])).toEqual([
        [1, "r-3", "response", 1760700000000],
        [2, "r-4", "response", 1760700000000],
        [3, "r-5", "request", 1760700000000],
        [4, "r-5", "response", 1760700000000],
      ]);
      expect(lines[0]?.["decoded"]).toEqual({ by: "xor-decode", version: "1", direction: "response", mime: "application/json", blob: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bytes: S42_TOKEN_JSON.length, ok: true });
      const reader = BundleReader.open(dir);
      expect(reader.decodedSidecar).toBe(true);
      expect(reader.issues).toEqual([]);
      const view = (id: string, side: "request" | "response") => {
        const r = reader.requests().find((x) => x.id === id);
        const d = side === "request" ? r?.request.decoded : r?.response?.decoded;
        return d?.blob ? new TextDecoder().decode(reader.readBlob(d.blob) ?? new Uint8Array()) : null;
      };
      expect([view("r-3", "response"), view("r-4", "response"), view("r-5", "request"), view("r-5", "response")]).toEqual([S42_TOKEN_JSON, S42_ITEMS_JSON, S42_POST_JSON, S42_ORDER_JSON]);
      // the raw events a reader hands out carry the overlay too (redaction, HAR export)
      const raw = reader.events.find((e) => e["id"] === "r-3")?.["response"];
      expect(typeof raw === "object" && raw !== null && "decoded" in raw).toBe(true);
      // a re-run sees the same views and appends nothing
      const again = await decodeBundle(dir, new DecodeSession(host, decodePlugins(config)));
      expect([again.decoded, again.failed, again.unchanged, again.appended]).toEqual([0, 0, 4, 0]);
      expect(sidecarLines(dir).length).toBe(4);
      expect(readFileSync(join(dir, "events.jsonl")).equals(eventsBefore)).toBe(true);
    } finally {
      await host.close();
    }
    const open = join(root, "open");
    mkdirSync(open);
    cpSync(dir, open, { recursive: true });
    const m = JSON.parse(readFileSync(join(open, "manifest.json"), "utf8")) as Record<string, unknown>;
    delete m["finished"];
    writeFileSync(join(open, "manifest.json"), JSON.stringify(m));
    await expect(decodeBundle(open, { decode: async () => null })).rejects.toThrow("not finished");
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("a changed view is appended and the last line per (request, direction) wins; a failure never replaces an ok view; a torn last line is skipped", async () => {
    const root = tmp("tabcap-deckeep-");
    const config = join(root, "config");
    installXor(config);
    const dir = await s42Bundle(join(root, "b"));
    const host = new DecodeHost();
    try {
      await decodeBundle(dir, new DecodeSession(host, decodePlugins(config)));
      // failures: the document (no view before) gets a failed one appended, the four ok views are kept
      const failing = { decode: async (j: DecodeJob) => ({ by: "xor-decode", version: "1", direction: j.direction, ok: false as const, error: "key rotated" }) };
      const res = await decodeBundle(dir, failing);
      expect([res.decoded, res.failed, res.kept, res.appended]).toEqual([0, 1, 4, 1]);
      expect(BundleReader.open(dir).requests().find((r) => r.id === "r-3")?.response?.decoded?.ok).toBe(true);
      // version 2 of the plugin: every view differs, so each is appended and wins
      const v2 = { decode: async (j: DecodeJob) => ({ by: "xor-decode", version: "2", direction: j.direction, ok: true as const, mime: "text/plain", body: new TextEncoder().encode(`v2 ${j.id ?? ""} ${j.direction}`) }) };
      const res2 = await decodeBundle(dir, v2);
      expect([res2.decoded, res2.appended]).toEqual([5, 5]);
      const lines = sidecarLines(dir);
      expect(lines.map((l) => l["seq"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const r3 = BundleReader.open(dir).requests().find((r) => r.id === "r-3")?.response?.decoded;
      expect([r3?.version, r3?.mime]).toEqual(["2", "text/plain"]);
      // an interrupted append leaves half a line: skipped and reported, the rest still applies
      writeFileSync(join(dir, SIDECAR_FILE), readFileSync(join(dir, SIDECAR_FILE), "utf8") + '{"seq":11,"request":"r-3","dire');
      const torn = BundleReader.open(dir);
      expect(torn.issues.map((i) => [i.kind, i.line])).toEqual([["bad-sidecar", 11]]);
      expect(torn.requests().find((r) => r.id === "r-3")?.response?.decoded?.version).toBe("2");
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

// ------------------------------------------------------------ 0.6-V

// Owner decisions 10-17 (after two real-site rounds): a CORS preflight and a
// 0-byte body are never offered to a plugin (live and offline; `bundle decode`
// counts them in `skipped`), and a decline supersedes the same plugin's earlier
// failure (a declined sidecar row; readers see no view). Oracle: the decisions
// as worded in the brief and docs/04 §28 0.6-V; the bundles are hand-built.
describe("0.6-V: preflights and empty bodies are not offered; a decline supersedes the same plugin's failure", () => {
  /** An in-process decoder that records what it was offered and decodes everything ok. */
  const counting = () => {
    const seen: string[] = [];
    return {
      seen,
      empty: false,
      decode: async (j: DecodeJob) => {
        seen.push(`${j.method} ${new URL(j.url).pathname} ${j.direction}`);
        return { by: "cnt", version: "1", direction: j.direction, ok: true as const, mime: "text/plain", body: new TextEncoder().encode("PLAIN") };
      },
    };
  };

  test("decodeSkip: OPTIONS with initiator preflight or an access-control-request-method header; then 0 bytes", () => {
    const one = new Uint8Array(1);
    const none = new Uint8Array(0);
    expect(decodeSkip({ method: "OPTIONS", initiatorType: "preflight", requestHeaders: {}, body: one })).toBe("preflight");
    expect(decodeSkip({ method: "options", initiatorType: null, requestHeaders: { "Access-Control-Request-Method": "POST" }, body: one })).toBe("preflight");
    // an OPTIONS the page sent itself is not a preflight
    expect(decodeSkip({ method: "OPTIONS", initiatorType: "script", requestHeaders: {}, body: one })).toBeNull();
    expect(decodeSkip({ method: "GET", initiatorType: "preflight", requestHeaders: { "access-control-request-method": "GET" }, body: none })).toBe("empty");
    expect(decodeSkip({ method: "GET", initiatorType: null, requestHeaders: {}, body: one })).toBeNull();
  });

  test("live: the recorder does not offer a preflight or a 0-byte side; no decoded field, no failure", async () => {
    const dec = counting();
    const { t, emit } = fakeChrome({ R1: "pre", R2: "pre2", R3: "", R4: "body", R5: "resp" });
    const tabs = new Tabs(t, false);
    await tabs.createTab("skip");
    const dir = join(tmp("tabcap-decskip-"), "b");
    const rec = await Recorder.start({ session: "skip", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, decode: dec });
    const reqs: Array<[string, string, string, Record<string, unknown>, Record<string, string>, string | null]> = [
      ["R1", "OPTIONS", "/api/p1", { type: "preflight", url: `${ORIGIN}/page` }, {}, null],
      ["R2", "OPTIONS", "/api/p2", { type: "other" }, { "access-control-request-method": "POST" }, null],
      ["R3", "GET", "/api/empty", { type: "script" }, {}, null],
      ["R4", "GET", "/api/body", { type: "script" }, {}, null],
      ["R5", "POST", "/api/post", { type: "script" }, { "content-type": "text/plain" }, ""],
    ];
    let ts = 10;
    for (const [id, method, path, initiator, headers, postData] of reqs) {
      ts++;
      emit("Network.requestWillBeSent", { requestId: id, loaderId: "L1", type: "Fetch", timestamp: ts, wallTime: 1760600000 + ts, initiator, request: { url: `${ORIGIN}${path}`, method, headers, ...(postData === null ? {} : { postData, hasPostData: true }) } });
      emit("Network.responseReceived", { requestId: id, type: "Fetch", timestamp: ts + 0.1, response: { status: 200, headers: { "content-type": "text/plain" }, mimeType: "text/plain" } });
      emit("Network.loadingFinished", { requestId: id, timestamp: ts + 0.2 });
    }
    await Bun.sleep(50);
    await rec.stop();
    expect(dec.seen.sort()).toEqual(["GET /api/body response", "POST /api/post response"]);
    const reader = BundleReader.open(dir);
    const views = Object.fromEntries(reader.requests().map((r) => [new URL(r.url).pathname, [r.request.decoded?.by ?? null, r.response?.decoded?.by ?? null]]));
    expect(views).toEqual({ "/api/p1": [null, null], "/api/p2": [null, null], "/api/empty": [null, null], "/api/body": [null, "cnt"], "/api/post": [null, "cnt"] });
  }, 20_000);

  test("offline: bundle decode skips them too and counts skipped {preflight, empty}", async () => {
    const root = tmp("tabcap-decskipo-");
    try {
      const dir = await buildBundle(join(root, "b"), { name: "sk", created: 1760600000000, seed: 9 }, async (b) => {
        await b.request({ url: `${ORIGIN}/api/p1`, method: "OPTIONS", type: "other", mime: "text/plain", body: "pre", ts: 1760600000010, extra: { initiator: { type: "preflight" } } });
        await b.request({ url: `${ORIGIN}/api/p2`, method: "OPTIONS", type: "fetch", mime: "text/plain", body: "pre", reqHeaders: { "access-control-request-method": "PUT" }, ts: 1760600000020 });
        await b.request({ url: `${ORIGIN}/api/empty`, type: "fetch", mime: "text/plain", body: "", ts: 1760600000030 });
        await b.request({ url: `${ORIGIN}/api/body`, type: "fetch", mime: "text/plain", body: "hello", ts: 1760600000040 });
        await b.request({ url: `${ORIGIN}/api/post`, method: "POST", type: "fetch", mime: "text/plain", body: "world", postData: "", ts: 1760600000050 });
      });
      const dec = counting();
      const res = await decodeBundle(dir, dec);
      expect(dec.seen.sort()).toEqual(["GET /api/body response", "POST /api/post response"]);
      expect([res.requests, res.decoded, res.failed, res.declined, res.appended]).toEqual([5, 2, 0, 0, 2]);
      expect(res.skipped).toEqual({ preflight: 2, empty: 2 });
      expect(renderBundleDecodeText(res)).toContain("2 preflight(s) and 2 empty bod(ies) not offered");
      const urlOf = new Map(BundleReader.open(dir).requests().map((r) => [r.id, new URL(r.url).pathname]));
      expect(res.rows.map((r) => urlOf.get(r.request))).toEqual(["/api/body", "/api/post"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed view, then the same plugin declines: a declined row is appended (superseded), readers see no view; a re-run appends nothing", async () => {
    const root = tmp("tabcap-decsup-");
    try {
      const dir = await buildBundle(join(root, "b"), { name: "sup", created: 1760600000000, seed: 10 }, async (b) => {
        await b.request({ url: `${ORIGIN}/api/a`, type: "fetch", mime: "text/plain", body: "ciphertext-a", ts: 1760600000010 });
        await b.request({ url: `${ORIGIN}/api/b`, type: "fetch", mime: "text/plain", body: "ciphertext-b", ts: 1760600000020 });
      });
      // the old runner: "returned None" was an ok:false view
      const failing = { decode: async (j: DecodeJob) => ({ by: "fake", version: "0", direction: j.direction, ok: false as const, error: "returned None" }) };
      const first = await decodeBundle(dir, failing);
      expect([first.failed, first.appended, first.superseded]).toEqual([2, 2, 0]);
      expect(BundleReader.open(dir).requests().map((r) => r.response?.decoded?.error)).toEqual(["returned None", "returned None"]);
      // the new runner declines r-3 only (another plugin declining would not touch fake's failure)
      const declining = {
        decode: async (j: DecodeJob, declined?: (plugin: string, version: string) => void) => {
          if (j.id === "r-3") declined?.("fake", "1");
          else declined?.("other", "1");
          return null;
        },
      };
      const second = await decodeBundle(dir, declining, () => 1760700000000);
      expect([second.declined, second.appended, second.superseded, second.failed]).toEqual([2, 1, 1, 0]);
      expect(second.rows).toEqual([{ request: "r-3", direction: "response", by: "fake", ok: false, mime: null, bytes: null, error: "declined", superseded: true }]);
      expect(renderBundleDecodeText(second)).toContain("1 superseded");
      const line = readFileSync(join(dir, SIDECAR_FILE), "utf8").trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(line)).toEqual({ seq: 3, request: "r-3", direction: "response", decoded: { by: "fake", version: "1", direction: "response", mime: null, blob: null, bytes: null, ok: false, declined: true, error: "declined" }, at: 1760700000000 });
      const reader = BundleReader.open(dir);
      expect(reader.issues).toEqual([]);
      // r-3 is /api/b (the builder's second request): its failure is hidden, /api/a keeps its own
      expect(reader.requests().map((r) => [r.id, new URL(r.url).pathname, r.response?.decoded?.error ?? null])).toEqual([
        ["r-2", "/api/a", "returned None"],
        ["r-3", "/api/b", null],
      ]);
      // net show / net body read one event through the same overlay
      expect(decodedEntry({ id: "r-3" }, dir, new BlobStore(dir))).toBeNull();
      // a re-run sees no view on r-3 any more: nothing to supersede
      const third = await decodeBundle(dir, declining);
      expect([third.declined, third.appended, third.superseded]).toEqual([2, 0, 0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the reader: a declined row hides only its own plugin's failure (inline or earlier in the sidecar); any later view wins over it", () => {
    const fail = (by: string) => ({ by, version: "1", direction: "response", mime: null, blob: null, bytes: null, ok: false, error: "bad" });
    const ok = { by: "fake", version: "1", direction: "response", mime: "text/plain", blob: `sha256:${"a".repeat(64)}`, bytes: 3, ok: true };
    const dec = declinedRow("fake", "1", "response");
    const ev = (inline: Record<string, unknown> | null) => ({ kind: "request", id: "r-1", response: inline === null ? { status: 200 } : { status: 200, decoded: inline } });
    const views = (...rows: Record<string, unknown>[]) => latestViews(parseSidecarText(rows.map((d, i) => JSON.stringify({ seq: i + 1, request: "r-1", direction: "response", decoded: d, at: 1 })).join("\n")));
    const shown = (e: Record<string, unknown>): unknown => {
      const r = e["response"];
      return typeof r === "object" && r !== null && "decoded" in r ? (r as { decoded: unknown }).decoded : undefined;
    };
    // inline failure by the same plugin: gone; by another plugin, or an ok view: kept
    expect(shown(overlayEvent(ev(fail("fake")), views(dec)))).toBeUndefined();
    expect(shown(overlayEvent(ev(fail("other")), views(dec)))).toEqual(fail("other"));
    expect(shown(overlayEvent(ev(ok), views(dec)))).toEqual(ok);
    expect(shown(overlayEvent(ev(null), views(dec)))).toBeUndefined();
    // sidecar: failure then decline → no view; decline does not displace another plugin's failure; a later failure shows again
    expect(shown(overlayEvent(ev(null), views(fail("fake"), dec)))).toBeUndefined();
    expect(shown(overlayEvent(ev(null), views(fail("other"), dec)))).toEqual(fail("other"));
    expect(shown(overlayEvent(ev(null), views(fail("fake"), dec, fail("fake"))))).toEqual(fail("fake"));
    expect(shown(overlayEvent(ev(null), views(ok, dec)))).toEqual(ok);
    // parsed, a declined row says so
    expect(parseDecoded(dec)).toMatchObject({ by: "fake", ok: false, declined: true, error: "declined" });
  });
});
