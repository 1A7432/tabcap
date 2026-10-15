// 0.3-G packaging templates (unpublished): Homebrew formula, npm wrapper with
// per-platform optional dependencies, Scoop manifest. Checks syntax and that
// every file points at the archives scripts/release.ts actually produces.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planFor } from "../../scripts/release.ts";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";
import { isRecord } from "../../src/shared/json.ts";
import { REPO_ROOT } from "./_fixtures.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const PKG = join(REPO_ROOT, "packaging");
const RELEASES = "https://github.com/1A7432/tabcap/releases/download";
const json = (p: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(p, "utf8"));
  if (!isRecord(v)) throw new Error(`${p} is not an object`);
  return v;
};
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

describe("Homebrew formula template", () => {
  const rb = readFileSync(join(PKG, "homebrew", "tabcap.rb"), "utf8");
  test("arm64 macOS tarball of this version, a 64-hex sha256, installs tabcap", () => {
    expect(rb).toContain(`version "${TOOL_VERSION}"`);
    const url = /url "([^"]+)"/.exec(rb)?.[1] ?? "";
    expect(url.replaceAll("#{version}", TOOL_VERSION)).toBe(`${RELEASES}/v${TOOL_VERSION}/${planFor("darwin-arm64", TOOL_VERSION).archive}`);
    expect(rb).toMatch(/sha256 "[0-9a-f]{64}"/);
    expect(rb).toContain('bin.install "tabcap"');
    expect(rb).toContain("on_arm do");
  });
  // Starting ruby on the windows-latest runner took 0.5 s to over 5 s (3.3 s
  // with --disable-gems too, so not RubyGems).
  test.skipIf(Bun.which("ruby") === null)(
    "ruby -c accepts it",
    () => {
      const r = Bun.spawnSync(["ruby", "-c", join(PKG, "homebrew", "tabcap.rb")], { stdout: "pipe", stderr: "pipe" });
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    },
    SLOW_IO_MS,
  );
});

describe("npm wrapper template", () => {
  const wrapper = json(join(PKG, "npm", "tabcap", "package.json"));
  const platforms = readdirSync(join(PKG, "npm", "platforms")).sort();
  test("one optional dependency per platform package, same version, no install scripts", () => {
    expect(platforms).toEqual(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"]);
    expect(wrapper).toMatchObject({ name: "tabcap", version: TOOL_VERSION, bin: { tabcap: "bin/tabcap.js" }, license: "Apache-2.0" });
    expect("scripts" in wrapper).toBe(false);
    const deps = rec(wrapper["optionalDependencies"]);
    expect(Object.keys(deps).sort()).toEqual(platforms.map((p) => `@tabcap/${p}`));
    for (const v of Object.values(deps)) expect(v).toBe(TOOL_VERSION);
  });
  test("each platform package selects itself by os / cpu and ships bin/ only", () => {
    for (const p of platforms) {
      const m = json(join(PKG, "npm", "platforms", p, "package.json"));
      const [os, cpu] = p.split("-");
      expect(m).toMatchObject({ name: `@tabcap/${p}`, version: TOOL_VERSION, os: [os], cpu: [cpu], files: ["bin/"], license: "Apache-2.0" });
      expect("scripts" in m).toBe(false);
    }
  });
  test("the shim parses, maps every platform package, and says what is missing", () => {
    const shim = join(PKG, "npm", "tabcap", "bin", "tabcap.js");
    const src = readFileSync(shim, "utf8");
    new Bun.Transpiler({ loader: "js" }).transformSync(src); // throws on a syntax error
    for (const p of platforms) expect(src).toContain(`"${p}": "@tabcap/${p}"`);
    const r = Bun.spawnSync(["bun", shim, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/^tabcap: (@tabcap\/\S+ is not installed|no prebuilt binary for )/);
  });
});

describe("Scoop manifest template", () => {
  const m = json(join(PKG, "scoop", "tabcap.json"));
  test("windows-x64 zip of this version, tabcap.exe, autoupdate from the .sha256 files", () => {
    const plan = planFor("windows-x64", TOOL_VERSION);
    const x64 = rec(rec(m["architecture"])["64bit"]);
    expect(m).toMatchObject({ version: TOOL_VERSION, bin: "tabcap.exe", license: "Apache-2.0" });
    expect(x64["url"]).toBe(`${RELEASES}/v${TOOL_VERSION}/${plan.archive}`);
    expect(x64["extract_dir"]).toBe(plan.name);
    expect(String(x64["hash"])).toMatch(/^[0-9a-f]{64}$/);
    const auto = rec(m["autoupdate"]);
    const autoX64 = rec(rec(auto["architecture"])["64bit"]);
    expect(String(autoX64["url"]).replaceAll("$version", TOOL_VERSION)).toBe(String(x64["url"]));
    expect(String(autoX64["extract_dir"]).replaceAll("$version", TOOL_VERSION)).toBe(plan.name);
    expect(rec(auto["hash"])).toEqual({ url: "$url.sha256" });
  });
});
