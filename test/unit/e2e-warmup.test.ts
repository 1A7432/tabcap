// The CI e2e warm-up (scripts/e2e-warmup.ts) without a browser: its CLI calls
// parse against the command table (a renamed command or flag would otherwise
// only show up as a failed warm-up step in CI), and its page is a data: URL that
// navigate accepts, so the warm-up contacts nothing.

import { describe, expect, test } from "bun:test";
import { WARMUP_PAGE, warmupSteps } from "../../scripts/e2e-warmup.ts";
import { matchCommand, parseCommand } from "../../src/cli/commands.ts";
import { checkUrl } from "../../src/daemon/tools/navigate.ts";

describe("e2e warm-up", () => {
  test("daemon start, browser start (--proxy none, the given binary), navigate, screenshot, browser stop", () => {
    const paths: string[] = [];
    for (const argv of warmupSteps("/cft/chrome")) {
      const c = matchCommand(argv);
      if (c === null) throw new Error(`no command for ${argv.join(" ")}`);
      paths.push(c.path.join(" "));
      const p = parseCommand(c, argv.slice(c.path.length));
      expect(p.help).toBe(false);
      if (c.path.join(" ") === "browser start") expect(p.args).toMatchObject({ proxy: "none", executablePath: "/cft/chrome" });
      if (c.path[0] === "navigate" || c.path[0] === "screenshot") expect(p.session).toBe("warmup");
    }
    expect(paths).toEqual(["daemon start", "browser start", "navigate", "screenshot", "browser stop"]);
  });

  test("the page is a data: URL navigate accepts, with something to draw", () => {
    expect(WARMUP_PAGE.startsWith("data:text/html,")).toBe(true);
    expect(checkUrl(WARMUP_PAGE)).toBe(WARMUP_PAGE);
    const html = decodeURIComponent(WARMUP_PAGE.slice("data:text/html,".length));
    expect(html).toContain("<title>tabcap warm-up</title>");
    expect(html).toContain("animation:");
  });
});
