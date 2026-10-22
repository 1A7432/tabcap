import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, helpAll, helpFor, matchCommand, parseCommand, usageOf } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
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
  test("tabcap --help is the index (0.5-C): every user command on one line; examples are in `tabcap help <command>`", () => {
    const text = helpAll();
    for (const c of COMMANDS.filter((x) => x.internal !== true)) {
      expect(text).toContain(`\n  ${c.path.join(" ")}  `);
      expect(helpFor(c)).toContain(`Example: ${c.example}`);
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
    expect(parseCommand(spec(["fill"]), ["e3", "hello", "world", "--trusted", "--session", "s1"])).toEqual({ args: { ref: "e3", text: "hello world", trusted: true }, session: "s1", help: false, given: new Set(["--trusted", "--session"]) });
    expect(parseCommand(spec(["evaluate"]), ["--await", "--", "--x"]).args).toEqual({ await: true, expression: "--x" });
    expect(parseCommand(spec(["snapshot"]), ["--max-chars=500", "--timeout", "9000"]).args).toEqual({ maxChars: 500, timeoutMs: 9000 });
    expect(spec(["net", "body"]).action).toBe("net.body");
  });
  // The owner's rule of 2026-10-22: before `--`, a one-dash word the spec does not declare is an unknown option;
  // `-` alone and negative numbers stay positional. Expected values: that rule as written in the brief.
  test("one-dash words: a declared spelling is an option, -1 is positional, any other is an unknown option before --", async () => {
    const thrown = (c: ReturnType<typeof spec>, argv: string[]): { code: string; message: string; next: string } => {
      try {
        parseCommand(c, argv);
      } catch (e) {
        if (e instanceof TabcapError) return { code: e.code, message: e.message, next: e.next };
        throw e;
      }
      throw new Error(`no error for ${argv.join(" ")}`);
    };
    const hint = '. An argument that starts with "-" goes after `--`.';
    const session = spec(["replay", "session"]);
    expect(parseCommand(session, ["./b", "-o", "s.json"]).args).toEqual({ bundle: "./b", out: "s.json" });
    expect(parseCommand(session, ["./b", "-o=s.json"]).args).toEqual({ bundle: "./b", out: "s.json" });
    expect(thrown(session, ["./b", "-o", "s.json", "-q"])).toEqual({ code: "usage", message: "unknown option -q", next: `Usage: ${usageOf(session)}${hint}` });
    expect(parseCommand(spec(["evaluate"]), ["-1"]).args).toEqual({ expression: "-1" });
    expect(parseCommand(spec(["evaluate"]), ["--", "-q"]).args).toEqual({ expression: "-q" });
    // a quiet command (a stray word may be a password) does not echo the word, and its next adds that a password
    // is never an argument (after `--` it would be "unexpected argument #2")
    const siteAdd = spec(["site", "add"]);
    const quiet = thrown(siteAdd, ["example", "-hunter2"]);
    expect(quiet).toEqual({
      code: "usage",
      message: "unknown option (value not shown)",
      next: `Usage: ${usageOf(siteAdd)}. An argument that starts with "-" goes after \`--\`; a password is never an argument: type it at the prompt or pipe it with --password-stdin.`,
    });
    expect(quiet.next).not.toContain("hunter2");
    expect(thrown(siteAdd, ["example", "-=hunter2"]).message).toBe("unknown option (value not shown)");
    const r = await run(["evaluate", "-q"]);
    expect(r.code).toBe(2);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage", message: "unknown option -q" } });
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
