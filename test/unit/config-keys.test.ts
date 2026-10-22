// Review wave 3 (owner 2026-10-21, docs/04 §44): config.json has one key
// table, CONFIG_KEYS (src/shared/config.ts). A key the table does not list at
// its level (a case slip, a typo, the right key at the wrong level) is neither
// an error nor a reason to drop the rest of the level: it is a warning,
// `config.json: unknown key <path> (did you mean <key>?)`, shown by `browser
// start` / `browser status` (`warnings`), `tabcap status` (`config.warnings`)
// and `tabcap setup` (`warnings`). The replay rules subtrees keep refusing
// unknown keys themselves (docs/04 §31). Expected texts: the owner's example
// in the decision ("sites.x.guard.stopon (did you mean stopOn?)").

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
  configWarnings,
  readChromeArgsConfig,
  readConfig,
  readConfigWarnings,
  readFetchConfig,
  readHandoffConfig,
  readPoolConfig,
  readProtectionConfig,
  readRecordBodies,
  readSiteGuards,
  readTraceConfig,
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
});
