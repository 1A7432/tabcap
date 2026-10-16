// docs/08 §5: names aligned with Chrome DevTools MCP; the 0.3 deprecated
// aliases were removed in 0.4. The schema snapshot pins the whole CLI
// contract (names, positionals, flags, defaults, aliases); update it with
// `bun test --update-snapshots` only for an intended contract change.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { COMMANDS, helpFor, matchCommand, parseCommand, schema, specOf, usageOf } from "../../src/cli/commands.ts";
import { run, withLocalPaths } from "../../src/cli/main.ts";

const parse = (words: string[], argv: string[]) => {
  const c = matchCommand(words);
  if (c === null) throw new Error(words.join(" "));
  return { c, p: parseCommand(c, argv) };
};

describe("CLI contract (schema snapshot)", () => {
  test("tabcap schema --json is unchanged", () => {
    expect(schema()).toMatchSnapshot();
  });
});

describe("renamed commands; the 0.3 aliases are gone (docs/08 §5, removed in 0.4)", () => {
  const OLD_COMMANDS = ["tabs", "tab use", "press", "console"];
  const OLD_FLAGS: Array<[string[], string]> = [
    [["net", "list"], "--type"],
    [["net", "list"], "--limit"],
    [["net", "list"], "--offset"],
    [["screenshot"], "--out"],
    [["screenshot"], "--full"],
  ];

  test("the old command names are no commands any more; the new ones are", () => {
    for (const name of OLD_COMMANDS) expect(COMMANDS.some((c) => c.path.join(" ") === name)).toBe(false);
    for (const name of ["tab list", "tab select", "press-key", "console list", "console show"]) expect(specOf(name).path.join(" ")).toBe(name);
    expect(matchCommand(["tabs"])).toBeNull();
    expect(matchCommand(["tab", "use", "t2"])).toBeNull();
    expect(matchCommand(["press", "Enter"])).toBeNull();
    expect(matchCommand(["console", "warn"])).toBeNull();
    expect(matchCommand(["console", "list"])?.path).toEqual(["console", "list"]);
    expect(matchCommand(["console", "show", "3"])?.path).toEqual(["console", "show"]);
  });

  test("old names fail with the normal unknown-command / unknown-option usage error", async () => {
    for (const argv of [["tabs"], ["tab", "use", "t2"], ["press", "Enter"], ["console"], ["console", "--level", "warn"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
      if (r.envelope.ok) throw new Error("expected failure");
      expect(r.envelope.error.message).toStartWith("unknown command: ");
    }
    for (const [words, flag] of OLD_FLAGS) {
      const c = specOf(words.join(" "));
      expect(() => parseCommand(c, [flag, "x"])).toThrow(`unknown option ${flag}`);
      const r = await run([...words, flag, "1"]);
      expect(r.code).toBe(2);
      expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage", message: `unknown option ${flag}` } });
    }
  });

  test("the new flag names parse; dialog --prompt-text stays a plain alias of --text", () => {
    expect(parse(["net", "list"], ["--resource-types", "xhr", "--page-size", "5", "--page-idx", "1"]).p.args).toEqual({ types: "xhr", pageSize: 5, pageIdx: 1 });
    expect(parse(["screenshot"], ["--file-path", "a.png", "--full-page"]).p.args).toEqual({ filePath: "a.png", fullPage: true });
    expect(parse(["dialog"], ["accept", "--prompt-text", "x"]).p.args).toEqual({ op: "accept", text: "x" });
    expect(parse(["dialog"], ["accept", "--text", "x"]).p.args).toEqual({ op: "accept", text: "x" });
    const help = helpFor(specOf("net list"));
    expect(help).not.toMatch(/deprecated|old spelling|--offset/i);
    expect(helpFor(specOf("dialog"))).toContain("--text, --prompt-text");
  });

  test("tab new is navigate in a new tab; wait --text repeats; upload keeps its files as a list", () => {
    const tn = parse(["tab", "new"], ["http://x/", "--background"]);
    expect(tn.c.action).toBe("navigate");
    expect(tn.p.args).toEqual({ url: "http://x/", background: true, newTab: true });
    expect(parse(["wait"], ["--text", "a", "--text", "b c"]).p.args).toEqual({ text: ["a", "b c"] });
    expect(parse(["wait"], ["--text", "a"]).p.args).toEqual({ text: ["a"] });
    expect(parse(["upload"], ["e3", "a b.txt", "c.txt"]).p.args).toEqual({ ref: "e3", files: ["a b.txt", "c.txt"] });
    expect(usageOf(specOf("upload"))).toContain("<ref> <files>...");
    expect(parse(["evaluate"], ["--function", "(a) => a", "--args", "[1]"]).p.args).toEqual({ function: "(a) => a", args: "[1]" });
  });

  test("local paths resolve against the caller's working directory", () => {
    expect(withLocalPaths(specOf("upload"), { ref: "e1", files: ["a.txt", "/abs/b.txt"] }, "/work")).toEqual({ ref: "e1", files: [resolve("/work/a.txt"), resolve("/abs/b.txt")] });
    expect(withLocalPaths(specOf("screenshot"), { filePath: "shots/x.png" }, "/work")).toEqual({ filePath: resolve("/work/shots/x.png") });
    expect(withLocalPaths(specOf("snapshot"), { filePath: "t.txt", interactive: true }, "/w")).toEqual({ filePath: resolve("/w/t.txt"), interactive: true });
    expect(withLocalPaths(specOf("click"), { ref: "e1" }, "/w")).toEqual({ ref: "e1" });
  });

  test("every interactive command takes --snapshot and (but upload) --no-wait", () => {
    for (const name of ["click", "hover", "fill", "type", "press-key", "upload"]) expect(specOf(name).flags.some((f) => f.flag === "--snapshot")).toBe(true);
    for (const name of ["click", "hover", "fill", "type", "press-key", "navigate", "tab new", "go", "reload"]) expect(specOf(name).flags.some((f) => f.flag === "--no-wait")).toBe(true);
  });

  test("the schema has no deprecation fields; plain aliases stay", () => {
    const sc = schema();
    const byName = new Map(sc.commands.map((c) => [c.name, c]));
    for (const name of ["tabs", "tab use", "press", "console"]) expect(byName.has(name)).toBe(false);
    for (const c of sc.commands) {
      expect(Object.keys(c)).not.toContain("deprecatedFor");
      for (const f of c.flags) expect(Object.keys(f).filter((k) => k.startsWith("deprecated"))).toEqual([]);
    }
    expect(byName.get("net list")?.flags.map((f) => f.flag)).not.toContain("--offset");
    expect(byName.get("dialog")?.flags.find((f) => f.flag === "--text")).toMatchObject({ alias: "--prompt-text" });
    expect(byName.get("wait")?.flags.find((f) => f.flag === "--text")).toMatchObject({ repeatable: true });
  });
});
