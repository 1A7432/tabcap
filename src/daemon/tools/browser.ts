// tabcap browser start | stop | status

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readChromeArgsConfig, readConfig, readHandoffConfig } from "../../shared/config.ts";
import { TakeoverWatch, onHumanInput } from "../browser/takeover.ts";
import { envVar } from "../../shared/env.ts";
import { log } from "../../shared/log.ts";
import { Tabs } from "../browser/targets.ts";
import { ConsoleLog } from "../capture/console.ts";
import type { BrowserInfo, Daemon } from "../state.ts";
import { DirectTransport } from "../transport/direct/index.ts";
import {
  HIDE_WEBDRIVER_FLAG,
  applyCustomArgs,
  checkCustomArgs,
  effectiveProxyLabel,
  parseProxy,
  parseWebdriver,
  resolveExecutable,
  webdriverOf,
  type CustomArgs,
} from "../transport/direct/launcher.ts";
import { logOffset, logSince, nestedSandboxError, sandboxFailed } from "../transport/direct/sandbox-check.ts";
import { optBool, optStr, optStrList, type Args } from "./args.ts";

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

export async function browserStart(d: Daemon, a: Args): Promise<unknown> {
  if (d.browser !== null) {
    const info = d.browser.info;
    const cfgNow = readConfig(d.paths.configFile);
    const note = runningNote({ custom: customArgsOf(a, d.paths.configFile), proxy: optStr(a, "proxy") ?? cfgNow.proxy, webdriver: optStr(a, "webdriver") ?? cfgNow.webdriver }, info);
    return { ...info, alreadyRunning: true, ...(note === null ? {} : { note }) };
  }
  const cfg = readConfig(d.paths.configFile);
  // 0.7.1-A: a bad `handoff` value fails here, before anything starts (docs/04 §37).
  const handoff = readHandoffConfig(d.paths.configFile);
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
  const tabs = new Tabs(t, foreground);
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
      foreground,
      front: t.front,
      startedAt: Date.now(),
    },
  };
  const running = d.browser;
  void t.closed.then(async (reason) => {
    if (d.browser !== running) return;
    log.warn("browser connection closed", { reason });
    if (failedSandbox()) sandboxError();
    await d.browserGone();
  });
  return { ...d.browser.info, alreadyRunning: false, extension: ext, detectTakeover: takeover !== null };
}

export async function browserStop(d: Daemon): Promise<unknown> {
  const b = d.browser;
  if (b === null) return { stopped: false, running: false };
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
  d.pool.reset();
  await b.t.shutdown();
  return { stopped: true, pid: b.info.pid, bundles };
}

export function browserStatus(d: Daemon): unknown {
  const b = d.browser;
  if (b === null) return { running: false };
  return {
    running: true,
    ...b.info,
    sessions: b.tabs.sessions.size,
    tabs: [...b.tabs.tabs.values()].filter((x) => !x.closed).length,
    refusedFocusCalls: b.t.refusedFocusCalls,
    detectTakeover: b.takeover !== null,
    popupFocus: b.t.frontStats,
    recording: [...d.recorders.keys()],
  };
}
