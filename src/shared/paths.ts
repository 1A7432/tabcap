// Filesystem layout. $TABCAP_HOME moves everything under one directory
// (tests use it so they never touch ~). Defaults per platform (baseDirs):
//   macOS    ~/.config/tabcap, ~/.cache/tabcap, ~/.local/share/tabcap
//   Linux    $XDG_CONFIG_HOME/tabcap, $XDG_CACHE_HOME/tabcap, $XDG_DATA_HOME/tabcap
//            (each falls back to the macOS-style default when unset or relative)
//   Windows  %LOCALAPPDATA%\tabcap\{config,cache,data}; files there get the
//            user-default ACL of the profile (no POSIX modes on Windows).
//   config   daemon.sock (Unix), daemon.pid, daemon.json, daemon.log, config.json, profiles/
//   cache    chrome/<version>/ (Chrome for Testing downloads)
//   data     shots/, bundles/
// The daemon listens on a Unix socket on macOS / Linux and on loopback TCP with
// a per-start bearer token on Windows (Bun.serve has no `unix` there).
// The socket normally lives in config/, but sun_path is short (macOS 104,
// Linux 108 bytes incl. NUL); a long $TABCAP_HOME gets a short per-user path
// instead (chooseSocketPath). The daemon records where it really listens in
// config/daemon.json, and the CLI prefers that record.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { envVar } from "./env.ts";
import { isRecord, str, tryParseJson } from "./json.ts";

/** How the daemon listens: a Unix socket, or loopback TCP with a bearer token (Windows). */
export type ListenerKind = "unix" | "tcp";

export function listenerKind(platform: NodeJS.Platform): ListenerKind {
  return platform === "win32" ? "tcp" : "unix";
}

export type Paths = {
  listener: ListenerKind;
  config: string;
  cache: string;
  data: string;
  /** Socket clients talk to: the running daemon's record, else `newSocket` (unused on Windows). */
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
  // Unix sockets only exist on macOS / Linux, so these are POSIX paths on every host.
  const join = posix.join;
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

export type DirsEnv = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
};

/** Pure: the config / cache / data directories for a platform (see the header). */
export function baseDirs(o: DirsEnv): { config: string; cache: string; data: string } {
  const home = envVar("HOME", o.env);
  const p = o.platform === "win32" ? win32 : posix;
  if (home !== undefined && home !== "") return { config: p.join(home, "config"), cache: p.join(home, "cache"), data: p.join(home, "data") };
  if (o.platform === "win32") {
    const lad = o.env["LOCALAPPDATA"];
    const root = lad !== undefined && win32.isAbsolute(lad) ? win32.join(lad, "tabcap") : win32.join(o.homedir, "AppData", "Local", "tabcap");
    return { config: win32.join(root, "config"), cache: win32.join(root, "cache"), data: win32.join(root, "data") };
  }
  // XDG base directories (Linux only; macOS keeps its 0.2 layout). Relative values are ignored, as the spec says.
  const xdg = (name: string, fallback: string[]): string => {
    const v = o.platform === "linux" ? o.env[name] : undefined;
    return v !== undefined && posix.isAbsolute(v) ? posix.join(v, "tabcap") : posix.join(o.homedir, ...fallback, "tabcap");
  };
  return { config: xdg("XDG_CONFIG_HOME", [".config"]), cache: xdg("XDG_CACHE_HOME", [".cache"]), data: xdg("XDG_DATA_HOME", [".local", "share"]) };
}

export function paths(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Paths {
  const { config, cache, data } = baseDirs({ platform, env, homedir: homedir() });
  const daemonInfo = join(config, "daemon.json");
  const listener = listenerKind(platform);
  const chosen =
    listener === "tcp"
      ? { path: join(config, "daemon.sock"), fallback: false } // not used: Windows listens on TCP
      : chooseSocketPath({
          configDir: config,
          platform,
          uid: process.getuid?.() ?? 0,
          darwinTemp: darwinUserTemp,
          xdgRuntime: env["XDG_RUNTIME_DIR"] ?? null,
          runUserExists: (d) => existsSync(d),
        });
  // A running daemon's record wins: TMPDIR-like inputs can differ between shells.
  const recorded = listener === "unix" ? recordedSocket(daemonInfo) : null;
  const socket = recorded ?? chosen.path;
  return {
    listener,
    config,
    cache,
    data,
    socket,
    newSocket: chosen.path,
    socketFallback: listener === "unix" && socket !== join(config, "daemon.sock"),
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

/** Where a running daemon listens, as recorded in config/daemon.json. The token stays in that file. */
export type Endpoint = { kind: "unix"; socket: string } | { kind: "tcp"; host: "127.0.0.1"; port: number; token: string };

/** The endpoint clients use: the recorded TCP listener on Windows, else the socket path. Null when nothing is recorded / bound. */
export function daemonEndpoint(p: Paths): Endpoint | null {
  if (p.listener === "unix") return existsSync(p.socket) ? { kind: "unix", socket: p.socket } : null;
  return recordedTcp(p.daemonInfo);
}

/** Pure parse of a TCP record: `{listener:"tcp", port, token}`; anything else is null. */
export function parseTcpRecord(raw: unknown): Endpoint | null {
  if (!isRecord(raw) || raw["listener"] !== "tcp") return null;
  const port = raw["port"];
  const token = str(raw, "token");
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (token === null || !/^[0-9a-f]{64}$/.test(token)) return null;
  return { kind: "tcp", host: "127.0.0.1", port, token };
}

function recordedTcp(daemonInfo: string): Endpoint | null {
  if (!existsSync(daemonInfo)) return null;
  return parseTcpRecord(tryParseJson(readFileSync(daemonInfo, "utf8")));
}

/**
 * Short names of the bundles one answer compares (0.7-C, docs/04 §2.1): each
 * bundle directory's basename; a basename given twice gets `~2`, `~3` … in
 * order, so the names stay unique within the answer.
 */
export function bundleShorts(dirs: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = d.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/** The `bundles` list of a cross-bundle answer: `{short, dir}` per bundle, in argument order. */
export const bundleList = (dirs: readonly string[]): { short: string; dir: string }[] => {
  const shorts = bundleShorts(dirs);
  return dirs.map((dir, i) => ({ short: shorts[i] ?? dir, dir }));
};
