// tabcap browser start | stop | status

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readChromeArgsConfig, readConfig, readConfigWarnings, readHandoffConfig, readProtectionConfig } from "../../shared/config.ts";
import { TakeoverWatch, onHumanInput } from "../browser/takeover.ts";
import { envVar } from "../../shared/env.ts";
import { log } from "../../shared/log.ts";
import { Tabs } from "../browser/targets.ts";
import { ConsoleLog } from "../capture/console.ts";
import { Downloads, downloadBehavior, dropStaging, openStaging } from "../capture/downloads.ts";
import { TabcapError } from "../../shared/envelope.ts";
import type { BrowserInfo, Daemon } from "../state.ts";
import { DirectTransport } from "../transport/direct/index.ts";
import {
  HIDE_WEBDRIVER_FLAG,
  applyCustomArgs,
  checkCustomArgs,
  effectiveProxyLabel,
  isolationWarnings,
  parseProxy,
  parseWebdriver,
  resolveExecutable,
  webdriverOf,
  type CustomArgs,
} from "../transport/direct/launcher.ts";
import { logOffset, logSince, nestedSandboxError, sandboxFailed } from "../transport/direct/sandbox-check.ts";
import { optBool, optStr, optStrList, type Args } from "./args.ts";
import { withoutUrlCredentials } from "../../shared/launchargs.ts";
import { stopTrace } from "./trace.ts";
import { keepLiveFamilies, readLiveFamilies } from "../protection/live.ts";

/** Review 10-21: the browser info as `browser start` / `browser status` answer it, URL values without their userinfo. */
function shownInfo(info: BrowserInfo): BrowserInfo {
  return { ...info, args: withoutUrlCredentials(info.args), extraArgs: withoutUrlCredentials(info.extraArgs), dropArgs: withoutUrlCredentials(info.dropArgs), dropArgsUnmatched: withoutUrlCredentials(info.dropArgsUnmatched) };
}

/** The UI extension directory, when this build has one (docs/07 §1); absent in the MVP. */
function extensionDir(): string | null {
  const env = envVar("EXTENSION_DIR");
  const dir = env !== undefined && env !== "" ? env : join(import.meta.dir, "..", "..", "..", "extension");
  return existsSync(join(dir, "manifest.json")) ? dir : null;
}

/** 0.8.1-A: config.json `chrome.args` / `chrome.dropArgs`, then `--chrome-arg` / `--drop-chrome-arg` (docs/04 §42). */
function customArgsOf(a: Args, configFile: string): CustomArgs {
  const cfg = readChromeArgsConfig(configFile);
  return { add: [...cfg.add, ...optStrList(a, "chromeArg")], drop: [...cfg.drop, ...optStrList(a, "dropChromeArg")] };
}

/**
 * `browser start` while the browser runs: the `note` (docs/04 §42) when this call asks for something the
 * running browser does not have and that only a `browser stop` + `browser start` applies: other custom
 * Chrome args, or an explicit --proxy / --webdriver (or its config.json default) that differs from the
 * running one. Proxy and webdriver are worked out as a fresh start would (webdriver follows the final
 * command line, §42 rule 3; a proxy switch among the custom args under --proxy system reads
 * `chrome-arg`). A value a fresh start would refuse is not compared here. Null: nothing differs.
 */
export function runningNote(
  want: { custom: CustomArgs; proxy: string | null; webdriver: string | null },
  info: Pick<BrowserInfo, "extraArgs" | "dropArgs" | "proxy" | "webdriver">,
): string | null {
  const parts: string[] = [];
  if (JSON.stringify(want.custom) !== JSON.stringify({ add: info.extraArgs, drop: info.dropArgs })) parts.push("other custom Chrome args");
  if (want.proxy !== null) {
    const label = attempt(() => effectiveProxyLabel(parseProxy(want.proxy), want.custom.add));
    if (label !== null && label !== info.proxy) parts.push(`another proxy (${info.proxy})`);
  }
  if (want.webdriver !== null) {
    const mode = attempt(() => parseWebdriver(want.webdriver));
    const wd = mode === null ? null : webdriverOf(applyCustomArgs(mode === "hidden" ? [HIDE_WEBDRIVER_FLAG] : [], want.custom).args);
    if (wd !== null && wd !== info.webdriver) parts.push(`webdriver ${info.webdriver} (not ${wd})`);
  }
  return parts.length === 0 ? null : `the running browser has ${parts.join(", ")}; run \`tabcap browser stop\`, then \`tabcap browser start\` for these to apply`;
}

function attempt<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/**
 * Review wave 3 (docs/04 §44): the answer's `warnings` are the browser's own (`info.warnings`, as at
 * start) followed by config.json's warnings (unknown keys, then known keys of the wrong JSON type), read
 * again for every answer; a config.json that cannot be read is the answer's error.
 */
function withConfigWarnings(own: readonly string[], configFile: string): string[] {
  return [...own, ...readConfigWarnings(configFile)];
}

export async function browserStart(d: Daemon, a: Args): Promise<unknown> {
  if (d.browser !== null) {
    const info = d.browser.info;
    const cfgNow = readConfig(d.paths.configFile);
    const note = runningNote({ custom: customArgsOf(a, d.paths.configFile), proxy: optStr(a, "proxy") ?? cfgNow.proxy, webdriver: optStr(a, "webdriver") ?? cfgNow.webdriver }, info);
    return { ...shownInfo(info), warnings: withConfigWarnings(info.warnings, d.paths.configFile), alreadyRunning: true, ...(note === null ? {} : { note }) };
  }
  const cfg = readConfig(d.paths.configFile);
  // 0.7.1-A: a bad `handoff` value fails here, before anything starts (docs/04 §37).
  const handoff = readHandoffConfig(d.paths.configFile);
  // Review 10-21: so does a bad `protection.live` (docs/04 §41.3).
  const protection = readProtectionConfig(d.paths.configFile);
  // Review wave 3: read before the launch, so the answer cannot fail once the browser runs.
  const configWarnings = readConfigWarnings(d.paths.configFile);
  const exe = resolveExecutable({
    flag: optStr(a, "executablePath"),
    env: envVar("CHROME") ?? null,
    config: cfg.chrome?.executablePath ?? null,
    chromeCache: d.paths.chromeCache,
  });
  const proxy = parseProxy(optStr(a, "proxy") ?? cfg.proxy);
  const webdriver = parseWebdriver(optStr(a, "webdriver") ?? cfg.webdriver);
  const custom = customArgsOf(a, d.paths.configFile);
  checkCustomArgs(custom, proxy);
  const foreground = optBool(a, "foreground");
  const profile = join(d.paths.profiles, "default");
  const cdpEnv = envVar("CDP");
  d.browserFailure = null;
  const logFile = d.paths.browserLog;
  const offset = logOffset(logFile);
  const failedSandbox = () => sandboxFailed(logSince(logFile, offset));
  // Remembered, so later commands repeat the cause instead of "not running".
  const sandboxError = () => (d.browserFailure = nestedSandboxError(logFile));
  const ext = extensionDir();
  const t = await DirectTransport.start({
    executable: exe.path,
    profileDir: profile,
    logFile: d.paths.browserLog,
    proxy,
    webdriver,
    custom,
    extensionDir: ext,
    // Measured 10-15: with --no-startup-window Chrome never took the macOS
    // foreground, even when the first createTarget opened a window.
    noStartupWindow: true,
    restoreFront: true,
    ...(cdpEnv === "pipe" || cdpEnv === "port" ? { cdp: cdpEnv } : {}),
  }).catch((e: unknown) => {
    throw failedSandbox() ? sandboxError() : e;
  });
  // Inside another sandbox the helpers have already failed by now (measured: the
  // log lines precede the CDP attach), while the browser process still answers.
  if (failedSandbox()) {
    await t.shutdown().catch(() => undefined);
    throw sandboxError();
  }
  // 0.9-D (docs/04 §48): before the first tab, downloads go into this run's staging directory (never the
  // user's ~/Downloads); a browser whose downloads tabcap cannot take over is not kept.
  const staging = openStaging(d.paths.downloads);
  try {
    await t.send("Browser.setDownloadBehavior", downloadBehavior(staging), null, 10_000);
  } catch (e) {
    await t.shutdown().catch(() => undefined);
    dropStaging(staging);
    throw new TabcapError("cdp", `the browser did not take tabcap's download behaviour: ${e instanceof Error ? e.message : String(e)}`, "Retry `tabcap browser start`; without it downloads would land in the user's own Downloads folder, so the browser was stopped.");
  }
  const tabs = new Tabs(t, foreground);
  const downloads = new Downloads({ t, tabs, staging, recorder: (s) => d.recorders.get(s), scrub: (s) => d.secrets.scrub(s) });
  // Review 10-21 (docs/04 §41.1): the live probe's families are read and compiled once per browser start.
  const liveFamilies = protection.live ? readLiveFamilies(d.paths.config) : null;
  // 0.7.1-A: the take-over listener on every owned tab (direct mode; off with handoff.detectTakeover:false).
  const takeover = handoff.detectTakeover
    ? new TakeoverWatch(t, tabs, (tab, r, at, inWindow) => {
        onHumanInput({ guard: d.guard, recorder: (s) => d.recorders.get(s), navOf: (x) => d.navOf(x) }, tab, r, at, inWindow);
      })
    : null;
  d.browser = {
    t,
    tabs,
    console: new ConsoleLog(t, tabs),
    takeover,
    extensionDir: ext,
    downloads,
    info: {
      transport: "direct",
      channel: t.channel,
      pid: t.pid,
      version: t.version.product,
      userAgent: t.version.userAgent,
      executable: exe.path,
      executableSource: exe.source,
      profile,
      proxy: effectiveProxyLabel(proxy, t.args),
      // A custom arg can turn the switch on or off (docs/04 §42).
      webdriver: webdriverOf(t.args),
      args: t.args,
      extraArgs: custom.add,
      dropArgs: custom.drop,
      dropArgsUnmatched: t.unmatchedDrops,
      // Review 10-21: plus the user protection rule files the live probe skipped (read once, here).
      warnings: [...isolationWarnings(t.args, custom), ...(liveFamilies?.warnings ?? [])],
      protectionLive: protection.live,
      foreground,
      front: t.front,
      startedAt: Date.now(),
    },
  };
  const running = d.browser;
  if (liveFamilies !== null) keepLiveFamilies(running, liveFamilies);
  void t.closed.then(async (reason) => {
    if (d.browser !== running) return;
    log.warn("browser connection closed", { reason });
    if (failedSandbox()) sandboxError();
    await d.browserGone();
  });
  return { ...shownInfo(d.browser.info), warnings: [...d.browser.info.warnings, ...configWarnings], alreadyRunning: false, extension: ext, detectTakeover: takeover !== null };
}

export async function browserStop(d: Daemon): Promise<unknown> {
  const b = d.browser;
  if (b === null) return { stopped: false, running: false };
  // Owner 10-21 (as Daemon.browserGone): the handoffs end with the browser, their event before the recordings finish.
  d.guard.drop(null, "browser-gone");
  // Review 10-21: trace mode ends with the browser (it was left in d.tracers); as at session stop,
  // before the recordings finish, so what it saw still reaches them.
  for (const name of [...d.tracers.keys()]) await stopTrace(d, name, "browser stop");
  const bundles: string[] = [];
  for (const [name, r] of d.recorders) {
    const res = await r.stop();
    d.lastBundles.set(name, r);
    bundles.push(res.dir);
  }
  d.recorders.clear();
  // 0.4-D: pool accounts' cookies go back to the store while the pipe is up
  // (Chrome closes every tab within ~500 ms of the pipe dropping, spike 10-16).
  if (d.store !== null) await d.pool.saveAll(d.store, b.t).catch((e: unknown) => log.warn("pool: saving cookies before shutdown failed", { error: String(e) }));
  d.browser = null;
  b.tabs.dispose();
  b.console.dispose();
  b.takeover?.dispose();
  b.downloads.dispose();
  d.pool.reset();
  await b.t.shutdown();
  // 0.9-D: what is left in the staging directory is no recording's (docs/04 §48).
  dropStaging(b.downloads.staging);
  return { stopped: true, pid: b.info.pid, bundles };
}

/** `browser status` without config.json: what `daemon status` embeds (it answers whatever the file holds). */
/** 0.8.2 (docs/04 §18): the daemon's budget for stopping the browser, under the 15 s `daemon stop` gives it. */
export const SHUTDOWN_BROWSER_MS = 10_000;

/** After a kill, how long the abandoned stop gets to settle (its CDP calls now fail fast) before the caller goes on. */
export const STOP_SETTLE_MS = 1000;

/**
 * Runs `stop`; past `ms`, runs `kill`, then gives the stop STOP_SETTLE_MS to settle so its
 * last steps (cookie saves into the store, recorder writes) do not race the caller's own
 * teardown (Bugbot, PR #34); a late failure of the stop is logged, not thrown. False when killed.
 */
export async function stopWithin(stop: () => Promise<unknown>, ms: number, kill: () => Promise<void>, settleMs = STOP_SETTLE_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopping = stop();
  const done = await Promise.race([stopping.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)))]).finally(() => clearTimeout(timer));
  if (done) return true;
  await kill();
  const settled = stopping.then(
    () => undefined,
    (e: unknown) => log.warn("browser stop failed after the kill", { error: String(e) }),
  );
  await Promise.race([settled, Bun.sleep(settleMs)]);
  return false;
}

export function browserFacts(d: Daemon): Record<string, unknown> {
  const b = d.browser;
  if (b === null) return { running: false };
  return {
    running: true,
    ...shownInfo(b.info),
    sessions: b.tabs.sessions.size,
    tabs: [...b.tabs.tabs.values()].filter((x) => !x.closed).length,
    refusedFocusCalls: b.t.refusedFocusCalls,
    detectTakeover: b.takeover !== null,
    popupFocus: b.t.frontStats,
    recording: [...d.recorders.keys()],
  };
}

/** `browser status`: `browserFacts` with config.json's warnings (unknown keys, wrong types) in `warnings` (also with no browser). */
export function browserStatus(d: Daemon): unknown {
  const facts = browserFacts(d);
  return { ...facts, warnings: withConfigWarnings(d.browser?.info.warnings ?? [], d.paths.configFile) };
}
