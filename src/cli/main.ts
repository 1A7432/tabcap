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
import { parseBusinessRule, parseUsageActor, renderUsageText, usageReport, type UsageReport } from "../bundle/usage.ts";
import { newSalt, redactBundle, writeSalt } from "../bundle/redact.ts";
import { readConfig, writeConfig } from "../shared/config.ts";
import { envVar } from "../shared/env.ts";
import { isRecord, oneOf } from "../shared/json.ts";
import { paths } from "../shared/paths.ts";
import { runDaemon } from "../daemon/main.ts";
import { binaryVersion, downloadCft } from "../daemon/transport/direct/cft.ts";
import { hostPlatform, type CftPlatform } from "../daemon/transport/direct/launcher.ts";
import { daemonStatus, send, startDaemon, status as daemonPing, stopDaemon } from "./client.ts";
import { runAnalyze } from "./analyze.ts";
import { renderWhereText, whereResultOf } from "../analyze/where.ts";
import { runReplay } from "./replay.ts";
import { pluginList, pluginSet, siteAdd, siteList, siteRemove } from "./site.ts";
import { pluginInit } from "./plugin-init.ts";
import { accountAdd, accountBind, accountList, accountRemove, accountSetState, proxyAdd, proxyCheck, proxyList, proxyRemove, proxySetState } from "./pool.ts";
import { Store, storePath } from "../daemon/store/db.ts";
import { Secrets, variantsOf } from "../daemon/secrets.ts";
import { decodeBundle } from "../bundle/decode.ts";
import { exportFixtures } from "../bundle/fixtures.ts";
import { readRulesFile, rulesInfo } from "../replay/rules.ts";
import { bundleRules } from "./replay.ts";
import { DecodeHost, DecodeSession, type DecodePlugin } from "../daemon/hooks/decode.ts";
import { asDecodePlugin, asFixturePlugin, decodePlugins, listPlugins, pluginsDir } from "../daemon/hooks/plugins.ts";
import type { FixturePlugin } from "../daemon/hooks/fixture.ts";
import { BUNDLE_USAGE, COMMANDS, OUTPUT_FLAGS, OUTPUT_FLAGS_NOT_ON, flagNames, helpAll, helpFor, helpTopic, matchCommand, parseCommand, schema, specOf, spellingsOf, usageOf, type CommandSpec } from "./commands.ts";
import { applyFilters, filterOptions, hasFilters, type FilterOptions } from "../shared/filter.ts";
import { applyBudget, outputLimit } from "../shared/budget.ts";
import { TOOL_NAME, TOOL_VERSION } from "../bundle/manifest.ts";
import { renderTraceText } from "../daemon/trace/table.ts";
import { offlineStatus, renderStatusText } from "../daemon/tools/status.ts";
import { renderFingerprintText } from "../fingerprint/fields.ts";
import { fingerprintDiff, fingerprintRefList, fingerprintRefRemove, fingerprintRefShow, fingerprintServe } from "./fingerprint.ts";
import { wireCaPath, wireServe, wireVersion } from "./wire.ts";
import { renderWireText, wireResultOf } from "../wire/probe.ts";
import type { RunOptions } from "../mcp/tools.ts";
import { hostConfig } from "../mcp/hosts.ts";
import { fetchArgs, fetchClientTimeout } from "./fetch.ts";
import { guideList, guideOf, renderGuideListText, renderGuideText } from "./guides.ts";

const USAGE = BUNDLE_USAGE;

type Parsed = { positional: string[]; flags: Map<string, string | true>; repeated: Map<string, string[]> };

const EXPORT_HAR = specOf("bundle export har");
const IMPORT_HAR = specOf("bundle import har");
const DECODE = specOf("bundle decode");
const INFO = specOf("bundle info");
const EXPORT_FIXTURES = specOf("bundle export fixtures");

/** Flags that take a value; everything else starting with "-" is boolean. */
const VALUE_FLAGS = new Set(
  COMMANDS.filter((c) => c.path[0] === "bundle").flatMap((c) => c.flags.filter((f) => f.kind !== "bool").flatMap((f) => (f.alias === undefined ? [f.flag] : [f.flag, f.alias]))),
);

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const setFlag = (name: string, v: string): void => {
    flags.set(name, v);
    repeated.set(name, [...(repeated.get(name) ?? []), v]);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      if (eq > 0) {
        setFlag(a.slice(0, eq), a.slice(eq + 1));
      } else if (VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        if (v === undefined) throw new TabcapError("usage", `${a} needs a value`, `Usage: ${USAGE.join(" | ")}`);
        setFlag(a, v);
        i++;
      } else {
        flags.set(a, true);
      }
    } else positional.push(a);
  }
  return { positional, flags, repeated };
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
  const rulesFile = flagStr(p, "--rules");
  // 0.6-C: --rules only drops each rule's ignoreQuery parameters (no config.json fallback here).
  const rules = rulesFile === undefined ? undefined : readRulesFile(rulesFile);
  const res = exportHar(reader, {
    ...(tab === undefined ? {} : { tab }),
    ...(typesFlag === undefined ? {} : { types: typesFlag.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    embedEvents: p.flags.get("--embed-events") === true,
    redact: salt === null ? false : { salt, knownSecrets: storeSecrets() },
    ...(rules === undefined ? {} : { rules }),
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
    ...(rules === undefined ? {} : { rules: rulesInfo(rules) }),
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

/** `tabcap bundle decode <bundle> [--plugin name]` (0.6-B, bundle/decode.ts). */
async function cmdDecode(p: Parsed): Promise<unknown> {
  const usage = USAGE[4] ?? "";
  checkFlags(p, flagNames(DECODE), usage);
  const [dir = ""] = need(p, 1, usage);
  const config = paths().config;
  const name = flagStr(p, "--plugin");
  let plugins: DecodePlugin[];
  if (name !== undefined) {
    const info = listPlugins(config).find((x) => x.name === name);
    if (info === undefined) throw new TabcapError("not-found", `no plugin named "${name}" in ${pluginsDir(config)}`, "Install it in its own directory with a manifest.json, then `tabcap plugin list`.");
    if (info.manifest === null) throw new TabcapError("bad-input", `plugin "${name}" is not usable: ${info.error ?? "invalid"}`, "Fix its manifest.json; `tabcap plugin list` shows the error.");
    plugins = asDecodePlugin(info);
    if (plugins.length === 0) throw new TabcapError("usage", `plugin "${name}" is not a decode plugin`, 'Decode plugins have "kind": "decode" in manifest.json (docs/04 §28).');
  } else {
    plugins = decodePlugins(config);
    if (plugins.length === 0) throw new TabcapError("not-found", "no enabled decode plugin", "Install one under the plugins directory and `tabcap plugin enable <name>`, or pass --plugin <name>.");
  }
  const secrets = new Secrets();
  if (existsSync(storePath(config))) {
    const s = Store.open(config);
    try {
      secrets.setStored(s.knownSecrets());
    } finally {
      s.close();
    }
  }
  const host = new DecodeHost();
  const disabled: { plugin: string; reason: string }[] = [];
  const session = new DecodeSession(host, plugins, { scrub: (t) => secrets.scrub(t), onDisabled: (plugin, reason) => disabled.push({ plugin, reason }) });
  try {
    const res = await decodeBundle(dir, session);
    return { ...res, plugins: plugins.map((x) => ({ name: x.name, version: x.version })), disabled };
  } finally {
    host.close();
  }
}

/** `tabcap bundle export fixtures <bundle> --out <dir> [--rules f] [--format json|plugin] [--no-redact]` (0.6-C, bundle/fixtures.ts). */
async function cmdExportFixtures(p: Parsed): Promise<unknown> {
  const usage = USAGE[5] ?? "";
  checkFlags(p, flagNames(EXPORT_FIXTURES), usage);
  const [dir = ""] = need(p, 1, usage);
  const out = flagStr(p, "--out");
  if (out === undefined) throw new TabcapError("usage", "missing --out <dir>", `Usage: ${usage}`);
  const reader = BundleReader.open(dir);
  const config = paths().config;
  const formatName = flagStr(p, "--format") ?? "json";
  let format: "json" | FixturePlugin = "json";
  if (formatName !== "json") {
    const info = listPlugins(config).find((x) => x.name === formatName);
    if (info === undefined) throw new TabcapError("not-found", `no plugin named "${formatName}" in ${pluginsDir(config)}`, 'Pass --format json, or install a fixture plugin (manifest.json with "kind": "fixture", docs/04 §31), then `tabcap plugin list`.');
    if (info.manifest === null) throw new TabcapError("bad-input", `plugin "${formatName}" is not usable: ${info.error ?? "invalid"}`, "Fix its manifest.json; `tabcap plugin list` shows the error.");
    const fp = asFixturePlugin(info)[0];
    if (fp === undefined) throw new TabcapError("usage", `plugin "${formatName}" is not a fixture plugin`, 'Fixture plugins have "kind": "fixture" in manifest.json (docs/04 §31).');
    format = fp;
  }
  const rules = bundleRules(dir, flagStr(p, "--rules"));
  const redact = p.flags.get("--no-redact") !== true;
  const salt = redact ? newSalt() : null;
  const res = await exportFixtures(reader, { out, rules, format, redact: salt === null ? false : { salt, knownSecrets: storeSecrets() }, configDir: config, includePreflight: p.flags.get("--include-preflight") === true });
  const saltFile = salt === null ? null : writeSalt(dir, `fixtures-${compactStamp(nowMs())}`, salt);
  return {
    ...res,
    saltFile,
    complete: reader.isComplete(),
    warnings: [...(reader.isComplete() ? [] : ["bundle is not finished: recording in progress or interrupted"]), ...(reader.truncatedLastLine ? ["events.jsonl ends with a truncated line; it was skipped"] : []), ...res.warnings],
  };
}

function cmdInfo(p: Parsed): unknown {
  const usage = USAGE[3] ?? "";
  checkFlags(p, flagNames(INFO), usage);
  const [dir = ""] = need(p, 1, usage);
  const wantUsage = p.flags.get("--usage") === true;
  if (!wantUsage && ["--text", "--business-code", "--actor", "--all-hosts"].some((f) => p.flags.has(f))) throw new TabcapError("usage", "--text, --business-code, --actor and --all-hosts belong to --usage", `Usage: ${usage}`);
  const r = BundleReader.open(dir);
  if (wantUsage) {
    const rules = (p.repeated.get("--business-code") ?? []).map(parseBusinessRule);
    const actor = flagStr(p, "--actor");
    return usageReport(r, dir, rules, { actor: actor === undefined ? null : parseUsageActor(actor), allHosts: p.flags.get("--all-hosts") === true });
  }
  const kinds: Record<string, number> = {};
  for (const e of r.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const recount = computeCounts(r.events, r.manifest.counts.blobBytes);
  const typeInferred = { "sec-fetch": 0, "content-type": 0 };
  for (const q of r.requests()) {
    // adds bad-request issues, if any
    if (q["typeInferred"] === "sec-fetch") typeInferred["sec-fetch"]++;
    else if (q["typeInferred"] === "content-type") typeInferred["content-type"]++;
  }
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
    typeInferred,
    redaction: r.manifest.redaction,
    truncatedLastLine: r.truncatedLastLine,
    decodedSidecar: r.decodedSidecar,
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

async function runSpec(c: CommandSpec, argv: readonly string[], raw: readonly string[], opts: RunOptions): Promise<{ code: number; envelope: Envelope<unknown>; text?: string }> {
  const parsed = parseCommand(c, argv);
  if (parsed.help) {
    const text = helpFor(c);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const key = c.path.join(" ");
  const p = paths();
  let data: unknown;
  switch (key) {
    case "guide": {
      // 0.7-A: task guides from the registry in guides.ts; --text renders them for a human or a shell.
      const id = typeof parsed.args["id"] === "string" ? parsed.args["id"] : null;
      const text = parsed.args["text"] === true;
      if (id === null) {
        const list = guideList();
        return text ? { code: 0, envelope: ok(list), text: renderGuideListText() } : { code: 0, envelope: ok(list) };
      }
      const g = guideOf(id);
      return text ? { code: 0, envelope: ok(g), text: renderGuideText(g) } : { code: 0, envelope: ok(g) };
    }
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
    case "plugin init":
      data = pluginInit(p.config, parsed.args, process.cwd());
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
    case "mcp": {
      if (typeof parsed.args["printConfig"] === "string") {
        data = hostConfig(parsed.args["printConfig"]);
        break;
      }
      // stdout belongs to the protocol from here on; serveStdio exits the process when stdin closes.
      const { serveStdio } = await import("../mcp/server.ts");
      await serveStdio(async (a, o) => (await run(a, o)).envelope, parsed.args["allTools"] === true ? "all" : "core");
      return { code: -1, envelope: ok({ stopped: true }) };
    }
    case "schema":
      if (parsed.args["json"] === true) return { code: 0, envelope: ok(schema()), text: JSON.stringify(schema(), null, 2) };
      data = schema();
      break;
    case "wire serve":
      return await wireServe(p, parsed.args);
    case "wire version":
      data = await wireVersion(p);
      break;
    case "wire ca-path":
      data = wireCaPath(p);
      break;
    default: {
      if (c.action === undefined) throw new TabcapError("internal", `no handler for ${key}`, "This is a bug.");
      // `opts`: an MCP tool's session / timeout for a command without the flag (src/mcp/tools.ts).
      const session = parsed.session ?? opts.session ?? envVar("SESSION") ?? "default";
      let timeout = typeof parsed.args["timeoutMs"] === "number" ? parsed.args["timeoutMs"] : (opts.timeoutMs ?? 30_000);
      let args = withLocalPaths(c, parsed.args, process.cwd());
      // 0.6-A `fetch`: @files and --batch are read here; a batch waits for all its requests.
      if (key === "fetch") {
        args = fetchArgs(args, process.cwd());
        timeout = fetchClientTimeout(args, timeout);
      }
      const env = await send(p, c.action, args, session, [...raw], timeout);
      if (key === "fetch" && env.ok && isRecord(env.data) && Array.isArray(env.data["batch"])) {
        const lines = env.data["batch"];
        const failed = lines.some((l) => !isRecord(l) || l["ok"] !== true);
        return { code: failed ? 1 : 0, envelope: env, text: lines.map((l) => JSON.stringify(l)).join("\n") };
      }
      const code = env.ok ? 0 : env.error.code === "usage" ? 2 : 1;
      // 0.7-B `status`: without a daemon it still answers (what the CLI can read itself); `--text` is rendered here.
      if (key === "status") {
        const st = !env.ok && env.error.code === "not-running" ? ok(offlineStatus(p.config, p.listener)) : env;
        const stCode = st.ok ? 0 : code;
        return parsed.args["text"] === true && st.ok ? { code: stCode, envelope: st, text: renderStatusText(st.data) } : { code: stCode, envelope: st };
      }
      // `where --text`: the daemon answers JSON as always; the human report is rendered here.
      if (key === "where" && parsed.args["text"] === true && env.ok) {
        const r = whereResultOf(env.data);
        const saved = isRecord(env.data) && isRecord(env.data["saved"]) ? env.data["saved"] : null;
        const seqs = saved !== null && Array.isArray(saved["seqs"]) ? saved["seqs"].length : 0;
        if (r !== null) return { code, envelope: env, text: renderWhereText(r) + (saved === null ? "" : `\nwrote ${seqs} finding event(s) to ${String(saved["bundle"] ?? "")}`) };
      }
      // `recon --text`: the Markdown dossier the daemon wrote next to the JSON one.
      if (key === "recon" && parsed.args["text"] === true && env.ok && isRecord(env.data) && typeof env.data["markdown"] === "string") {
        return { code, envelope: env, text: readFileSync(env.data["markdown"], "utf8").trimEnd() };
      }
      // `trace list --text`: the report is rendered here from the daemon's JSON.
      if (key === "trace list" && parsed.args["text"] === true && env.ok) return { code, envelope: env, text: renderTraceText(env.data) };
      // `fingerprint probe --text`: the table is rendered here from the daemon's JSON.
      if (key === "fingerprint probe" && parsed.args["text"] === true && env.ok) return { code, envelope: env, text: renderFingerprintText(env.data) };
      // `wire probe --text`: the tabcap-wire/0 result as a table.
      if (key === "wire probe" && parsed.args["text"] === true && env.ok) {
        const r = wireResultOf(env.data);
        if (r !== null) return { code, envelope: env, text: renderWireText(r) };
      }
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
  const group = words[0] === undefined ? null : helpTopic(words[0]);
  if (group !== null) return { code: 0, text: group };
  return null;
}

type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };
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
    return await runSpec(c, rest, argv, opts);
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
    const rest = (n: number): Parsed => ({ positional: p.positional.slice(n), flags: p.flags, repeated: p.repeated });
    let data: unknown;
    if (group === "bundle" && sub === "export" && third === "har") data = await cmdExportHar(rest(3));
    else if (group === "bundle" && sub === "export" && third === "fixtures") data = await cmdExportFixtures(rest(3));
    else if (group === "bundle" && sub === "import" && third === "har") data = await cmdImportHar(rest(3));
    else if (group === "bundle" && sub === "redact") data = await cmdRedact(rest(2));
    else if (group === "bundle" && sub === "info") data = cmdInfo(rest(2));
    else if (group === "bundle" && sub === "decode") data = await cmdDecode(rest(2));
    else {
      const got = p.positional.slice(0, 3).join(" ");
      return { code: 2, envelope: fail("usage", got === "" ? "no command given" : `unknown command: ${got}`, `Available: ${USAGE.join(" | ")}`) };
    }
    if (sub === "info" && p.flags.get("--text") === true && p.flags.get("--usage") === true) return { code: 0, envelope: ok(data), text: renderUsageText(data as UsageReport) };
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
