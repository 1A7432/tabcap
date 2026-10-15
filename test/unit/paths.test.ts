import { describe, expect, test } from "bun:test";
import { chooseSocketPath, maxSocketBytes, type SocketEnv } from "../../src/shared/paths.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const LONG = "/tmp/tabcap-test/a-deliberately-long-home-directory-that-pushes-the-daemon-socket-path-past-the-unix-limit/home/config";

const env = (o: Partial<SocketEnv>): SocketEnv => ({
  configDir: "/Users/me/.config/tabcap",
  platform: "darwin",
  uid: 501,
  darwinTemp: () => "/var/folders/z2/c3rbwqj506n5lxs0w93gj0w40000gn/T",
  xdgRuntime: null,
  runUserExists: () => false,
  ...o,
});

describe("daemon socket path chooser", () => {
  test("short config dir: socket stays in config/", () => {
    expect(chooseSocketPath(env({}))).toEqual({ path: "/Users/me/.config/tabcap/daemon.sock", fallback: false });
  });

  test("long TABCAP_HOME on macOS: per-user temp dir, uid + hash of the config dir", () => {
    const r = chooseSocketPath(env({ configDir: LONG }));
    expect(r.fallback).toBe(true);
    expect(r.path).toMatch(/^\/var\/folders\/z2\/c3rbwqj506n5lxs0w93gj0w40000gn\/T\/tabcap-501-[0-9a-f]{8}\.sock$/);
    expect(Buffer.byteLength(r.path)).toBeLessThanOrEqual(maxSocketBytes("darwin"));
    // deterministic, and different homes do not collide
    expect(chooseSocketPath(env({ configDir: LONG })).path).toBe(r.path);
    expect(chooseSocketPath(env({ configDir: LONG + "2" })).path).not.toBe(r.path);
  });

  test("macOS without a usable temp dir falls back to a private /tmp dir", () => {
    expect(chooseSocketPath(env({ configDir: LONG, darwinTemp: () => null })).path).toMatch(/^\/tmp\/tabcap-501\/tabcap-501-[0-9a-f]{8}\.sock$/);
  });

  test("Linux: XDG_RUNTIME_DIR, then /run/user/<uid>, then /tmp", () => {
    const linux = { platform: "linux" as const, configDir: LONG };
    expect(chooseSocketPath(env({ ...linux, xdgRuntime: "/run/user/1000" })).path).toMatch(/^\/run\/user\/1000\/tabcap-501-/);
    expect(chooseSocketPath(env({ ...linux, runUserExists: (d) => d === "/run/user/501" })).path).toMatch(/^\/run\/user\/501\/tabcap-501-/);
    expect(chooseSocketPath(env({ ...linux })).path).toMatch(/^\/tmp\/tabcap-501\/tabcap-501-/);
  });

  test("limits count bytes, not characters (non-ASCII home)", () => {
    const dir = "/Users/" + "用".repeat(28) + "/.config/tabcap"; // 7+84+12 bytes > 103 with /daemon.sock
    expect(dir.length + "/daemon.sock".length).toBeLessThanOrEqual(103);
    expect(chooseSocketPath(env({ configDir: dir })).fallback).toBe(true);
    expect(maxSocketBytes("linux")).toBe(107);
  });
});

describe("environment names (0.3: TABCAP_* only)", () => {
  test("TABCAP_* is read; the 0.2.x BBL_* fallback is gone", async () => {
    const { envVar } = await import("../../src/shared/env.ts");
    expect(envVar("HOME", { TABCAP_HOME: "/a", BBL_HOME: "/b" })).toBe("/a");
    expect(envVar("HOME", { BBL_HOME: "/b" })).toBeUndefined();
    expect(envVar("HOME", {})).toBeUndefined();
    const { paths } = await import("../../src/shared/paths.ts");
    expect(paths({ BBL_HOME: "/tmp/legacy-home" }).config).toBe(join(homedir(), ".config", "tabcap"));
    expect(paths({ TABCAP_HOME: "/tmp/new-home", BBL_HOME: "/tmp/legacy-home" }).config).toBe("/tmp/new-home/config");
  });
  test("default directories use the tabcap name", async () => {
    const { paths } = await import("../../src/shared/paths.ts");
    const p = paths({});
    expect(p.config.endsWith("/.config/tabcap")).toBe(true);
    expect(p.cache.endsWith("/.cache/tabcap")).toBe(true);
    expect(p.data.endsWith("/.local/share/tabcap")).toBe(true);
  });
});
