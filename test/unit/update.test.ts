// `tabcap update` (0.7.2-A): channel detection, the owning npm, version
// comparison, and the command against a local registry fixture. The executable
// path comes from the test-only TABCAP_UPDATE_EXECUTABLE; npm is a fake script
// through TABCAP_NPM, so nothing is installed and no real registry is asked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { run } from "../../src/cli/main.ts";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";
import { brewPrefixOf, channelOf, compareVersions, npmForBinary, parseVersion, type Version } from "../../src/cli/update.ts";
import { removeTree } from "./_platform.ts";

const POSIX_NPM = "/usr/local/lib/node_modules/tabcap/node_modules/tabcap-darwin-arm64/bin/tabcap";
const WIN_NPM = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tabcap\\node_modules\\tabcap-win32-x64\\bin\\tabcap.exe";

describe("install channel from the binary path", () => {
  test("npm platform packages, both separators", () => {
    expect(channelOf(POSIX_NPM)).toBe("npm");
    expect(channelOf("/home/u/.npm-global/lib/node_modules/tabcap/node_modules/tabcap-linux-x64/bin/tabcap")).toBe("npm");
    expect(channelOf("/opt/x/node_modules/tabcap-linux-arm64/bin/tabcap")).toBe("npm");
    expect(channelOf(WIN_NPM)).toBe("npm");
    expect(channelOf("C:/Users/me/AppData/Roaming/npm/node_modules/tabcap/node_modules/tabcap-win32-x64/bin/tabcap.exe")).toBe("npm");
  });

  test("Homebrew kegs (the resolved path, not the bin/ symlink)", () => {
    expect(channelOf("/opt/homebrew/Cellar/tabcap/0.7.3/bin/tabcap")).toBe("homebrew");
    expect(channelOf("/home/linuxbrew/.linuxbrew/Cellar/tabcap/0.7.3_1/bin/tabcap")).toBe("homebrew");
    expect(channelOf("/opt/homebrew/bin/tabcap")).toBe("manual");
    expect(channelOf("/opt/homebrew/Cellar/other/1.0/bin/tabcap")).toBe("manual");
    expect(channelOf("/opt/homebrew/Cellar/tabcap/0.7.3/libexec/tabcap")).toBe("manual");
    expect(brewPrefixOf("/opt/homebrew/Cellar/tabcap/0.7.3/bin/tabcap")).toBe("/opt/homebrew");
    expect(brewPrefixOf("/home/linuxbrew/.linuxbrew/Cellar/tabcap/0.7.3/bin/tabcap")).toBe("/home/linuxbrew/.linuxbrew");
    expect(brewPrefixOf("/usr/local/bin/tabcap")).toBeNull();
  });

  test("anything else is manual", () => {
    expect(channelOf("/usr/local/bin/tabcap")).toBe("manual");
    expect(channelOf("C:\\tools\\tabcap.exe")).toBe("manual");
    expect(channelOf("/opt/homebrew/bin/bun")).toBe("manual");
    // an unknown os / cpu, or not under bin/
    expect(channelOf("/p/lib/node_modules/tabcap/node_modules/tabcap-freebsd-x64/bin/tabcap")).toBe("manual");
    expect(channelOf("/p/lib/node_modules/tabcap/node_modules/tabcap-linux-x64/tabcap")).toBe("manual");
    expect(channelOf("/p/lib/node_modules/tabcap/bin/tabcap.js")).toBe("manual");
  });
});

describe("the npm that owns the install", () => {
  test("POSIX: <prefix>/lib/node_modules/... -> <prefix>/bin/npm", () => {
    expect(npmForBinary(POSIX_NPM, "darwin")).toBe("/usr/local/bin/npm");
    expect(npmForBinary("/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/tabcap/node_modules/tabcap-linux-x64/bin/tabcap", "linux")).toBe("/home/u/.nvm/versions/node/v22.1.0/bin/npm");
  });

  test("Windows: <prefix>\\node_modules\\... -> <prefix>\\npm.cmd", () => {
    expect(npmForBinary(WIN_NPM, "win32")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd");
    expect(npmForBinary("C:/n/node_modules/tabcap/node_modules/tabcap-win32-x64/bin/tabcap.exe", "win32")).toBe("C:/n/npm.cmd");
  });

  test("not a global npm install -> null (npm on PATH is used)", () => {
    expect(npmForBinary("/usr/local/bin/tabcap", "darwin")).toBeNull();
    expect(npmForBinary("/proj/node_modules/tabcap/node_modules/tabcap-linux-x64/bin/tabcap", "linux")).toBeNull();
    expect(npmForBinary("C:\\tools\\tabcap.exe", "win32")).toBeNull();
  });
});

describe("version comparison", () => {
  const v = (s: string): Version => {
    const p = parseVersion(s);
    if (p === null) throw new Error(`unparsable ${s}`);
    return p;
  };
  test("older / equal / newer, numerically", () => {
    expect(compareVersions(v("0.7.1"), v("0.7.2"))).toBe(-1);
    expect(compareVersions(v("0.9.0"), v("0.10.0"))).toBe(-1);
    expect(compareVersions(v("0.7.1"), v("0.7.1"))).toBe(0);
    expect(compareVersions(v("1.0.0"), v("0.99.99"))).toBe(1);
  });
  test("unparsable", () => {
    for (const s of ["", "0.7", "0.7.1-rc.1", "v0.7.1", "x.y.z", "0.7.1.2"]) expect(parseVersion(s)).toBeNull();
  });
});

describe("tabcap update against a local registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-update-"));
  const npmExe = join(dir, "lib", "node_modules", "tabcap", "node_modules", "tabcap-linux-x64", "bin", "tabcap");
  const manualExe = join(dir, "bin", "tabcap");
  const brewExe = join(dir, "Cellar", "tabcap", "0.0.1", "bin", "tabcap");
  // A fake brew records its argv; with `keg` it creates <prefix>/Cellar/tabcap/<keg> like a real upgrade.
  const fakeBrew = (name: string, code: number, keg?: string): string => {
    const p = join(dir, name);
    const mk = keg === undefined ? "" : `mkdir -p '${join(dir, "Cellar", "tabcap", keg, "bin")}'\n`;
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n${mk}echo "fake brew warns" >&2\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const argvFile = join(dir, "npm-argv.txt");
  // A fake npm writes its arguments to argvFile, one per line, prints a line on each
  // output and exits with `code`. POSIX: a sh script. Windows: a .cmd batch file, the
  // kind of npm a global install has there (npmForBinary -> <prefix>\npm.cmd), so the
  // tests also show that Bun.spawn runs a .cmd directly. The batch file loops over %1
  // with shift (any number of arguments); each redirection comes first on its line so
  // an argument ending in a digit (tabcap@x.y.z) is not read as a handle number; echo
  // ends lines with CRLF, which readArgv folds back.
  const fakeNpm = (name: string, code: number): string => {
    if (process.platform === "win32") {
      const p = join(dir, `${name}.cmd`);
      const lines = ["@echo off", `type nul > "${argvFile}"`, ":next", 'if "%~1"=="" goto done', `>> "${argvFile}" echo %~1`, "shift", "goto next", ":done", "echo fake npm says hi", ">&2 echo fake npm warns", `exit /b ${code}`];
      writeFileSync(p, lines.join("\r\n") + "\r\n");
      return p;
    }
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho "fake npm says hi"\necho "fake npm warns" >&2\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const readArgv = (): string => readFileSync(argvFile, "utf8").replaceAll("\r\n", "\n");
  // Windows creates a symlink only with the privilege (elevated, or Developer Mode).
  const canSymlink = ((): boolean => {
    const probe = join(dir, "symlink-probe");
    try {
      writeFileSync(`${probe}.target`, "");
      symlinkSync(`${probe}.target`, probe);
      return true;
    } catch {
      return false;
    }
  })();
  let latest = "0.0.0";
  let server: Server<undefined>;
  const saved: Record<string, string | undefined> = {};
  const keys = ["TABCAP_HOME", "TABCAP_NPM_REGISTRY", "TABCAP_NPM", "TABCAP_BREW", "TABCAP_UPDATE_EXECUTABLE"];
  const setEnv = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    for (const p of [npmExe, manualExe, brewExe]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    }
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname === "/tabcap/latest" ? Response.json({ name: "tabcap", version: latest }) : new Response("nope", { status: 404 })),
    });
    setEnv("TABCAP_HOME", join(dir, "home"));
    setEnv("TABCAP_NPM_REGISTRY", `http://127.0.0.1:${server.port}/`);
  });
  afterAll(async () => {
    void server.stop(true);
    for (const k of keys) setEnv(k, saved[k]);
    await removeTree(dir);
  });

  const newer = (): string => {
    const c = parseVersion(TOOL_VERSION);
    if (c === null) throw new Error("bad TOOL_VERSION");
    return `${c[0]}.${c[1]}.${c[2] + 1}`;
  };
  const update = async (exe: string, ...flags: string[]) => {
    setEnv("TABCAP_UPDATE_EXECUTABLE", exe);
    return await run(["update", ...flags]);
  };

  test("up to date", async () => {
    latest = TOOL_VERSION;
    const { code, envelope } = await update(npmExe);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ current: TOOL_VERSION, latest: TOOL_VERSION, updateAvailable: false, channel: "npm", executable: npmExe, action: "up-to-date", releases: "https://github.com/1A7432/tabcap/releases" });
    expect(envelope.data).not.toHaveProperty("npm");
  });

  test("--check on npm: compares, spawns nothing", async () => {
    latest = newer();
    setEnv("TABCAP_NPM", fakeNpm("npm-check", 0));
    const { code, envelope } = await update(npmExe, "--check");
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ current: TOOL_VERSION, latest, updateAvailable: true, channel: "npm", action: "check" });
    expect(envelope.data).not.toHaveProperty("npm");
    expect(existsSync(argvFile)).toBe(false);
  });

  test("manual channel: versions and the release page, nothing runs (with and without --check)", async () => {
    latest = newer();
    setEnv("TABCAP_NPM", fakeNpm("npm-manual", 0));
    for (const [flags, action] of [[[], "manual"], [["--check"], "check"]] as const) {
      const { code, envelope } = await update(manualExe, ...flags);
      expect(code).toBe(0);
      if (!envelope.ok) throw new Error(envelope.error.message);
      expect(envelope.data).toMatchObject({ updateAvailable: true, channel: "manual", executable: manualExe, action });
      expect(String((envelope.data as { next: string }).next)).toContain("https://github.com/1A7432/tabcap/releases");
    }
    expect(existsSync(argvFile)).toBe(false);
  });

  test("npm channel: runs npm install -g tabcap@<latest>", async () => {
    latest = newer();
    const npm = fakeNpm("npm-ok", 0);
    setEnv("TABCAP_NPM", npm);
    const { code, envelope } = await update(npmExe);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ updateAvailable: true, channel: "npm", action: "installed", npm: { command: [npm, "install", "-g", `tabcap@${latest}`] } });
    expect(readArgv()).toBe(`install\n-g\ntabcap@${latest}\n`);
  });

  test.skipIf(!canSymlink)("npm channel through a symlink: matched on the resolved path, the given path answered", async () => {
    latest = newer();
    const link = join(dir, "tabcap-link");
    if (!existsSync(link)) symlinkSync(npmExe, link);
    setEnv("TABCAP_NPM", fakeNpm("npm-link", 0));
    const { envelope } = await update(link, "--check");
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ channel: "npm", executable: link, action: "check" });
  });

  test("npm failing -> error envelope with its exit code and output", async () => {
    latest = newer();
    setEnv("TABCAP_NPM", fakeNpm("npm-fail", 1));
    const { code, envelope } = await update(npmExe);
    expect(code).toBe(1);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("io");
    expect(envelope.error.message).toContain("exited with 1");
    expect(envelope.error.message).toContain("fake npm warns");
    expect(envelope.error.next).toContain(`npm install -g tabcap@${latest}`);
  });

  // The fake brew is a POSIX shell script, and Homebrew does not exist on Windows.
  test.skipIf(process.platform === "win32")("--check on Homebrew: compares, spawns nothing", async () => {
    latest = newer();
    rmSync(argvFile, { force: true });
    setEnv("TABCAP_BREW", fakeBrew("brew-check", 0));
    const { code, envelope } = await update(brewExe, "--check");
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ updateAvailable: true, channel: "homebrew", action: "check" });
    expect(String((envelope.data as { next: string }).next)).toContain("brew upgrade tabcap");
    expect(existsSync(argvFile)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("Homebrew channel: runs brew upgrade tabcap; the new keg means installed", async () => {
    latest = newer();
    const brew = fakeBrew("brew-ok", 0, latest);
    setEnv("TABCAP_BREW", brew);
    const { code, envelope } = await update(brewExe);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ channel: "homebrew", action: "installed", brew: { command: [brew, "upgrade", "tabcap"] } });
    expect(readFileSync(argvFile, "utf8")).toBe("upgrade\ntabcap\n");
    await removeTree(join(dir, "Cellar", "tabcap", latest));
  });

  test.skipIf(process.platform === "win32")("Homebrew channel: brew succeeds without the new keg -> formula-behind", async () => {
    latest = newer();
    setEnv("TABCAP_BREW", fakeBrew("brew-behind", 0));
    const { code, envelope } = await update(brewExe);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ channel: "homebrew", action: "formula-behind" });
    expect(String((envelope.data as { next: string }).next)).toContain("brew update && brew upgrade tabcap");
  });

  test.skipIf(process.platform === "win32")("Homebrew channel: brew failing -> error envelope", async () => {
    latest = newer();
    setEnv("TABCAP_BREW", fakeBrew("brew-fail", 1));
    const { code, envelope } = await update(brewExe);
    expect(code).toBe(1);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("io");
    expect(envelope.error.message).toContain("exited with 1");
    expect(envelope.error.message).toContain("fake brew warns");
    expect(envelope.error.next).toContain("brew upgrade tabcap");
  });

  test("unparsable latest -> error envelope", async () => {
    latest = "next";
    const { code, envelope } = await update(npmExe, "--check");
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { code: "bad-input" } });
  });

  test("registry down -> io error naming the URL", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port;
    await closed.stop(true);
    setEnv("TABCAP_NPM_REGISTRY", `http://127.0.0.1:${port}`);
    try {
      const { code, envelope } = await update(npmExe, "--check");
      expect(code).toBe(1);
      if (envelope.ok) throw new Error("expected failure");
      expect(envelope.error.code).toBe("io");
      expect(envelope.error.message).toContain(`http://127.0.0.1:${port}/tabcap/latest`);
      expect(envelope.error.next).toContain("https://github.com/1A7432/tabcap/releases");
    } finally {
      setEnv("TABCAP_NPM_REGISTRY", `http://127.0.0.1:${server.port}/`);
    }
  });
});
