// 0.6-I `net start --bodies all|api|api+script|none`: the mode table (owner
// design 10-16: api = document, xhr, fetch, websocket, eventsource, other
// non-static; api+script adds scripts; image, font, stylesheet, media are
// metadata only under both), config.json `record.bodies`, and the recorder
// over a fake transport (CDP event order as in post-redirect.test.ts).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { readManifest } from "../../src/bundle/manifest.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { BODIES_MODES, keepsBody, parseBodiesMode, type BodiesMode } from "../../src/shared/bodies.ts";
import { recordBodiesFrom } from "../../src/shared/config.ts";
import { isRecord } from "../../src/shared/json.ts";

const TYPES = ["document", "xhr", "fetch", "websocket", "eventsource", "manifest", "other", "script", "stylesheet", "image", "font", "media"] as const;

describe("body mode table (0.6-I)", () => {
  test("which types keep their body, per mode", () => {
    const table = Object.fromEntries(BODIES_MODES.map((m) => [m, TYPES.filter((t) => keepsBody(m, t))]));
    expect(table).toEqual({
      all: [...TYPES],
      api: ["document", "xhr", "fetch", "websocket", "eventsource", "manifest", "other"],
      "api+script": ["document", "xhr", "fetch", "websocket", "eventsource", "manifest", "other", "script"],
      none: [],
    });
  });

  test("--bodies and config.json record.bodies: the four names, anything else an error", () => {
    for (const m of BODIES_MODES) expect(parseBodiesMode(m, "flag")).toBe(m);
    expect(() => parseBodiesMode("API", "flag")).toThrow(/--bodies/);
    expect(() => parseBodiesMode("scripts", "config")).toThrow(/record\.bodies/);
    expect(recordBodiesFrom({})).toBe("all");
    expect(recordBodiesFrom({ record: { bodies: "api+script" } })).toBe("api+script");
    expect(recordBodiesFrom({ record: {} })).toBe("all");
    expect(() => recordBodiesFrom({ record: "api" })).toThrow(/config\.json record/);
    expect(() => recordBodiesFrom({ record: { bodies: 1 } })).toThrow(/record\.bodies/);
  });
});

function fakeChrome() {
  const listeners = new Set<(e: CdpEvent) => void>();
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const bodyCalls: string[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}) => {
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getResponseBody") {
        bodyCalls.push(String(params["requestId"]));
        return { body: `body of ${String(params["requestId"])}`, base64Encoded: false };
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
  return { t, emit, bodyCalls };
}

const ORIGIN = "http://127.0.0.1:9";
/** CDP Network.ResourceType spellings of the requests a page makes. */
const PAGE: Array<{ id: string; cdpType: string; path: string; mime: string; status?: number }> = [
  { id: "D1", cdpType: "Document", path: "/s54", mime: "text/html" },
  { id: "S1", cdpType: "Script", path: "/s54/big.js", mime: "application/javascript" },
  { id: "C1", cdpType: "Stylesheet", path: "/s54/site.css", mime: "text/css" },
  { id: "I1", cdpType: "Image", path: "/s54/logo.png", mime: "image/png" },
  { id: "F1", cdpType: "Font", path: "/s54/f.woff2", mime: "font/woff2" },
  { id: "X1", cdpType: "XHR", path: "/s54/api", mime: "application/json" },
  { id: "R1", cdpType: "Fetch", path: "/s54/data", mime: "application/json" },
  { id: "N1", cdpType: "XHR", path: "/s54/empty", mime: "", status: 204 },
];

async function record(mode: BodiesMode | undefined) {
  const chrome = fakeChrome();
  const tabs = new Tabs(chrome.t, false);
  await tabs.createTab("s54");
  const dir = join(mkdtempSync(join(tmpdir(), "tabcap-06i-")), "b");
  const rec = await Recorder.start({ session: "s54", dir, t: chrome.t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" }, ...(mode === undefined ? {} : { bodies: mode }) });
  let ts = 10;
  for (const r of PAGE) {
    chrome.emit("Network.requestWillBeSent", { requestId: r.id, loaderId: "L1", type: r.cdpType, timestamp: (ts += 0.01), wallTime: 1760500000, request: { url: `${ORIGIN}${r.path}`, method: "GET", headers: {} } });
    chrome.emit("Network.responseReceived", { requestId: r.id, type: r.cdpType, timestamp: (ts += 0.01), response: { status: r.status ?? 200, headers: { "content-type": r.mime }, mimeType: r.mime } });
    chrome.emit("Network.loadingFinished", { requestId: r.id, timestamp: (ts += 0.01) });
  }
  // let the recorder write every request before looking at the index
  for (let i = 0; i < 50 && rec.index.length < PAGE.length; i++) await Bun.sleep(5);
  const index = [...rec.index];
  await rec.stop();
  return { reader: await BundleReader.open(dir), dir, index, bodyCalls: chrome.bodyCalls };
}

const bodyOf = (e: unknown): unknown => (isRecord(e) && isRecord(e["response"]) ? e["response"]["body"] : undefined);

describe("recorder under --bodies (0.6-I)", () => {
  test("api: scripts and static resources are metadata only, never asked from Chrome; manifest record.bodies says api", async () => {
    const { reader, dir, index, bodyCalls } = await record("api");
    expect(readManifest(dir).record).toEqual({ bodies: "api" });
    expect(bodyCalls.sort()).toEqual(["D1", "R1", "X1"]);
    const byPath = new Map(reader.requests().map((r) => [new URL(r.url).pathname, r]));
    for (const p of ["/s54/big.js", "/s54/site.css", "/s54/logo.png", "/s54/f.woff2"]) {
      const raw = reader.events.find((e) => e.kind === "request" && e["url"] === `${ORIGIN}${p}`);
      expect(bodyOf(raw)).toEqual({ skipped: "resource-type" });
      expect(byPath.get(p)?.response?.body).toBeNull();
      expect(byPath.get(p)?.response?.bodyMissing).toBeNull();
      expect(byPath.get(p)?.response?.status).toBe(200);
    }
    for (const p of ["/s54", "/s54/api", "/s54/data"]) expect(byPath.get(p)?.response?.body?.blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    // a 204 has no body whatever the mode: its reason stays
    expect(byPath.get("/s54/empty")?.response?.bodyMissing?.reason).toBe("no-content");
    expect(index.filter((e) => e.bodySkipped !== undefined).map((e) => e.type)).toEqual(["script", "stylesheet", "image", "font"]);
    expect(reader.manifest.counts.bodies).toBe(3);
  });

  test("api+script keeps the script; all (and no option) keep everything; none keeps nothing", async () => {
    const plus = await record("api+script");
    expect(plus.bodyCalls.sort()).toEqual(["D1", "R1", "S1", "X1"]);
    expect(plus.index.filter((e) => e.bodySkipped !== undefined).map((e) => e.type)).toEqual(["stylesheet", "image", "font"]);
    const all = await record("all");
    expect(all.bodyCalls.length).toBe(7);
    expect(all.index.some((e) => e.bodySkipped !== undefined)).toBe(false);
    expect(readManifest(all.dir).record).toEqual({ bodies: "all" });
    const dflt = await record(undefined);
    expect(readManifest(dflt.dir).record).toEqual({ bodies: "all" });
    expect(dflt.bodyCalls.length).toBe(7);
    const none = await record("none");
    expect(none.bodyCalls).toEqual([]);
    expect(none.index.filter((e) => e.bodySkipped !== undefined).length).toBe(7);
    expect(none.reader.manifest.counts.bodies).toBe(0);
  });
});
