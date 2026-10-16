import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, helpAll, helpFor, matchCommand, parseCommand } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const home = mkdtempSync(join(tmpdir(), "tabcap-cli-"));
const prevHome = process.env["TABCAP_HOME"];
process.env["TABCAP_HOME"] = home;
afterAll(() => {
  if (prevHome === undefined) delete process.env["TABCAP_HOME"];
  else process.env["TABCAP_HOME"] = prevHome;
  rmSync(home, { recursive: true, force: true });
}, SLOW_IO_MS);

describe("help", () => {
  test("tabcap --help lists every command with an example", () => {
    const text = helpAll();
    for (const c of COMMANDS) {
      expect(text).toContain(c.path.join(" "));
      expect(text).toContain(`e.g. ${c.example}`);
    }
    expect(text).not.toContain("Deprecated");
    expect(text).toContain("bundle");
  });
  test("tabcap <cmd> --help prints usage, example and options, exit 0", async () => {
    const r = await run(["net", "list", "--help"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("Usage: tabcap net list");
    expect(r.text).toContain("Example: tabcap net list --resource-types xhr,fetch");
    expect(r.text).not.toContain("deprecated");
    expect(r.text).toContain("--filter");
    const c = matchCommand(["click"]);
    if (c === null) throw new Error("no click");
    expect(helpFor(c)).toContain("--trusted");
  });
});

describe("argument parsing", () => {
  const spec = (words: string[]) => {
    const c = matchCommand(words);
    if (c === null) throw new Error(words.join(" "));
    return c;
  };
  test("positionals, joined rest, flags, session, --", () => {
    expect(parseCommand(spec(["fill"]), ["e3", "hello", "world", "--trusted", "--session", "s1"])).toEqual({ args: { ref: "e3", text: "hello world", trusted: true }, session: "s1", help: false });
    expect(parseCommand(spec(["evaluate"]), ["--await", "--", "--x"]).args).toEqual({ await: true, expression: "--x" });
    expect(parseCommand(spec(["snapshot"]), ["--max-chars=500", "--timeout", "9000"]).args).toEqual({ maxChars: 500, timeoutMs: 9000 });
    expect(spec(["net", "body"]).action).toBe("net.body");
  });
  test("usage errors carry next and exit 2", async () => {
    for (const argv of [["click"], ["snapshot", "--bogus"], ["snapshot", "--max-chars", "x"], ["tab", "list", "extra"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      if (r.envelope.ok) throw new Error("expected failure");
      expect(r.envelope.error.code).toBe("usage");
      expect(r.envelope.error.next).toContain("Usage: tabcap");
    }
  });
});

describe("no daemon", () => {
  test("browser commands fail with not-running and say what to do", async () => {
    const r = await run(["tab", "list"]);
    expect(r.code).toBe(1);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "not-running" } });
    if (r.envelope.ok) throw new Error("expected failure");
    expect(r.envelope.error.next).toContain("tabcap daemon start");
  });
  test("daemon status reports not running (ok envelope)", async () => {
    const r = await run(["daemon", "status"]);
    expect(r.code).toBe(0);
    // Windows has no Unix socket: the daemon listens on loopback TCP (src/daemon/listener.ts).
    const where = process.platform === "win32" ? { listener: "tcp", socket: null } : { listener: "unix", socket: join(home, "config", "daemon.sock") };
    expect(r.envelope).toMatchObject({ ok: true, data: { running: false, ...where } });
  });
});
