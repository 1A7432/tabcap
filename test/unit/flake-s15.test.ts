// 0.3-C: the s15 e2e flake, two causes (measured 10-15, CfT 155).
// 1. The guard's screenshot of a background tab that had never been captured,
//    taken right after the 403 wall rendered, sometimes got Chrome's immediate
//    "Unable to capture screenshot" (4 of 15 in a loop of the s15 flow); the
//    guard stored null and the e2e waited for a screenshot that never came.
// 2. The page never reads the bodies of its 200 answers, so Chrome sends no
//    loadingFinished and those requests are closed at `net stop`; the closing
//    writes ran in parallel and a slower one could land after a later request
//    (the last /api/limited before /api/verified).
// Oracles: the CDP error text Chrome returned, and the order the requests
// started in. These tests play both from a fake transport, deterministically.

import { describe, expect, test } from "bun:test";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import type { AttachedTarget, CdpEvent } from "../../src/daemon/transport/types.ts";
import { deflateSync } from "node:zlib";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { Guard, type GuardRecorder } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { captureTab, isNoFrameError } from "../../src/daemon/tools/page.ts";
import { CdpError } from "../../src/daemon/transport/direct/cdp.ts";
import type { CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 2×1 RGBA PNG, two different pixels (not uniform). */
function smallPng(): Uint8Array {
  const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 255, 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 2);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Chrome as measured: no frame for a plain capture of the hidden tab; a frame once focus emulation is on. */
function hiddenTabChrome(o: { plainFails: boolean }) {
  const calls: string[] = [];
  let emulating = false;
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}) => {
      calls.push(method === "Emulation.setFocusEmulationEnabled" ? `${method}:${String(params["enabled"])}` : method);
      if (method === "Emulation.setFocusEmulationEnabled") emulating = params["enabled"] === true;
      if (method === "Page.captureScreenshot") {
        if (o.plainFails && !emulating) throw new CdpError(method, "Unable to capture screenshot", -32000);
        return { data: Buffer.from(smallPng()).toString("base64") };
      }
      return {};
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: () => Promise.reject(new Error("unused")),
    detach: async () => undefined,
    waitAttached: () => Promise.reject(new Error("unused")),
    targets: () => [],
  };
  return { t, calls };
}

describe("screenshot of a hidden tab with no frame yet (s15 flake)", () => {
  test("Chrome's 'Unable to capture screenshot' → one focus-emulated capture, emulation switched off again", async () => {
    const { t, calls } = hiddenTabChrome({ plainFails: true });
    const r = await captureTab(t, "S1", { format: "png", fromSurface: true }, "t2");
    expect(r.focusEmulation).toBe(true);
    expect(r.png.length).toBeGreaterThan(30);
    expect(calls).toEqual(["Page.captureScreenshot", "Emulation.setFocusEmulationEnabled:true", "Page.captureScreenshot", "Emulation.setFocusEmulationEnabled:false"]);
  });

  test("a capture that works stays plain; other CDP errors still fail", async () => {
    const ok = hiddenTabChrome({ plainFails: false });
    expect((await captureTab(ok.t, "S1", {}, "t2")).focusEmulation).toBe(false);
    expect(ok.calls).toEqual(["Page.captureScreenshot"]);
    expect(isNoFrameError(new CdpError("Page.captureScreenshot", "Unable to capture screenshot", -32000))).toBe(true);
    expect(isNoFrameError(new CdpError("Page.captureScreenshot", "Target closed", -32000))).toBe(false);
    expect(isNoFrameError(new Error("Unable to capture screenshot"))).toBe(false);
  });

  test("the guard's waiting state gets its screenshot although Chrome's first capture had no frame", async () => {
    const { t } = hiddenTabChrome({ plainFails: true });
    const events: Array<Record<string, unknown>> = [];
    let listener: ((e: NetEntry) => void) | null = null;
    const rec: GuardRecorder = {
      session: "s15",
      onIndexed: (fn) => {
        listener = fn;
        return () => undefined;
      },
      event: (kind, fields) => {
        events.push({ kind, ...fields });
        return events.length;
      },
      cmdStart: () => null,
      cmdEnd: () => undefined,
    };
    const g = new Guard({
      configDir: join(mkdtempSync(join(tmpdir(), "tabcap-flake-")), "config"),
      secrets: new Secrets(),
      siteOf: () => null,
      // the daemon's guardShot, minus the file: captureTab on the tab's session
      screenshot: async () => ((await captureTab(t, "S1", { format: "png", fromSurface: true }, "t2")).png.length > 0 ? "/shots/s15-t2.png" : null),
      pageInfo: async () => ({ url: null, title: null, text: null }),
      settleMs: 0,
    });
    g.watch(rec);
    const fire: (e: NetEntry) => void = listener ?? (() => undefined);
    fire({ id: "r-34", tab: "t2", type: "fetch", method: "GET", url: "http://127.0.0.1:9/api/limited", status: 403, mime: "text/html", size: 1, outcome: "finished", blob: null, bodyMissing: null, cmd: null, at: 0 });
    await g.settle();
    expect(g.get("s15")?.screenshot).toBe("/shots/s15-t2.png");
    expect(events.find((e) => e["kind"] === "handoff")).toMatchObject({ state: "waiting", screenshot: "/shots/s15-t2.png" });
  });
});

describe("requests closed at stop keep their start order (s15 flake, cause 2)", () => {
  test("a slow close (request body fetched late) does not let later requests overtake it", async () => {
    const listeners = new Set<(e: CdpEvent) => void>();
    const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
    const t: Transport = {
      kind: "direct",
      closed: new Promise<string>(() => undefined),
      send: async (method) => {
        if (method === "Target.createTarget") return { targetId: "T1" };
        // the slow path: the first request's body takes a while to come back
        if (method === "Network.getRequestPostData") {
          await Bun.sleep(80);
          return { postData: '{"code":""}' };
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
    await tabs.createTab("s15");
    const dir = join(mkdtempSync(join(tmpdir(), "tabcap-flush-")), "b");
    const rec = await Recorder.start({ session: "s15", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    // three fetches whose bodies the page never reads: responses, but no loadingFinished
    const urls = ["http://127.0.0.1:9/api/verified?bucket=main", "http://127.0.0.1:9/api/limited?bucket=main", "http://127.0.0.1:9/api/limited?bucket=main&n=2"];
    urls.forEach((url, i) => {
      const post = i === 0;
      emit("Network.requestWillBeSent", { requestId: `R${i}`, loaderId: "L1", type: "Fetch", timestamp: 10 + i, wallTime: 1760500000 + i, request: { url, method: post ? "POST" : "GET", headers: {}, hasPostData: post } });
      emit("Network.responseReceived", { requestId: `R${i}`, type: "Fetch", timestamp: 10.5 + i, response: { status: 200, headers: { "content-type": "application/json" }, mimeType: "application/json" } });
    });
    await rec.stop();
    const reqs = BundleReader.open(dir).requests();
    expect(reqs.map((r) => [r.url, r.outcome])).toEqual(urls.map((u) => [u, "incomplete"]));
    expect(reqs.map((r) => r.request.postData)).toEqual([{ inline: '{"code":""}' }, null, null]);
  });
});
