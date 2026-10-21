// tabcap command line. Only argument parsing, dispatch and printing live here;
// every command prints exactly one JSON envelope on stdout (docs/03 §5 接口),
// except `--help`, which prints text. argv is parsed with the command registry
// (commands.ts); what each command does is in the handler table (handlers.ts);
// browser commands are forwarded to the daemon.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TabcapError, fail, ok, toFail, type Envelope } from "../shared/envelope.ts";
import { readConfig, readConfigWarnings, writeConfig } from "../shared/config.ts";
import { envVar } from "../shared/env.ts";
import { isRecord, oneOf } from "../shared/json.ts";
import { paths } from "../shared/paths.ts";
import { binaryVersion, downloadCft } from "../daemon/transport/direct/cft.ts";
import { hostPlatform, type CftPlatform } from "../daemon/transport/direct/launcher.ts";
import { send, status as daemonPing } from "./client.ts";
import { runAnalyze } from "./analyze.ts";
import { runReplay } from "./replay.ts";
import { OUTPUT_FLAGS, OUTPUT_FLAGS_NOT_ON, helpAll, helpFor, helpTopic, matchCommand, unknownCommandName, unknownCommandNext, parseCommand, spellingsOf, type CommandSpec } from "./commands.ts";
import { applyFilters, filterOptions, hasFilters, type FilterOptions } from "../shared/filter.ts";
import { applyBudget, outputLimit } from "../shared/budget.ts";
import { TOOL_NAME, TOOL_VERSION } from "../bundle/manifest.ts";
import type { RunOptions } from "../mcp/tools.ts";
import { handlerOf, handlerTable, type Ctx, type Outcome, type Sent } from "./handlers.ts";

/** What the CLI does for each command (src/cli/handlers.ts); `setup` and `run` live here. */
export const HANDLERS = handlerTable({ run, setup: cmdSetup });

const PLATFORMS: readonly CftPlatform[] = ["mac-arm64", "mac-x64", "linux64", "win64"];

/**
 * `tabcap setup`. Review wave 3 (docs/04 §44): a config.json it cannot parse is refused before anything
 * else (readConfig) and never rewritten; the answer's `warnings` are the written file's unknown keys.
 */
async function cmdSetup(args: Record<string, unknown>): Promise<unknown> {
  const p = paths();
  const exe = typeof args["executablePath"] === "string" ? args["executablePath"] : null;
  const platArg = typeof args["platform"] === "string" ? args["platform"] : null;
  const cfg = readConfig(p.configFile);
  if (exe !== null) {
    if (!existsSync(exe)) throw new TabcapError("not-found", `no such file: ${exe}`, "Pass the path of the Chrome for Testing binary itself (inside the .app on macOS).");
    const v = binaryVersion(exe);
    if (v === null) throw new TabcapError("io", `${exe} --version failed`, "Make sure the path is a Chrome for Testing binary that runs on this machine.");
    const version = /(\d+(?:\.\d+)+)/.exec(v)?.[1] ?? v;
    writeConfig(p.configFile, { ...cfg, chrome: { executablePath: exe, version, platform: null } });
    return { executablePath: exe, version, downloaded: false, config: p.configFile, warnings: readConfigWarnings(p.configFile) };
  }
  const plat = platArg ?? hostPlatform();
  if (!oneOf(PLATFORMS, plat)) throw new TabcapError("unsupported", `no Chrome for Testing build for ${plat ?? process.platform + "-" + process.arch}`, "Use --platform mac-arm64|mac-x64|linux64|win64, or --executable-path.");
  const r = await downloadCft(p.chromeCache, plat);
  writeConfig(p.configFile, { ...cfg, chrome: { executablePath: r.executablePath, version: r.version, platform: plat } });
  return { ...r, platform: plat, config: p.configFile, warnings: readConfigWarnings(p.configFile) };
}

async function runSpec(c: CommandSpec, argv: readonly string[], raw: readonly string[], opts: RunOptions): Promise<Outcome> {
  const parsed = parseCommand(c, argv);
  if (parsed.help) {
    const text = helpFor(c);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const key = c.path.join(" ");
  const h = handlerOf(HANDLERS, key) ?? {};
  const ctx: Ctx = { spec: c, args: parsed.args, paths: paths(), cwd: process.cwd() };
  if (c.action === undefined) {
    if (h.run === undefined) throw new TabcapError("internal", `no handler for ${key}`, "This is a bug.");
    return await h.run(ctx);
  }
  // `opts`: an MCP tool's session / timeout for a command without the flag (src/mcp/tools.ts).
  const session = parsed.session ?? opts.session ?? envVar("SESSION") ?? "default";
  const timeoutMs = typeof parsed.args["timeoutMs"] === "number" ? parsed.args["timeoutMs"] : (opts.timeoutMs ?? 30_000);
  const first: Sent = { args: withLocalPaths(c, parsed.args, ctx.cwd), timeoutMs };
  const sent = h.prepare === undefined ? first : h.prepare(first, ctx);
  const answer = await send(ctx.paths, c.action, sent.args, session, [...raw], sent.timeoutMs);
  const env = !answer.ok && h.fallback !== undefined ? (h.fallback(answer, ctx) ?? answer) : answer;
  if (env.ok && h.output !== undefined) {
    const out = h.output(env);
    if (out !== null) return out;
  }
  const code = env.ok ? 0 : env.error.code === "usage" ? 2 : 1;
  const text = env.ok && parsed.args["text"] === true && h.render !== undefined ? h.render(env.data) : null;
  return text === null ? { code, envelope: env } : { code, envelope: env, text };
}

/**
 * Local file paths (`--file-path`, `upload` files …) are relative to the
 * caller's working directory, not the daemon's: resolve them here.
 */
export function withLocalPaths(c: CommandSpec, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const out = { ...args };
  for (const k of c.localPaths ?? []) {
    const v = out[k];
    if (typeof v === "string" && v !== "") out[k] = resolve(cwd, v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" && x !== "" ? resolve(cwd, x) : x));
  }
  return out;
}

/** Run one command; returns the envelope and the exit code (0 ok, 1 error, 2 usage; -1 keep running). */
/**
 * `--help` / `-h` anywhere before `--`, or `help <command…>`: help for the
 * longest matching command (`tabcap net list --help`, `tabcap bundle export har -h`),
 * a group's subcommands (`tabcap net --help`), or everything. Null: not a help request.
 */
export function helpRequest(argv: readonly string[]): { code: number; text: string } | null {
  const end = argv.indexOf("--");
  const head = end < 0 ? [...argv] : argv.slice(0, end);
  const asked = head[0] === "help" || head.includes("--help") || head.includes("-h");
  if (!asked) return null;
  const words = head.filter((a) => !a.startsWith("-")).slice(head[0] === "help" ? 1 : 0);
  if (words.length === 0) return { code: 0, text: helpAll() };
  const c = matchCommand(words);
  if (c !== null) return { code: 0, text: helpFor(c) };
  const group = words[0] === undefined ? null : helpTopic(words[0]);
  if (group !== null) return { code: 0, text: group };
  return null;
}

type OutputOptions = { filters: FilterOptions; full: boolean; given: string[] };

/**
 * Take the output flags (OUTPUT_FLAGS) out of argv, up to `--`: they act on
 * the envelope after the command ran, so no command parser sees them.
 * `--full` stays in place for the commands in OUTPUT_FLAGS_NOT_ON.
 */
export function takeOutputFlags(argv: readonly string[]): { rest: string[]; out: OutputOptions } {
  const end = argv.indexOf("--");
  const head = end < 0 ? [...argv] : argv.slice(0, end);
  const tail = end < 0 ? [] : argv.slice(end);
  const values: Record<string, string> = {};
  const given: string[] = [];
  let full = false;
  const rest: string[] = [];
  const words = head.filter((a) => !a.startsWith("-"));
  const command = matchCommand(words)?.path.join(" ") ?? "";
  for (let i = 0; i < head.length; i++) {
    const a = head[i] ?? "";
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const spec = OUTPUT_FLAGS.find((f) => spellingsOf(f).includes(name));
    if (spec === undefined || (OUTPUT_FLAGS_NOT_ON[spec.flag] ?? []).includes(command)) {
      rest.push(a);
      continue;
    }
    if (spec.kind === "bool") {
      if (eq > 0) throw new TabcapError("usage", `${name} takes no value`, "e.g. tabcap analyze deps <bundle> --full");
      full = true;
      given.push(spec.flag);
      continue;
    }
    const v = eq > 0 ? a.slice(eq + 1) : head[++i];
    if (v === undefined) throw new TabcapError("usage", `${name} needs a value`, `${spec.flag} <${spec.metavar ?? "v"}>: ${spec.help}`);
    if (Object.hasOwn(values, spec.key)) throw new TabcapError("usage", `${name} given twice`, `Give ${spec.flag} once.`);
    values[spec.key] = v;
    given.push(spec.flag);
  }
  const pick = (k: string): string | undefined => (Object.hasOwn(values, k) ? values[k] : undefined);
  const filters = filterOptions({ select: pick("select"), grep: pick("grep"), context: pick("context"), maxMatches: pick("maxMatches"), fields: pick("fields") });
  return { rest: [...rest, ...tail], out: { filters, full, given } };
}

/** `--session <name>` / `--session=<name>` of a daemon command, else $TABCAP_SESSION, else `default`. */
function sessionOf(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") break;
    const next = argv[i + 1];
    if (a === "--session" && next !== undefined) return next;
    if (a.startsWith("--session=")) return a.slice("--session=".length);
  }
  return envVar("SESSION") ?? "default";
}

/** Where an over-budget answer goes: the session's open recording (asked from the daemon), else the cache. */
async function budgetTarget(c: CommandSpec | null, argv: readonly string[]): Promise<{ bundle: string } | { cache: string }> {
  const p = paths();
  if (c?.action !== undefined) {
    const session = sessionOf(argv);
    const st = await daemonPing(p);
    const recs = st.ok && isRecord(st.data) && Array.isArray(st.data["recordings"]) ? st.data["recordings"].filter(isRecord) : [];
    const open = recs.find((r) => r["session"] === session && r["recording"] === true && typeof r["bundle"] === "string");
    if (open !== undefined && typeof open["bundle"] === "string") return { bundle: open["bundle"] };
  }
  return { cache: p.cache };
}

/** The output layer: filters, then the budget, on an ok envelope that is printed as JSON. */
async function shapeOutput(r: Outcome, argv: readonly string[], out: OutputOptions): Promise<Outcome> {
  if (!r.envelope.ok || r.code === -1 || argv.length === 0 || helpRequest(argv) !== null) return r;
  if (r.text !== undefined) {
    if (!hasFilters(out.filters)) return r;
    return { code: 2, envelope: fail("usage", `${out.given.join(" / ")} filter the JSON envelope, but this command printed text`, "Leave out --text (or --json for schema) to filter the JSON answer, or leave out the filter flags.") };
  }
  const c = matchCommand(argv.filter((a) => !a.startsWith("-")));
  const command = c?.path.join(" ") ?? "";
  let data: unknown = r.envelope.data;
  let filter: Record<string, unknown> | null = null;
  if (hasFilters(out.filters)) {
    const f = applyFilters(data, out.filters);
    data = f.data;
    filter = f.filter;
  }
  data = await applyBudget(command, data, { limit: outputLimit(), full: out.full, target: () => budgetTarget(c, argv) });
  const envelope: Envelope<unknown> = { ok: true, data, ...(filter === null ? {} : { ...(out.filters.select === null ? {} : { selected: out.filters.select }), filter }) };
  return { ...r, envelope };
}

export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<Outcome> {
  let taken: { rest: string[]; out: OutputOptions };
  try {
    taken = takeOutputFlags(argv);
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
  const r = await runCommand(taken.rest, opts);
  try {
    return await shapeOutput(r, taken.rest, taken.out);
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
}

async function runCommand(argv: readonly string[], opts: RunOptions = {}): Promise<Outcome> {
  try {
    const words = argv.filter((a) => !a.startsWith("-"));
    if (argv.length === 0) {
      const text = helpAll();
      return { code: 2, envelope: ok({ help: text }), text };
    }
    if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version") {
      return { code: 0, envelope: ok({ tool: TOOL_NAME, version: TOOL_VERSION }) };
    }
    const help = helpRequest(argv);
    if (help !== null) return { code: help.code, envelope: ok({ help: help.text }), text: help.text };
    if (argv[0] === "analyze") return await runAnalyze(argv);
    if (argv[0] === "replay") return await runReplay(argv);
    const c = matchCommand(words);
    if (c === null) {
      const got = unknownCommandName(words);
      // 0.7-C: the closest commands, never the whole list (it was 8 KB).
      return { code: 2, envelope: fail("usage", got === "" ? "no command given" : `unknown command: ${got}`, got === "" ? "Run `tabcap --help` for the command groups." : unknownCommandNext(words)) };
    }
    // Drop the command words (first occurrences, in order) and keep everything else.
    const rest = [...argv];
    for (const w of c.path) rest.splice(rest.indexOf(w), 1);
    return await runSpec(c, rest, argv, opts);
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
}

if (import.meta.main) {
  const { code, envelope, text } = await run(process.argv.slice(2));
  if (code !== -1) {
    process.stdout.write(text !== undefined ? text + "\n" : JSON.stringify(envelope) + "\n");
    process.exit(code);
  }
}
