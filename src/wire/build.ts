// Build native/dist/<target>/wireprint[.exe] with Zig (dev runs and the release
// script; a compiled tabcap carries the binaries and never builds). Each build
// installs into a fresh temporary prefix and renames the binary into place, so
// two builds at once (parallel test runs) never leave a half-written file.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { NATIVE_DIST, NATIVE_SRC, binaryName, distBinary, zigBuildCommand, type NativeTarget } from "./targets.ts";

export type Built = { target: NativeTarget; path: string; bytes: number; ms: number };

export async function buildTarget(t: NativeTarget, o: { src?: string; dist?: string; inherit?: boolean } = {}): Promise<Built> {
  const src = o.src ?? NATIVE_SRC;
  const dist = o.dist ?? NATIVE_DIST;
  if (Bun.which("zig") === null) {
    throw new TabcapError("not-found", "zig is not on PATH; it is needed to build the wire component in a source checkout", "Install Zig 0.16.0 (see native/wireprint/build.zig.zon), or use a released tabcap binary, which carries the component.");
  }
  mkdirSync(dist, { recursive: true });
  const prefix = mkdtempSync(join(dist, `.build-${t}-`));
  const started = performance.now();
  try {
    const p = Bun.spawn(zigBuildCommand(t, prefix), { cwd: src, stdout: o.inherit === true ? "inherit" : "pipe", stderr: o.inherit === true ? "inherit" : "pipe" });
    const [code, err] = await Promise.all([p.exited, p.stderr instanceof ReadableStream ? new Response(p.stderr).text() : Promise.resolve("")]);
    if (code !== 0) throw new TabcapError("internal", `zig build for ${t} failed (exit ${code}): ${err.trim().slice(0, 600)}`, "Run `bun scripts/native.ts build` to see the full output; Zig must be 0.16.0.");
    const out = distBinary(t, dist);
    mkdirSync(join(dist, t), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    copyFileSync(join(prefix, "bin", binaryName(t)), tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, out);
    return { target: t, path: out, bytes: statSync(out).size, ms: Math.round(performance.now() - started) };
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}
