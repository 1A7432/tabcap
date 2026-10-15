// Fixture builders for L0 tests.
//
// SAMPLE_LINES are the eight docs/04 §11 sample lines, copied verbatim (the
// oracle). They are written through BundleWriter so `seq`, files and the
// manifest are real. The writer numbers from 1 and the sample's seqs are
// 1..8, so the sample's seq values (and the ids derived from them: n-3, r-4,
// r-6, n-7, r-8) are preserved exactly, not renumbered.
//
// Regenerate the committed fixture:  bun test/unit/_fixtures.ts
// (writes fixtures/bundles/sample-v0/). bundle.test.ts checks that the
// committed copy equals a fresh build and that SAMPLE_LINES still match §11.
//
// buildRichBundle() is synthetic test data shaped like docs/04 §5.1 (all
// request fields present) for the HAR and redaction tests. Its values are not
// oracle values; tests derive expectations by computing on them (hashes,
// equality across a round trip).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ulid } from "../../src/shared/ids.ts";
import { toRawEvent } from "../../src/bundle/reader.ts";
import type { RawEvent } from "../../src/bundle/types.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";

export const SAMPLE_LINES: readonly string[] = [
  '{"seq":1,"ts":1760500000000,"mono":null,"kind":"session","actor":"system","tab":null,"cmd":null,"phase":"start","name":"range-s02","mode":{"capture":"mixed","trace":false,"raw":true}}',
  '{"seq":2,"ts":1760500000100,"mono":null,"kind":"tab","actor":"system","tab":"t1","cmd":null,"phase":"attach","chromeTabId":1234,"owned":true,"url":"http://127.0.0.1:4310/s02/a","reason":"borrowed"}',
  '{"seq":3,"ts":1760500000150,"mono":88000.0,"kind":"nav","actor":"human","tab":"t1","cmd":null,"frame":"root","nav":"n-3","url":"http://127.0.0.1:4310/s02/a","from":null,"type":"navigation","loaderId":"L1","loadEvent":null}',
  '{"seq":4,"ts":1760500000900,"mono":88750.2,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-4","type":"xhr","method":"GET","url":"http://127.0.0.1:4310/api/fast", "...":"…","outcome":"finished"}',
  '{"seq":5,"ts":1760500001200,"mono":null,"kind":"action","actor":"human","tab":"t1","cmd":null,"op":"click","target":{"role":"link","name":"下一页","selector":"a#next"},"value":null,"phase":"done","trusted":true,"nav":"n-3"}',
  '{"seq":6,"ts":1760500001210,"mono":89060.0,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-6","type":"fetch","method":"POST","url":"http://127.0.0.1:4310/api/before-leave","...":"…","outcome":"finished"}',
  '{"seq":7,"ts":1760500001300,"mono":89150.0,"kind":"nav","actor":"human","tab":"t1","cmd":null,"frame":"root","nav":"n-7","url":"http://127.0.0.1:4310/s02/b","from":"http://127.0.0.1:4310/s02/a","type":"navigation","loaderId":"L2","loadEvent":null}',
  '{"seq":8,"ts":1760500001350,"mono":89200.0,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-8","type":"xhr","method":"GET","url":"http://127.0.0.1:4310/api/slow","...":"…","outcome":"failed","error":{"text":"net::ERR_ABORTED","canceled":true}}',
];

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const SAMPLE_FIXTURE_DIR = join(REPO_ROOT, "fixtures", "bundles", "sample-v0");

export function sampleEvents(): RawEvent[] {
  return SAMPLE_LINES.map((line) => {
    const e = toRawEvent(JSON.parse(line));
    if (typeof e === "string") throw new Error(`bad sample line: ${e}`);
    return e;
  });
}

/** created = ts of the first sample event, finished = ts of the last one. */
export const SAMPLE_CREATED = 1760500000000;
export const SAMPLE_FINISHED = 1760500001350;

export async function buildSampleBundle(dir: string): Promise<void> {
  const w = await BundleWriter.open(dir, {
    now: () => SAMPLE_FINISHED,
    init: {
      id: ulid(SAMPLE_CREATED, new Uint8Array(10)),
      created: SAMPLE_CREATED,
      // name and tab table taken from sample seq 1 (session) and seq 2 (tab attach)
      session: { name: "range-s02", tabs: [{ tab: "t1", chromeTabId: 1234, owned: true, firstUrl: "http://127.0.0.1:4310/s02/a" }] },
      mode: { capture: "mixed", trace: false, raw: true },
    },
  });
  for (const e of sampleEvents()) {
    const { seq, ...rest } = e;
    const stored = w.append(rest);
    if (stored.seq !== seq) throw new Error(`seq drift: wrote ${stored.seq}, sample has ${seq}`);
  }
  await w.close();
}

// ------------------------------------------------------------ rich bundle

export const SECRET_SID = "abc123def456";
export const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy";
export const ITEMS_JSON = JSON.stringify({ items: [{ title: "条目 A", sid: SECRET_SID }, { title: "条目 B" }], contact: "demo@example.com" });
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01]);
export const RICH_FINISHED = 1760500009000;

const base = { mono: null, actor: "human" as const, tab: "t1", cmd: null };

/** Synthetic §5.1-complete bundle: pages, requests (gzip/binary/form/ws/failed/incomplete), action, state, screenshot. */
export async function buildRichBundle(dir: string): Promise<void> {
  const w = await BundleWriter.open(dir, {
    now: () => RICH_FINISHED,
    init: {
      id: ulid(1760500000000, new Uint8Array(10).fill(1)),
      created: 1760500000000,
      producer: { tool: "tabcap", version: "0.1.0", browser: { name: "Chrome", version: "155.0.8059.41", userAgent: "UA" }, platform: "darwin-arm64" },
      session: { name: "rich", site: "range-demo", account: "demo", tabs: [{ tab: "t1", chromeTabId: 1234, owned: true, firstUrl: "http://127.0.0.1:4310/s02/a?sid=" + SECRET_SID }] },
      mode: { capture: "mixed", trace: false, raw: true, humanRecorder: false },
    },
  });
  const items = await w.putBlob(ITEMS_JSON);
  const login = await w.putBlob(JSON.stringify({ ok: true, token: JWT }));
  const png = await w.putBlob(PNG_BYTES);
  const cookies = await w.putBlob(JSON.stringify([{ name: "sid", value: SECRET_SID, domain: "127.0.0.1", path: "/" }, { name: "theme", value: "dark", domain: "127.0.0.1", path: "/" }]));
  const shot = await w.putBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const ref = (r: Awaited<ReturnType<BundleWriter["putBlob"]>>) => {
    if (r.outcome !== "stored") throw new Error("fixture blob not stored");
    return r;
  };

  w.append({ ...base, ts: 1760500000000, actor: "system", tab: null, kind: "session", phase: "start", name: "rich", mode: { capture: "mixed", trace: false, raw: true } });
  w.append({ ...base, ts: 1760500000100, actor: "system", kind: "tab", phase: "attach", chromeTabId: 1234, owned: true, url: "http://127.0.0.1:4310/s02/a", reason: "borrowed" });
  w.append((seq) => ({ ...base, ts: 1760500000150, mono: 88000, kind: "nav", frame: "root", nav: `n-${seq}`, url: "http://127.0.0.1:4310/s02/a", from: null, type: "navigation", loaderId: "L1", loadEvent: { domContentLoaded: 88100.5, load: 88200 } }));
  // r-4: GET xhr, gzip on the wire, cookie + authorization, multi-value set-cookie.
  w.append((seq) => ({
    ...base, ts: 1760500000900, mono: 88750.2, kind: "request", nav: "n-3", id: `r-${seq}`,
    cdp: { requestId: "1A2B.33", loaderId: "L1", frameId: "F1", sessionId: null },
    type: "xhr", method: "GET", url: `http://127.0.0.1:4310/api/items?page=2&sid=${SECRET_SID}&q=13800138000`, urlFragment: null,
    initiator: { type: "script", url: "http://127.0.0.1:4310/app.js", line: 120, col: 33, stack: null },
    request: { headers: { accept: "application/json", cookie: `sid=${SECRET_SID}; theme=dark`, authorization: `Bearer ${JWT}` }, headersSource: "merged", postData: null },
    response: {
      status: 200, statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", "set-cookie": [`sid=${SECRET_SID}; Path=/; HttpOnly`, "theme=dark"] },
      headersSource: "merged", mimeType: "application/json", charset: "utf-8", protocol: "h2", remote: { ip: "127.0.0.1", port: 4310 },
      fromCache: false, fromServiceWorker: false, fromPrefetch: false,
      body: { blob: ref(items).ref, size: ref(items).size, base64: false, wireEncoding: "gzip", truncated: false },
      bodyMissing: null,
    },
    redirect: null,
    timing: { start: 88120.1, responseStart: 88122, end: 88123.4, cdp: { requestTime: 88.1201, dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1, sendStart: 0.4, sendEnd: 0.6, receiveHeadersEnd: 1.9 } },
    outcome: "finished", error: null,
  }));
  // r-5: POST form with a password, JSON response carrying a JWT.
  w.append((seq) => ({
    ...base, ts: 1760500001000, mono: 88850, kind: "request", nav: "n-3", id: `r-${seq}`, cdp: null,
    type: "fetch", method: "POST", url: "http://127.0.0.1:4310/api/login", urlFragment: null, initiator: null,
    request: { headers: { "content-type": "application/x-www-form-urlencoded", "x-api-key": "k-998877" }, headersSource: "event", postData: { inline: "user=demo&password=hunter2secret&remember=1" } },
    response: {
      status: 200, statusText: "OK", headers: { "content-type": "application/json" }, headersSource: "event", mimeType: "application/json", charset: null, protocol: "http/1.1", remote: null,
      fromCache: false, fromServiceWorker: false, fromPrefetch: false,
      body: { blob: ref(login).ref, size: ref(login).size, base64: false, wireEncoding: null, truncated: false }, bodyMissing: null,
    },
    redirect: null, timing: { start: 88850, responseStart: 88860, end: 88861, cdp: null }, outcome: "finished", error: null,
  }));
  // r-6: binary image.
  w.append((seq) => ({
    ...base, ts: 1760500001100, mono: 88900, kind: "request", nav: "n-3", id: `r-${seq}`, cdp: null,
    type: "image", method: "GET", url: "http://127.0.0.1:4310/logo.png", urlFragment: null, initiator: null,
    request: { headers: { accept: "image/png" }, headersSource: "event", postData: null },
    response: {
      status: 200, statusText: "OK", headers: { "content-type": "image/png" }, headersSource: "event", mimeType: "image/png", charset: null, protocol: "h2", remote: null,
      fromCache: true, fromServiceWorker: false, fromPrefetch: false,
      body: { blob: ref(png).ref, size: ref(png).size, base64: true, wireEncoding: null, truncated: false }, bodyMissing: null,
    },
    redirect: null, timing: null, outcome: "finished", error: null,
  }));
  // r-7: websocket handshake + frames.
  w.append((seq) => ({
    ...base, ts: 1760500001200, mono: 88950, kind: "request", nav: "n-3", id: `r-${seq}`, cdp: null,
    type: "websocket", method: "GET", url: "ws://127.0.0.1:4310/ws", urlFragment: null, initiator: null,
    request: { headers: { upgrade: "websocket" }, headersSource: "event", postData: null },
    response: {
      status: 101, statusText: "Switching Protocols", headers: { upgrade: "websocket" }, headersSource: "event", mimeType: null, charset: null, protocol: "http/1.1", remote: null,
      fromCache: false, fromServiceWorker: false, fromPrefetch: false, body: null, bodyMissing: null,
    },
    redirect: null, timing: null, outcome: "finished", error: null,
  }));
  w.append({ ...base, ts: 1760500001250, kind: "ws", ws: "r-7", phase: "frame", direction: "send", opcode: 1, payload: { inline: JSON.stringify({ op: "sub", token: JWT }) }, reason: null });
  w.append({ ...base, ts: 1760500001260, kind: "ws", ws: "r-7", phase: "frame", direction: "recv", opcode: 1, payload: { inline: "{\"op\":\"tick\",\"n\":1}" }, reason: null });
  w.append((seq) => ({ ...base, ts: 1760500001300, mono: 89150, kind: "nav", frame: "root", nav: `n-${seq}`, url: "http://127.0.0.1:4310/s02/a#tab2", from: "http://127.0.0.1:4310/s02/a", type: "history", loaderId: "L1", loadEvent: null }));
  // r-11: failed; r-12: incomplete (never exported).
  w.append((seq) => ({
    ...base, ts: 1760500001350, mono: 89200, kind: "request", nav: "n-10", id: `r-${seq}`, cdp: null,
    type: "xhr", method: "GET", url: "http://127.0.0.1:4310/api/slow", urlFragment: null, initiator: null,
    request: { headers: { accept: "*/*" }, headersSource: "event", postData: null }, response: null,
    redirect: null, timing: null, outcome: "failed", error: { text: "net::ERR_ABORTED", canceled: true, blockedReason: null },
  }));
  w.append((seq) => ({
    ...base, ts: 1760500001400, mono: 89250, kind: "request", nav: "n-10", id: `r-${seq}`, cdp: null,
    type: "eventsource", method: "GET", url: "http://127.0.0.1:4310/api/stream", urlFragment: null, initiator: null,
    request: { headers: {}, headersSource: "event", postData: null },
    response: { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" }, headersSource: "event", mimeType: "text/event-stream", charset: null, protocol: "h2", remote: null, fromCache: false, fromServiceWorker: false, fromPrefetch: false, body: null, bodyMissing: { reason: "navigated", detail: "No resource with given identifier found" } },
    redirect: null, timing: null, outcome: "incomplete", error: null,
  }));
  w.append({ ...base, ts: 1760500001500, kind: "action", op: "click", target: { role: "link", name: "下一页", selector: "a#next" }, value: null, phase: "done", trusted: true, nav: "n-3" });
  w.append({ ...base, ts: 1760500001600, actor: "system", kind: "state", what: "cookies", origin: "http://127.0.0.1:4310", blob: ref(cookies).ref, count: 2, reason: "nav" });
  w.append({ ...base, ts: 1760500001700, actor: "system", kind: "screenshot", blob: ref(shot).ref, format: "png", width: 2, height: 2, scale: 1, reason: "nav", nav: "n-3" });
  w.append({ ...base, ts: 1760500001800, actor: "ai", kind: "note", text: "contact demo@example.com", refs: ["r-4"] });
  w.append({ ...base, ts: 1760500001900, actor: "system", tab: null, kind: "session", phase: "stop", name: "rich", mode: { capture: "mixed", trace: false, raw: true } });
  await w.close();
}

/** gzip of ITEMS_JSON, for tests that need real compressed bytes. */
export function gzippedItems(): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(ITEMS_JSON, "utf8")));
}

if (import.meta.main) {
  rmSync(SAMPLE_FIXTURE_DIR, { recursive: true, force: true });
  await buildSampleBundle(SAMPLE_FIXTURE_DIR);
  process.stdout.write(`wrote ${SAMPLE_FIXTURE_DIR}\n`);
}
