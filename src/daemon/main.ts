// The daemon: one process, HTTP over a Unix socket (0600, in a 0700 dir), or
// on Windows over loopback TCP with a per-start bearer token (listener.ts).
//   POST /command {action, args, session, argv?} -> JSON envelope
//   GET  /status                                  -> JSON envelope
// Every response is passed through known-secret replacement. The log records
// actions and outcomes, never arguments.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOOL_VERSION } from "../bundle/manifest.ts";
import { TabcapError, fail, ok, toFail, type Envelope, type FailEnvelope } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { log } from "../shared/log.ts";
import type { Paths } from "../shared/paths.ts";
import { ACTION_COMMANDS, Daemon } from "./state.ts";
import { BLOCKED_WHILE_WAITING, waitingError } from "./guard.ts";
import { Store } from "./store/db.ts";
import { screenshot } from "./tools/page.ts";
import { setLogScrubber } from "../shared/log.ts";
import { browserStatus, browserStop } from "./tools/browser.ts";
import { TOOLS } from "./tools/index.ts";
import { scrubValue } from "./secrets.ts";
import { listen, newToken, type Listening } from "./listener.ts";
import { budgetBlock } from "./tools/pool.ts";
import { CdpClosedError, CdpError, CdpTimeoutError } from "./transport/direct/cdp.ts";
import { TRACE_PAUSED_NOTE } from "./trace/tracer.ts";

/** How often the daemon looks for proxies whose health check is due (pool.health.intervalS, down back-off). */
const HEALTH_TICK_MS = 15_000;

function toEnvelope(e: unknown): FailEnvelope {
  if (e instanceof CdpTimeoutError) return fail("timeout", e.message, "The browser did not answer in time; check the tab with `tabcap screenshot`, or retry.");
  if (e instanceof CdpClosedError) return fail("not-running", e.message, "The browser connection is gone; run `tabcap browser start`.");
  if (e instanceof CdpError) return fail("cdp", e.message, "Retry; if the page changed, run `tabcap snapshot` again first.");
  return toFail(e);
}

/** Actions whose `text` argument is typed into the page (fill / type). */
const TEXT_ACTIONS = new Set(["fill", "type"]);
const DEFERRED = "<deferred to the end event>";

/** Small, non-sensitive summary of a result for the `cmd` event. */
function summarize(data: unknown): unknown {
  if (!isRecord(data)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (["tree", "value", "valueText", "textPreview", "hits", "requests"].includes(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200)) out[k] = v;
    if (Object.keys(out).length >= 12) break;
  }
  return out;
}

export async function handleCommand(d: Daemon, body: unknown, shutdown: () => void): Promise<Envelope<unknown>> {
  if (!isRecord(body) || typeof body["action"] !== "string") return fail("usage", "request must be {action, args, session}", "Use the tabcap CLI.");
  const action = body["action"];
  const args = isRecord(body["args"]) ? body["args"] : {};
  const session = typeof body["session"] === "string" && body["session"] !== "" ? body["session"] : "default";
  const argv = Array.isArray(body["argv"]) ? body["argv"].filter((x): x is string => typeof x === "string") : null;
  if (action === "daemon.shutdown") {
    setTimeout(shutdown, 50);
    return ok({ stopping: true, pid: process.pid });
  }
  if (action === "daemon.status") return markFetchAuth(d, ok(statusData(d)));
  const known = TOOLS[action];
  if (known === undefined) return fail("usage", `unknown action: ${action}`, "Run `tabcap --help`.");
  // Sites may have been added by `tabcap site add` (another process) since the last command.
  d.refreshSecrets();
  // docs/05 s15: while the session waits for the human, nothing acts on the page.
  const blockedBy = d.guard.blocking(session, action, typeof args["url"] === "string" ? args["url"] : null);
  // 0.4-D: an account over its configured hourly budget does not act on pages either.
  const overBudget = blockedBy === null ? budgetBlock(d, session, action) : null;
  const tool: typeof known = blockedBy !== null ? () => Promise.reject(waitingError(blockedBy)) : overBudget !== null ? () => Promise.reject(overBudget) : known;
  const started = Date.now();
  // docs/04 §14: a `cmd` start event before the tool runs, an end event after;
  // everything the recorder writes in between carries cmd: "c-<start seq>".
  // Text typed into the page may turn out to be a password only once the tool
  // has looked at the field, so the start event defers it to the end event.
  const deferText = TEXT_ACTIONS.has(action) && typeof args["text"] === "string";
  const scrubbed = () => {
    const input = scrubValue(d.secrets, { action, ...args });
    return { argv: argv === null ? null : argv.map((a) => d.secrets.scrub(a)), input: isRecord(input) ? input : {} };
  };
  const startArgs = () => (deferText ? { argv: null, input: { ...scrubbed().input, text: DEFERRED } } : scrubbed());
  const tabArg = action !== "tab.close" && action !== "tab.use" && typeof args["tab"] === "string" ? args["tab"] : null;
  const currentTab = () => tabArg ?? d.browser?.tabs.session(session)?.current ?? null;
  const recAtStart = d.recorders.get(session);
  const startId = recAtStart?.cmdStart({ tab: currentTab(), ...startArgs() }) ?? null;
  d.noteAction(session, { action, at: started, cmd: startId });
  let env: Envelope<unknown>;
  try {
    const data = await tool(d, args, session);
    // While recording, action commands say which command window they were (`net list --since c-<n>`).
    const out = startId !== null && ACTION_COMMANDS.has(action) && isRecord(data) && !("cmd" in data) ? { ...data, cmd: startId } : data;
    const h = d.guard.get(session);
    if (h !== null && h.state === "waiting" && h.since >= started && BLOCKED_WHILE_WAITING.has(action)) {
      // This very command ran into the challenge: stop here, with its own result attached.
      env = toFail(waitingError(h));
      if (!env.ok) env.error["result"] = out;
    } else {
      const notice = action.startsWith("handoff.") ? null : (d.guard.waitingNotice(session) ?? d.guard.takeNotice(session));
      env = ok(notice !== null && isRecord(out) ? { ...out, handoff: notice } : out);
    }
  } catch (e) {
    env = toEnvelope(e);
  }
  env = markFetchAuth(d, env);
  env = withTraceField(d, session, env);
  const durationMs = Date.now() - started;
  // Which app the human is in, for handing the foreground back when a page opens a window.
  d.browser?.t.noteFront();
  log.info("command", { action, session, ok: env.ok, durationMs, ...(env.ok ? {} : { code: env.error.code }) });
  const rec = d.recorders.get(session);
  if (rec !== undefined) {
    // A recording this command started (net start) gets its window opened now.
    const id = rec === recAtStart && startId !== null ? startId : rec.cmdStart({ tab: currentTab(), ...startArgs() });
    if (id !== null) {
      rec.cmdEnd(id, {
        tab: currentTab(),
        ok: env.ok,
        error: env.ok ? null : scrubValue(d.secrets, env.error),
        durationMs,
        outputSummary: env.ok ? scrubValue(d.secrets, summarize(env.data)) : null,
        ...(deferText ? scrubbed() : {}),
      });
    }
  }
  return env;
}

/**
 * AGENTS.md: instrumentation is marked in the output. While the proxy auth
 * handler (browser-level Fetch, 0.4-D) is on, every command output says
 * `fetchAuth: "on"`.
 */
export function markFetchAuth(d: Daemon, env: Envelope<unknown>): Envelope<unknown> {
  if (!d.pool.fetchAuth) return env;
  if (!env.ok) return { ok: false, error: { ...env.error, fetchAuth: "on" } };
  return isRecord(env.data) ? ok({ ...env.data, fetchAuth: "on" }) : env;
}

/**
 * 0.4-F: while trace mode is on in the session every answer carries
 * `"trace": "on"`; while the session waits for the human it says `"paused"`
 * and why (failures included: the `waiting` error itself).
 */
export function withTraceField(d: Daemon, session: string, env: Envelope<unknown>): Envelope<unknown> {
  const tr = d.tracers.get(session);
  if (tr === undefined || tr.stoppedNow) return env;
  const field: Record<string, unknown> = tr.paused ? { trace: "paused", traceNote: TRACE_PAUSED_NOTE } : { trace: "on" };
  if (!env.ok) return { ok: false, error: { ...env.error, ...field } };
  return isRecord(env.data) ? ok({ ...env.data, ...field }) : env;
}

/** The wire form of every daemon answer: known secret values replaced (docs/04 §8.1). */
export function scrubbedBody(d: Daemon, env: Envelope<unknown>): string {
  return d.secrets.scrub(JSON.stringify(env));
}

let listening: Listening["describe"] | null = null;

function statusData(d: Daemon): unknown {
  return {
    running: true,
    pid: process.pid,
    version: TOOL_VERSION,
    listener: d.paths.listener,
    socket: d.paths.listener === "unix" ? d.paths.socket : null,
    socketFallback: d.paths.socketFallback,
    ...(listening !== null && listening.listener === "tcp" ? { port: listening.port } : {}),
    startedAt: d.startedAt,
    store: d.store?.path ?? null,
    handoffs: d.guard.all().map((h) => ({ session: h.session, state: h.state, reason: h.reason })),
    browser: browserStatus(d),
    recordings: [...d.recorders.values()].map((r) => r.status()),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runDaemon(paths: Paths): Promise<void> {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  const unix = paths.listener === "unix";
  const socket = paths.newSocket;
  if (unix && dirname(socket).startsWith("/tmp/tabcap-")) ensurePrivateDir(dirname(socket));
  chmodSync(paths.config, 0o700);
  if (existsSync(paths.pidFile)) {
    const old = Number(readFileSync(paths.pidFile, "utf8").trim());
    const bound = unix ? existsSync(paths.socket) : existsSync(paths.daemonInfo);
    if (Number.isSafeInteger(old) && old > 0 && old !== process.pid && pidAlive(old) && bound) {
      throw new TabcapError("conflict", `a daemon is already running (pid ${old})`, "Use it, or run `tabcap daemon stop` first.");
    }
  }
  if (unix && existsSync(socket)) unlinkSync(socket);
  // docs/04 §8.1: the store must be 0600 in a 0700 directory, or the daemon does not start.
  const store = Store.open(paths.config);
  const d = new Daemon({ ...paths, socket, socketFallback: paths.newSocket !== paths.socket || paths.socketFallback }, { screenshot: guardShot, pageInfo });
  d.store = store;
  d.refreshSecrets();
  setLogScrubber((line) => d.secrets.scrub(line));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping");
    await browserStop(d).catch((e: unknown) => log.error("browser stop failed", { error: String(e) }));
    server.stop(true);
    store.close();
    for (const f of unix ? [socket, paths.pidFile, paths.daemonInfo] : [paths.pidFile, paths.daemonInfo]) {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    }
    process.exit(0);
  };
  const bound = listen(unix ? { kind: "unix", socket } : { kind: "tcp", token: newToken() }, async (req, srv) => {
      srv.timeout(req, 0); // commands may legitimately run for minutes (--timeout)
      const url = new URL(req.url);
      d.refreshSecrets();
      let env: Envelope<unknown>;
      if (req.method === "GET" && url.pathname === "/status") env = ok(statusData(d));
      else if (req.method === "POST" && url.pathname === "/command") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          body = null;
        }
        env = await handleCommand(d, body, () => void shutdown());
      } else env = fail("not-found", `no route ${req.method} ${url.pathname}`, "Use POST /command or GET /status.");
      return new Response(scrubbedBody(d, env), { headers: { "content-type": "application/json" } });
  });
  const server = bound.server;
  listening = bound.describe;
  if (unix) chmodSync(socket, 0o600);
  writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  // Clients read where to connect from here (the socket may live outside
  // config/, see paths.ts; on Windows the port and the token).
  const info = unix ? { pid: process.pid, socket, startedAt: d.startedAt } : { pid: process.pid, ...bound.record, startedAt: d.startedAt };
  writeFileSync(paths.daemonInfo, JSON.stringify(info) + "\n", { mode: 0o600 });
  // 0.4-D: periodic proxy health checks, only when config.json pool.health.url is set (owner rule 10-16).
  const health = setInterval(() => {
    void d.pool.healthTick(store).catch((e: unknown) => log.warn("pool: health check failed", { error: String(e) }));
  }, HEALTH_TICK_MS);
  health.unref();
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  log.info("daemon listening", { ...bound.describe, pid: process.pid });
}

/** Guard screenshot of a tab at the moment it was handed to the human. */
async function guardShot(d: Daemon, session: string, tab: string): Promise<string | null> {
  const r = await screenshot(d, { tab }, session);
  return isRecord(r) && typeof r["path"] === "string" ? r["path"] : null;
}

const PAGE_INFO = `(() => ({ url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 4000) : null }))()`;

/** Short page excerpt for challenge handlers (scrubbed by the guard). */
async function pageInfo(d: Daemon, session: string, tab: string): Promise<{ url: string | null; title: string | null; text: string | null }> {
  const { t, tabs } = d.need();
  const target = tabs.pick(session, tab);
  const r = await t.send("Runtime.evaluate", { expression: PAGE_INFO, returnByValue: true }, target.sessionId, 5000);
  const res = isRecord(r["result"]) && isRecord(r["result"]["value"]) ? r["result"]["value"] : {};
  const s = (k: string) => (typeof res[k] === "string" ? res[k] : null);
  return { url: s("url"), title: s("title"), text: s("text") };
}

/** /tmp fallback: our own 0700 directory, not a symlink, owned by us. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.() ?? -1;
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new TabcapError("conflict", `${dir} is not a private directory owned by this user`, `Remove ${dir} or set a shorter $TABCAP_HOME.`);
  }
}
