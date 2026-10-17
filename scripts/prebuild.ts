// Preflight of every `bun run build*` (0.7-G): the compiled tabcap embeds the
// four wire binaries (src/wire/embedded.ts), so `bun build --compile` cannot
// resolve its imports until `bun scripts/native.ts build` (Zig 0.16.0) has
// written native/dist/<target>/wireprint[.exe]. When any is missing this exits 1
// with one sentence that says so, instead of bun's "Could not resolve" error.
//
//   bun scripts/prebuild.ts                 check native/dist
//   bun scripts/prebuild.ts --dist <dir>    check another directory (tests)

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { NATIVE_DIST, NATIVE_TARGETS, distBinary } from "../src/wire/targets.ts";

export const PREFLIGHT_MESSAGE = "the wire component is not built: install Zig 0.16.0 and run `bun scripts/native.ts build` first (release and npm packages include it)";

/** The wire binaries `bun build --compile` needs that are not in `dist` (paths, in target order). */
export function missingWireBinaries(dist: string = NATIVE_DIST): string[] {
  return NATIVE_TARGETS.map((t) => distBinary(t, dist)).filter((p) => !existsSync(p));
}

/** The error text when anything is missing, else null (pure apart from the existence checks). */
export function preflight(dist: string = NATIVE_DIST): string | null {
  const missing = missingWireBinaries(dist);
  if (missing.length === 0) return null;
  return `${PREFLIGHT_MESSAGE}\nmissing: ${missing.map((p) => relative(process.cwd(), p).split("\\").join("/")).join(", ")}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dist");
  const dist = i < 0 ? NATIVE_DIST : argv[i + 1];
  if (dist === undefined || dist === "" || (i < 0 && argv.length > 0) || (i >= 0 && argv.length !== 2)) {
    console.error("usage: bun scripts/prebuild.ts [--dist <dir>]");
    process.exit(2);
  }
  const why = preflight(dist);
  if (why !== null) {
    console.error(why);
    process.exit(1);
  }
}
