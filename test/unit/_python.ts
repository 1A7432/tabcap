// Python for the replay generator tests, always through uv and always offline
// (UV_OFFLINE=1: tests never download; CI fills the uv cache in a warm-up
// step). Syntax checks: `uv run --no-project --offline python -m py_compile`.
// A generated package gets its own `.venv` inside its output directory:
// `uv sync --project <out> --group test --offline`, then
// `uv run --project <out> --offline …`; nothing is shared between tests or
// between parallel `bun test` runs.
// No uv, or a uv cache without a Python / httpx / pytest: the Python-dependent
// tests skip with the reason printed, except under CI (`CI` set), where they
// run and fail with that reason, so CI never silently skips the generated client.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };

const UV = Bun.which("uv");

/** True under CI: a missing Python must fail the test, not skip it. */
export const MUST_RUN = (process.env["CI"] ?? "") !== "";

/** The environment of every uv call: offline, no progress bars, no foreign virtualenv. */
function uvEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, UV_OFFLINE: "1", UV_NO_PROGRESS: "1", ...extra };
  // an active virtualenv or a shared project environment would make uv use (and warn about) it
  delete env["VIRTUAL_ENV"];
  delete env["UV_PROJECT_ENVIRONMENT"];
  return env;
}

export type Ran = { code: number; out: string; err: string };

function uv(args: string[], cwd?: string, env: Record<string, string> = {}): Ran {
  if (UV === null) return { code: -1, out: "", err: "uv is not installed" };
  const p = Bun.spawnSync([UV, ...args], { ...(cwd === undefined ? {} : { cwd }), env: uvEnv(env), stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function firstLines(s: string): string {
  return s.trim().slice(0, 400);
}

let pythonChecked: string | null | undefined;

/** null when `uv run --no-project` finds a Python 3.11+ offline; else the reason. */
export function pythonReason(): string | null {
  if (pythonChecked !== undefined) return pythonChecked;
  if (UV === null) pythonChecked = "uv is not installed";
  else {
    const r = uv(["run", "--no-project", "--offline", "-q", "python", "-I", "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"]);
    pythonChecked = r.code === 0 ? null : `uv finds no Python 3.11+ offline: ${firstLines(r.err)}`;
  }
  return pythonChecked;
}

/** `uv run --no-project --offline python <args>` (the caller passes `-I` where it wants isolation). */
export function runPython(args: string[], cwd?: string): Ran {
  return uv(["run", "--no-project", "--offline", "-q", "python", ...args], cwd);
}

/** `python -m py_compile` over files; returns stderr (or the reason there is no Python) on failure, null when all compile. */
export function pyCompile(files: readonly string[]): string | null {
  const reason = pythonReason();
  if (reason !== null) return reason;
  const r = runPython(["-I", "-m", "py_compile", ...files]);
  return r.code === 0 ? null : r.err;
}

/** `uv sync --project <out> --group test --offline`: the package's own `.venv`. null on success, else the reason. */
export function syncPackage(out: string): string | null {
  const r = uv(["sync", "--project", out, "--group", "test", "--offline", "-q"], out);
  return r.code === 0 ? null : `uv sync --offline failed (the uv cache lacks a Python, httpx[http2] or pytest; tests never download): ${firstLines(r.err)}`;
}

/** `uv run --project <out> --offline <args>` in `out`, after syncPackage(out). */
export function runInPackage(out: string, args: string[], env: Record<string, string> = {}): Ran {
  return uv(["run", "--project", out, "--offline", "-q", ...args], out, env);
}

/** runInPackage without blocking the event loop (a server child of this process keeps its pipes drained). */
export async function runInPackageAsync(out: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  if (UV === null) return { code: -1, out: "", err: "uv is not installed" };
  const p = Bun.spawn([UV, "run", "--project", out, "--offline", "-q", ...args], { cwd: out, env: uvEnv(env), stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o, err: e };
}

let packageChecked: string | null | undefined;

/**
 * null when a package with the generated pyproject.toml syncs offline (probed
 * once per test file in its own temp dir, removed after); else the reason.
 */
export function packageReason(): string | null {
  if (packageChecked !== undefined) return packageChecked;
  const py = pythonReason();
  if (py !== null) return (packageChecked = py);
  const dir = mkdtempSync(join(tmpdir(), "tabcap-uv-probe-"));
  try {
    writeFileSync(join(dir, "pyproject.toml"), PYPROJECT.replace(/\{\{\w+\}\}/g, "tabcap-uv-probe"));
    const sync = syncPackage(dir);
    if (sync !== null) packageChecked = sync;
    else {
      const r = runInPackage(dir, ["python", "-c", "import httpx, h2, pytest; httpx.Client(http2=True).close()"]);
      packageChecked = r.code === 0 ? null : `httpx[http2] / pytest do not import after uv sync: ${firstLines(r.err)}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return packageChecked;
}

/**
 * Whether a test that needs `reason === null` is skipped: yes when there is a
 * reason, except under CI (MUST_RUN). Prints the reason once per label.
 */
export function skipWithout(reason: string | null, label: string): boolean {
  if (reason === null) return false;
  if (MUST_RUN) {
    console.error(`[${label}] Python through uv is unavailable under CI, the test FAILS: ${reason}`);
    return false;
  }
  console.warn(`[${label}] SKIPPED: ${reason}`);
  return true;
}

/** Throws with the reason (the CI case of skipWithout). */
export function need(reason: string | null): void {
  if (reason !== null) throw new Error(reason);
}
