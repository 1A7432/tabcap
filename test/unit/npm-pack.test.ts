// 0.5-N scripts/npm-pack.ts: the pure parts (names from NPM_SCOPE, target
// mapping, version check, manifests, files, shim generation, publish order,
// npm pack output checks) and the shim's pass-through with a stand-in binary.
// No npm, no registry: the real pack and install are the local proof in
// packaging/npm/README.md.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_FILES,
  NPM_PLATFORMS,
  NPM_REGISTRY,
  NPM_SCOPE,
  PLATFORM_FILES,
  RELEASE_TARGET,
  SHIM_BEGIN,
  SHIM_END,
  assembleMain,
  assemblePlatform,
  binaryState,
  checkPacked,
  checkVersions,
  embeddedVersions,
  listFiles,
  mainManifest,
  mainReadme,
  missingFiles,
  parseArgs,
  parsePackJson,
  platformBinary,
  platformManifest,
  platformPackageName,
  platformReadme,
  publishCommands,
  readTemplate,
  shimSource,
  shq,
  toNpmPlatform,
  type NpmPlatform,
} from "../../scripts/npm-pack.ts";
import { FORBIDDEN, TARGETS } from "../../scripts/release.ts";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";
import { REPO_ROOT } from "./_fixtures.ts";

const NPM = join(REPO_ROOT, "packaging", "npm");
const platformTemplate = (p: NpmPlatform): Record<string, unknown> => readTemplate(join(NPM, "platforms", p, "package.json"));
const mainTemplate = (): Record<string, unknown> => readTemplate(join(NPM, "tabcap", "package.json"));
const shimTemplate = (): string => readFileSync(join(NPM, "tabcap", "bin", "tabcap.js"), "utf8");

const withTmp = <T>(f: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-npm-"));
  try {
    return f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("names and targets", () => {
  test("unscoped tabcap-<os>-<cpu> or @<scope>/<os>-<cpu>, from one constant", () => {
    expect(NPM_PLATFORMS.map((p) => platformPackageName(p, null))).toEqual(["tabcap-darwin-arm64", "tabcap-linux-x64", "tabcap-linux-arm64", "tabcap-win32-x64"]);
    expect(NPM_PLATFORMS.map((p) => platformPackageName(p, "tabcap"))).toEqual(["@tabcap/darwin-arm64", "@tabcap/linux-x64", "@tabcap/linux-arm64", "@tabcap/win32-x64"]);
    for (const p of NPM_PLATFORMS) expect(platformPackageName(p)).toBe(platformPackageName(p, NPM_SCOPE));
  });
  test("npm platforms map one to one onto the release targets; Windows ships tabcap.exe", () => {
    expect(NPM_PLATFORMS.map((p) => RELEASE_TARGET[p]).sort()).toEqual([...TARGETS].sort());
    expect(RELEASE_TARGET["win32-x64"]).toBe("windows-x64");
    expect(NPM_PLATFORMS.map(platformBinary)).toEqual(["bin/tabcap", "bin/tabcap", "bin/tabcap", "bin/tabcap.exe"]);
    expect(toNpmPlatform("windows-x64")).toBe("win32-x64");
    expect(toNpmPlatform("win32-x64")).toBe("win32-x64");
    expect(toNpmPlatform("darwin-x64")).toBeNull();
  });
  test("options: --targets takes npm or release names in platform order, --version must look like one", () => {
    expect(parseArgs([])).toEqual({ targets: [...NPM_PLATFORMS], version: null });
    expect(parseArgs(["--targets", "windows-x64,darwin-arm64"]).targets).toEqual(["darwin-arm64", "win32-x64"]);
    expect(parseArgs(["--version", "0.4.0"]).version).toBe("0.4.0");
    expect(() => parseArgs(["--targets", "darwin-x64"])).toThrow(/unknown darwin-x64/);
    expect(() => parseArgs(["--targets", ""])).toThrow(/\(empty\)/);
    expect(() => parseArgs(["--version", "v0.4"])).toThrow(/not a version/);
    expect(() => parseArgs(["--publish"])).toThrow(/unknown option --publish/);
  });
});

describe("version check", () => {
  const ok = [{ path: "a/package.json", version: "1.2.3" }];
  test("package.json's version, refused when --version or a template differs", () => {
    expect(checkVersions("1.2.3", null, ok)).toBe("1.2.3");
    expect(checkVersions("1.2.3", "1.2.3", ok)).toBe("1.2.3");
    expect(() => checkVersions("1.2.3", "1.2.4", ok)).toThrow(/--version 1\.2\.4 but package\.json says 1\.2\.3/);
    expect(() => checkVersions("1.2.3", null, [...ok, { path: "b/package.json", version: "1.2.2" }])).toThrow(/b\/package\.json has version "1\.2\.2"/);
    expect(() => checkVersions("1.2.3", null, [{ path: "c/package.json", version: undefined }])).toThrow(/c\/package\.json has version undefined/);
  });
  test("the committed templates carry this version", () => {
    const templates = [mainTemplate(), ...NPM_PLATFORMS.map(platformTemplate)].map((t, i) => ({ path: String(i), version: t["version"] }));
    expect(checkVersions(TOOL_VERSION, null, templates)).toBe(TOOL_VERSION);
  });
});

describe("manifests and files", () => {
  test("templates leave the names to the generator; their files lists cover what is shipped", () => {
    for (const p of NPM_PLATFORMS) {
      const t = platformTemplate(p);
      expect("name" in t).toBe(false);
      expect(missingFiles(t, PLATFORM_FILES)).toEqual([]);
    }
    const m = mainTemplate();
    expect("optionalDependencies" in m).toBe(false);
    expect(missingFiles(m, MAIN_FILES)).toEqual([]);
    expect(missingFiles({ files: ["bin/"] }, MAIN_FILES)).toEqual(["skills/", "templates/", "NOTICE"]);
    expect(missingFiles({}, PLATFORM_FILES)).toEqual(["bin/", "NOTICE"]);
  });
  test("platform package.json: scoped or unscoped name first, the template's os / cpu kept, no scripts", () => {
    for (const p of NPM_PLATFORMS) {
      const [os, cpu] = p.split("-");
      for (const scope of [null, "tabcap"]) {
        const m = platformManifest(platformTemplate(p), p, "9.9.9", scope);
        expect(Object.keys(m).slice(0, 2)).toEqual(["name", "version"]);
        expect(m).toMatchObject({ name: platformPackageName(p, scope), version: "9.9.9", os: [os], cpu: [cpu], license: "Apache-2.0" });
        expect("scripts" in m).toBe(false);
      }
    }
  });
  test("tabcap package.json: one optional dependency per platform package at this version, bin is the shim, no scripts", () => {
    for (const scope of [null, "tabcap"]) {
      const m = mainManifest(mainTemplate(), "9.9.9", scope);
      expect(m).toMatchObject({ name: "tabcap", version: "9.9.9", bin: { tabcap: "bin/tabcap.js" }, license: "Apache-2.0" });
      expect(m["optionalDependencies"]).toEqual(Object.fromEntries(NPM_PLATFORMS.map((p) => [platformPackageName(p, scope), "9.9.9"])));
      expect("scripts" in m).toBe(false);
    }
    expect(() => mainManifest({ name: "other" }, "9.9.9")).toThrow(/name must be tabcap/);
  });
});

describe("shim generation", () => {
  test("the committed template has one generated block and an empty map", () => {
    const t = shimTemplate();
    expect(t.split(SHIM_BEGIN).length).toBe(2);
    expect(t.split(SHIM_END).length).toBe(2);
    expect(t).toContain(`${SHIM_BEGIN}\nconst PACKAGES = {};\n${SHIM_END}`);
  });
  test("the map is generated from the scope and the result still parses", () => {
    for (const scope of [null, "tabcap"]) {
      const src = shimSource(shimTemplate(), scope);
      new Bun.Transpiler({ loader: "js" }).transformSync(src); // throws on a syntax error
      for (const p of NPM_PLATFORMS) expect(src).toContain(`  "${p}": "${platformPackageName(p, scope)}"`);
      expect(src.split(SHIM_BEGIN).length).toBe(2);
      expect(shimSource(src, scope)).toBe(src); // idempotent
    }
  });
  test("refused without exactly one block", () => {
    expect(() => shimSource("no markers")).toThrow(/exactly one/);
    expect(() => shimSource(`${SHIM_BEGIN}\n${SHIM_END}\n${SHIM_BEGIN}\n${SHIM_END}\n`)).toThrow(/exactly one/);
    expect(() => shimSource(`${SHIM_END}\n${SHIM_BEGIN}\n`)).toThrow(/exactly one/);
  });
});

// A stand-in platform package next to the generated shim, as npm lays them out.
const host = `${process.platform}-${process.arch}`;
const hostPlatform = NPM_PLATFORMS.find((p) => p === host);
describe.skipIf(process.platform === "win32" || hostPlatform === undefined)("shim pass-through (stand-in binary)", () => {
  const install = (dir: string, scope: string | null, script: string | null): string => {
    const nm = join(dir, "node_modules");
    mkdirSync(join(nm, "tabcap", "bin"), { recursive: true });
    const shim = join(nm, "tabcap", "bin", "tabcap.js");
    writeFileSync(shim, shimSource(shimTemplate(), scope));
    if (script !== null && hostPlatform !== undefined) {
      const pkgDir = join(nm, ...platformPackageName(hostPlatform, scope).split("/"));
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: platformPackageName(hostPlatform, scope), version: "9.9.9" }));
      writeFileSync(join(pkgDir, "bin", "tabcap"), `#!/bin/sh\n${script}\n`);
      chmodSync(join(pkgDir, "bin", "tabcap"), 0o755);
    }
    return shim;
  };
  const runShim = (shim: string, args: string[]) => Bun.spawnSync(["bun", shim, ...args], { stdout: "pipe", stderr: "pipe" });

  for (const scope of [null, "tabcap"]) {
    test(`${scope === null ? "unscoped" : "scoped"}: arguments, stdout and the exit code pass through`, () =>
      withTmp((dir) => {
        const shim = install(dir, scope, `printf '%s|' "$@"; [ "$1" = --version ] && echo '{"ok":true,"data":{"tool":"tabcap","version":"9.9.9"}}'; exit 7`);
        const r = runShim(shim, ["--version", "a b", "c"]);
        expect(r.stdout.toString()).toBe('--version|a b|c|{"ok":true,"data":{"tool":"tabcap","version":"9.9.9"}}\n');
        expect(r.exitCode).toBe(7);
      }));
  }
  test("a signal that kills the binary kills the shim the same way", () =>
    withTmp((dir) => {
      const r = runShim(install(dir, null, "kill -TERM $$"), []);
      expect(r.signalCode).toBe("SIGTERM");
    }));
  test("no platform package installed: says which one and exits 1", () =>
    withTmp((dir) => {
      const r = runShim(install(dir, "tabcap", null), ["--version"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toBe(`tabcap: @tabcap/${host} is not installed (were optional dependencies skipped?); reinstall tabcap without --omit=optional / --no-optional.\n`);
    }));
});

describe("binary version check", () => {
  const pkgText = (v: string): string => `var package_default = {\n  name: "tabcap",\n  version: "${v}",\n  private: true\n};`;
  test("embedded package.json versions are read from the bundled object literal", () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(embeddedVersions(enc(`\0\0${pkgText("0.4.0")}\0`))).toEqual(["0.4.0"]);
    expect(embeddedVersions(enc(`${pkgText("0.2.0")}\n${pkgText("0.4.0")}`)).sort()).toEqual(["0.2.0", "0.4.0"]);
    // bun 1.4.2's real layout: the literal sits four spaces deep inside an __esm wrapper
    expect(embeddedVersions(enc(`__esm(() => {\n  package_default = {\n    name: "tabcap",\n    version: "0.7.0",\n    private: true,`))).toEqual(["0.7.0"]);
    expect(embeddedVersions(enc(`{"name":"tabcap","version":"0.4.0"}`))).toEqual([]);
    expect(embeddedVersions(enc(`\n  name: "tabcap",\n  version: "unterminated`))).toEqual([]);
  });
  test("missing, ok, stale (another version) or unknown (no marker)", () =>
    withTmp((dir) => {
      const f = join(dir, "bin");
      expect(binaryState(f, "0.4.0")).toEqual({ state: "missing", found: [] });
      writeFileSync(f, pkgText("0.4.0"));
      expect(binaryState(f, "0.4.0")).toEqual({ state: "ok", found: ["0.4.0"] });
      writeFileSync(f, pkgText("0.2.0"));
      expect(binaryState(f, "0.4.0")).toEqual({ state: "stale", found: ["0.2.0"] });
      writeFileSync(f, "no marker");
      expect(binaryState(f, "0.4.0")).toEqual({ state: "unknown", found: [] });
    }));
});

describe("publish commands", () => {
  const packed = [
    { name: "tabcap-darwin-arm64", version: "0.4.0", tgz: "/d/npm/tabcap-darwin-arm64-0.4.0.tgz", size: 1, unpackedSize: 1, sha256: "" },
    { name: "tabcap", version: "0.4.0", tgz: "/d/npm/tabcap-0.4.0.tgz", size: 1, unpackedSize: 1, sha256: "" },
    { name: "tabcap-win32-x64", version: "0.4.0", tgz: "/d e/tabcap-win32-x64-0.4.0.tgz", size: 1, unpackedSize: 1, sha256: "" },
  ];
  test("whoami first, then the platform packages, tabcap last; the registry named on every line; no provenance", () => {
    const c = publishCommands(packed);
    expect(NPM_REGISTRY).toBe("https://registry.npmjs.org");
    expect(c.publish).toEqual([
      "npm whoami --registry https://registry.npmjs.org",
      "npm publish /d/npm/tabcap-darwin-arm64-0.4.0.tgz --access public --registry https://registry.npmjs.org",
      "npm publish '/d e/tabcap-win32-x64-0.4.0.tgz' --access public --registry https://registry.npmjs.org",
      "npm publish /d/npm/tabcap-0.4.0.tgz --access public --registry https://registry.npmjs.org",
    ]);
    expect(c.verify).toEqual([
      "npm view tabcap-darwin-arm64@0.4.0 version --registry https://registry.npmjs.org",
      "npm view tabcap-win32-x64@0.4.0 version --registry https://registry.npmjs.org",
      "npm view tabcap@0.4.0 version --registry https://registry.npmjs.org",
      "npm view tabcap@0.4.0 optionalDependencies --registry https://registry.npmjs.org",
    ]);
    for (const l of c.publish) expect(l).not.toContain("--provenance");
  });
  test("shell quoting", () => {
    expect(shq("/a/b-1.tgz")).toBe("/a/b-1.tgz");
    expect(shq("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

describe("npm pack --json output", () => {
  const entry = (files: Array<{ path: string; mode: number }>) => JSON.stringify([{ name: "tabcap-linux-x64", version: "0.4.0", filename: "tabcap-linux-x64-0.4.0.tgz", size: 10, unpackedSize: 20, files }]);
  const want = { name: "tabcap-linux-x64", version: "0.4.0", files: ["LICENSE", "bin/tabcap", "package.json"], executable: ["bin/tabcap"] };
  test("one package, the directory's files, the binary executable", () => {
    const e = parsePackJson(entry([{ path: "package.json", mode: 0o644 }, { path: "LICENSE", mode: 0o644 }, { path: "bin/tabcap", mode: 0o755 }]));
    expect(checkPacked(e, want)).toEqual([]);
  });
  test("lost, unexpected and non-executable files are named", () => {
    const e = parsePackJson(entry([{ path: "package.json", mode: 0o644 }, { path: "bin/tabcap", mode: 0o644 }, { path: ".npmrc", mode: 0o644 }]));
    expect(checkPacked(e, { ...want, name: "@tabcap/linux-x64" })).toEqual([
      "name tabcap-linux-x64, want @tabcap/linux-x64",
      "unexpected files .npmrc",
      "files not packed LICENSE",
      "bin/tabcap is not executable in the tarball (mode 644)",
    ]);
  });
  test("anything else is refused, not trusted", () => {
    expect(() => parsePackJson("npm notice\n")).toThrow(/printed no JSON/);
    // npm 12 prints an object keyed by the package name instead of a one-entry array
    const arr = JSON.parse(entry([{ path: "package.json", mode: 0o644 }, { path: "bin/tabcap", mode: 0o755 }])) as unknown[];
    const keyed = JSON.stringify({ [(arr[0] as { name: string }).name]: arr[0] });
    expect(parsePackJson(keyed).files.map((f) => f.path)).toEqual(["package.json", "bin/tabcap"]);
    expect(() => parsePackJson(JSON.stringify({ a: arr[0], b: arr[0] }))).toThrow(/expected one package/);
    expect(() => parsePackJson("[]")).toThrow(/expected one package/);
    expect(() => parsePackJson('[{"name":"x"}]')).toThrow(/missing name/);
    expect(() => parsePackJson(JSON.stringify([{ name: "x", version: "1", filename: "../x.tgz", size: 1, unpackedSize: 1, files: [] }]))).toThrow(/odd filename/);
    expect(() => parsePackJson(JSON.stringify([{ name: "x", version: "1", filename: "x.tgz", size: 1, unpackedSize: 1, files: [{ path: 1 }] }]))).toThrow(/bad files entry/);
  });
});

describe("package layout (stand-in binary)", () => {
  test("platform package: package.json, the binary 0755, LICENSE, NOTICE, a five-line README", () =>
    withTmp((dir) => {
      const fake = join(dir, "fake");
      writeFileSync(fake, "not a real binary\n");
      for (const p of NPM_PLATFORMS) {
        const out = assemblePlatform({ p, version: TOOL_VERSION, binary: fake, outDir: join(dir, "out"), scope: "tabcap" });
        expect(listFiles(out)).toEqual(["LICENSE", "NOTICE", "README.md", platformBinary(p), "package.json"].sort());
        if (process.platform !== "win32") expect(statSync(join(out, platformBinary(p))).mode & 0o777).toBe(0o755);
        expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toMatchObject({ name: `@tabcap/${p}`, version: TOOL_VERSION });
        const readme = readFileSync(join(out, "README.md"), "utf8");
        expect(readme.trimEnd().split("\n").length).toBe(5);
        expect(readme).toBe(platformReadme(p, TOOL_VERSION, "tabcap"));
      }
      expect(() => assemblePlatform({ p: "linux-x64", version: TOOL_VERSION, binary: join(dir, "absent"), outDir: join(dir, "out") })).toThrow(/missing/);
    }));
  test("tabcap package: package.json, the generated shim, LICENSE, NOTICE, README, the skill, the decode template", () =>
    withTmp((dir) => {
      const out = assembleMain({ version: TOOL_VERSION, outDir: dir, scope: null });
      expect(listFiles(out)).toEqual(["LICENSE", "NOTICE", "README.md", "bin/tabcap.js", "package.json", "skills/tabcap/SKILL.md", "skills/tabcap/references/analysis.md", "skills/tabcap/references/commands.md", "skills/tabcap/references/devtools-mcp.md", "skills/tabcap/references/guides.md", "skills/tabcap/references/mcp.md", "skills/tabcap/references/pools.md", "skills/tabcap/references/recording.md", "skills/tabcap/references/replay.md", "skills/tabcap/references/search.md", "skills/tabcap/references/trace-and-probes.md", "templates/plugins/decode-python/config.example.json", "templates/plugins/decode-python/manifest.json", "templates/plugins/decode-python/plugin.py", "templates/plugins/decode-python/pyproject.toml", "templates/plugins/decode-python/runner.py"]);
      expect(readFileSync(join(out, "bin", "tabcap.js"), "utf8")).toBe(shimSource(shimTemplate(), null));
      expect(readFileSync(join(out, "skills", "tabcap", "SKILL.md"), "utf8")).toBe(readFileSync(join(REPO_ROOT, "skills", "tabcap", "SKILL.md"), "utf8"));
    }));
  test("the npm README is the quick start with an install paragraph, without internal wording", () => {
    const r = mainReadme(readFileSync(join(REPO_ROOT, "README.md"), "utf8"), "9.9.9", null);
    expect(r.startsWith("# tabcap 9.9.9\n\nInstalled from npm: `npm install -g tabcap`")).toBe(true);
    expect(r).toContain("`tabcap-win32-x64`");
    expect(r).toContain("\n\n## Quick start\n");
    for (const re of FORBIDDEN) expect(re.test(r)).toBe(false);
  });
});
