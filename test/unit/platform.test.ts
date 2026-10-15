// 0.3-G: per-platform code paths (directories, daemon listener, Chrome for
// Testing builds and unpacking). Pure functions are tested for every platform
// on every host; the listeners are started for real.

import { describe, expect, test } from "bun:test";
import { requestFor } from "../../src/cli/client.ts";
import { authorized, listen, newToken } from "../../src/daemon/listener.ts";
import { binaryVersion, unpackCommand } from "../../src/daemon/transport/direct/cft.ts";
import { binaryIn, hostPlatform } from "../../src/daemon/transport/direct/launcher.ts";
import { baseDirs, listenerKind, parseTcpRecord } from "../../src/shared/paths.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("directories per platform", () => {
  test("macOS keeps the 0.2 layout and ignores XDG variables", () => {
    expect(baseDirs({ platform: "darwin", env: { XDG_CONFIG_HOME: "/x" }, homedir: "/Users/me" })).toEqual({
      config: "/Users/me/.config/tabcap",
      cache: "/Users/me/.cache/tabcap",
      data: "/Users/me/.local/share/tabcap",
    });
  });

  test("Linux follows XDG base directories; unset or relative values fall back", () => {
    expect(baseDirs({ platform: "linux", env: {}, homedir: "/home/me" })).toEqual({
      config: "/home/me/.config/tabcap",
      cache: "/home/me/.cache/tabcap",
      data: "/home/me/.local/share/tabcap",
    });
    expect(baseDirs({ platform: "linux", env: { XDG_CONFIG_HOME: "/c", XDG_CACHE_HOME: "/k", XDG_DATA_HOME: "relative/d" }, homedir: "/home/me" })).toEqual({
      config: "/c/tabcap",
      cache: "/k/tabcap",
      data: "/home/me/.local/share/tabcap",
    });
  });

  test("Windows: %LOCALAPPDATA%\\tabcap, else the profile's AppData\\Local", () => {
    expect(baseDirs({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, homedir: "C:\\Users\\me" })).toEqual({
      config: "C:\\Users\\me\\AppData\\Local\\tabcap\\config",
      cache: "C:\\Users\\me\\AppData\\Local\\tabcap\\cache",
      data: "C:\\Users\\me\\AppData\\Local\\tabcap\\data",
    });
    expect(baseDirs({ platform: "win32", env: { LOCALAPPDATA: "" }, homedir: "C:\\Users\\me" }).config).toBe("C:\\Users\\me\\AppData\\Local\\tabcap\\config");
  });

  test("TABCAP_HOME wins everywhere", () => {
    expect(baseDirs({ platform: "linux", env: { TABCAP_HOME: "/h", XDG_CONFIG_HOME: "/c" }, homedir: "/home/me" }).config).toBe("/h/config");
    expect(baseDirs({ platform: "win32", env: { TABCAP_HOME: "D:\\t", LOCALAPPDATA: "C:\\L" }, homedir: "C:\\Users\\me" }).data).toBe("D:\\t\\data");
  });
});

describe("daemon listener per platform", () => {
  test("Unix socket on macOS / Linux, loopback TCP on Windows", () => {
    expect(listenerKind("darwin")).toBe("unix");
    expect(listenerKind("linux")).toBe("unix");
    expect(listenerKind("win32")).toBe("tcp");
  });

  test("daemon.json TCP records: port and a 64-hex token, nothing else accepted", () => {
    const token = "a".repeat(64);
    expect(parseTcpRecord({ pid: 1, listener: "tcp", host: "127.0.0.1", port: 5123, token })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 5123, token });
    expect(parseTcpRecord({ listener: "tcp", port: 0, token })).toBeNull();
    expect(parseTcpRecord({ listener: "tcp", port: 70000, token })).toBeNull();
    expect(parseTcpRecord({ listener: "tcp", port: 5123, token: "short" })).toBeNull();
    expect(parseTcpRecord({ listener: "tcp", port: "5123", token })).toBeNull();
    expect(parseTcpRecord({ pid: 1, socket: "/tmp/x.sock" })).toBeNull();
    expect(parseTcpRecord(null)).toBeNull();
  });

  test("the CLI sends the token as a bearer header to 127.0.0.1, never in the URL", () => {
    const token = newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(token);
    const r = requestFor({ kind: "tcp", host: "127.0.0.1", port: 5123, token }, "/status", { method: "GET" });
    expect(r.url).toBe("http://127.0.0.1:5123/status");
    expect(new Headers(r.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(r.url).not.toContain(token);
    const u = requestFor({ kind: "unix", socket: "/s/daemon.sock" }, "/status", { method: "GET" });
    expect(u).toEqual({ url: "http://localhost/status", init: { method: "GET", unix: "/s/daemon.sock" } });
  });

  test("bearer check: exact token only", () => {
    const token = newToken();
    const req = (h: string | null) => new Request("http://127.0.0.1/status", h === null ? {} : { headers: { authorization: h } });
    expect(authorized(req(`Bearer ${token}`), token)).toBe(true);
    expect(authorized(req(null), token)).toBe(false);
    expect(authorized(req(token), token)).toBe(false);
    expect(authorized(req(`Bearer ${token.slice(1)}`), token)).toBe(false);
    expect(authorized(req(`Bearer ${token}x`), token)).toBe(false);
    expect(authorized(req(`bearer ${token}`), token)).toBe(false);
  });

  test("TCP listener: loopback, random port, 401 without the token, handler with it; the token is not in describe", async () => {
    const token = newToken();
    let reached = 0;
    const l = listen({ kind: "tcp", token }, () => {
      reached++;
      return new Response(JSON.stringify({ ok: true, data: { hi: 1 } }));
    });
    try {
      expect(l.record).toMatchObject({ listener: "tcp", host: "127.0.0.1", token });
      expect(l.describe).toEqual({ listener: "tcp", host: "127.0.0.1", port: l.record.listener === "tcp" ? l.record.port : -1 });
      expect(JSON.stringify(l.describe)).not.toContain(token);
      const url = `http://127.0.0.1:${l.describe.listener === "tcp" ? l.describe.port : 0}/status`;
      const none = await fetch(url);
      expect(none.status).toBe(401);
      expect(await none.json()).toMatchObject({ ok: false, error: { code: "usage" } });
      expect((await fetch(url, { headers: { authorization: `Bearer ${newToken()}` } })).status).toBe(401);
      expect(reached).toBe(0);
      const good = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true, data: { hi: 1 } });
      expect(reached).toBe(1);
    } finally {
      l.server.stop(true);
    }
  });

  test.skipIf(process.platform === "win32")("Unix listener: no token involved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const socket = join(dir, "d.sock");
    const l = listen({ kind: "unix", socket }, () => new Response("{}"));
    try {
      expect(l.record).toEqual({ listener: "unix", socket });
      const r = await fetch("http://localhost/status", { unix: socket });
      expect(r.status).toBe(200);
    } finally {
      l.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Chrome for Testing per platform", () => {
  test("which build: mac arm64 / x64, linux64, win64; none for Linux or Windows on arm64", () => {
    expect(hostPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(hostPlatform("darwin", "x64")).toBe("mac-x64");
    expect(hostPlatform("linux", "x64")).toBe("linux64");
    expect(hostPlatform("win32", "x64")).toBe("win64");
    expect(hostPlatform("linux", "arm64")).toBeNull();
    expect(hostPlatform("win32", "arm64")).toBeNull();
  });

  test("binary inside the archive", () => {
    expect(binaryIn("V", "win64")).toBe(join("V", "chrome-win64", "chrome.exe"));
    expect(binaryIn("V", "linux64")).toBe(join("V", "chrome-linux64", "chrome"));
    expect(binaryIn("V", "mac-arm64")).toBe(join("V", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
  });

  test("unpacking: Expand-Archive on Windows (paths via the environment), unzip, else bsdtar on Linux", () => {
    const all = (t: string) => `/usr/bin/${t}`;
    const none = () => null;
    const win = unpackCommand("win32", "C:\\t\\it's.zip", "C:\\t\\out", none);
    expect(win?.cmd.slice(0, 5)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(win?.cmd[5]).toContain("Expand-Archive -LiteralPath $env:TABCAP_SETUP_ZIP -DestinationPath $env:TABCAP_SETUP_DEST -Force");
    expect(win?.cmd.join(" ")).not.toContain("it's.zip");
    expect(win?.env).toEqual({ TABCAP_SETUP_ZIP: "C:\\t\\it's.zip", TABCAP_SETUP_DEST: "C:\\t\\out" });
    expect(unpackCommand("linux", "/z.zip", "/d", all)).toEqual({ cmd: ["unzip", "-q", "-o", "/z.zip", "-d", "/d"], env: {} });
    expect(unpackCommand("linux", "/z.zip", "/d", (t) => (t === "bsdtar" ? "/usr/bin/bsdtar" : null))).toEqual({ cmd: ["bsdtar", "-xf", "/z.zip", "-C", "/d"], env: {} });
    expect(unpackCommand("linux", "/z.zip", "/d", none)).toBeNull();
    expect(unpackCommand("darwin", "/z.zip", "/d", all)?.cmd[0]).toBe("unzip");
  });

  test("version check of a missing binary is null, not a crash", () => {
    const missing = join(tmpdir(), "no-such-chrome-binary");
    expect(binaryVersion(missing)).toBeNull();
    // On Windows a missing file is answered before PowerShell starts, on any host.
    expect(binaryVersion(missing, "win32")).toBeNull();
  });
});
