// The native wire-fingerprint component (native/wireprint, Zig) is cross-compiled
// for the four release targets into native/dist/<zig target>/wireprint[.exe]
// (`bun scripts/native.ts build`); the compiled tabcap binary embeds all four
// (src/wire/embedded.ts) and picks the host's one at run time.

import { join } from "node:path";

export const NATIVE_TARGETS = ["aarch64-macos", "x86_64-linux-gnu", "aarch64-linux-gnu", "x86_64-windows-gnu"] as const;
export type NativeTarget = (typeof NATIVE_TARGETS)[number];

export function isNativeTarget(v: string): v is NativeTarget {
  return (NATIVE_TARGETS as readonly string[]).includes(v);
}

/** Repository paths (dev runs and the build script; a compiled binary never reads them). */
export const NATIVE_SRC = join(import.meta.dir, "..", "..", "native", "wireprint");
export const NATIVE_DIST = join(import.meta.dir, "..", "..", "native", "dist");

/** Zig target of a host; null where tabcap ships no wire binary (e.g. Windows arm64, macOS x64). */
export function hostTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativeTarget | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-macos";
  if (platform === "linux" && arch === "x64") return "x86_64-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-linux-gnu";
  if (platform === "win32" && arch === "x64") return "x86_64-windows-gnu";
  return null;
}

export function binaryName(t: NativeTarget): string {
  return t.endsWith("-windows-gnu") ? "wireprint.exe" : "wireprint";
}

/** dist path of one target's binary. */
export function distBinary(t: NativeTarget, dist: string = NATIVE_DIST): string {
  return join(dist, t, binaryName(t));
}

/** `zig build` for one release binary: ReleaseSafe, stripped, pure Zig (no libc), installed under `prefix`/bin. */
export function zigBuildCommand(t: NativeTarget, prefix: string): string[] {
  return ["zig", "build", "-Doptimize=ReleaseSafe", "-Dstrip=true", `-Dtarget=${t}`, "--prefix", prefix];
}
