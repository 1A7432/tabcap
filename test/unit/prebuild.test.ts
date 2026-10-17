// scripts/prebuild.ts (0.7-G): `bun run build*` stops with one clear sentence
// when the wire binaries tabcap embeds are not in native/dist yet.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREFLIGHT_MESSAGE, missingWireBinaries, preflight } from "../../scripts/prebuild.ts";
import { NATIVE_TARGETS, binaryName } from "../../src/wire/targets.ts";
import { REPO_ROOT } from "./_fixtures.ts";

const withTmp = <T>(f: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-prebuild-"));
  try {
    return f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const run = (dist: string) => Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "prebuild.ts"), "--dist", dist], { stdout: "pipe", stderr: "pipe" });

const writeAll = (dist: string, skip: string | null = null): void => {
  for (const t of NATIVE_TARGETS) {
    if (t === skip) continue;
    mkdirSync(join(dist, t), { recursive: true });
    writeFileSync(join(dist, t, binaryName(t)), "stand-in");
  }
};

describe("build preflight (wire binaries in native/dist)", () => {
  test("no native/dist: the message, every target listed, exit 1", () =>
    withTmp((dir) => {
      const dist = join(dir, "native", "dist");
      expect(missingWireBinaries(dist)).toEqual(NATIVE_TARGETS.map((t) => join(dist, t, binaryName(t))));
      expect(preflight(dist)?.split("\n")[0]).toBe(PREFLIGHT_MESSAGE);
      const r = run(dist);
      expect(r.exitCode).toBe(1);
      const lines = r.stderr.toString().trimEnd().split("\n");
      expect(lines[0]).toBe("the wire component is not built: install Zig 0.16.0 and run `bun scripts/native.ts build` first (release and npm packages include it)");
      expect(lines[1]?.startsWith("missing: ")).toBe(true);
      expect(lines[1]?.endsWith("x86_64-windows-gnu/wireprint.exe")).toBe(true);
      expect(lines).toHaveLength(2);
      expect(r.stdout.toString()).toBe("");
    }));

  test("one binary missing is enough to stop", () =>
    withTmp((dist) => {
      writeAll(dist, "aarch64-linux-gnu");
      expect(missingWireBinaries(dist)).toEqual([join(dist, "aarch64-linux-gnu", "wireprint")]);
      expect(run(dist).exitCode).toBe(1);
    }));

  test("all four present: silent, exit 0", () =>
    withTmp((dist) => {
      writeAll(dist);
      expect(preflight(dist)).toBeNull();
      const r = run(dist);
      expect([r.exitCode, r.stdout.toString(), r.stderr.toString()]).toEqual([0, "", ""]);
    }));

  test("every build script runs the preflight before bun build --compile", async () => {
    const pkg: unknown = await Bun.file(join(REPO_ROOT, "package.json")).json();
    const scripts = typeof pkg === "object" && pkg !== null && "scripts" in pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? Object.entries(pkg.scripts) : [];
    const builds = scripts.filter(([k]) => k === "build" || k.startsWith("build:"));
    expect(builds.map(([k]) => k)).toEqual(["build", "build:darwin-arm64", "build:linux-x64", "build:linux-arm64", "build:windows-x64"]);
    for (const [, cmd] of builds) expect(String(cmd).startsWith("bun scripts/prebuild.ts && bun build --compile ")).toBe(true);
  });
});
