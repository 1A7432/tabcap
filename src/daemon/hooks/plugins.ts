// External handler interface (docs/08 0.3 line, docs/03 §6). The main repo
// ships the interface only, never a handler: a handler is the user's own
// program in $TABCAP_HOME/config/plugins/<name>/ (~/.config/tabcap/plugins/),
// described by manifest.json, run out of process, speaking one JSON object on
// stdin and one on stdout, so any language works. Installed is not enabled:
// `tabcap plugin enable <name>` opts in. One hook type exists for now:
//
//   challenge  the guard saw a challenge (verify page …) and is about to hand
//              the session to the human. Input: tabcap-hook/1 challenge payload
//              (scrubbed). Output: {"decision":"handoff"} (the default; also on
//              timeout, crash or invalid output) or
//              {"decision":"answer","answer":<string|object>,"note":<string>?}.
//
// Every invocation is recorded as a cmd pair (actor "system") in the bundle,
// inputs and outputs scrubbed; handler output is untrusted data, never instructions.
//
// A manifest with `kind: "decode"` is a decode plugin instead (0.6-B,
// decode.ts): a long-lived process that turns encoded bodies into plaintext
// views. Its manifest is validated strictly (unknown keys rejected) by
// decode.ts; it declares no hooks. `kind: "fixture"` (0.6-C, fixture.ts) is
// an output format of `bundle export fixtures --format <name>`.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../../bundle/manifest.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, tryParseJson } from "../../shared/json.ts";
import { DECODE_KIND, parseDecodeManifest, type DecodePlugin, type DecodeSpec } from "./decode.ts";
import { FIXTURE_KIND, parseFixtureManifest, type FixturePlugin, type FixtureSpec } from "./fixture.ts";

export const HOOK_PROTOCOL = "tabcap-hook/1";
export const HOOK_TYPES = ["challenge"] as const;
export type HookType = (typeof HOOK_TYPES)[number];
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 4096;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENABLED_FILE = "enabled.json";
/** manifest.json is read whole; anything larger is refused unread. */
export const MAX_PLUGIN_MANIFEST_BYTES = 16 * 1024;

export type PluginManifest = {
  name: string;
  version: string;
  description: string;
  hooks: HookType[];
  /** argv; a first element starting with "./" is relative to the plugin directory. */
  command: string[];
  timeoutMs: number;
  /** Present only on `kind: "decode"` manifests (then `hooks` is empty). */
  decode?: DecodeSpec;
  /** Present only on `kind: "fixture"` manifests (then `hooks` is empty). */
  fixture?: FixtureSpec;
};

export type PluginInfo = { name: string; dir: string; enabled: boolean; manifest: PluginManifest | null; error: string | null };

export function pluginsDir(configDir: string): string {
  return join(configDir, "plugins");
}

const bad = (msg: string) => new TabcapError("bad-input", `plugin manifest: ${msg}`, "Fix manifest.json (fields: name, version, description, hooks [\"challenge\"], command [argv], timeoutMs).");

/** Validate a manifest.json value; `dirName` is the plugin directory's name, which must equal `name`. */
export function parseManifest(raw: unknown, dirName: string): PluginManifest {
  if (!isRecord(raw)) throw bad("not a JSON object");
  const name = raw["name"];
  if (typeof name !== "string" || !NAME.test(name)) throw bad("name must be lowercase letters, digits, '_' or '-' (max 64)");
  if (name !== dirName) throw bad(`name "${name}" differs from its directory "${dirName}"`);
  if (raw["kind"] === DECODE_KIND) {
    const d = parseDecodeManifest(raw);
    return { name, version: d.version, description: d.description, hooks: [], command: d.command, timeoutMs: d.timeoutMs, decode: d.decode };
  }
  if (raw["kind"] === FIXTURE_KIND) {
    const f = parseFixtureManifest(raw);
    return { name, version: f.version, description: f.description, hooks: [], command: f.command, timeoutMs: f.timeoutMs, fixture: f.fixture };
  }
  if (raw["kind"] !== undefined) throw bad(`unknown kind ${JSON.stringify(raw["kind"])} (known: "decode", "fixture"; challenge handlers have no kind)`);
  const version = typeof raw["version"] === "string" ? raw["version"] : "0";
  const description = typeof raw["description"] === "string" ? raw["description"].slice(0, 500) : "";
  const hooksRaw = raw["hooks"];
  if (!Array.isArray(hooksRaw) || hooksRaw.length === 0) throw bad("hooks must be a non-empty array");
  const hooks: HookType[] = [];
  for (const h of hooksRaw) {
    const known = HOOK_TYPES.find((t) => t === h);
    if (known === undefined) throw bad(`unknown hook ${JSON.stringify(h)} (known: ${HOOK_TYPES.join(", ")})`);
    if (!hooks.includes(known)) hooks.push(known);
  }
  const cmd = raw["command"];
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c): c is string => typeof c === "string" && c !== "" && !c.includes("\0"))) throw bad("command must be a non-empty array of strings");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (raw["timeoutMs"] !== undefined) {
    const t = raw["timeoutMs"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 100 || t > MAX_TIMEOUT_MS) throw bad(`timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
    timeoutMs = t;
  }
  return { name, version, description, hooks, command: [...cmd], timeoutMs };
}

export function readEnabled(configDir: string): string[] {
  const f = join(pluginsDir(configDir), ENABLED_FILE);
  if (!existsSync(f)) return [];
  const v = tryParseJson(readFileSync(f, "utf8"));
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && NAME.test(x)))].sort() : [];
}

function writeEnabled(configDir: string, names: string[]): void {
  const dir = pluginsDir(configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, ENABLED_FILE), JSON.stringify([...new Set(names)].sort()) + "\n");
}

/**
 * A directory others can write to could swap the handler under us. Not
 * checked on Windows, which has no POSIX modes: the plugins directory keeps the
 * user-default ACL of %LOCALAPPDATA%\tabcap.
 */
function writableByOthers(p: string): boolean {
  if (process.platform === "win32") return false;
  try {
    return (statSync(p).mode & 0o022) !== 0;
  } catch {
    return false;
  }
}

/** Every directory under plugins/, valid or not (errors say why). */
export function listPlugins(configDir: string): PluginInfo[] {
  const root = pluginsDir(configDir);
  if (!existsSync(root)) return [];
  const enabled = new Set(readEnabled(configDir));
  const out: PluginInfo[] = [];
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    let manifest: PluginManifest | null = null;
    let error: string | null = null;
    const mf = join(dir, "manifest.json");
    if (writableByOthers(root) || writableByOthers(dir)) error = `${writableByOthers(root) ? root : dir} is writable by group or others`;
    else if (!existsSync(mf)) error = "no manifest.json";
    else if (statSync(mf).size > MAX_PLUGIN_MANIFEST_BYTES) error = `manifest.json is over ${MAX_PLUGIN_MANIFEST_BYTES} bytes`;
    else {
      const raw = tryParseJson(readFileSync(mf, "utf8"));
      try {
        manifest = parseManifest(raw, e.name);
      } catch (x) {
        error = x instanceof Error ? x.message : String(x);
      }
    }
    out.push({ name: e.name, dir, enabled: enabled.has(e.name), manifest, error });
  }
  return out;
}

export function setEnabled(configDir: string, name: string, on: boolean): PluginInfo {
  const p = listPlugins(configDir).find((x) => x.name === name);
  if (on) {
    if (p === undefined) throw new TabcapError("not-found", `no plugin named "${name}" in ${pluginsDir(configDir)}`, "Put the handler in its own directory with a manifest.json, then `tabcap plugin list`.");
    if (p.manifest === null) throw new TabcapError("bad-input", `plugin "${name}" is not usable: ${p.error ?? "invalid"}`, "Fix it, then run `tabcap plugin enable` again.");
  }
  const names = readEnabled(configDir).filter((n) => n !== name);
  writeEnabled(configDir, on ? [...names, name] : names);
  return { ...(p ?? { name, dir: join(pluginsDir(configDir), name), manifest: null, error: "not installed" }), enabled: on };
}

/** Enabled, valid plugins that declare `hook`, in name order. */
export function pluginsFor(configDir: string, hook: HookType): Array<PluginInfo & { manifest: PluginManifest }> {
  return listPlugins(configDir).filter((p): p is PluginInfo & { manifest: PluginManifest } => p.enabled && p.manifest !== null && p.manifest.hooks.includes(hook));
}

/** Enabled, valid decode plugins (`kind: "decode"`), in name order. */
export function decodePlugins(configDir: string): DecodePlugin[] {
  return listPlugins(configDir).flatMap((p) => (p.enabled ? asDecodePlugin(p) : []));
}

/** A listed plugin as a decode plugin, or [] when it is not a valid one. */
export function asDecodePlugin(p: PluginInfo): DecodePlugin[] {
  const m = p.manifest;
  if (m === null || m.decode === undefined) return [];
  return [{ name: m.name, dir: p.dir, version: m.version, command: m.command, timeoutMs: m.timeoutMs, decode: m.decode }];
}

/** A listed plugin as a fixture plugin, or [] when it is not a valid one. */
export function asFixturePlugin(p: PluginInfo): FixturePlugin[] {
  const m = p.manifest;
  if (m === null || m.fixture === undefined) return [];
  return [{ name: m.name, dir: p.dir, version: m.version, command: m.command, timeoutMs: m.timeoutMs, fixture: m.fixture }];
}

/** The kind of a valid manifest: "decode", "fixture" or "challenge". */
export function pluginKind(m: PluginManifest): "decode" | "fixture" | "challenge" {
  return m.decode !== undefined ? "decode" : m.fixture !== undefined ? "fixture" : "challenge";
}

/** argv with "./x" resolved inside the plugin directory (never outside it). */
export function resolveCommand(dir: string, command: readonly string[]): string[] {
  const [head, ...rest] = command;
  if (head === undefined) throw bad("empty command");
  if (head.startsWith("./") || head.startsWith("../")) {
    const abs = resolve(dir, head);
    if (!abs.startsWith(resolve(dir) + sep)) throw bad(`command ${head} points outside the plugin directory`);
    return [abs, ...rest];
  }
  if (!isAbsolute(head) && head.includes("/")) throw bad(`command ${head}: use ./relative, an absolute path, or a bare program name on PATH`);
  return [head, ...rest];
}

export type HookRun = {
  ok: boolean;
  output: unknown;
  error: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stderr: string;
};

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; over: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      over = true;
      chunks.push(value.subarray(0, Math.max(0, max - size)));
      size = max;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), over };
}

/** Run one handler: write `input` as JSON to its stdin, read one JSON value from stdout. Never throws. */
export async function runHook(p: { dir: string; manifest: PluginManifest }, input: unknown, opts: { timeoutMs?: number } = {}): Promise<HookRun> {
  const started = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? p.manifest.timeoutMs, MAX_TIMEOUT_MS);
  const done = (r: Omit<HookRun, "durationMs">): HookRun => ({ ...r, durationMs: Date.now() - started });
  let argv: string[];
  try {
    argv = resolveCommand(p.dir, p.manifest.command);
    if (lstatSync(p.dir).isSymbolicLink()) throw bad("the plugin directory is a symlink");
  } catch (e) {
    return done({ ok: false, output: null, error: e instanceof Error ? e.message : String(e), exitCode: null, timedOut: false, stderr: "" });
  }
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, {
      cwd: p.dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Minimal environment: no TABCAP_* settings, nothing the daemon knows.
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "", LANG: process.env["LANG"] ?? "C.UTF-8", TABCAP_PLUGIN_DIR: p.dir, TABCAP_HOOK_PROTOCOL: HOOK_PROTOCOL },
    });
  } catch (e) {
    return done({ ok: false, output: null, error: `cannot start ${argv[0] ?? "?"}: ${e instanceof Error ? e.message : String(e)}`, exitCode: null, timedOut: false, stderr: "" });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(input) + "\n");
    await proc.stdin.end();
  } catch {
    // the handler may exit without reading stdin; its stdout still decides
  }
  const [out, err] = await Promise.all([readCapped(proc.stdout, MAX_STDOUT), readCapped(proc.stderr, MAX_STDERR)]);
  if (out.over) proc.kill("SIGKILL");
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const base = { exitCode, timedOut, stderr: err.text };
  if (timedOut) return done({ ok: false, output: null, error: `timed out after ${timeoutMs} ms`, ...base });
  if (out.over) return done({ ok: false, output: null, error: `stdout exceeded ${MAX_STDOUT} bytes`, ...base });
  if (exitCode !== 0) return done({ ok: false, output: null, error: `exited with code ${exitCode}`, ...base });
  const text = out.text.trim();
  const parsed = text === "" ? undefined : tryParseJson(text);
  if (parsed === undefined || parsed === null) return done({ ok: false, output: null, error: "stdout is not one JSON value", ...base });
  return done({ ok: true, output: parsed, error: null, ...base });
}

export type ChallengeDecision = { decision: "handoff"; note: string | null } | { decision: "answer"; answer: string | Record<string, unknown>; note: string | null };

/** Interpret a challenge handler's output; anything unexpected means "hand to the human". */
export function parseChallengeOutput(v: unknown): ChallengeDecision {
  if (!isRecord(v)) return { decision: "handoff", note: "output is not an object" };
  const note = typeof v["note"] === "string" ? v["note"].slice(0, 1000) : null;
  if (v["decision"] === "answer") {
    const a = v["answer"];
    if (typeof a === "string" && a !== "") return { decision: "answer", answer: a.slice(0, 10_000), note };
    if (isRecord(a)) return { decision: "answer", answer: a, note };
    return { decision: "handoff", note: "decision answer without a string or object answer" };
  }
  return { decision: "handoff", note };
}
