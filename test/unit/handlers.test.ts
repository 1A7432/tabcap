// The handler table beside the command registry (src/cli/handlers.ts, review
// wave 3): what the CLI does for each command of src/cli/commands.ts. Every
// command without a daemon action has a local run, a daemon command has no
// local run, every `--text` output flag is rendered (or the command says why
// its `--text` leaves the answer JSON), and the table names no command the
// registry lacks. Offline: it reads the two tables only.
// Reproduce: bun test test/unit/handlers.test.ts

import { describe, expect, test } from "bun:test";
import { COMMANDS, type CommandSpec } from "../../src/cli/commands.ts";
import { HANDLERS } from "../../src/cli/main.ts";

const name = (c: CommandSpec): string => c.path.join(" ");
const handler = (c: CommandSpec) => (Object.hasOwn(HANDLERS, name(c)) ? HANDLERS[name(c)] : undefined);
/** A boolean `--text`: the command offers a text form of its answer. */
const hasTextFlag = (c: CommandSpec): boolean => c.flags.some((f) => (f.flag === "--text" || f.alias === "--text") && f.kind === "bool");

describe("handler table (src/cli/handlers.ts)", () => {
  test("every command without a daemon action (internal ones too) has a local run", () => {
    const missing = COMMANDS.filter((c) => c.action === undefined && handler(c)?.run === undefined).map(name);
    expect(missing).toEqual([]);
  });

  test("a daemon command has no local run; daemon hooks only on daemon commands", () => {
    for (const c of COMMANDS) {
      const h = handler(c);
      if (h === undefined) continue;
      if (c.action !== undefined) expect([name(c), h.run]).toEqual([name(c), undefined]);
      else expect([name(c), h.prepare, h.fallback, h.output, h.render]).toEqual([name(c), undefined, undefined, undefined, undefined]);
    }
  });

  test("every command with a boolean --text renders it, or says why it stays JSON (never both)", () => {
    const text = COMMANDS.filter(hasTextFlag);
    expect(text.map(name)).toContain("status");
    expect(text.map(name)).toContain("html");
    for (const c of text) {
      const h = handler(c);
      const rendered = h?.render !== undefined || h?.rendersText === true;
      expect([name(c), rendered || h?.jsonOnly !== undefined]).toEqual([name(c), true]);
      expect([name(c), rendered && h?.jsonOnly !== undefined]).toEqual([name(c), false]);
    }
  });

  test("the table names registry commands only", () => {
    const known = new Set(COMMANDS.map(name));
    expect(Object.keys(HANDLERS).filter((k) => !known.has(k))).toEqual([]);
  });
});
