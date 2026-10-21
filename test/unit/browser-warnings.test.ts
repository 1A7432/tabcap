// Review 10-21 (owner decision): switches that weaken the browser's isolation
// are passed on (docs/04 §42, "only refuse what breaks tabcap") but named in
// `warnings` of `browser start` / `browser status` and of `tabcap status`'s
// browser section (§35). The list is the owner's: --no-sandbox,
// --disable-web-security, --remote-allow-origins, a --remote-debugging-port the
// user set, --allow-running-insecure-content, --ignore-certificate-errors,
// --host-resolver-rules, --proxy-pac-url. The browser is the fake in _fakechrome.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { buildArgsReport, isolationWarnings, parseProxy, type CustomArgs } from "../../src/daemon/transport/direct/launcher.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const WEAKENING = [
  "--no-sandbox",
  "--disable-web-security",
  "--remote-allow-origins=*",
  "--remote-debugging-port=9222",
  "--allow-running-insecure-content",
  "--ignore-certificate-errors",
  "--host-resolver-rules=MAP * 127.0.0.1",
  "--proxy-pac-url=http://127.0.0.1:9/p.pac",
];
const base = { profileDir: "/p", platform: "darwin" as const, proxy: parseProxy("system"), webdriver: "hidden" as const, extensionDir: null, noStartupWindow: true };
const final = (cdp: "pipe" | "port", custom: CustomArgs) => buildArgsReport({ ...base, cdp, custom }).args;

describe("isolationWarnings (docs/04 §42)", () => {
  test("one sentence per weakening switch in the final command line, each starting with the switch name", () => {
    const custom = { add: WEAKENING, drop: [] };
    const w = isolationWarnings(final("pipe", custom), custom);
    expect(w).toHaveLength(WEAKENING.length);
    WEAKENING.forEach((sw, i) => expect(w[i]?.startsWith(`${sw.split("=")[0] ?? ""}: `)).toBe(true));
    for (const x of w) expect(x.length).toBeGreaterThan(40);
  });

  test("tabcap's own command line has none, also in port mode (its --remote-debugging-port=0 is not the user's)", () => {
    expect(isolationWarnings(final("pipe", { add: [], drop: [] }), { add: [], drop: [] })).toEqual([]);
    const port = final("port", { add: [], drop: [] });
    expect(port).toContain("--remote-debugging-port=0");
    expect(isolationWarnings(port, { add: [], drop: [] })).toEqual([]);
    const mine = { add: ["--remote-debugging-port=9333"], drop: [] };
    expect(isolationWarnings(final("port", mine), mine).map((x) => x.split(":")[0])).toEqual(["--remote-debugging-port"]);
  });

  test("a weakening switch the user drops again is not in the command line, so not warned", () => {
    const custom = { add: ["--no-sandbox"], drop: [] };
    const args = final("pipe", custom).filter((a) => a !== "--no-sandbox");
    expect(isolationWarnings(args, custom)).toEqual([]);
  });
});

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

function home(): { d: Daemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-bwarn-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  const d = new Daemon(p);
  daemons.push(d);
  return { d, dir };
}

type Env = Awaited<ReturnType<typeof handleCommand>>;
const run = (d: Daemon, action: string, args: Record<string, unknown> = {}): Promise<Env> => handleCommand(d, { action, args, session: "a" }, () => undefined);
const data = (env: Env): Record<string, unknown> => {
  if (!env.ok || !isRecord(env.data)) throw new Error(JSON.stringify(env));
  return env.data;
};

describe.skipIf(!FAKE_CHROME)("warnings in browser start / browser status / status (fake browser; POSIX)", () => {
  test(
    "named switches: the same warnings in all three answers; none: an empty list; no browser: status says null",
    async () => {
      const { d, dir } = home();
      const statusBrowser = async (): Promise<Record<string, unknown>> => {
        const b = data(await run(d, "status"))["browser"];
        return isRecord(b) ? b : {};
      };
      expect((await statusBrowser())["warnings"]).toBeNull();
      const exe = fakeChrome(dir, {});
      const started = data(await run(d, "browser.start", { executablePath: exe, proxy: "none", chromeArg: ["--no-sandbox", "--ignore-certificate-errors", "--lang=en-US"] }));
      const w = started["warnings"];
      expect(Array.isArray(w) ? w.map((x) => String(x).split(":")[0]) : w).toEqual(["--no-sandbox", "--ignore-certificate-errors"]);
      expect(data(await run(d, "browser.status"))["warnings"]).toEqual(w);
      expect((await statusBrowser())["warnings"]).toEqual(w);
      expect(data(await run(d, "browser.start", {}))["warnings"]).toEqual(w); // already running: the running browser's
      await run(d, "browser.stop");
      const plain = data(await run(d, "browser.start", { executablePath: exe, proxy: "none" }));
      expect(plain["warnings"]).toEqual([]);
    },
    SLOW_IO_MS,
  );
});
