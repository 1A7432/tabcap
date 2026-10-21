// CLI ↔ daemon version handshake (owner 10-21, docs/07 §1): the CLI's POST
// /command body carries its version; a daemon of another version refuses with
// `daemon-version` naming both and the restart command that `tabcap update`
// gives after an install (src/cli/update.ts installedNext). `daemon start`
// against a running daemon of another version says the same. A body without a
// version (POST /fetch, scripts) is not checked, and `daemon.shutdown` never
// is (that is how the restart works). The daemon side runs handleCommand
// directly; the CLI side talks to a Bun.serve stand-in on loopback TCP (the
// daemon.json shape of the Windows listener, which every platform can serve).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";
import { send, startDaemon } from "../../src/cli/client.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths, type Paths } from "../../src/shared/paths.ts";

const RESTART = "`tabcap daemon stop && tabcap daemon start`";
const OLD = "0.0.1";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) void s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-ver-"));
  roots.push(d);
  return d;
};

describe("daemon side (handleCommand)", () => {
  const daemon = () => new Daemon(paths({ TABCAP_HOME: tmp() }));
  const run = (d: Daemon, body: Record<string, unknown>) => handleCommand(d, body, () => undefined);

  test("another version: daemon-version naming both versions, next is the restart command; nothing runs", async () => {
    const d = daemon();
    const env = await run(d, { action: "session.list", args: {}, session: "a", version: OLD });
    expect(env.ok).toBe(false);
    const e: Record<string, unknown> = env.ok ? {} : env.error;
    expect(e["code"]).toBe("daemon-version");
    expect(String(e["message"])).toContain(TOOL_VERSION);
    expect(String(e["message"])).toContain(OLD);
    expect(String(e["next"])).toContain(RESTART);
    expect(e).toMatchObject({ daemonVersion: TOOL_VERSION, cliVersion: OLD });
  });

  test("the same version, or none (POST /fetch, scripts): answered as before", async () => {
    const d = daemon();
    expect((await run(d, { action: "session.list", args: {}, session: "a", version: TOOL_VERSION })).ok).toBe(true);
    expect((await run(d, { action: "session.list", args: {}, session: "a" })).ok).toBe(true);
  });

  test("daemon.shutdown is never refused (the restart needs it)", async () => {
    const d = daemon();
    const env = await run(d, { action: "daemon.shutdown", version: OLD });
    expect(env.ok).toBe(true);
  });
});

/** A stand-in daemon on loopback TCP that records the bodies and answers /status with `version`. */
function fakeDaemon(version: string): { p: Paths; bodies: unknown[] } {
  const home = tmp();
  const p: Paths = { ...paths({ TABCAP_HOME: home }), listener: "tcp" };
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  const token = "ab".repeat(32);
  const bodies: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ ok: false, error: { code: "usage", message: "token", next: "" } });
      if (new URL(req.url).pathname === "/status") return Response.json({ ok: true, data: { running: true, pid: 4242, version } });
      bodies.push(await req.json());
      return Response.json({ ok: true, data: {} });
    },
  });
  servers.push(server);
  writeFileSync(p.daemonInfo, JSON.stringify({ listener: "tcp", port: server.port, token }));
  return { p, bodies };
}

describe("CLI side (client.ts)", () => {
  test("every /command body carries the CLI's version", async () => {
    const { p, bodies } = fakeDaemon(TOOL_VERSION);
    expect((await send(p, "session.list", {}, "a", ["session", "list"], 2000)).ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(isRecord(bodies[0]) ? bodies[0]["version"] : null).toBe(TOOL_VERSION);
  });

  test("daemon start against a running daemon of another version: next is the restart command", async () => {
    const { p } = fakeDaemon(OLD);
    const r = await startDaemon(p);
    expect(r).toMatchObject({ started: false, alreadyRunning: true, version: OLD });
    const next = isRecord(r) ? String(r["next"]) : "";
    expect(next).toContain(RESTART);
    expect(next).toContain(OLD);
    expect(next).toContain(TOOL_VERSION);
  });

  test("daemon start against a running daemon of this version: no next", async () => {
    const { p } = fakeDaemon(TOOL_VERSION);
    const r = await startDaemon(p);
    expect(r).toMatchObject({ started: false, alreadyRunning: true, version: TOOL_VERSION });
    expect(isRecord(r) && "next" in r).toBe(false);
  });
});
