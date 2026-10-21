// Handler table: what the CLI does for each command of the registry
// (src/cli/commands.ts, which owns names, arguments, flags and help). main.ts
// parses argv with the registry and dispatches here:
//   - a command without a daemon action runs here (`run`);
//   - a daemon command is sent to the daemon by main.ts, with optional hooks:
//     `prepare` (args and client timeout sent), `fallback` (an answer when the
//     call failed), `output` (an ok answer printed other than as one
//     envelope), `render` (its `--text`).
// A local command's `--text` is rendered by its run from its own typed result
// (`local`). test/unit/handlers.test.ts checks that every command without a
// daemon action has a run and every `--text` a rendering or a json-only reason.

import { readFileSync } from "node:fs";
import type { Paths } from "../shared/paths.ts";
import { ok, type Envelope, type FailEnvelope, type OkEnvelope } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import type { RunOptions } from "../mcp/tools.ts";
import { hostConfig } from "../mcp/hosts.ts";
import { runDaemon } from "../daemon/main.ts";
import { Store } from "../daemon/store/db.ts";
import { offlineStatus, renderStatusText } from "../daemon/tools/status.ts";
import { renderTraceText } from "../daemon/trace/table.ts";
import { renderFingerprintText } from "../fingerprint/fields.ts";
import { renderWireText, wireResultOf } from "../wire/probe.ts";
import { renderWhereText, whereResultOf } from "../analyze/where.ts";
import { renderUsageText } from "../bundle/usage.ts";
import { nowMs } from "../shared/time.ts";
import { bundleDecode, bundleExportFixtures, bundleExportHar, bundleImportHar, bundleInfo, bundleRedact } from "./bundle.ts";
import { listBundles, openRecordings, pruneBundles, renderBundleListText } from "./bundles.ts";
import { daemonStatus, startDaemon, stopDaemon } from "./client.ts";
import { schema, type CommandSpec } from "./commands.ts";
import { fetchArgs, fetchClientTimeout } from "./fetch.ts";
import { fingerprintDiff, fingerprintRefList, fingerprintRefRemove, fingerprintRefShow, fingerprintServe } from "./fingerprint.ts";
import { guideList, guideOf, renderGuideListText, renderGuideText } from "./guides.ts";
import { pluginInit } from "./plugin-init.ts";
import { accountAdd, accountBind, accountList, accountRemove, accountSetState, proxyAdd, proxyCheck, proxyList, proxyRemove, proxySetState } from "./pool.ts";
import { pluginList, pluginSet, siteAdd, siteList, siteRemove } from "./site.ts";
import { cmdUpdate } from "./update.ts";
import { wireCaPath, wireServe, wireVersion } from "./wire.ts";

/** One command's outcome: the envelope, its exit code (0 ok, 1 error, 2 usage; -1 keep running) and the text printed instead of it. */
export type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };

/** What a handler gets: the command, its parsed arguments, the paths and the caller's working directory. */
export type Ctx = { spec: CommandSpec; args: Record<string, unknown>; paths: Paths; cwd: string };

/** The arguments and the client timeout a daemon command sends. */
export type Sent = { args: Record<string, unknown>; timeoutMs: number };

export type Handler = {
  /** A command without a daemon action: runs here. */
  run?: (ctx: Ctx) => Promise<Outcome>;
  /** A daemon command: the arguments and client timeout it sends (fetch reads @files and --batch here). */
  prepare?: (sent: Sent, ctx: Ctx) => Sent;
  /** A daemon command whose call failed: the answer given instead (status without a daemon), or null. */
  fallback?: (env: FailEnvelope, ctx: Ctx) => Envelope<unknown> | null;
  /** A daemon command's ok answer printed other than as one envelope (fetch --batch: a JSON line per request), or null. */
  output?: (env: OkEnvelope<unknown>) => Outcome | null;
  /** A daemon command's `--text`: the text for its ok answer's data, or null to print the JSON. */
  render?: (data: unknown) => string | null;
  /** A local command whose run renders `--text` (set by `local` when it has a render). */
  rendersText?: true;
  /** The command's `--text` flag is not an output format (the answer stays JSON), and why. */
  jsonOnly?: string;
};

/** What the table needs from src/cli/main.ts, which imports this module: the CLI's own run (`mcp` serves it) and `setup`. */
export type Host = {
  run: (argv: readonly string[], opts: RunOptions) => Promise<Outcome>;
  setup: (args: Record<string, unknown>) => Promise<unknown>;
};

type LocalSpec<T> = {
  run: (ctx: Ctx) => T | Promise<T>;
  /** `--text`: the text for the result; null prints the JSON. */
  render?: (result: T, ctx: Ctx) => string | null;
  /** The answer's data when it is not the whole result (a result may carry what only the text needs). */
  data?: (result: T) => unknown;
  /** Exit code of an ok answer (default 0). */
  code?: (result: T) => number;
};

/** A command the CLI runs itself and answers with one envelope. */
export function local<T>(s: LocalSpec<T>): Handler {
  const { render } = s;
  return {
    run: async (ctx) => {
      const result = await s.run(ctx);
      const envelope = ok(s.data === undefined ? result : s.data(result));
      const code = s.code === undefined ? 0 : s.code(result);
      const text = render !== undefined && ctx.args["text"] === true ? render(result, ctx) : null;
      return text === null ? { code, envelope } : { code, envelope, text };
    },
    ...(render === undefined ? {} : { rendersText: true }),
  };
}

/** A command that prints by itself or keeps running (servers, `mcp`, `schema --json`): its run gives the whole outcome. */
export function custom(run: (ctx: Ctx) => Outcome | Promise<Outcome>): Handler {
  return { run: async (ctx) => await run(ctx) };
}

/** A daemon command's hooks (src/cli/main.ts sends it). */
export function daemon(h: Pick<Handler, "prepare" | "fallback" | "output" | "render" | "jsonOnly">): Handler {
  return h;
}

/** `where --text`: the report, then where the findings were written. */
function whereText(data: unknown): string | null {
  const r = whereResultOf(data);
  if (r === null) return null;
  const saved = isRecord(data) && isRecord(data["saved"]) ? data["saved"] : null;
  const seqs = saved !== null && Array.isArray(saved["seqs"]) ? saved["seqs"].length : 0;
  return renderWhereText(r) + (saved === null ? "" : `\nwrote ${seqs} finding event(s) to ${String(saved["bundle"] ?? "")}`);
}

/** `fetch --batch`: one JSON line per request; exit 1 when any line failed. */
function batchOutput(env: OkEnvelope<unknown>): Outcome | null {
  const lines = isRecord(env.data) && Array.isArray(env.data["batch"]) ? env.data["batch"] : null;
  if (lines === null) return null;
  const failed = lines.some((l) => !isRecord(l) || l["ok"] !== true);
  return { code: failed ? 1 : 0, envelope: env, text: lines.map((l) => JSON.stringify(l)).join("\n") };
}

/** The table, keyed by command path (`net list`, `bundle export har`). Daemon commands without hooks are not listed. */
export function handlerTable(host: Host): Readonly<Record<string, Handler>> {
  return {
    // 0.7-A: task guides from the registry in guides.ts; --text renders them for a human or a shell.
    guide: local({
      run: ({ args }) => (typeof args["id"] === "string" ? { guide: guideOf(args["id"]) } : { list: guideList() }),
      data: (r) => ("guide" in r ? r.guide : r.list),
      render: (r) => ("guide" in r ? renderGuideText(r.guide) : renderGuideListText()),
    }),
    setup: local({ run: ({ args }) => host.setup(args) }),
    update: local({ run: ({ args }) => cmdUpdate(args) }),
    "daemon start": local({
      run: async ({ paths }) => {
        // Store permission problems surface here, not as a daemon that never comes up.
        Store.open(paths.config).close();
        return await startDaemon(paths);
      },
    }),
    "daemon stop": local({ run: ({ paths }) => stopDaemon(paths) }),
    "daemon status": local({ run: ({ paths }) => daemonStatus(paths) }),
    "daemon run": custom(async ({ paths }) => {
      await runDaemon(paths);
      return { code: -1, envelope: ok({ running: true }) };
    }),
    // 0.7-B `status`: without a daemon it still answers (what the CLI can read itself); `--text` is rendered here.
    status: daemon({
      fallback: (env, { paths }) => (env.error.code === "not-running" ? ok(offlineStatus(paths.config, paths.listener)) : null),
      render: (data) => renderStatusText(data),
    }),
    "site add": local({ run: ({ paths, args }) => siteAdd(paths, args) }),
    "site list": local({ run: ({ paths }) => siteList(paths) }),
    "site remove": local({ run: ({ paths, args }) => siteRemove(paths, args) }),
    "proxy add": local({ run: ({ paths, args }) => proxyAdd(paths, args) }),
    "proxy list": local({ run: ({ paths }) => proxyList(paths) }),
    "proxy remove": local({ run: ({ paths, args }) => proxyRemove(paths, args) }),
    "proxy check": local({ run: ({ paths, args }) => proxyCheck(paths, args) }),
    "proxy set-state": local({ run: ({ paths, args }) => proxySetState(paths, args) }),
    "account add": local({ run: ({ paths, args }) => accountAdd(paths, args) }),
    "account remove": local({ run: ({ paths, args }) => accountRemove(paths, args) }),
    "account bind": local({ run: ({ paths, args }) => accountBind(paths, args) }),
    "account list": local({ run: ({ paths, args }) => accountList(paths, args) }),
    "account set-state": local({ run: ({ paths, args }) => accountSetState(paths, args) }),
    // `html --text` is the daemon's textContent switch, not an output format.
    html: daemon({ jsonOnly: "--text asks the daemon for textContent instead of markup; the answer stays JSON" }),
    // 0.6-A `fetch`: @files and --batch are read here; a batch waits for all its requests.
    fetch: daemon({
      prepare: (sent, { cwd }) => {
        const args = fetchArgs(sent.args, cwd);
        return { args, timeoutMs: fetchClientTimeout(args, sent.timeoutMs) };
      },
      output: batchOutput,
    }),
    // `where --text`: the daemon answers JSON as always; the human report is rendered here.
    where: daemon({ render: whereText }),
    // `recon --text`: the Markdown dossier the daemon wrote next to the JSON one.
    recon: daemon({ render: (data) => (isRecord(data) && typeof data["markdown"] === "string" ? readFileSync(data["markdown"], "utf8").trimEnd() : null) }),
    "trace list": daemon({ render: (data) => renderTraceText(data) }),
    "fingerprint probe": daemon({ render: (data) => renderFingerprintText(data) }),
    "plugin list": local({ run: ({ paths }) => pluginList(paths) }),
    "plugin enable": local({ run: ({ paths, args }) => pluginSet(paths, args, true) }),
    "plugin disable": local({ run: ({ paths, args }) => pluginSet(paths, args, false) }),
    "plugin init": local({ run: ({ paths, args, cwd }) => pluginInit(paths.config, args, cwd) }),
    "bundle export har": local({ run: ({ args }) => bundleExportHar(args) }),
    "bundle import har": local({ run: ({ args, spec }) => bundleImportHar(args, spec) }),
    "bundle redact": local({ run: ({ args }) => bundleRedact(args) }),
    "bundle info": local({
      run: ({ args, spec }) => bundleInfo(args, spec),
      data: (r) => ("usage" in r ? r.usage : r.info),
      // --text belongs to --usage (bundleInfo refuses it alone)
      render: (r) => ("usage" in r ? renderUsageText(r.usage) : null),
    }),
    // Review 10-21: the store's bundle index; a recording the daemon still has open is never pruned.
    "bundle list": local({ run: async ({ paths, args }) => listBundles(paths, args, await openRecordings(paths)), render: (l) => renderBundleListText(l) }),
    "bundle prune": local({ run: async ({ paths, args }) => pruneBundles(paths, args, await openRecordings(paths), nowMs()) }),
    "bundle decode": local({ run: ({ paths, args }) => bundleDecode(paths, args) }),
    "bundle export fixtures": local({ run: ({ paths, args, spec }) => bundleExportFixtures(paths, args, spec) }),
    "wire serve": custom(({ paths, args }) => wireServe(paths, args)),
    "wire version": local({ run: ({ paths }) => wireVersion(paths) }),
    "wire ca-path": local({ run: ({ paths }) => wireCaPath(paths) }),
    // `wire probe --text`: the tabcap-wire/0 result as a table.
    "wire probe": daemon({
      render: (data) => {
        const r = wireResultOf(data);
        return r === null ? null : renderWireText(r);
      },
    }),
    "fingerprint serve": custom(({ paths, args }) => fingerprintServe(paths, args)),
    "fingerprint ref list": local({ run: ({ paths }) => fingerprintRefList(paths) }),
    "fingerprint ref show": local({ run: ({ paths, args }) => fingerprintRefShow(paths, args) }),
    "fingerprint ref remove": local({ run: ({ paths, args }) => fingerprintRefRemove(paths, args) }),
    "fingerprint diff": local({ run: ({ paths, args }) => fingerprintDiff(paths, args), render: (r) => renderFingerprintText(r) }),
    mcp: custom(async ({ args }) => {
      if (typeof args["printConfig"] === "string") return { code: 0, envelope: ok(hostConfig(args["printConfig"])) };
      // stdout belongs to the protocol from here on; serveStdio exits the process when stdin closes.
      const { serveStdio } = await import("../mcp/server.ts");
      await serveStdio(async (a, o) => (await host.run(a, o)).envelope, args["allTools"] === true ? "all" : "core");
      return { code: -1, envelope: ok({ stopped: true }) };
    }),
    schema: custom(({ args }) => (args["json"] === true ? { code: 0, envelope: ok(schema()), text: JSON.stringify(schema(), null, 2) } : { code: 0, envelope: ok(schema()) })),
  };
}

/** The handler of a command path, if the table has one. */
export function handlerOf(table: Readonly<Record<string, Handler>>, key: string): Handler | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
