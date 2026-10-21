// scripts/native.ts refuses a Zig whose major.minor differs from build.zig.zon's
// minimum_zig_version (AGENTS.md: that file decides) before running any zig command.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_DIR, minimumZigVersion, zigVersionProblem } from "../../scripts/native.ts";

describe("Zig version check", () => {
  test("minimum_zig_version from build.zig.zon (the real file pins 0.16.0)", () => {
    expect(minimumZigVersion(readFileSync(join(NATIVE_DIR, "build.zig.zon"), "utf8"))).toBe("0.16.0");
    expect(minimumZigVersion('.{\n    .name = .x,\n    .minimum_zig_version = "1.2.3",\n}\n')).toBe("1.2.3");
    expect(minimumZigVersion(".{ .name = .x }")).toBeNull();
  });

  test("same major.minor passes, patch and dev builds included", () => {
    expect(zigVersionProblem("0.16.0\n", "0.16.0")).toBeNull();
    expect(zigVersionProblem("0.16.2", "0.16.0")).toBeNull();
    expect(zigVersionProblem("0.16.1-dev.42+abcdef0", "0.16.0")).toBeNull();
  });

  test("another major.minor: one sentence with the current version, the series needed and the next step", () => {
    const p = zigVersionProblem("0.17.0\n", "0.16.0");
    expect(p).toBe(
      "zig on PATH is 0.17.0, native/wireprint needs Zig 0.16.x (build.zig.zon minimum_zig_version 0.16.0): install Zig 0.16.0 (https://ziglang.org/download/) and put it first on PATH, or copy a built native/dist/ from another checkout (released tabcap binaries carry the component and need no Zig)",
    );
    expect(zigVersionProblem("0.15.2", "0.16.0")).toStartWith("zig on PATH is 0.15.2, native/wireprint needs Zig 0.16.x");
    expect(zigVersionProblem("1.16.0", "0.16.0")).toStartWith("zig on PATH is 1.16.0,");
  });

  test("an unreadable `zig version` or minimum is reported, not passed", () => {
    expect(zigVersionProblem("", "0.16.0")).toStartWith('cannot read the Zig version from `zig version` (""); native/wireprint needs Zig 0.16.x: install Zig 0.16.0');
    expect(zigVersionProblem("0.16.0", "sixteen")).toBe('build.zig.zon\'s minimum_zig_version "sixteen" is not a version');
  });
});
