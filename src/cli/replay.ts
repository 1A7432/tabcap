// `tabcap replay …`: argument parsing and printing only; the work is in
// src/replay/ (offline, no daemon).

import { TabcapError, fail, ok, toFail, type Envelope } from "../shared/envelope.ts";
import { paths } from "../shared/paths.ts";
import { helpFor, helpGroup, parseCommand, specOf, usageOf, type CommandSpec } from "./commands.ts";
import { startReplayServer, type ServeInfo } from "../replay/server.ts";
import { exportSession } from "../replay/session.ts";
import { exportPython } from "../replay/python.ts";
import { DEFAULT_AGAINST, DEFAULT_HEADERS, check, renderCheckText } from "../replay/check.ts";
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

type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };

const SUBS = ["serve", "session", "export-python", "check"] as const;
type Sub = (typeof SUBS)[number];
const isSub = (s: string | undefined): s is Sub => SUBS.some((x) => x === s);

export const REPLAY_USAGE = SUBS.map((s) => usageOf(specOf(`replay ${s}`)));

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numOr = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
/** `--prefer` (0.6-S), or {} when absent. */
const preferArg = (v: unknown): { prefer?: PreferMode } => (typeof v === "string" ? { prefer: parsePrefer(v) } : {});

/** `-o` is the only short flag; parseCommand knows long flags. */
function longFlags(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return argv.map((a, i) => (a === "-o" && (end < 0 || i < end) ? "--out" : a));
}

function serveText(info: ServeInfo): string {
  const rules = info.rules.source === "none" ? "" : `, ${info.rules.rules} rule(s) from ${info.rules.source === "file" ? (info.rules.file ?? "") : "config.json"}`;
  const prefer = info.prefer === null ? "" : `, prefer ${info.prefer}`;
  const lines = [`replaying ${info.bundle} on ${info.url}: ${info.routeCount} route(s), ${info.recordings} recording(s), ${info.skippedCount} skipped${rules}${prefer}. Ctrl-C to stop.`];
  for (const w of info.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

async function serve(spec: CommandSpec, args: Record<string, unknown>): Promise<Outcome> {
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

export async function runReplay(argv: readonly string[]): Promise<Outcome> {
  try {
    const [, sub, ...rest] = argv;
    if (sub === undefined || sub === "--help" || sub === "-h") {
      const text = helpGroup("replay") ?? REPLAY_USAGE.join("\n");
      return { code: 0, envelope: ok({ help: text }), text };
    }
    if (!isSub(sub)) return { code: 2, envelope: fail("usage", `unknown command: replay ${sub}`, `Available: ${REPLAY_USAGE.join(" | ")}`) };
    const spec = specOf(`replay ${sub}`);
    const parsed = parseCommand(spec, longFlags(rest));
    if (parsed.help) {
      const text = helpFor(spec);
      return { code: 0, envelope: ok({ help: text }), text };
    }
    const a = parsed.args;
    const bundle = str(a["bundle"]) ?? "";
    switch (sub) {
      case "serve":
        return await serve(spec, a);
      case "session": {
        const out = str(a["out"]);
        if (out === undefined) throw new TabcapError("usage", "missing -o <file>", `Usage: ${usageOf(spec)}`);
        const site = str(a["site"]);
        if (bundle === "" && site === undefined) throw new TabcapError("usage", "give a bundle, or --site <name> for the store's saved session", `Usage: ${usageOf(spec)}`);
        return { code: 0, envelope: ok(exportSession({ bundle: bundle === "" ? null : bundle, out, site, configDir: paths().config })) };
      }
      case "export-python": {
        const out = str(a["out"]);
        if (out === undefined) throw new TabcapError("usage", "missing -o <dir>", `Usage: ${usageOf(spec)}`);
        if (a["chain"] === true && a["noChain"] === true) throw new TabcapError("usage", "give either --chain or --no-chain, not both", `Usage: ${usageOf(spec)}`);
        const chain = a["chain"] === true ? true : a["noChain"] === true ? false : undefined;
        const proxyEnv = str(a["proxyEnv"]);
        // 0.4-D: resolve the account's proxy first, so a bundle without one fails before anything is written.
        const ap = proxyEnv === undefined ? null : bundleAccountProxy(bundle);
        const result = exportPython({ bundle, out, include: str(a["include"]), exclude: str(a["exclude"]), chain, browserHeaders: a["browserHeaders"] === true });
        return { code: 0, envelope: ok(proxyEnv === undefined || ap === null ? result : { ...result, proxyEnv: writeProxyEnv(proxyEnv, ap) }) };
      }
      case "check": {
        const rate = a["rate"];
        const headers = headerNames(str(a["headers"]));
        const result = await check({
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
        });
        const code = result.totals.different + result.totals.errors > 0 ? 1 : 0;
        if (a["json"] === true) return { code, envelope: ok(result) };
        return { code, envelope: ok(result), text: renderCheckText(result) };
      }
    }
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
}
