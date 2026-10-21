// `tabcap replay …`: the commands over parsed arguments (the command registry
// parses them; the handler table, src/cli/handlers.ts, runs these and
// prints); the work is in src/replay/ (offline, no daemon). One exception:
// `replay check --live` asks a running daemon for its fetch stops first
// (daemonGuardState).

import { TabcapError, ok, type Envelope } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { paths, type Paths } from "../shared/paths.ts";
import { send } from "./client.ts";
import { usageOf, type CommandSpec } from "./commands.ts";
import { startReplayServer, type ServeInfo } from "../replay/server.ts";
import { exportSession } from "../replay/session.ts";
import { exportPython } from "../replay/python.ts";
import { DEFAULT_AGAINST, DEFAULT_HEADERS, check, type CheckResult, type LiveGuardState, type LiveStop } from "../replay/check.ts";
import { headerNames } from "../replay/common.ts";
import { accountProxy, writeProxyEnv, type AccountProxy } from "../replay/proxyenv.ts";
import { BundleReader } from "../bundle/reader.ts";
import { loadRules, parsePrefer, type PreferMode, type RuleSet } from "../replay/rules.ts";

/** `--rules <file>`, else config.json `sites.<bundle site>.replay` then `replay` (0.6-C). */
export function bundleRules(bundle: string, file: string | undefined): RuleSet {
  const site = file === undefined ? BundleReader.open(bundle).manifest.session.site : null;
  return loadRules({ file, configFile: paths().configFile, site });
}

/** --proxy-env: the proxy of the account the bundle was recorded with (manifest session.site / account). */
function bundleAccountProxy(bundle: string): AccountProxy {
  const m = BundleReader.open(bundle).manifest;
  const site = m.session.site;
  if (site === null) throw new TabcapError("usage", "--proxy-env: the bundle names no site (manifest session.site)", "Record in a session started with --site <site> --account <user>.");
  const ap = accountProxy(paths().config, site, m.session.account);
  if (ap === null) throw new TabcapError("conflict", `--proxy-env: account ${site}.${m.session.account ?? "(first)"} is not bound to a pool proxy (system / none): there is no proxy URL to write`, "Leave out --proxy-env; or bind the account with `tabcap account bind <site>.<user> --proxy <name>`.");
  return ap;
}

/**
 * `replay check --live` (docs/04 §31): the running daemon's fetch stops, read
 * from its `status` answer (every session's `guardStops`; read-only, no cmd
 * window); `{running:false}` when no daemon answers. Any other failure (a
 * daemon of another version, a timeout) is passed on: the check does not go
 * out unguarded on a guess. The answer is untrusted: malformed rows are left out.
 */
export async function daemonGuardState(p: Paths, sender: typeof send = send): Promise<LiveGuardState> {
  const env = await sender(p, "status", {}, "default", ["status"], 5000);
  if (!env.ok) {
    if (env.error.code === "not-running") return { running: false };
    throw new TabcapError(env.error.code, `replay check --live could not read the daemon's fetch stops: ${env.error.message}`, env.error.next);
  }
  const stops: LiveStop[] = [];
  const sessions = isRecord(env.data) && Array.isArray(env.data["sessions"]) ? env.data["sessions"] : [];
  for (const sess of sessions) {
    const rows = isRecord(sess) && Array.isArray(sess["guardStops"]) ? sess["guardStops"] : [];
    for (const g of rows) {
      if (!isRecord(g)) continue;
      const [site, rule, request, by, reason] = [g["site"], g["rule"], g["request"], g["by"], g["reason"]];
      if (typeof site !== "string" || typeof rule !== "string" || typeof request !== "string" || typeof by !== "string" || typeof reason !== "string") continue;
      if (!stops.some((x) => x.site === site && x.request === request)) stops.push({ site, rule, request, session: by, reason });
    }
  }
  return { running: true, stops };
}

type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numOr = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
/** `--prefer` (0.6-S), or {} when absent. */
const preferArg = (v: unknown): { prefer?: PreferMode } => (typeof v === "string" ? { prefer: parsePrefer(v) } : {});

function serveText(info: ServeInfo): string {
  const rules = info.rules.source === "none" ? "" : `, ${info.rules.rules} rule(s) from ${info.rules.source === "file" ? (info.rules.file ?? "") : "config.json"}`;
  const prefer = info.prefer === null ? "" : `, prefer ${info.prefer}`;
  const lines = [`replaying ${info.bundle} on ${info.url}: ${info.routeCount} route(s), ${info.recordings} recording(s), ${info.skippedCount} skipped${rules}${prefer}. Ctrl-C to stop.`];
  for (const w of info.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

/** `tabcap replay serve <bundle>`: prints one envelope (or a text line) at start, then serves until Ctrl-C. */
export async function replayServe(spec: CommandSpec, args: Record<string, unknown>): Promise<Outcome> {
  const bundle = str(args["bundle"]) ?? "";
  const json = args["json"] === true;
  const once = args["once"];
  if (once !== undefined && (typeof once !== "number" || !(once > 0))) throw new TabcapError("usage", "--once needs a positive number of seconds", `Usage: ${usageOf(spec)}`);
  const port = numOr(args["port"], 4500);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TabcapError("usage", `bad --port ${port}`, "Pass 0-65535 (0 = any free port).");
  const server = await startReplayServer({
    bundle,
    host: str(args["host"]) ?? "127.0.0.1",
    port,
    strict: headerNames(str(args["strict"])),
    matchCookies: args["matchCookies"] === true,
    log: json ? null : (line) => process.stderr.write(line + "\n"),
    rules: bundleRules(bundle, str(args["rules"])),
    configDir: paths().config,
    ...preferArg(args["prefer"]),
  });
  process.stdout.write((json ? JSON.stringify(ok(server.info)) : serveText(server.info)) + "\n");
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    const timer = typeof once === "number" ? setTimeout(done, once * 1000) : null;
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  server.stop();
  if (!json) process.stderr.write(`stopped after ${server.served} request(s)\n`);
  // The envelope was printed at start; nothing more on stdout.
  return { code: -1, envelope: ok({ stopped: true, served: server.served }) };
}

/** `tabcap replay session [<bundle>] -o <file> [--site s]`: a Playwright storageState file. */
export function replaySession(spec: CommandSpec, a: Record<string, unknown>): unknown {
  const bundle = str(a["bundle"]) ?? "";
  const out = str(a["out"]);
  if (out === undefined) throw new TabcapError("usage", "missing -o <file>", `Usage: ${usageOf(spec)}`);
  const site = str(a["site"]);
  if (bundle === "" && site === undefined) throw new TabcapError("usage", "give a bundle, or --site <name> for the store's saved session", `Usage: ${usageOf(spec)}`);
  return exportSession({ bundle: bundle === "" ? null : bundle, out, site, configDir: paths().config });
}

/** `tabcap replay export-python <bundle> -o <dir>`: the generated client package. */
export function replayExportPython(spec: CommandSpec, a: Record<string, unknown>): unknown {
  const bundle = str(a["bundle"]) ?? "";
  const out = str(a["out"]);
  if (out === undefined) throw new TabcapError("usage", "missing -o <dir>", `Usage: ${usageOf(spec)}`);
  if (a["chain"] === true && a["noChain"] === true) throw new TabcapError("usage", "give either --chain or --no-chain, not both", `Usage: ${usageOf(spec)}`);
  const chain = a["chain"] === true ? true : a["noChain"] === true ? false : undefined;
  const proxyEnv = str(a["proxyEnv"]);
  // 0.4-D: resolve the account's proxy first, so a bundle without one fails before anything is written.
  const ap = proxyEnv === undefined ? null : bundleAccountProxy(bundle);
  const result = exportPython({ bundle, out, include: str(a["include"]), exclude: str(a["exclude"]), chain, request: str(a["request"]), browserHeaders: a["browserHeaders"] === true, configDir: paths().config });
  return proxyEnv === undefined || ap === null ? result : { ...result, proxyEnv: writeProxyEnv(proxyEnv, ap) };
}

/** `tabcap replay check <bundle>`; exit 1 on any difference or error. */
export async function replayCheck(a: Record<string, unknown>): Promise<CheckResult> {
  const bundle = str(a["bundle"]) ?? "";
  const rate = a["rate"];
  const headers = headerNames(str(a["headers"]));
  return await check({
    bundle,
    against: str(a["against"]) ?? DEFAULT_AGAINST,
    live: a["live"] === true,
    rate: typeof rate === "number" ? rate : undefined,
    site: str(a["site"]),
    filter: str(a["filter"]),
    withCookies: a["withCookies"] === true,
    headers: headers.length > 0 ? headers : DEFAULT_HEADERS,
    configDir: paths().config,
    rules: bundleRules(bundle, str(a["rules"])),
    ...preferArg(a["prefer"]),
    guardState: () => daemonGuardState(paths()),
  });
}

export const checkCode = (r: CheckResult): number => (r.totals.different + r.totals.errors > 0 ? 1 : 0);
