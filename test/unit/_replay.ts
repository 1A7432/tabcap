// Synthetic bundle for the replay tests (serve / session / export-python /
// check). Written through the real BundleWriter (via _analyze.ts). Values are
// test data, not oracle values: tests compare what replay serves with what
// this builder stored (sha256 of the blobs), never with hand-written hashes.
//
// Contents (origin http://127.0.0.1:4310):
//   GET  /                      document, HTML
//   GET  /api/items?page=1&client=web   JSON, cookie header
//   GET  /api/items?client=web&page=2   JSON (same group, other key)
//   GET  /api/feed  ×3          same key, three different bodies (pagination-style cycling)
//   POST /api/login             form body, two set-cookie headers, JSON {ok, csrf}
//   POST /api/search  ×2        JSON body {q, page, t, client}, header x-client-build
//   GET  /api/sign?q=…&sig=<64 hex>&t=…  ×2  signature-like parameter
//   GET  /api/evicted           200, body missing (evicted)
//   GET  /api/gone              no response (navigated): not replayable
//   GET  /go                    302, absolute same-origin location, body missing (redirect)
//   POST /api/ping              204, body missing (no-content)
//   GET  /img/logo.png          image bytes
//   POST /api/upload            request body not recorded (postDataMissing)
//   state cookies ×2 (the later one wins), state localStorage ×1

import { createHmac } from "node:crypto";
import { buildBundle } from "./_analyze.ts";

export const ORIGIN = "http://127.0.0.1:4310";
export const CREATED = 1760600000000;
export const SID = "sid-7f3a9c21e5b0";
export const CSRF = "csrf-41d8cd98f00b";
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0x7f]);
export const HTML = "<!doctype html><meta charset=utf-8><title>replay</title><p>条目列表</p>";
export const ITEMS1 = JSON.stringify({ items: [{ id: 1, title: "苹果" }, { id: 2, title: "香蕉" }], page: 1, served: "items-v1", more: true });
export const ITEMS2 = JSON.stringify({ items: [{ id: 3, title: "樱桃", tag: null }], page: 2, served: "items-v1", more: false });
export const FEED = [1, 2, 3].map((n) => JSON.stringify({ n, cursor: `c${n}`, kind: "feed" }));
export const LOGIN_BODY = "user=demo&pass=hunter2+x";
export const LOGIN_RESP = JSON.stringify({ ok: true, csrf: CSRF });
export const SEARCH = [
  { q: "apple", page: 1, t: CREATED + 5000, client: "web" },
  { q: "banana", page: 2, t: CREATED + 9000, client: "web" },
];
export const SEARCH_RESP = SEARCH.map((s) => JSON.stringify({ query: s.q, page: s.page, total: 2, hits: [{ name: `${s.q}-1`, score: 0.5 }] }));
export const SIGN_KEY = "test-key";
export const sign = (q: string, t: number) => createHmac("sha256", SIGN_KEY).update(`${q}|${t}`).digest("hex");
export const SIGN_URLS = [
  `${ORIGIN}/api/sign?q=a&t=${CREATED + 11000}&sig=${sign("a", CREATED + 11000)}`,
  `${ORIGIN}/api/sign?q=b&t=${CREATED + 12000}&sig=${sign("b", CREATED + 12000)}`,
];
export const COOKIES_OLD = [{ name: "sid", value: "old-session-value", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, session: true }];
export const COOKIES = [
  { name: "sid", value: SID, domain: "127.0.0.1", path: "/", expires: -1, size: 20, httpOnly: true, secure: false, session: true, sameSite: "Strict", priority: "Medium" },
  { name: "theme", value: "dark", domain: "127.0.0.1", path: "/", expires: 1790000000.5, size: 9, httpOnly: false, secure: false, session: false, priority: "Medium" },
  { name: 7, value: "not a cookie" },
];
export const LOCAL_STORAGE = [["token", "ls-token-1"], ["lang", "zh"]];

const JSON_MIME = "application/json";

export async function buildReplayBundle(dir: string): Promise<string> {
  return buildBundle(dir, { name: "replay-demo", created: CREATED, seed: 7 }, async (b) => {
    const cookie = `sid=${SID}; theme=dark`;
    await b.request({ url: `${ORIGIN}/`, type: "document", mime: "text/html", body: HTML, respHeaders: { "content-type": "text/html; charset=utf-8" }, ts: CREATED + 100 });
    const oldState = await b.w.putBlob(JSON.stringify(COOKIES_OLD));
    if (oldState.outcome !== "stored") throw new Error("state blob");
    b.w.append({ actor: "ai", tab: "t1", cmd: null, ts: CREATED + 150, mono: null, kind: "state", what: "cookies", origin: ORIGIN, blob: oldState.ref, count: 1, reason: "session-start" });
    await b.request({
      url: `${ORIGIN}/api/login`,
      method: "POST",
      type: "fetch",
      mime: JSON_MIME,
      body: LOGIN_RESP,
      postData: LOGIN_BODY,
      reqHeaders: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      respHeaders: {
        "set-cookie": [`sid=${SID}; Path=/; HttpOnly`, "theme=dark; Path=/"],
        "content-encoding": "gzip",
        "content-length": "999",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "x-request-id": "login-1",
      },
      ts: CREATED + 200,
    });
    await b.request({ url: `${ORIGIN}/api/items?page=1&client=web`, mime: JSON_MIME, body: ITEMS1, reqHeaders: { accept: JSON_MIME, cookie, "x-client-build": "2026.10" }, ts: CREATED + 1000 });
    await b.request({ url: `${ORIGIN}/api/items?client=web&page=2`, mime: JSON_MIME, body: ITEMS2, reqHeaders: { accept: JSON_MIME, cookie, "x-client-build": "2026.10" }, ts: CREATED + 2000 });
    for (const [i, body] of FEED.entries()) await b.request({ url: `${ORIGIN}/api/feed`, type: "fetch", mime: JSON_MIME, body, reqHeaders: { cookie }, ts: CREATED + 3000 + i * 100 });
    for (const [i, s] of SEARCH.entries()) {
      await b.request({
        url: `${ORIGIN}/api/search`,
        method: "POST",
        type: "fetch",
        mime: JSON_MIME,
        body: SEARCH_RESP[i] ?? "",
        postData: JSON.stringify(s),
        reqHeaders: { "content-type": JSON_MIME, "x-client-build": "2026.10", "x-csrf": CSRF, cookie },
        ts: s.t + 20,
      });
    }
    for (const [i, url] of SIGN_URLS.entries()) await b.request({ url, mime: JSON_MIME, body: JSON.stringify({ ok: 1, i }), ts: CREATED + 11020 + i * 1000 });
    await b.request({ url: `${ORIGIN}/api/evicted`, mime: JSON_MIME, bodyMissing: "evicted", ts: CREATED + 13000 });
    await b.request({ url: `${ORIGIN}/api/gone`, status: 0, bodyMissing: "navigated", ts: CREATED + 13100 });
    await b.request({ url: `${ORIGIN}/go`, type: "document", status: 302, bodyMissing: "redirect", respHeaders: { location: `${ORIGIN}/final?x=1` }, ts: CREATED + 13200 });
    await b.request({ url: `${ORIGIN}/api/ping`, method: "POST", type: "fetch", status: 204, bodyMissing: "no-content", ts: CREATED + 13300 });
    await b.request({ url: `${ORIGIN}/img/logo.png`, type: "image", mime: "image/png", body: PNG, base64: true, ts: CREATED + 13400 });
    // the recorder could not fetch this request body (docs/04 §5.3 postDataMissing)
    const upBody = await b.w.putBlob('{"stored":true}');
    if (upBody.outcome !== "stored") throw new Error("upload blob");
    b.w.append((seq) => ({
      actor: "ai", tab: "t1", cmd: null, ts: CREATED + 13500, mono: null, kind: "request", nav: null, id: `r-${seq}`, cdp: null, type: "fetch",
      method: "POST", url: `${ORIGIN}/api/upload`, urlFragment: null, initiator: null,
      request: { headers: { "content-type": "application/octet-stream" }, headersSource: "event", postData: null, postDataMissing: { reason: "unavailable", detail: "No post data available for the request" } },
      response: {
        status: 200, statusText: "OK", headers: { "content-type": JSON_MIME }, headersSource: "event", mimeType: JSON_MIME, charset: null, protocol: "http/1.1", remote: null,
        fromCache: false, fromServiceWorker: false, fromPrefetch: false, body: { blob: upBody.ref, size: upBody.size, base64: false, wireEncoding: null, truncated: false }, bodyMissing: null,
      },
      redirect: null, timing: null, outcome: "finished", error: null,
    }));
    const st = await b.w.putBlob(JSON.stringify(COOKIES));
    const ls = await b.w.putBlob(JSON.stringify(LOCAL_STORAGE));
    if (st.outcome !== "stored" || ls.outcome !== "stored") throw new Error("state blob");
    b.w.append({ actor: "ai", tab: "t1", cmd: null, ts: CREATED + 14000, mono: null, kind: "state", what: "cookies", origin: ORIGIN, blob: st.ref, count: COOKIES.length, reason: "session-stop" });
    b.w.append({ actor: "ai", tab: "t1", cmd: null, ts: CREATED + 14001, mono: null, kind: "state", what: "localStorage", origin: ORIGIN, blob: ls.ref, count: LOCAL_STORAGE.length, reason: "session-stop" });
  });
}
