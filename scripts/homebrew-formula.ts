// Render the Homebrew formula for one release:
//   bun scripts/homebrew-formula.ts --version 0.7.2 --sums SHA256SUMS [--out Formula/tabcap.rb]
// The template is packaging/homebrew/tabcap.rb ({{VERSION}}, {{SHA256_<TARGET>}}); the
// checksums come from the release's SHA256SUMS (`<sha256>  tabcap-v<version>-<target>.tar.gz`,
// written by scripts/release.ts). .github/workflows/homebrew.yml runs this for every
// published release and pushes the result to the tap. Pure functions are exported for
// test/unit/homebrew-formula.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const TEMPLATE = join(ROOT, "packaging", "homebrew", "tabcap.rb");

/** Release targets the formula needs, with their placeholder names. */
export const FORMULA_TARGETS = {
  "darwin-arm64": "SHA256_DARWIN_ARM64",
  "linux-x64": "SHA256_LINUX_X64",
  "linux-arm64": "SHA256_LINUX_ARM64",
} as const;

/** Pure: `<sha256>  <file>` lines → file → sha256 (lowercase); other lines are ignored. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[2] !== undefined) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Pure: the formula for `version` from the template and the release's checksums; throws when one is missing. */
export function renderFormula(template: string, version: string, sums: Map<string, string>): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be major.minor.patch, got ${JSON.stringify(version)}`);
  let out = template.replaceAll("{{VERSION}}", version);
  for (const [target, key] of Object.entries(FORMULA_TARGETS)) {
    const file = `tabcap-v${version}-${target}.tar.gz`;
    const sha = sums.get(file);
    if (sha === undefined) throw new Error(`SHA256SUMS has no line for ${file}`);
    out = out.replaceAll(`{{${key}}}`, sha);
  }
  const left = /\{\{[A-Z0-9_]+\}\}/.exec(out);
  if (left !== null) throw new Error(`placeholder ${left[0]} is not filled`);
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const version = arg("--version");
  const sumsPath = arg("--sums");
  if (version === undefined || sumsPath === undefined) {
    console.error("usage: bun scripts/homebrew-formula.ts --version <x.y.z> --sums <SHA256SUMS> [--template <file>] [--out <file>]");
    process.exit(2);
  }
  const formula = renderFormula(readFileSync(arg("--template") ?? TEMPLATE, "utf8"), version, parseSums(readFileSync(sumsPath, "utf8")));
  const out = arg("--out");
  if (out === undefined) process.stdout.write(formula);
  else {
    writeFileSync(out, formula);
    console.error(`wrote ${out} (tabcap ${version})`);
  }
}
