// `bun run gen:docs`: regenerate skills/tabcap/references/commands.md (the
// full command reference) from the command registry (src/cli/commands.ts),
// the same source as `--help` and `tabcap schema --json`, and (0.7-A)
// skills/tabcap/references/guides.md from the task guides (src/cli/guides.ts),
// the same source as `tabcap guide`, and (review wave 3) skills/tabcap/references/config.md
// from the config.json key table (src/shared/config.ts CONFIG_KEYS), the same source as
// the readers and the unknown-key warnings. The READMEs are written by hand and carry
// no generated table (they link to the reference).
// test/unit/schema.test.ts fails when a committed file is out of date.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OUTPUT_FLAGS, OUTPUT_FLAGS_NOT_ON, groupedCommands, isCommonFlag, usageOf, type CommandSpec, type FlagSpec } from "../src/cli/commands.ts";
import { GUIDES, type Guide } from "../src/cli/guides.ts";
import { CONFIG_KEYS } from "../src/shared/config.ts";

export const ROOT = join(import.meta.dir, "..");
export const SKILL_DIR = "skills/tabcap";
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
export const REFERENCE_FILE = `${SKILL_DIR}/references/commands.md`;
export const GUIDES_FILE = `${SKILL_DIR}/references/guides.md`;
export const CONFIG_FILE = `${SKILL_DIR}/references/config.md`;

const cell = (s: string) => s.replace(/\|/g, "\\|");

function flagValue(f: FlagSpec): string {
  if (f.kind === "bool") return "";
  if (f.kind === "optnum") return " [ms]";
  return ` <${f.metavar ?? "v"}>`;
}

function flagRow(f: FlagSpec): string {
  const names = [f.flag, ...(f.alias === undefined ? [] : [f.alias])].map((n) => `\`${cell(n + flagValue(f))}\``).join(", ");
  const notes: string[] = [];
  if (f.required === true) notes.push("required");
  if (f.repeat === true) notes.push("repeatable");
  const dflt = f.default === undefined ? "" : `\`${String(f.default)}\``;
  return `| ${names} | ${dflt} | ${cell(f.help)}${notes.length === 0 ? "" : ` (${notes.join("; ")})`} |`;
}

function commandSection(c: CommandSpec): string {
  const flags = c.flags.filter((f) => !isCommonFlag(f));
  return [
    `### \`tabcap ${c.path.join(" ")}\``,
    "",
    c.summary,
    "",
    "```",
    usageOf(c),
    "```",
    "",
    `Example: \`${c.example}\``,
    ...(flags.length === 0 ? [] : ["", "| Option | Default | Meaning |", "|---|---|---|", ...flags.map(flagRow)]),
  ].join("\n");
}

/** The whole reference file for the skill (references/commands.md). */
export function referenceDoc(): string {
  const sections = groupedCommands().map((g) => [`## ${g.title}`, "", ...g.commands.map((c) => `${commandSection(c)}\n`)].join("\n"));
  return [
    "<!-- GENERATED from src/cli/commands.ts by `bun run gen:docs`; do not edit by hand. -->",
    "",
    "# tabcap command reference",
    "",
    "Every command prints one JSON envelope on stdout: `{\"ok\":true,\"data\":…}` or `{\"ok\":false,\"error\":{\"code\",\"message\",\"next\"}}`. Browser commands also take `--session <name>` (else `$TABCAP_SESSION`, else `default`) and most take `--timeout <ms>` (default 30000; `wait` / `net wait` 10000); they are left out below. `tabcap <command> --help` prints the same as one section here; `tabcap schema --json` is the machine-readable form.",
    "",
    "## Output flags (every command)",
    "",
    "The CLI applies these to the envelope's `data` after the command ran, in this order: select, grep, fields, then the output budget. The envelope then also carries `filter: {select, grep, fields, matches, total, capped}` (and `selected` with `--select`). Above `TABCAP_OUTPUT_LIMIT` bytes (default 16384; `0` turns it off) `data` becomes `{summary, file, bytes, truncated: true}`: the whole `data` is in `file` (the recording's `exports/<command>-<seq>.json`, else `<cache>/outputs/<stamp>-<command>.json`). `net list`, `console list` and `snapshot` page or cut on their own and are exempt.",
    "",
    "| Option | Default | Meaning |",
    "|---|---|---|",
    ...OUTPUT_FLAGS.map((f) => flagRow(f).replace(/ \|$/, (OUTPUT_FLAGS_NOT_ON[f.flag] ?? []).length > 0 ? ` (not on ${(OUTPUT_FLAGS_NOT_ON[f.flag] ?? []).join(", ")}) |` : " |")),
    "",
    ...sections,
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/** A reference path of a guide (relative to the skill directory) as a link from inside references/. */
function readLink(path: string): string {
  const rel = path.replace(/^references\//, "");
  return `[${rel}](${rel})`;
}

function guideSection(g: Guide): string {
  return [
    `## \`${g.id}\`: ${g.title}`,
    "",
    `When: ${g.when}`,
    "",
    "```sh",
    ...g.steps.flatMap((st, i) => [...(i === 0 ? [] : [""]), `# ${i + 1}. ${st.why}`, st.cmd]),
    "```",
    "",
    "Watch:",
    "",
    ...g.watch.map((w) => `- ${w}`),
    "",
    `Read: ${g.read.map(readLink).join(", ")}`,
  ].join("\n");
}

/** The task guides for the skill (references/guides.md), from src/cli/guides.ts. */
export function guidesDoc(): string {
  return [
    "<!-- GENERATED from src/cli/guides.ts by `bun run gen:docs`; do not edit by hand. -->",
    "",
    "# tabcap task guides",
    "",
    "Task-first entry points: which commands a task needs, in what order, and the pitfalls that are easy to miss. The same text is in the binary: `tabcap guide` lists the guides, `tabcap guide <id>` gives one as JSON, `--text` as a numbered shell block; over MCP `tabcap_help {guide: \"<id>\"}` (`\"\"` lists them). Example values (`example`, `e5`, `r-12`, `./b`) stand for yours.",
    "",
    "| Guide | When to use it |",
    "|---|---|",
    ...GUIDES.map((g) => `| \`${g.id}\`: ${cell(g.title)} | ${cell(g.when)} |`),
    "",
    ...GUIDES.map((g) => `${guideSection(g)}\n`),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/** The config.json key table for the skill (references/config.md), from src/shared/config.ts CONFIG_KEYS. */
export function configDoc(): string {
  const rows = Object.entries(CONFIG_KEYS).flatMap(([layer, keys]) =>
    Object.entries(keys).map(([key, k]) => {
      const dflt = k.default === "—" ? "—" : `\`${cell(k.default)}\``;
      return `| \`${layer === "" ? key : `${layer}.${key}`}\` | \`${cell(k.type)}\` | ${dflt} | ${cell(k.about)} | ${k.doc ?? "—"} |`;
    }),
  );
  return [
    "<!-- GENERATED from src/shared/config.ts (CONFIG_KEYS) by `bun run gen:docs`; do not edit by hand. -->",
    "",
    "# config.json keys",
    "",
    "`config.json` is in tabcap's config directory (`~/.config/tabcap/` on macOS, `$XDG_CONFIG_HOME/tabcap/` or `~/.config/tabcap/` on Linux, `%LOCALAPPDATA%\\tabcap\\config\\` on Windows; `tabcap setup` answers its path as `config`). Every key is optional; `<site>` stands for a store site name (`tabcap site list`). A file that is not valid JSON, or not a JSON object, is a `bad-input` error naming the line and column for every command that reads it (`tabcap status` instead keeps its answer and reports that error in `config.error`), and `tabcap setup` does not rewrite it. A key this table does not list at its level is not an error: `browser start` / `browser status` (`warnings`), `tabcap status` (`config.warnings`) and `tabcap setup` (`warnings`) name it, e.g. `config.json: unknown key fetch.minIntervalMS (did you mean minIntervalMs?)`. `replay` and `sites.<site>.replay` hold replay key rules, which refuse unknown keys. The last column is the section of docs/04 (the evidence bundle spec in the tabcap repository) that specifies the key.",
    "",
    "| Key | Type | Default | Meaning | docs/04 |",
    "|---|---|---|---|---|",
    ...rows,
  ]
    .join("\n")
    .concat("\n");
}

function readOr(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The generated files as they should be: the command reference, the task guides and the config.json key table. */
export function generatedDocs(root: string = ROOT): { file: string; current: string; wanted: string }[] {
  return [
    { file: REFERENCE_FILE, current: readOr(join(root, REFERENCE_FILE)), wanted: referenceDoc() },
    { file: GUIDES_FILE, current: readOr(join(root, GUIDES_FILE)), wanted: guidesDoc() },
    { file: CONFIG_FILE, current: readOr(join(root, CONFIG_FILE)), wanted: configDoc() },
  ];
}

if (import.meta.main) {
  for (const d of generatedDocs()) {
    if (d.current === d.wanted) {
      console.log(`unchanged ${d.file}`);
      continue;
    }
    mkdirSync(dirname(join(ROOT, d.file)), { recursive: true });
    writeFileSync(join(ROOT, d.file), d.wanted);
    console.log(`wrote     ${d.file}`);
  }
}
