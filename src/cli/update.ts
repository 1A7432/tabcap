// `tabcap update [--check]` (0.7.2, owner decision 2026-10-18): a CLI-local
// command. One request to the npm registry, only when the user runs it; never
// a background or start-up check. An npm install updates itself with the npm
// that owns it; a release tarball or source build is never downloaded or
// replaced, the answer points at the release page instead. Not an MCP tool
// (src/mcp/tools.ts EXCLUDED): an agent must not upgrade its own tool mid-session.

import { existsSync, realpathSync } from "node:fs";
import { TabcapError } from "../shared/envelope.ts";
import { envVar } from "../shared/env.ts";
import { isRecord } from "../shared/json.ts";
import { paths } from "../shared/paths.ts";
import { TOOL_VERSION } from "../bundle/manifest.ts";
import { status as daemonPing } from "./client.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const RELEASES_URL = "https://github.com/1A7432/tabcap/releases";
const REGISTRY_TIMEOUT_MS = 10_000;
const BROWSER_CLAUSE = "`tabcap setup` moves Chrome for Testing to the current stable.";

export type Channel = "npm" | "manual";
export type Version = [number, number, number];

/** The binary of an npm install lives in its platform package: node_modules/tabcap-<os>-<cpu>/bin/. */
const NPM_BIN = /[\\/]node_modules[\\/]tabcap-(?:darwin|linux|win32)-(?:arm64|x64)[\\/]bin[\\/]/;

/** Pure: the install channel of a (resolved) binary path; both separators are accepted. */
export function channelOf(executable: string): Channel {
  return NPM_BIN.test(executable) ? "npm" : "manual";
}

/**
 * Pure: the npm of the global prefix that owns this binary, or null when the
 * path is not a global npm install. POSIX: <prefix>/lib/node_modules/tabcap/
 * node_modules/... → <prefix>/bin/npm; Windows: <prefix>\node_modules\tabcap\
 * node_modules\... → <prefix>\npm.cmd.
 */
export function npmForBinary(executable: string, platform: NodeJS.Platform = process.platform): string | null {
  const pkg = String.raw`[\\/]node_modules[\\/]tabcap[\\/]node_modules[\\/]tabcap-(?:darwin|linux|win32)-(?:arm64|x64)[\\/]bin[\\/]`;
  const sep = executable.includes("\\") && !executable.includes("/") ? "\\" : "/";
  if (platform === "win32") {
    const m = new RegExp(`^(.*?)${pkg}`).exec(executable);
    return m === null || m[1] === undefined || m[1] === "" ? null : `${m[1]}${sep}npm.cmd`;
  }
  const m = new RegExp(String.raw`^(.*?)[\\/]lib${pkg}`).exec(executable);
  if (m === null || m[1] === undefined) return null;
  return `${m[1]}${sep}bin${sep}npm`;
}

/** Pure: numeric major.minor.patch, or null. */
export function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) return null;
  const n = [Number(m[1]), Number(m[2]), Number(m[3])];
  return n.every((x) => Number.isSafeInteger(x)) ? (n as Version) : null;
}

/** Pure: -1 / 0 / 1 for a < b / a = b / a > b. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The registry's `latest` version of tabcap (one GET, 10 s). */
export async function latestVersion(registry: string): Promise<string> {
  const url = `${registry.replace(/\/+$/, "")}/tabcap/latest`;
  const unreachable = (why: string) => new TabcapError("io", `cannot read ${url}: ${why}`, `Retry later (check the network / proxy), or look at ${RELEASES_URL}.`);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch (e) {
    throw unreachable(e instanceof Error && e.name === "TimeoutError" ? `no answer within ${REGISTRY_TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw unreachable(`HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const v = isRecord(body) ? body["version"] : undefined;
  if (typeof v !== "string") throw new TabcapError("bad-input", `${url} has no version string`, `Retry later, or look at ${RELEASES_URL}.`);
  return v;
}

/** Runs npm with both of its outputs on our stderr (stdout stays the one envelope); exit code and the tail of its output. */
async function runNpm(cmd: string[]): Promise<{ code: number; tail: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { code: -1, tail: e instanceof Error ? e.message : String(e) };
  }
  let tail = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) {
      process.stderr.write(chunk);
      tail = (tail + dec.decode(chunk, { stream: true })).slice(-4000);
    }
  };
  await Promise.all([pump(child.stdout as ReadableStream<Uint8Array>), pump(child.stderr as ReadableStream<Uint8Array>)]);
  const code = await child.exited;
  return { code, tail: tail.trimEnd().split(/\r?\n/).slice(-5).join("\n") };
}

const progress = (msg: string) => process.stderr.write(`[tabcap update] ${msg}\n`);

export async function cmdUpdate(args: Record<string, unknown>): Promise<unknown> {
  const check = args["check"] === true;
  const current = TOOL_VERSION;
  const cur = parseVersion(current);
  if (cur === null) throw new TabcapError("internal", `the running version ${current} is not major.minor.patch`, "This is a bug.");
  // TABCAP_UPDATE_EXECUTABLE is test-only (test/unit/update.test.ts): it stands in for the binary's own path.
  const executable = envVar("UPDATE_EXECUTABLE") ?? process.execPath;
  let resolved = executable;
  try {
    resolved = realpathSync(executable);
  } catch {
    // a path that does not resolve is matched as given
  }
  const channel = channelOf(resolved);
  const latest = await latestVersion(envVar("NPM_REGISTRY") ?? DEFAULT_REGISTRY);
  const lat = parseVersion(latest);
  if (lat === null) throw new TabcapError("bad-input", `the registry's latest tabcap version is not major.minor.patch: ${JSON.stringify(latest)}`, `Retry later, or look at ${RELEASES_URL}.`);
  const cmp = compareVersions(cur, lat);
  const base = { current, latest, updateAvailable: cmp < 0, channel, executable, releases: RELEASES_URL };
  const install = ["install", "-g", `tabcap@${latest}`];
  const manualNext = `Download the package for this platform from ${RELEASES_URL} and replace this binary, or rebuild from source (git pull, then bun run build).`;
  if (cmp >= 0) {
    const ahead = cmp > 0 ? ` (newer than the registry's latest, ${latest})` : "";
    return { ...base, action: "up-to-date", next: `tabcap ${current}${ahead} is up to date. ${BROWSER_CLAUSE}` };
  }
  if (check) {
    const next = channel === "npm" ? `Run \`tabcap update\` to install ${latest} (npm ${install.join(" ")}).` : manualNext;
    return { ...base, action: "check", next };
  }
  if (channel === "manual") return { ...base, action: "manual", next: manualNext };
  const owner = npmForBinary(resolved);
  const npm = envVar("NPM") ?? (owner !== null && existsSync(owner) ? owner : "npm");
  const command = [npm, ...install];
  progress(`running ${command.join(" ")}`);
  const r = await runNpm(command);
  if (r.code !== 0) {
    throw new TabcapError(
      "io",
      `${command.join(" ")} exited with ${r.code}${r.tail === "" ? "" : `: ${r.tail}`}`,
      `Run \`npm ${install.join(" ")}\` by hand and read npm's output (a global prefix you cannot write to needs your usual fix), or download the package from ${RELEASES_URL}.`,
    );
  }
  const running = (await daemonPing(paths())).ok;
  const next = running
    ? `Installed ${latest}. The daemon still runs the old binary: run \`tabcap daemon stop && tabcap daemon start\`. ${BROWSER_CLAUSE}`
    : `Installed ${latest}; the next tabcap command runs it. ${BROWSER_CLAUSE}`;
  return { ...base, action: "installed", npm: { command }, next };
}
