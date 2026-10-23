// 0.9-C streaming responses and SSE events in the recorder (docs/04 §47, docs/05 s74).
// Oracle: docs/04 §47 (pass-through at the Response stage, streamResourceContent,
// the fallback, partial bodies, the 32 MiB cap, `sse` events right after their
// request) and the measured CDP shapes of docs/07 §1.1 E3a / E3c. The recorder
// runs over a fake transport (same doubles as bodies06i / input-fidelity); the
// parser itself is in sse09c.test.ts.
// Reproduce: bun test test/unit/recorder09c.test.ts

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SIZE_CAP } from "../../src/bundle/blobs.ts";
import { exportHar, importHar, PARTIAL_COMMENT } from "../../src/bundle/har.ts";
import { BundleReader, parseSse } from "../../src/bundle/reader.ts";
import { redactView } from "../../src/bundle/redact.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import type { BodiesMode } from "../../src/shared/bodies.ts";
import { isRecord } from "../../src/shared/json.ts";

const enc = new TextEncoder();

// ---------------------------------------------------------------- the recorder over a fake transport

type Call = { method: string; params: CdpParams };
type SendFn = (method: string, params: CdpParams) => Promise<Record<string, unknown>> | Record<string, unknown> | undefined;

function fakeChrome(handler: SendFn = () => undefined) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const calls: Call[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}) => {
      calls.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "T1" };
      return (await handler(method, params)) ?? {};
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
  return { t, emit, calls };
}

async function startRec(chrome: ReturnType<typeof fakeChrome>, o: { bodies?: BodiesMode; unreadAfterMs?: number } = {}) {
  const tabs = new Tabs(chrome.t, false);
  await tabs.createTab("s74");
  const dir = join(mkdtempSync(join(tmpdir(), "tabcap-09c-")), "b");
  const rec = await Recorder.start({ session: "s74", dir, t: chrome.t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, ...o });
  return { rec, dir };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

const ORIGIN = "http://127.0.0.1:9";
const SSE_CT = "text/event-stream; charset=utf-8";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const MSG = (i: number) => `id: ${i}\ndata: {"t":"tok${i} 中文"}\n\n`;

/** requestWillBeSent + responseReceived of one request (CDP timestamps in seconds). */
function begin(emit: ReturnType<typeof fakeChrome>["emit"], id: string, path: string, mime: string, type = "Fetch", loaderId = "L1") {
  emit("Network.requestWillBeSent", { requestId: id, loaderId, type, timestamp: 100, wallTime: 1760500000, request: { url: `${ORIGIN}${path}`, method: "POST", headers: {} } });
  emit("Network.responseReceived", { requestId: id, type, timestamp: 100.01, response: { status: 200, headers: { "content-type": mime }, mimeType: mime.split(";")[0] } });
}

const reqOf = (dir: string, path: string) => BundleReader.open(dir).requests().find((r) => r.url === `${ORIGIN}${path}`);
const bodyText = (dir: string, path: string): string | null => {
  const r = reqOf(dir, path);
  const blob = r?.response?.body?.blob;
  const bytes = blob === undefined ? null : BundleReader.open(dir).readBlob(blob);
  return bytes === null ? null : Buffer.from(bytes).toString();
};

describe("recorder: the Response stage passes streaming responses through (§47, s74)", () => {
  test("text/event-stream (any case, parameters) and application/x-ndjson: continueResponse at once, no Fetch.getResponseBody; JSON as before", async () => {
    const gate: { open: () => void } = { open: () => undefined };
    const chrome = fakeChrome((method) => {
      // Fetch.getResponseBody of a stream would answer only when the stream ended (E3b): never, here.
      if (method === "Fetch.getResponseBody") return new Promise((r) => (gate.open = () => r({ body: '{"ok":1}', base64Encoded: false })));
      return undefined;
    });
    const { rec } = await startRec(chrome);
    const paused = (id: string, ct: string, resourceType = "Fetch") =>
      chrome.emit("Fetch.requestPaused", { requestId: `I${id}`, networkId: id, resourceType, frameId: "T1", responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: ct }] });
    paused("A", "Text/Event-Stream; charset=UTF-8");
    paused("B", "application/x-ndjson");
    paused("E", "text/event-stream", "XHR"); // an EventSource request in the Fetch domain (E3e)
    await until(() => chrome.calls.filter((c) => c.method === "Fetch.continueResponse").length === 3);
    expect(chrome.calls.filter((c) => c.method === "Fetch.getResponseBody")).toEqual([]);
    expect(chrome.calls.filter((c) => c.method === "Fetch.continueResponse").map((c) => c.params["requestId"])).toEqual(["IA", "IB", "IE"]);
    // a JSON response still has its body copied before it goes on
    paused("J", "application/json");
    await until(() => chrome.calls.some((c) => c.method === "Fetch.getResponseBody"));
    expect(chrome.calls.filter((c) => c.method === "Fetch.continueResponse").length).toBe(3);
    gate.open();
    await until(() => chrome.calls.filter((c) => c.method === "Fetch.continueResponse").length === 4);
    const order = chrome.calls.map((c) => c.method).filter((m) => m.startsWith("Fetch.") && m !== "Fetch.enable");
    expect(order.slice(-2)).toEqual(["Fetch.getResponseBody", "Fetch.continueResponse"]);
    await rec.stop();
  });
});

describe("recorder: streams read as they arrive (§47)", () => {
  test("normal end: body = bufferedData + data chunks, no Network.getResponseBody; one sse event per message right after the request, at from the arriving chunk", async () => {
    let answer: (v: Record<string, unknown>) => void = () => undefined;
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? new Promise((r) => (answer = r)) : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/sse", SSE_CT);
    // two chunks before the answer (no data), then the answer with them, then chunks with data
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.02, dataLength: 4, encodedDataLength: 4 });
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.03, dataLength: enc.encode(MSG(1)).length, encodedDataLength: 0 });
    answer({ bufferedData: b64(`: c\n${MSG(1)}`) });
    await Bun.sleep(5);
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.25, dataLength: 0, data: b64(MSG(2).slice(0, 5)) });
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.45, dataLength: 0, data: b64(`${MSG(2).slice(5)}event: done\ndata: [DONE]\n`) });
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.65, dataLength: 0, data: b64("\n") });
    chrome.emit("Network.loadingFinished", { requestId: "R1", timestamp: 100.7 });
    await until(() => rec.index.length === 1);
    expect(chrome.calls.filter((c) => c.method === "Network.streamResourceContent").map((c) => c.params)).toEqual([{ requestId: "R1" }]);
    expect(chrome.calls.some((c) => c.method === "Network.getResponseBody")).toBe(false);
    expect(rec.index[0]).toMatchObject({ outcome: "finished", mime: "text/event-stream" });
    expect(rec.index[0]?.partial).toBeUndefined();
    const rid = rec.index[0]?.id ?? "none";
    expect(rec.sse.map((m) => [m.request, m.index, m.event, m.lastEventId, m.at])).toEqual([
      [rid, 0, "message", "1", 100030],
      [rid, 1, "message", "2", 100450],
      [rid, 2, "done", "2", 100650],
    ]);
    await rec.stop();
    const reader = BundleReader.open(dir);
    expect(bodyText(dir, "/s74/sse")).toBe(`: c\n${MSG(1)}${MSG(2)}event: done\ndata: [DONE]\n\n`);
    const r = reqOf(dir, "/s74/sse");
    if (r === undefined) throw new Error("no request");
    expect(r.response?.body?.partial).toBeUndefined();
    expect(r.response?.bodyMissing).toBeNull();
    expect(r["bodySource"]).toBeUndefined();
    // the sse events come right after their request, in stream order, with the request's actor / cmd / nav
    const seqs = reader.events.map((e) => e.kind);
    const at = seqs.indexOf("request");
    expect(seqs.slice(at, at + 4)).toEqual(["request", "sse", "sse", "sse"]);
    const sse = reader.sseMessages();
    expect(sse.map((e) => [e.sse, e.index, e.event, e.id, e.retry, e.data, e.at, e.mono])).toEqual([
      [r.id, 0, "message", "1", null, { inline: '{"t":"tok1 中文"}' }, 100030, 100030],
      [r.id, 1, "message", "2", null, { inline: '{"t":"tok2 中文"}' }, 100450, 100450],
      [r.id, 2, "done", "2", null, { inline: "[DONE]" }, 100650, 100650],
    ]);
    for (const e of sse) expect([e.actor, e.cmd, e.nav, e.tab]).toEqual([r.actor, r.cmd, r.nav, r.tab]);
    // ts on the request's clock: wallTime + (at - start)
    expect(sse.map((e) => e.ts)).toEqual([1760500000030, 1760500000450, 1760500000650]);
    expect(reader.issues).toEqual([]);
  });

  test("Network.streamResourceContent fails: logged, the body is read with Network.getResponseBody at the end, messages without at", async () => {
    const body = `${MSG(1)}${MSG(2)}`;
    const chrome = fakeChrome((method) => {
      if (method === "Network.streamResourceContent") throw new Error("Request with the provided ID has finished loading");
      if (method === "Network.getResponseBody") return { body, base64Encoded: false };
      return undefined;
    });
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/sse", SSE_CT);
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.1, dataLength: body.length });
    await Bun.sleep(5);
    chrome.emit("Network.loadingFinished", { requestId: "R1", timestamp: 100.2 });
    await until(() => rec.index.length === 1);
    expect(chrome.calls.filter((c) => c.method === "Network.getResponseBody").length).toBe(1);
    expect(rec.sse.map((m) => [m.index, m.lastEventId, m.at])).toEqual([
      [0, "1", null],
      [1, "2", null],
    ]);
    await rec.stop();
    expect(bodyText(dir, "/s74/sse")).toBe(body);
    // ts falls back to the request's
    const reader = BundleReader.open(dir);
    const ts = reqOf(dir, "/s74/sse")?.ts ?? -1;
    expect(reader.sseMessages().map((e) => [e.ts, e.mono])).toEqual([
      [ts, null],
      [ts, null],
    ]);
  });

  test("loadingFailed mid-stream: failed, the bytes that arrived with partial:true, bodyMissing null; only complete messages", async () => {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: "" } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/cut", SSE_CT);
    await Bun.sleep(5);
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.1, dataLength: 0, data: b64(`${MSG(1)}id: 2\ndata: half`) });
    chrome.emit("Network.loadingFailed", { requestId: "R1", timestamp: 100.3, errorText: "net::ERR_CONNECTION_RESET", canceled: false, type: "Fetch" });
    await until(() => rec.index.length === 1);
    expect(rec.index[0]).toMatchObject({ outcome: "failed", partial: true, bodyMissing: null });
    expect(rec.sse.map((m) => m.lastEventId)).toEqual(["1"]);
    await rec.stop();
    const r = reqOf(dir, "/s74/cut");
    expect(r?.outcome).toBe("failed");
    expect(r?.error).toMatchObject({ text: "net::ERR_CONNECTION_RESET", canceled: false });
    expect(r?.response?.body?.partial).toBe(true);
    expect(r?.response?.bodyMissing).toBeNull();
    expect(bodyText(dir, "/s74/cut")).toBe(`${MSG(1)}id: 2\ndata: half`);
    expect(r?.["bodySource"]).toBeUndefined();
  });

  test("nothing arrived before the failure: the old rule (bodyMissing failed, no partial)", async () => {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: "" } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/cut", SSE_CT);
    await Bun.sleep(5);
    chrome.emit("Network.loadingFailed", { requestId: "R1", timestamp: 100.3, errorText: "net::ERR_ABORTED", canceled: true, type: "Fetch" });
    await until(() => rec.index.length === 1);
    await rec.stop();
    const r = reqOf(dir, "/s74/cut");
    expect(r?.response?.body).toBeNull();
    expect(r?.response?.bodyMissing).toEqual({ reason: "failed", detail: "net::ERR_ABORTED" });
    expect(rec.index[0]?.partial).toBeUndefined();
  });

  test("a navigation commit closes an open stream: incomplete, partial:true, no bodySource; ndjson the same, without sse events", async () => {
    const chrome = fakeChrome((method, params) => (method === "Network.streamResourceContent" ? { bufferedData: params["requestId"] === "R1" ? b64(MSG(1)) : "" } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/sse?n=20", SSE_CT);
    begin(chrome.emit, "R2", "/s74/ndjson", "application/x-ndjson");
    await Bun.sleep(5);
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.2, dataLength: 0, data: b64("id: 2\n") });
    chrome.emit("Network.dataReceived", { requestId: "R2", timestamp: 100.2, dataLength: 0, data: b64('{"i":0}\n') });
    chrome.emit("Page.frameNavigated", { frame: { id: "T1", loaderId: "L2", url: `${ORIGIN}/other` } });
    await until(() => rec.index.length === 2, 3000);
    await rec.stop();
    for (const path of ["/s74/sse?n=20", "/s74/ndjson"]) {
      const r = reqOf(dir, path);
      expect([r?.outcome, r?.response?.body?.partial, r?.response?.bodyMissing, r?.["bodySource"]]).toEqual(["incomplete", true, null, undefined]);
    }
    expect(bodyText(dir, "/s74/sse?n=20")).toBe(`${MSG(1)}id: 2\n`);
    expect(bodyText(dir, "/s74/ndjson")).toBe('{"i":0}\n');
    expect(rec.sse.map((m) => [m.lastEventId, m.at])).toEqual([["1", null]]); // bufferedData without earlier dataReceived: no time
  });

  test("net stop closes an open stream as incomplete with what arrived; one with nothing as stopped", async () => {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: "" } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/a", SSE_CT);
    begin(chrome.emit, "R2", "/s74/b", SSE_CT);
    await Bun.sleep(5);
    chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.2, dataLength: 0, data: b64(MSG(1)) });
    await rec.stop();
    expect([reqOf(dir, "/s74/a")?.outcome, reqOf(dir, "/s74/a")?.response?.body?.partial, reqOf(dir, "/s74/a")?.response?.bodyMissing]).toEqual(["incomplete", true, null]);
    expect([reqOf(dir, "/s74/b")?.response?.body, reqOf(dir, "/s74/b")?.response?.bodyMissing]).toEqual([null, { reason: "stopped", detail: null }]);
    expect(rec.sse.map((m) => [m.request, m.at])).toEqual([[reqOf(dir, "/s74/a")?.id ?? "none", 100200]]);
  });

  test("rule 9 (unread bodies after 1 s) does not apply to a stream: nothing is written early", async () => {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: b64(MSG(1)) } : undefined));
    const { rec, dir } = await startRec(chrome, { unreadAfterMs: 20 });
    begin(chrome.emit, "R1", "/s74/sse", SSE_CT);
    await Bun.sleep(120);
    expect(rec.index).toEqual([]);
    await rec.stop();
    expect(reqOf(dir, "/s74/sse")?.outcome).toBe("incomplete");
    expect(reqOf(dir, "/s74/sse")?.["unreadByPage"]).toBeUndefined();
  });

  test("--bodies none: a stream is never asked for; its body is skipped; no sse events", async () => {
    const chrome = fakeChrome();
    const { rec, dir } = await startRec(chrome, { bodies: "none" });
    begin(chrome.emit, "R1", "/s74/sse", SSE_CT);
    chrome.emit("Network.loadingFinished", { requestId: "R1", timestamp: 100.7 });
    await until(() => rec.index.length === 1);
    await rec.stop();
    expect(chrome.calls.filter((c) => c.method === "Network.streamResourceContent" || c.method === "Network.getResponseBody")).toEqual([]);
    const raw = BundleReader.open(dir).events.find((e) => e.kind === "request");
    expect(isRecord(raw?.["response"]) ? raw["response"]["body"] : undefined).toEqual({ skipped: "resource-type" });
    expect(rec.sse).toEqual([]);
  });

  test("the 32 MiB cap: past it nothing is kept and the request says too-large; a message over 64 KB goes to a blob", async () => {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: "" } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/big", "application/x-ndjson");
    begin(chrome.emit, "R2", "/s74/long", SSE_CT);
    await Bun.sleep(5);
    const chunk = b64("x".repeat(11 * 1024 * 1024));
    for (let i = 0; i < 3; i++) chrome.emit("Network.dataReceived", { requestId: "R1", timestamp: 100.1 + i, dataLength: 0, data: chunk });
    const long = "y".repeat(70 * 1024);
    chrome.emit("Network.dataReceived", { requestId: "R2", timestamp: 100.5, dataLength: 0, data: b64(`data: ${long}\n\ndata: short\n\n`) });
    chrome.emit("Network.loadingFinished", { requestId: "R1", timestamp: 104 });
    chrome.emit("Network.loadingFinished", { requestId: "R2", timestamp: 104 });
    await until(() => rec.index.length === 2, 5000);
    await rec.stop();
    const big = reqOf(dir, "/s74/big");
    expect(big?.response?.body).toBeNull();
    expect(big?.response?.bodyMissing).toEqual({ reason: "too-large", detail: `${3 * 11 * 1024 * 1024} bytes > ${DEFAULT_SIZE_CAP}` });
    expect(chrome.calls.some((c) => c.method === "Network.getResponseBody")).toBe(false);
    const reader = BundleReader.open(dir);
    const ms = reader.sseMessages();
    expect(ms.map((m) => ("blob" in m.data ? ["blob", m.data.size] : ["inline", m.data.inline.length]))).toEqual([
      ["blob", 70 * 1024],
      ["inline", 5],
    ]);
    const first = ms[0]?.data;
    const blob = first !== undefined && "blob" in first ? reader.readBlob(first.blob) : null;
    expect(blob === null ? null : Buffer.from(blob).toString()).toBe(long);
    expect(rec.sse.map((m) => [m.size, m.blob !== null])).toEqual([
      [70 * 1024, true],
      [5, false],
    ]);
  });
});

describe("partial bodies and sse events in HAR, the reader and redaction", () => {
  async function partialBundle(): Promise<string> {
    const chrome = fakeChrome((method) => (method === "Network.streamResourceContent" ? { bufferedData: b64(`${MSG(1)}data: {"token":"abcdef123456"}\n\n`) } : undefined));
    const { rec, dir } = await startRec(chrome);
    begin(chrome.emit, "R1", "/s74/cut", SSE_CT);
    await Bun.sleep(5);
    chrome.emit("Network.loadingFailed", { requestId: "R1", timestamp: 100.3, errorText: "net::ERR_CONNECTION_RESET", canceled: false, type: "Fetch" });
    await until(() => rec.index.length === 1);
    await rec.stop();
    return dir;
  }

  test("HAR export writes the partial comment; import restores partial from exactly that comment", async () => {
    const dir = await partialBundle();
    const har = exportHar(BundleReader.open(dir)).har;
    const entry = har.log.entries[0];
    expect(entry?.response.content.comment).toBe(PARTIAL_COMMENT);
    expect(PARTIAL_COMMENT).toBe("partial: the stream ended before the response was complete");
    expect(exportHar(BundleReader.open(dir)).dropped["sse"]).toBe(2);
    const back = join(mkdtempSync(join(tmpdir(), "tabcap-09c-har-")), "b");
    await importHar(JSON.parse(JSON.stringify(har)), back);
    expect(BundleReader.open(back).requests()[0]?.response?.body?.partial).toBe(true);
    // any other comment is not a partial body
    const other = structuredClone(har);
    const c = other.log.entries[0]?.response.content;
    if (c !== undefined) c.comment = "partial";
    const back2 = join(mkdtempSync(join(tmpdir(), "tabcap-09c-har-")), "b");
    await importHar(JSON.parse(JSON.stringify(other)), back2);
    expect(BundleReader.open(back2).requests()[0]?.response?.body?.partial).toBeUndefined();
    // --embed-events keeps the sse events
    const embedded = join(mkdtempSync(join(tmpdir(), "tabcap-09c-har-")), "b");
    await importHar(JSON.parse(JSON.stringify(exportHar(BundleReader.open(dir), { embedEvents: true }).har)), embedded);
    expect(BundleReader.open(embedded).sseMessages().map((m) => m.index)).toEqual([0, 1]);
  });

  test("parseSse checks an sse event as untrusted input", () => {
    const base = { seq: 3, ts: 1, mono: null, kind: "sse", actor: "ai" as const, tab: "t1", cmd: null };
    const good = { ...base, sse: "r-2", nav: "n-1", index: 0, event: "message", id: "", retry: null, data: { inline: "x" }, at: null };
    expect(parseSse(good)).toMatchObject({ sse: "r-2", index: 0, data: { inline: "x" } });
    expect(parseSse({ ...good, sse: "2" })).toBe("sse is not a request id");
    expect(parseSse({ ...good, index: -1 })).toBe("index is not a count");
    expect(parseSse({ ...good, retry: "5" })).toBe("retry is not a count or null");
    expect(parseSse({ ...good, data: { inline: 3 } })).toBe("data is neither inline nor a blob");
    expect(parseSse({ ...good, at: "now" })).toBe("at is not a number or null");
    expect(parseSse({ ...base, kind: "ws" })).toBe("not an sse event");
  });

  test("redaction treats sse data like a text WebSocket payload (JSON names, value patterns)", async () => {
    const dir = await partialBundle();
    const view = redactView(BundleReader.open(dir), { salt: "s" });
    const data = view.events.filter((e) => e.kind === "sse").map((e) => (isRecord(e["data"]) ? e["data"]["inline"] : null));
    expect(data[0]).toBe('{"t":"tok1 中文"}');
    expect(String(data[1])).not.toContain("abcdef123456");
    expect(String(data[1])).toMatch(/^\{"token":"«r:[a-z0-9-]+:[0-9a-f]{8}»"\}$/);
  });
});
