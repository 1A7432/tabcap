// `bun run release:darwin-arm64`: build dist/tabcap-darwin-arm64, then lay out
// dist/release/tabcap-v<version>-darwin-arm64/ (binary, skills/tabcap/ in the
// agentskills.io layout, standalone README cut from README.md's quick start,
// LICENSE, NOTICE) and write the
// .tar.gz plus a `shasum -a 256` style .sha256 next to it.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAME, TOOL_VERSION } from "../src/bundle/manifest.ts";

const ROOT = join(import.meta.dir, "..");
const QUICK_START = "## Quick start";
/** Lab / internal words that must not reach the standalone README. */
export const FORBIDDEN = [/同事/, /占位/, /placeholder/i, /\bevidence\//, /逆向/, /Kimi/i];

/** The quick-start section of README.md as a standalone README (generated-table markers stripped). */
export function standaloneReadme(readme: string, version: string): string {
  const start = readme.indexOf(QUICK_START);
  if (start < 0) throw new Error(`README.md has no "${QUICK_START}" section`);
  const next = readme.indexOf("\n## ", start + QUICK_START.length);
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

function run(cmd: string[], env: Record<string, string> = {}): void {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${p.exitCode})`);
}

if (import.meta.main) {
  const target = "darwin-arm64";
  const name = `${TOOL_NAME}-v${TOOL_VERSION}-${target}`;
  const bin = join(ROOT, "dist", `${TOOL_NAME}-${target}`);
  run(["bun", "run", `build:${target}`]);
  if (!existsSync(bin)) throw new Error(`missing ${bin}`);

  const releaseDir = join(ROOT, "dist", "release");
  const dir = join(releaseDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  copyFileSync(bin, join(dir, TOOL_NAME));
  chmodSync(join(dir, TOOL_NAME), 0o755);
  cpSync(join(ROOT, "skills", TOOL_NAME), join(dir, "skills", TOOL_NAME), { recursive: true });
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(ROOT, "NOTICE"), join(dir, "NOTICE"));
  writeFileSync(join(dir, "README.md"), standaloneReadme(readFileSync(join(ROOT, "README.md"), "utf8"), TOOL_VERSION));

  const tgz = `${name}.tar.gz`;
  rmSync(join(releaseDir, tgz), { force: true });
  // COPYFILE_DISABLE: no macOS ._ resource-fork entries in the archive.
  run(["tar", "-czf", join(releaseDir, tgz), "-C", releaseDir, name], { COPYFILE_DISABLE: "1" });
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(releaseDir, tgz))).digest("hex");
  writeFileSync(join(releaseDir, `${tgz}.sha256`), `${hash}  ${tgz}\n`);
  console.log(JSON.stringify({ dir, tarball: join(releaseDir, tgz), sha256: hash }, null, 2));
}
