// 0.3-C: `state` cookie snapshots (docs/04 §4.1: P1 cookies at session start /
// stop and every root `navigation` nav; content = CDP Network.getCookies array)
// and the store's saved sessions (docs/04 §8.1). Oracle: the cookie arrays the
// fake CDP answered with (blobs must hold them byte-for-byte as JSON), and the
// spec's field list. Real-browser coverage: test/e2e/v03c.e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { cookieArray, navCookieParams, navWantsCookies, siteCookieUrls, stateOrigin } from "../../src/daemon/capture/cookies.ts";
import { Recorder } from "../../src/daemon/capture/recorder.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { COOKIE_SECRET_MIN, Store } from "../../src/daemon/store/db.ts";
import { saveSiteCookies } from "../../src/daemon/tools/session.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { isRecord } from "../../src/shared/json.ts";
import { exportSession } from "../../src/replay/session.ts";
import { until } from "./_platform.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const SID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const cookie = (name: string, value: string, extra: Record<string, unknown> = {}) => ({ name, value, domain: "127.0.0.1", path: "/", expires: -1, size: name.length + value.length, httpOnly: false, secure: false, session: true, priority: "Medium", sameParty: false, sourceScheme: "NonSecure", sourcePort: 4310, ...extra });

describe("cookie snapshot helpers (pure)", () => {
  test("cookieArray keeps CDP cookie objects as they are and drops malformed entries", () => {
    const good = cookie("sid", SID, { httpOnly: true, partitionKey: { topLevelSite: "http://127.0.0.1", hasCrossSiteAncestor: false } });
    expect(cookieArray({ cookies: [good, null, { name: "x" }, "y", { name: "a", value: 1, domain: "d" }] })).toEqual([good]);
    expect(cookieArray({ cookies: "nope" })).toEqual([]);
    expect(cookieArray(null)).toEqual([]);
  });

  test("state.origin is the http(s) origin of the tab, else null", () => {
    expect(stateOrigin("http://127.0.0.1:4310/s07/login?x=1#h")).toBe("http://127.0.0.1:4310");
    expect(stateOrigin("https://shop.test/")).toBe("https://shop.test");
    for (const u of ["about:blank", "data:text/html,x", "chrome://version", "not a url"]) expect(stateOrigin(u)).toBeNull();
  });

  test("only root `navigation` navs (not the initial one, not history / reload / back_forward) take a snapshot", () => {
    expect(navWantsCookies("navigation", false)).toBe(true);
    expect(navWantsCookies("navigation", true)).toBe(false);
    for (const t of ["history", "reload", "back_forward"] as const) expect(navWantsCookies(t, false)).toBe(false);
  });

  test("site cookie URLs: entry URL, stored domains over http and https, tabs on those hosts only", () => {
    expect(siteCookieUrls("http://127.0.0.1:4310/s07/login", ["127.0.0.1", ".api.shop.test", "bad host/"], ["http://127.0.0.1:4310/s07/data", "https://www.api.shop.test/x", "https://other.test/", "about:blank"])).toEqual([
      "http://127.0.0.1:4310/s07/login",
      "https://api.shop.test/",
      "http://api.shop.test/",
      "http://127.0.0.1:4310/s07/data",
      "https://www.api.shop.test/x",
    ]);
  });
});

/** One page tab; Network.getCookies answers with whatever `jar` holds at that moment. */
function fakeBrowser(jar: { cookies: unknown[] }) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const sent: Array<{ method: string; params: CdpParams; sessionId: string | null }> = [];
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId = null) => {
      sent.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "T1" };
      if (method === "Network.getCookies") return { cookies: structuredClone(jar.cookies) };
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
  const commit = (url: string, loaderId: string) => emit("Page.frameNavigated", { frame: { id: "T1", loaderId, url } });
  return { t, emit, commit, sent };
}

describe("recorder: state cookie events (docs/04 §4.1)", () => {
  test("session start, each root navigation, session stop; history / reload navs take none; blobs hold the CDP arrays", async () => {
    const jar: { cookies: unknown[] } = { cookies: [] };
    const { t, emit, commit } = fakeBrowser(jar);
    const tabs = new Tabs(t, false);
    const tab = await tabs.createTab("s07");
    commit("http://127.0.0.1:4310/s07/login", "L1"); // the page was open before recording
    const dir = join(tmp("tabcap-state-"), "b");
    const rec = await Recorder.start({ session: "s07", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    jar.cookies = [cookie("sid", SID, { httpOnly: true })];
    commit("http://127.0.0.1:4310/s07/data", "L2");
    emit("Page.navigatedWithinDocument", { frameId: "T1", url: "http://127.0.0.1:4310/s07/data#tab2" });
    tab.pendingNavType = "reload";
    commit("http://127.0.0.1:4310/s07/data", "L3");
    jar.cookies = [cookie("sid", SID, { httpOnly: true }), cookie("theme", "dark")];
    await Bun.sleep(20);
    // the snapshot's blob write can lag on a slow Windows runner (state 1 at 20 ms there)
    await until(() => {
      const counts = rec.status()["counts"];
      return isRecord(counts) && typeof counts["state"] === "number" && counts["state"] >= 2;
    });
    expect(rec.status()).toMatchObject({ counts: { state: 2 } });
    const done = await rec.stop();
    const reader = BundleReader.open(dir);
    const states = reader.events.filter((e) => e.kind === "state");
    expect(states.map((e) => [e["reason"], e["what"], e["origin"], e["count"], e.actor, e.tab])).toEqual([
      ["session-start", "cookies", "http://127.0.0.1:4310", 0, "system", "t1"],
      ["nav", "cookies", "http://127.0.0.1:4310", 1, "system", "t1"],
      ["session-stop", "cookies", "http://127.0.0.1:4310", 2, "system", "t1"],
    ]);
    // the nav snapshot follows its nav event; stop's comes before the session stop event
    const seqOf = (k: string, f: (e: Record<string, unknown>) => boolean) => reader.events.find((e) => e.kind === k && f(e))?.seq ?? -1;
    expect(seqOf("state", (e) => e["reason"] === "nav")).toBeGreaterThan(seqOf("nav", (e) => e["url"] === "http://127.0.0.1:4310/s07/data"));
    expect(seqOf("state", (e) => e["reason"] === "session-stop")).toBeLessThan(seqOf("session", (e) => e["phase"] === "stop"));
    // blob = the CDP array as JSON
    const blob = (e: Record<string, unknown>) => {
      const b = reader.readBlob(typeof e["blob"] === "string" ? e["blob"] : "");
      return b === null ? null : JSON.parse(new TextDecoder().decode(b));
    };
    expect(blob(states[2] ?? {})).toEqual(jar.cookies);
    // manifest counts cover the new events and blobs
    const m: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const counts = isRecord(m) && isRecord(m["counts"]) ? m["counts"] : {};
    expect(counts["events"]).toBe(reader.events.length);
    expect(Number(counts["blobBytes"])).toBeGreaterThan(0);
    expect(done.counts).toMatchObject({ events: reader.events.length });
    // replay session reads the last snapshot of the real recording shape
    const out = join(tmp("tabcap-state-out-"), "s.json");
    const r = exportSession({ bundle: dir, out, configDir: join(dir, "unused") });
    expect(r).toMatchObject({ cookies: 2, source: { kind: "bundle" } });
    expect(JSON.parse(readFileSync(out, "utf8"))["cookies"].map((c: { name: string }) => c.name)).toEqual(["sid", "theme"]);
  });

  test("the nav snapshot asks for the committed URL; start / stop ask without urls", async () => {
    expect(navCookieParams("http://127.0.0.1:4310/s07/login?again=1")).toEqual({ urls: ["http://127.0.0.1:4310/s07/login?again=1"] });
    expect(navCookieParams("about:blank")).toEqual({});
    expect(navCookieParams("data:text/html,x")).toEqual({});
    // Linux, Chromium 155: at Page.frameNavigated the no-urls call can still answer
    // for a frame tree without the committed URL ([]), while the jar holds the cookie.
    const jar: { cookies: unknown[] } = { cookies: [] };
    const { t, commit, sent } = fakeBrowser(jar);
    const send = t.send;
    t.send = async (method, params = {}, sid, ms) => (method === "Network.getCookies" && params["urls"] === undefined && jar.cookies.length > 0 && racing ? { cookies: [] } : send(method, params, sid, ms));
    let racing = false;
    const tabs = new Tabs(t, false);
    await tabs.createTab("x");
    commit("http://127.0.0.1:4310/s07/login", "L1");
    const dir = join(tmp("tabcap-state-race-"), "b");
    const rec = await Recorder.start({ session: "x", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    jar.cookies = [cookie("sid", SID, { httpOnly: true })];
    racing = true;
    commit("http://127.0.0.1:4310/s07/login?again=1", "L2");
    await Bun.sleep(20);
    racing = false;
    await rec.stop();
    const states = BundleReader.open(dir).events.filter((e) => e.kind === "state");
    expect(states.map((e) => [e["reason"], e["count"]])).toEqual([
      ["session-start", 0],
      ["nav", 1],
      ["session-stop", 1],
    ]);
    expect(sent.filter((c) => c.method === "Network.getCookies").map((c) => c.params)).toEqual([{}, { urls: ["http://127.0.0.1:4310/s07/login?again=1"] }, {}]);
  });

  test("a failing Network.getCookies writes no state event and does not break the recording", async () => {
    const { t, commit } = fakeBrowser({ cookies: [] });
    const send = t.send;
    t.send = async (method, params, sid, ms) => (method === "Network.getCookies" ? Promise.reject(new Error("No target with given id")) : send(method, params, sid, ms));
    const tabs = new Tabs(t, false);
    await tabs.createTab("x");
    commit("http://127.0.0.1:4310/", "L1");
    const dir = join(tmp("tabcap-state-err-"), "b");
    const rec = await Recorder.start({ session: "x", dir, t, tabs, browser: { version: "Chrome/155", userAgent: "UA" } });
    commit("http://127.0.0.1:4310/two", "L2");
    await rec.stop();
    const reader = BundleReader.open(dir);
    expect(reader.events.filter((e) => e.kind === "state")).toEqual([]);
    expect(reader.isComplete()).toBe(true);
  });
});

describe("store sessions (docs/04 §8.1): written by the daemon, secret in every output", () => {
  test("saveSiteCookies asks for the site's URLs, saves the row, returns counts only; the values become secrets", async () => {
    const cfg = join(tmp("tabcap-store-s-"), "config");
    const store = Store.open(cfg);
    store.addSite({ name: "range-demo", entryUrl: "http://127.0.0.1:4310/s07/login", domains: ["127.0.0.1"], username: "demo-user", password: "E2e-pa55 w&rd" });
    const jar = { cookies: [cookie("sid", SID, { httpOnly: true }), cookie("lang", "en"), cookie("odd name", "value-with-length-16")] };
    const { t, sent } = fakeBrowser(jar);
    const saved = await saveSiteCookies(store, t, { site: "range-demo", account: "demo-user" }, [{ sessionId: "S9", url: "http://127.0.0.1:4310/s07/data" }, { sessionId: "S8", url: "https://elsewhere.test/" }], 1760700000000);
    expect(saved).toEqual({ site: "range-demo", account: "demo-user", cookies: 3, savedAt: 1760700000000 });
    expect(JSON.stringify(saved)).not.toContain(SID);
    expect(sent.at(-1)).toEqual({ method: "Network.getCookies", params: { urls: ["http://127.0.0.1:4310/s07/login", "http://127.0.0.1:4310/s07/data"] }, sessionId: "S9" });
    expect(store.savedSession("range-demo")).toMatchObject({ username: "demo-user", savedAt: 1760700000000, cookies: jar.cookies });
    // cookie values are known secrets (short ones excepted), refs stay in the placeholder alphabet
    expect(COOKIE_SECRET_MIN).toBe(8);
    const known = store.knownSecrets();
    expect(known).toEqual([
      { ref: "range-demo.password", value: "E2e-pa55 w&rd" },
      { ref: "range-demo.cookie.sid", value: SID },
      { ref: "range-demo.cookie", value: "value-with-length-16" },
    ]);
    const secrets = new Secrets();
    secrets.setStored(known);
    expect(secrets.scrub(`cookie: sid=${SID}; lang=en`)).toBe("cookie: sid=<secret:range-demo.cookie.sid>; lang=en");
    // listings never carry them; removing the site removes the session
    expect(JSON.stringify(store.listSites())).not.toContain(SID);
    expect(store.removeSite("range-demo")).toBe(true);
    expect(store.knownSecrets()).toEqual([]);
    store.close();
  });

  test("no tab, or a site that is gone: nothing saved", async () => {
    const cfg = join(tmp("tabcap-store-s2-"), "config");
    const store = Store.open(cfg);
    store.addSite({ name: "s", entryUrl: "http://127.0.0.1:1/", domains: [], username: "u", password: "pw-123456" });
    const { t } = fakeBrowser({ cookies: [cookie("sid", SID)] });
    expect(await saveSiteCookies(store, t, { site: "s", account: "u" }, [])).toBeNull();
    expect(await saveSiteCookies(store, t, { site: "gone", account: "u" }, [{ sessionId: "S1", url: "http://127.0.0.1:1/" }])).toBeNull();
    expect(store.savedSession("s")).toBeNull();
    store.close();
  });

  test("replay session --site without a bundle reads the saved row; neither bundle nor site is a usage error", async () => {
    const cfg = join(tmp("tabcap-store-s3-"), "config");
    const store = Store.open(cfg);
    store.addSite({ name: "s", entryUrl: "http://127.0.0.1:1/", domains: [], username: "u", password: "pw-123456" });
    store.saveSession("s", "u", [cookie("sid", SID, { httpOnly: true })]);
    store.close();
    const out = join(cfg, "..", "state.json");
    const r = exportSession({ bundle: null, out, site: "s", configDir: cfg });
    expect(r).toMatchObject({ source: { kind: "store", site: "s", account: "u" }, cookies: 1, mode: "0600" });
    expect(JSON.stringify(r)).not.toContain(SID);
    expect(() => exportSession({ bundle: null, out, configDir: cfg })).toThrow(/give a bundle/);
  });
});
