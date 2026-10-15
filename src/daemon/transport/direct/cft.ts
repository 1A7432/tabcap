// `tabcap setup`: download Chrome for Testing (Stable) via the official JSON API
// into <cache>/chrome/<version>/, unpack it with a system tool (`unzip` on
// macOS; `unzip` or `bsdtar` on Linux; PowerShell `Expand-Archive` on Windows),
// verify the binary, record it in config.json. Idempotent and non-interactive;
// progress goes to stderr. Only the Chrome for Testing hosts are contacted.
// The download lands in <cache>/chrome/.tmp-<version>-<pid>/ and is renamed onto
// <version>/ only when complete; a failed run removes its temp directory, and
// every run first removes temp directories left by runs that are gone.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { TabcapError } from "../../../shared/envelope.ts";
import { isRecord, str } from "../../../shared/json.ts";
import { binaryIn, type CftPlatform } from "./launcher.ts";

export const CFT_JSON = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const ALLOWED_HOSTS = new Set(["googlechromelabs.github.io", "storage.googleapis.com", "edgedl.me.gvt1.com"]);

export type CftDownload = { version: string; url: string };

/** Pure: pick the Stable chrome download for `platform` from the JSON API document. */
export function pickDownload(doc: unknown, platform: CftPlatform): CftDownload {
  const bad = (what: string) => new TabcapError("bad-input", `Chrome for Testing JSON: ${what}`, "Retry later; the download index may be changing, or pass --executable-path.");
  const channels = isRecord(doc) && isRecord(doc["channels"]) ? doc["channels"] : null;
  const stable = channels !== null && isRecord(channels["Stable"]) ? channels["Stable"] : null;
  if (stable === null) throw bad("no channels.Stable");
  const version = str(stable, "version");
  if (version === null || !/^\d+(\.\d+){3}$/.test(version)) throw bad("bad Stable version");
  const downloads = isRecord(stable["downloads"]) ? stable["downloads"] : null;
  const chrome = downloads !== null && Array.isArray(downloads["chrome"]) ? downloads["chrome"] : [];
  for (const d of chrome) {
    if (isRecord(d) && d["platform"] === platform) {
      const url = str(d, "url");
      if (url === null) break;
      checkHost(url);
      return { version, url };
    }
  }
  throw bad(`no chrome download for ${platform}`);
}

function checkHost(url: string): void {
  const host = new URL(url).hostname;
  if (new URL(url).protocol !== "https:" || !ALLOWED_HOSTS.has(host)) {
    throw new TabcapError("bad-input", `refusing to download from ${url}`, "Only the official Chrome for Testing hosts are allowed; pass --executable-path instead.");
  }
}

const progress = (msg: string) => process.stderr.write(`[tabcap setup] ${msg}\n`);

/** PowerShell, non-interactive, without the user's profile scripts. */
const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];

/**
 * The binary's version line, or null. `chrome.exe --version` prints nothing on
 * Windows (a GUI-subsystem program), so there the file's version resource is
 * read instead; that shows the file is a Chrome build, not that it starts.
 */
export function binaryVersion(bin: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    return readVersion(bin, platform);
  } catch {
    return null; // the program (or PowerShell) could not be started
  }
}

function readVersion(bin: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    // The path goes through the environment, never into the script text.
    const p = Bun.spawnSync([...POWERSHELL, "(Get-Item -LiteralPath $env:TABCAP_SETUP_BIN).VersionInfo.ProductVersion"], {
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TABCAP_SETUP_BIN: bin },
    });
    const v = p.stdout.toString().trim();
    return p.exitCode === 0 && /^\d+(\.\d+)+$/.test(v) ? `Google Chrome for Testing ${v}` : null;
  }
  const p = Bun.spawnSync([bin, "--version"], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  return p.exitCode === 0 && out !== "" ? out : null;
}

export type UnpackCommand = { cmd: string[]; env: Record<string, string> };

/**
 * Pure: how to unpack `zip` into `dest` on `platform`. `which` finds tools on
 * PATH. Windows uses PowerShell's Expand-Archive with the paths passed through
 * the environment; Linux prefers `unzip` and falls back to `bsdtar`.
 */
export function unpackCommand(platform: NodeJS.Platform, zip: string, dest: string, which: (tool: string) => string | null = (t) => Bun.which(t)): UnpackCommand | null {
  if (platform === "win32") {
    return {
      cmd: [...POWERSHELL, "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:TABCAP_SETUP_ZIP -DestinationPath $env:TABCAP_SETUP_DEST -Force"],
      env: { TABCAP_SETUP_ZIP: zip, TABCAP_SETUP_DEST: dest },
    };
  }
  if (which("unzip") !== null) return { cmd: ["unzip", "-q", "-o", zip, "-d", dest], env: {} };
  if (platform === "linux" && which("bsdtar") !== null) return { cmd: ["bsdtar", "-xf", zip, "-C", dest], env: {} };
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** Remove `.tmp-*` partial downloads whose setup process is gone; returns the names removed. */
export function cleanStaleTmp(chromeCache: string, alive: (pid: number) => boolean = pidAlive): string[] {
  if (!existsSync(chromeCache)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(chromeCache)) {
    if (!name.startsWith(".tmp-")) continue;
    const pid = Number(/-(\d+)$/.exec(name)?.[1] ?? "NaN");
    if (Number.isSafeInteger(pid) && pid !== process.pid && alive(pid)) continue; // another setup is downloading
    rmSync(join(chromeCache, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function downloadCft(
  chromeCache: string,
  platform: CftPlatform,
  fetchFn: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<{ executablePath: string; version: string; downloaded: boolean; cleaned: string[] }> {
  const cleaned = cleanStaleTmp(chromeCache);
  if (cleaned.length > 0) progress(`removed ${cleaned.length} unfinished download(s): ${cleaned.join(", ")}`);
  progress(`fetching ${CFT_JSON}`);
  checkHost(CFT_JSON);
  const idx = await fetchFn(CFT_JSON);
  if (!idx.ok) throw new TabcapError("io", `download index returned HTTP ${idx.status}`, "Check the network / proxy, or pass --executable-path.");
  const { version, url } = pickDownload(await idx.json(), platform);
  const dir = join(chromeCache, version);
  const bin = binaryIn(dir, platform);
  if (existsSync(bin) && binaryVersion(bin) !== null) {
    progress(`Chrome for Testing ${version} already installed`);
    return { executablePath: bin, version, downloaded: false, cleaned };
  }
  mkdirSync(chromeCache, { recursive: true });
  const tmp = join(chromeCache, `.tmp-${version}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    await fetchAndUnpack(url, tmp, dir, platform, fetchFn);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (binaryVersion(bin) === null) throw new TabcapError("io", `the downloaded browser does not run: ${bin}`, "Run it by hand with --version to see the error.");
  progress(`installed Chrome for Testing ${version}`);
  return { executablePath: bin, version, downloaded: true, cleaned };
}

/** Download the zip into `tmp`, unzip there, check the binary, then rename `tmp` onto `dir`. */
async function fetchAndUnpack(url: string, tmp: string, dir: string, platform: CftPlatform, fetchFn: (url: string) => Promise<Response>): Promise<void> {
  const zip = join(tmp, "chrome.zip");
  progress(`downloading ${url}`);
  const res = await fetchFn(url);
  if (!res.ok || res.body === null) throw new TabcapError("io", `download returned HTTP ${res.status}`, "Retry later or pass --executable-path.");
  const total = Number(res.headers.get("content-length") ?? "0");
  // node:fs handle, closed explicitly: on Windows a Bun FileSink still held the
  // file after end(), and Expand-Archive could not open the zip (CI 10-16).
  const sink = await open(zip, "w");
  let got = 0;
  let lastPct = -10;
  try {
    for await (const chunk of res.body) {
      await sink.write(chunk);
      got += chunk.length;
      const pct = total > 0 ? Math.floor((got / total) * 100) : 0;
      if (pct >= lastPct + 10) {
        progress(`${pct}% (${Math.round(got / 1048576)} MB)`);
        lastPct = pct;
      }
    }
  } finally {
    await sink.close();
  }
  const how = unpackCommand(process.platform, zip, tmp);
  if (how === null) throw new TabcapError("io", "no unzip tool found", "Install `unzip` (or `bsdtar` on Linux), then run `tabcap setup` again.");
  progress(`unpacking with ${how.cmd[0] ?? "?"}`);
  const unzip = Bun.spawnSync(how.cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...how.env } });
  if (unzip.exitCode !== 0) throw new TabcapError("io", `unpacking failed: ${unzip.stderr.toString().slice(0, 300)}`, `Make sure \`${how.cmd[0] ?? "unzip"}\` works, then run \`tabcap setup\` again.`);
  rmSync(zip, { force: true });
  const tmpBin = binaryIn(tmp, platform);
  if (!existsSync(tmpBin)) {
    const found = readdirSync(tmp).slice(0, 10).join(", ");
    const err = unzip.stderr.toString().trim().slice(0, 300);
    throw new TabcapError("io", `archive did not contain ${tmpBin} (unpacked: ${found || "nothing"}${err === "" ? "" : `; ${how.cmd[0] ?? "unzip"} said: ${err}`})`, "Report this; the archive layout may have changed. Use --executable-path meanwhile.");
  }
  chmodSync(tmpBin, 0o755);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
}
