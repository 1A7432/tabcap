// npm packaging (nothing is published from here; the owner runs `npm publish`).
//
//   bun run npm:pack                               all four platform packages and the tabcap package
//   bun run npm:pack --targets darwin-arm64        only these platform packages (comma list; npm or release
//                                                  names, windows-x64 = win32-x64); tabcap is always packed
//   bun run npm:pack --version 0.4.0               refuse unless package.json and every template say 0.4.0
//
// Binaries come from dist/tabcap-<release target>[.exe] (scripts/release.ts
// layout). A binary that is missing, or whose embedded package.json version is
// not this version, is (re)built with release.ts's own commands: the four wire
// binaries first (`bun scripts/native.ts build`), then `bun build --compile`.
// The host's binary must also answer `--version` with this version.
//
// Per platform, dist/npm/tabcap-<os>-<cpu>/ holds package.json (the template in
// packaging/npm/platforms/<os>-<cpu>/ with the name from NPM_SCOPE), bin/tabcap
// (bin/tabcap.exe on Windows, mode 0755), LICENSE, NOTICE and a five-line
// README.md. dist/npm/tabcap/ holds package.json (template plus one optional
// dependency per platform package), bin/tabcap.js (the shim with its PACKAGES
// map generated from NPM_SCOPE), LICENSE, NOTICE, README.md (the README's
// quick start with an npm install paragraph) and skills/tabcap/. Each directory
// is packed with `npm pack --json --offline --ignore-scripts --no-update-notifier`
// into dist/npm/ (no registry contact), the packed file list is checked against
// the directory, dist/npm/SHA256SUMS lists the tarballs, and the publish and
// verify commands are printed.
// packaging/npm/README.md is the publish runbook.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TOOL_NAME, TOOL_VERSION } from "../src/bundle/manifest.ts";
import { isRecord } from "../src/shared/json.ts";
import { NATIVE_BUILD_COMMAND, QUICK_START, planFor, run, sha256File, standaloneReadme, type Target } from "./release.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * The one switch for the platform package names. null: unscoped
 * `tabcap-<os>-<cpu>` (the default; `tabcap` itself was free on the registry
 * on 2026-10-16). Set it to "tabcap" only if you own the @tabcap scope on npm:
 * the names become `@tabcap/<os>-<cpu>`, in the platform package.json files,
 * the tabcap package's optionalDependencies and the shim alike.
 */
export const NPM_SCOPE: string | null = null;

/** The registry the printed commands name explicitly (a default registry may be a mirror). */
export const NPM_REGISTRY = "https://registry.npmjs.org";

export const NPM_PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"] as const;
export type NpmPlatform = (typeof NPM_PLATFORMS)[number];

/** npm `<process.platform>-<process.arch>` ↔ scripts/release.ts target. */
export const RELEASE_TARGET: Record<NpmPlatform, Target> = {
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
};

const LABEL: Record<NpmPlatform, string> = {
  "darwin-arm64": "macOS arm64",
  "linux-x64": "Linux x64",
  "linux-arm64": "Linux arm64",
  "win32-x64": "Windows x64",
};

export function isNpmPlatform(v: string): v is NpmPlatform {
  return (NPM_PLATFORMS as readonly string[]).includes(v);
}

/** npm name of a platform package. */
export function platformPackageName(p: NpmPlatform, scope: string | null = NPM_SCOPE): string {
  return scope === null ? `${TOOL_NAME}-${p}` : `@${scope}/${p}`;
}

/** Directory of a platform package under dist/npm (the same for scoped and unscoped names). */
export function platformDirName(p: NpmPlatform): string {
  return `${TOOL_NAME}-${p}`;
}

/** Path of the binary inside a platform package. */
export function platformBinary(p: NpmPlatform): string {
  return p.startsWith("win32-") ? `bin/${TOOL_NAME}.exe` : `bin/${TOOL_NAME}`;
}

/** One npm or release target name → npm platform; null if unknown. */
export function toNpmPlatform(v: string): NpmPlatform | null {
  if (isNpmPlatform(v)) return v;
  for (const p of NPM_PLATFORMS) if (RELEASE_TARGET[p] === v) return p;
  return null;
}

export type Options = { targets: NpmPlatform[]; version: string | null };

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = { targets: [...NPM_PLATFORMS], version: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--targets") {
      const list = (argv[++i] ?? "").split(",").filter((x) => x !== "");
      const mapped = list.map(toNpmPlatform);
      const bad = list.filter((_, k) => mapped[k] === null);
      if (list.length === 0 || bad.length > 0) throw new Error(`--targets: unknown ${bad.join(", ") || "(empty)"}; use ${NPM_PLATFORMS.join(", ")}`);
      o.targets = NPM_PLATFORMS.filter((p) => mapped.includes(p));
    } else if (a === "--version") {
      const v = argv[++i] ?? "";
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`--version: not a version: ${v || "(empty)"}`);
      o.version = v;
    } else throw new Error(`unknown option ${a ?? ""}`);
  }
  return o;
}

/**
 * The version to pack: package.json's. Refuses when --version names another
 * one or any template's version differs (bump the templates with package.json).
 */
export function checkVersions(version: string, requested: string | null, templates: ReadonlyArray<{ path: string; version: unknown }>): string {
  const problems: string[] = [];
  if (requested !== null && requested !== version) problems.push(`--version ${requested} but package.json says ${version}`);
  for (const t of templates) if (t.version !== version) problems.push(`${t.path} has version ${JSON.stringify(t.version)}, package.json ${version}`);
  if (problems.length > 0) throw new Error(`version mismatch:\n  ${problems.join("\n  ")}`);
  return version;
}

/** A template package.json as an object; throws on anything else. */
export function readTemplate(path: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(v)) throw new Error(`${path} is not a JSON object`);
  return v;
}

/** Platform package.json: name from the scope, then the template (whose version was checked). */
export function platformManifest(template: Record<string, unknown>, p: NpmPlatform, version: string, scope: string | null = NPM_SCOPE): Record<string, unknown> {
  const { name: _name, version: _version, ...rest } = template;
  return { name: platformPackageName(p, scope), version, ...rest };
}

/** tabcap package.json: the template plus one optional dependency per platform package, all at this version. */
export function mainManifest(template: Record<string, unknown>, version: string, scope: string | null = NPM_SCOPE): Record<string, unknown> {
  if (template["name"] !== TOOL_NAME) throw new Error(`packaging/npm/tabcap/package.json: name must be ${TOOL_NAME}`);
  const { optionalDependencies: _deps, version: _version, name: _name, ...rest } = template;
  const optionalDependencies: Record<string, string> = {};
  for (const p of NPM_PLATFORMS) optionalDependencies[platformPackageName(p, scope)] = version;
  return { name: TOOL_NAME, version, ...rest, optionalDependencies };
}

/** The `files` the tabcap package needs: the shim, the skill, the decode plugin template, NOTICE (npm adds package.json, README, LICENSE itself). */
export const MAIN_FILES = ["bin/", "skills/", "templates/", "NOTICE"] as const;
/** The `files` a platform package needs. */
export const PLATFORM_FILES = ["bin/", "NOTICE"] as const;

/** Every `need` entry is in a manifest's `files`; returns the missing ones. */
export function missingFiles(manifest: Record<string, unknown>, need: readonly string[]): string[] {
  const files = manifest["files"];
  const have = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  return need.filter((f) => !have.includes(f));
}

export const SHIM_BEGIN = "// BEGIN GENERATED: packages (scripts/npm-pack.ts)";
export const SHIM_END = "// END GENERATED: packages";

/** The shim with its PACKAGES map generated from the scope (exactly one marked block in the template). */
export function shimSource(template: string, scope: string | null = NPM_SCOPE): string {
  const start = template.indexOf(SHIM_BEGIN);
  const end = template.indexOf(SHIM_END);
  if (start < 0 || end < start || template.indexOf(SHIM_BEGIN, start + 1) >= 0 || template.indexOf(SHIM_END, end + 1) >= 0) {
    throw new Error("shim template must hold exactly one BEGIN / END GENERATED: packages block");
  }
  const map: Record<string, string> = {};
  for (const p of NPM_PLATFORMS) map[p] = platformPackageName(p, scope);
  const block = `${SHIM_BEGIN}\nconst PACKAGES = ${JSON.stringify(map, null, 2)};\n`;
  return template.slice(0, start) + block + template.slice(end);
}

/** README of a platform package: five lines. */
export function platformReadme(p: NpmPlatform, version: string, scope: string | null = NPM_SCOPE): string {
  return [
    `# ${platformPackageName(p, scope)}`,
    "",
    `The ${TOOL_NAME} ${version} binary for ${LABEL[p]} (\`${platformBinary(p)}\`).`,
    `Installed by the \`${TOOL_NAME}\` package as an optional dependency; install that instead: \`npm install -g ${TOOL_NAME}\`.`,
    `Apache-2.0 (LICENSE, NOTICE). Source and documentation: https://github.com/1A7432/tabcap`,
  ].join("\n") + "\n";
}

/** README of the tabcap package: the README's quick start with an npm paragraph under the title. */
export function mainReadme(readme: string, version: string, scope: string | null = NPM_SCOPE): string {
  const base = standaloneReadme(readme, version, QUICK_START.en);
  const head = `# ${TOOL_NAME} ${version}\n\n`;
  if (!base.startsWith(head)) throw new Error("standalone README has an unexpected title");
  const names = NPM_PLATFORMS.map((p) => `\`${platformPackageName(p, scope)}\``);
  const para =
    `Installed from npm: \`npm install -g ${TOOL_NAME}\` puts \`${TOOL_NAME}\` on your PATH; npm installs the binary for your platform ` +
    `from one optional dependency (${names.slice(0, -1).join(", ")} or ${names[names.length - 1] ?? ""}), so do not install with \`--omit=optional\`. ` +
    `The skill ships in this package: \`$(npm root -g)/${TOOL_NAME}/skills/${TOOL_NAME}/\`. Step 1 below is then done.`;
  return head + para + "\n\n" + base.slice(head.length);
}

/**
 * Versions in a compiled binary's embedded package.json (bun bundles it as an
 * object literal: `name: "tabcap",` then, after whitespace, `version: "…",`;
 * the indentation depends on the bun version). Empty when the marker is not
 * found (an unknown layout, not proof of a stale binary).
 */
export function embeddedVersions(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // bun 1.4 nests the literal in an __esm wrapper, so the indentation varies
  // (2 or 4 spaces): match `name: "tabcap",`, skip whitespace, then `version: "`.
  const head = Buffer.from(`name: "${TOOL_NAME}",`, "latin1");
  const tail = Buffer.from(`version: "`, "latin1");
  const out = new Set<string>();
  for (let i = buf.indexOf(head); i >= 0; i = buf.indexOf(head, i + head.length)) {
    let from = i + head.length;
    while (from < buf.length && (buf[from] === 0x20 || buf[from] === 0x0a || buf[from] === 0x0d || buf[from] === 0x09)) from++;
    if (buf.compare(tail, 0, tail.length, from, from + tail.length) !== 0) continue;
    from += tail.length;
    const quote = buf.indexOf(0x22, from);
    if (quote < 0 || quote - from > 64) continue;
    out.add(buf.toString("latin1", from, quote));
  }
  return [...out];
}

export type BinaryState = "ok" | "missing" | "stale" | "unknown";

/** Whether a dist binary can be packed as `version`. */
export function binaryState(path: string, version: string): { state: BinaryState; found: string[] } {
  if (!existsSync(path)) return { state: "missing", found: [] };
  const found = embeddedVersions(readFileSync(path));
  if (found.length === 0) return { state: "unknown", found };
  return { state: found.every((v) => v === version) ? "ok" : "stale", found };
}

/** POSIX shell quoting for printed commands. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./@:=+,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

export type Packed = { name: string; version: string; tgz: string; size: number; unpackedSize: number; sha256: string };

/** What to paste, in order: who am I, the platform packages, then tabcap; then the checks. */
export function publishCommands(packed: readonly Packed[], registry: string = NPM_REGISTRY): { publish: string[]; verify: string[] } {
  const main = packed.filter((p) => p.name === TOOL_NAME);
  const platforms = packed.filter((p) => p.name !== TOOL_NAME);
  const publish = [`npm whoami --registry ${registry}`, ...[...platforms, ...main].map((p) => `npm publish ${shq(p.tgz)} --access public --registry ${registry}`)];
  const verify = [...platforms, ...main].map((p) => `npm view ${p.name}@${p.version} version --registry ${registry}`);
  for (const p of main) verify.push(`npm view ${p.name}@${p.version} optionalDependencies --registry ${registry}`);
  return { publish, verify };
}

/** Files under `dir`, relative, `/`-separated, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Lay out one platform package from a built binary. */
export function assemblePlatform(o: { p: NpmPlatform; version: string; binary: string; outDir: string; root?: string; scope?: string | null }): string {
  const root = o.root ?? ROOT;
  const scope = o.scope === undefined ? NPM_SCOPE : o.scope;
  const template = readTemplate(join(root, "packaging", "npm", "platforms", o.p, "package.json"));
  const manifest = platformManifest(template, o.p, o.version, scope);
  const miss = missingFiles(manifest, PLATFORM_FILES);
  if (miss.length > 0) throw new Error(`packaging/npm/platforms/${o.p}/package.json: files lacks ${miss.join(", ")}`);
  if (!existsSync(o.binary)) throw new Error(`missing ${o.binary}; build it first`);
  const dir = join(o.outDir, platformDirName(o.p));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bin = join(dir, platformBinary(o.p));
  copyFileSync(o.binary, bin);
  chmodSync(bin, 0o755);
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(root, "NOTICE"), join(dir, "NOTICE"));
  writeFileSync(join(dir, "README.md"), platformReadme(o.p, o.version, scope));
  return dir;
}

/** Lay out the tabcap package. */
export function assembleMain(o: { version: string; outDir: string; root?: string; scope?: string | null }): string {
  const root = o.root ?? ROOT;
  const scope = o.scope === undefined ? NPM_SCOPE : o.scope;
  const tpl = join(root, "packaging", "npm", TOOL_NAME);
  const manifest = mainManifest(readTemplate(join(tpl, "package.json")), o.version, scope);
  const miss = missingFiles(manifest, MAIN_FILES);
  if (miss.length > 0) throw new Error(`packaging/npm/${TOOL_NAME}/package.json: files lacks ${miss.join(", ")}`);
  const dir = join(o.outDir, TOOL_NAME);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "bin", `${TOOL_NAME}.js`), shimSource(readFileSync(join(tpl, "bin", `${TOOL_NAME}.js`), "utf8"), scope));
  chmodSync(join(dir, "bin", `${TOOL_NAME}.js`), 0o755);
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(root, "NOTICE"), join(dir, "NOTICE"));
  writeFileSync(join(dir, "README.md"), mainReadme(readFileSync(join(root, "README.md"), "utf8"), o.version, scope));
  cpSync(join(root, "skills", TOOL_NAME), join(dir, "skills", TOOL_NAME), { recursive: true });
  cpSync(join(root, "templates", "plugins", "decode-python"), join(dir, "templates", "plugins", "decode-python"), { recursive: true });
  return dir;
}

type PackEntry = { name: string; version: string; filename: string; size: number; unpackedSize: number; files: Array<{ path: string; mode: number }> };

/** The one entry of `npm pack --json` output (untrusted text); throws on anything else. */
export function parsePackJson(text: string): PackEntry {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`npm pack --json printed no JSON: ${text.slice(0, 200)}`);
  }
  const e: unknown = Array.isArray(v) && v.length === 1 ? v[0] : null;
  if (!isRecord(e)) throw new Error("npm pack --json: expected one package");
  const { name, version, filename, size, unpackedSize, files } = e;
  if (typeof name !== "string" || typeof version !== "string" || typeof filename !== "string" || typeof size !== "number" || typeof unpackedSize !== "number" || !Array.isArray(files)) {
    throw new Error("npm pack --json: missing name / version / filename / size / files");
  }
  const list: Array<{ path: string; mode: number }> = [];
  for (const f of files) {
    if (!isRecord(f) || typeof f["path"] !== "string" || typeof f["mode"] !== "number") throw new Error("npm pack --json: bad files entry");
    list.push({ path: f["path"], mode: f["mode"] });
  }
  if (filename.includes("/") || filename.includes("\\") || !filename.endsWith(".tgz")) throw new Error(`npm pack --json: odd filename ${filename}`);
  return { name, version, filename, size, unpackedSize, files: list };
}

/**
 * The packed tarball matches the directory: same name and version, the same
 * files, and `executable` files with an executable mode.
 */
export function checkPacked(e: PackEntry, want: { name: string; version: string; files: string[]; executable: string[] }): string[] {
  const problems: string[] = [];
  if (e.name !== want.name) problems.push(`name ${e.name}, want ${want.name}`);
  if (e.version !== want.version) problems.push(`version ${e.version}, want ${want.version}`);
  const got = e.files.map((f) => f.path).sort();
  const extra = got.filter((f) => !want.files.includes(f));
  const lost = want.files.filter((f) => !got.includes(f));
  if (extra.length > 0) problems.push(`unexpected files ${extra.join(", ")}`);
  if (lost.length > 0) problems.push(`files not packed ${lost.join(", ")}`);
  for (const x of want.executable) {
    const m = e.files.find((f) => f.path === x)?.mode;
    if (m === undefined || (m & 0o111) === 0) problems.push(`${x} is not executable in the tarball (mode ${m === undefined ? "?" : m.toString(8)})`);
  }
  return problems;
}

function npmPack(dir: string, dest: string): PackEntry {
  const npm = Bun.which("npm");
  if (npm === null) throw new Error("npm not found on PATH");
  const p = Bun.spawnSync([npm, "pack", "--json", "--offline", "--ignore-scripts", "--no-update-notifier", "--pack-destination", dest], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`npm pack in ${dir} failed (${p.exitCode}): ${p.stderr.toString().slice(0, 500)}`);
  return parsePackJson(p.stdout.toString());
}

/** `<binary> --version` → the version in its JSON envelope, or null. */
function runVersion(binary: string): string | null {
  const p = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(p.stdout.toString());
  } catch {
    return null;
  }
  const data = isRecord(v) ? v["data"] : null;
  return isRecord(data) && typeof data["version"] === "string" ? data["version"] : null;
}

function hostPlatform(): NpmPlatform | null {
  const k = `${process.platform}-${process.arch}`;
  return isNpmPlatform(k) ? k : null;
}

if (import.meta.main) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const templates = [join("packaging", "npm", TOOL_NAME, "package.json"), ...NPM_PLATFORMS.map((p) => join("packaging", "npm", "platforms", p, "package.json"))].map((path) => ({
      path,
      version: readTemplate(join(ROOT, path))["version"],
    }));
    const version = checkVersions(TOOL_VERSION, o.version, templates);

    // Binaries: build what is missing or carries another version, with release.ts's commands.
    const plans = o.targets.map((p) => ({ p, plan: planFor(RELEASE_TARGET[p], version) }));
    const todo = plans.filter(({ plan }) => binaryState(plan.binary, version).state !== "ok");
    for (const { plan } of todo) {
      const s = binaryState(plan.binary, version);
      console.error(`npm-pack: ${relative(ROOT, plan.binary)} is ${s.state}${s.found.length > 0 ? ` (${s.found.join(", ")})` : ""}; building`);
    }
    if (todo.length > 0) {
      run(NATIVE_BUILD_COMMAND);
      for (const { plan } of todo) run(plan.buildCommand);
    }
    for (const { p, plan } of plans) {
      const s = binaryState(plan.binary, version);
      if (s.state === "stale" || s.state === "missing") throw new Error(`${relative(ROOT, plan.binary)} is still ${s.state} (${s.found.join(", ")}) after the build`);
      if (s.state === "unknown") console.error(`npm-pack: warning: no embedded version found in ${relative(ROOT, plan.binary)} (built just now: ${todo.some((t) => t.p === p)})`);
      if (p === hostPlatform()) {
        const v = runVersion(plan.binary);
        if (v !== version) throw new Error(`${relative(ROOT, plan.binary)} --version says ${v ?? "(nothing)"}, want ${version}`);
      }
    }

    const outDir = join(ROOT, "dist", "npm");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const packed: Packed[] = [];
    const pack = (dir: string, name: string, executable: string[]): void => {
      const e = npmPack(dir, outDir);
      const problems = checkPacked(e, { name, version, files: listFiles(dir), executable });
      if (problems.length > 0) throw new Error(`${relative(ROOT, dir)}: ${problems.join("; ")}`);
      const tgz = join(outDir, e.filename);
      if (!existsSync(tgz) || statSync(tgz).size !== e.size) throw new Error(`npm pack did not write ${tgz}`);
      packed.push({ name: e.name, version: e.version, tgz, size: e.size, unpackedSize: e.unpackedSize, sha256: sha256File(tgz) });
    };
    for (const { p, plan } of plans) {
      const dir = assemblePlatform({ p, version, binary: plan.binary, outDir });
      pack(dir, platformPackageName(p), p.startsWith("win32-") ? [] : [platformBinary(p)]);
    }
    pack(assembleMain({ version, outDir }), TOOL_NAME, [`bin/${TOOL_NAME}.js`]);

    const sums = [...packed].sort((a, b) => (a.tgz < b.tgz ? -1 : 1)).map((p) => `${p.sha256}  ${relative(outDir, p.tgz)}`);
    writeFileSync(join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");

    const mb = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} kB`);
    console.log(`# ${packed.length} tarballs in ${outDir} (SHA256SUMS next to them)`);
    for (const p of packed) console.log(`#   ${relative(outDir, p.tgz)}  ${mb(p.size)} packed, ${mb(p.unpackedSize)} unpacked  ${p.name}@${p.version}`);
    if (o.targets.length < NPM_PLATFORMS.length) {
      const left = NPM_PLATFORMS.filter((p) => !o.targets.includes(p)).map((p) => platformPackageName(p));
      console.log(`# not packed here: ${left.join(", ")}; ${TOOL_NAME} lists all four, publish it only after all four are on the registry`);
    }
    const cmds = publishCommands(packed);
    console.log("\n# publish, in this order (your own shell, after npm login; see packaging/npm/README.md)");
    for (const c of cmds.publish) console.log(c);
    console.log("\n# verify afterwards");
    for (const c of cmds.verify) console.log(c);
  } catch (e) {
    console.error(`npm-pack: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
