// 0.8.1-A: custom Chrome args (docs/04 §42). Expected values follow the merge
// rules written in §42 before the code; Chrome keeps only the last occurrence
// of a repeated switch, so list switches must stay one switch each.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HIDE_WEBDRIVER_FLAG,
  applyCustomArgs,
  buildArgs,
  buildArgsReport,
  checkCustomArgs,
  effectiveProxyLabel,
  parseProxy,
  webdriverOf,
  type CustomArgs,
} from "../../src/daemon/transport/direct/launcher.ts";
import { readChromeArgsConfig, readConfig, writeConfig } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { manifestLaunch } from "../../src/daemon/tools/net.ts";
import { renderStatusText } from "../../src/daemon/tools/status.ts";
import { optStrList } from "../../src/daemon/tools/args.ts";

const base = { profileDir: "/p", platform: "darwin" as const, cdp: "pipe" as const, proxy: parseProxy("system"), webdriver: "hidden" as const, extensionDir: null, noStartupWindow: true };
const withCustom = (add: string[], drop: string[] = []) => buildArgsReport({ ...base, custom: { add, drop } });
const only = (args: string[], name: string): string[] => args.filter((a) => a === name || a.startsWith(`${name}=`));
const items = (args: string[], name: string): string[] => (only(args, name)[0] ?? "").replace(`${name}=`, "").split(",");
const usage = (f: () => void, text: string) => {
  try {
    f();
  } catch (e) {
    if (!(e instanceof TabcapError)) throw e;
    expect(e.code).toBe("usage");
    expect(e.message).toContain(text);
    return;
  }
  throw new Error("expected a usage error");
};

describe("applyCustomArgs (docs/04 §42)", () => {
  test("no custom args: the command line is tabcap's own", () => {
    expect(withCustom([]).args).toEqual(buildArgs(base));
    expect(withCustom([]).unmatched).toEqual([]);
  });

  test("a new switch is appended before positionals; a same-name switch replaces tabcap's", () => {
    const r = buildArgsReport({ ...base, noStartupWindow: false, custom: { add: ["--lang=en-US", "--force-color-profile=display-p3"], drop: [] } });
    expect(r.args[r.args.length - 1]).toBe("about:blank");
    expect(r.args[r.args.length - 2]).toBe("--force-color-profile=display-p3");
    expect(r.args).toContain("--lang=en-US");
    expect(only(r.args, "--force-color-profile")).toEqual(["--force-color-profile=display-p3"]);
  });

  test("the user's own repeated plain switch: the last one stays", () => {
    const a = withCustom(["--lang=fr", "--lang=de"]).args;
    expect(only(a, "--lang")).toEqual(["--lang=de"]);
  });

  test("--disable-features merges into tabcap's one switch", () => {
    const a = withCustom(["--disable-features=Foo,Bar"]).args;
    expect(only(a, "--disable-features")).toHaveLength(1);
    const f = items(a, "--disable-features");
    for (const x of ["PreconnectToSearch", "Translate", "PaintHolding", "Foo", "Bar"]) expect(f).toContain(x);
  });

  test("--enable-features=X takes X out of tabcap's --disable-features, and the reverse", () => {
    const a = withCustom(["--enable-features=ThirdPartyStoragePartitioning:mode/x", "--disable-features=CDPScreenshotNewSurface"]).args;
    expect(items(a, "--disable-features")).not.toContain("ThirdPartyStoragePartitioning");
    expect(items(a, "--disable-features")).toContain("CDPScreenshotNewSurface");
    expect(only(a, "--enable-features")).toEqual(["--enable-features=ThirdPartyStoragePartitioning:mode/x"]);
  });

  test("a list switch without a value adds nothing and keeps tabcap's list (Bugbot, PR #27)", () => {
    for (const bare of ["--disable-features", "--enable-features", "--disable-blink-features", "--disable-features="]) {
      expect(withCustom([bare]).args).toEqual(buildArgs(base));
    }
    expect(only(withCustom(["--enable-blink-features"]).args, "--enable-blink-features")).toEqual([]);
    expect(only(buildArgsReport({ ...base, extensionDir: "/ext", custom: { add: ["--load-extension"], drop: [] } }).args, "--load-extension")).toEqual(["--load-extension=/ext"]);
  });

  test("a list switch tabcap does not set is added once, merged with later ones", () => {
    const a = withCustom(["--enable-blink-features=A", "--enable-blink-features=B,A"]).args;
    expect(only(a, "--enable-blink-features")).toEqual(["--enable-blink-features=B,A"]);
  });

  test("blink pair and webdriver: the final command line decides", () => {
    expect(webdriverOf(buildArgs(base))).toBe("hidden");
    const merged = withCustom(["--disable-blink-features=Foo"]).args;
    expect(only(merged, "--disable-blink-features")).toEqual(["--disable-blink-features=AutomationControlled,Foo"]);
    expect(webdriverOf(merged)).toBe("hidden");
    const on = withCustom(["--enable-blink-features=AutomationControlled"]).args;
    expect(only(on, "--disable-blink-features")).toEqual([]);
    expect(webdriverOf(on)).toBe("visible");
    expect(webdriverOf(withCustom([], ["--disable-blink-features"]).args)).toBe("visible");
    expect(webdriverOf(buildArgsReport({ ...base, webdriver: "visible", custom: { add: [HIDE_WEBDRIVER_FLAG], drop: [] } }).args)).toBe("hidden");
  });

  test("--load-extension paths merge as written (no feature-name split)", () => {
    const a = buildArgsReport({ ...base, extensionDir: "/ext", custom: { add: ["--load-extension=C:\\x,/y"], drop: [] } }).args;
    expect(only(a, "--load-extension")).toEqual(["--load-extension=/ext,C:\\x,/y"]);
  });

  test("drops: a whole switch, list items, an exact plain switch; unmatched ones are reported", () => {
    const r = withCustom([], ["--disable-popup-blocking", "--disable-features=PreconnectToSearch,Translate", "--force-color-profile=srgb", "--no-such-switch", "--force-color-profile=other"]);
    expect(r.args).not.toContain("--disable-popup-blocking");
    expect(items(r.args, "--disable-features")).not.toContain("PreconnectToSearch");
    expect(items(r.args, "--disable-features")).not.toContain("Translate");
    expect(items(r.args, "--disable-features")).toContain("PaintHolding");
    expect(only(r.args, "--force-color-profile")).toEqual([]);
    expect(r.unmatched).toEqual(["--no-such-switch", "--force-color-profile=other"]);
  });

  test("dropping every item of a list removes the switch; drop runs before add", () => {
    const all = buildArgs(base).find((a) => a.startsWith("--disable-features=")) ?? "";
    expect(only(withCustom([], [all]).args, "--disable-features")).toEqual([]);
    const r = withCustom(["--disable-popup-blocking"], ["--disable-popup-blocking"]);
    expect(r.args).toContain("--disable-popup-blocking");
    expect(r.unmatched).toEqual([]);
  });

  test("pure: the base list is not modified", () => {
    const b = buildArgs(base);
    const copy = [...b];
    applyCustomArgs(b, { add: ["--disable-features=X"], drop: ["--disable-sync"] });
    expect(b).toEqual(copy);
  });
});

describe("checkCustomArgs (docs/04 §42)", () => {
  const sys = parseProxy("system");
  const check = (c: Partial<CustomArgs>, proxy = sys) => () => checkCustomArgs({ add: c.add ?? [], drop: c.drop ?? [] }, proxy);

  test("refuses only what breaks tabcap", () => {
    usage(check({ add: ["--user-data-dir=/x"] }), "--user-data-dir");
    usage(check({ add: ["--remote-debugging-pipe"] }), "--remote-debugging-pipe");
    usage(check({ drop: ["--user-data-dir"] }), "--user-data-dir");
    usage(check({ drop: ["--remote-debugging-port"] }), "--remote-debugging-port");
    usage(check({ drop: ["--remote-debugging-pipe"] }), "--remote-debugging-pipe");
  });

  test("not a switch: positionals, single dash, bare --", () => {
    usage(check({ add: ["about:blank"] }), "not a switch");
    usage(check({ add: ["-lang=en"] }), "not a switch");
    usage(check({ add: ["--"] }), "not a switch");
    usage(check({ add: ["--=x"] }), "not a switch");
    usage(check({ drop: ["https://example.com"] }), "not a switch");
  });

  test("proxy switches: allowed under --proxy system, a conflict otherwise", () => {
    expect(check({ add: ["--proxy-server=http://127.0.0.1:9"] })).not.toThrow();
    usage(check({ add: ["--proxy-server=http://127.0.0.1:9"] }, parseProxy("none")), "conflicts with --proxy none");
    usage(check({ add: ["--proxy-pac-url=http://x/p.pac"] }, parseProxy("http://127.0.0.1:8080")), "conflicts");
    expect(effectiveProxyLabel(sys, ["--proxy-server=http://127.0.0.1:9"])).toBe("chrome-arg");
    expect(effectiveProxyLabel(sys, buildArgs(base))).toBe("system");
    expect(effectiveProxyLabel(parseProxy("none"), buildArgs({ ...base, proxy: parseProxy("none") }))).toBe("none");
  });

  test("dropping a proxy switch: a conflict unless --proxy system, the same next as adding one (review 10-21)", () => {
    const none = parseProxy("none");
    const url = parseProxy("http://127.0.0.1:8080");
    for (const sw of ["--proxy-server", "--proxy-bypass-list", "--proxy-pac-url", "--no-proxy-server", "--proxy-auto-detect", "--proxy-server=127.0.0.1:1"]) {
      usage(check({ drop: [sw] }, none), "conflicts with --proxy none");
      usage(check({ drop: [sw] }, url), "conflicts with --proxy http://127.0.0.1:8080");
      expect(check({ drop: [sw] })).not.toThrow();
    }
    const nextOf = (f: () => void): string => {
      try {
        f();
      } catch (e) {
        if (e instanceof TabcapError) return e.next;
      }
      return "";
    };
    expect(nextOf(check({ drop: ["--proxy-server"] }, none))).toBe(nextOf(check({ add: ["--proxy-server=http://127.0.0.1:9"] }, none)));
  });

  test("everything else passes, including a debugging port, headless and certificate switches", () => {
    expect(check({ add: ["--remote-debugging-port=9222", "--headless=new", "--ignore-certificate-errors", "--user-agent=X Y/1.0", "--js-flags=--expose-gc"], drop: ["--no-startup-window"] })).not.toThrow();
  });
});

describe("config.json chrome.args / chrome.dropArgs (docs/04 §42)", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "tabcap-cfg081a-")), "config.json");

  test("absent → none; lists are read; anything else is bad-input naming the key", () => {
    const f = file();
    expect(readChromeArgsConfig(f)).toEqual({ add: [], drop: [] });
    writeFileSync(f, JSON.stringify({ chrome: { args: ["--lang=en"], dropArgs: ["--disable-sync"] } }));
    expect(readChromeArgsConfig(f)).toEqual({ add: ["--lang=en"], drop: ["--disable-sync"] });
    writeFileSync(f, JSON.stringify({ chrome: { args: "--x" } }));
    expect(() => readChromeArgsConfig(f)).toThrow("chrome.args");
    writeFileSync(f, JSON.stringify({ chrome: { dropArgs: [1] } }));
    expect(() => readChromeArgsConfig(f)).toThrow("chrome.dropArgs");
  });

  test("works without chrome.executablePath; `setup` rewriting chrome keeps args and dropArgs", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ chrome: { args: ["--lang=en"], dropArgs: ["--disable-sync"] }, pool: { strategy: "lru" } }));
    expect(readConfig(f).chrome).toBeNull();
    expect(readChromeArgsConfig(f).add).toEqual(["--lang=en"]);
    writeConfig(f, { ...readConfig(f), chrome: { executablePath: "/cft", version: "155", platform: "mac-arm64" } });
    const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    expect(raw["chrome"]).toEqual({ args: ["--lang=en"], dropArgs: ["--disable-sync"], executablePath: "/cft", version: "155", platform: "mac-arm64" });
    expect(raw["pool"]).toEqual({ strategy: "lru" });
  });

  test("--chrome-arg arrives as one string or a list", () => {
    expect(optStrList({}, "chromeArg")).toEqual([]);
    expect(optStrList({ chromeArg: "--a" }, "chromeArg")).toEqual(["--a"]);
    expect(optStrList({ chromeArg: ["--a", "--b"] }, "chromeArg")).toEqual(["--a", "--b"]);
    expect(() => optStrList({ chromeArg: [1] }, "chromeArg")).toThrow(TabcapError);
  });
});

describe("outputs (docs/04 §42)", () => {
  test("manifest: no local profile or extension path, known secrets replaced", () => {
    const args = buildArgsReport({ ...base, profileDir: "/Users/someone/.local/share/tabcap/profiles/default", extensionDir: "/Users/someone/ext", custom: { add: ["--user-agent=tok-SECRET"], drop: [] } }).args;
    const m = manifestLaunch({ args, extraArgs: ["--user-agent=tok-SECRET"], dropArgs: [] }, (s) => s.replaceAll("SECRET", "<secret:x>"));
    expect(m.args).toContain("--user-data-dir=<profile>");
    expect(m.args).toContain("--load-extension=<extension>");
    expect(m.args).toContain("--user-agent=tok-<secret:x>");
    expect(JSON.stringify(m)).not.toContain("someone");
    expect(m.extraArgs).toEqual(["--user-agent=tok-<secret:x>"]);
  });

  test("status --text names custom args only when there are some", () => {
    const facts = (extraArgs: string[] | null, dropArgs: string[] | null) => ({
      daemon: { running: true, pid: 1, listener: "unix" },
      browser: { running: true, pid: 2, mode: "direct", tabs: 0, webdriver: "hidden", extraArgs, dropArgs },
      plugins: { decode: [], challenge: [] },
      sessions: [],
      handoff: [],
    });
    expect(renderStatusText(facts([], [])).split("\n")[0]).toContain("webdriver hidden · plugins");
    expect(renderStatusText(facts(["--lang=en", "--x"], ["--disable-sync"])).split("\n")[0]).toContain("webdriver hidden, chrome args +2 -1 · plugins");
  });
});
