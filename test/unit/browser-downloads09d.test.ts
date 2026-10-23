// 0.9-D (docs/04 §48, docs/05 s75): browser start takes over the download behaviour before
// the first tab, or the browser is not kept (no browser whose downloads land
// in the user's ~/Downloads); the staging directory lives for one browser run.
// The browser is the fake in _fakechrome.ts (it answers every CDP call with {}
// unless told to fail one). Oracle: docs/04 §48.
// Reproduce: bun test test/unit/browser-downloads09d.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, alive, fakeChrome, fakeChromePid } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree, until } from "./_platform.ts";

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

function home(): { d: Daemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-bdl09d-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  const d = new Daemon(p);
  daemons.push(d);
  return { d, dir };
}

type Env = Awaited<ReturnType<typeof handleCommand>>;
const run = (d: Daemon, action: string, args: Record<string, unknown> = {}): Promise<Env> => handleCommand(d, { action, args, session: "a" }, () => undefined);
const runs = (root: string): string[] => (existsSync(root) ? readdirSync(root) : []);

describe.skipIf(!FAKE_CHROME)("browser start and the download behaviour (fake browser; POSIX)", () => {
  test(
    "taken: one staging directory (0700) for the run while it runs; browser stop removes it; the next start makes a new one",
    async () => {
      const { d, dir } = home();
      const exe = fakeChrome(dir, {});
      expect((await run(d, "browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      const root = d.paths.downloads;
      const first = runs(root);
      expect(first.length).toBe(1);
      expect(d.browser?.downloads.staging).toBe(join(root, first[0] ?? ""));
      expect((statSync(join(root, first[0] ?? "")).mode & 0o777).toString(8)).toBe("700");
      expect((await run(d, "browser.stop")).ok).toBe(true);
      expect(runs(root)).toEqual([]);
      expect((await run(d, "browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      expect(runs(root).length).toBe(1);
      expect(runs(root)).not.toEqual(first);
    },
    SLOW_IO_MS,
  );

  test(
    "refused by the browser: browser start fails with cdp, the browser is shut down, no staging directory is left, and later commands say not-running",
    async () => {
      const { d, dir } = home();
      const exe = fakeChrome(dir, { fail: { "Browser.setDownloadBehavior": "Browser context management is not supported." } });
      const env = await run(d, "browser.start", { executablePath: exe, proxy: "none" });
      expect(env.ok ? null : env.error).toMatchObject({ code: "cdp" });
      expect(env.ok ? "" : String(env.error["message"])).toContain("Browser context management is not supported.");
      expect(d.browser).toBeNull();
      const pid = fakeChromePid(dir);
      if (pid !== null) await until(() => !alive(pid), 5000);
      expect(runs(d.paths.downloads)).toEqual([]);
      const later = await run(d, "tabs");
      expect(later.ok ? null : later.error["code"]).toBe("not-running");
    },
    SLOW_IO_MS,
  );

  test(
    "download list / wait without a recording: not-found, as net list / net wait",
    async () => {
      const { d, dir } = home();
      expect((await run(d, "browser.start", { executablePath: fakeChrome(dir, {}), proxy: "none" })).ok).toBe(true);
      for (const action of ["download.list", "download.wait"]) {
        const env = await run(d, action);
        expect([action, env.ok ? null : env.error["code"]]).toEqual([action, "not-found"]);
      }
    },
    SLOW_IO_MS,
  );
});
