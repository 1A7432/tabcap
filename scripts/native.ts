// `bun run test:native` / `bun run fmt:native`: run zig inside native/wireprint.
//   bun scripts/native.ts test   → zig build test -Dopenssl=false
//   bun scripts/native.ts fmt    → zig fmt src
// tabcap builds the component only with -Dopenssl=false and never with -Dja4plus.

import { join } from "node:path";

export const NATIVE_DIR = join(import.meta.dir, "..", "native", "wireprint");

export const COMMANDS: Record<string, string[]> = {
  test: ["zig", "build", "test", "-Dopenssl=false"],
  fmt: ["zig", "fmt", "src"],
};

if (import.meta.main) {
  const name = process.argv[2] ?? "";
  const cmd = COMMANDS[name];
  if (cmd === undefined) {
    console.error(`usage: bun scripts/native.ts <${Object.keys(COMMANDS).join("|")}>`);
    process.exit(2);
  }
  if (Bun.which("zig") === null) {
    console.error("zig not found on PATH (native/wireprint needs Zig 0.16.0, see build.zig.zon)");
    process.exit(127);
  }
  const proc = Bun.spawnSync(cmd, { cwd: NATIVE_DIR, stdout: "inherit", stderr: "inherit" });
  process.exit(proc.exitCode ?? 1);
}
