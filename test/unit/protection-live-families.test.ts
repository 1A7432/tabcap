// The live protection probe's families (review 10-21, low item; docs/04
// §41.1 / §41.3): built-ins plus config/protection/*.json are read and
// compiled once when the browser starts, not on every navigation, and a user
// file that was skipped (bad JSON, a bad or nested-quantifier regex …) is
// named in `warnings` — in browser start / browser status / status (the
// browser's warnings) and in every navigate / snapshot answer's protection
// part (protectionField) — instead of being dropped silently as before; recon
// already reported them. A file added or fixed later is used from the next
// browser start. The browser is the fake in _fakechrome.ts (it answers the
// probe: one cookie, frame tree, isolated world).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { familiesFor, protectionField } from "../../src/daemon/protection/live.ts";
import { Daemon } from "../../src/daemon/state.ts";
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

function home(): { d: Daemon; dir: string; protectionDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-plfam-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  const protectionDir = join(p.config, "protection");
  mkdirSync(protectionDir, { recursive: true, mode: 0o700 });
  const d = new Daemon(p);
  daemons.push(d);
  return { d, dir, protectionDir };
}

const MINE = { schema: "tabcap-protection/0", id: "mine", name: "Mine", vendor: "Me", category: "anti-bot", version: 1, rules: [{ id: "c", kind: "cookie", name: "mine_session_cookie", confidence: 100, note: "n" }] };

describe("without a browser (unit tests): read once per daemon", () => {
  test("a second call reuses the first read, a file added in between is not seen", () => {
    const { d, protectionDir } = home();
    const first = familiesFor(d);
    writeFileSync(join(protectionDir, "mine.json"), JSON.stringify(MINE));
    expect(familiesFor(d)).toBe(first);
    expect(first.families.some((f) => f.id === "mine")).toBe(false);
  });
});

describe.skipIf(!FAKE_CHROME)("with the browser (fake browser; POSIX)", () => {
  test(
    "a skipped user file is in browser start / browser status / status warnings and in the navigate / snapshot protection part",
    async () => {
      const { d, dir, protectionDir } = home();
      writeFileSync(join(protectionDir, "broken.json"), "{ not json");
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      const exe = fakeChrome(dir, { url: "https://shop.example/", cookies: [{ name: "datadome", value: "AbCdEf0123456789" }] });
      const started = await run("browser.start", { executablePath: exe, proxy: "none" });
      if (!started.ok || !isRecord(started.data)) throw new Error(JSON.stringify(started));
      const warned = (w: unknown): boolean => Array.isArray(w) && w.some((x) => String(x).includes("broken.json skipped"));
      expect(warned(started.data["warnings"])).toBe(true);
      const bs = await run("browser.status");
      expect(bs.ok && isRecord(bs.data) && warned(bs.data["warnings"])).toBe(true);
      const st = await run("status");
      expect(st.ok && isRecord(st.data) && isRecord(st.data["browser"]) && warned(st.data["browser"]["warnings"])).toBe(true);
      const b = d.browser;
      if (b === null) throw new Error("no browser");
      const tab = await b.tabs.createTab("a");
      const field = await protectionField(d, b.t, tab);
      expect(field.protection?.map((x) => x.name)).toEqual(["DataDome"]);
      expect(warned(field.warnings)).toBe(true);
    },
    SLOW_IO_MS,
  );

  test(
    "read once per browser start: a file added later is not used by later navigations, only after the next browser start",
    async () => {
      const { d, dir, protectionDir } = home();
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      const exe = fakeChrome(dir, { url: "https://shop.example/", cookies: [{ name: "mine_session_cookie", value: "v" }] });
      expect((await run("browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      const names = async (): Promise<string[]> => {
        const b = d.browser;
        if (b === null) throw new Error("no browser");
        const tab = [...b.tabs.tabs.values()].find((t) => !t.closed) ?? (await b.tabs.createTab("a"));
        tab.navEpoch++; // a new navigation, so the page is probed again
        return ((await protectionField(d, b.t, tab)).protection ?? []).map((x) => x.name);
      };
      expect(await names()).toEqual([]);
      writeFileSync(join(protectionDir, "mine.json"), JSON.stringify(MINE));
      expect(await names()).toEqual([]);
      expect((await run("browser.stop")).ok).toBe(true);
      expect((await run("browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      expect(await names()).toEqual(["Mine"]);
    },
    SLOW_IO_MS,
  );
});
