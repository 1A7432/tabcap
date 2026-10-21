// Review 10-21 (owner decision): config.json `protection.live` (boolean,
// default true), read at `browser start` like `handoff.detectTakeover`. When
// false there is no live probe at all (docs/04 §41.3): navigate / tab new / go /
// reload / snapshot answers carry no `protection`, the guard hands over without
// family names, and `browser start` / `browser status` / `tabcap status` say
// `protectionLive: false`. `tabcap setup` keeps the key. The browser is the fake
// in _fakechrome.ts; DataDome's cookie rule (datadome.json) is the family the
// probe would otherwise find.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { cachedNames, liveIdentify, namesForGuard, protectionField } from "../../src/daemon/protection/live.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { PROTECTION_DEFAULTS, parseProtectionConfig, readConfig, readProtectionConfig, writeConfig } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

function home(config: unknown = null): { d: Daemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-plswitch-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  if (config !== null) writeFileSync(p.configFile, JSON.stringify(config));
  const d = new Daemon(p);
  daemons.push(d);
  return { d, dir };
}

describe("config.json protection.live", () => {
  test("absent → on; a boolean is read; anything else is bad-input naming the key", () => {
    expect(PROTECTION_DEFAULTS).toEqual({ live: true });
    expect(parseProtectionConfig(undefined)).toEqual({ live: true });
    expect(parseProtectionConfig(null)).toEqual({ live: true });
    expect(parseProtectionConfig({})).toEqual({ live: true });
    expect(parseProtectionConfig({ live: false })).toEqual({ live: false });
    expect(parseProtectionConfig({ live: true })).toEqual({ live: true });
    for (const [raw, key] of [
      [{ live: "no" }, "protection.live"],
      [{ live: 0 }, "protection.live"],
      [3, "protection"],
      [[], "protection"],
    ] as const) {
      try {
        parseProtectionConfig(raw);
        throw new Error("expected bad-input");
      } catch (e) {
        if (!(e instanceof TabcapError)) throw e;
        expect(e.code).toBe("bad-input");
        expect(e.message).toContain(`config.json ${key} is invalid`);
      }
    }
  });

  test("read from the file; `tabcap setup` rewriting chrome keeps it", () => {
    const { d } = home({ protection: { live: false }, chrome: { args: ["--lang=en"] } });
    const f = d.paths.configFile;
    expect(readProtectionConfig(f)).toEqual({ live: false });
    writeConfig(f, { ...readConfig(f), chrome: { executablePath: "/cft", version: "155", platform: "mac-arm64" } });
    const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
    expect(isRecord(raw) ? raw["protection"] : null).toEqual({ live: false });
    expect(readProtectionConfig(f)).toEqual({ live: false });
  });
});

type Env = Awaited<ReturnType<typeof handleCommand>>;
const run = (d: Daemon, action: string, args: Record<string, unknown> = {}): Promise<Env> => handleCommand(d, { action, args, session: "g" }, () => undefined);
const data = (env: Env): Record<string, unknown> => {
  if (!env.ok || !isRecord(env.data)) throw new Error(JSON.stringify(env));
  return env.data;
};

describe.skipIf(!FAKE_CHROME)("the live probe on and off (fake browser; POSIX)", () => {
  const PAGE = "https://shop.range.test/";
  const DD = { name: "datadome", value: "AbCdEf0123456789" };

  async function started(config: unknown) {
    const { d, dir } = home(config);
    const answer = data(await run(d, "browser.start", { executablePath: fakeChrome(dir, { cookies: [DD], url: PAGE }), proxy: "none" }));
    const b = d.browser;
    if (b === null) throw new Error("the fake browser is not running");
    const tab = await b.tabs.createTab("g");
    tab.url = PAGE; // what the fake reports as the document (it sends no navigation events)
    const probes = () => b.t.cdp.sentCounts.get("Page.getFrameTree") ?? 0;
    const statusBrowser = async (): Promise<Record<string, unknown>> => {
      const x = data(await run(d, "status"))["browser"];
      return isRecord(x) ? x : {};
    };
    return { d, b, tab, answer, probes, statusBrowser };
  }

  test(
    "protection.live false: no probe for answers or the guard, no names; the answers say protectionLive false",
    async () => {
      const s = await started({ protection: { live: false } });
      expect(s.answer["protectionLive"]).toBe(false);
      expect(data(await run(s.d, "browser.status"))["protectionLive"]).toBe(false);
      expect((await s.statusBrowser())["protectionLive"]).toBe(false);
      const before = s.probes();
      expect(await protectionField(s.d, s.b.t, s.tab)).toEqual({});
      expect(await liveIdentify(s.d, s.b.t, s.tab)).toEqual({ detections: [], fingerprinting: [] });
      expect(await namesForGuard(s.d, s.tab.id)).toEqual([]);
      expect(cachedNames(s.tab)).toEqual([]);
      expect(s.probes()).toBe(before);
    },
    SLOW_IO_MS,
  );

  test(
    "default (and protection.live true): probed once, the family named; protectionLive true; no browser: null in status",
    async () => {
      const { d } = home();
      const st = data(await run(d, "status"))["browser"];
      expect(isRecord(st) ? st["protectionLive"] : undefined).toBeNull();
      for (const config of [null, { protection: { live: true } }]) {
        const s = await started(config);
        expect(s.answer["protectionLive"]).toBe(true);
        expect((await s.statusBrowser())["protectionLive"]).toBe(true);
        const before = s.probes();
        expect(await protectionField(s.d, s.b.t, s.tab)).toEqual({ protection: [{ name: "DataDome", category: "anti-bot", confidence: 100 }] });
        expect(await namesForGuard(s.d, s.tab.id)).toEqual(["DataDome"]);
        expect(s.probes()).toBe(before + 1);
        await run(s.d, "browser.stop");
      }
    },
    SLOW_IO_MS,
  );

  test(
    "a bad protection.live fails browser start before anything launches",
    async () => {
      const { d, dir } = home({ protection: { live: "off" } });
      const env = await run(d, "browser.start", { executablePath: fakeChrome(dir, {}), proxy: "none" });
      expect(env.ok ? null : env.error).toMatchObject({ code: "bad-input", message: "config.json protection.live is invalid" });
      expect(d.browser).toBeNull();
    },
    SLOW_IO_MS,
  );
});
