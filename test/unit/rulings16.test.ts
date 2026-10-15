// docs/04 §16 rulings and the P2 setup fix: bundle file permissions, default
// actor "ai" (no "outside a command window = human"), setup temp cleanup.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { BundleWriter } from "../../src/bundle/writer.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { cleanStaleTmp, downloadCft } from "../../src/daemon/transport/direct/cft.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";
import { isRecord } from "../../src/shared/json.ts";
import { expectMode } from "./_platform.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const mode = (p: string) => statSync(p).mode & 0o777;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...walk(p));
  }
  return out;
}

describe("bundle permissions (docs/04 §16)", () => {
  test("bundle dir 0700; events.jsonl, manifest.json, blobs 0600 in 0700 dirs", async () => {
    const dir = join(tmp("tabcap-perm-"), "b");
    const w = await BundleWriter.open(dir, { init: { session: { name: "p" }, mode: { capture: "mixed", trace: false, raw: false } } });
    w.append({ ts: 1, mono: null, kind: "session", actor: "system", tab: null, cmd: null, phase: "start", name: "p" });
    await w.putBlob("secret body");
    await w.close();
    expectMode(dir, 0o700);
    for (const p of walk(dir)) expectMode(p, statSync(p).isDirectory() ? 0o700 : 0o600);
    expect(walk(dir).some((p) => p.includes(`${sep}blobs${sep}sha256${sep}`))).toBe(true);
  });
});

/** A transport with one page tab whose CDP events the test plays. */
function fakeBrowser() {
  const listeners = new Set<(e: CdpEvent) => void>();
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method) => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getResponseBody") return { body: '{"ok":1}', base64Encoded: false };
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
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const l of listeners) l({ method, params, sessionId: "S1" });
  };
  return { t, emit };
}

describe("actor default (docs/04 §16)", () => {
  test("a request finishing outside any command window is still actor ai, cmd null", async () => {
    const { t, emit } = fakeBrowser();
    const tabs = new Tabs(t, false);
    await tabs.createTab("s");
    const dir = join(tmp("tabcap-actor-"), "b");
    const rec = await Recorder.start({ session: "s", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    const c = rec.cmdStart({ tab: "t1", argv: ["navigate"], input: {} });
    rec.cmdEnd(c ?? "", { tab: "t1", ok: true, error: null, durationMs: 1, outputSummary: null });
    // after the navigate returned: the page's own XHR
    emit("Network.requestWillBeSent", { requestId: "R1", loaderId: "L1", type: "XHR", timestamp: 1, wallTime: 1760500000, request: { url: "http://127.0.0.1:1/api", method: "GET", headers: {} } });
    emit("Network.responseReceived", { requestId: "R1", type: "XHR", timestamp: 1.01, response: { status: 200, headers: {}, mimeType: "application/json" } });
    emit("Network.loadingFinished", { requestId: "R1", timestamp: 1.02 });
    await Bun.sleep(50);
    await rec.stop();
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
    const req = events.find((e) => e["kind"] === "request");
    expect(req).toMatchObject({ actor: "ai", cmd: null, url: "http://127.0.0.1:1/api" });
    expect(events.some((e) => e["actor"] === "human")).toBe(false);
    expect(rec.cmdStarts.get(c ?? "")).toBeNumber();
  });
});

describe("setup temp cleanup (field report P2)", () => {
  test("stale .tmp-* of dead processes are removed; a live one and versions stay", () => {
    const cache = tmp("tabcap-cft-");
    for (const d of [".tmp-155.0.1.2-111", ".tmp-155.0.1.2-222", ".tmp-odd", "155.0.1.2"]) mkdirSync(join(cache, d));
    writeFileSync(join(cache, ".tmp-155.0.1.2-111", "chrome.zip"), "partial");
    const removed = cleanStaleTmp(cache, (pid) => pid === 222).sort();
    expect(removed).toEqual([".tmp-155.0.1.2-111", ".tmp-odd"]);
    expect(readdirSync(cache).sort()).toEqual([".tmp-155.0.1.2-222", "155.0.1.2"]);
    expect(cleanStaleTmp(join(cache, "missing"))).toEqual([]);
  });

  test("a failed download leaves no .tmp-* behind", async () => {
    const cache = tmp("tabcap-cft-fail-");
    mkdirSync(join(cache, ".tmp-1.0.0.0-999999999"));
    const index = { channels: { Stable: { version: "155.0.8059.79", downloads: { chrome: [{ platform: "mac-arm64", url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/mac-arm64/chrome-mac-arm64.zip" }] } } } };
    let calls = 0;
    const fetchFn = async (url: string): Promise<Response> => {
      calls++;
      if (url.endsWith(".json")) return new Response(JSON.stringify(index));
      // the body breaks half way
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1024));
          c.error(new Error("connection reset"));
        },
      });
      return new Response(body, { headers: { "content-length": "4096" } });
    };
    const err = await downloadCft(cache, "mac-arm64", fetchFn).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBe(2);
    expect(readdirSync(cache).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    expect(existsSync(join(cache, "155.0.8059.79"))).toBe(false);
  });
});
