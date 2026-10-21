// CLI side of the daemon API: fetch over the Unix socket (or, on Windows, the
// loopback port with the bearer token from config/daemon.json), start / stop
// the daemon (the same binary re-runs itself as `tabcap daemon run`, detached).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_VERSION } from "../bundle/manifest.ts";
import { RESTART_DAEMON, TabcapError, fail, type Envelope } from "../shared/envelope.ts";
import { envVar } from "../shared/env.ts";
import { isRecord } from "../shared/json.ts";
import { daemonEndpoint, paths as currentPaths, type Endpoint, type Paths } from "../shared/paths.ts";

const NOT_RUNNING = () => fail("not-running", "the tabcap daemon is not running", "Run `tabcap daemon start` (then `tabcap browser start`).");

function isEnvelope(v: unknown): v is Envelope<unknown> {
  return isRecord(v) && typeof v["ok"] === "boolean";
}

/** Pure: URL and fetch options for one request to the daemon at `ep`. */
export function requestFor(ep: Endpoint, path: string, init: RequestInit): { url: string; init: BunFetchRequestInit } {
  if (ep.kind === "unix") return { url: `http://localhost${path}`, init: { ...init, unix: ep.socket } };
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ep.token}`);
  return { url: `http://${ep.host}:${ep.port}${path}`, init: { ...init, headers } };
}

async function request(paths: Paths, path: string, init: RequestInit, timeoutMs: number): Promise<Envelope<unknown>> {
  const ep = daemonEndpoint(paths);
  if (ep === null) return NOT_RUNNING();
  let res: Response;
  try {
    const r = requestFor(ep, path, init);
    res = await fetch(r.url, { ...r.init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      return fail("timeout", `the daemon did not answer within ${timeoutMs} ms`, "Check `tabcap daemon status`; raise --timeout for slow pages.");
    }
    return NOT_RUNNING();
  }
  const body: unknown = await res.json().catch(() => null);
  return isEnvelope(body) ? body : fail("internal", "the daemon sent a malformed response", "Check the daemon log (`tabcap daemon status` shows its path).");
}

export function send(paths: Paths, action: string, args: Record<string, unknown>, session: string, argv: string[], timeoutMs: number): Promise<Envelope<unknown>> {
  return request(paths, "/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, args, session, argv, version: TOOL_VERSION }) }, timeoutMs + 10_000);
}

export function status(paths: Paths): Promise<Envelope<unknown>> {
  return request(paths, "/status", { method: "GET" }, 5000);
}

/** How to run this program again: the compiled binary itself, or `bun <main.ts>`. */
export function selfCommand(): string[] {
  const exe = process.execPath;
  if (/^bun(\.exe)?$/.test(basename(exe))) return [exe, fileURLToPath(new URL("./main.ts", import.meta.url))];
  return [exe];
}

function readPid(paths: Paths): number | null {
  if (!existsSync(paths.pidFile)) return null;
  const n = Number(readFileSync(paths.pidFile, "utf8").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(paths: Paths): Promise<unknown> {
  const st = await status(paths);
  if (st.ok) {
    const data = isRecord(st.data) ? st.data : {};
    // Owner 10-21: a daemon left running from another version ignores flags it does not know.
    const v = data["version"];
    const behind = typeof v === "string" && v !== TOOL_VERSION ? { next: `The running daemon is tabcap ${v.slice(0, 64)}, this CLI is tabcap ${TOOL_VERSION}: run \`${RESTART_DAEMON}\` (that also stops its browser and finishes its recordings).` } : {};
    return { started: false, alreadyRunning: true, ...data, log: paths.logFile, ...behind };
  }
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  const fd = openSync(paths.logFile, "a", 0o600);
  const [cmd, ...rest] = selfCommand();
  if (cmd === undefined) throw new TabcapError("internal", "cannot find own executable", "Run `tabcap daemon run` in a terminal instead.");
  const child = spawn(cmd, [...rest, "daemon", "run"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, TABCAP_LOG: envVar("LOG") ?? "info" },
  });
  closeSync(fd);
  child.unref();
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    // Re-resolve: the new daemon records the socket it bound in daemon.json.
    const s = await status(currentPaths());
    if (s.ok) return { started: true, alreadyRunning: false, ...(isRecord(s.data) ? s.data : {}), log: paths.logFile };
    if (child.exitCode !== null) break;
  }
  throw new TabcapError("internal", "the daemon did not come up within 10 s", `Look at ${paths.logFile}.`);
}

export async function stopDaemon(paths: Paths): Promise<unknown> {
  const pid = readPid(paths);
  const res = await request(paths, "/command", { method: "POST", body: JSON.stringify({ action: "daemon.shutdown" }) }, 5000);
  if (!res.ok && (pid === null || !alive(pid))) return { stopped: false, running: false };
  if (pid !== null) {
    for (let i = 0; i < 150 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100);
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }
  return { stopped: true, pid };
}

export async function daemonStatus(paths: Paths): Promise<unknown> {
  const st = await status(paths);
  if (st.ok) return { ...(isRecord(st.data) ? st.data : {}), log: paths.logFile };
  if (paths.listener === "tcp") return { running: false, listener: "tcp", socket: null, log: paths.logFile };
  return { running: false, listener: "unix", socket: paths.newSocket, socketFallback: paths.newSocket !== `${paths.config}/daemon.sock`, log: paths.logFile };
}
