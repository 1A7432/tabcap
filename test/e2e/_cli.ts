// The CLI as the e2e tests drive it: spawn `bun src/cli/main.ts <args>` with a
// test's TABCAP_HOME and the Chrome for Testing in TABCAP_CHROME, read the JSON
// envelope it prints, and the small helpers every e2e file uses with it
// (s / rec / recs to read answers, until to poll). A run whose output cannot
// be read fails with its exit code, the first 2 KB of its stdout and the last
// 2 KB of its stderr, so a crash shows why.

import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SHOW = 2048;

export const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
export const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** One CLI run: the envelope's ok / data / error, the envelope itself, stdout as printed (`raw`), stderr and the exit code. */
export type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; envelope: Record<string, unknown>; raw: string; stderr: string; exit: number };

export type CliOptions = {
  /** Environment on top of TABCAP_HOME / TABCAP_CHROME (TABCAP_LOG, TABCAP_E2E_HUMAN, ...). */
  env?: Record<string, string>;
  stdin?: string;
  cwd?: string;
  /**
   * Stdout that is not JSON (text output, --help, JSON lines): "throw"
   * (default) fails with the output; "exit" answers ok = exit code 0 with
   * empty data, error null, envelope {} and raw = stdout.
   */
  nonJson?: "throw" | "exit";
  /** Sees every run's stdout and stderr before they are parsed. */
  onOutput?: (stdout: string, stderr: string) => void;
};

const head = (t: string): string => (t.length <= SHOW ? t : `${t.slice(0, SHOW)}… [${t.length - SHOW} more chars]`);
const tail = (t: string): string => (t.length <= SHOW ? t : `[${t.length - SHOW} chars before] …${t.slice(-SHOW)}`);

function unreadable(args: string[], what: string, out: string, err: string, exit: number): Error {
  return new Error(`tabcap ${args.join(" ")}: ${what} (exit ${exit})\nstdout: ${head(out)}\nstderr: ${tail(err)}`);
}

/** Run `tabcap <args>` against `home` and read its envelope. */
export async function tabcap(home: string, args: string[], o: CliOptions = {}): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME, ...o.env },
    stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
    stdout: "pipe",
    stderr: "pipe",
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  o.onOutput?.(out, err);
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    if (o.nonJson === "exit") return { ok: exit === 0, data: {}, error: null, envelope: {}, raw: out, stderr: err, exit };
    throw unreadable(args, "stdout is not JSON", out, err, exit);
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw unreadable(args, "not an envelope", out, err, exit);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, envelope: env, raw: out, stderr: err, exit };
}

/** The data of a run that had to succeed; a failed one throws with its output. */
export function okData(e: Env, args: string[]): Record<string, unknown> {
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}${e.stderr === "" ? "" : `\nstderr: ${tail(e.stderr)}`}`);
  return e.data;
}

/** `tabcap <args>` against `home` that has to succeed: its data. */
export async function ok(home: string, ...args: string[]): Promise<Record<string, unknown>> {
  return okData(await tabcap(home, args), args);
}

export type Cli = { tabcap: (args: string[], stdin?: string) => Promise<Env>; ok: (...args: string[]) => Promise<Record<string, unknown>> };

/** tabcap() and ok() bound to a test file's home (read at every call, so a `let` set in beforeAll works) and options. */
export function cliFor(home: () => string, o: Omit<CliOptions, "stdin"> = {}): Cli {
  return {
    tabcap: (args, stdin) => tabcap(home(), args, stdin === undefined ? o : { ...o, stdin }),
    ok: async (...args) => okData(await tabcap(home(), args, o), args),
  };
}

/** Poll `get` until `done` holds; after `ms` throw with the last value. */
export async function until<T>(what: string, get: () => Promise<T> | T, done: (v: T) => boolean, ms = 15_000, every = 150): Promise<T> {
  const end = Date.now() + ms;
  let last = await get();
  while (!done(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await Bun.sleep(every);
    last = await get();
  }
  return last;
}
