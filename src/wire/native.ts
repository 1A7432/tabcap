// Running the native wire component (native/wireprint).
//
// Compiled tabcap: the host's embedded binary is extracted once to
// <cache>/native/wireprint-<sha256 of its bytes>/wireprint[.exe] (directory
// 0700, file 0755; written to a temp name and renamed). Source checkout: the
// binary in native/dist/<host target>/, built with Zig when missing.
// Before every spawn the file's sha256 is checked against the expected one
// (the embedded bytes, or the hash taken when it was located); a mismatch
// re-extracts (compiled) or fails. Spawned with an argv array, never a shell.
// Exit codes of the component: 0 ok, 1 usage / input error (stderr), 3 check
// INCONSISTENT (JSON still on stdout); anything else is a crash.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { binaryName, distBinary, hostTarget, type NativeTarget } from "./targets.ts";

export type NativeSource = "embedded" | "dev";

export type Located = { path: string; sha256: string; source: NativeSource; target: NativeTarget };

export type Ran = { code: number; stdout: string; stderr: string };

/** True inside a `bun build --compile` executable (its modules live in Bun's virtual file system). */
export function isCompiled(modulePath: string = import.meta.path, execPath: string = process.execPath): boolean {
  if (modulePath.includes("$bunfs") || modulePath.includes("~BUN")) return true;
  return !/^bun(\.exe)?$/i.test(execPath.split(/[\\/]/).pop() ?? "");
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function needTarget(): NativeTarget {
  const t = hostTarget();
  if (t === null) {
    throw new TabcapError("unsupported", `no wire component for ${process.platform}-${process.arch}`, "tabcap ships it for macOS arm64, Linux x64 / arm64 and Windows x64.");
  }
  return t;
}

/** Write `bytes` to <cacheDir>/native/wireprint-<sha>/<name> unless an identical file is there. */
export function extractTo(cacheDir: string, t: NativeTarget, bytes: Uint8Array): Located {
  const sha = sha256Hex(bytes);
  const dir = join(cacheDir, "native", `wireprint-${sha}`);
  const file = join(dir, binaryName(t));
  if (existsSync(file) && sha256Hex(new Uint8Array(readFileSync(file))) === sha) return { path: file, sha256: sha, source: "embedded", target: t };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new TabcapError("io", `cannot extract the wire component to ${file}: ${e instanceof Error ? e.message : String(e)}`, "Check free space and permissions of the tabcap cache directory.");
  }
  return { path: file, sha256: sha, source: "embedded", target: t };
}

export class Wireprint {
  private constructor(
    private loc: Located,
    private readonly reload: (() => Promise<Located>) | null,
  ) {}

  get path(): string {
    return this.loc.path;
  }
  get sha256(): string {
    return this.loc.sha256;
  }
  get source(): NativeSource {
    return this.loc.source;
  }
  get target(): NativeTarget {
    return this.loc.target;
  }

  /** The component for this host: embedded (compiled tabcap) or native/dist (source checkout; built if missing). */
  static async locate(o: { cacheDir: string; compiled?: boolean; dist?: string }): Promise<Wireprint> {
    const t = needTarget();
    if (o.compiled ?? isCompiled()) {
      const load = async (): Promise<Located> => {
        const { EMBEDDED } = await import("./embedded.ts");
        const bytes = new Uint8Array(await Bun.file(EMBEDDED[t]).arrayBuffer());
        return extractTo(o.cacheDir, t, bytes);
      };
      return new Wireprint(await load(), load);
    }
    const path = distBinary(t, o.dist);
    if (!existsSync(path)) {
      const { buildTarget } = await import("./build.ts");
      await buildTarget(t, o.dist === undefined ? {} : { dist: o.dist });
    }
    return new Wireprint({ path, sha256: sha256Hex(new Uint8Array(readFileSync(path))), source: "dev", target: t }, null);
  }

  /** A component at a known path (tests). */
  static at(path: string, target: NativeTarget = needTarget()): Wireprint {
    return new Wireprint({ path, sha256: sha256Hex(new Uint8Array(readFileSync(path))), source: "dev", target }, null);
  }

  /** The file still has the expected bytes; compiled: re-extract once when it does not. */
  private async verified(): Promise<string> {
    const ok = existsSync(this.loc.path) && sha256Hex(new Uint8Array(readFileSync(this.loc.path))) === this.loc.sha256;
    if (ok) return this.loc.path;
    if (this.reload !== null) {
      this.loc = await this.reload();
      return this.loc.path;
    }
    throw new TabcapError("io", `the wire component at ${this.loc.path} changed or disappeared (sha256 no longer ${this.loc.sha256})`, "Rebuild it with `bun scripts/native.ts build --host`.");
  }

  /** Run with an argv array; returns exit code and both streams (no interpretation). */
  async run(args: readonly string[], timeoutMs = 30_000): Promise<Ran> {
    const path = await this.verified();
    const p = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  }

  /** Run a JSON-printing subcommand. Exit 1 → TabcapError bad-input; 3 is accepted only with `inconsistentOk`. */
  async json(args: readonly string[], o: { inconsistentOk?: boolean; timeoutMs?: number } = {}): Promise<{ value: Record<string, unknown>; code: number }> {
    const r = await this.run(args, o.timeoutMs);
    return { value: parseOutput(r, args, o.inconsistentOk === true), code: r.code };
  }

  async version(): Promise<string> {
    const r = await this.run(["version"]);
    if (r.code !== 0) throw mapFailure(r, ["version"]);
    return r.stdout.trim();
  }
}

/** The error for a non-zero exit (pure: unit tested). */
export function mapFailure(r: Ran, args: readonly string[]): TabcapError {
  const cmd = args[0] ?? "";
  const msg = r.stderr.trim().split("\n")[0] ?? "";
  if (r.code === 1) return new TabcapError("bad-input", `wireprint ${cmd}: ${msg.replace(/^error: /, "")}`, "The captured bytes or files could not be read by the wire component; rerun, and keep the files with --capture-dir to look at them.");
  return new TabcapError("internal", `wireprint ${cmd} exited with code ${r.code}${msg === "" ? "" : `: ${msg}`}`, "This is a bug in the wire component; rerun with --capture-dir and report the files.");
}

/** stdout as a JSON object, or the mapped failure (pure: unit tested). */
export function parseOutput(r: Ran, args: readonly string[], inconsistentOk: boolean): Record<string, unknown> {
  if (!(r.code === 0 || (r.code === 3 && inconsistentOk))) throw mapFailure(r, args);
  let v: unknown;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    throw new TabcapError("internal", `wireprint ${args[0] ?? ""} printed no JSON`, "This is a bug in the wire component.");
  }
  if (!isRecord(v)) throw new TabcapError("internal", `wireprint ${args[0] ?? ""} printed no JSON object`, "This is a bug in the wire component.");
  return v;
}
