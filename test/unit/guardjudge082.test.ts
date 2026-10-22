// 0.8.2 (docs/04 §18): an acting command answers only once the guard has judged the documents
// it loaded. PR #29, Windows CI: a navigate onto the s15 403 verify page answered ok because the
// page's context (navigate's readiness) came before the document's loadingFinished and body
// write; the guard tripped a moment later. Oracle: the CDP event order Chrome sends (context /
// responseReceived before loadingFinished), played from a fake transport with a slow body.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { Guard } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";

async function setup(bodyMs: number) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method) => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getResponseBody") {
        await Bun.sleep(bodyMs);
        return { body: "<html>verify</html>", base64Encoded: false };
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
  const tabs = new Tabs(t, false);
  const tab = await tabs.createTab("n");
  const rec = await Recorder.start({ session: "n", dir: join(mkdtempSync(join(tmpdir(), "tabcap-judge-")), "b"), t, tabs, browser: { version: "Chrome/156", userAgent: "UA", webdriver: "hidden" } });
  const guard = new Guard({
    configDir: join(mkdtempSync(join(tmpdir(), "tabcap-judge-")), "config"),
    secrets: new Secrets(),
    siteOf: () => null,
    screenshot: async () => null,
    pageInfo: async () => ({ url: null, title: null, text: null }),
    settleMs: 0,
  });
  guard.watch(rec);
  /** The verify page as a document: request and response; loadingFinished only when `finished`. */
  const page = (id: string, o: { finished: boolean; type?: string }) => {
    const type = o.type ?? "Document";
    emit("Network.requestWillBeSent", { requestId: id, loaderId: id, type, timestamp: 10, wallTime: 1761000000, request: { url: "http://127.0.0.1:9/api/limited?bucket=nav", method: "GET", headers: {} } });
    emit("Network.responseReceived", { requestId: id, type, timestamp: 10.1, response: { status: 403, headers: { "content-type": "text/html" }, mimeType: "text/html" } });
    if (o.finished) emit("Network.loadingFinished", { requestId: id, timestamp: 10.2 });
  };
  return { tab, rec, guard, page, emit };
}

describe("documentsIndexed: the guard judges a loaded document before the answer (0.8.2)", () => {
  test("a slow body write: the wait ends once the document is in the index, and the guard is waiting by then", async () => {
    const { tab, rec, guard, page } = await setup(150);
    page("R1", { finished: true });
    expect(guard.get("n")).toBeNull();
    const t0 = Date.now();
    expect(await rec.documentsIndexed(tab.id, 2000)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(rec.index.map((e) => [e.type, e.status])).toEqual([["document", 403]]);
    expect(guard.get("n")).toMatchObject({ state: "waiting", reason: "verify-page" });
    await rec.stop();
  });

  test("loadingFinished still to come: the wait covers it too", async () => {
    const { tab, rec, guard, page, emit } = await setup(0);
    page("R1", { finished: false });
    setTimeout(() => emit("Network.loadingFinished", { requestId: "R1", timestamp: 10.2 }), 80);
    expect(await rec.documentsIndexed(tab.id, 2000)).toBe(true);
    expect(guard.get("n")).toMatchObject({ state: "waiting" });
    await rec.stop();
  });

  test("bounded: a document that does not finish in time ends the wait with false", async () => {
    const { tab, rec, page } = await setup(0);
    page("R1", { finished: false });
    const t0 = Date.now();
    expect(await rec.documentsIndexed(tab.id, 120)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    await rec.stop();
  });

  test("nothing to wait for: other tabs, non-documents and documents without a response return at once", async () => {
    const { tab, rec, page, emit } = await setup(5000);
    page("R1", { finished: false, type: "XHR" });
    emit("Network.requestWillBeSent", { requestId: "R2", loaderId: "R2", type: "Document", timestamp: 11, wallTime: 1761000001, request: { url: "http://127.0.0.1:9/next", method: "GET", headers: {} } });
    const t0 = Date.now();
    expect(await rec.documentsIndexed(tab.id, 2000)).toBe(true);
    expect(await rec.documentsIndexed("t-other", 2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
    await rec.stop();
  });
});
