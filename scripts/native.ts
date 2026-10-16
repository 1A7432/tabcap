// `bun run test:native` / `bun run fmt:native` / the wire binaries tabcap embeds.
//   bun scripts/native.ts test                     → zig build test (in native/wireprint)
//   bun scripts/native.ts fmt                      → zig fmt src
//   bun scripts/native.ts build                    → native/dist/<target>/wireprint[.exe] for all four targets
//   bun scripts/native.ts build --host             → only this machine's target (CI e2e jobs, dev runs)
//   bun scripts/native.ts build --targets a,b      → these Zig targets
// Release binaries: -Doptimize=ReleaseSafe -Dstrip=true, pure Zig (cross-compiles from any host).

import { NATIVE_SRC, NATIVE_TARGETS, hostTarget, isNativeTarget, type NativeTarget } from "../src/wire/targets.ts";
import { buildTarget } from "../src/wire/build.ts";

export const NATIVE_DIR = NATIVE_SRC;

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
