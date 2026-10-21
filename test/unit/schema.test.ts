import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, SCHEMA_ID, helpAll, schema } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { CONFIG_FILE, GUIDES_FILE, REFERENCE_FILE, ROOT, SKILL_FILE, configDoc, generatedDocs } from "../../scripts/gen-docs.ts";
import { CONFIG_KEYS } from "../../src/shared/config.ts";
import { GUIDES } from "../../src/cli/guides.ts";

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

  test("without --json it is an ordinary envelope (exempt from the output budget)", async () => {
    const r = await run(["schema"]);
    expect(r.text).toBeUndefined();
    expect(r.envelope).toMatchObject({ ok: true, data: { schema: SCHEMA_ID } });
  });

  test("one entry per registry command, same names as --help (the index lists the non-internal ones)", () => {
    const s = schema();
    expect(s.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.path.join(" ")));
    const help = helpAll();
    for (const c of s.commands) {
      if (!c.internal) expect(help).toContain(c.name);
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
  test("the skill's references/commands.md, references/guides.md and references/config.md are up to date with their registries", () => {
    expect(generatedDocs().map((d) => d.file)).toEqual([REFERENCE_FILE, GUIDES_FILE, CONFIG_FILE]);
    for (const d of generatedDocs()) {
      if (d.current !== d.wanted) throw new Error(`${d.file} is out of date: run \`bun run gen:docs\` and commit the result`);
    }
  });

  test("the reference lists every user-facing command and no removed alias; the README has no generated table", () => {
    const ref = readFileSync(join(ROOT, REFERENCE_FILE), "utf8");
    for (const c of COMMANDS.filter((x) => x.internal !== true)) {
      expect(ref).toContain(`### \`tabcap ${c.path.join(" ")}\``);
    }
    for (const file of ["README.md", "README.zh-CN.md"]) {
      const readme = readFileSync(join(ROOT, file), "utf8");
      expect(readme).not.toContain("GENERATED");
      expect(readme).toContain("skills/tabcap/references/commands.md");
    }
    for (const doc of [ref]) expect(doc).not.toMatch(/[Dd]eprecated/);
  });

  test("references/config.md: one row per CONFIG_KEYS key with its type, default, sentence and docs/04 section (review wave 3)", () => {
    const doc = configDoc();
    expect(doc.startsWith("<!-- GENERATED from src/shared/config.ts")).toBe(true);
    expect(doc).toContain("| Key | Type | Default | Meaning | docs/04 |");
    const rows = doc.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows).toHaveLength(46);
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    for (const [layer, keys] of Object.entries(CONFIG_KEYS)) {
      for (const [key, info] of Object.entries(keys)) {
        const path = layer === "" ? key : `${layer}.${key}`;
        expect(rows).toContain(`| \`${path}\` | \`${cell(info.type)}\` | ${info.default === "—" ? "—" : `\`${cell(info.default)}\``} | ${cell(info.about)} | ${info.doc ?? "—"} |`);
      }
    }
    expect(rows[0]).toStartWith("| `chrome` |");
    expect(rows).toContain("| `sites.<site>.guard.stopOn` | `string[] (stop rules)` | `[]` | a match stops the site's fetches and hands the session to the human (`waiting`, reason stop-rule) | §18 |");
    expect(readFileSync(join(ROOT, SKILL_FILE), "utf8")).toContain("(references/config.md)");
  });

  test("references/guides.md has every guide with every step command (0.7-A)", () => {
    const doc = readFileSync(join(ROOT, GUIDES_FILE), "utf8");
    expect(doc.startsWith("<!-- GENERATED from src/cli/guides.ts")).toBe(true);
    for (const g of GUIDES) {
      expect(doc).toContain(`## \`${g.id}\`: ${g.title}`);
      for (const s of g.steps) expect(doc).toContain(`\n${s.cmd}\n`);
    }
  });
});
