// Platform facts for L0 tests that run on macOS, Linux and Windows (CI matrix).
//
// POSIX permission bits exist on macOS / Linux only. On Windows tabcap's files
// keep the user-default ACL of %LOCALAPPDATA%\tabcap (README "Files"): Node
// reports 0666 / 0777 there and chmod only toggles read-only, and the product
// does not check modes (store, plugins). Mode assertions therefore run on POSIX
// only; what replaces them on Windows (ACLs) is 待验 (NOTES 0.3-G).

import { expect } from "bun:test";
import { statSync } from "node:fs";

export const POSIX_MODES = process.platform !== "win32";

/** `stat` mode bits equal `want` (POSIX only; a no-op on Windows, see above). */
export function expectMode(path: string, want: number): void {
  if (POSIX_MODES) expect([path, statSync(path).mode & 0o777]).toEqual([path, want]);
}
