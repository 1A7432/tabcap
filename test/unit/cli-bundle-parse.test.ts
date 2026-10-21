// `tabcap bundle …` parsed by the command registry (review wave 3, item 1):
// the hand-written parseArgs / checkFlags in src/cli/main.ts are gone and
// every bundle subcommand goes through parseCommand like the rest.
// Oracle: the old parser's answers for the same argv, recorded from the source
// at 2bc578f (src/cli/main.ts runBundle) with a harness that ran `run(argv)`
// on a copy of fixtures/bundles/sample-v0 under an empty TABCAP_HOME. Where the
// answer is the same, the expected value below is the old one. Where it
// differs, the line says `old:` and the new answer follows the registry rule
// (parseCommand): positionals are counted against the spec (`missing <x>`,
// `unexpected argument: x`), a bool flag takes no `=value`, `--` ends options,
// a word starting with "-" is positional unless the spec declares that
// spelling (`-o` of import har), and a usage error's next is the command's
// own usage line.
// Reproduce: bun test test/unit/cli-bundle-parse.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/main.ts";
import { specOf, unknownCommandName, usageOf } from "../../src/cli/commands.ts";
import { isRecord } from "../../src/shared/json.ts";
import { SAMPLE_FIXTURE_DIR } from "./_fixtures.ts";

let T = "";
let prevHome: string | undefined;

beforeAll(async () => {
  T = mkdtempSync(join(tmpdir(), "tabcap-bundle-parse-"));
  prevHome = process.env["TABCAP_HOME"];
  process.env["TABCAP_HOME"] = join(T, "home");
  mkdirSync(join(T, "home"), { recursive: true });
  cpSync(SAMPLE_FIXTURE_DIR, join(T, "b"), { recursive: true });
  const har = await run(["bundle", "export", "har", join(T, "b"), "--out", join(T, "s.har"), "--no-redact", "--embed-events"]);
  expect(har.code).toBe(0);
});

afterAll(() => {
  if (prevHome === undefined) delete process.env["TABCAP_HOME"];
  else process.env["TABCAP_HOME"] = prevHome;
  rmSync(T, { recursive: true, force: true });
});

const U = (path: string): string => `Usage: ${usageOf(specOf(path))}`;
const NEAR = (cmds: string): string => `Did you mean: ${cmds}? \`tabcap --help\` lists the command groups; \`tabcap help <command>\` shows one command.`;

type Want = { code: number; error?: { code: string; message: string; next?: string }; data?: Record<string, unknown>; text?: string };

/** argv with <B> (bundle copy), <H> (HAR of it) and <T> (scratch dir) placeholders; what the CLI answers. */
const CASES: Array<[string[], Want]> = [
  // bundle info
  [["bundle", "info", "<B>"], { code: 0, data: { events: 8, complete: true } }],
  // old: "expected 1 argument(s), got 0"
  [["bundle", "info"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("bundle info") } }],
  // old: "expected 1 argument(s), got 2"
  [["bundle", "info", "<B>", "extra"], { code: 2, error: { code: "usage", message: "unexpected argument: extra", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--bogus"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--bogus=1"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--bogus", "v"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--usage"], { code: 0, data: { schema: "tabcap-usage/0" } }],
  [["bundle", "info", "<B>", "--usage", "--text"], { code: 0, data: { schema: "tabcap-usage/0" }, text: "usage <B>" }],
  [["bundle", "info", "<B>", "--text"], { code: 2, error: { code: "usage", message: "--text, --business-code, --actor and --all-hosts belong to --usage", next: U("bundle info") } }],
  // old: ok, the plain summary (the value turned --usage off without a word)
  [["bundle", "info", "<B>", "--usage=1"], { code: 2, error: { code: "usage", message: "--usage takes no value", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--usage", "--business-code", "$.code=0", "--business-code", "$.ok=true"], { code: 0, data: { schema: "tabcap-usage/0", businessRules: ["$.code=0", "$.ok=true"] } }],
  // old next: every bundle usage line joined with " | "
  [["bundle", "info", "<B>", "--usage", "--business-code"], { code: 2, error: { code: "usage", message: "--business-code needs a value", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--usage", "--business-code=$.code=0"], { code: 0, data: { schema: "tabcap-usage/0", businessRules: ["$.code=0"] } }],
  // old: "unknown option --" (`--` did not end the options)
  [["bundle", "info", "--", "<B>"], { code: 0, data: { events: 8 } }],
  // old: "unknown option -x"
  [["bundle", "info", "<B>", "-x"], { code: 2, error: { code: "usage", message: "unexpected argument: -x", next: U("bundle info") } }],
  // old: usage error "unknown option -x"; now the bundle directory "-x", which does not exist
  [["bundle", "info", "-x"], { code: 1, error: { code: "not-found", message: "bundle directory not found: -x" } }],
  [["bundle", "info", "<B>", "--actor", "page"], { code: 2, error: { code: "usage", message: "--text, --business-code, --actor and --all-hosts belong to --usage", next: U("bundle info") } }],
  [["bundle", "info", "<B>", "--usage", "--actor", "bogus"], { code: 2, error: { code: "usage", message: 'bad --actor "bogus"', next: "Use one of: page, fetch, evaluate, other." } }],
  [["bundle", "info", "<B>", "--usage", "--actor=fetch", "--all-hosts"], { code: 0, data: { schema: "tabcap-usage/0" } }],
  // old: "expected 1 argument(s), got 2"
  [["bundle", "info", "<B>", "-"], { code: 2, error: { code: "usage", message: "unexpected argument: -", next: U("bundle info") } }],
  // old: "--business-code needs a value" (the whole argv was read before the unknown option was named)
  [["bundle", "info", "<B>", "--bogus", "--usage", "--business-code"], { code: 2, error: { code: "usage", message: "unknown option --bogus", next: U("bundle info") } }],
  // bundle export har
  [["bundle", "export", "har", "<B>", "--out", "<T>/x.har"], { code: 0, data: { redacted: true, entries: 3, complete: true } }],
  [["bundle", "export", "har", "<B>", "--out", "<T>/x2.har", "--no-redact"], { code: 0, data: { redacted: false, entries: 3 } }],
  // old: ok and redacted (the value turned --no-redact off without a word)
  [["bundle", "export", "har", "<B>", "--out", "<T>/x3.har", "--no-redact=1"], { code: 2, error: { code: "usage", message: "--no-redact takes no value", next: U("bundle export har") } }],
  // old next: every bundle usage line joined
  [["bundle", "export", "har", "<B>", "--out"], { code: 2, error: { code: "usage", message: "--out needs a value", next: U("bundle export har") } }],
  [["bundle", "export", "har", "<B>", "--out=<T>/x4.har"], { code: 0, data: { redacted: true, entries: 3 } }],
  // old: "expected 1 argument(s), got 0"
  [["bundle", "export", "har"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("bundle export har") } }],
  [["bundle", "export", "har", "<B>", "--types", "xhr", "--tab", "t1", "--embed-events", "--out", "<T>/x5.har"], { code: 0, data: { redacted: true, entries: 2 } }],
  [["bundle", "export", "har", "<B>", "--rules", "<T>/no-such-rules.json", "--out", "<T>/x6.har"], { code: 1, error: { code: "not-found", message: "rules file not found: <T>/no-such-rules.json" } }],
  // old: ok, without the events (the value turned --embed-events off without a word)
  [["bundle", "export", "har", "<B>", "--embed-events=yes", "--out", "<T>/x7.har"], { code: 2, error: { code: "usage", message: "--embed-events takes no value", next: U("bundle export har") } }],
  // old: "unknown option -o" (export har declares no -o)
  [["bundle", "export", "har", "<B>", "-o", "<T>/x8.har"], { code: 2, error: { code: "usage", message: "unexpected argument: -o", next: U("bundle export har") } }],
  // bundle import har
  [["bundle", "import", "har", "<H>", "-o", "<T>/imp1"], { code: 0, data: { events: 8, restoredFromEvents: true } }],
  [["bundle", "import", "har", "<H>", "--out", "<T>/imp2"], { code: 0, data: { events: 8, restoredFromEvents: true } }],
  [["bundle", "import", "har", "<H>", "-o=<T>/imp3"], { code: 0, data: { events: 8, restoredFromEvents: true } }],
  [["bundle", "import", "har", "<H>"], { code: 2, error: { code: "usage", message: "missing -o <bundle>", next: U("bundle import har") } }],
  // old: "expected 1 argument(s), got 0"
  [["bundle", "import", "har", "-o", "<T>/imp4"], { code: 2, error: { code: "usage", message: "missing <file>", next: U("bundle import har") } }],
  // old next: every bundle usage line joined
  [["bundle", "import", "har", "<H>", "-o"], { code: 2, error: { code: "usage", message: "-o needs a value", next: U("bundle import har") } }],
  [["bundle", "import", "har", "<T>/no-such.har", "-o", "<T>/imp5"], { code: 1, error: { code: "not-found", message: "HAR file not found: <T>/no-such.har", next: "Check the path of the .har file." } }],
  // old: "expected 1 argument(s), got 2"
  [["bundle", "import", "har", "<H>", "<T>/imp6", "-o", "<T>/imp7"], { code: 2, error: { code: "usage", message: "unexpected argument: <T>/imp6", next: U("bundle import har") } }],
  // bundle redact
  [["bundle", "redact", "<B>", "<T>/red1"], { code: 0, data: { events: 8 } }],
  // old: "expected 2 argument(s), got 1"
  [["bundle", "redact", "<B>"], { code: 2, error: { code: "usage", message: "missing <out>", next: U("bundle redact") } }],
  [["bundle", "redact", "<B>", "<T>/red2", "--text"], { code: 2, error: { code: "usage", message: "unknown option --text", next: U("bundle redact") } }],
  // old: "expected 2 argument(s), got 3"
  [["bundle", "redact", "<B>", "<T>/red3", "extra"], { code: 2, error: { code: "usage", message: "unexpected argument: extra", next: U("bundle redact") } }],
  // bundle decode
  [["bundle", "decode", "<B>"], { code: 1, error: { code: "not-found", message: "no enabled decode plugin" } }],
  [["bundle", "decode", "<B>", "--plugin", "nope"], { code: 1, error: { code: "not-found", message: 'no plugin named "nope" in <T>/home/config/plugins' } }],
  // old next: every bundle usage line joined
  [["bundle", "decode", "<B>", "--plugin"], { code: 2, error: { code: "usage", message: "--plugin needs a value", next: U("bundle decode") } }],
  // old: "expected 1 argument(s), got 0"
  [["bundle", "decode"], { code: 2, error: { code: "usage", message: "missing <bundle>", next: U("bundle decode") } }],
  // bundle export fixtures
  [["bundle", "export", "fixtures", "<B>", "--out", "<T>/fx1"], { code: 0, data: { redacted: true, format: "json" } }],
  [["bundle", "export", "fixtures", "<B>"], { code: 2, error: { code: "usage", message: "missing --out <dir>", next: U("bundle export fixtures") } }],
  [["bundle", "export", "fixtures", "<B>", "--out", "<T>/fx2", "--format", "nope"], { code: 1, error: { code: "not-found", message: 'no plugin named "nope" in <T>/home/config/plugins' } }],
  [["bundle", "export", "fixtures", "<B>", "--out", "<T>/fx3", "--include-preflight", "--no-redact", "--format=json"], { code: 0, data: { redacted: false, format: "json" } }],
  // old: ok and redacted (the value turned --no-redact off without a word)
  [["bundle", "export", "fixtures", "<B>", "--out", "<T>/fx4", "--no-redact=0"], { code: 2, error: { code: "usage", message: "--no-redact takes no value", next: U("bundle export fixtures") } }],
  // the group, unknown subcommands, help
  [["bundle"], { code: 2, error: { code: "usage", message: "unknown command: bundle", next: NEAR("tabcap bundle info | tabcap bundle list | tabcap bundle prune") } }],
  [["bundle", "foo"], { code: 2, error: { code: "usage", message: "unknown command: bundle foo", next: NEAR("tabcap bundle info | tabcap bundle list | tabcap bundle prune") } }],
  [["bundle", "export", "foo"], { code: 2, error: { code: "usage", message: "unknown command: bundle export foo", next: NEAR("tabcap bundle export har | tabcap bundle import har | tabcap bundle redact") } }],
  [["bundle", "export"], { code: 2, error: { code: "usage", message: "unknown command: bundle export", next: NEAR("tabcap bundle export har | tabcap bundle redact | tabcap bundle info") } }],
  // old: "unknown command: bundle inf <B>" (the bundle path was echoed as a command word)
  [["bundle", "inf", "<B>"], { code: 2, error: { code: "usage", message: "unknown command: bundle inf", next: NEAR("tabcap bundle info | tabcap bundle list | tabcap bundle prune") } }],
  [["bundle", "info", "<B>", "--help"], { code: 0, text: "Usage: tabcap bundle info <bundle> [--usage] [--text] [--business-code $.path=ok]... [--actor page|fetch|evaluate|other] [--all-hosts]" }],
  // old: the old bundle usage list (a --help after `--` was still taken as help)
  [["bundle", "info", "<B>", "--", "--help"], { code: 2, error: { code: "usage", message: "unexpected argument: --help", next: U("bundle info") } }],
  [["bundle", "list", "--limit", "x"], { code: 2, error: { code: "usage", message: "--limit must be a number", next: U("bundle list") } }],
  [["bundle", "prune"], { code: 2, error: { code: "usage", message: "give exactly one of --keep and --older-than", next: "Usage: tabcap bundle prune (--keep N | --older-than <30d>) [--site s] [--dry-run] [--yes]" } }],
  [["bundle", "list", "--text"], { code: 0, data: { bundles: [] }, text: "no recordings in the store's bundle index" }],
];

const fill = (a: string): string => a.replace("<B>", join(T, "b")).replace("<H>", join(T, "s.har")).replace("<T>", T);
// Paths inside messages are native (backslashes on Windows): the placeholders and the rest of a path read with "/".
const norm = (s: string): string =>
  s.split(join(T, "b")).join("<B>").split(join(T, "s.har")).join("<H>").split(T).join("<T>").replace(/<([BHT])>((?:\\[^\s"'`]+)+)/g, (_m, tag: string, rest: string) => `<${tag}>${rest.replaceAll("\\", "/")}`);

describe("bundle commands through parseCommand (oracle: the old parser's answers)", () => {
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
});

describe("the words that name an unknown command: those that start a command path, plus one, at least two", () => {
  test("a value after them is not echoed; a three-word group keeps its third word", () => {
    expect(unknownCommandName(["net", "foo", "bar"])).toBe("net foo");
    expect(unknownCommandName(["foo", "bar", "baz"])).toBe("foo bar");
    expect(unknownCommandName(["bundle"])).toBe("bundle");
    expect(unknownCommandName(["bundle", "export", "foo", "x"])).toBe("bundle export foo");
    expect(unknownCommandName(["bundle", "inf", "/some/bundle"])).toBe("bundle inf");
    // old: always the first two words ("fingerprint ref")
    expect(unknownCommandName(["fingerprint", "ref", "foo"])).toBe("fingerprint ref foo");
  });
});
