// Python for the replay generator tests. `py_compile` needs only python3; the
// generated pytest suite needs httpx + pytest, taken from (in order)
// $TABCAP_TEST_PYTHON, or a venv made with `uv` from its local cache only
// (UV_OFFLINE=1: tests never download). Without either the pytest run is
// skipped with the reason printed; py_compile still runs.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A Python 3 that actually runs. On Windows `python3` is often the Store alias
 * stub (it exits with an error or opens the Store), and `python` is the real one.
 */
function findPython3(): string | null {
  for (const name of ["python3", "python"]) {
    const p = Bun.which(name);
    if (p === null) continue;
    const r = Bun.spawnSync([p, "-I", "-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    if (r.exitCode === 0) return p;
  }
  return null;
}

export const PYTHON3 = findPython3();

function works(python: string): boolean {
  const r = Bun.spawnSync([python, "-I", "-c", "import httpx, pytest"], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

/** A python with httpx and pytest, or the reason there is none. */
export function pytestPython(): { python: string } | { reason: string } {
  const env = process.env["TABCAP_TEST_PYTHON"];
  if (env !== undefined && env !== "") return works(env) ? { python: env } : { reason: `TABCAP_TEST_PYTHON=${env} lacks httpx or pytest` };
  const uv = Bun.which("uv");
  if (uv === null) return { reason: "uv is not installed and TABCAP_TEST_PYTHON is not set" };
  const venv = join(tmpdir(), "tabcap-replay-test-venv");
  const py = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  if (existsSync(py) && works(py)) return { python: py };
  const env2 = { ...process.env, UV_OFFLINE: "1", UV_NO_PROGRESS: "1" };
  const mk = Bun.spawnSync([uv, "venv", "-q", "--allow-existing", venv], { env: env2, stdout: "pipe", stderr: "pipe" });
  if (mk.exitCode !== 0) return { reason: `uv venv failed: ${mk.stderr.toString().trim().slice(0, 300)}` };
  const inst = Bun.spawnSync([uv, "pip", "install", "-q", "--python", py, "httpx", "pytest"], { env: env2, stdout: "pipe", stderr: "pipe" });
  if (inst.exitCode !== 0) return { reason: `offline install of httpx + pytest failed (uv cache has no copy; network is not used in tests): ${inst.stderr.toString().trim().slice(0, 300)}` };
  return works(py) ? { python: py } : { reason: "venv created but httpx / pytest do not import" };
}

/** `python3 -m py_compile` over files; returns stderr on failure, null when all compile. */
export function pyCompile(files: readonly string[]): string | null {
  if (PYTHON3 === null) return "python3 not found";
  const r = Bun.spawnSync([PYTHON3, "-I", "-m", "py_compile", ...files], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? null : r.stderr.toString();
}
