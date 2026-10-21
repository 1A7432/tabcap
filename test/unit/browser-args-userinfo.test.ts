// `browser start` / `browser status` answer the browser's full command line
// (`args`, with `extraArgs` / `dropArgs` / `dropArgsUnmatched`, docs/04 §42).
// Review 10-21 (owner decision): a URL value there has its userinfo removed
// (`scheme://user:pass@host` -> `scheme://host`); nothing else changes, the
// home directory included (an answer is not evidence; the manifest has its
// own rules). Review wave 3: `tabcap status`'s `browser.extraArgs` / `dropArgs`
// too. The browser is the fake in _fakechrome.ts; the pure part is
// launchargs.ts's withoutUrlCredentials.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { withoutUrlCredentials } from "../../src/shared/launchargs.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

describe("withoutUrlCredentials", () => {
  test("only the userinfo of URL values goes; paths, the profile and other switches stay", () => {
    const home = homedir();
    expect(
      withoutUrlCredentials([
        "--start-url=https://alice:pw1@a.example/x",
        "--user-data-dir=" + join(home, "p"),
        "--load-extension=" + join(home, "e"),
        "--list=http://u@b.example/,ftp://v:w@c.example/y",
        "--lang=en-US",
        "--no-sandbox",
        "https://positional:pw@d.example/",
      ]),
    ).toEqual([
      "--start-url=https://a.example/x",
      "--user-data-dir=" + join(home, "p"),
      "--load-extension=" + join(home, "e"),
      "--list=http://b.example/,ftp://c.example/y",
      "--lang=en-US",
      "--no-sandbox",
      "https://positional:pw@d.example/",
    ]);
  });
});

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

describe.skipIf(!FAKE_CHROME)("browser start / browser status answers (fake browser; POSIX)", () => {
  test(
    "args, extraArgs and dropArgs carry no URL credentials; the browser itself got them as given",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tabcap-bargs-"));
      roots.push(dir);
      const p = paths({ TABCAP_HOME: dir });
      mkdirSync(p.config, { recursive: true, mode: 0o700 });
      const d = new Daemon(p);
      daemons.push(d);
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      const exe = fakeChrome(dir, {});
      const arg = "--start-url=https://alice:secretpw@a.example/x";
      const started = await run("browser.start", { executablePath: exe, proxy: "none", chromeArg: [arg] });
      if (!started.ok || !isRecord(started.data)) throw new Error(JSON.stringify(started));
      const status = await run("browser.status");
      if (!status.ok || !isRecord(status.data)) throw new Error(JSON.stringify(status));
      const again = await run("browser.start", {});
      if (!again.ok || !isRecord(again.data)) throw new Error(JSON.stringify(again));
      for (const a of [started.data, status.data, again.data]) {
        expect(JSON.stringify(a)).not.toContain("secretpw");
        expect(a["args"]).toContain("--start-url=https://a.example/x");
        expect(a["extraArgs"]).toEqual(["--start-url=https://a.example/x"]);
      }
      expect(d.browser?.info.args).toContain(arg);
    },
    SLOW_IO_MS,
  );

  test(
    "tabcap status's browser.extraArgs / dropArgs lose URL credentials as well (review wave 3)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tabcap-bargs-"));
      roots.push(dir);
      const p = paths({ TABCAP_HOME: dir });
      mkdirSync(p.config, { recursive: true, mode: 0o700 });
      const d = new Daemon(p);
      daemons.push(d);
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      const exe = fakeChrome(dir, {});
      const started = await run("browser.start", { executablePath: exe, proxy: "none", chromeArg: ["--start-url=https://alice:secretpw@a.example/x"], dropChromeArg: ["--homepage=https://bob:droppw@b.example/"] });
      if (!started.ok) throw new Error(JSON.stringify(started));
      const status = await run("status");
      if (!status.ok || !isRecord(status.data) || !isRecord(status.data["browser"])) throw new Error(JSON.stringify(status));
      const browser = status.data["browser"];
      expect(JSON.stringify(browser)).not.toContain("secretpw");
      expect(JSON.stringify(browser)).not.toContain("droppw");
      expect(browser["extraArgs"]).toEqual(["--start-url=https://a.example/x"]);
      expect(browser["dropArgs"]).toEqual(["--homepage=https://b.example/"]);
      expect(d.browser?.info.dropArgs).toEqual(["--homepage=https://bob:droppw@b.example/"]);
    },
    SLOW_IO_MS,
  );
});
