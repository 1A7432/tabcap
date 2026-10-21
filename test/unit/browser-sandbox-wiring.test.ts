// Chrome inside another sandbox (0.7.4, owner decision 2026-10-19), the wiring
// that sandbox-check.test.ts leaves out: browser start reads the lines the
// browser wrote to browser.log during this launch (the launcher points its
// stderr there), fails with `unsupported` when the launch failed or when it
// answered but the sandbox line is already there (and shuts that browser
// down), and remembers the cause when the browser dies later, so every command
// after that repeats it instead of "not running". The browser is the fake in
// _fakechrome.ts. Oracle for the lines: Chrome's own words that
// sandbox-check.ts matches (the macOS helper line measured with sandbox-exec,
// NOTES 2026-10-19; the Linux zygote line is still 待验 there).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, alive, fakeChrome, fakeChromePid } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree, until } from "./_platform.ts";

const MAC_LINE = "sandbox initialization failed: Operation not permitted\n";
const LINUX_LINE = "[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.\n";

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

function home(): { d: Daemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-sbxwire-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  const d = new Daemon(p);
  daemons.push(d);
  return { d, dir };
}

type Env = Awaited<ReturnType<typeof handleCommand>>;
const run = (d: Daemon, action: string, args: Record<string, unknown> = {}): Promise<Env> => handleCommand(d, { action, args, session: "a" }, () => undefined);
const start = (d: Daemon, exe: string): Promise<Env> => run(d, "browser.start", { executablePath: exe, proxy: "none" });
const err = (env: Env): Record<string, unknown> => (env.ok ? {} : env.error);
const data = (env: Env): Record<string, unknown> => (env.ok && isRecord(env.data) ? env.data : {});

describe.skipIf(!FAKE_CHROME)("browser start inside another sandbox (fake browser; POSIX)", () => {
  test(
    "the browser exits at launch after the sandbox line: unsupported naming browser.log, and later commands repeat it",
    async () => {
      const { d, dir } = home();
      const first = err(await start(d, fakeChrome(dir, { stderrAtStart: LINUX_LINE, exitAtStart: 1 })));
      expect(first).toMatchObject({ code: "unsupported" });
      expect(String(first["message"])).toContain("another sandbox");
      expect(String(first["message"])).toContain(d.paths.browserLog);
      expect(String(first["next"])).toContain("Never add --no-sandbox");
      expect(d.browser).toBeNull();
      // every later command that needs the browser: the same cause, not "not running"
      const later = err(await run(d, "tabs"));
      expect(later).toMatchObject({ code: "unsupported", message: first["message"] });
      expect(() => d.need()).toThrow(String(first["message"]));
    },
    SLOW_IO_MS,
  );

  test(
    "the browser exits at launch without it: the launch error itself, nothing remembered",
    async () => {
      const { d, dir } = home();
      const first = err(await start(d, fakeChrome(dir, { stderrAtStart: "[ERROR:crashpad/file_io_posix.cc:208] open settings.dat: Operation not permitted (1)\n", exitAtStart: 1 })));
      expect(first["code"]).not.toBe("unsupported");
      expect(d.browserFailure).toBeNull();
      expect(err(await run(d, "tabs"))).toMatchObject({ code: "not-running" });
    },
    SLOW_IO_MS,
  );

  test(
    "the browser answers but the sandbox line is already there: tabcap shuts that browser down and fails",
    async () => {
      const { d, dir } = home();
      const first = err(await start(d, fakeChrome(dir, { stderrAtStart: MAC_LINE })));
      expect(first).toMatchObject({ code: "unsupported" });
      expect(d.browser).toBeNull();
      const pid = fakeChromePid(dir);
      expect(pid).not.toBeNull();
      if (pid !== null) expect(alive(pid)).toBe(false);
      expect(err(await run(d, "tabs"))).toMatchObject({ code: "unsupported" });
    },
    SLOW_IO_MS,
  );

  test(
    "only this launch's lines count; a later start forgets the cause; a browser that dies after a clean start and wrote the line is remembered (the measured macOS case)",
    async () => {
      const { d, dir } = home();
      // an earlier launch failed and left its line in browser.log
      expect(err(await start(d, fakeChrome(dir, { stderrAtStart: MAC_LINE, exitAtStart: 1 })))).toMatchObject({ code: "unsupported" });
      writeFileSync(d.paths.browserLog, "Failed to initialize sandbox.\n", { flag: "a" });
      // this launch is clean: it starts, and the remembered cause is gone
      const ok = await start(d, fakeChrome(dir));
      expect(ok.ok).toBe(true);
      expect(data(ok)).toMatchObject({ alreadyRunning: false, version: "FakeChrome/1.0" });
      expect(d.browserFailure).toBeNull();
      expect((await run(d, "tabs")).ok).toBe(true);
      // the helpers fail a moment later: the browser writes the line and exits
      const t = d.browser?.t;
      expect(t).toBeDefined();
      await t?.send("FakeChrome.crash", { stderr: MAC_LINE }, null, 5000).catch(() => undefined);
      await until(() => d.browser === null, 10_000);
      expect(d.browser).toBeNull();
      expect(err(await run(d, "tabs"))).toMatchObject({ code: "unsupported" });
      expect(d.browserFailure?.code).toBe("unsupported");
    },
    SLOW_IO_MS,
  );
});
