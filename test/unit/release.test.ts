import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN, PACKAGE_FILES, QUICK_START, TARGETS, assemble, parseArgs, planFor, sha256File, standaloneReadme, tarExe, writeSums, zipCommand } from "../../scripts/release.ts";
import { REPO_ROOT } from "./_fixtures.ts";

describe("release README (install and quick start only)", () => {
  const out = standaloneReadme(readFileSync(join(REPO_ROOT, "README.md"), "utf8"), "9.9.9");
  test("cut from install through the quick start: install, setup, first session, the agent hook-up; nothing after it", () => {
    expect(out.startsWith("# tabcap 9.9.9\n\n## Install\n")).toBe(true);
    expect(out).toContain("\n## Quick start\n");
    for (const s of ["xattr -d com.apple.quarantine tabcap", "tabcap setup", "tabcap daemon start && tabcap browser start", "tabcap net start", "claude mcp add tabcap -- tabcap mcp", "skills/tabcap/"]) expect(out).toContain(s);
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("## What it does");
  });
  test("no lab or internal wording", () => {
    for (const re of FORBIDDEN) expect(re.test(out)).toBe(false);
    expect(() => standaloneReadme("## Quick start\n\nsee evidence/\n", "1")).toThrow();
  });
  test("the Chinese README is cut the same way and passes the same check", () => {
    const zh = standaloneReadme(readFileSync(join(REPO_ROOT, "README.zh-CN.md"), "utf8"), "9.9.9", QUICK_START.zh);
    expect(zh.startsWith("# tabcap 9.9.9\n\n## 安装\n")).toBe(true);
    expect(zh).toContain("\n## 快速开始\n");
    expect(zh).not.toContain("<!--");
    for (const re of FORBIDDEN) expect(re.test(zh)).toBe(false);
    expect(() => standaloneReadme("## 快速开始\n\n占位\n", "1", QUICK_START.zh)).toThrow();
  });
});

describe("release plan (dry run)", () => {
  test("four targets; Windows is a zip with tabcap.exe, the others tar.gz with tabcap", () => {
    expect([...TARGETS]).toEqual(["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"]);
    const plans = TARGETS.map((t) => planFor(t, "1.2.3", "/r"));
    expect(plans.map((p) => p.archive)).toEqual([
      "tabcap-v1.2.3-darwin-arm64.tar.gz",
      "tabcap-v1.2.3-linux-x64.tar.gz",
      "tabcap-v1.2.3-linux-arm64.tar.gz",
      "tabcap-v1.2.3-windows-x64.zip",
    ]);
    expect(plans.map((p) => p.binaryName)).toEqual(["tabcap", "tabcap", "tabcap", "tabcap.exe"]);
    expect(plans[3]?.binary).toBe(join("/r", "dist", "tabcap-windows-x64.exe"));
    expect(plans[1]?.buildCommand).toEqual(["bun", "build", "--compile", "--target=bun-linux-x64", join("/r", "src", "cli", "main.ts"), "--outfile", join("/r", "dist", "tabcap-linux-x64")]);
  });

  test("options", () => {
    expect(parseArgs([])).toEqual({ targets: [...TARGETS], skipBuild: false, sumsOnly: false, dryRun: false });
    expect(parseArgs(["--targets", "linux-x64,windows-x64", "--skip-build"])).toMatchObject({ targets: ["linux-x64", "windows-x64"], skipBuild: true });
    expect(() => parseArgs(["--targets", "linux-mips"])).toThrow("unknown linux-mips");
    expect(() => parseArgs(["--targets"])).toThrow();
    expect(() => parseArgs(["--publish"])).toThrow("unknown option");
  });

  test("Windows packs with the system bsdtar by full path; macOS with bsdtar; Linux with zip", () => {
    expect(tarExe("win32", { SystemRoot: "C:\\Windows" })).toBe(join("C:\\Windows", "System32", "tar.exe"));
    expect(tarExe("linux")).toBe("tar");
    expect(zipCommand("win32", "o.zip", "d", "n").cmd.slice(1)).toEqual(["-a", "-c", "-f", "o.zip", "-C", "d", "n"]);
    expect(zipCommand("darwin", "o.zip", "d", "n").cmd).toEqual(["tar", "--format", "zip", "-cf", "o.zip", "-C", "d", "n"]);
    expect(zipCommand("linux", "o.zip", "d", "n")).toEqual({ cmd: ["zip", "-q", "-r", "o.zip", "n"], cwd: "d" });
  });
});

/** Entry names of an archive (bsdtar lists zip too; GNU tar on Linux does not, so unzip there). */
function listing(archive: string): string[] {
  const zipOnLinux = archive.endsWith(".zip") && process.platform === "linux";
  const cmd = zipOnLinux ? ["unzip", "-Z1", archive] : [tarExe(process.platform), archive.endsWith(".zip") ? "-tf" : "-tzf", archive];
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout
    .toString()
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter((l) => l !== "" && !l.endsWith("/"))
    .sort();
}

describe("release packaging with a stand-in binary", () => {
  for (const target of ["linux-x64", "windows-x64"] as const) {
    test(`${target}: binary, skill, decode template, both READMEs, LICENSE, NOTICE; .sha256 and SHA256SUMS agree`, () => {
      const tmp = mkdtempSync(join(tmpdir(), "tabcap-rel-"));
      try {
        const releaseDir = join(tmp, "release");
        mkdirSync(releaseDir);
        const fake = join(tmp, "fake-bin");
        writeFileSync(fake, "not a real binary\n");
        const plan = planFor(target, "9.9.9", tmp);
        const r = assemble({ plan, version: "9.9.9", releaseDir, root: REPO_ROOT, binary: fake });
        const top = plan.name;
        // the skill ships whole: SKILL.md plus every topic file under references/ (0.5-C)
        const refs = readdirSync(join(REPO_ROOT, "skills", "tabcap", "references")).map((n) => `${top}/skills/tabcap/references/${n}`);
        expect(refs).toContain(`${top}/skills/tabcap/references/commands.md`);
        // and so does the decode plugin template (0.6-T)
        const tpl = readdirSync(join(REPO_ROOT, "templates", "plugins", "decode-python")).map((n) => `${top}/templates/plugins/decode-python/${n}`);
        expect(tpl).toContain(`${top}/templates/plugins/decode-python/runner.py`);
        expect(listing(r.archive)).toEqual([...PACKAGE_FILES.map((f) => `${top}/${f}`), `${top}/${plan.binaryName}`, ...refs, ...tpl].sort());
        expect(readFileSync(`${r.archive}.sha256`, "utf8")).toBe(`${r.sha256}  ${plan.archive}\n`);
        expect(r.sha256).toBe(sha256File(r.archive));
        writeFileSync(join(releaseDir, "tabcap-v0.0.1-linux-x64.tar.gz"), "other version, not listed");
        const sums = writeSums(releaseDir, "9.9.9");
        expect(sums.lines).toEqual([`${r.sha256}  ${plan.archive}`]);
        expect(readFileSync(sums.file, "utf8")).toBe(`${r.sha256}  ${plan.archive}\n`);
        expect(readFileSync(join(r.dir, "README.md"), "utf8").startsWith("# tabcap 9.9.9\n\n## Quick start\n")).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
