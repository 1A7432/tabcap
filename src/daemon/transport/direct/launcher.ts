// Launch Chrome for Testing for the `direct` transport (docs/07 §1.1, §1.2).
// Flag table: the "采用" rows of docs/07 §1.2, taken from Playwright's
// chromiumSwitches.ts (Apache-2.0, see NOTICE). The two --disable-features
// groups are merged into one switch because Chrome keeps only the last
// occurrence of a repeated switch.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { TabcapError } from "../../../shared/envelope.ts";
import { log } from "../../../shared/log.ts";
import type { Wire } from "./cdp.ts";
import { pipeWire, wsWire } from "./wire.ts";

// ------------------------------------------------------------ flag table

/** Quiet Chrome's own background traffic. */
export const NETWORK_QUIET_FLAGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-service-autorun",
  "--disable-field-trial-config",
  "--disable-client-side-phishing-detection",
  "--disable-breakpad",
  "--disable-default-apps",
  "--disable-component-extensions-with-background-pages",
];
export const NETWORK_QUIET_DISABLED_FEATURES = [
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "Translate",
  "MediaRouter",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "LensOverlay",
  "HttpsUpgrades",
];
/** Background tabs keep running (pairs with focus emulation, docs/07 §1.1). */
export const NO_THROTTLE_FLAGS = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
export const QUIET_UI_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-search-engine-choice-screen",
  "--disable-infobars",
  "--disable-prompt-on-repost",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
];
export const RECORDING_FLAGS = [
  "--disable-back-forward-cache",
  "--enable-features=CDPScreenshotNewSurface",
  "--allow-pre-commit-input",
  "--disable-ipc-flooding-protection",
  "--force-color-profile=srgb",
  "--export-tagged-pdf",
];
export const RECORDING_DISABLED_FEATURES = [
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
];

export type ProxyMode = { kind: "system" } | { kind: "none" } | { kind: "url"; url: string };

/** `system` (default: pass nothing), `none` (black-hole proxy), or a proxy URL. */
export function parseProxy(value: string | undefined | null): ProxyMode {
  if (value === undefined || value === null || value === "" || value === "system") return { kind: "system" };
  if (value === "none") return { kind: "none" };
  if (!/^(https?|socks[45]?):\/\/[^\s]+$/i.test(value) && !/^[\w.-]+:\d+$/.test(value)) {
    throw new TabcapError("usage", `bad --proxy value: ${value}`, "Use --proxy system, --proxy none, or --proxy http://host:port.");
  }
  return { kind: "url", url: value };
}

export function proxyLabel(p: ProxyMode): string {
  return p.kind === "url" ? p.url : p.kind;
}

export type ArgsOptions = {
  profileDir: string;
  platform: NodeJS.Platform;
  cdp: "pipe" | "port";
  proxy: ProxyMode;
  extensionDir: string | null;
  noStartupWindow: boolean;
};

/** Pure: the full command line (without the executable). */
export function buildArgs(o: ArgsOptions): string[] {
  const args = [`--user-data-dir=${o.profileDir}`];
  args.push(o.cdp === "pipe" ? "--remote-debugging-pipe" : "--remote-debugging-port=0");
  args.push(...NETWORK_QUIET_FLAGS, ...NO_THROTTLE_FLAGS, ...QUIET_UI_FLAGS, ...RECORDING_FLAGS);
  args.push(`--disable-features=${[...NETWORK_QUIET_DISABLED_FEATURES, ...RECORDING_DISABLED_FEATURES].join(",")}`);
  if (o.platform === "darwin") args.push("--use-mock-keychain");
  if (o.platform === "linux") args.push("--password-store=basic");
  if (o.proxy.kind === "none") args.push("--proxy-server=127.0.0.1:1", "--proxy-bypass-list=127.0.0.1;localhost");
  if (o.proxy.kind === "url") args.push(`--proxy-server=${o.proxy.url}`);
  if (o.extensionDir !== null) args.push(`--load-extension=${o.extensionDir}`);
  if (o.noStartupWindow) args.push("--no-startup-window");
  else args.push("about:blank");
  return args;
}

// ------------------------------------------------------------ executable

export type CftPlatform = "mac-arm64" | "mac-x64" | "linux64" | "win64";

/** Chrome for Testing build for this OS / CPU; null where Google publishes none (Linux arm64, Windows arm64). */
export function hostPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CftPlatform | null {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (platform === "linux" && arch === "x64") return "linux64";
  if (platform === "win32" && arch === "x64") return "win64";
  return null;
}

/** Binary path inside an unzipped Chrome for Testing archive directory. */
export function binaryIn(versionDir: string, platform: CftPlatform): string {
  if (platform === "linux64") return join(versionDir, "chrome-linux64", "chrome");
  if (platform === "win64") return join(versionDir, "chrome-win64", "chrome.exe");
  return join(versionDir, `chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest cached Chrome for Testing under `<cache>/chrome/<version>/`, if any. */
export function cachedChrome(chromeCache: string, platform: CftPlatform | null): string | null {
  if (platform === null || !existsSync(chromeCache)) return null;
  const versions = readdirSync(chromeCache).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(compareVersions).reverse();
  for (const v of versions) {
    const bin = binaryIn(join(chromeCache, v), platform);
    if (existsSync(bin)) return bin;
  }
  return null;
}

export type ExecutableSource = "flag" | "env" | "config" | "cache";

export function resolveExecutable(o: {
  flag: string | null;
  env: string | null;
  config: string | null;
  chromeCache: string;
}): { path: string; source: ExecutableSource } {
  const pick: Array<[string | null, ExecutableSource]> = [
    [o.flag, "flag"],
    [o.env, "env"],
    [o.config, "config"],
    [cachedChrome(o.chromeCache, hostPlatform()), "cache"],
  ];
  for (const [p, source] of pick) {
    if (p === null || p === "") continue;
    if (!existsSync(p) || !statSync(p).isFile()) {
      throw new TabcapError("not-found", `browser executable from ${source} does not exist: ${p}`, "Run `tabcap setup` (downloads Chrome for Testing) or pass --executable-path <Chrome for Testing binary>.");
    }
    return { path: p, source };
  }
  throw new TabcapError("not-found", "no Chrome for Testing found", "Run `tabcap setup` once, or pass --executable-path <Chrome for Testing binary> (or set TABCAP_CHROME).");
}

// ------------------------------------------------------------ launch

export type Launched = {
  proc: ChildProcess;
  pid: number;
  wire: Wire;
  cdp: "pipe" | "port";
  args: string[];
};

export type LaunchOptions = Omit<ArgsOptions, "cdp"> & {
  executable: string;
  logFile: string;
  /** Force one CDP channel; default tries pipe, then port. */
  cdp?: "pipe" | "port";
  /** Check the pipe answers; resolves true when it does. */
  probe: (wire: Wire) => Promise<boolean>;
};

function openLog(file: string): number {
  return openSync(file, "a", 0o600);
}

async function launchPipe(o: LaunchOptions): Promise<Launched | null> {
  const args = buildArgs({ ...o, cdp: "pipe" });
  const fd = openLog(o.logFile);
  const proc = spawn(o.executable, args, { stdio: ["ignore", "ignore", fd, "pipe", "pipe"] });
  closeSync(fd);
  const toChrome = proc.stdio[3] as Writable | null | undefined;
  const fromChrome = proc.stdio[4] as Readable | null | undefined;
  if (proc.pid === undefined || toChrome == null || fromChrome == null) {
    proc.kill("SIGKILL");
    return null;
  }
  const wire = pipeWire(toChrome, fromChrome);
  if (await o.probe(wire)) return { proc, pid: proc.pid, wire, cdp: "pipe", args };
  log.warn("pipe probe failed; falling back to --remote-debugging-port=0");
  wire.close();
  await killAndWait(proc, 5000);
  return null;
}

async function launchPort(o: LaunchOptions): Promise<Launched> {
  const args = buildArgs({ ...o, cdp: "port" });
  const portFile = join(o.profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const fd = openLog(o.logFile);
  const proc = spawn(o.executable, args, { stdio: ["ignore", "ignore", fd] });
  closeSync(fd);
  if (proc.pid === undefined) throw new TabcapError("internal", "failed to spawn the browser", `Check ${o.logFile}.`);
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) break;
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      if (port !== undefined && path !== undefined && /^\d+$/.test(port) && path.startsWith("/devtools/browser/")) {
        const wire = await wsWire(`ws://127.0.0.1:${port}${path}`);
        return { proc, pid: proc.pid, wire, cdp: "port", args };
      }
    }
    await Bun.sleep(50);
  }
  await killAndWait(proc, 3000);
  throw new TabcapError("internal", "the browser did not publish DevToolsActivePort within 15 s", `Check ${o.logFile}; another Chrome may be using the profile.`);
}

export async function launchChrome(o: LaunchOptions): Promise<Launched> {
  mkdirSync(o.profileDir, { recursive: true, mode: 0o700 });
  if (o.cdp !== "port") {
    const viaPipe = await launchPipe(o);
    if (viaPipe !== null) return viaPipe;
    if (o.cdp === "pipe") throw new TabcapError("internal", "the browser did not answer on --remote-debugging-pipe", `Check ${o.logFile}.`);
  }
  return launchPort(o);
}

export async function killAndWait(proc: ChildProcess, graceMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  const ok = await Promise.race([exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (!ok) {
    proc.kill("SIGKILL");
    await Promise.race([exited, Bun.sleep(2000)]);
  }
}

// ------------------------------------------------------------ macOS foreground

/** Name of the frontmost macOS app, or null when unknown / not permitted / not macOS. */
export function frontmostApp(): string | null {
  if (process.platform !== "darwin") return null;
  const p = Bun.spawnSync(
    ["osascript", "-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
    { timeout: 5000, stdout: "pipe", stderr: "pipe" },
  );
  const name = p.stdout.toString().trim();
  return p.exitCode === 0 && name !== "" ? name : null;
}

/** Bring a macOS app back to the front; true on success. */
export function activateApp(name: string): boolean {
  if (process.platform !== "darwin" || !/^[^"\\]+$/.test(name)) return false;
  const p = Bun.spawnSync(["osascript", "-e", `tell application "${name}" to activate`], { timeout: 5000, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0;
}

export const isChromeApp = (name: string | null): boolean => name !== null && /chrom/i.test(name);

const FRONTMOST_SCRIPT = 'tell application "System Events" to get name of first application process whose frontmost is true';

/** Async `frontmostApp` (does not block the daemon's event loop while osascript runs). */
export async function frontmostAppAsync(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const p = Bun.spawn(["osascript", "-e", FRONTMOST_SCRIPT], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const name = out.trim();
  return code === 0 && name !== "" ? name : null;
}

/** Async `activateApp`. */
export async function activateAppAsync(name: string): Promise<boolean> {
  if (process.platform !== "darwin" || !/^[^"\\]+$/.test(name)) return false;
  const p = Bun.spawn(["osascript", "-e", `tell application "${name}" to activate`], { stdout: "ignore", stderr: "ignore", timeout: 5000 });
  return (await p.exited) === 0;
}
