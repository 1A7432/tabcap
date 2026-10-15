// tabcap browser start | stop | status

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../shared/config.ts";
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
  d.browser = {
    t,
    tabs,
    console: new ConsoleLog(t, tabs),
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
  return { ...d.browser.info, alreadyRunning: false, extension: extensionDir() };
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
  d.browser = null;
  b.tabs.dispose();
  b.console.dispose();
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
    popupFocus: b.t.frontStats,
    recording: [...d.recorders.keys()],
  };
}
