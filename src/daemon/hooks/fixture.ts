// Fixture plugins (0.6-C, owner design 2026-10-16; docs/04 §31): the output
// format of `tabcap bundle export fixtures --format <plugin>` is the user's
// own program, so a team's harness format is a plugin, not tabcap's concern.
// Same directory mechanism as challenge handlers and decode plugins
// ($TABCAP_HOME/config/plugins/<name>/manifest.json); naming it with
// --format is the opt-in (it need not be enabled, like `bundle decode --plugin`).
//
// Manifest (untrusted input: unknown keys rejected, sizes capped):
//   {name, kind:"fixture", version, description?, command:[argv], timeoutMs?, maxBytes?}
// Protocol `tabcap-fixture/1`, the decode plugins' JSON lines (one request
// per line, one answer per line, in order, one long-lived process per run):
//   → {"id":1,"op":"fixture","fixture":{…one fixture, as the json format writes it…}}
//   ← {"id":1,"files":[{"path":"tests/test_1.py","encoding":"utf8"|"base64","data":"…"}]}
//   ← {"id":1,"ok":false,"error":"…"}
// Paths are relative to --out (no absolute path, no "..", no backslash, at
// most 255 characters, at most 64 files per answer); a path written earlier in
// the run is refused. The answer's decoded data is capped by maxBytes.
// A timeout, crash or broken answer kills the process (the next fixture starts
// it again) and counts as a failure; 3 failures stop the run's plugin.

import { isAbsolute } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { DEFAULT_DECODE_TIMEOUT_MS, MAX_DECODE_TIMEOUT_MS, MAX_FAILURES, MAX_MAX_BYTES, PluginProcess, lineCapFor, pluginEnv } from "./decode.ts";

export const FIXTURE_KIND = "fixture";
export const FIXTURE_PROTOCOL = "tabcap-fixture/1";
export const DEFAULT_FIXTURE_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_ANSWER = 64;
const MAX_PATH_CHARS = 255;
const MAX_TEXT = 500;
const MAX_VERSION_CHARS = 64;
const MAX_ARGV = 32;
const MAX_ARG_CHARS = 4096;
const MANIFEST_KEYS = new Set(["name", "kind", "version", "description", "command", "timeoutMs", "maxBytes"]);

export type FixtureSpec = { maxBytes: number };
export type FixturePlugin = { name: string; dir: string; version: string; command: string[]; timeoutMs: number; fixture: FixtureSpec };

const bad = (msg: string) =>
  new TabcapError("bad-input", `plugin manifest: ${msg}`, 'Fix manifest.json (fixture plugins: name, kind "fixture", version, command [argv], timeoutMs, maxBytes; docs/04 §31).');

/** The fixture-specific part of a `kind: "fixture"` manifest (the caller checked name / directory). */
export function parseFixtureManifest(raw: Record<string, unknown>): { version: string; description: string; command: string[]; timeoutMs: number; fixture: FixtureSpec } {
  for (const k of Object.keys(raw)) if (!MANIFEST_KEYS.has(k)) throw bad(`unknown key ${JSON.stringify(k)} (fixture plugins: ${[...MANIFEST_KEYS].join(", ")})`);
  const version = raw["version"];
  if (typeof version !== "string" || version === "" || version.length > MAX_VERSION_CHARS) throw bad(`version must be a string of 1..${MAX_VERSION_CHARS} characters`);
  const d = raw["description"];
  if (d !== undefined && (typeof d !== "string" || d.length > MAX_TEXT)) throw bad(`description must be a string of at most ${MAX_TEXT} characters`);
  const cmd = raw["command"];
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > MAX_ARGV) throw bad(`command must be a list of 1..${MAX_ARGV} strings`);
  const command = cmd.map((c, i) => {
    if (typeof c !== "string" || c === "" || c.length > MAX_ARG_CHARS || c.includes("\0")) throw bad(`command[${i}] must be a non-empty string without NUL`);
    return c;
  });
  const head = command[0] ?? "";
  if (!(head.startsWith("./") || isAbsolute(head) || !/[\\/]/.test(head))) throw bad(`command[0] ${JSON.stringify(head)} must be ./<file> inside the plugin directory, an absolute path or a program name on PATH`);
  let timeoutMs = DEFAULT_DECODE_TIMEOUT_MS;
  if (raw["timeoutMs"] !== undefined) {
    const t = raw["timeoutMs"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 100 || t > MAX_DECODE_TIMEOUT_MS) throw bad(`timeoutMs must be an integer from 100 to ${MAX_DECODE_TIMEOUT_MS}`);
    timeoutMs = t;
  }
  let maxBytes = DEFAULT_FIXTURE_MAX_BYTES;
  if (raw["maxBytes"] !== undefined) {
    const b = raw["maxBytes"];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > MAX_MAX_BYTES) throw bad(`maxBytes must be an integer from 1 to ${MAX_MAX_BYTES}`);
    maxBytes = b;
  }
  return { version, description: typeof d === "string" ? d : "", command, timeoutMs, fixture: { maxBytes } };
}

export type FixtureFile = { path: string; data: Uint8Array };

/** A relative output path a plugin may write, or the reason it may not. */
export function checkOutputPath(p: string): string | null {
  if (p === "" || p.length > MAX_PATH_CHARS) return `path must be 1..${MAX_PATH_CHARS} characters`;
  if (p.includes("\0") || p.includes("\\") || /[\r\n]/.test(p)) return "path cannot hold NUL, backslashes or line breaks";
  if (p.startsWith("/") || isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "path must be relative to --out";
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return "path segments cannot be empty, . or ..";
  return null;
}

/** Interpret one answer line; a string is a protocol failure. */
export function parseFixtureReply(v: unknown, id: number, maxBytes: number): { ok: true; files: FixtureFile[] } | { ok: false; error: string } | string {
  if (!isRecord(v)) return "answer is not a JSON object";
  if (v["id"] !== id) return `answer id ${JSON.stringify(v["id"] ?? null)} is not ${id}`;
  if (v["ok"] === false) {
    const e = v["error"];
    return { ok: false, error: typeof e === "string" && e !== "" ? e.slice(0, MAX_TEXT) : "the plugin reported a failure" };
  }
  if (v["ok"] !== undefined && v["ok"] !== true) return "answer ok must be true or false";
  const list = v["files"];
  if (!Array.isArray(list) || list.length > MAX_FILES_PER_ANSWER) return `answer files must be a list of at most ${MAX_FILES_PER_ANSWER} {path, encoding, data}`;
  const files: FixtureFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [i, f] of list.entries()) {
    if (!isRecord(f) || typeof f["path"] !== "string" || typeof f["data"] !== "string") return `files[${i}] must be {path, encoding, data}`;
    const why = checkOutputPath(f["path"]);
    if (why !== null) return `files[${i}] ${JSON.stringify(f["path"].slice(0, 80))}: ${why}`;
    if (seen.has(f["path"])) return `files[${i}] ${JSON.stringify(f["path"])} is listed twice`;
    seen.add(f["path"]);
    let data: Uint8Array;
    if (f["encoding"] === "utf8") data = new TextEncoder().encode(f["data"]);
    else if (f["encoding"] === "base64") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f["data"].replace(/\s+/g, ""))) return `files[${i}] data is not base64`;
      data = new Uint8Array(Buffer.from(f["data"], "base64"));
    } else return `files[${i}] encoding must be "utf8" or "base64"`;
    total += data.length;
    if (total > maxBytes) return `answer files are over maxBytes ${maxBytes}`;
    files.push({ path: f["path"], data });
  }
  return { ok: true, files };
}

/** One fixture plugin's process for one export run. */
export class FixtureRunner {
  private readonly proc: PluginProcess;
  private nextId = 1;
  private failures = 0;
  disabled: string | null = null;

  constructor(readonly plugin: FixturePlugin) {
    this.proc = new PluginProcess(
      { dir: plugin.dir, command: plugin.command, timeoutMs: plugin.timeoutMs, maxLine: lineCapFor(plugin.fixture.maxBytes) },
      pluginEnv(plugin.dir, "TABCAP_FIXTURE_PROTOCOL", FIXTURE_PROTOCOL),
    );
  }

  /** Convert one fixture; never throws. */
  async convert(fixture: unknown): Promise<{ ok: true; files: FixtureFile[] } | { ok: false; error: string }> {
    if (this.disabled !== null) return { ok: false, error: `plugin ${this.plugin.name} stopped: ${this.disabled}` };
    const id = this.nextId++;
    const r = await this.proc.call({ id, op: "fixture", fixture });
    const parsed = r.kind === "failure" ? r.error : parseFixtureReply(r.value, id, this.plugin.fixture.maxBytes);
    if (typeof parsed === "string") {
      if (r.kind === "line") this.proc.kill(); // out of step: a fresh process next time
      this.failures++;
      if (this.failures >= MAX_FAILURES) this.disabled = `${this.failures} failures, last: ${parsed}`;
      return { ok: false, error: parsed };
    }
    return parsed;
  }

  close(): void {
    this.proc.kill();
  }
}
