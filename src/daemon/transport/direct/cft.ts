// `tabcap setup`: download Chrome for Testing (Stable) via the official JSON API
// into <cache>/chrome/<version>/, unzip with the system `unzip`, verify the
// binary runs, record it in config.json. Idempotent and non-interactive;
// progress goes to stderr. Only the Chrome for Testing hosts are contacted.
// The download lands in <cache>/chrome/.tmp-<version>-<pid>/ and is renamed onto
// <version>/ only when complete; a failed run removes its temp directory, and
// every run first removes temp directories left by runs that are gone.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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

/** Run `<bin> --version`; returns the version line or null. */
export function binaryVersion(bin: string): string | null {
  const p = Bun.spawnSync([bin, "--version"], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  return p.exitCode === 0 && out !== "" ? out : null;
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
  const sink = Bun.file(zip).writer();
  let got = 0;
  let lastPct = -10;
  for await (const chunk of res.body) {
    sink.write(chunk);
    got += chunk.length;
    const pct = total > 0 ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      progress(`${pct}% (${Math.round(got / 1048576)} MB)`);
      lastPct = pct;
    }
  }
  await sink.end();
  progress("unzipping");
  const unzip = Bun.spawnSync(["unzip", "-q", "-o", zip, "-d", tmp], { stdout: "pipe", stderr: "pipe" });
  if (unzip.exitCode !== 0) throw new TabcapError("io", `unzip failed: ${unzip.stderr.toString().slice(0, 300)}`, "Make sure `unzip` is installed, then run `tabcap setup` again.");
  rmSync(zip, { force: true });
  const tmpBin = binaryIn(tmp, platform);
  if (!existsSync(tmpBin)) throw new TabcapError("io", `archive did not contain ${tmpBin}`, "Report this; the archive layout may have changed. Use --executable-path meanwhile.");
  chmodSync(tmpBin, 0o755);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
}
