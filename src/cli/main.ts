// tabcap command line. Only argument parsing and printing live here; every
// command prints exactly one JSON envelope on stdout (docs/03 §5 接口), except
// `--help`, which prints text. Browser commands are forwarded to the daemon.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TabcapError, fail, ok, toFail, type Envelope } from "../shared/envelope.ts";
import { compactStamp, nowMs } from "../shared/time.ts";
import { exportHar, importHar } from "../bundle/har.ts";
import { computeCounts, writeFileAtomic } from "../bundle/manifest.ts";
import { BundleReader } from "../bundle/reader.ts";
import { newSalt, redactBundle, writeSalt } from "../bundle/redact.ts";
import { readConfig, writeConfig } from "../shared/config.ts";
import { envVar } from "../shared/env.ts";
import { isRecord, oneOf } from "../shared/json.ts";
import { paths } from "../shared/paths.ts";
import { runDaemon } from "../daemon/main.ts";
import { binaryVersion, downloadCft } from "../daemon/transport/direct/cft.ts";
import { hostPlatform, type CftPlatform } from "../daemon/transport/direct/launcher.ts";
import { daemonStatus, send, startDaemon, stopDaemon } from "./client.ts";
import { runAnalyze } from "./analyze.ts";
import { renderWhereText, whereResultOf } from "../analyze/where.ts";
import { runReplay } from "./replay.ts";
import { pluginList, pluginSet, siteAdd, siteList, siteRemove } from "./site.ts";
import { accountAdd, accountBind, accountList, accountRemove, accountSetState, proxyAdd, proxyCheck, proxyList, proxyRemove, proxySetState } from "./pool.ts";
import { Store, storePath } from "../daemon/store/db.ts";
import { variantsOf } from "../daemon/secrets.ts";
import { BUNDLE_USAGE, COMMANDS, flagNames, helpAll, helpFor, helpGroup, matchCommand, parseCommand, schema, specOf, usageOf, type CommandSpec } from "./commands.ts";
import { TOOL_NAME, TOOL_VERSION } from "../bundle/manifest.ts";
import { renderTraceText } from "../daemon/trace/table.ts";
import { renderFingerprintText } from "../fingerprint/fields.ts";
import { fingerprintDiff, fingerprintRefList, fingerprintRefRemove, fingerprintRefShow, fingerprintServe } from "./fingerprint.ts";

const USAGE = BUNDLE_USAGE;

type Parsed = { positional: string[]; flags: Map<string, string | true> };

const EXPORT_HAR = specOf("bundle export har");
const IMPORT_HAR = specOf("bundle import har");

/** Flags that take a value; everything else starting with "-" is boolean. */
const VALUE_FLAGS = new Set(
  COMMANDS.filter((c) => c.path[0] === "bundle").flatMap((c) => c.flags.filter((f) => f.kind !== "bool").flatMap((f) => (f.alias === undefined ? [f.flag] : [f.flag, f.alias]))),
);

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(0, eq), a.slice(eq + 1));
      } else if (VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        if (v === undefined) throw new TabcapError("usage", `${a} needs a value`, `Usage: ${USAGE.join(" | ")}`);
        flags.set(a, v);
        i++;
      } else {
        flags.set(a, true);
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function flagStr(p: Parsed, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === "string") return v;
  }
  return undefined;
}

function checkFlags(p: Parsed, allowed: readonly string[], usage: string): void {
  for (const k of p.flags.keys()) {
    if (!allowed.includes(k)) throw new TabcapError("usage", `unknown option ${k}`, `Usage: ${usage}`);
  }
}

function need(p: Parsed, count: number, usage: string): string[] {
  if (p.positional.length !== count) throw new TabcapError("usage", `expected ${count} argument(s), got ${p.positional.length}`, `Usage: ${usage}`);
  return p.positional;
}

/** Secret values of the local store (docs/04 §8.1: redaction also removes them by value). */
function storeSecrets(): string[] {
  const p = paths();
  if (!existsSync(storePath(p.config))) return [];
  const s = Store.open(p.config);
  try {
    // raw, JSON, URI and form spellings: a login POST body carries the form-encoded one
    return [...new Set(s.knownSecrets().flatMap((k) => variantsOf(k.value)))];
  } finally {
    s.close();
  }
}

async function cmdExportHar(p: Parsed): Promise<unknown> {
  const usage = USAGE[0] ?? "";
  checkFlags(p, flagNames(EXPORT_HAR), usage);
  const [dir = ""] = need(p, 1, usage);
  const reader = BundleReader.open(dir);
  const now = nowMs();
  const out = flagStr(p, "--out") ?? join(dir, "exports", `har-${compactStamp(now)}.har`);
  const redact = p.flags.get("--no-redact") !== true;
  const salt = redact ? newSalt() : null;
  const tab = flagStr(p, "--tab");
  const typesFlag = flagStr(p, "--types");
  const res = exportHar(reader, {
    ...(tab === undefined ? {} : { tab }),
    ...(typesFlag === undefined ? {} : { types: typesFlag.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    embedEvents: p.flags.get("--embed-events") === true,
    redact: salt === null ? false : { salt, knownSecrets: storeSecrets() },
  });
  // docs/04 §17: HAR exports are 0600 like the rest of the bundle (they can carry live values with --no-redact).
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileAtomic(out, JSON.stringify(res.har, null, 2) + "\n", 0o600);
  const saltFile = salt === null ? null : writeSalt(dir, basename(out).replace(/\.har$/i, ""), salt);
  return {
    out,
    pages: res.pages,
    entries: res.entries,
    redacted: res.redacted,
    saltFile,
    dropped: res.dropped,
    skipped: res.skipped,
    complete: reader.isComplete(),
    warnings: [
      ...(reader.isComplete() ? [] : ["bundle is not finished: recording in progress or interrupted"]),
      ...(reader.truncatedLastLine ? ["events.jsonl ends with a truncated line; it was skipped"] : []),
      ...(redact ? ["redaction is rule based; free text in bodies may still hold personal data, review before sharing"] : []),
    ],
  };
}

async function cmdImportHar(p: Parsed): Promise<unknown> {
  const usage = USAGE[1] ?? "";
  checkFlags(p, flagNames(IMPORT_HAR), usage);
  const [file = ""] = need(p, 1, usage);
  const out = flagStr(p, "-o", "--out");
  if (out === undefined) throw new TabcapError("usage", "missing -o <bundle>", `Usage: ${usage}`);
  if (!existsSync(file)) throw new TabcapError("not-found", `HAR file not found: ${file}`, "Check the path of the .har file.");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw new TabcapError("bad-input", `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "Export the HAR again; the file may be truncated.");
  }
  return importHar(json, out, { name: basename(file).replace(/\.har$/i, "") });
}

async function cmdRedact(p: Parsed): Promise<unknown> {
  const usage = USAGE[2] ?? "";
  checkFlags(p, [], usage);
  const [src = "", out = ""] = need(p, 2, usage);
  const res = await redactBundle(src, out, { knownSecrets: storeSecrets() });
  return { ...res, warnings: ["redaction is rule based; free text in bodies may still hold personal data, review before sharing"] };
}

function cmdInfo(p: Parsed): unknown {
  const usage = USAGE[3] ?? "";
  checkFlags(p, [], usage);
  const [dir = ""] = need(p, 1, usage);
  const r = BundleReader.open(dir);
  const kinds: Record<string, number> = {};
  for (const e of r.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const recount = computeCounts(r.events, r.manifest.counts.blobBytes);
  r.requests(); // adds bad-request issues, if any
  const warnings: string[] = [];
  if (!r.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted");
  if (r.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  if (recount.events !== r.manifest.counts.events) warnings.push(`manifest counts.events=${r.manifest.counts.events} but events.jsonl has ${recount.events}`);
  return {
    dir,
    format: r.manifest.format,
    id: r.manifest.id,
    session: r.manifest.session.name,
    complete: r.isComplete(),
    created: r.manifest.created,
    finished: r.manifest.finished ?? null,
    counts: r.manifest.counts,
    events: r.events.length,
    kinds,
    imported: r.manifest.imported,
    redaction: r.manifest.redaction,
    truncatedLastLine: r.truncatedLastLine,
    issues: r.issues,
    warnings,
  };
}

const PLATFORMS: readonly CftPlatform[] = ["mac-arm64", "mac-x64", "linux64", "win64"];

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
    return { executablePath: exe, version, downloaded: false, config: p.configFile };
  }
  const plat = platArg ?? hostPlatform();
  if (!oneOf(PLATFORMS, plat)) throw new TabcapError("unsupported", `no Chrome for Testing build for ${plat ?? process.platform + "-" + process.arch}`, "Use --platform mac-arm64|mac-x64|linux64|win64, or --executable-path.");
  const r = await downloadCft(p.chromeCache, plat);
  writeConfig(p.configFile, { ...cfg, chrome: { executablePath: r.executablePath, version: r.version, platform: plat } });
  return { ...r, platform: plat, config: p.configFile };
}

async function runSpec(c: CommandSpec, argv: readonly string[], raw: readonly string[]): Promise<{ code: number; envelope: Envelope<unknown>; text?: string }> {
  const parsed = parseCommand(c, argv);
  if (parsed.help) {
    const text = helpFor(c);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const key = c.path.join(" ");
  const p = paths();
  let data: unknown;
  switch (key) {
    case "setup":
      data = await cmdSetup(parsed.args);
      break;
    case "daemon start":
      // Store permission problems surface here, not as a daemon that never comes up.
      Store.open(p.config).close();
      data = await startDaemon(p);
      break;
    case "site add":
      data = await siteAdd(p, parsed.args);
      break;
    case "site list":
      data = siteList(p);
      break;
    case "site remove":
      data = siteRemove(p, parsed.args);
      break;
    case "proxy add":
      data = await proxyAdd(p, parsed.args);
      break;
    case "proxy list":
      data = proxyList(p);
      break;
    case "proxy remove":
      data = proxyRemove(p, parsed.args);
      break;
    case "proxy check":
      data = await proxyCheck(p, parsed.args);
      break;
    case "proxy set-state":
      data = proxySetState(p, parsed.args);
      break;
    case "account add":
      data = await accountAdd(p, parsed.args);
      break;
    case "account remove":
      data = await accountRemove(p, parsed.args);
      break;
    case "account bind":
      data = accountBind(p, parsed.args);
      break;
    case "account list":
      data = accountList(p, parsed.args);
      break;
    case "account set-state":
      data = accountSetState(p, parsed.args);
      break;
    case "plugin list":
      data = pluginList(p);
      break;
    case "plugin enable":
      data = pluginSet(p, parsed.args, true);
      break;
    case "plugin disable":
      data = pluginSet(p, parsed.args, false);
      break;
    case "fingerprint serve":
      return await fingerprintServe(p, parsed.args);
    case "fingerprint ref list":
      data = fingerprintRefList(p);
      break;
    case "fingerprint ref show":
      data = fingerprintRefShow(p, parsed.args);
      break;
    case "fingerprint ref remove":
      data = fingerprintRefRemove(p, parsed.args);
      break;
    case "fingerprint diff": {
      const r = fingerprintDiff(p, parsed.args);
      return parsed.args["text"] === true ? { code: 0, envelope: ok(r), text: renderFingerprintText(r) } : { code: 0, envelope: ok(r) };
    }
    case "daemon stop":
      data = await stopDaemon(p);
      break;
    case "daemon status":
      data = await daemonStatus(p);
      break;
    case "daemon run":
      await runDaemon(p);
      return { code: -1, envelope: ok({ running: true }) };
    case "schema":
      if (parsed.args["json"] === true) return { code: 0, envelope: ok(schema()), text: JSON.stringify(schema(), null, 2) };
      data = schema();
      break;
    default: {
      if (c.action === undefined) throw new TabcapError("internal", `no handler for ${key}`, "This is a bug.");
      const session = parsed.session ?? envVar("SESSION") ?? "default";
      const timeout = typeof parsed.args["timeoutMs"] === "number" ? parsed.args["timeoutMs"] : 30_000;
      const env = await send(p, c.action, withLocalPaths(c, parsed.args, process.cwd()), session, [...raw], timeout);
      const code = env.ok ? 0 : env.error.code === "usage" ? 2 : 1;
      // `where --text`: the daemon answers JSON as always; the human report is rendered here.
      if (key === "where" && parsed.args["text"] === true && env.ok) {
        const r = whereResultOf(env.data);
        const saved = isRecord(env.data) && isRecord(env.data["saved"]) ? env.data["saved"] : null;
        const seqs = saved !== null && Array.isArray(saved["seqs"]) ? saved["seqs"].length : 0;
        if (r !== null) return { code, envelope: env, text: renderWhereText(r) + (saved === null ? "" : `\nwrote ${seqs} finding event(s) to ${String(saved["bundle"] ?? "")}`) };
      }
      // `trace list --text`: the report is rendered here from the daemon's JSON.
      if (key === "trace list" && parsed.args["text"] === true && env.ok) return { code, envelope: env, text: renderTraceText(env.data) };
      // `fingerprint probe --text`: the table is rendered here from the daemon's JSON.
      if (key === "fingerprint probe" && parsed.args["text"] === true && env.ok) return { code, envelope: env, text: renderFingerprintText(env.data) };
      return { code, envelope: env };
    }
  }
  return { code: 0, envelope: ok(data) };
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
  const group = words[0] === undefined ? null : helpGroup(words[0]);
  if (group !== null) return { code: 0, text: group };
  return null;
}

export async function run(argv: readonly string[]): Promise<{ code: number; envelope: Envelope<unknown>; text?: string }> {
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
    if (argv[0] === "bundle") return await runBundle(argv);
    if (argv[0] === "analyze") return await runAnalyze(argv);
    if (argv[0] === "replay") return await runReplay(argv);
    const c = matchCommand(words);
    if (c === null) {
      const got = words.slice(0, 2).join(" ");
      const all = COMMANDS.filter((c) => c.internal !== true).map((c) => usageOf(c));
      return { code: 2, envelope: fail("usage", got === "" ? "no command given" : `unknown command: ${got}`, `Run \`tabcap --help\`. Available: ${all.join(" | ")}`) };
    }
    // Drop the command words (first occurrences, in order) and keep everything else.
    const rest = [...argv];
    for (const w of c.path) rest.splice(rest.indexOf(w), 1);
    return await runSpec(c, rest, argv);
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
}

async function runBundle(argv: readonly string[]): Promise<{ code: number; envelope: Envelope<unknown>; text?: string }> {
  try {
    if (argv.includes("--help")) {
      const text = ["Evidence bundle tools:", ...USAGE.map((u) => `  ${u}`)].join("\n");
      return { code: 0, envelope: ok({ help: text }), text };
    }
    const p = parseArgs(argv);
    const [group, sub, third] = p.positional;
    const rest = (n: number): Parsed => ({ positional: p.positional.slice(n), flags: p.flags });
    let data: unknown;
    if (group === "bundle" && sub === "export" && third === "har") data = await cmdExportHar(rest(3));
    else if (group === "bundle" && sub === "import" && third === "har") data = await cmdImportHar(rest(3));
    else if (group === "bundle" && sub === "redact") data = await cmdRedact(rest(2));
    else if (group === "bundle" && sub === "info") data = cmdInfo(rest(2));
    else {
      const got = p.positional.slice(0, 3).join(" ");
      return { code: 2, envelope: fail("usage", got === "" ? "no command given" : `unknown command: ${got}`, `Available: ${USAGE.join(" | ")}`) };
    }
    return { code: 0, envelope: ok(data) };
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
