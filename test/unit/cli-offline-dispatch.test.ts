// `tabcap analyze …` / `tabcap replay …` dispatched by runCommand like every
// other command (review wave 3, item 2): analyze.ts and replay.ts no longer
// take argv before the registry, build their own --help or usage lists, or
// parse with split(); their help and usage come from the registry.
// Oracle: the old dispatchers' answers for the same argv, recorded from the
// source at 2bc578f (runAnalyze / runReplay) with a harness that ran
// `run(argv)` on a copy of fixtures/bundles/sample-v0 under an empty
// TABCAP_HOME. Same answer: the old value. A line with `old:` differs; the new
// answer follows the registry rule (parseCommand; an unknown command names the
// closest commands; a bare group word is an unknown command, as `tabcap net`).
// Reproduce: bun test test/unit/cli-offline-dispatch.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as analyzeModule from "../../src/cli/analyze.ts";
import * as replayModule from "../../src/cli/replay.ts";
import { COMMANDS, helpFor, specOf, usageOf } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { SAMPLE_FIXTURE_DIR } from "./_fixtures.ts";

let T = "";
let prevHome: string | undefined;

beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), "tabcap-offline-dispatch-"));
  prevHome = process.env["TABCAP_HOME"];
  process.env["TABCAP_HOME"] = join(T, "home");
  mkdirSync(join(T, "home"), { recursive: true });
  cpSync(SAMPLE_FIXTURE_DIR, join(T, "b"), { recursive: true });
});

afterAll(() => {
  if (prevHome === undefined) delete process.env["TABCAP_HOME"];
  else process.env["TABCAP_HOME"] = prevHome;
  rmSync(T, { recursive: true, force: true });
});

const U = (path: string): string => `Usage: ${usageOf(specOf(path))}`;
const NEAR = (cmds: string): string => `Did you mean: ${cmds}? \`tabcap --help\` lists the command groups; \`tabcap help <command>\` shows one command.`;
const ANALYZE_NEAR = NEAR("tabcap analyze find | tabcap analyze diff | tabcap analyze deps");
const REPLAY_NEAR = NEAR("tabcap replay serve | tabcap replay check | tabcap replay session");

type Want = { code: number; error?: { code: string; message: string; next?: string }; data?: Record<string, unknown>; text?: string };

const CASES: Array<[string[], Want]> = [
  // analyze
  // old: ok, a hand-made list "Analysis over bundles (no daemon needed):" with exit 0
  [["analyze"], { code: 2, error: { code: "usage", message: "unknown command: analyze", next: ANALYZE_NEAR } }],
  // old next: "Available: " and every analyze usage line joined
  [["analyze", "foo"], { code: 2, error: { code: "usage", message: "unknown command: analyze foo", next: ANALYZE_NEAR } }],
  // old: "expected <bundle> <text>"
  [["analyze", "find"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("analyze find") } }],
  // old: "expected <bundle> <text>"
  [["analyze", "find", "<B>"], { code: 2, error: { code: "usage", message: "missing <text>", next: U("analyze find") } }],
  [["analyze", "find", "<B>", "Order", "placed"], { code: 0, data: { query: { text: "Order placed", ignoreCase: false, normalized: "Order placed" } } }],
  // old: "unknown option --ignore-case=1"
  [["analyze", "find", "<B>", "x", "--ignore-case=1"], { code: 2, error: { code: "usage", message: "--ignore-case takes no value", next: U("analyze find") } }],
  [["analyze", "find", "<B>", "x", "--bogus"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("analyze find") } }],
  // old: the analyze usage list (a --help after `--` was still taken as help); now the text searched for
  [["analyze", "find", "<B>", "--", "--help"], { code: 0, data: { query: { text: "--help", ignoreCase: false, normalized: "--help" } } }],
  [["analyze", "find", "<B>", "-x"], { code: 0, data: { query: { text: "-x", ignoreCase: false, normalized: "-x" } } }],
  [["analyze", "find", "<B>", "Order", "--ignore-case", "--text"], { code: 0, data: { query: { text: "Order", ignoreCase: true, normalized: "Order" } }, text: 'find "Order" in <B> [ignore-case]' }],
  [["analyze", "find", "<B>", "Order", "--", "--text"], { code: 0, data: { query: { text: "Order --text", ignoreCase: false, normalized: "Order --text" } } }],
  // old: "expected at least two bundles, got 1"
  [["analyze", "diff", "<B>"], { code: 2, error: { code: "usage", message: "missing <bundle2>", next: U("analyze diff") } }],
  [["analyze", "diff", "<B>", "<B>"], { code: 0, data: { sessions: 1 } }],
  [["analyze", "diff", "<B>", "<B>", "<B>", "--text"], { code: 0, data: { sessions: 1 }, text: "diff of 3 bundles, 1 session(s)" }],
  // old: "expected at least two bundles, got 0"
  [["analyze", "diff"], { code: 2, error: { code: "usage", message: "missing <bundle1>", next: U("analyze diff") } }],
  // old: "unknown option --reveal=1"
  [["analyze", "diff", "<B>", "<B>", "--reveal=1"], { code: 2, error: { code: "usage", message: "--reveal takes no value", next: U("analyze diff") } }],
  [["analyze", "deps", "<B>", "--bogus"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("analyze deps") } }],
  [["analyze", "deps"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("analyze deps") } }],
  [["analyze", "deps", "<B>", "--request"], { code: 2, error: { code: "usage", message: "--request needs a value", next: U("analyze deps") } }],
  [["analyze", "chain", "<B>", "extra"], { code: 2, error: { code: "usage", message: "unexpected argument: extra", next: U("analyze chain") } }],
  [["analyze", "shape", "<B>", "--types", "all"], { code: 0, data: { schema: "tabcap-shape/0" } }],
  [["analyze", "schema-diff", "<B>", "<B>"], { code: 0, data: { schema: "tabcap-schema-diff/0", drift: false } }],
  [["analyze", "schema-diff", "<B>"], { code: 2, error: { code: "usage", message: "missing <new>", next: U("analyze schema-diff") } }],
  [["analyze", "recon", "<B>", "--text"], { code: 0, text: "# Recon dossier" }],
  // replay
  // old: ok, the replay group's help with exit 0
  [["replay"], { code: 2, error: { code: "usage", message: "unknown command: replay", next: REPLAY_NEAR } }],
  // old next: "Available: " and every replay usage line joined
  [["replay", "foo"], { code: 2, error: { code: "usage", message: "unknown command: replay foo", next: REPLAY_NEAR } }],
  // old: "unknown option --out" (every -o was rewritten to --out, also for serve, which has none)
  [["replay", "serve", "<B>", "-o", "x"], { code: 2, error: { code: "usage", message: "unexpected argument: -o", next: U("replay serve") } }],
  // old: "--out needs a value" (the rewritten spelling)
  [["replay", "session", "<B>", "-o"], { code: 2, error: { code: "usage", message: "-o needs a value", next: U("replay session") } }],
  [["replay", "session", "<B>"], { code: 2, error: { code: "usage", message: "missing -o <file>", next: U("replay session") } }],
  // old: "unexpected argument: -o=<T>/ss.json" (-o=v was not read; --out=v was); now as -o <T>/ss.json
  [["replay", "session", "<B>", "-o=<T>/ss.json"], { code: 1, error: { code: "not-found", message: "the bundle has no cookie snapshot (no `state` event with what=cookies)" } }],
  [["replay", "session", "<B>", "-o", "<T>/ss2.json"], { code: 1, error: { code: "not-found", message: "the bundle has no cookie snapshot (no `state` event with what=cookies)" } }],
  [["replay", "session", "<B>", "--", "-o", "<T>/ss3.json"], { code: 2, error: { code: "usage", message: "unexpected argument: -o", next: U("replay session") } }],
  [["replay", "export-python", "<B>"], { code: 2, error: { code: "usage", message: "missing -o <dir>", next: U("replay export-python") } }],
  [["replay", "check", "<B>", "--rate", "x"], { code: 2, error: { code: "usage", message: "--rate must be a number", next: U("replay check") } }],
  [["replay", "check"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("replay check") } }],
  [["replay", "session", "--site"], { code: 2, error: { code: "usage", message: "--site needs a value", next: U("replay session") } }],
  [["replay", "serve", "<B>", "--port", "99999", "--once", "1"], { code: 2, error: { code: "usage", message: "bad --port 99999", next: "Pass 0-65535 (0 = any free port)." } }],
];

const fill = (a: string): string => a.replace("<B>", join(T, "b")).replace("<T>", T);
const norm = (s: string): string => s.split(join(T, "b")).join("<B>").split(T).join("<T>");

describe("analyze / replay through runCommand (oracle: the old dispatchers' answers)", () => {
  for (const [argv, want] of CASES) {
    test(argv.join(" "), async () => {
      const r = await run(argv.map(fill));
      const got: Want = { code: r.code };
      if (r.envelope.ok) {
        const d = r.envelope.data;
        if (want.data !== undefined && isRecord(d)) got.data = Object.fromEntries(Object.keys(want.data).map((k) => [k, d[k]]));
      } else {
        const e = r.envelope.error;
        got.error = { code: e.code, message: norm(e.message), ...(want.error?.next === undefined ? {} : { next: norm(e.next) }) };
      }
      if (want.text !== undefined) got.text = norm(r.text ?? "").split("\n")[0] ?? "";
      expect(got).toEqual(want);
    });
  }

  test("every analyze / replay subcommand's --help is the registry's help for it", async () => {
    for (const c of COMMANDS.filter((x) => x.path[0] === "analyze" || x.path[0] === "replay")) {
      const r = await run([...c.path, fill("<B>"), "--help"]);
      expect([c.path.join(" "), r.code, r.text]).toEqual([c.path.join(" "), 0, helpFor(c)]);
    }
  });

  test("analyze.ts and replay.ts no longer dispatch argv or build usage text", () => {
    const own = (m: object): string[] => Object.keys(m).filter((k) => /usage|^run[A-Z]/i.test(k));
    expect(own(analyzeModule)).toEqual([]);
    expect(own(replayModule)).toEqual([]);
  });
});
