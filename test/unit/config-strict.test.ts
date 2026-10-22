// Review wave 3 (owner 2026-10-21, docs/04 §44): a config.json that exists
// but is not valid JSON (or is not a JSON object) is an error on every path
// that reads it — never an empty config, never the defaults. The error names
// the file and the line / column of the first syntax error; `tabcap setup`
// refuses to rewrite such a file (no backup, no change); the replay rules from
// config.json go through the same reader. Expected positions: RFC 8259's
// grammar applied by hand to the texts below. Owner 2026-10-22: `tabcap
// status` is the exception: it keeps its whole view (a waiting handoff stays
// visible) and answers the same error in `config.error`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/main.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { offlineStatus, renderStatusText } from "../../src/daemon/tools/status.ts";
import { loadRules, rulesFromConfig } from "../../src/replay/rules.ts";
import {
  readChromeArgsConfig,
  readConfig,
  readConfigRaw,
  readFetchConfig,
  readHandoffConfig,
  readPoolConfig,
  readProtectionConfig,
  readRecordBodies,
  readSiteGuards,
  readTraceConfig,
  writeConfig,
} from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord, jsonSyntaxErrorAt } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-cfgstrict-"));
  roots.push(d);
  return d;
};
afterAll(async () => {
  for (const r of roots.splice(0)) await removeTree(r);
}, SLOW_IO_MS);

function thrown(f: () => unknown): TabcapError {
  try {
    f();
  } catch (e) {
    if (e instanceof TabcapError) return e;
    throw new Error(`expected a TabcapError, got ${String(e)}`);
  }
  throw new Error("expected an error");
}

describe("jsonSyntaxErrorAt: the offset of the first syntax error (RFC 8259)", () => {
  test("valid documents: null", () => {
    for (const t of ['{"a":1}', " [1, 2.5e-3, -0, true, false, null] ", '"x\\u00e9\\n"', '{"a":{"b":[{}, [], ""]}}', "0"]) expect(jsonSyntaxErrorAt(t)).toBeNull();
  });
  test("the position of what is wrong", () => {
    expect(jsonSyntaxErrorAt('{"a":1,}')).toBe(7); // trailing comma: the "}" where a name must be
    expect(jsonSyntaxErrorAt('{"a" 1}')).toBe(5); // the value where ":" must be
    expect(jsonSyntaxErrorAt('{"a":1}}')).toBe(7); // text after the document
    expect(jsonSyntaxErrorAt("[1,2")).toBe(4); // the end, where "]" must be
    expect(jsonSyntaxErrorAt("")).toBe(0);
    expect(jsonSyntaxErrorAt("﻿{}")).toBe(0); // a byte order mark is not JSON
    expect(jsonSyntaxErrorAt('{"a":tru}')).toBe(5);
    expect(jsonSyntaxErrorAt('{"a":01}')).toBe(6); // a leading zero ends the number
    expect(jsonSyntaxErrorAt('{"a":"x\ny"}')).toBe(7); // a raw control character in a string
    expect(jsonSyntaxErrorAt('{"a":"\\q"}')).toBe(7); // a bad escape
    expect(jsonSyntaxErrorAt("{'a':1}")).toBe(1);
    expect(jsonSyntaxErrorAt('{"a":[1,]}')).toBe(8);
  });
  test("deep nesting does not overflow the stack", () => {
    expect(jsonSyntaxErrorAt("[".repeat(200_000))).toBe(200_000);
  });
});

describe("config.json that is not valid JSON: every reader refuses (docs/04 §44)", () => {
  const broken = (text = '{\n  "sites": {"x": {"guard": {"stopOn": ["status>=403"]}}},\n  "pool": {"budget": {"requestsPerHour": 10}},\n}\n'): string => {
    const f = join(tmp(), "config.json");
    writeFileSync(f, text);
    return f;
  };

  const readers: Array<[string, (f: string) => unknown]> = [
    ["readConfigRaw", (f) => readConfigRaw(f)],
    ["readConfig (setup, browser start)", (f) => readConfig(f)],
    ["readChromeArgsConfig (browser start)", (f) => readChromeArgsConfig(f)],
    ["readHandoffConfig (browser start)", (f) => readHandoffConfig(f)],
    ["readProtectionConfig (browser start)", (f) => readProtectionConfig(f)],
    ["readPoolConfig (pool, proxy check)", (f) => readPoolConfig(f)],
    ["readFetchConfig (fetch, replay check --live)", (f) => readFetchConfig(f, null)],
    ["readFetchConfig for a site", (f) => readFetchConfig(f, "x")],
    ["readRecordBodies (net start)", (f) => readRecordBodies(f)],
    ["readSiteGuards (net start, fetch, the guard)", (f) => readSiteGuards(f)],
    ["readTraceConfig (trace start)", (f) => readTraceConfig(f)],
    ["rulesFromConfig (replay serve / check, export fixtures)", (f) => rulesFromConfig(f, "x")],
    ["loadRules without --rules", (f) => loadRules({ configFile: f, site: null })],
  ];

  for (const [name, read] of readers) {
    test(`${name}: bad-input naming the file and the line / column`, () => {
      const f = broken();
      const e = thrown(() => read(f));
      expect(e.code).toBe("bad-input");
      expect(e.message).toContain(f);
      expect(e.message).toContain("line 4, column 1");
      expect(e.next).toContain("move it away");
    });
  }

  test("the parser's own reason is kept", () => {
    const e = thrown(() => readConfigRaw(broken('{"a": x}')));
    expect(e.message).toContain("line 1, column 7");
    expect(e.message).toContain('"x"');
  });

  test("valid JSON that is not an object is refused too; an absent file is still the defaults", () => {
    for (const text of ["[]", "null", '"x"', "3"]) {
      const e = thrown(() => readConfig(broken(text)));
      expect(e.code).toBe("bad-input");
      expect(e.message).toContain("JSON object");
    }
    const absent = join(tmp(), "config.json");
    expect(readConfigRaw(absent)).toEqual({});
    expect(readPoolConfig(absent).strategy).toBe("fixed");
    expect(rulesFromConfig(absent, null).source.kind).toBe("none");
  });

  test("a file that cannot be read is io, not a silent default", () => {
    const dir = join(tmp(), "config.json");
    mkdirSync(dir);
    expect(thrown(() => readConfigRaw(dir)).code).toBe("io");
  });

  test("writeConfig refuses to rewrite it and leaves every byte as it was", () => {
    const f = broken();
    const before = readFileSync(f, "utf8");
    const e = thrown(() => writeConfig(f, { chrome: { executablePath: "/cft", version: "155", platform: null }, proxy: null, webdriver: null }));
    expect(e.code).toBe("bad-input");
    expect(readFileSync(f, "utf8")).toBe(before);
  });
});

describe("commands with an unparseable config.json answer the error", () => {
  const prevHome = process.env["TABCAP_HOME"];
  let home = "";
  beforeAll(() => {
    home = tmp();
    process.env["TABCAP_HOME"] = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env["TABCAP_HOME"];
    else process.env["TABCAP_HOME"] = prevHome;
  });
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  });

  test("tabcap setup refuses before anything else and does not touch the file", async () => {
    const p = paths({ TABCAP_HOME: home });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    const text = '{"chrome": {"args": ["--lang=en"]},}';
    writeFileSync(p.configFile, text);
    // A path that does not exist: had setup looked at it first, the answer would be not-found.
    const r = await run(["setup", "--executable-path", join(home, "no-such-chrome")]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "bad-input" } });
    if (r.envelope.ok) throw new Error("expected failure");
    expect(r.envelope.error.message).toContain(p.configFile);
    expect(r.envelope.error.message).toContain("line 1, column 36");
    expect(readFileSync(p.configFile, "utf8")).toBe(text);
  });

  test("browser start answers bad-input before it launches anything", async () => {
    const dir = tmp();
    const p = paths({ TABCAP_HOME: dir });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    writeFileSync(p.configFile, '{"webdriver": "visible",}');
    const d = new Daemon(p);
    daemons.push(d);
    const env = await handleCommand(d, { action: "browser.start", args: { executablePath: join(dir, "no-such-chrome") }, session: "a" }, () => undefined);
    expect(env).toMatchObject({ ok: false, error: { code: "bad-input" } });
    expect(d.browser).toBeNull();
  });
});

describe("tabcap status keeps its view and reports a broken config.json in config.error (owner 2026-10-22)", () => {
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  });
  // A trailing comma: the "}" at line 3, column 1 stands where a name must be (RFC 8259).
  const BROKEN = '{\n  "webdriver": "visible",\n}\n';

  function home(text: string | null): ReturnType<typeof paths> {
    const p = paths({ TABCAP_HOME: tmp() });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    if (text !== null) writeFileSync(p.configFile, text);
    return p;
  }

  test("tabcap status keeps the session view when config.json is broken", async () => {
    const p = home(BROKEN);
    const want = thrown(() => readConfigRaw(p.configFile));
    expect(want.message).toContain(p.configFile);
    expect(want.message).toContain("line 3, column 1");
    const d = new Daemon(p);
    daemons.push(d);
    d.sites.set("w", { site: "shop", account: "alice", proxy: null });
    d.guard.takeover("w", { tab: "t1", url: "https://shop.test/login", event: "pointerdown", at: 1 }, undefined);
    const env = await handleCommand(d, { action: "status", args: {}, session: "w" }, () => undefined);
    expect(env.ok).toBe(true);
    const data = env.ok && isRecord(env.data) ? env.data : {};
    expect(data["config"]).toEqual({ warnings: [], error: { code: "bad-input", message: want.message, next: want.next } });
    expect(data["handoff"]).toMatchObject([{ session: "w", reason: "human-takeover", site: "shop", url: "https://shop.test/login" }]);
    expect(data["sessions"]).toMatchObject([{ session: "w", site: "shop", account: "alice", state: "waiting", reason: "human-takeover" }]);
    expect(data["next"]).toContain("`tabcap handoff continue --session w`");
    // --text: the error and its next under the first line; the WAITING line is still there (no
    // browser, so no tab URL after it).
    const lines = renderStatusText(data).split("\n");
    expect(lines[0]).toStartWith("tabcap status · daemon pid ");
    expect(lines[1]).toBe(`config error: ${want.message}`);
    expect(lines[2]).toBe(`  next: ${want.next}`);
    expect(lines[3]).toBe("w: site shop (alice) · 0 tab(s) · not recording · WAITING human-takeover · trace off");
    expect(lines.some((l) => l.startsWith("warning:"))).toBe(false);
    // browser status still refuses with the same error (docs/04 §44).
    expect(await handleCommand(d, { action: "browser.status", args: {}, session: "w" }, () => undefined)).toMatchObject({ ok: false, error: { code: "bad-input", message: want.message } });
  });

  test("without a daemon (offlineStatus): the same config.error; --text puts it under the first line", () => {
    const p = home(BROKEN);
    const want = thrown(() => readConfigRaw(p.configFile));
    const off = offlineStatus(p.config, "unix");
    expect(off.config).toEqual({ warnings: [], error: { code: "bad-input", message: want.message, next: want.next } });
    expect(off.daemon).toEqual({ running: false, listener: "unix" });
    expect(off.plugins).toEqual({ decode: [], challenge: [] });
    expect(renderStatusText(off)).toBe(["tabcap status · daemon not running (`tabcap daemon start`) · plugins: none", `config error: ${want.message}`, `  next: ${want.next}`, "(no sessions)", "conflicts: none"].join("\n"));
  });

  test("a file that is not an object is bad-input, one that cannot be read is io; an absent one is no error", () => {
    const notObject = home("[]");
    const e = thrown(() => readConfigRaw(notObject.configFile));
    expect(e.message).toContain("JSON object");
    expect(offlineStatus(notObject.config, "unix").config).toEqual({ warnings: [], error: { code: "bad-input", message: e.message, next: e.next } });
    const unreadable = home(null);
    mkdirSync(unreadable.configFile);
    const io = offlineStatus(unreadable.config, "unix").config;
    expect(io.warnings).toEqual([]);
    expect(io.error?.code).toBe("io");
    expect(io.error?.message).toContain(unreadable.configFile);
    expect(offlineStatus(home(null).config, "unix").config).toEqual({ warnings: [], error: null });
  });
});
