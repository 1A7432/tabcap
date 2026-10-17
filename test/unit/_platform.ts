// Platform facts for L0 tests that run on macOS, Linux and Windows (CI matrix).
//
// POSIX permission bits exist on macOS / Linux only. On Windows tabcap's files
// keep the user-default ACL of %LOCALAPPDATA%\tabcap (README "Files"): Node
// reports 0666 / 0777 there and chmod only toggles read-only, and the product
// does not check modes (store, plugins). Mode assertions therefore run on POSIX
// only; what replaces them on Windows (ACLs) is 待验 (NOTES 0.3-G).

import { expect } from "bun:test";
import { rmSync, statSync } from "node:fs";

export const POSIX_MODES = process.platform !== "win32";

/** `stat` mode bits equal `want` (POSIX only; a no-op on Windows, see above). */
export function expectMode(path: string, want: number): void {
  if (POSIX_MODES) expect([path, statSync(path).mode & 0o777]).toEqual([path, want]);
}

// Windows CI runners are sometimes far slower at creating files and starting
// processes. Measured on windows-latest (CI logs, bracketed test times): a
// normal run takes ~19 s for test/unit; one slow VM took 49 s, with file-heavy
// tests 10-50x slower (a reader round-trip 27 ms -> 1478 ms, release packaging
// 118 ms -> 1436 ms) and a bundle-building beforeAll killed at bun's 5 s
// default. ruby / PowerShell start-up alone took 2.5 s to over 5 s.

/** Timeout for hooks and tests that build bundles on disk or start a program. */
export const SLOW_IO_MS = 30_000;

/**
 * Waits until `done()` holds or `ms` passed, polling every 10 ms. For work the
 * test cannot await (a recorder's background write): assert after it, never
 * instead of a fixed sleep's lower bound.
 */
export async function until(done: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await Bun.sleep(10);
}

/**
 * `rm -rf` for a directory a test's child processes used (their cwd: a plugin
 * run with `uv run`). Await the processes' exit first (DecodeHost.close()); on
 * Windows the directory can still refuse removal for a moment after that
 * (measured 0.7-F: EPERM, no python.exe / uv.exe left running, removed on the
 * retry 200 ms later), so EPERM / EBUSY / ENOTEMPTY are retried there for up to
 * `ms`. Elsewhere, and for any other error, it is a plain rmSync.
 */
export async function removeTree(path: string, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; ; ) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = e instanceof Error && "code" in e ? e.code : null;
      const transient = process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY");
      if (!transient || Date.now() > end) throw e;
      await Bun.sleep(100);
    }
  }
}
