// Decode plugins (0.6-B, owner design 2026-10-16; docs/04 §28). A decode
// plugin is the user's own program in $TABCAP_HOME/config/plugins/<name>/,
// `manifest.json` with `kind: "decode"`, enabled like a challenge handler
// (`tabcap plugin enable <name>`). It turns an encoded / encrypted body into
// plaintext; tabcap stores the plaintext as a derived view beside the
// original body (`decoded` on the request event's `request` / `response`
// side) and the analysis commands read it as decode step `plugin:<name>`.
//
// Manifest (untrusted input: unknown keys rejected, sizes capped):
//   {name, kind:"decode", version, description?,
//    match:{host:[globs], path?:[globs], contentTypes?:[types], direction?:"response"|"request"|"both"},
//    command:[argv], timeoutMs?, maxBytes?}
// argv[0] is "./x" inside the plugin directory, an absolute path, or a bare
// program name looked up on PATH (`uv`, `python3`, `bun`: owner 2026-10-16,
// the Python runner template); other "./" / "../" arguments must stay inside
// the directory; the process runs in the plugin directory. An optional
// config.json beside the manifest (keys …) is the plugin's own: tabcap never
// reads it, and it never reaches a bundle.
//
// Protocol `tabcap-decode/1`: newline-delimited JSON on stdin / stdout, one
// request per line, one answer per line, in order.
//   → {"id":1,"op":"decode","direction":"response",
//      "request":{"id":"r-N"|null,"url","method","headers":{…}},
//      "response":{"status","headers":{…}},            (response direction only)
//      "body":{"encoding":"base64","data":"…","mime":"…"|null}}
//   ← {"id":1,"ok":true,"mime":"application/json","body":{"encoding":"utf8"|"base64","data":"…"},"note"?:"…"}
//   ← {"id":1,"ok":false,"error":"…"}
//   ← {"id":1,"declined":true}     (not mine: no view, not a failure)
// `request.id` is null while recording (the event gets its id when it is
// written, after the decode) and r-N in `tabcap bundle decode`. Headers are
// the recorded ones minus cookie / set-cookie / authorization /
// proxy-authorization, known secrets replaced.
// One long-lived process per plugin per daemon (per `bundle decode` run),
// calls one at a time, a hard timeout per call, a cap on the answer line.
// A timeout, crash, unparsable or oversized answer, or one that breaks the
// protocol (wrong id, no ok, bad body), kills the process (the next call
// starts it again) and counts as a failure; MAX_FAILURES failures
// disable the plugin for the rest of the session (the recorder writes a
// `note` event). `ok:false` and `declined` are answers, not failures. The plugin's stderr
// is drained and dropped: it may print its keys.
// 0.6-V (owner decision 10-17): a CORS preflight and a 0-byte body are never
// offered to a plugin, live or in `bundle decode` (`decodeSkip`): no view, no
// decline; `bundle decode` counts them as `skipped: {preflight, empty}`.

import { lstatSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Headers } from "../../bundle/types.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";

export const DECODE_PROTOCOL = "tabcap-decode/1";
export const DECODE_KIND = "decode";
export const DEFAULT_DECODE_TIMEOUT_MS = 5000;
export const MAX_DECODE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Same as the body cap (docs/04 §5.2 rule 4). */
export const MAX_MAX_BYTES = 32 * 1024 * 1024;
/** Misbehaviours (timeout, crash, bad answer) before a plugin is disabled for the session. */
export const MAX_FAILURES = 3;
const MAX_GLOBS = 32;
const MAX_GLOB_CHARS = 200;
const MAX_ARGV = 32;
const MAX_ARG_CHARS = 4096;
const MAX_VERSION_CHARS = 64;
const MAX_TEXT = 500;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOST_GLOB = /^[a-z0-9.*_:[\]-]+$/;
const MEDIA = /^(\*\/\*|[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+))$/;
const MANIFEST_KEYS = new Set(["name", "kind", "version", "description", "match", "command", "timeoutMs", "maxBytes"]);
const MATCH_KEYS = new Set(["host", "path", "contentTypes", "direction"]);
/** Never sent to a plugin: credentials of the session itself. */
const WITHHELD_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

export type DecodeDirection = "request" | "response";
export type DecodeMatch = { host: string[]; path: string[]; contentTypes: string[]; direction: DecodeDirection | "both" };
export type DecodeSpec = { match: DecodeMatch; maxBytes: number };

const bad = (msg: string) =>
  new TabcapError(
    "bad-input",
    `plugin manifest: ${msg}`,
    'Fix manifest.json (decode plugins: name, kind "decode", version, match {host, path, contentTypes, direction}, command [argv], timeoutMs, maxBytes; docs/04 §28).',
  );

function globList(v: unknown, field: string, check: (s: string) => boolean, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_GLOBS) throw bad(`match.${field} must be a list of 1..${MAX_GLOBS} ${what}`);
  return v.map((x, i) => {
    if (typeof x !== "string" || x === "" || x.length > MAX_GLOB_CHARS) throw bad(`match.${field}[${i}] must be a string of 1..${MAX_GLOB_CHARS} characters`);
    const s = x.toLowerCase();
    if (field !== "path" && !check(s)) throw bad(`match.${field}[${i}] ${JSON.stringify(x)} is not ${what}`);
    if (field === "path" && !check(x)) throw bad(`match.${field}[${i}] ${JSON.stringify(x)} is not ${what}`);
    return field === "path" ? x : s;
  });
}

/**
 * The decode-specific part of a `kind: "decode"` manifest (the caller checked
 * name / directory). Returns the fields every plugin manifest has plus the spec.
 */
export function parseDecodeManifest(raw: Record<string, unknown>): { version: string; description: string; command: string[]; timeoutMs: number; decode: DecodeSpec } {
  for (const k of Object.keys(raw)) if (!MANIFEST_KEYS.has(k)) throw bad(`unknown key ${JSON.stringify(k)} (decode plugins: ${[...MANIFEST_KEYS].join(", ")})`);
  const version = raw["version"];
  if (typeof version !== "string" || version === "" || version.length > MAX_VERSION_CHARS) throw bad(`version must be a string of 1..${MAX_VERSION_CHARS} characters`);
  const d = raw["description"];
  if (d !== undefined && (typeof d !== "string" || d.length > MAX_TEXT)) throw bad(`description must be a string of at most ${MAX_TEXT} characters`);
  const m = raw["match"];
  if (!isRecord(m)) throw bad("match must be an object {host, path?, contentTypes?, direction?}");
  for (const k of Object.keys(m)) if (!MATCH_KEYS.has(k)) throw bad(`unknown key match.${k} (known: ${[...MATCH_KEYS].join(", ")})`);
  const host = globList(m["host"], "host", (s) => HOST_GLOB.test(s), "host globs (letters, digits, . - _ : [ ] and *)");
  const path = m["path"] === undefined ? ["/**"] : globList(m["path"], "path", (s) => s.startsWith("/") && !/[\s?#]/.test(s), "path globs starting with / (no query, no spaces)");
  const contentTypes = m["contentTypes"] === undefined ? ["*/*"] : globList(m["contentTypes"], "contentTypes", (s) => MEDIA.test(s), "media types (type/subtype, type/* or */*, no parameters)");
  const dir = m["direction"] ?? "response";
  if (dir !== "response" && dir !== "request" && dir !== "both") throw bad('match.direction must be "response", "request" or "both"');
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
  let maxBytes = DEFAULT_MAX_BYTES;
  if (raw["maxBytes"] !== undefined) {
    const b = raw["maxBytes"];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > MAX_MAX_BYTES) throw bad(`maxBytes must be an integer from 1 to ${MAX_MAX_BYTES}`);
    maxBytes = b;
  }
  return { version, description: typeof d === "string" ? d : "", command, timeoutMs, decode: { match: { host, path, contentTypes, direction: dir }, maxBytes } };
}

/** argv with every "./" / "../" element resolved inside the plugin directory (never outside it). */
export function resolveDecodeCommand(dir: string, command: readonly string[]): string[] {
  const root = resolve(dir);
  return command.map((c, i) => {
    if (c.startsWith("./") || c.startsWith("../")) {
      const abs = resolve(root, c);
      if (!abs.startsWith(root + sep)) throw bad(`command[${i}] ${c} points outside the plugin directory`);
      return abs;
    }
    if (i === 0 && !isAbsolute(c) && /[\\/]/.test(c)) throw bad(`command[0] ${c}: use ./<file> inside the plugin directory, an absolute path or a program name on PATH`);
    return c;
  });
}

// ------------------------------------------------------------ matching

function globRegex(glob: string, segmentStar: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += segmentStar ? "[^/]*" : ".*";
    } else re += c.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const baseMime = (m: string | null): string => (m ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

function mimeMatches(pattern: string, mime: string): boolean {
  if (pattern === "*/*") return true;
  if (mime === "") return false;
  if (pattern.endsWith("/*")) return mime.startsWith(pattern.slice(0, -1));
  return pattern === mime;
}

/** Does this plugin take the body of `url` (with this media type) in `direction`? */
export function decodeMatches(m: DecodeMatch, url: string, mime: string | null, direction: DecodeDirection): boolean {
  if (m.direction !== "both" && m.direction !== direction) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (!m.host.some((g) => globRegex(g, false).test(host))) return false;
  if (!m.path.some((g) => globRegex(g, true).test(u.pathname))) return false;
  const mt = baseMime(mime);
  return m.contentTypes.some((p) => mimeMatches(p, mt));
}

// ------------------------------------------------------------ one plugin process

export type DecodePlugin = { name: string; dir: string; version: string; command: string[]; timeoutMs: number; decode: DecodeSpec };

export type Reply = { kind: "line"; value: unknown } | { kind: "failure"; error: string };

/** What a line-protocol plugin process needs (decode plugins here, fixture plugins in bundle/fixtures.ts). */
export type LineProcessSpec = { dir: string; command: string[]; timeoutMs: number; maxLine: number };

/** The answer line cap for a payload cap: base64 of `maxBytes` plus 64 KB of JSON around it. */
export const lineCapFor = (maxBytes: number): number => Math.ceil((maxBytes * 4) / 3) + 64 * 1024;

/**
 * The environment of a plugin process: PATH, HOME, LANG, the plugin directory,
 * the protocol variable, Windows basics and where uv / Python keep their
 * caches (a runner started with `uv run` must find the same cache and
 * interpreters as the user's shell). No TABCAP_* setting.
 */
export function pluginEnv(dir: string, protocolVar: string, protocol: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "",
    LANG: process.env["LANG"] ?? "C.UTF-8",
    TABCAP_PLUGIN_DIR: dir,
    [protocolVar]: protocol,
  };
  for (const k of ["SYSTEMROOT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("UV_") && v !== undefined) env[k] = v;
  return env;
}

/** A long-lived plugin process: one JSON line in, one JSON line out, one call at a time. */
export class PluginProcess {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | null = null;
  private waiter: ((r: Reply) => void) | null = null;
  private buf: Uint8Array[] = [];
  private bufLen = 0;
  private maxLine: number;
  private exited: string | null = null;
  starts = 0;

  constructor(
    private readonly p: LineProcessSpec,
    private readonly env: Record<string, string>,
  ) {
    this.maxLine = p.maxLine;
  }

  get alive(): boolean {
    return this.proc !== null && this.exited === null;
  }

  private start(): string | null {
    let argv: string[];
    try {
      argv = resolveDecodeCommand(this.p.dir, this.p.command);
      if (lstatSync(this.p.dir).isSymbolicLink()) return "the plugin directory is a symlink";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    try {
      this.proc = Bun.spawn(argv, { cwd: this.p.dir, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: this.env });
    } catch (e) {
      return `cannot start ${this.p.command[0] ?? "?"}: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.starts++;
    this.exited = null;
    this.buf = [];
    this.bufLen = 0;
    const proc = this.proc;
    void this.readLoop(proc.stdout, proc);
    void this.drain(proc.stderr);
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.exited = `exited with code ${code}`;
      this.settle({ kind: "failure", error: this.exited });
    });
    return null;
  }

  private settle(r: Reply): void {
    const w = this.waiter;
    this.waiter = null;
    w?.(r);
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      // the process is gone
    }
  }

  private async readLoop(stream: ReadableStream<Uint8Array>, owner: unknown): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // a killed process may still flush output: it must not reach its successor
        if (this.proc !== owner) return;
        this.take(value);
      }
    } catch {
      // the process is gone; exited settles the waiter
    }
  }

  private take(chunk: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      this.buf.push(chunk.subarray(start, i));
      this.bufLen += i - start;
      const line = Buffer.concat(this.buf, this.bufLen).toString("utf8");
      this.buf = [];
      this.bufLen = 0;
      start = i + 1;
      this.onLine(line);
    }
    if (start < chunk.length) {
      this.buf.push(chunk.subarray(start));
      this.bufLen += chunk.length - start;
      if (this.bufLen > this.maxLine) {
        this.buf = [];
        this.bufLen = 0;
        this.kill();
        this.settle({ kind: "failure", error: `answer line over ${this.maxLine} bytes` });
      }
    }
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    if (this.waiter === null) return; // nothing asked: ignored
    if (line.length > this.maxLine) {
      this.kill();
      this.settle({ kind: "failure", error: `answer line over ${this.maxLine} bytes` });
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(line) as unknown;
    } catch {
      this.kill();
      this.settle({ kind: "failure", error: "answer is not one JSON line" });
      return;
    }
    this.settle({ kind: "line", value: v });
  }

  /** Send one request line and wait for one answer line (or a failure). Never throws. */
  async call(msg: Record<string, unknown>): Promise<Reply> {
    if (!this.alive) {
      const why = this.start();
      if (why !== null) return { kind: "failure", error: why };
    }
    const proc = this.proc;
    if (proc === null) return { kind: "failure", error: "not running" };
    const answer = new Promise<Reply>((res) => {
      this.waiter = res;
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<Reply>((res) => {
      timer = setTimeout(() => res({ kind: "failure", error: `timed out after ${this.p.timeoutMs} ms` }), this.p.timeoutMs);
    });
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      await proc.stdin.flush();
    } catch {
      // the process died; exited settles the waiter
    }
    const r = await Promise.race([answer, timeout]);
    if (timer !== null) clearTimeout(timer);
    if (r.kind === "failure") {
      this.waiter = null;
      this.kill();
    }
    return r;
  }

  kill(): void {
    this.killed();
  }

  /** Kill the process (if any); the promise resolves when it has exited. */
  private killed(): Promise<number> | null {
    const p = this.proc;
    this.proc = null;
    if (p === null) return null;
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
    return p.exited;
  }

  /**
   * Kill the process and resolve once it has exited (at most `waitMs`). On
   * Windows a directory cannot be removed while a process runs in it, so
   * whoever removes the plugin directory afterwards awaits this.
   */
  async stop(waitMs = 5000): Promise<void> {
    const exited = this.killed();
    if (exited === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cap = new Promise<void>((res) => {
      timer = setTimeout(res, waitMs);
    });
    try {
      await Promise.race([exited.then(() => undefined), cap]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------ host and session

export type DecodeJob = {
  direction: DecodeDirection;
  /** r-N, or null while recording (the event id is assigned when it is written). */
  id: string | null;
  url: string;
  method: string;
  requestHeaders: Headers;
  response: { status: number | null; headers: Headers } | null;
  body: Uint8Array;
  /** Media type the match uses: the request's content-type, or the response's mime type / content-type. */
  mime: string | null;
};

/**
 * A CORS preflight (0.6-S rule, shared with replay/common.ts `isPreflight`):
 * an OPTIONS request with CDP initiator type "preflight" or an
 * `access-control-request-method` header (HAR imports, older recordings).
 */
export function isPreflightOf(method: string, initiatorType: unknown, headers: Headers): boolean {
  if (method.toUpperCase() !== "OPTIONS") return false;
  if (initiatorType === "preflight") return true;
  return Object.keys(headers).some((k) => k.toLowerCase() === "access-control-request-method");
}

/** 0.6-V: why a body is not offered to the decode plugins (preflight: the whole
 * exchange; empty: this side has 0 bytes), or null when it is offered. */
export function decodeSkip(o: { method: string; initiatorType: unknown; requestHeaders: Headers; body: Uint8Array }): "preflight" | "empty" | null {
  if (isPreflightOf(o.method, o.initiatorType, o.requestHeaders)) return "preflight";
  return o.body.length === 0 ? "empty" : null;
}

export type DecodeOutcome =
  | { by: string; version: string; direction: DecodeDirection; ok: true; mime: string | null; body: Uint8Array; note?: string }
  | { by: string; version: string; direction: DecodeDirection; ok: false; error: string };

/** One process per plugin, shared by every session of a daemon (or one `bundle decode` run). */
export class DecodeHost {
  private procs = new Map<string, { key: string; proc: PluginProcess; chain: Promise<unknown> }>();

  /** Run one call on the plugin's process (started on first use, restarted after a failure); calls to one plugin queue. */
  call(p: DecodePlugin, msg: Record<string, unknown>): Promise<Reply> {
    const key = JSON.stringify([p.dir, p.version, p.command, p.timeoutMs, p.decode.maxBytes]);
    let slot = this.procs.get(p.name);
    if (slot === undefined || slot.key !== key) {
      slot?.proc.kill();
      const spec: LineProcessSpec = { dir: p.dir, command: p.command, timeoutMs: p.timeoutMs, maxLine: lineCapFor(p.decode.maxBytes) };
      slot = { key, proc: new PluginProcess(spec, pluginEnv(p.dir, "TABCAP_DECODE_PROTOCOL", DECODE_PROTOCOL)), chain: Promise.resolve() };
      this.procs.set(p.name, slot);
    }
    const s = slot;
    const run = s.chain.then(() => s.proc.call(msg));
    s.chain = run.catch(() => undefined);
    return run;
  }

  /** Kill a plugin's process (protocol broken); the next call starts a new one. */
  reset(name: string): void {
    this.procs.get(name)?.proc.kill();
  }

  /** Processes started so far for a plugin (tests: restart after a crash). */
  starts(name: string): number {
    return this.procs.get(name)?.proc.starts ?? 0;
  }

  /** Kill every plugin process; resolves once they have exited (see PluginProcess.stop). */
  close(): Promise<void> {
    const stops = [...this.procs.values()].map((s) => s.proc.stop());
    this.procs.clear();
    return Promise.all(stops).then(() => undefined);
  }
}

function selectedHeaders(h: Headers, scrub: (s: string) => string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (WITHHELD_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.map(scrub) : scrub(v);
  }
  return out;
}

const cut = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Interpret one answer line; a string is a protocol failure. */
export function parseDecodeReply(v: unknown, id: number, maxBytes: number): { ok: true; mime: string | null; body: Uint8Array; note: string | null } | { ok: false; error: string } | { declined: true } | string {
  if (!isRecord(v)) return "answer is not a JSON object";
  if (v["id"] !== id) return `answer id ${JSON.stringify(v["id"] ?? null)} is not ${id}`;
  if (v["declined"] === true && v["ok"] === undefined) return { declined: true };
  if (v["ok"] === false) return { ok: false, error: typeof v["error"] === "string" && v["error"] !== "" ? cut(v["error"]) : "the plugin reported a failure" };
  if (v["ok"] !== true) return "answer has no boolean ok";
  const b = v["body"];
  if (!isRecord(b) || typeof b["data"] !== "string") return "answer has no body {encoding, data}";
  let body: Uint8Array;
  if (b["encoding"] === "utf8") body = new TextEncoder().encode(b["data"]);
  else if (b["encoding"] === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b["data"].replace(/\s+/g, ""))) return "answer body is not base64";
    body = new Uint8Array(Buffer.from(b["data"], "base64"));
  } else return 'answer body.encoding must be "utf8" or "base64"';
  if (body.length > maxBytes) return `decoded body of ${body.length} bytes is over maxBytes ${maxBytes}`;
  const mimeRaw = v["mime"];
  const mime = typeof mimeRaw === "string" && mimeRaw.length <= 200 && /^[\x20-\x7e]+$/.test(mimeRaw) ? mimeRaw : null;
  const note = typeof v["note"] === "string" && v["note"] !== "" ? cut(v["note"]) : null;
  return { ok: true, mime, body, note };
}

/**
 * The decode plugins of one recording (or one `bundle decode` run): which
 * plugin takes a body, failure counts, the plugins disabled for the session.
 */
export class DecodeSession {
  private failures = new Map<string, number>();
  private disabled = new Set<string>();
  private nextId = 1;
  private readonly scrub: (s: string) => string;
  private readonly source: () => readonly DecodePlugin[];
  /** Every plugin name this session has offered so far (0.7-E: the set changes while a recording runs). */
  private readonly seen = new Set<string>();

  /**
   * `plugins` is a fixed list (`bundle decode`, `replay check`) or a supplier
   * read per decode job (0.7-E: a recording follows `plugin enable` /
   * `plugin disable` made while it runs).
   */
  constructor(
    private readonly host: DecodeHost,
    plugins: readonly DecodePlugin[] | (() => readonly DecodePlugin[]),
    private readonly opts: { scrub?: (s: string) => string; onDisabled?: (name: string, reason: string) => void; maxFailures?: number } = {},
  ) {
    this.scrub = opts.scrub ?? ((s) => s);
    this.source = typeof plugins === "function" ? plugins : () => plugins;
    for (const p of this.plugins) this.seen.add(p.name);
  }

  /** The plugins as of now (a live supplier is read again). */
  get plugins(): readonly DecodePlugin[] {
    return this.source();
  }

  get empty(): boolean {
    return this.plugins.length === 0;
  }

  /** Names of the plugins this session has had in its set so far, in name order (enabled at start or later). */
  get used(): string[] {
    return [...this.seen].sort();
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /** Enabled plugins (name order) whose match takes this body. */
  matching(job: Pick<DecodeJob, "url" | "mime" | "direction">): DecodePlugin[] {
    const list = this.plugins;
    for (const p of list) this.seen.add(p.name);
    return list.filter((p) => !this.disabled.has(p.name) && decodeMatches(p.decode.match, job.url, job.mime, job.direction));
  }

  /**
   * Decode one body: the matching plugins in name order, the first `ok` answer
   * wins; when none succeeds, the first failure is reported. Null when no
   * plugin matches. A plugin that answers `declined` (decode() returned
   * None / null: not its body) leaves no view and is not a failure; it is
   * reported to `declined` and, when every matching plugin declined, the
   * result is null. Never throws.
   */
  async decode(job: DecodeJob, declined?: (plugin: string, version: string) => void): Promise<DecodeOutcome | null> {
    const list = this.matching(job);
    if (list.length === 0) return null;
    let first: DecodeOutcome | null = null;
    for (const p of list) {
      const out = await this.one(p, job);
      if (out === null) {
        declined?.(p.name, p.version);
        continue;
      }
      if (out.ok) return out;
      first ??= out;
    }
    return first;
  }

  private async one(p: DecodePlugin, job: DecodeJob): Promise<DecodeOutcome | null> {
    const base = { by: p.name, version: p.version, direction: job.direction };
    if (job.body.length > p.decode.maxBytes) return { ...base, ok: false, error: `body of ${job.body.length} bytes is over maxBytes ${p.decode.maxBytes}; not sent` };
    const id = this.nextId++;
    const msg: Record<string, unknown> = {
      id,
      op: "decode",
      direction: job.direction,
      request: { id: job.id, url: job.url, method: job.method, headers: selectedHeaders(job.requestHeaders, this.scrub) },
      ...(job.direction === "response" && job.response !== null ? { response: { status: job.response.status, headers: selectedHeaders(job.response.headers, this.scrub) } } : {}),
      body: { encoding: "base64", data: Buffer.from(job.body).toString("base64"), mime: job.mime },
    };
    const r = await this.host.call(p, msg);
    const parsed = r.kind === "failure" ? r.error : parseDecodeReply(r.value, id, p.decode.maxBytes);
    if (typeof parsed === "string") {
      if (r.kind === "line") this.host.reset(p.name); // out of step: a fresh process
      this.fail(p, parsed);
      return { ...base, ok: false, error: this.scrub(parsed) };
    }
    if ("declined" in parsed) return null;
    if (!parsed.ok) return { ...base, ok: false, error: this.scrub(parsed.error) };
    return { ...base, ok: true, mime: parsed.mime, body: parsed.body, ...(parsed.note === null ? {} : { note: this.scrub(parsed.note) }) };
  }

  private fail(p: DecodePlugin, error: string): void {
    const n = (this.failures.get(p.name) ?? 0) + 1;
    this.failures.set(p.name, n);
    log.debug("decode plugin failure", { plugin: p.name, failures: n });
    if (n >= (this.opts.maxFailures ?? MAX_FAILURES) && !this.disabled.has(p.name)) {
      this.disabled.add(p.name);
      try {
        this.opts.onDisabled?.(p.name, this.scrub(`${n} failures, last: ${error}`));
      } catch (e) {
        log.warn("decode: onDisabled failed", { error: String(e) });
      }
    }
  }
}

/**
 * The `decoded` field of a request / response side (docs/04 §28):
 * `{by, version, direction, mime, blob, bytes, ok, error?, note?}`. A view
 * the blob store refuses (over its cap) is reported as `ok: false`.
 */
export async function decodedField(
  out: DecodeOutcome,
  putBlob: (b: Uint8Array) => Promise<{ outcome: "stored"; ref: string; size: number } | { outcome: "too-large"; size: number; cap: number }>,
): Promise<Record<string, unknown>> {
  const base = { by: out.by, version: out.version, direction: out.direction };
  if (!out.ok) return { ...base, mime: null, blob: null, bytes: null, ok: false, error: out.error };
  const put = await putBlob(out.body);
  if (put.outcome !== "stored") return { ...base, mime: out.mime, blob: null, bytes: put.size, ok: false, error: `decoded view of ${put.size} bytes is over the blob cap ${put.cap}` };
  return { ...base, mime: out.mime, blob: put.ref, bytes: put.size, ok: true, ...(out.note === undefined ? {} : { note: out.note }) };
}

/** A plugin manifest name is valid (same rule as challenge handlers). */
export const isPluginName = (s: string): boolean => NAME.test(s);
