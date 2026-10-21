// The daemon side of the live protection probe (0.8-A2, docs/04 §41.3) that
// protectionlive.test.ts (the pure parts) leaves out: one probe per
// navigation (tab + navEpoch + URL), cached for navigate / snapshot / status /
// the guard; a failing step leaves the others; a `protection` event when the
// families change while the session records, once per recording (also for a
// page probed before `net start`, PR #25 Bugbot), nothing for "nothing found"
// in a new recording; the guard's names probed in the tab's turn, never an
// error. The page answers come from a fake transport (and, for the guard, the
// fake browser in _fakechrome.ts); expected families and scores come from the
// built-in rule file datadome.json (cookie `datadome` 100, global `ddjskey` 75).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinFamilies } from "../../src/analyze/protection/registry.ts";
import { DIGEST_FN } from "../../src/daemon/adapters/detect.ts";
import { Tabs, type Tab } from "../../src/daemon/browser/targets.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { cachedNames, liveIdentify, namesForGuard, probeTab, protectionField } from "../../src/daemon/protection/live.ts";
import { GLOBALS_FN, RESOURCES_FN } from "../../src/daemon/protection/probe.ts";
import { Daemon } from "../../src/daemon/state.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../../src/daemon/transport/types.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-plive-"));
  roots.push(d);
  return d;
};
afterAll(async () => {
  for (const r of roots.splice(0)) await removeTree(r);
});

type Page = { url: string; cookies: Array<{ name: string; value: string }>; resources: string[]; globals: Record<string, string> };
type Step = "frameTree" | "cookies" | "world" | "globals";

/** A page behind CDP: the probe's four steps answer from `page`; a step in `fail` throws as CDP does. */
function fakeBrowser() {
  const listeners = new Set<(e: CdpEvent) => void>();
  const sent: string[] = [];
  const fail = new Set<Step>();
  let page: Page = { url: "about:blank", cookies: [], resources: [], globals: {} };
  let n = 0;
  let ctx = 0;
  let loader = 0;
  const cdpError = (method: string) => new Error(`${method}: No target with given id`);
  const target = (targetId: string): AttachedTarget => ({ targetId, sessionId: `S-${targetId}`, type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const value = (v: unknown) => ({ result: { type: "object", value: v } });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      sent.push(method);
      switch (method) {
        case "Target.createTarget":
          return { targetId: `T${++n}` };
        case "Page.getFrameTree":
          if (fail.has("frameTree")) throw cdpError(method);
          return { frameTree: { frame: { id: (sessionId ?? "").replace(/^S-/, ""), loaderId: `L${loader}`, url: page.url } } };
        case "Network.getCookies":
          if (fail.has("cookies")) throw cdpError(method);
          return { cookies: page.cookies };
        case "Page.createIsolatedWorld":
          if (fail.has("world")) throw cdpError(method);
          return { executionContextId: ++ctx };
        case "Runtime.evaluate": {
          const x = String(params["expression"]);
          if (x.startsWith(`(${RESOURCES_FN})`)) return value({ resources: page.resources, frames: [] });
          if (x.startsWith(`(${DIGEST_FN})`)) return value({ els: [], total: 0, truncated: false });
          if (x.startsWith(`(${GLOBALS_FN})`)) {
            if (fail.has("globals")) throw cdpError(method);
            return value(page.globals);
          }
          return { result: { type: "undefined" } };
        }
        default:
          return {};
      }
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async (id) => target(id),
    detach: async () => undefined,
    waitAttached: async (id) => target(id),
    targets: () => [],
  };
  const fire = (e: CdpEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return {
    t,
    fail,
    /** A root-frame commit of a new document, as Chrome reports it (Tabs moves navEpoch; a recording writes its nav). */
    navigate(tab: Tab, next: Partial<Page> & { url: string }): void {
      page = { cookies: [], resources: [], globals: {}, ...next };
      loader++;
      fire({ method: "Page.frameNavigated", params: { frame: { id: tab.targetId, loaderId: `L${loader}`, url: next.url } }, sessionId: tab.sessionId });
    },
    /** The target's URL changed without a commit (Target.targetInfoChanged). */
    retitle(tab: Tab, url: string): void {
      page = { ...page, url };
      fire({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: tab.targetId, url, title: "" } }, sessionId: null });
    },
    /** Probes so far (each starts with Page.getFrameTree; the recorder never sends it). */
    probes: () => sent.filter((m) => m === "Page.getFrameTree").length,
  };
}

async function setup() {
  const root = tmp();
  const d = new Daemon(paths({ TABCAP_HOME: root }));
  const f = fakeBrowser();
  const tabs = new Tabs(f.t, false);
  const tab = await tabs.createTab("p");
  return { root, d, f, tabs, tab };
}

const DD = { name: "datadome", value: "AbCdEf0123456789" };
const pairs = (found: { detections: ReadonlyArray<{ family: string; confidence: number }> }) => found.detections.map((x) => [x.family, x.confidence]);

describe("live identification: once per navigation", () => {
  test("a family found: the answer field, the cached names, one probe", async () => {
    const { d, f, tab } = await setup();
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD] });
    const found = await liveIdentify(d, f.t, tab);
    expect(pairs(found)).toEqual([["datadome", 100]]);
    expect(found.detections[0]).toMatchObject({ name: "DataDome", category: "anti-bot", matched: [{ rule: "datadome-cookie", kind: "cookie" }] });
    expect(await protectionField(d, f.t, tab)).toEqual({ protection: [{ name: "DataDome", category: "anti-bot", confidence: 100 }] });
    expect(cachedNames(tab)).toEqual(["DataDome"]);
    expect(f.probes()).toBe(1);
  });

  test("nothing found: no answer field, no names", async () => {
    const { d, f, tab } = await setup();
    f.navigate(tab, { url: "https://plain.example/" });
    expect(await protectionField(d, f.t, tab)).toEqual({});
    expect(cachedNames(tab)).toEqual([]);
    expect(cachedNames(undefined)).toEqual([]);
  });

  test("the cache: same navigation probed once; a new navigation or a new URL is probed again, and has no cached names before that", async () => {
    const { d, f, tab } = await setup();
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD] });
    await liveIdentify(d, f.t, tab);
    await liveIdentify(d, f.t, tab);
    expect(f.probes()).toBe(1);
    f.navigate(tab, { url: "https://shop.example/" }); // the same URL again: a new document without the cookie
    expect(cachedNames(tab)).toEqual([]);
    expect(pairs(await liveIdentify(d, f.t, tab))).toEqual([]);
    expect(f.probes()).toBe(2);
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD] });
    await liveIdentify(d, f.t, tab);
    expect(cachedNames(tab)).toEqual(["DataDome"]);
    f.retitle(tab, "https://shop.example/elsewhere");
    expect(cachedNames(tab)).toEqual([]);
    expect(pairs(await liveIdentify(d, f.t, tab))).toEqual([["datadome", 100]]);
    expect(f.probes()).toBe(4);
  });

  test("a failing step leaves the others: no cookies, the global still names the family; no isolated world, the cookie still does", async () => {
    const { d, f, tab } = await setup();
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD], resources: ["https://js.datadome.co/tags.js"], globals: { ddjskey: "string" } });
    f.fail.add("cookies");
    const ev = await probeTab(f.t, tab, builtinFamilies());
    expect(ev).toEqual({ cookies: null, resources: ["https://js.datadome.co/tags.js"], frames: [], dom: { els: [], total: 0, truncated: false }, globals: { ddjskey: "string" } });
    f.fail.clear();
    // a new document, so the isolated world has to be made (and that fails)
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD], resources: ["https://js.datadome.co/tags.js"], globals: { ddjskey: "string" } });
    f.fail.add("world");
    f.fail.add("globals");
    const ev2 = await probeTab(f.t, tab, builtinFamilies());
    expect(ev2).toEqual({ cookies: [{ name: "datadome", value: "AbCdEf0123456789", request: null }], resources: null, frames: null, dom: null, globals: null });
    // through liveIdentify (a new navigation each time, so it probes)
    f.fail.clear();
    f.fail.add("cookies");
    f.fail.add("world");
    f.navigate(tab, { url: "https://shop.example/a", cookies: [DD], globals: { ddjskey: "string" } });
    expect(pairs(await liveIdentify(d, f.t, tab))).toEqual([["datadome", 75]]);
  });

  test("the whole probe failing is an empty answer, never an error, and this navigation is not probed again", async () => {
    // docs/04 §41.3 "同一次导航只探测一次" applied to a failed probe (live.ts caches the empty answer).
    const { d, f, tab } = await setup();
    f.navigate(tab, { url: "https://shop.example/", cookies: [DD] });
    f.fail.add("frameTree");
    expect(await liveIdentify(d, f.t, tab)).toEqual({ detections: [], fingerprinting: [] });
    f.fail.clear();
    expect(await protectionField(d, f.t, tab)).toEqual({});
    expect(f.probes()).toBe(1);
    f.navigate(tab, { url: "https://shop.example/next", cookies: [DD] });
    expect(pairs(await liveIdentify(d, f.t, tab))).toEqual([["datadome", 100]]);
    expect(f.probes()).toBe(2);
  });
});

describe("`protection` events in the recording", () => {
  const rec = (s: Awaited<ReturnType<typeof setup>>, name: string) =>
    Recorder.start({ session: "p", dir: join(s.root, name), t: s.f.t, tabs: s.tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" } }).then((r) => {
      s.d.recorders.set("p", r);
      return r;
    });
  const stop = async (s: Awaited<ReturnType<typeof setup>>, r: Recorder): Promise<Record<string, unknown>[]> => {
    await r.stop();
    s.d.recorders.delete("p");
    return readFileSync(join(r.dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l): unknown => JSON.parse(l))
      .filter(isRecord);
  };
  const prot = (evs: Record<string, unknown>[]) => evs.filter((e) => e["kind"] === "protection");
  const fams = (e: Record<string, unknown> | undefined) => (Array.isArray(e?.["detections"]) ? e["detections"].filter(isRecord).map((x) => [x["family"], x["confidence"]]) : null);
  /** The nav id the tab was on when `e` was written: the last nav event before it. */
  const navBefore = (evs: Record<string, unknown>[], e: Record<string, unknown> | undefined) => evs.filter((x) => x["kind"] === "nav" && Number(x["seq"]) < Number(e?.["seq"])).at(-1)?.["nav"];

  test("a page probed before net start: the recording still gets its event, once; the next recording gets its own", async () => {
    const s = await setup();
    s.f.navigate(s.tab, { url: "https://shop.example/", cookies: [DD] });
    await liveIdentify(s.d, s.f.t, s.tab); // not recording yet
    const r1 = await rec(s, "b1");
    await liveIdentify(s.d, s.f.t, s.tab);
    await liveIdentify(s.d, s.f.t, s.tab);
    const e1 = await stop(s, r1);
    expect(prot(e1).length).toBe(1);
    const p = prot(e1)[0];
    expect(p).toMatchObject({ tab: "t1", url: "https://shop.example/", actor: "system", detections: [{ family: "datadome", name: "DataDome", category: "anti-bot", confidence: 100, matched: [{ rule: "datadome-cookie" }] }] });
    expect(p?.["nav"]).toBe(navBefore(e1, p));
    expect(JSON.stringify(p)).not.toContain(DD.value);
    const r2 = await rec(s, "b2");
    await liveIdentify(s.d, s.f.t, s.tab);
    expect(prot(await stop(s, r2)).map(fams)).toEqual([[["datadome", 100]]]);
    expect(s.f.probes()).toBe(1);
  });

  test("while recording: written when the families or scores change, not when they stay; nothing found first writes nothing; a change to nothing is written", async () => {
    const s = await setup();
    s.f.navigate(s.tab, { url: "https://plain.example/" });
    const r = await rec(s, "b");
    await liveIdentify(s.d, s.f.t, s.tab);
    s.f.navigate(s.tab, { url: "https://shop.example/", cookies: [DD] });
    await liveIdentify(s.d, s.f.t, s.tab);
    s.f.navigate(s.tab, { url: "https://shop.example/2", cookies: [DD] });
    await liveIdentify(s.d, s.f.t, s.tab);
    s.f.navigate(s.tab, { url: "https://shop.example/3", globals: { ddjskey: "string" } });
    await liveIdentify(s.d, s.f.t, s.tab);
    s.f.navigate(s.tab, { url: "https://plain.example/again" });
    await liveIdentify(s.d, s.f.t, s.tab);
    const evs = await stop(s, r);
    const ps = prot(evs);
    expect(ps.map(fams)).toEqual([[["datadome", 100]], [["datadome", 75]], []]);
    expect(ps.map((e) => e["url"])).toEqual(["https://shop.example/", "https://shop.example/3", "https://plain.example/again"]);
    for (const e of ps) expect(e["nav"]).toBe(navBefore(evs, e));
  });
});

// The guard reads d.browser (a Running, whose transport is a DirectTransport): the fake browser process.
describe.skipIf(!FAKE_CHROME)("the guard's names (namesForGuard; fake browser, POSIX)", () => {
  const PAGE = "https://shop.range.test/";
  let d: Daemon;
  beforeAll(async () => {
    const root = tmp();
    const p = paths({ TABCAP_HOME: root });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    d = new Daemon(p);
    const exe = fakeChrome(root, { cookies: [DD], url: PAGE });
    const env = await handleCommand(d, { action: "browser.start", args: { executablePath: exe, proxy: "none" }, session: "g" }, () => undefined);
    if (!env.ok) throw new Error(`fake browser did not start: ${JSON.stringify(env.error)}`);
  }, SLOW_IO_MS);
  afterAll(async () => {
    await handleCommand(d, { action: "browser.stop", args: {}, session: "g" }, () => undefined);
  }, SLOW_IO_MS);

  const running = () => {
    const b = d.browser;
    if (b === null) throw new Error("the fake browser is not running");
    return b;
  };
  const probes = () => running().t.cdp.sentCounts.get("Page.getFrameTree") ?? 0;
  async function newTab(): Promise<Tab> {
    const tab = await running().tabs.createTab("g");
    tab.url = PAGE; // what the fake reports as the document (it sends no navigation events)
    return tab;
  }
  /** Hold the tab's command queue until the returned function is called. */
  function hold(tab: Tab): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    void running().tabs.run(tab, () => gate).catch(() => undefined);
    return release;
  }

  test("a tab not probed yet is probed in its turn (after the command in front of it); then the cached names answer at once, without a probe", async () => {
    const tab = await newTab();
    const before = probes();
    const release = hold(tab);
    const names = namesForGuard(d, tab.id);
    await Bun.sleep(100);
    expect(probes()).toBe(before); // still the other command's turn
    release();
    expect(await names).toEqual(["DataDome"]);
    expect(probes()).toBe(before + 1);
    expect(cachedNames(tab)).toEqual(["DataDome"]);
    // cached: answered at once, even while another command holds the tab
    const release2 = hold(tab);
    try {
      expect(await Promise.race([namesForGuard(d, tab.id), Bun.sleep(2000).then(() => "waited for the tab")])).toEqual(["DataDome"]);
    } finally {
      release2();
    }
    expect(probes()).toBe(before + 1);
  }, SLOW_IO_MS);

  test("an unknown or closed tab: no names and no probe", async () => {
    const tab = await newTab();
    running().tabs.markClosed(tab);
    const before = probes();
    expect(await namesForGuard(d, tab.id)).toEqual([]);
    expect(await namesForGuard(d, "t999")).toEqual([]);
    expect(probes()).toBe(before);
  }, SLOW_IO_MS);

  test("a probe that cannot run (the tab closed while it waited for its turn) is no names, never an error", async () => {
    const tab = await newTab();
    const before = probes();
    const release = hold(tab);
    const names = namesForGuard(d, tab.id);
    running().tabs.markClosed(tab);
    release();
    expect(await names).toEqual([]);
    expect(probes()).toBe(before);
  }, SLOW_IO_MS);

  test("no browser: no names", async () => {
    const tab = await newTab();
    const b = d.browser;
    d.browser = null;
    try {
      expect(await namesForGuard(d, tab.id)).toEqual([]);
    } finally {
      d.browser = b;
    }
  }, SLOW_IO_MS);
});
