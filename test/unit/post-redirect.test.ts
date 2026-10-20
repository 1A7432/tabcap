// 0.6-D (docs/05 s49): the recorder's redirect path keeps a POST's body, from
// a fake transport. Oracles: the CDP event sequence Chrome sent for a POST
// answered with 302 (raw/cdp.jsonl of the s49 e2e, 10-16: the POST's
// requestWillBeSent carries postData; the redirect hop is a second
// requestWillBeSent with the same requestId, redirectResponse and no
// postData) and the bundle body rules of docs/04 §5.2 (inline up to 64 KiB,
// else a blob).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";

function fakeChrome(o: { postData?: (requestId: string) => Promise<string> } = {}) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const calls: string[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}) => {
      calls.push(method);
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getRequestPostData") {
        if (o.postData === undefined) throw new Error("No post data available for the request");
        return { postData: await o.postData(String(params["requestId"])) };
      }
      if (method === "Network.getResponseBody") return { body: "ok", base64Encoded: false };
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
  return { t, emit, calls };
}

const ORIGIN = "http://127.0.0.1:9";
const redirect302 = (location: string) => ({ status: 302, statusText: "Found", headers: { location }, mimeType: "" });

/** POST /s49/submit → 302 → GET /s49/done (→ 302 → GET /s49/final with `twice`), the CDP events in Chrome's order. */
async function recordRedirect(post: { postData?: string; hasPostData: boolean }, chrome = fakeChrome(), twice = false) {
  const tabs = new Tabs(chrome.t, false);
  await tabs.createTab("s49");
  const dir = join(mkdtempSync(join(tmpdir(), "tabcap-06d-")), "b");
  const rec = await Recorder.start({ session: "s49", dir, t: chrome.t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" } });
  const { emit } = chrome;
  emit("Network.requestWillBeSent", {
    requestId: "R1",
    loaderId: "L1",
    type: "Document",
    timestamp: 10,
    wallTime: 1760500000,
    request: { url: `${ORIGIN}/s49/submit`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, hasPostData: post.hasPostData, ...(post.postData === undefined ? {} : { postData: post.postData }) },
  });
  emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", type: "Document", timestamp: 10.2, wallTime: 1760500000.2, redirectResponse: redirect302("/s49/done"), request: { url: `${ORIGIN}/s49/done`, method: "GET", headers: {} } });
  if (twice) emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", type: "Document", timestamp: 10.25, wallTime: 1760500000.25, redirectResponse: redirect302("/s49/final"), request: { url: `${ORIGIN}/s49/final`, method: "GET", headers: {} } });
  emit("Network.responseReceived", { requestId: "R1", type: "Document", timestamp: 10.3, response: { status: 200, headers: { "content-type": "text/html" }, mimeType: "text/html" } });
  emit("Network.loadingFinished", { requestId: "R1", timestamp: 10.4 });
  await rec.stop();
  return BundleReader.open(dir);
}

describe("recorder: a POST answered with a redirect keeps its body (0.6-D, docs/05 s49)", () => {
  test("form POST → 302 → GET: the POST hop has postData inline, the GET points back at it", async () => {
    const body = "user=s49-user&note=%E5%A4%87%E6%B3%A8+a%26b%3Dc";
    const reqs = (await recordRedirect({ postData: body, hasPostData: true })).requests();
    expect(reqs.map((r) => [r.method, r.url, r.response?.status ?? null])).toEqual([
      ["POST", `${ORIGIN}/s49/submit`, 302],
      ["GET", `${ORIGIN}/s49/done`, 200],
    ]);
    expect(reqs[0]?.request.postData).toEqual({ inline: body });
    expect(reqs[1]?.request.postData).toBeNull();
    expect(reqs[1]?.redirect).toEqual({ from: reqs[0]?.id ?? "" });
  });

  test("a body over the inline limit goes to a blob first; the GET hop still points at the POST, which is written first", async () => {
    const body = "x=" + "a".repeat(70 * 1024);
    const reader = await recordRedirect({ postData: body, hasPostData: true });
    const reqs = reader.requests();
    expect(reqs.map((r) => r.method)).toEqual(["POST", "GET"]);
    const pd = reqs[0]?.request.postData;
    if (pd === null || pd === undefined || !("blob" in pd)) throw new Error(`expected a blob, got ${JSON.stringify(pd)}`);
    expect(pd.size).toBe(body.length);
    expect(new TextDecoder().decode(reader.mustReadBlob(pd.blob))).toBe(body);
    expect(reqs[1]?.redirect).toEqual({ from: reqs[0]?.id ?? "" });
  });

  test("two redirects after a blob-sized POST: hops written in order, each pointing at the one before", async () => {
    const reqs = (await recordRedirect({ postData: "y=" + "b".repeat(70 * 1024), hasPostData: true }, fakeChrome(), true)).requests();
    expect(reqs.map((r) => [r.method, r.url])).toEqual([
      ["POST", `${ORIGIN}/s49/submit`],
      ["GET", `${ORIGIN}/s49/done`],
      ["GET", `${ORIGIN}/s49/final`],
    ]);
    expect(reqs[1]?.redirect).toEqual({ from: reqs[0]?.id ?? "" });
    expect(reqs[2]?.redirect).toEqual({ from: reqs[1]?.id ?? "" });
  });

  test("hasPostData without postData: asked with Network.getRequestPostData; when the answer fails, postDataMissing says so", async () => {
    const asked = fakeChrome({ postData: async () => "late=1" });
    const got = (await recordRedirect({ hasPostData: true }, asked)).requests();
    expect(got[0]?.request.postData).toEqual({ inline: "late=1" });
    expect(asked.calls).toContain("Network.getRequestPostData");
    const gone = (await recordRedirect({ hasPostData: true })).requests();
    expect(gone[0]?.request.postData).toBeNull();
    expect(gone[0]?.request.postDataMissing).toMatchObject({ reason: "unavailable" });
    expect(gone[1]?.redirect).toEqual({ from: gone[0]?.id ?? "" });
  });

  test("a GET redirect stays as before: no postData, written at once", async () => {
    const reqs = (await recordRedirect({ hasPostData: false })).requests();
    expect(reqs.map((r) => r.request.postData)).toEqual([null, null]);
    expect(reqs[0]?.request.postDataMissing).toBeUndefined();
  });
});
