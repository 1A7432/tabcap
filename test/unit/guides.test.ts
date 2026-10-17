// 0.7-A task guides (src/cli/guides.ts): the registry cannot drift from the
// command registry (every `tabcap …` command a guide names parses with
// src/cli/commands.ts), `tabcap guide [<id>] [--text]`, the MCP
// `tabcap_help {guide}` argument and the SKILL.md task section.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCommonFlag, matchCommand, parseCommand } from "../../src/cli/commands.ts";
import { GUIDES, GUIDE_IDS, guideList, guideOf, renderGuideText } from "../../src/cli/guides.ts";
import { run, takeOutputFlags } from "../../src/cli/main.ts";
import { HELP, buildTools, callTool } from "../../src/mcp/tools.ts";
import { parseRulesDoc } from "../../src/replay/rules.ts";
import { ok } from "../../src/shared/envelope.ts";
import { ROOT, SKILL_DIR } from "../../scripts/gen-docs.ts";

/**
 * Split one plain shell command into words: single quotes literal, double
 * quotes with \" and \\, a backslash outside quotes escapes one character.
 * Unquoted operators, expansions and globs are refused: a guide's tabcap
 * command must paste into any shell unchanged.
 */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? "";
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unclosed ' in ${cmd}`);
      cur += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      inWord = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        const c = cmd[i] ?? "";
        if (c === "$" || c === "`") throw new Error(`expansion inside "…" in ${cmd}`);
        if (c === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) cur += cmd[++i] ?? "";
        else cur += c;
      }
      if (i >= cmd.length) throw new Error(`unclosed " in ${cmd}`);
    } else if (ch === "\\") {
      cur += cmd[++i] ?? "";
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else if ("|;&<>()$`*?[]{}~#".includes(ch)) {
      throw new Error(`unquoted ${ch} in ${cmd}`);
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** Parse a `tabcap …` command line the way the CLI does (output flags first, then the command's own parser); returns the command path. */
function checkTabcap(cmd: string): string {
  const words = shellWords(cmd);
  if (words[0] !== "tabcap") throw new Error(`not a tabcap command: ${cmd}`);
  const { rest } = takeOutputFlags(words.slice(1));
  const c = matchCommand(rest.filter((a) => !a.startsWith("-")));
  if (c === null || c.internal === true) throw new Error(`no such command: ${cmd}`);
  const argv = [...rest];
  for (const w of c.path) argv.splice(argv.indexOf(w), 1);
  const parsed = parseCommand(c, argv);
  if (parsed.help) throw new Error(`asks for help: ${cmd}`);
  for (const f of c.flags) if (f.required === true && !(f.key in parsed.args)) throw new Error(`missing ${f.flag}: ${cmd}`);
  if (c.flags.some((f) => isCommonFlag(f, ["--session"])) && parsed.session === null) throw new Error(`no --session: ${cmd}`);
  return c.path.join(" ");
}

/** The backticked `tabcap …` spans of a line. */
const tabcapSpans = (line: string): string[] => [...line.matchAll(/`(tabcap [^`]+)`/g)].map((m) => m[1] ?? "");

describe("the guide registry", () => {
  test("five guides in the agreed order, unique kebab-case ids, one-line fields", () => {
    expect(GUIDE_IDS).toEqual(["first-look", "scrape-through-browser", "encrypted-site", "offline-replay", "login-with-challenge"]);
    for (const g of GUIDES) {
      expect(g.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      for (const line of [g.title, g.when, ...g.watch, ...g.steps.flatMap((s) => [s.cmd, s.why])]) {
        expect(line.trim().length).toBeGreaterThan(0);
        expect(line).not.toContain("\n");
      }
      expect([g.id, g.steps.length >= 5 && g.steps.length <= 10]).toEqual([g.id, true]);
      expect(g.watch.length).toBeGreaterThan(0);
      expect(g.read.length).toBeGreaterThan(0);
      for (const r of g.read) expect([r, existsSync(join(ROOT, SKILL_DIR, r))]).toEqual([r, true]);
    }
  });

  test("every tabcap command in steps and every `tabcap …` span in watch parses with the command registry, with --session where it applies", () => {
    let checked = 0;
    for (const g of GUIDES) {
      for (const s of g.steps) {
        if (!s.cmd.startsWith("tabcap ")) continue;
        expect(() => checkTabcap(s.cmd)).not.toThrow();
        checked++;
      }
      for (const w of g.watch) {
        for (const span of tabcapSpans(w)) {
          expect(() => checkTabcap(span)).not.toThrow();
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  test("the check catches drift: an unknown command, an unknown flag, a missing --session or required flag, a bad positional count, an unquoted glob", () => {
    for (const bad of [
      "tabcap plugin init --kind decode ./x",
      "tabcap fetch https://example.com/ --referrer https://example.com/ --session s",
      "tabcap net list --resource-types xhr,fetch",
      "tabcap where --session s",
      "tabcap guard resume --session s",
      "tabcap net body r-1 extra --session s",
      "tabcap fetch /api/items?page=2 --session s",
    ]) {
      expect([bad, (() => { try { checkTabcap(bad); return "parsed"; } catch { return "refused"; } })()]).toEqual([bad, "refused"]);
    }
    expect(checkTabcap("tabcap net list --grep /api/ --fields id,url --session s")).toBe("net list");
    expect(checkTabcap("tabcap replay export-python ./b --out ./client")).toBe("replay export-python");
  });

  test("`tabcap guide <id>` mentions point at existing guides; the replay rules a guide writes are valid rules", () => {
    for (const g of GUIDES) {
      const text = [g.when, ...g.watch, ...g.steps.flatMap((s) => [s.cmd, s.why])].join("\n");
      for (const m of text.matchAll(/tabcap guide ([a-z-]+)/g)) expect(GUIDE_IDS).toContain(m[1] ?? "");
    }
    const printf = guideOf("offline-replay").steps.find((s) => s.cmd.startsWith("printf "))?.cmd ?? "";
    const json = /'(\{.*\})'/.exec(printf)?.[1] ?? "";
    const rules = parseRulesDoc(JSON.parse(json), "rules", { requireSchema: true, where: "guide" });
    expect(rules[0]).toMatchObject({ prefer: "2xx", key: { ignoreQuery: ["t", "nonce"], body: "json" } });
  });
});

describe("tabcap guide", () => {
  test("no id: the list (id, title, when) as JSON; --text one entry per guide", async () => {
    const r = await run(["guide"]);
    expect(r.code).toBe(0);
    expect(r.text).toBeUndefined();
    expect(r.envelope).toEqual(ok(guideList()));
    const t = await run(["guide", "--text"]);
    for (const g of GUIDES) expect(t.text).toContain(`  ${g.id}`);
  });

  test("an id: the guide as JSON; --text a numbered shell block with # why comments", async () => {
    const r = await run(["guide", "offline-replay"]);
    expect(r.envelope).toEqual(ok(guideOf("offline-replay")));
    const t = await run(["guide", "scrape-through-browser", "--text"]);
    expect(t.code).toBe(0);
    const g = guideOf("scrape-through-browser");
    expect(t.text).toBe(renderGuideText(g));
    const lines = (t.text ?? "").split("\n");
    g.steps.forEach((s, i) => {
      const at = lines.indexOf(`# ${i + 1}. ${s.why}`);
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(s.cmd);
    });
    expect(lines.filter((l) => l.startsWith("# - ")).length).toBe(g.watch.length);
  });

  test("an unknown id is a usage error listing the guides; output filters work on the JSON", async () => {
    const r = await run(["guide", "nope"]);
    expect(r.code).toBe(2);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "usage", message: 'no guide "nope"' } });
    if (r.envelope.ok) throw new Error("expected failure");
    for (const id of GUIDE_IDS) expect(r.envelope.error.next).toContain(id);
    const sel = await run(["guide", "first-look", "--select", "steps[*].cmd"]);
    expect(sel.envelope).toMatchObject({ ok: true, data: guideOf("first-look").steps.map((s) => s.cmd) });
  });

  test("the help index starts with the Start here group", async () => {
    const help = (await run(["--help"])).text ?? "";
    const groups = help.split("\n").filter((l) => /^[A-Z].*\[[a-z]+\]:$/.test(l));
    expect(groups[0]).toBe("Start here [start]:");
    expect(help).toContain("  guide  task recipes, start here");
  });
});

describe("MCP tabcap_help {guide}", () => {
  const help = buildTools("core").find((t) => t.def.name === HELP);
  const call = async (args: Record<string, unknown>) => {
    if (help === undefined) throw new Error("no tabcap_help");
    return callTool(help, args, () => Promise.resolve(ok({})), { now: () => 0, sleep: () => Promise.resolve() });
  };

  test('guide "" lists, an id gives the same guide as the CLI; bad arguments are usage errors', async () => {
    expect(help?.def.inputSchema.properties).toEqual({ command: { type: "string" }, guide: { type: "string" } });
    expect(await call({ guide: "" })).toEqual(ok(guideList()));
    expect(await call({ guide: "encrypted-site" })).toEqual(ok(guideOf("encrypted-site")));
    expect(await call({ guide: "nope" })).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(await call({ guide: 1 })).toMatchObject({ ok: false, error: { code: "usage", message: "guide must be a string" } });
    expect(await call({ guide: "first-look", command: "net list" })).toMatchObject({ ok: false, error: { code: "usage" } });
  });
});

describe("SKILL.md by task (0.7-A)", () => {
  test("a Tasks section that ends each task in `tabcap guide <id>`, a link to references/guides.md, the DevTools MCP section moved out", () => {
    const skill = readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8");
    const tasks = skill.split("\n## Tasks\n")[1]?.split("\n## ")[0] ?? "";
    const paras = tasks.split("\n").filter((l) => l.startsWith("**"));
    expect(paras.length).toBe(GUIDES.length);
    paras.forEach((p, i) => expect(p.endsWith(`\`tabcap guide ${GUIDE_IDS[i] ?? ""}\``)).toBe(true));
    expect(skill).toContain("(references/guides.md)");
    expect(skill).not.toContain("## Record → analyse → replay");
    expect(skill).not.toContain("## If you know Chrome DevTools MCP");
  });
});
