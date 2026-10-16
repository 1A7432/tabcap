// `bun scripts/validate-skill.ts [skills/tabcap]`: a local stand-in for
// `skills-ref validate` (agentskills.io), which cannot be installed offline.
// It checks the agentskills.io SKILL.md rules plus this project's stricter
// ones (docs/08 "Skill 规范"):
// - SKILL.md starts with YAML frontmatter; only the spec's keys (name,
//   description, license, compatibility, metadata, allowed-tools);
// - name: 1–64 chars, lowercase letters / digits / single hyphens, equal to
//   the directory name;
// - description: non-empty, at most 400 chars (spec: 1024), triggers first
//   (it starts with "Use when");
// - compatibility (spec: optional, ≤ 500 chars) is required here and names the
//   separately installed `tabcap` binary and Chrome for Testing;
// - license: Apache-2.0;
// - body under 500 lines and SKILL.md at most 8 KB (0.5-C context budget: it
//   is loaded whole when the skill triggers; detail goes to references/);
//   every relative link points at an existing file;
// - only SKILL.md, references/*.md and scripts/* (none today) in the
//   directory, and nothing an installer scan would flag (Hermes Agent scans
//   skills for risky content): no shell scripts, no `curl … | sh`, no sudo,
//   no `rm -rf`.
// test/unit/skill.test.ts runs it on skills/tabcap.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export const MAX_DESCRIPTION = 400;
export const MAX_COMPATIBILITY = 500;
export const MAX_BODY_LINES = 500;
export const MAX_SKILL_BYTES = 8192;
const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RISKY: Array<[RegExp, string]> = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/, "pipes a download into a shell"],
  [/\bsudo\s/, "uses sudo"],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, "uses rm -rf"],
  [/\bchmod\s+[0-7]*7[0-7]*\s+\//, "changes permissions under /"],
];

export type Frontmatter = { fields: Map<string, string>; bodyStart: number; problems: string[] };

/** The small YAML subset SKILL.md frontmatter uses: `key: value` lines, quoted or plain; `metadata:` with indented pairs. */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  const problems: string[] = [];
  const fields = new Map<string, string>();
  if (lines[0] !== "---") return { fields, bodyStart: 0, problems: ["SKILL.md must start with a `---` frontmatter line"] };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { fields, bodyStart: 0, problems: ["the frontmatter has no closing `---`"] };
  let inMap: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s+/.test(line)) {
      if (inMap === null) problems.push(`line ${i + 1}: indented line outside a map`);
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s(.*))?$/.exec(line);
    if (m === null || m[1] === undefined) {
      problems.push(`line ${i + 1}: not a \`key: value\` line`);
      continue;
    }
    const key = m[1];
    const raw = (m[2] ?? "").trim();
    if (!ALLOWED_KEYS.has(key)) problems.push(`unknown frontmatter key "${key}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`);
    if (fields.has(key)) problems.push(`duplicate key "${key}"`);
    inMap = raw === "" ? key : null;
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        const v: unknown = JSON.parse(raw);
        value = typeof v === "string" ? v : raw;
      } catch {
        problems.push(`${key}: bad double-quoted string`);
      }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) problems.push(`${key}: bad single-quoted string`);
      value = raw.slice(1, -1).replace(/''/g, "'");
    } else if (/: |\s#/.test(raw) || /^[[{&*!|>%@`]/.test(raw)) {
      problems.push(`${key}: a plain YAML value must not contain ": " or " #" or start with a YAML indicator; quote it`);
    }
    fields.set(key, value);
  }
  return { fields, bodyStart: end + 1, problems };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every problem found in a skill directory; empty when it is valid. */
export function validateSkill(dir: string): string[] {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return [`${file} is missing`];
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  const problems = [...fm.problems];
  const name = fm.fields.get("name") ?? "";
  if (name === "") problems.push("name is required");
  else {
    if (name.length > 64) problems.push("name is longer than 64 characters");
    if (!NAME.test(name)) problems.push(`name "${name}" must be lowercase letters, digits and single hyphens (kebab-case)`);
    if (name !== basename(dir)) problems.push(`name "${name}" must equal the directory name "${basename(dir)}"`);
  }
  const description = fm.fields.get("description") ?? "";
  if (description === "") problems.push("description is required");
  if (description.length > MAX_DESCRIPTION) problems.push(`description is ${description.length} characters; at most ${MAX_DESCRIPTION}`);
  if (description !== "" && !description.startsWith("Use when")) problems.push('description must put its triggers first ("Use when …")');
  const compat = fm.fields.get("compatibility") ?? "";
  if (compat === "") problems.push("compatibility is required here: say that the tabcap binary is installed separately");
  if (compat.length > MAX_COMPATIBILITY) problems.push(`compatibility is ${compat.length} characters; at most ${MAX_COMPATIBILITY}`);
  if (compat !== "" && (!/\btabcap\b/.test(compat) || !/Chrome for Testing/.test(compat))) problems.push("compatibility must name the tabcap binary and Chrome for Testing");
  if (fm.fields.get("license") !== "Apache-2.0") problems.push("license must be Apache-2.0");
  const body = text.split("\n").slice(fm.bodyStart);
  if (body.length >= MAX_BODY_LINES) problems.push(`the body has ${body.length} lines; keep it under ${MAX_BODY_LINES} (move detail to references/)`);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_SKILL_BYTES) problems.push(`SKILL.md is ${bytes} bytes; at most ${MAX_SKILL_BYTES} (move detail to references/)`);
  for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const target = m[1] ?? "";
    if (/^[a-z]+:/.test(target)) continue;
    if (!existsSync(join(dir, target))) problems.push(`link to ${target} points at nothing`);
  }
  for (const p of walk(dir)) {
    const rel = relative(dir, p).split(sep).join("/"); // Windows separators too
    if (rel !== "SKILL.md" && !/^references\/[^/]+\.md$/.test(rel) && !rel.startsWith("scripts/")) problems.push(`unexpected file ${rel} (only SKILL.md, references/*.md, scripts/)`);
    if (/\.(sh|bash|zsh|command|ps1|bat)$/i.test(rel) || /(^|\/)install/i.test(rel)) problems.push(`${rel}: no install or shell scripts inside the skill`);
    const content = readFileSync(p, "utf8");
    for (const [re, why] of RISKY) if (re.test(content)) problems.push(`${rel} ${why}`);
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "skills", "tabcap");
  const problems = validateSkill(dir);
  for (const p of problems) console.log(`invalid: ${p}`);
  if (problems.length === 0) console.log(`valid: ${dir}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
