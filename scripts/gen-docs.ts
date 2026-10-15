// `bun run gen:docs`: regenerate the command tables in README.md and
// README.zh-CN.md and the whole of skills/tabcap/references/commands.md from
// the command registry (src/cli/commands.ts), the same source as `--help` and
// `tabcap schema --json`. In the READMEs only the text between the
// BEGIN/END GENERATED markers is replaced; hand-written prose around it stays.
// test/unit/schema.test.ts fails when the committed files are out of date.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALIASES_REMOVED_IN, COMMANDS, COMMON_FLAGS, currentCommands, deprecatedAliases, usageOf, type CommandSpec, type FlagSpec } from "../src/cli/commands.ts";

export const ROOT = join(import.meta.dir, "..");
export const SKILL_DIR = "skills/tabcap";
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
export const REFERENCE_FILE = `${SKILL_DIR}/references/commands.md`;
export const README_FILE = "README.md";
export const README_ZH_FILE = "README.zh-CN.md";

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Markdown table of every current command: usage (common flags left out) and one-line help; then the deprecated aliases. */
export function commandTable(header: [string, string], aliasLabel: string): string {
  const rows = currentCommands().map((c) => `| \`${cell(usageOf(c, COMMON_FLAGS))}\` | ${cell(c.summary)} |`);
  const aliases = deprecatedAliases().map((x) => `\`${x.alias}\` → \`${x.use}\``);
  return [`| ${header[0]} | ${header[1]} |`, "|---|---|", ...rows, "", `${aliasLabel}: ${aliases.join(", ")}`].join("\n");
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
  if (f.deprecatedNote !== undefined) notes.push(`deprecated: ${f.deprecatedNote}`);
  if (f.deprecated !== undefined) notes.push(`old spelling ${f.deprecated.map((x) => `\`${x}\``).join(", ")}, deprecated`);
  const dflt = f.default === undefined ? "" : `\`${String(f.default)}\``;
  return `| ${names} | ${dflt} | ${cell(f.help)}${notes.length === 0 ? "" : ` (${notes.join("; ")})`} |`;
}

function commandSection(c: CommandSpec): string {
  const flags = c.flags.filter((f) => !COMMON_FLAGS.includes(f.flag));
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
  const groups: Array<[string, (c: CommandSpec) => boolean]> = [
    ["Setup and lifecycle", (c) => ["setup", "daemon", "browser"].includes(c.path[0] ?? "")],
    ["Sites, sessions and tabs", (c) => ["site", "session", "tab"].includes(c.path[0] ?? "")],
    ["Navigation and page reading", (c) => ["navigate", "go", "reload", "snapshot", "outline", "find", "wait"].includes(c.path[0] ?? "")],
    ["Input", (c) => ["click", "hover", "fill", "type", "press-key", "upload", "dialog"].includes(c.path[0] ?? "")],
    ["Page tools", (c) => ["evaluate", "screenshot", "resize", "emulate", "console"].includes(c.path[0] ?? "")],
    ["Network recording", (c) => c.path[0] === "net"],
    ["Handoff and challenge handlers", (c) => ["handoff", "plugin"].includes(c.path[0] ?? "")],
    ["Offline: bundles, analysis, replay", (c) => ["bundle", "analyze", "replay", "schema"].includes(c.path[0] ?? "")],
  ];
  const cmds = currentCommands();
  const used = new Set<CommandSpec>();
  const sections = groups.map(([title, test]) => {
    const mine = cmds.filter((c) => test(c) && !used.has(c));
    for (const c of mine) used.add(c);
    return [`## ${title}`, "", ...mine.map((c) => `${commandSection(c)}\n`)].join("\n");
  });
  const rest = cmds.filter((c) => !used.has(c));
  if (rest.length > 0) sections.push(["## Other", "", ...rest.map((c) => `${commandSection(c)}\n`)].join("\n"));
  return [
    "<!-- GENERATED from src/cli/commands.ts by `bun run gen:docs`; do not edit by hand. -->",
    "",
    "# tabcap command reference",
    "",
    "Every command prints one JSON envelope on stdout: `{\"ok\":true,\"data\":…}` or `{\"ok\":false,\"error\":{\"code\",\"message\",\"next\"}}`. Browser commands also take `--session <name>` (else `$TABCAP_SESSION`, else `default`) and most take `--timeout <ms>` (default 30000; `wait` / `net wait` 10000); they are left out below. `tabcap <command> --help` prints the same as one section here; `tabcap schema --json` is the machine-readable form.",
    "",
    `Deprecated aliases, removed in ${ALIASES_REMOVED_IN}: ${deprecatedAliases()
      .map((x) => `\`tabcap ${x.alias}\` → \`tabcap ${x.use}\``)
      .join(", ")}.`,
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
  const spec: [string, [string, string], string][] = [
    [README_FILE, ["Command", "What it does"], `Deprecated aliases (removed in ${ALIASES_REMOVED_IN})`],
    [README_ZH_FILE, ["命令", "作用"], `旧名别名（${ALIASES_REMOVED_IN} 删除）`],
  ];
  const tables = spec.map(([file, header, label]) => {
    const current = readFileSync(join(root, file), "utf8");
    return { file, current, wanted: replaceGenerated(current, "commands", commandTable(header, label)) };
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
