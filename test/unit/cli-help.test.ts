import { describe, expect, test } from "bun:test";
import { helpRequest, run } from "../../src/cli/main.ts";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";

describe("help at two levels and --version (field report P2)", () => {
  test("`net list --help`, `-h`, `help net list` all give that command's help", async () => {
    for (const argv of [["net", "list", "--help"], ["net", "list", "-h"], ["help", "net", "list"], ["--help", "net", "list"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.text?.startsWith("Usage: tabcap net list")).toBe(true);
      expect(r.text).toContain("--failed");
    }
  });

  test("offline commands too: bundle export har, analyze find", async () => {
    expect((await run(["bundle", "export", "har", "--help"])).text?.startsWith("Usage: tabcap bundle export har <bundle>")).toBe(true);
    expect((await run(["analyze", "find", "-h"])).text?.startsWith("Usage: tabcap analyze find <bundle> <text>")).toBe(true);
  });

  test("a group lists its subcommands", async () => {
    const r = await run(["net", "--help"]);
    expect(r.code).toBe(0);
    for (const sub of ["start", "stop", "list", "body", "show", "wait"]) expect(r.text).toContain(`tabcap net ${sub}`);
    const tab = (await run(["tab", "-h"])).text;
    expect(tab).toContain("tabcap tab select <tab>");
    expect(tab).not.toContain("tab use");
  });

  test("an unknown command with --help is still a usage error; `--` ends help scanning", async () => {
    const r = await run(["frobnicate", "--help"]);
    expect(r.code).toBe(2);
    expect(r.envelope.ok).toBe(false);
    expect(helpRequest(["evaluate", "--", "--help"])).toBeNull();
    expect(helpRequest(["navigate", "http://x/"])).toBeNull();
  });

  test("--version prints the version envelope and exits 0", async () => {
    for (const argv of [["--version"], ["-V"], ["version"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.envelope).toEqual({ ok: true, data: { tool: "tabcap", version: TOOL_VERSION } });
      expect(r.text).toBeUndefined();
    }
  });
});
