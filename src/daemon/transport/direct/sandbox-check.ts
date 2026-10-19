// Chrome that cannot create its own sandbox (0.7.4, owner decision 2026-10-19).
// Inside another process sandbox (an agent host's command sandbox: Seatbelt on
// macOS, bubblewrap / Landlock on Linux) Chrome's helpers fail to initialise
// theirs and the browser exits with SIGTRAP a moment after it started. Measured
// with `sandbox-exec` on macOS 10-19: `browser start` answered ok, the helpers
// logged "sandbox initialization failed: Operation not permitted", and every
// later command only said "the browser is not running". tabcap reads the lines
// Chrome wrote to browser.log during this launch and fails with the cause and
// the way out. It never adds --no-sandbox.

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { TabcapError } from "../../../shared/envelope.ts";

/** Chrome's own words when its sandbox cannot start (macOS helpers; Linux zygote). */
const MARKERS = [/sandbox initialization failed/i, /Failed to initialize sandbox/i, /No usable sandbox!/];
const TAIL = 64 * 1024;

/** Pure: does this browser.log text say Chrome's sandbox could not start? */
export function sandboxFailed(text: string): boolean {
  return MARKERS.some((m) => m.test(text));
}

/** Size of the log now (the launch's start offset); 0 when it does not exist. */
export function logOffset(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** What the browser wrote to the log since `offset` (at most the last 64 KiB). */
export function logSince(file: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const end = statSync(file).size;
    const from = Math.max(offset, end - TAIL);
    if (end <= from) return "";
    const buf = Buffer.alloc(end - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function nestedSandboxError(logFile: string, platform: NodeJS.Platform = process.platform): TabcapError {
  const linux = platform === "linux" ? " On Linux this also happens when unprivileged user namespaces are off (see the README's platform table)." : "";
  return new TabcapError(
    "unsupported",
    `Chrome could not create its sandbox: the tabcap daemon runs inside another sandbox, most likely the agent host's command sandbox (${logFile}).${linux}`,
    "Run tabcap outside that sandbox: `tabcap daemon stop`, then `tabcap daemon start && tabcap browser start` as unsandboxed commands (allow `tabcap` in the host's allowlist or excluded commands), or use it through `tabcap mcp`. Never add --no-sandbox.",
  );
}
