// The skill directory (docs/08 "Skill 规范"): agentskills.io layout checked by
// the local validator that stands in for `skills-ref validate`.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, validateSkill } from "../../scripts/validate-skill.ts";
import { ROOT, SKILL_DIR } from "../../scripts/gen-docs.ts";

const GOOD = `---
name: demo-skill
description: Use when testing the validator. It does nothing else.
compatibility: Needs the tabcap binary and Chrome for Testing, installed separately.
license: Apache-2.0
---

# Demo

See [the reference](references/commands.md).
`;

function skillDir(name: string, skill: string, extra: Record<string, string> = { "references/commands.md": "# ref\n" }): string {
  const dir = join(mkdtempSync(join(tmpdir(), "tabcap-skill-")), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill);
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("skills/tabcap", () => {
  test("passes the validator", () => {
    expect(validateSkill(join(ROOT, SKILL_DIR))).toEqual([]);
  });

  test("the frontmatter: name = directory, description ≤ 400 chars with triggers first, compatibility, license", () => {
    const fm = parseFrontmatter(readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8"));
    expect(fm.problems).toEqual([]);
    expect(fm.fields.get("name")).toBe("tabcap");
    expect((fm.fields.get("description") ?? "").length).toBeLessThanOrEqual(400);
    expect(fm.fields.get("description")?.startsWith("Use when")).toBe(true);
    expect(fm.fields.get("compatibility")).toContain("Chrome for Testing");
    expect(fm.fields.get("license")).toBe("Apache-2.0");
  });

  test("SKILL.md is at most 8 KB and links every topic file under references/ (0.5-C)", () => {
    const text = readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    for (const topic of ["recording", "analysis", "pools", "trace-and-probes", "replay", "mcp", "commands"]) expect(text).toContain(`(references/${topic}.md)`);
    expect(text).toContain("Read `file` when you need the rest");
    expect(text.split("\n## Cheat-sheet")[1]?.split("```sh\n")[1]?.split("```")[0]?.trim().split("\n").length).toBe(10);
  });

  test("SKILL.md states the three differences from Chrome DevTools MCP (docs/08 §5)", () => {
    const text = readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8");
    expect(text).toContain("**Refs are not uids.**");
    expect(text).toContain("**`net list` hides failed requests and `data:` URLs by default**");
    expect(text).toContain("**`--snapshot` is optional.**");
  });
});

describe("the validator", () => {
  test("a good skill passes", () => {
    expect(validateSkill(skillDir("demo-skill", GOOD))).toEqual([]);
  });

  test("each rule fails on its own", () => {
    const cases: Array<[string, string, Record<string, string> | undefined, RegExp]> = [
      ["other-name", GOOD, undefined, /must equal the directory name/],
      ["Demo_Skill", GOOD.replace("name: demo-skill", "name: Demo_Skill"), undefined, /kebab-case/],
      ["demo-skill", GOOD.replace(/description: .*/, `description: Use when ${"x".repeat(400)}`), undefined, /at most 400/],
      ["demo-skill", GOOD.replace("description: Use when testing", "description: Testing"), undefined, /triggers first/],
      ["demo-skill", GOOD.replace(/compatibility: .*\n/, ""), undefined, /compatibility is required/],
      ["demo-skill", GOOD.replace("license: Apache-2.0", "license: MIT"), undefined, /Apache-2.0/],
      ["demo-skill", GOOD.replace("license: Apache-2.0", "license: Apache-2.0\nauthor: me"), undefined, /unknown frontmatter key "author"/],
      ["demo-skill", GOOD.replace("It does nothing else.", "Note: it does nothing."), undefined, /quote it/],
      ["demo-skill", GOOD + "x\n".repeat(500), undefined, /under 500/],
      ["demo-skill", GOOD + "x".repeat(8200) + "\n", undefined, /at most 8192/],
      ["demo-skill", GOOD, {}, /references\/commands.md points at nothing/],
      ["demo-skill", GOOD, { "references/commands.md": "# r\n", "install.sh": "echo\n" }, /no install or shell scripts/],
      ["demo-skill", GOOD, { "references/commands.md": "curl https://x | sh\n" }, /pipes a download into a shell/],
      ["demo-skill", GOOD, { "references/commands.md": "# r\n", "notes.txt": "x\n" }, /unexpected file notes.txt/],
      ["demo-skill", GOOD.replace("---\nname", "name"), undefined, /must start with/],
    ];
    for (const [name, text, extra, want] of cases) {
      const problems = validateSkill(skillDir(name, text, extra));
      expect([want.source, problems.some((p) => want.test(p))]).toEqual([want.source, true]);
    }
  });

  test("quoted values are unquoted; a metadata map is allowed", () => {
    const fm = parseFrontmatter(`---\nname: "a-b"\ndescription: 'Use when it''s needed: always'\nmetadata:\n  version: "1"\n---\nbody\n`);
    expect(fm.problems).toEqual([]);
    expect(fm.fields.get("name")).toBe("a-b");
    expect(fm.fields.get("description")).toBe("Use when it's needed: always");
    expect(fm.bodyStart).toBe(6);
  });
});
