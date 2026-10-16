// The four wire binaries, embedded by `bun build --compile` (`with { type: "file" }`:
// each import is a path inside the executable's virtual file system). Only
// src/wire/native.ts imports this module, and only when tabcap runs as a
// compiled binary, so source checkouts and unit tests never need native/dist.
// Build them first: `bun scripts/native.ts build` (scripts/release.ts does).

import aarch64Macos from "../../native/dist/aarch64-macos/wireprint" with { type: "file" };
import x8664LinuxGnu from "../../native/dist/x86_64-linux-gnu/wireprint" with { type: "file" };
import aarch64LinuxGnu from "../../native/dist/aarch64-linux-gnu/wireprint" with { type: "file" };
import x8664WindowsGnu from "../../native/dist/x86_64-windows-gnu/wireprint.exe" with { type: "file" };
import type { NativeTarget } from "./targets.ts";

export const EMBEDDED: Record<NativeTarget, string> = {
  "aarch64-macos": aarch64Macos,
  "x86_64-linux-gnu": x8664LinuxGnu,
  "aarch64-linux-gnu": aarch64LinuxGnu,
  "x86_64-windows-gnu": x8664WindowsGnu,
};
