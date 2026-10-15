// Release packaging (nothing is published from here).
//
//   bun scripts/release.ts                         build all four binaries, package each, write SHA256SUMS
//   bun scripts/release.ts --targets linux-x64     only these targets (comma list)
//   bun scripts/release.ts --skip-build            package binaries already in dist/
//   bun scripts/release.ts --sums-only             only (re)write dist/release/SHA256SUMS
//   bun scripts/release.ts --dry-run               print the plan as JSON, touch nothing
//
// Per target: `bun build --compile --target=bun-<target>` → dist/tabcap-<target>[.exe];
// then dist/release/tabcap-v<version>-<target>/ holds the binary (tabcap or
// tabcap.exe), skills/tabcap/ (agentskills.io layout), README.md and
// README.zh-CN.md (the quick-start sections only, generated-table markers
// stripped, checked for internal wording), LICENSE and NOTICE; it is packed as
// .tar.gz (zip for Windows) with a `shasum -a 256` style .sha256 next to it.
// SHA256SUMS lists every package of this version in dist/release/.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAME, TOOL_VERSION } from "../src/bundle/manifest.ts";

const ROOT = join(import.meta.dir, "..");

export const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(v: string): v is Target {
  return (TARGETS as readonly string[]).includes(v);
}

/** Lab / internal words that must not reach the standalone READMEs. */
export const FORBIDDEN = [/同事/, /占位/, /placeholder/i, /\bevidence\//, /逆向/, /Kimi/i];

export const QUICK_START = { en: "## Quick start", zh: "## 快速开始" } as const;

/** The quick-start section of a README as a standalone README (generated-table markers stripped). */
export function standaloneReadme(readme: string, version: string, heading: string = QUICK_START.en): string {
  const start = readme.indexOf(heading);
  if (start < 0) throw new Error(`README has no "${heading}" section`);
  const next = readme.indexOf("\n## ", start + heading.length);
  const section = readme.slice(start, next < 0 ? undefined : next).trimEnd();
  const body = section
    .split("\n")
    .filter((l) => !/^<!-- (BEGIN|END) GENERATED: /.test(l))
    .join("\n");
  const out = `# ${TOOL_NAME} ${version}\n\n${body}\n`;
  const bad = FORBIDDEN.filter((re) => re.test(out));
  if (bad.length > 0) throw new Error(`standalone README contains internal wording: ${bad.map(String).join(", ")}`);
  return out;
}

export type Plan = {
  target: Target;
  /** Built binary in dist/. */
  binary: string;
  /** Name of the binary inside the package. */
  binaryName: string;
  /** Package directory name, also the archive's top-level directory. */
  name: string;
  archive: string;
  kind: "tar.gz" | "zip";
  buildCommand: string[];
};

/** Pure: what one target produces. */
export function planFor(target: Target, version: string, root: string = ROOT): Plan {
  const win = target.startsWith("windows-");
  const exe = win ? ".exe" : "";
  const binary = join(root, "dist", `${TOOL_NAME}-${target}${exe}`);
  const name = `${TOOL_NAME}-v${version}-${target}`;
  const kind = win ? "zip" : "tar.gz";
  return {
    target,
    binary,
    binaryName: `${TOOL_NAME}${exe}`,
    name,
    archive: `${name}.${kind}`,
    kind,
    buildCommand: ["bun", "build", "--compile", `--target=bun-${target}`, join(root, "src", "cli", "main.ts"), "--outfile", binary],
  };
}

/** Files every package carries besides the binary (paths inside the package). */
export const PACKAGE_FILES = ["README.md", "README.zh-CN.md", "LICENSE", "NOTICE", `skills/${TOOL_NAME}/SKILL.md`] as const;

function run(cmd: string[], o: { cwd?: string; env?: Record<string, string> } = {}): void {
  const p = Bun.spawnSync(cmd, { cwd: o.cwd ?? ROOT, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...(o.env ?? {}) } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${p.exitCode})`);
}

/**
 * The tar to use. On Windows the system bsdtar (Windows 10+), by full path: a
 * GNU tar from Git for Windows may come first on PATH, cannot write zip and
 * reads "C:" in a path as a remote host.
 */
export function tarExe(host: NodeJS.Platform, env: Record<string, string | undefined> = process.env): string {
  return host === "win32" ? join(env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

/** How to write a zip of `dir/name` on this host. */
export function zipCommand(host: NodeJS.Platform, zip: string, dir: string, name: string): { cmd: string[]; cwd: string } {
  // bsdtar writes zip archives: tar.exe on Windows 10+, /usr/bin/tar on macOS.
  if (host === "win32") return { cmd: [tarExe(host), "-a", "-c", "-f", zip, "-C", dir, name], cwd: dir };
  if (host === "darwin") return { cmd: ["tar", "--format", "zip", "-cf", zip, "-C", dir, name], cwd: dir };
  return { cmd: ["zip", "-q", "-r", zip, name], cwd: dir };
}

export function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Lay out and pack one package from an already built binary. `releaseDir`
 * receives the directory, the archive and its .sha256. Returns the archive path and hash.
 */
export function assemble(o: { plan: Plan; version: string; releaseDir: string; root?: string; binary?: string }): { dir: string; archive: string; sha256: string } {
  const root = o.root ?? ROOT;
  const bin = o.binary ?? o.plan.binary;
  if (!existsSync(bin)) throw new Error(`missing ${bin}; build it first`);
  const dir = join(o.releaseDir, o.plan.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  copyFileSync(bin, join(dir, o.plan.binaryName));
  chmodSync(join(dir, o.plan.binaryName), 0o755);
  cpSync(join(root, "skills", TOOL_NAME), join(dir, "skills", TOOL_NAME), { recursive: true });
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(root, "NOTICE"), join(dir, "NOTICE"));
  writeFileSync(join(dir, "README.md"), standaloneReadme(readFileSync(join(root, "README.md"), "utf8"), o.version, QUICK_START.en));
  writeFileSync(join(dir, "README.zh-CN.md"), standaloneReadme(readFileSync(join(root, "README.zh-CN.md"), "utf8"), o.version, QUICK_START.zh));

  const archive = join(o.releaseDir, o.plan.archive);
  rmSync(archive, { force: true });
  if (o.plan.kind === "zip") {
    const z = zipCommand(process.platform, archive, o.releaseDir, o.plan.name);
    run(z.cmd, { cwd: z.cwd });
  } else {
    // COPYFILE_DISABLE: no macOS ._ resource-fork entries in the archive.
    run([tarExe(process.platform), "-czf", archive, "-C", o.releaseDir, o.plan.name], { cwd: o.releaseDir, env: { COPYFILE_DISABLE: "1" } });
  }
  const sha256 = sha256File(archive);
  writeFileSync(`${archive}.sha256`, `${sha256}  ${o.plan.archive}\n`);
  return { dir, archive, sha256 };
}

/** SHA256SUMS over every package of `version` in `releaseDir`, sorted by name. */
export function writeSums(releaseDir: string, version: string): { file: string; lines: string[] } {
  const prefix = `${TOOL_NAME}-v${version}-`;
  const lines = readdirSync(releaseDir)
    .filter((f) => f.startsWith(prefix) && (f.endsWith(".tar.gz") || f.endsWith(".zip")))
    .sort()
    .map((f) => `${sha256File(join(releaseDir, f))}  ${f}`);
  const file = join(releaseDir, "SHA256SUMS");
  writeFileSync(file, lines.length === 0 ? "" : lines.join("\n") + "\n");
  return { file, lines };
}

export type Options = { targets: Target[]; skipBuild: boolean; sumsOnly: boolean; dryRun: boolean };

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = { targets: [...TARGETS], skipBuild: false, sumsOnly: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-build") o.skipBuild = true;
    else if (a === "--sums-only") o.sumsOnly = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--targets") {
      const list = (argv[++i] ?? "").split(",").filter((x) => x !== "");
      const bad = list.filter((x) => !isTarget(x));
      if (list.length === 0 || bad.length > 0) throw new Error(`--targets: unknown ${bad.join(", ") || "(empty)"}; use ${TARGETS.join(", ")}`);
      o.targets = list.filter(isTarget);
    } else throw new Error(`unknown option ${a ?? ""}`);
  }
  return o;
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  const releaseDir = join(ROOT, "dist", "release");
  const plans = o.targets.map((t) => planFor(t, TOOL_VERSION));
  if (o.dryRun) {
    console.log(JSON.stringify({ version: TOOL_VERSION, releaseDir, plans, files: PACKAGE_FILES, sums: join(releaseDir, "SHA256SUMS") }, null, 2));
  } else {
    mkdirSync(releaseDir, { recursive: true });
    const built: Array<{ target: Target; archive: string; sha256: string }> = [];
    if (!o.sumsOnly) {
      for (const plan of plans) {
        if (!o.skipBuild) run(plan.buildCommand);
        const r = assemble({ plan, version: TOOL_VERSION, releaseDir });
        built.push({ target: plan.target, archive: r.archive, sha256: r.sha256 });
      }
    }
    const sums = writeSums(releaseDir, TOOL_VERSION);
    console.log(JSON.stringify({ version: TOOL_VERSION, packages: built, sums: sums.file, listed: sums.lines.length }, null, 2));
  }
}
