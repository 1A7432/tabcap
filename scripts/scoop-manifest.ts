// Render the Scoop manifest for one published release:
//   bun scripts/scoop-manifest.ts --version 0.8.1 --sums SHA256SUMS [--manifest <file>] [--out <file>]
// packaging/scoop/tabcap.json is the manifest of the last PUBLISHED release: its
// version and the windows-x64 zip's url, hash and extract_dir all come from that
// release's SHA256SUMS (`<sha256>  tabcap-v<version>-windows-x64.zip`, written by
// scripts/release.ts); every other field is kept as it is. A release commit leaves
// the file alone: .github/workflows/homebrew.yml runs this for every published
// release and commits the result to main. A version older than the manifest's is
// not written (re-running the workflow for an old tag must not roll main back).
// Pure functions are exported for test/unit/scoop-manifest.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/shared/json.ts";
import { parseSums } from "./homebrew-formula.ts";
import { planFor } from "./release.ts";

const ROOT = join(import.meta.dir, "..");
export const MANIFEST = join(ROOT, "packaging", "scoop", "tabcap.json");
export const RELEASES = "https://github.com/1A7432/tabcap/releases/download";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Pure: -1 / 0 / 1 for a < b / a = b / a > b; throws when either is not major.minor.patch. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (pa === null || pb === null) throw new Error(`version must be major.minor.patch, got ${JSON.stringify(pa === null ? a : b)}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Pure: the manifest's object and its architecture.64bit block; throws on anything else. */
function parseManifest(text: string): { m: Record<string, unknown>; x64: Record<string, unknown>; arch: Record<string, unknown> } {
  const m: unknown = JSON.parse(text);
  if (!isRecord(m)) throw new Error("the Scoop manifest is not a JSON object");
  const arch = m["architecture"];
  if (!isRecord(arch)) throw new Error("the Scoop manifest has no architecture object");
  const x64 = arch["64bit"];
  if (!isRecord(x64)) throw new Error("the Scoop manifest has no architecture.64bit object");
  return { m, x64, arch };
}

/** Pure: the manifest's own version (major.minor.patch); throws when it has none. */
export function manifestVersion(text: string): string {
  const v = parseManifest(text).m["version"];
  if (typeof v !== "string" || !VERSION.test(v)) throw new Error(`the Scoop manifest's version is not major.minor.patch: ${JSON.stringify(v)}`);
  return v;
}

/** Pure: the manifest for `version` from the current one and the release's checksums; throws when the zip's line is missing. */
export function renderScoopManifest(current: string, version: string, sums: Map<string, string>): string {
  if (!VERSION.test(version)) throw new Error(`version must be major.minor.patch, got ${JSON.stringify(version)}`);
  const { m, x64, arch } = parseManifest(current);
  const plan = planFor("windows-x64", version);
  const hash = sums.get(plan.archive);
  if (hash === undefined) throw new Error(`SHA256SUMS has no line for ${plan.archive}`);
  m["version"] = version;
  // Existing keys keep their place, so the diff on main is the four values.
  arch["64bit"] = { ...x64, url: `${RELEASES}/v${version}/${plan.archive}`, hash, extract_dir: plan.name };
  return JSON.stringify(m, null, 4) + "\n";
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const version = arg("--version");
  const sumsPath = arg("--sums");
  if (version === undefined || sumsPath === undefined) {
    console.error("usage: bun scripts/scoop-manifest.ts --version <x.y.z> --sums <SHA256SUMS> [--manifest <file>] [--out <file>]");
    process.exit(2);
  }
  const current = readFileSync(arg("--manifest") ?? MANIFEST, "utf8");
  const have = manifestVersion(current);
  if (compareVersions(version, have) < 0) {
    console.error(`the Scoop manifest already has ${have}, newer than ${version}: nothing written`);
    process.exit(0);
  }
  const manifest = renderScoopManifest(current, version, parseSums(readFileSync(sumsPath, "utf8")));
  const out = arg("--out");
  if (out === undefined) process.stdout.write(manifest);
  else {
    writeFileSync(out, manifest);
    console.error(`wrote ${out} (tabcap ${version})`);
  }
}
