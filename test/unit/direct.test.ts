import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickDownload } from "../../src/daemon/transport/direct/cft.ts";
import { HIDE_WEBDRIVER_FLAG, binaryIn, buildArgs, cachedChrome, parseProxy, parseWebdriver, resolveExecutable } from "../../src/daemon/transport/direct/launcher.ts";
import { ReadyTracker, originOf, toReadyInput } from "../../src/daemon/transport/direct/ready.ts";
import { readConfig } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const base = { profileDir: "/p", platform: "darwin" as const, cdp: "pipe" as const, proxy: parseProxy("system"), webdriver: "hidden" as const, extensionDir: null, noStartupWindow: true };

describe("launcher flags (docs/07 §1.2 采用 rows)", () => {
  test("pipe, keychain, quiet / no-throttle / recording groups", () => {
    const a = buildArgs(base);
    for (const f of [
      "--user-data-dir=/p",
      "--remote-debugging-pipe",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-popup-blocking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-networking",
      "--disable-component-update",
      "--enable-features=CDPScreenshotNewSurface",
      "--disable-back-forward-cache",
      "--no-startup-window",
    ]) {
      expect(a).toContain(f);
    }
    expect(a).not.toContain("--enable-automation");
    expect(a).not.toContain("--disable-extensions");
    expect(a).not.toContain("about:blank");
    expect(a.some((x) => x.startsWith("--proxy-server"))).toBe(false);
  });

  test("one merged --disable-features switch", () => {
    const df = buildArgs(base).filter((x) => x.startsWith("--disable-features="));
    expect(df).toHaveLength(1);
    expect(df[0]).toContain("Translate");
    expect(df[0]).toContain("PaintHolding");
    expect(df[0]).toContain("DestroyProfileOnBrowserClose");
  });

  test("port fallback, linux password store, startup window, extension", () => {
    const a = buildArgs({ ...base, cdp: "port", platform: "linux", noStartupWindow: false, extensionDir: "/ext" });
    expect(a).toContain("--remote-debugging-port=0");
    expect(a).not.toContain("--remote-debugging-pipe");
    expect(a).toContain("--password-store=basic");
    expect(a).not.toContain("--use-mock-keychain");
    expect(a).toContain("--load-extension=/ext");
    expect(a[a.length - 1]).toBe("about:blank");
  });

  test("proxy modes", () => {
    expect(buildArgs({ ...base, proxy: parseProxy("none") })).toEqual(expect.arrayContaining(["--proxy-server=127.0.0.1:1", "--proxy-bypass-list=127.0.0.1;localhost"]));
    expect(buildArgs({ ...base, proxy: parseProxy("http://127.0.0.1:8888") })).toEqual(expect.arrayContaining(["--proxy-server=http://127.0.0.1:8888", "--proxy-bypass-list=<-loopback>"]));
    expect(buildArgs({ ...base, proxy: parseProxy("system") }).some((x) => x.startsWith("--proxy-"))).toBe(false);
    expect(parseProxy(undefined)).toEqual({ kind: "system" });
    expect(() => parseProxy("not a proxy")).toThrow(TabcapError);
  });

  test("webdriver: hidden by default on both CDP channels, visible passes no switch (docs/04 §40)", () => {
    expect(HIDE_WEBDRIVER_FLAG).toBe("--disable-blink-features=AutomationControlled");
    expect(buildArgs(base)).toContain(HIDE_WEBDRIVER_FLAG);
    expect(buildArgs({ ...base, cdp: "port" })).toContain(HIDE_WEBDRIVER_FLAG);
    const v = buildArgs({ ...base, webdriver: "visible" });
    expect(v.some((x) => x.startsWith("--disable-blink-features"))).toBe(false);
    expect(parseWebdriver(undefined)).toBe("hidden");
    expect(parseWebdriver(null)).toBe("hidden");
    expect(parseWebdriver("")).toBe("hidden");
    expect(parseWebdriver("hidden")).toBe("hidden");
    expect(parseWebdriver("visible")).toBe("visible");
    expect(() => parseWebdriver("sometimes")).toThrow(TabcapError);
    expect(() => parseWebdriver("Hidden")).toThrow(TabcapError);
    const dir = mkdtempSync(join(tmpdir(), "tabcap-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ webdriver: "visible" }));
    expect(readConfig(file).webdriver).toBe("visible");
    writeFileSync(file, JSON.stringify({ webdriver: 3 }));
    expect(readConfig(file).webdriver).toBeNull();
    writeFileSync(file, "{}");
    expect(parseWebdriver(readConfig(file).webdriver)).toBe("hidden");
  });

  test("executable resolution: flag > env > config > cache; missing paths are errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-exe-"));
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeFileSync(a, "");
    writeFileSync(b, "");
    expect(resolveExecutable({ flag: a, env: b, config: null, chromeCache: dir })).toEqual({ path: a, source: "flag" });
    expect(resolveExecutable({ flag: null, env: b, config: a, chromeCache: dir })).toEqual({ path: b, source: "env" });
    expect(() => resolveExecutable({ flag: join(dir, "nope"), env: null, config: null, chromeCache: dir })).toThrow(TabcapError);
    expect(() => resolveExecutable({ flag: null, env: null, config: null, chromeCache: join(dir, "empty") })).toThrow("no Chrome for Testing found");
  });

  test("cached Chrome for Testing: newest version wins", () => {
    const cache = mkdtempSync(join(tmpdir(), "tabcap-cache-"));
    for (const v of ["9.0.1.2", "155.0.8059.79", "155.0.10.1"]) {
      const bin = binaryIn(join(cache, v), "mac-arm64");
      mkdirSync(join(bin, ".."), { recursive: true });
      writeFileSync(bin, "");
    }
    expect(cachedChrome(cache, "mac-arm64")).toBe(binaryIn(join(cache, "155.0.8059.79"), "mac-arm64"));
    expect(cachedChrome(cache, "linux64")).toBeNull();
  });
});

describe("setup: Chrome for Testing JSON API", () => {
  const doc = {
    channels: {
      Stable: {
        channel: "Stable",
        version: "155.0.8059.79",
        downloads: {
          chrome: [
            { platform: "linux64", url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/linux64/chrome-linux64.zip" },
            { platform: "mac-arm64", url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/mac-arm64/chrome-mac-arm64.zip" },
          ],
        },
      },
    },
  };
  test("picks the platform's Stable chrome zip", () => {
    expect(pickDownload(doc, "mac-arm64")).toEqual({ version: "155.0.8059.79", url: doc.channels.Stable.downloads.chrome[1]?.url ?? "" });
  });
  test("refuses other hosts, missing platforms, malformed docs", () => {
    const evil = structuredClone(doc);
    const first = evil.channels.Stable.downloads.chrome[0];
    if (first !== undefined) first.url = "https://example.com/chrome.zip";
    expect(() => pickDownload(evil, "linux64")).toThrow("refusing");
    expect(() => pickDownload(doc, "mac-x64")).toThrow("no chrome download");
    expect(() => pickDownload({}, "mac-arm64")).toThrow(TabcapError);
  });
});

describe("readiness state machine (docs/07 §1.1)", () => {
  const ROOT = "FRAME1";
  test("default context with matching origin on the root frame = ready", () => {
    const r = new ReadyTracker(ROOT, "http://127.0.0.1:9/a");
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "http://127.0.0.1:9", isDefault: false })).toBe(false);
    expect(r.feed({ kind: "context", frameId: "CHILD", origin: "http://127.0.0.1:9", isDefault: true })).toBe(false);
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "http://127.0.0.1:9", isDefault: true })).toBe(true);
  });
  test("redirect to another origin: accepted after the root commit of our loader", () => {
    const r = new ReadyTracker(ROOT, "http://a.test/x");
    r.setLoaderId("L1");
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "http://b.test", isDefault: true })).toBe(false);
    expect(r.feed({ kind: "committed", frameId: ROOT, parentId: null, loaderId: "OTHER", url: "http://b.test/" })).toBe(false);
    r.feed({ kind: "committed", frameId: ROOT, parentId: null, loaderId: "L1", url: "http://b.test/" });
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "http://b.test", isDefault: true })).toBe(true);
  });
  test("opaque origins only after a commit; same-document is immediately ready", () => {
    const r = new ReadyTracker(ROOT, "about:blank");
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "", isDefault: true })).toBe(false);
    r.feed({ kind: "committed", frameId: ROOT, parentId: null, loaderId: null, url: "about:blank" });
    expect(r.feed({ kind: "context", frameId: ROOT, origin: "://", isDefault: true })).toBe(true);
    const s = new ReadyTracker(ROOT, "http://a.test/#x");
    expect(s.feed({ kind: "same-document", frameId: ROOT, url: "http://a.test/#x" })).toBe(true);
  });
  test("CDP event translation tolerates junk", () => {
    expect(toReadyInput({ method: "Runtime.executionContextCreated", params: { context: { origin: "http://x", auxData: { isDefault: true, frameId: "F" } } }, sessionId: "s" })).toEqual({ kind: "context", frameId: "F", origin: "http://x", isDefault: true });
    expect(toReadyInput({ method: "Runtime.executionContextCreated", params: { context: 5 }, sessionId: "s" })).toBeNull();
    expect(toReadyInput({ method: "Page.frameNavigated", params: {}, sessionId: "s" })).toBeNull();
    expect(originOf("data:text/html,x")).toBeNull();
  });
});
