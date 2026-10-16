// `bun run gen:docs`: regenerate the command tables in README.md and
// README.zh-CN.md and the whole of skills/tabcap/references/commands.md from
// the command registry (src/cli/commands.ts), the same source as `--help` and
// `tabcap schema --json`. In the READMEs only the text between the
// BEGIN/END GENERATED markers is replaced; hand-written prose around it stays.
// test/unit/schema.test.ts fails when the committed files are out of date.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMMON_FLAGS, OUTPUT_FLAGS, OUTPUT_FLAGS_NOT_ON, currentCommands, groupedCommands, isCommonFlag, usageOf, type CommandSpec, type FlagSpec } from "../src/cli/commands.ts";

export const ROOT = join(import.meta.dir, "..");
export const SKILL_DIR = "skills/tabcap";
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
export const REFERENCE_FILE = `${SKILL_DIR}/references/commands.md`;
export const README_FILE = "README.md";
export const README_ZH_FILE = "README.zh-CN.md";

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Markdown table of every current command: usage (common flags left out) and one-line help. */
export function commandTable(header: [string, string]): string {
  const rows = currentCommands().map((c) => `| \`${cell(usageOf(c, COMMON_FLAGS))}\` | ${cell(c.summary)} |`);
  return [`| ${header[0]} | ${header[1]} |`, "|---|---|", ...rows].join("\n");
}

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

const begin = (name: string) => `<!-- BEGIN GENERATED: ${name} (from src/cli/commands.ts; run \`bun run gen:docs\`) -->`;
const end = (name: string) => `<!-- END GENERATED: ${name} -->`;

/** Replace the body between the named markers; throws when they are missing or out of order. */
export function replaceGenerated(text: string, name: string, body: string): string {
  const b = begin(name);
  const e = end(name);
  const i = text.indexOf(b);
  const j = text.indexOf(e);
  if (i < 0 || j < 0 || j < i) throw new Error(`markers for "${name}" not found (expected ${b} … ${e})`);
  if (text.indexOf(b, i + 1) >= 0 || text.indexOf(e, j + 1) >= 0) throw new Error(`markers for "${name}" appear more than once`);
  return text.slice(0, i + b.length) + "\n" + body + "\n" + text.slice(j);
}

/** The files as they should be, given their current hand-written parts. */
export function generatedDocs(root: string = ROOT): { file: string; current: string; wanted: string }[] {
  const spec: [string, [string, string]][] = [
    [README_FILE, ["Command", "What it does"]],
    [README_ZH_FILE, ["命令", "作用"]],
  ];
  const tables = spec.map(([file, header]) => {
    const current = readFileSync(join(root, file), "utf8");
    return { file, current, wanted: replaceGenerated(current, "commands", commandTable(header)) };
  });
  const ref = join(root, REFERENCE_FILE);
  let current = "";
  try {
    current = readFileSync(ref, "utf8");
  } catch {
    current = "";
  }
  return [...tables, { file: REFERENCE_FILE, current, wanted: referenceDoc() }];
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
