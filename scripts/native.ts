// `bun run test:native` / `bun run fmt:native` / the wire binaries tabcap embeds.
//   bun scripts/native.ts test                     → zig build test (in native/wireprint)
//   bun scripts/native.ts fmt                      → zig fmt src
//   bun scripts/native.ts build                    → native/dist/<target>/wireprint[.exe] for all four targets
//   bun scripts/native.ts build --host             → only this machine's target (CI e2e jobs, dev runs)
//   bun scripts/native.ts build --targets a,b      → these Zig targets
// Release binaries: -Doptimize=ReleaseSafe -Dstrip=true, pure Zig (cross-compiles from any host).
// Before any of them, `zig version` must have the major.minor of build.zig.zon's
// minimum_zig_version (AGENTS.md: that file decides, no upgrade); another Zig exits 1
// with one sentence and the next step instead of a compile error.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_SRC, NATIVE_TARGETS, hostTarget, isNativeTarget, type NativeTarget } from "../src/wire/targets.ts";
import { buildTarget } from "../src/wire/build.ts";

export const NATIVE_DIR = NATIVE_SRC;

/** Pure: build.zig.zon's `.minimum_zig_version = "x.y.z"`, or null. */
export function minimumZigVersion(zon: string): string | null {
  return /^\s*\.minimum_zig_version\s*=\s*"([^"]+)"/m.exec(zon)?.[1] ?? null;
}

/** Pure: null when `have` (the output of `zig version`) has the major.minor of `need`, else the sentence to print. */
export function zigVersionProblem(have: string, need: string): string | null {
  const mm = (v: string) => /^(\d+)\.(\d+)\./.exec(v.trim());
  const h = mm(have);
  const n = mm(need);
  if (n === null) return `build.zig.zon's minimum_zig_version ${JSON.stringify(need)} is not a version`;
  const series = `${n[1]}.${n[2]}.x`;
  const next = `install Zig ${need} (https://ziglang.org/download/) and put it first on PATH, or copy a built native/dist/ from another checkout (released tabcap binaries carry the component and need no Zig)`;
  if (h === null) return `cannot read the Zig version from \`zig version\` (${JSON.stringify(have.trim())}); native/wireprint needs Zig ${series}: ${next}`;
  if (h[1] === n[1] && h[2] === n[2]) return null;
  return `zig on PATH is ${have.trim()}, native/wireprint needs Zig ${series} (build.zig.zon minimum_zig_version ${need}): ${next}`;
}

export const COMMANDS: Record<string, string[]> = {
  test: ["zig", "build", "test"],
  fmt: ["zig", "fmt", "src"],
};

/** Targets named by `build` options (pure). */
export function buildTargets(argv: readonly string[], host: NativeTarget | null = hostTarget()): NativeTarget[] {
  if (argv.includes("--host")) {
    if (host === null) throw new Error(`no wire target for ${process.platform}-${process.arch}`);
    return [host];
  }
  const i = argv.indexOf("--targets");
  if (i < 0) return [...NATIVE_TARGETS];
  const list = (argv[i + 1] ?? "").split(",").filter((x) => x !== "");
  const bad = list.filter((x) => !isNativeTarget(x));
  if (list.length === 0 || bad.length > 0) throw new Error(`--targets: unknown ${bad.join(", ") || "(empty)"}; use ${NATIVE_TARGETS.join(", ")}`);
  return list.filter(isNativeTarget);
}

if (import.meta.main) {
  const name = process.argv[2] ?? "";
  if (Bun.which("zig") === null) {
    console.error("zig not found on PATH (native/wireprint needs Zig 0.16.0, see build.zig.zon)");
    process.exit(127);
  }
  const need = minimumZigVersion(readFileSync(join(NATIVE_DIR, "build.zig.zon"), "utf8"));
  if (need === null) {
    console.error("native/wireprint/build.zig.zon has no minimum_zig_version");
    process.exit(1);
  }
  const version = Bun.spawnSync(["zig", "version"], { stdout: "pipe", stderr: "pipe" });
  const problem = zigVersionProblem(version.exitCode === 0 ? version.stdout.toString() : "", need);
  if (problem !== null) {
    console.error(problem);
    process.exit(1);
  }
  if (name === "build") {
    for (const t of buildTargets(process.argv.slice(3))) {
      const b = await buildTarget(t, { inherit: true });
      console.log(`${t}: ${b.path} (${b.bytes} bytes, ${(b.ms / 1000).toFixed(1)} s)`);
    }
    process.exit(0);
  }
  const cmd = COMMANDS[name];
  if (cmd === undefined) {
    console.error(`usage: bun scripts/native.ts <${[...Object.keys(COMMANDS), "build [--host | --targets a,b]"].join("|")}>`);
    process.exit(2);
  }
  const proc = Bun.spawnSync(cmd, { cwd: NATIVE_DIR, stdout: "inherit", stderr: "inherit" });
  process.exit(proc.exitCode ?? 1);
}
