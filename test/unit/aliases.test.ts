// docs/08 §5: names aligned with Chrome DevTools MCP, old names kept one
// release as deprecated aliases. The schema snapshot pins the whole CLI
// contract (names, positionals, flags, defaults, aliases); update it with
// `bun test --update-snapshots` only for an intended contract change.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { COMMANDS, deprecatedAliases, helpFor, matchCommand, parseCommand, schema, specOf, usageOf } from "../../src/cli/commands.ts";
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

describe("renamed commands and their deprecated aliases (docs/08 §5)", () => {
  test("old command → same daemon action as the new one, marked deprecated", () => {
    const pairs: Array<[string, string]> = [
      ["tabs", "tab list"],
      ["tab use", "tab select"],
      ["press", "press-key"],
      ["console", "console list"],
    ];
    expect(deprecatedAliases()).toEqual(pairs.map(([alias, use]) => ({ alias, use })));
    for (const [oldName, newName] of pairs) {
      const o = specOf(oldName);
      const n = specOf(newName);
      expect(o.deprecatedFor).toBe(newName);
      expect(n.deprecatedFor).toBeUndefined();
      // console list is a new action (msgid, types, paging); the others share theirs
      if (newName !== "console list") expect(o.action).toBe(n.action ?? "missing");
    }
    expect(matchCommand(["tabs"])?.deprecatedFor).toBe("tab list");
    expect(matchCommand(["console", "warn"])?.path).toEqual(["console"]);
    expect(matchCommand(["console", "list"])?.path).toEqual(["console", "list"]);
    expect(matchCommand(["console", "show", "3"])?.path).toEqual(["console", "show"]);
  });

  test("--help of an alias says what to use instead, in one line", () => {
    const h = helpFor(specOf("press"));
    expect(h.split("\n")[1]).toBe("Deprecated: use `tabcap press-key` instead (this alias is removed in 0.4).");
    expect(helpFor(specOf("press-key"))).not.toContain("Deprecated");
  });

  test("old flag spellings parse to the new keys and are marked in help", () => {
    expect(parse(["net", "list"], ["--type", "xhr", "--limit", "5"]).p.args).toEqual({ types: "xhr", pageSize: 5 });
    expect(parse(["net", "list"], ["--resource-types", "xhr", "--page-size", "5", "--page-idx", "1"]).p.args).toEqual({ types: "xhr", pageSize: 5, pageIdx: 1 });
    expect(parse(["screenshot"], ["--out", "a.png", "--full"]).p.args).toEqual({ filePath: "a.png", fullPage: true });
    expect(parse(["screenshot"], ["--file-path", "a.png", "--full-page"]).p.args).toEqual({ filePath: "a.png", fullPage: true });
    expect(parse(["dialog"], ["accept", "--prompt-text", "x"]).p.args).toEqual({ op: "accept", text: "x" });
    const help = helpFor(specOf("net list"));
    expect(help).toContain("old spelling --limit still works; deprecated, removed in 0.4");
    expect(help).toContain("--offset <n>");
    expect(help).toContain("deprecated, use --page-idx");
    // deprecated flags and old spellings stay out of the usage line
    expect(usageOf(specOf("net list"))).not.toContain("--offset");
    expect(usageOf(specOf("net list"))).not.toContain("--type ");
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
    expect(withLocalPaths(specOf("screenshot"), { filePath: "shots/x.png" }, "/work")).toEqual({ filePath: "/work/shots/x.png" });
    expect(withLocalPaths(specOf("snapshot"), { filePath: "t.txt", interactive: true }, "/w")).toEqual({ filePath: "/w/t.txt", interactive: true });
    expect(withLocalPaths(specOf("click"), { ref: "e1" }, "/w")).toEqual({ ref: "e1" });
  });

  test("every interactive command takes --snapshot and (but upload) --no-wait", () => {
    for (const name of ["click", "hover", "fill", "type", "press-key", "upload"]) expect(specOf(name).flags.some((f) => f.flag === "--snapshot")).toBe(true);
    for (const name of ["click", "hover", "fill", "type", "press-key", "navigate", "tab new", "go", "reload"]) expect(specOf(name).flags.some((f) => f.flag === "--no-wait")).toBe(true);
  });

  test("the schema lists aliases and old spellings for tools", () => {
    const byName = new Map(schema().commands.map((c) => [c.name, c]));
    expect(byName.get("tabs")?.deprecatedFor).toBe("tab list");
    expect(byName.get("tab list")?.deprecatedFor).toBeNull();
    expect(byName.get("net list")?.flags.find((f) => f.flag === "--page-size")).toMatchObject({ deprecatedAliases: ["--limit"], deprecated: null });
    expect(byName.get("net list")?.flags.find((f) => f.flag === "--offset")).toMatchObject({ deprecated: "use --page-idx" });
    expect(byName.get("wait")?.flags.find((f) => f.flag === "--text")).toMatchObject({ repeatable: true });
    expect(COMMANDS.filter((c) => c.deprecatedFor !== undefined).every((c) => specOf(c.deprecatedFor ?? "").deprecatedFor === undefined)).toBe(true);
  });

  test("a deprecated alias still runs through the same path (usage errors as before)", async () => {
    const r = await run(["press"]);
    expect(r.code).toBe(2);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
  });
});
