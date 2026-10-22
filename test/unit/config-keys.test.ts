// Review wave 3 (owner 2026-10-21, docs/04 §44): config.json has one key
// table, CONFIG_KEYS (src/shared/config.ts). A key the table does not list at
// its level (a case slip, a typo, the right key at the wrong level) is neither
// an error nor a reason to drop the rest of the level: it is a warning,
// `config.json: unknown key <path> (did you mean <key>?)`, shown by `browser
// start` / `browser status` (`warnings`), `tabcap status` (`config.warnings`)
// and `tabcap setup` (`warnings`). The replay rules subtrees keep refusing
// unknown keys themselves (docs/04 §31). Expected texts: the owner's example
// in the decision ("sites.x.guard.stopon (did you mean stopOn?)").
// Owner 2026-10-22: a known key whose reader reads a value of the wrong JSON
// type as absent (`kind` in the table: chrome, proxy, webdriver,
// chrome.executablePath / version / platform) is still read as absent, and is
// named after the unknown keys as `config.json: <path> is <type>, not <kind>;
// ignored` (the owner's message shape), within the same 20-line cap. `tabcap
// setup` keeps a proxy / webdriver of the wrong type in the file it rewrites,
// so its answer names them too (review of that package).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/main.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { offlineStatus, renderStatusText, statusOf } from "../../src/daemon/tools/status.ts";
import { rulesFromConfig } from "../../src/replay/rules.ts";
import {
  CONFIG_KEYS,
  type ConfigKeyInfo,
  configWarnings,
  readChromeArgsConfig,
  readConfig,
  readConfigRaw,
  readConfigWarnings,
  readFetchConfig,
  readHandoffConfig,
  readPoolConfig,
  readProtectionConfig,
  readRecordBodies,
  readSiteGuards,
  readTraceConfig,
  writeConfig,
} from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-cfgkeys-"));
  roots.push(d);
  return d;
};
afterAll(async () => {
  for (const r of roots.splice(0)) await removeTree(r);
}, SLOW_IO_MS);

/** Every key of the table, each with a valid value. */
const FULL = {
  chrome: { executablePath: "/cft/chrome", version: "155.0.7000.0", platform: "mac-arm64", args: ["--lang=en-US"], dropArgs: ["--disable-sync"] },
  proxy: "none",
  webdriver: "visible",
  pool: { strategy: "lru", egress: { mode: "rotate", rotateOn: "every:10requests" }, health: { url: "http://127.0.0.1:9/h", intervalS: 60 }, budget: { requestsPerHour: 100 } },
  fetch: { minIntervalMs: 1000, concurrency: 2, stopOn: ["status>=500"] },
  sites: {
    x: {
      fetch: { minIntervalMs: 5000, concurrency: 1, stopOn: ["empty-body"] },
      guard: { stopOn: ["status>=403"], consecutiveNon200: 5, endOn: ["json:$.code=203"] },
      replay: { schema: "tabcap-replay-rules/0", rules: [{ match: { path: "/api/*" } }] },
    },
  },
  record: { bodies: "api" },
  trace: { decode: true, weakRows: false },
  handoff: { detectTakeover: false },
  protection: { live: false },
  replay: { rules: [] },
};

describe("CONFIG_KEYS: the one key table", () => {
  test("every level and key has a type, a default, a sentence and a docs/04 section (or none)", () => {
    let keys = 0;
    for (const [layer, entries] of Object.entries(CONFIG_KEYS)) {
      for (const [key, info] of Object.entries(entries)) {
        keys++;
        expect(`${layer}.${key}: ${info.type}`).not.toEndWith(": ");
        expect(info.default).not.toBe("");
        expect(info.about.length).toBeGreaterThan(10);
        if (info.doc !== null) expect(info.doc).toMatch(/^§\d+(\.\d+)?$/);
      }
    }
    expect(Object.keys(CONFIG_KEYS)).toHaveLength(16);
    expect(keys).toBe(46);
  });

  test("a config.json with every key: no warnings, and every reader takes it", () => {
    const f = join(tmp(), "config.json");
    writeFileSync(f, JSON.stringify(FULL));
    expect(readConfigWarnings(f)).toEqual([]);
    expect(readConfig(f)).toEqual({ chrome: { executablePath: "/cft/chrome", version: "155.0.7000.0", platform: "mac-arm64" }, proxy: "none", webdriver: "visible" });
    expect(readChromeArgsConfig(f)).toEqual({ add: ["--lang=en-US"], drop: ["--disable-sync"] });
    expect(readPoolConfig(f)).toEqual({ strategy: "lru", egress: { mode: "rotate", rotateOn: "every:10requests" }, health: { url: "http://127.0.0.1:9/h", intervalS: 60 }, budget: { requestsPerHour: 100 } });
    expect(readFetchConfig(f, null)).toEqual({ minIntervalMs: 1000, concurrency: 2, stopOn: ["status>=500"] });
    expect(readFetchConfig(f, "x")).toEqual({ minIntervalMs: 5000, concurrency: 1, stopOn: ["empty-body"] });
    expect(readSiteGuards(f).get("x")).toEqual({ stopOn: ["status>=403"], consecutiveNon200: 5, endOn: ["json:$.code=203"] });
    expect(readRecordBodies(f)).toBe("api");
    expect(readTraceConfig(f)).toEqual({ decode: true, weakRows: false });
    expect(readHandoffConfig(f)).toEqual({ detectTakeover: false });
    expect(readProtectionConfig(f)).toEqual({ live: false });
    expect(rulesFromConfig(f, "x").rules).toHaveLength(1);
  });
});

describe("unknown keys are warnings (docs/04 §44)", () => {
  test("the review's example: a case slip under sites.<s>.guard and under fetch; nothing else changes", () => {
    const raw = { sites: { x: { guard: { stopon: ["status>=400"] } } }, fetch: { minIntervalMS: 100 } };
    expect(configWarnings(raw)).toEqual([
      "config.json: unknown key sites.x.guard.stopon (did you mean stopOn?)",
      "config.json: unknown key fetch.minIntervalMS (did you mean minIntervalMs?)",
    ]);
    const f = join(tmp(), "config.json");
    writeFileSync(f, JSON.stringify(raw));
    // Not an error, and the level's known keys are read as before.
    expect(readFetchConfig(f, "x").minIntervalMs).toBe(3000);
    expect(readSiteGuards(f).size).toBe(0);
  });

  test("typos get the nearest key of their level; a key of another level says where it is known", () => {
    expect(configWarnings({ fecth: {}, pool: { egres: {}, budget: { requestPerHour: 5 } }, trace: { weak_rows: true } })).toEqual([
      "config.json: unknown key fecth (did you mean fetch?)",
      "config.json: unknown key pool.egres (did you mean egress?)",
      "config.json: unknown key pool.budget.requestPerHour (did you mean requestsPerHour?)",
      "config.json: unknown key trace.weak_rows (did you mean weakRows?)",
    ]);
    expect(configWarnings({ sites: { x: { stopOn: [] } }, minIntervalMs: 1, guard: {} })).toEqual([
      "config.json: unknown key sites.x.stopOn (known under fetch, sites.<site>.fetch, sites.<site>.guard)",
      "config.json: unknown key minIntervalMs (known under fetch, sites.<site>.fetch)",
      "config.json: unknown key guard (known under sites.<site>)",
    ]);
    expect(configWarnings({ zzz: 1, chrome: { flags: [] } })).toEqual(["config.json: unknown key zzz", "config.json: unknown key chrome.flags"]);
  });

  test("the replay subtrees are left to the replay rules parser, which refuses unknown keys", () => {
    const raw = { replay: { rules: [], bogus: 1 }, sites: { x: { replay: { rules: [], extra: true } } } };
    expect(configWarnings(raw)).toEqual([]);
    const f = join(tmp(), "config.json");
    writeFileSync(f, JSON.stringify(raw));
    expect(() => rulesFromConfig(f, "x")).toThrow(TabcapError);
  });

  test("a level that is not an object is its reader's error, not a warning; odd key names are quoted; the list is capped", () => {
    expect(configWarnings({ pool: 3, sites: { x: 5, y: null }, trace: [] })).toEqual([]);
    expect(configWarnings({ "a\nb": 1 })).toEqual(['config.json: unknown key "a\\nb"']);
    const many: Record<string, number> = {};
    for (let i = 0; i < 30; i++) many[`k${i}`] = i;
    const w = configWarnings(many);
    expect(w).toHaveLength(21);
    expect(w[20]).toBe("config.json: 10 more unknown keys not listed");
  });
});

describe("known keys of the wrong JSON type are warnings (owner 2026-10-22)", () => {
  const file = (raw: unknown): string => {
    const f = join(tmp(), "config.json");
    writeFileSync(f, JSON.stringify(raw));
    return f;
  };

  test("only the keys whose reader reads a wrong type as absent carry a kind", () => {
    const kinds: Record<string, string> = {};
    for (const [layer, entries] of Object.entries(CONFIG_KEYS)) {
      for (const [key, k] of Object.entries(entries)) {
        const info: ConfigKeyInfo = k;
        if (info.kind !== undefined) kinds[layer === "" ? key : `${layer}.${key}`] = info.kind;
      }
    }
    expect(kinds).toEqual({ chrome: "object", proxy: "string", webdriver: "string", "chrome.executablePath": "string", "chrome.version": "string", "chrome.platform": "string" });
    // null is taken silently only where tabcap writes it itself: setup's proxy / webdriver, platform for --executable-path.
    const nullable = Object.entries(CONFIG_KEYS).flatMap(([layer, entries]) =>
      Object.entries(entries).flatMap(([key, k]) => {
        const info: ConfigKeyInfo = k;
        return info.nullable === true ? [layer === "" ? key : `${layer}.${key}`] : [];
      }),
    );
    expect(nullable).toEqual(["proxy", "webdriver", "chrome.platform"]);
  });

  test("each such key: one line naming the type it has and the one it needs; the value is still read as absent", () => {
    const raw = { proxy: 8080, webdriver: true, chrome: { executablePath: ["/cft/chrome"], version: 155, platform: {}, args: ["--lang=en-US"] } };
    expect(configWarnings(raw)).toEqual([
      "config.json: proxy is a number, not a string; ignored",
      "config.json: webdriver is a boolean, not a string; ignored",
      "config.json: chrome.executablePath is an array, not a string; ignored",
      "config.json: chrome.version is a number, not a string; ignored",
      "config.json: chrome.platform is an object, not a string; ignored",
    ]);
    const f = file(raw);
    expect(readConfig(f)).toEqual({ chrome: null, proxy: null, webdriver: null });
    expect(readChromeArgsConfig(f)).toEqual({ add: ["--lang=en-US"], drop: [] });
    // A wrong version / platform next to a good executablePath: only those two read as absent.
    const g = file({ chrome: { executablePath: "/cft/chrome", version: 155, platform: false } });
    expect(readConfigWarnings(g)).toEqual(["config.json: chrome.version is a number, not a string; ignored", "config.json: chrome.platform is a boolean, not a string; ignored"]);
    expect(readConfig(g).chrome).toEqual({ executablePath: "/cft/chrome", version: null, platform: null });
  });

  test("chrome that is not an object: one line, nothing under it is looked at, and its switches are none", () => {
    expect(configWarnings({ chrome: "/cft/chrome" })).toEqual(["config.json: chrome is a string, not an object; ignored"]);
    expect(configWarnings({ chrome: [{ executablePath: 1 }] })).toEqual(["config.json: chrome is an array, not an object; ignored"]);
    const f = file({ chrome: ["--lang=en-US"] });
    expect(readConfig(f).chrome).toBeNull();
    expect(readChromeArgsConfig(f)).toEqual({ add: [], drop: [] });
  });

  test("null reads as absent; it is named only where tabcap never writes it (chrome, chrome.executablePath, chrome.version)", () => {
    expect(configWarnings({ proxy: null, webdriver: null, chrome: { executablePath: "/cft/chrome", version: "155", platform: null } })).toEqual([]);
    expect(configWarnings({ chrome: null, proxy: null })).toEqual(["config.json: chrome is null, not an object; ignored"]);
    expect(configWarnings({ chrome: { executablePath: null, version: null, platform: null } })).toEqual([
      "config.json: chrome.executablePath is null, not a string; ignored",
      "config.json: chrome.version is null, not a string; ignored",
    ]);
    const f = file({ chrome: { executablePath: "/cft/chrome", version: null } });
    expect(readConfig(f).chrome).toEqual({ executablePath: "/cft/chrome", version: null, platform: null });
    expect(readConfigWarnings(f)).toEqual(["config.json: chrome.version is null, not a string; ignored"]);
    expect(readConfig(file({ chrome: null })).chrome).toBeNull();
  });

  test("keys whose reader refuses a wrong value stay that reader's bad-input, not a warning", () => {
    const raw = { pool: { strategy: 1 }, fetch: { minIntervalMs: "1" }, record: { bodies: 5 }, trace: { decode: "yes" }, handoff: { detectTakeover: 1 }, protection: { live: "no" }, chrome: { args: "--x" } };
    expect(configWarnings(raw)).toEqual([]);
    const f = file(raw);
    for (const read of [readPoolConfig, (x: string) => readFetchConfig(x, null), readRecordBodies, readTraceConfig, readHandoffConfig, readProtectionConfig, readChromeArgsConfig]) {
      expect(() => read(f)).toThrow(TabcapError);
    }
  });

  test("writeConfig (tabcap setup) keeps a proxy / webdriver of the wrong type; absent or null ones are written null as before", () => {
    const CFT = { executablePath: "/cft", version: "155", platform: null };
    const f = file({ webdriver: true, proxy: 8080, chrome: "x", pool: { strategy: "lru" } });
    writeConfig(f, { ...readConfig(f), chrome: CFT });
    expect(readConfigRaw(f)).toEqual({ webdriver: true, proxy: 8080, chrome: CFT, pool: { strategy: "lru" } });
    expect(readConfigWarnings(f)).toEqual(["config.json: webdriver is a boolean, not a string; ignored", "config.json: proxy is a number, not a string; ignored"]);
    const g = file({ proxy: null });
    writeConfig(g, { ...readConfig(g), chrome: CFT });
    expect(readConfigRaw(g)).toEqual({ proxy: null, chrome: CFT, webdriver: null });
    // A value the caller sets is written over whatever the file had.
    const h = file({ proxy: ["socks5://127.0.0.1:1080"], webdriver: "visible" });
    writeConfig(h, { chrome: CFT, proxy: "none", webdriver: null });
    expect(readConfigRaw(h)).toEqual({ proxy: "none", webdriver: null, chrome: CFT });
  });

  test("after the unknown keys, in file order", () => {
    expect(configWarnings({ webdriver: 1, zzz: 1, chrome: { platform: 2, flags: [] }, proxy: false })).toEqual([
      "config.json: unknown key zzz",
      "config.json: unknown key chrome.flags",
      "config.json: webdriver is a number, not a string; ignored",
      "config.json: chrome.platform is a number, not a string; ignored",
      "config.json: proxy is a boolean, not a string; ignored",
    ]);
  });

  test("the same 20-line cap; the last line counts what is left of each kind", () => {
    const unknown = (n: number): Record<string, number> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    const fiveWrong = { proxy: 1, webdriver: 2, chrome: { executablePath: 3, version: 4, platform: 5 } };
    // 18 unknown + 5 wrong: the first two wrong-type lines fit.
    const a = configWarnings({ ...unknown(18), ...fiveWrong });
    expect(a).toHaveLength(21);
    expect(a.slice(18, 20)).toEqual(["config.json: proxy is a number, not a string; ignored", "config.json: webdriver is a number, not a string; ignored"]);
    expect(a[20]).toBe("config.json: 3 more keys of the wrong type not listed");
    // 20 unknown + 1 wrong: none fits.
    const b = configWarnings({ ...unknown(20), webdriver: 1 });
    expect(b).toHaveLength(21);
    expect(b[19]).toBe("config.json: unknown key k19");
    expect(b[20]).toBe("config.json: 1 more key of the wrong type not listed");
    // 25 unknown + 2 wrong: both counts.
    const c = configWarnings({ ...unknown(25), proxy: [], webdriver: {} });
    expect(c).toHaveLength(21);
    expect(c[20]).toBe("config.json: 5 more unknown keys and 2 more keys of the wrong type not listed");
    // Exactly 20 lines in all: no count line.
    expect(configWarnings({ ...unknown(19), webdriver: 1 })).toHaveLength(20);
  });
});

describe("where the warnings show", () => {
  const prevHome = process.env["TABCAP_HOME"];
  afterAll(() => {
    if (prevHome === undefined) delete process.env["TABCAP_HOME"];
    else process.env["TABCAP_HOME"] = prevHome;
  });
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  });
  const WARN = "config.json: unknown key fetch.minIntervalMS (did you mean minIntervalMs?)";

  function home(config: string): { d: Daemon; dir: string; file: string } {
    const dir = tmp();
    const p = paths({ TABCAP_HOME: dir });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    writeFileSync(p.configFile, config);
    const d = new Daemon(p);
    daemons.push(d);
    return { d, dir, file: p.configFile };
  }
  type Env = Awaited<ReturnType<typeof handleCommand>>;
  const cmd = (d: Daemon, action: string, args: Record<string, unknown> = {}): Promise<Env> => handleCommand(d, { action, args, session: "a" }, () => undefined);
  const data = (env: Env): Record<string, unknown> => {
    if (!env.ok || !isRecord(env.data)) throw new Error(JSON.stringify(env));
    return env.data;
  };
  const DAEMON = { running: true as const, pid: 1, version: "0", listener: "unix", socket: null, startedAt: 0 };

  test("tabcap status: config.warnings (also without a daemon), its own --text lines; browser.warnings stays the browser's", () => {
    const { d, dir } = home(JSON.stringify({ fetch: { minIntervalMS: 100 } }));
    const s = statusOf(d, DAEMON);
    expect(s.config).toEqual({ warnings: [WARN], error: null });
    expect(s.browser.warnings).toBeNull();
    const off = offlineStatus(paths({ TABCAP_HOME: dir }).config, "unix");
    expect(off.config).toEqual({ warnings: [WARN], error: null });
    expect(renderStatusText(off).split("\n")).toContain(`warning: ${WARN}`);
    const clean = home("{}");
    expect(statusOf(clean.d, DAEMON).config).toEqual({ warnings: [], error: null });
    expect(renderStatusText(statusOf(clean.d, DAEMON))).not.toContain("warning:");
  });

  // Owner 2026-10-22: tabcap status keeps its view and reports the broken file in config.error
  // (config-strict.test.ts has the whole answer); browser status still answers the error.
  test("browser status answers a broken config.json's error, tabcap status reports it in config.error; daemon status still answers", async () => {
    const { d } = home('{"fetch": {},}');
    expect(await cmd(d, "status")).toMatchObject({ ok: true, data: { config: { warnings: [], error: { code: "bad-input" } } } });
    expect(await cmd(d, "browser.status")).toMatchObject({ ok: false, error: { code: "bad-input" } });
    expect(await cmd(d, "daemon.status")).toMatchObject({ ok: true, data: { running: true, browser: { running: false } } });
  });

  test("browser status without a browser: warnings from config.json", async () => {
    const { d } = home(JSON.stringify({ fetch: { minIntervalMS: 100 } }));
    expect(data(await cmd(d, "browser.status"))).toEqual({ running: false, warnings: [WARN] });
  });

  test("a key of the wrong type shows in the same places, after the unknown keys (owner 2026-10-22)", async () => {
    const WRONG = "config.json: webdriver is a number, not a string; ignored";
    const { d, dir } = home(JSON.stringify({ webdriver: 3, fetch: { minIntervalMS: 100 } }));
    expect(statusOf(d, DAEMON).config).toEqual({ warnings: [WARN, WRONG], error: null });
    const off = offlineStatus(paths({ TABCAP_HOME: dir }).config, "unix");
    expect(renderStatusText(off).split("\n")).toContain(`warning: ${WRONG}`);
    expect(data(await cmd(d, "browser.status"))).toEqual({ running: false, warnings: [WARN, WRONG] });
  });

  test.skipIf(!FAKE_CHROME)(
    "browser start / browser status: after the browser's own warnings; read again on every answer (fake browser; POSIX)",
    async () => {
      const { d, dir, file } = home(JSON.stringify({ fetch: { minIntervalMS: 100 } }));
      const exe = fakeChrome(dir, {});
      const started = data(await cmd(d, "browser.start", { executablePath: exe, proxy: "none", chromeArg: ["--no-sandbox"] }));
      const w = started["warnings"];
      expect(Array.isArray(w) ? w.map((x) => String(x).split(":")[0]) : w).toEqual(["--no-sandbox", "config.json"]);
      expect(Array.isArray(w) ? w[1] : null).toBe(WARN);
      expect(data(await cmd(d, "browser.status"))["warnings"]).toEqual(w);
      expect(data(await cmd(d, "browser.start", {}))["warnings"]).toEqual(w);
      // The browser's own list (status's browser.warnings) has no config.json line.
      expect(d.browser?.info.warnings.some((x) => x.startsWith("config.json"))).toBe(false);
      writeFileSync(file, "{}");
      expect((data(await cmd(d, "browser.status"))["warnings"] as unknown[]).length).toBe(1);
    },
    SLOW_IO_MS,
  );

  test.skipIf(process.platform === "win32")("tabcap setup answers the warnings of the file it wrote (fake binary; POSIX)", async () => {
    const dir = tmp();
    process.env["TABCAP_HOME"] = dir;
    const p = paths({ TABCAP_HOME: dir });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    writeFileSync(p.configFile, JSON.stringify({ chrome: { argz: ["--lang=en"] }, sites: { x: { guard: { stopon: [] } } } }));
    const exe = join(dir, "chrome");
    writeFileSync(exe, '#!/bin/sh\necho "Google Chrome for Testing 155.0.7000.0"\n');
    chmodSync(exe, 0o755);
    const r = await run(["setup", "--executable-path", exe]);
    expect(r.envelope).toMatchObject({ ok: true, data: { executablePath: exe, version: "155.0.7000.0", downloaded: false } });
    if (!r.envelope.ok || !isRecord(r.envelope.data)) throw new Error("expected data");
    expect(r.envelope.data["warnings"]).toEqual(["config.json: unknown key chrome.argz (did you mean args?)", "config.json: unknown key sites.x.guard.stopon (did you mean stopOn?)"]);
  });

  test.skipIf(process.platform === "win32")("tabcap setup keeps a proxy / webdriver of the wrong type and names them; the chrome it writes replaces a wrong one (fake binary; POSIX)", async () => {
    const dir = tmp();
    process.env["TABCAP_HOME"] = dir;
    const p = paths({ TABCAP_HOME: dir });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    writeFileSync(p.configFile, JSON.stringify({ webdriver: true, proxy: 8080, chrome: "x", zzz: 1 }));
    expect(readConfigWarnings(p.configFile)).toEqual([
      "config.json: unknown key zzz",
      "config.json: webdriver is a boolean, not a string; ignored",
      "config.json: proxy is a number, not a string; ignored",
      "config.json: chrome is a string, not an object; ignored",
    ]);
    const exe = join(dir, "chrome");
    writeFileSync(exe, '#!/bin/sh\necho "Google Chrome for Testing 155.0.7000.0"\n');
    chmodSync(exe, 0o755);
    const r = await run(["setup", "--executable-path", exe]);
    if (!r.envelope.ok || !isRecord(r.envelope.data)) throw new Error(JSON.stringify(r.envelope));
    expect(r.envelope.data["warnings"]).toEqual([
      "config.json: unknown key zzz",
      "config.json: webdriver is a boolean, not a string; ignored",
      "config.json: proxy is a number, not a string; ignored",
    ]);
    expect(readConfigRaw(p.configFile)).toEqual({ webdriver: true, proxy: 8080, chrome: { executablePath: exe, version: "155.0.7000.0", platform: null }, zzz: 1 });
  });
});
