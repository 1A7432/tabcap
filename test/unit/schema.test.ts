import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, SCHEMA_ID, helpAll, schema } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { REFERENCE_FILE, ROOT, generatedDocs, replaceGenerated } from "../../scripts/gen-docs.ts";

const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pkgVersion = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : null;

describe("tabcap schema", () => {
  test("--json prints the bare registry document", async () => {
    const r = await run(["schema", "--json"]);
    expect(r.code).toBe(0);
    if (r.text === undefined) throw new Error("expected text output");
    const doc: unknown = JSON.parse(r.text);
    expect(doc).toEqual(JSON.parse(JSON.stringify(schema())));
    expect(doc).toMatchObject({ schema: SCHEMA_ID, tool: "tabcap", version: pkgVersion });
  });

  test("without --json it is an ordinary envelope", async () => {
    const r = await run(["schema"]);
    expect(r.text).toBeUndefined();
    expect(r.envelope).toMatchObject({ ok: true, data: { schema: SCHEMA_ID } });
  });

  test("one entry per registry command, same names as --help", () => {
    const s = schema();
    expect(s.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.path.join(" ")));
    const help = helpAll();
    for (const c of s.commands) {
      expect(help).toContain(c.name);
      expect(c.example.startsWith(`tabcap ${c.name}`)).toBe(true);
      expect(c.summary.length).toBeGreaterThan(0);
    }
    for (const name of ["bundle export har", "bundle import har", "analyze find", "analyze diff", "schema", "wait", "net wait"]) {
      expect(s.commands.some((c) => c.name === name)).toBe(true);
    }
  });

  test("positionals and flags carry types, defaults and requiredness", () => {
    const byName = new Map(schema().commands.map((c) => [c.name, c]));
    const fill = byName.get("fill");
    expect(fill?.positionals).toEqual([
      { name: "ref", required: true, variadic: false, choices: null },
      { name: "text", required: false, variadic: true, choices: null },
    ]);
    expect(fill?.flags.find((f) => f.flag === "--secret")).toMatchObject({ type: "string", required: false });
    expect(fill?.daemon).toBe(true);
    expect(fill?.flags.find((f) => f.flag === "--timeout")).toMatchObject({ type: "number", default: 30000, required: false });
    expect(fill?.flags.find((f) => f.flag === "--trusted")).toMatchObject({ type: "boolean", default: false });
    expect(byName.get("go")?.positionals[0]?.choices).toEqual(["back", "forward"]);
    expect(byName.get("wait")?.flags.find((f) => f.flag === "--idle")).toMatchObject({ type: "number", valueOptional: true, default: 500 });
    expect(byName.get("net wait")?.flags.find((f) => f.flag === "--url")).toMatchObject({ required: true });
    expect(byName.get("bundle import har")?.flags[0]).toMatchObject({ flag: "-o", alias: "--out", required: true });
    expect(byName.get("analyze diff")?.positionals.map((p) => p.required)).toEqual([true, true, false]);
    expect(byName.get("analyze find")?.daemon).toBe(false);
    expect(byName.get("daemon run")?.internal).toBe(true);
  });
});

describe("generated docs (bun run gen:docs)", () => {
  test("README.md, README.zh-CN.md and the skill's references/commands.md are up to date with the registry", () => {
    for (const d of generatedDocs()) {
      if (d.current !== d.wanted) throw new Error(`${d.file} is out of date: run \`bun run gen:docs\` and commit the result`);
    }
  });

  test("only the text between the markers is replaced", () => {
    const b = "<!-- BEGIN GENERATED: t (from src/cli/commands.ts; run `bun run gen:docs`) -->";
    const e = "<!-- END GENERATED: t -->";
    const doc = `intro\n${b}\nold\n${e}\noutro\n`;
    expect(replaceGenerated(doc, "t", "new")).toBe(`intro\n${b}\nnew\n${e}\noutro\n`);
    expect(() => replaceGenerated("no markers", "t", "x")).toThrow();
    expect(() => replaceGenerated(`${e}\n${b}`, "t", "x")).toThrow();
  });

  test("the generated docs list every user-facing command; deprecated aliases only as old → new", () => {
    const ref = readFileSync(join(ROOT, REFERENCE_FILE), "utf8");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const c of COMMANDS.filter((x) => x.internal !== true)) {
      const name = c.path.join(" ");
      if (c.deprecatedFor === undefined) {
        expect(ref).toContain(`### \`tabcap ${name}\``);
        expect(readme).toContain(`| \`tabcap ${name}`);
      } else {
        expect(ref).toContain(`\`tabcap ${name}\` → \`tabcap ${c.deprecatedFor}\``);
        expect(ref).not.toContain(`### \`tabcap ${name}\``);
      }
    }
  });
});
