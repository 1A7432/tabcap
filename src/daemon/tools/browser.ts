// tabcap browser start | stop | status

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig, readHandoffConfig } from "../../shared/config.ts";
import { TakeoverWatch, onHumanInput } from "../browser/takeover.ts";
import { envVar } from "../../shared/env.ts";
import { log } from "../../shared/log.ts";
import { Tabs } from "../browser/targets.ts";
import { ConsoleLog } from "../capture/console.ts";
import type { Daemon } from "../state.ts";
import { DirectTransport } from "../transport/direct/index.ts";
import { parseProxy, proxyLabel, resolveExecutable } from "../transport/direct/launcher.ts";
import { optBool, optStr, type Args } from "./args.ts";

/** The UI extension directory, when this build has one (docs/07 §1); absent in the MVP. */
function extensionDir(): string | null {
  const env = envVar("EXTENSION_DIR");
  const dir = env !== undefined && env !== "" ? env : join(import.meta.dir, "..", "..", "..", "extension");
  return existsSync(join(dir, "manifest.json")) ? dir : null;
}

export async function browserStart(d: Daemon, a: Args): Promise<unknown> {
  if (d.browser !== null) return { ...d.browser.info, alreadyRunning: true };
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
  const foreground = optBool(a, "foreground");
  const profile = join(d.paths.profiles, "default");
  const cdpEnv = envVar("CDP");
  const t = await DirectTransport.start({
    executable: exe.path,
    profileDir: profile,
    logFile: d.paths.browserLog,
    proxy,
    extensionDir: extensionDir(),
    // Measured 10-15: with --no-startup-window Chrome never took the macOS
    // foreground, even when the first createTarget opened a window.
    noStartupWindow: true,
    restoreFront: true,
    ...(cdpEnv === "pipe" || cdpEnv === "port" ? { cdp: cdpEnv } : {}),
  });
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
    info: {
      transport: "direct",
      channel: t.channel,
      pid: t.pid,
      version: t.version.product,
      userAgent: t.version.userAgent,
      executable: exe.path,
      executableSource: exe.source,
      profile,
      proxy: proxyLabel(proxy),
      foreground,
      front: t.front,
      startedAt: Date.now(),
    },
  };
  const running = d.browser;
  void t.closed.then(async (reason) => {
    if (d.browser !== running) return;
    log.warn("browser connection closed", { reason });
    await d.browserGone();
  });
  return { ...d.browser.info, alreadyRunning: false, extension: extensionDir(), detectTakeover: takeover !== null };
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
