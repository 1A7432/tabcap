// Chrome's own log on Windows (review 10-21; CI of PR #31: the browser.log a
// windows-latest e2e run kept was 0 bytes, so a probe timeout had nothing to
// look at). Chrome writes its stderr to browser.log on every platform (the
// launcher passes the file as fd 2), but a release Chrome on Windows logs
// nothing to stderr unless asked: tabcap's own Chrome for Testing gets
// `--enable-logging=stderr --log-level=1` (warnings and errors) there.
// macOS and Linux already print errors to stderr and keep their command line,
// so their wire baseline cache keys (docs/07 §6) do not change; a Windows key
// changes once (its cached wire profiles are measured again).

import { describe, expect, test } from "bun:test";
import { WINDOWS_LOG_FLAGS, buildArgs, parseProxy } from "../../src/daemon/transport/direct/launcher.ts";
import { normalizedLaunchArgs } from "../../src/shared/launchargs.ts";
import { flagsSha256 } from "../../src/wire/profile.ts";

const base = { profileDir: "/p", cdp: "pipe" as const, proxy: parseProxy("system"), webdriver: "hidden" as const, extensionDir: null, noStartupWindow: true };
const as081 = (args: string[]): string[] => args.map((a) => (a.startsWith("--user-data-dir=") ? "--user-data-dir=<profile>" : a));

describe("Chrome's log to stderr", () => {
  test("Windows: --enable-logging=stderr --log-level=1, after the keychain / password-store slot; macOS and Linux: neither", () => {
    expect(WINDOWS_LOG_FLAGS).toEqual(["--enable-logging=stderr", "--log-level=1"]);
    const win = buildArgs({ ...base, platform: "win32" });
    expect(win).toEqual(expect.arrayContaining(["--enable-logging=stderr", "--log-level=1"]));
    for (const platform of ["darwin", "linux"] as const) {
      const a = buildArgs({ ...base, platform });
      expect(a.some((x) => x.startsWith("--enable-logging") || x.startsWith("--log-level"))).toBe(false);
    }
  });

  test("the user can drop them like any other default (--drop-chrome-arg)", () => {
    const a = buildArgs({ ...base, platform: "win32", custom: { add: [], drop: ["--enable-logging", "--log-level"] } });
    expect(a.some((x) => x.startsWith("--enable-logging") || x.startsWith("--log-level"))).toBe(false);
  });

  test("wire cache keys: macOS and Linux as before; Windows differs by exactly the two switches", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const args = buildArgs({ ...base, platform });
      expect(flagsSha256(normalizedLaunchArgs(args, { home: "/h", extensionDir: null }))).toBe(flagsSha256(as081(args)));
    }
    const win = normalizedLaunchArgs(buildArgs({ ...base, platform: "win32" }), { home: "C:\\Users\\a", extensionDir: null });
    const without = win.filter((x) => !WINDOWS_LOG_FLAGS.includes(x));
    expect(win.length - without.length).toBe(2);
    expect(flagsSha256(win)).not.toBe(flagsSha256(without));
  });
});
