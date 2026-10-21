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
  // Spike 10-16 (CfT 155, netlog): a context with its own proxy sends
  // CONNECT www.google.com:443 through it on every navigation (search engine
  // preconnect); only this feature switch stops it (docs/07 §1.1).
  "PreconnectToSearch",
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

/** 0.7.6-A: navigator.webdriver reads false; a Blink switch, no page script (docs/04 §40). */
export const HIDE_WEBDRIVER_FLAG = "--disable-blink-features=AutomationControlled";

export type WebdriverMode = "hidden" | "visible";

/** `hidden` (default) or `visible`; anything else is a usage error. */
export function parseWebdriver(value: string | undefined | null): WebdriverMode {
  if (value === undefined || value === null || value === "" || value === "hidden") return "hidden";
  if (value === "visible") return "visible";
  throw new TabcapError("usage", `bad --webdriver value: ${value}`, "Use --webdriver hidden (default) or --webdriver visible.");
}

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

// ------------------------------------------------------------ custom args (0.8.1-A, docs/04 §42)

/** `browser start --chrome-arg` / `--drop-chrome-arg`, after config.json `chrome.args` / `chrome.dropArgs`. */
export type CustomArgs = { add: string[]; drop: string[] };
export const NO_CUSTOM_ARGS: CustomArgs = { add: [], drop: [] };

/** tabcap's own wiring: the profile it manages and the CDP pipe. */
const RESERVED_ADD = new Set(["--user-data-dir", "--remote-debugging-pipe"]);
/** The port fallback reads DevToolsActivePort, so its switch stays too. */
const RESERVED_DROP = new Set([...RESERVED_ADD, "--remote-debugging-port"]);
/** Allowed only with `--proxy system`; otherwise they fight `--proxy`. */
const PROXY_SWITCHES = new Set(["--proxy-server", "--proxy-bypass-list", "--proxy-pac-url", "--no-proxy-server", "--proxy-auto-detect"]);
/** Comma-list switches, merged instead of replaced; the value is the list's opposite ("" = none). */
const LIST_SWITCHES = new Map([
  ["--enable-features", "--disable-features"],
  ["--disable-features", "--enable-features"],
  ["--enable-blink-features", "--disable-blink-features"],
  ["--disable-blink-features", "--enable-blink-features"],
  ["--load-extension", ""],
]);
const SWITCH = /^--[A-Za-z0-9][\w.-]*(=.*)?$/s;

const switchName = (a: string): string => {
  const eq = a.indexOf("=");
  return eq > 0 ? a.slice(0, eq) : a;
};
const switchValue = (a: string): string | null => {
  const eq = a.indexOf("=");
  return eq > 0 ? a.slice(eq + 1) : null;
};
const listItems = (a: string): string[] => (switchValue(a) ?? "").split(",").filter((x) => x !== "");
/** Feature lists compare by name (`Name:param/value`, `Name<Trial`); extension paths as written. */
const itemKey = (sw: string) => (sw === "--load-extension" ? (x: string) => x : (x: string) => x.split(/[:<]/)[0] ?? x);

/** Refuse what would break tabcap itself (docs/04 §42); everything else is passed on. */
export function checkCustomArgs(c: CustomArgs, proxy: ProxyMode): void {
  const hint = "Custom args come from --chrome-arg / --drop-chrome-arg and config.json chrome.args / chrome.dropArgs.";
  for (const a of [...c.add, ...c.drop]) {
    if (!SWITCH.test(a) || a.includes("\0")) {
      throw new TabcapError("usage", `custom Chrome arg ${JSON.stringify(a)} is not a switch`, `Write it as --name or --name=value; open pages with \`tabcap navigate\` or \`tabcap tab new\`. ${hint}`);
    }
  }
  for (const a of c.add) {
    const n = switchName(a);
    if (RESERVED_ADD.has(n)) throw new TabcapError("usage", `${n} is set by tabcap itself and cannot be a custom Chrome arg`, `tabcap manages the profile and the CDP pipe. ${hint}`);
    if (PROXY_SWITCHES.has(n) && proxy.kind !== "system") {
      throw new TabcapError("usage", `custom Chrome arg ${n} conflicts with --proxy ${proxyLabel(proxy)}`, `Use one of them: --proxy <mode>, or the proxy switch with --proxy system. ${hint}`);
    }
  }
  for (const a of c.drop) {
    const n = switchName(a);
    if (RESERVED_DROP.has(n)) throw new TabcapError("usage", `${n} cannot be dropped: tabcap needs it to reach the browser`, hint);
  }
}

/**
 * Pure: tabcap's command line with the custom args applied (docs/04 §42).
 * Drops first, then adds; Chrome keeps only the last of a repeated switch, so
 * list switches are merged into tabcap's one and other switches replace
 * tabcap's of the same name. `unmatched`: drops that removed nothing.
 */
export function applyCustomArgs(base: readonly string[], c: CustomArgs): { args: string[]; unmatched: string[] } {
  let out = base.filter((a) => a.startsWith("--"));
  const positional = base.filter((a) => !a.startsWith("--"));
  const rewrite = (sw: string, keep: (item: string) => boolean): void => {
    out = out.flatMap((a) => {
      if (switchName(a) !== sw) return [a];
      const kept = listItems(a).filter(keep);
      return kept.length === 0 ? [] : [`${sw}=${kept.join(",")}`];
    });
  };
  const unmatched: string[] = [];
  for (const d of c.drop) {
    const before = out.join("\n");
    const n = switchName(d);
    const v = switchValue(d);
    if (v === null) out = out.filter((a) => switchName(a) !== n);
    else if (LIST_SWITCHES.has(n)) {
      const key = itemKey(n);
      const gone = new Set(v.split(",").filter((x) => x !== "").map(key));
      rewrite(n, (x) => !gone.has(key(x)));
    } else out = out.filter((a) => a !== d);
    if (out.join("\n") === before) unmatched.push(d);
  }
  for (const a of c.add) {
    const n = switchName(a);
    const opposite = LIST_SWITCHES.get(n);
    if (opposite === undefined) {
      out = [...out.filter((x) => switchName(x) !== n), a];
      continue;
    }
    // A list switch without a value adds no items: tabcap's list stays (Bugbot, PR #27).
    const key = itemKey(n);
    const mine = listItems(a);
    const names = new Set(mine.map(key));
    if (opposite !== "") rewrite(opposite, (x) => !names.has(key(x)));
    const at = out.findIndex((x) => switchName(x) === n);
    const merged = [...(at < 0 ? [] : listItems(out[at] ?? "").filter((x) => !names.has(key(x)))), ...mine];
    if (merged.length === 0) continue;
    if (at < 0) out.push(`${n}=${merged.join(",")}`);
    else out[at] = `${n}=${merged.join(",")}`;
  }
  return { args: [...out, ...positional], unmatched };
}

/** `hidden` when the final command line still disables AutomationControlled (docs/04 §42). */
export function webdriverOf(args: readonly string[]): WebdriverMode {
  const on = args.some((a) => switchName(a) === "--disable-blink-features" && listItems(a).some((x) => itemKey("--disable-blink-features")(x) === "AutomationControlled"));
  return on ? "hidden" : "visible";
}

/** `proxyLabel`, or `chrome-arg` when a custom switch sets the proxy under `--proxy system`. */
export function effectiveProxyLabel(p: ProxyMode, args: readonly string[]): string {
  return p.kind === "system" && args.some((a) => PROXY_SWITCHES.has(switchName(a))) ? "chrome-arg" : proxyLabel(p);
}

export type ArgsOptions = {
  profileDir: string;
  platform: NodeJS.Platform;
  cdp: "pipe" | "port";
  proxy: ProxyMode;
  webdriver: WebdriverMode;
  extensionDir: string | null;
  noStartupWindow: boolean;
  /** 0.8.1-A: applied last (docs/04 §42); none when absent. */
  custom?: CustomArgs;
};

/** Pure: the full command line (without the executable). */
export function buildArgs(o: ArgsOptions): string[] {
  return buildArgsReport(o).args;
}

/** `buildArgs` plus the custom drops that matched nothing. */
export function buildArgsReport(o: ArgsOptions): { args: string[]; unmatched: string[] } {
  const args = [`--user-data-dir=${o.profileDir}`];
  args.push(o.cdp === "pipe" ? "--remote-debugging-pipe" : "--remote-debugging-port=0");
  if (o.webdriver === "hidden") args.push(HIDE_WEBDRIVER_FLAG);
  args.push(...NETWORK_QUIET_FLAGS, ...NO_THROTTLE_FLAGS, ...QUIET_UI_FLAGS, ...RECORDING_FLAGS);
  args.push(`--disable-features=${[...NETWORK_QUIET_DISABLED_FEATURES, ...RECORDING_DISABLED_FEATURES].join(",")}`);
  if (o.platform === "darwin") args.push("--use-mock-keychain");
  if (o.platform === "linux") args.push("--password-store=basic");
  if (o.proxy.kind === "none") args.push("--proxy-server=127.0.0.1:1", "--proxy-bypass-list=127.0.0.1;localhost");
  if (o.proxy.kind === "url") args.push(`--proxy-server=${o.proxy.url}`, "--proxy-bypass-list=<-loopback>");
  if (o.extensionDir !== null) args.push(`--load-extension=${o.extensionDir}`);
  if (o.noStartupWindow) args.push("--no-startup-window");
  else args.push("about:blank");
  return applyCustomArgs(args, o.custom ?? NO_CUSTOM_ARGS);
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
  /** Custom drops that matched nothing (docs/04 §42). */
  unmatchedDrops: string[];
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
  const { args, unmatched: unmatchedDrops } = buildArgsReport({ ...o, cdp: "pipe" });
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
  if (await o.probe(wire)) return { proc, pid: proc.pid, wire, cdp: "pipe", args, unmatchedDrops };
  log.warn("pipe probe failed; falling back to --remote-debugging-port=0");
  wire.close();
  await killAndWait(proc, 5000);
  return null;
}

async function launchPort(o: LaunchOptions): Promise<Launched> {
  const { args, unmatched: unmatchedDrops } = buildArgsReport({ ...o, cdp: "port" });
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
        return { proc, pid: proc.pid, wire, cdp: "port", args, unmatchedDrops };
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

/**
 * The frontmost macOS process. `name` is the System Events process name, which
 * can differ from the application name (Firefox Developer Edition: `firefox`),
 * so the hand-back activates by `bundleId` when there is one.
 */
export type FrontApp = { name: string; bundleId: string | null; pid: number | null };

const FRONTMOST_SCRIPT = [
  'tell application "System Events"',
  "set p to first application process whose frontmost is true",
  "return {name of p, bundle identifier of p, unix id of p}",
  "end tell",
].join("\n");

/** Parse osascript's `name, bundle id, pid` list output; `missing value` means no bundle id. Null when unusable. */
export function parseFrontApp(out: string): FrontApp | null {
  const m = /^(.*), ([^,]*), (\d+)$/s.exec(out.trim());
  if (m === null) return null;
  const name = (m[1] ?? "").trim();
  const bundle = (m[2] ?? "").trim();
  const pid = Number(m[3]);
  if (name === "") return null;
  return { name, bundleId: bundle === "" || bundle === "missing value" ? null : bundle, pid: Number.isSafeInteger(pid) ? pid : null };
}

/** The frontmost macOS app, or null when unknown / not permitted / not macOS. */
export function frontmostApp(): FrontApp | null {
  if (process.platform !== "darwin") return null;
  const p = Bun.spawnSync(["osascript", "-e", FRONTMOST_SCRIPT], { timeout: 5000, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? parseFrontApp(p.stdout.toString()) : null;
}

/** AppleScript that brings an app back to the front: by bundle id when known, else by name; null when unsafe to embed or a Chrome app. */
export function activateScript(app: FrontApp): string | null {
  if (isChromeApp(app.name)) return null;
  const SAFE = /^[^"\\\n\r]+$/;
  if (app.bundleId !== null) return SAFE.test(app.bundleId) ? `tell application id "${app.bundleId}" to activate` : null;
  return SAFE.test(app.name) ? `tell application "${app.name}" to activate` : null;
}

/** Bring a macOS app back to the front; true on success. Never activates a Chrome app. */
export function activateApp(app: FrontApp): boolean {
  const script = process.platform === "darwin" ? activateScript(app) : null;
  if (script === null) return false;
  const p = Bun.spawnSync(["osascript", "-e", script], { timeout: 5000, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0;
}

export const isChromeApp = (app: FrontApp | string | null): boolean => {
  const name = typeof app === "string" || app === null ? app : app.name;
  return name !== null && /chrom/i.test(name);
};

/** Async `frontmostApp` (does not block the daemon's event loop while osascript runs). */
export async function frontmostAppAsync(): Promise<FrontApp | null> {
  if (process.platform !== "darwin") return null;
  const p = Bun.spawn(["osascript", "-e", FRONTMOST_SCRIPT], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? parseFrontApp(out) : null;
}

/** Async `activateApp`. */
export async function activateAppAsync(app: FrontApp): Promise<boolean> {
  const script = process.platform === "darwin" ? activateScript(app) : null;
  if (script === null) return false;
  const p = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore", timeout: 5000 });
  return (await p.exited) === 0;
}
