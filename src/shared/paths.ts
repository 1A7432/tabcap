// Filesystem layout. Defaults follow XDG-ish conventions; $TABCAP_HOME moves
// everything under one directory (tests use it so they never touch ~).
//   config  ~/.config/tabcap        daemon.sock, daemon.pid, daemon.json, daemon.log, config.json, profiles/
//   cache   ~/.cache/tabcap         chrome/<version>/ (Chrome for Testing downloads)
//   data    ~/.local/share/tabcap   shots/, bundles/
// The socket normally lives in config/, but sun_path is short (macOS 104,
// Linux 108 bytes incl. NUL); a long $TABCAP_HOME gets a short per-user path
// instead (chooseSocketPath). The daemon records the path it really bound in
// config/daemon.json, and the CLI prefers that record.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "./env.ts";
import { isRecord, str, tryParseJson } from "./json.ts";

export type Paths = {
  config: string;
  cache: string;
  data: string;
  /** Socket clients talk to: the running daemon's record, else `newSocket`. */
  socket: string;
  /** Socket a daemon starting now binds (chooseSocketPath). */
  newSocket: string;
  /** True when the socket is not under config/ because that path is too long. */
  socketFallback: boolean;
  pidFile: string;
  daemonInfo: string;
  logFile: string;
  browserLog: string;
  configFile: string;
  profiles: string;
  chromeCache: string;
  shots: string;
  bundles: string;
};

/** Longest usable socket path in bytes (sun_path minus the NUL). */
export function maxSocketBytes(platform: NodeJS.Platform): number {
  return platform === "darwin" ? 103 : 107;
}

export type SocketEnv = {
  configDir: string;
  platform: NodeJS.Platform;
  uid: number;
  /** macOS per-user temp dir (`getconf DARWIN_USER_TEMP_DIR`), lazily computed. */
  darwinTemp: () => string | null;
  xdgRuntime: string | null;
  runUserExists: (dir: string) => boolean;
};

/** Pure: where the daemon socket goes. */
export function chooseSocketPath(e: SocketEnv): { path: string; fallback: boolean } {
  const preferred = join(e.configDir, "daemon.sock");
  const max = maxSocketBytes(e.platform);
  if (Buffer.byteLength(preferred) <= max) return { path: preferred, fallback: false };
  const name = `tabcap-${e.uid}-${createHash("sha256").update(e.configDir).digest("hex").slice(0, 8)}.sock`;
  const candidates: string[] = [];
  if (e.platform === "darwin") {
    const t = e.darwinTemp();
    if (t !== null) candidates.push(t);
  } else {
    if (e.xdgRuntime !== null && e.xdgRuntime !== "") candidates.push(e.xdgRuntime);
    const ru = `/run/user/${e.uid}`;
    if (e.runUserExists(ru)) candidates.push(ru);
  }
  // Last resort: a private 0700 directory in /tmp (created and owner-checked by the daemon).
  candidates.push(`/tmp/tabcap-${e.uid}`);
  for (const dir of candidates) {
    const p = join(dir, name);
    if (Buffer.byteLength(p) <= max) return { path: p, fallback: true };
  }
  return { path: join(`/tmp/tabcap-${e.uid}`, name), fallback: true };
}

function darwinUserTemp(): string | null {
  const p = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe", stderr: "ignore" });
  const dir = p.stdout.toString().trim();
  return p.exitCode === 0 && dir.startsWith("/") ? dir.replace(/\/+$/, "") : null;
}

export function paths(env: Record<string, string | undefined> = process.env): Paths {
  const home = envVar("HOME", env);
  const config = home !== undefined && home !== "" ? join(home, "config") : join(homedir(), ".config", "tabcap");
  const cache = home !== undefined && home !== "" ? join(home, "cache") : join(homedir(), ".cache", "tabcap");
  const data = home !== undefined && home !== "" ? join(home, "data") : join(homedir(), ".local", "share", "tabcap");
  const daemonInfo = join(config, "daemon.json");
  const chosen = chooseSocketPath({
    configDir: config,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    darwinTemp: darwinUserTemp,
    xdgRuntime: env["XDG_RUNTIME_DIR"] ?? null,
    runUserExists: (d) => existsSync(d),
  });
  // A running daemon's record wins: TMPDIR-like inputs can differ between shells.
  const recorded = recordedSocket(daemonInfo);
  const socket = recorded ?? chosen.path;
  return {
    config,
    cache,
    data,
    socket,
    newSocket: chosen.path,
    socketFallback: socket !== join(config, "daemon.sock"),
    pidFile: join(config, "daemon.pid"),
    daemonInfo,
    logFile: join(config, "daemon.log"),
    browserLog: join(config, "browser.log"),
    configFile: join(config, "config.json"),
    profiles: join(config, "profiles"),
    chromeCache: join(cache, "chrome"),
    shots: join(data, "shots"),
    bundles: join(data, "bundles"),
  };
}

/** Socket path recorded by a daemon in config/daemon.json, if the file and socket exist. */
export function recordedSocket(daemonInfo: string): string | null {
  if (!existsSync(daemonInfo)) return null;
  const raw = tryParseJson(readFileSync(daemonInfo, "utf8"));
  const s = isRecord(raw) ? str(raw, "socket") : null;
  return s !== null && s.startsWith("/") && existsSync(s) ? s : null;
}
