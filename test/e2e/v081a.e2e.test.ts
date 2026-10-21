// L2 for 0.8.1-A: custom Chrome args (docs/04 §42, docs/05 s71).
// `browser start --chrome-arg` / `--drop-chrome-arg` and config.json
// `chrome.args` / `chrome.dropArgs`. Oracle: the range's log of the
// User-Agent header and what the page read from navigator.userAgent and
// navigator.webdriver; tabcap's answers and the manifest are checked against §42.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChromeArgsSite, type ChromeArgsSite, type S71Report } from "./site.ts";
import { ok, rec, s, tabcap } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "a"];
const UA = "TabcapS71/1.0";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const named = (args: string[], name: string): string[] => args.filter((a) => a === name || a.startsWith(`${name}=`));

let site: ChromeArgsSite;
const homes: string[] = [];

function newHome(config: unknown = null): string {
  const home = mkdtempSync(join(tmpdir(), "tabcap-e2e081a-"));
  homes.push(home);
  if (config !== null) {
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify(config), { mode: 0o600 });
  }
  return home;
}

async function reportSince(from: number): Promise<S71Report> {
  const end = Date.now() + 10_000;
  for (;;) {
    const got = site.reports[from];
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`reports: ${JSON.stringify(site.reports.slice(from))}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!enabled)("tabcap 0.8.1-A L2 (custom Chrome args on s71)", () => {
  beforeAll(() => {
    site = startChromeArgsSite();
  });

  afterAll(async () => {
    for (const h of homes) await tabcap(h, ["daemon", "stop"]).catch(() => null);
    site.stop();
    if (process.env["V081A_KEEP"] === undefined) for (const h of homes) removeHome(h, import.meta.file);
    else console.log(`[v081a] kept ${homes.join(" ")}`);
  });

  test("1. --chrome-arg: a new switch reaches Chrome, --disable-features merges; answers, status and manifest show them", async () => {
    const home = newHome();
    await ok(home, "daemon", "start");
    const extra = [`--user-agent=${UA}`, "--disable-features=TabcapS71Probe"];
    const started = await ok(home, "browser", "start", "--proxy", "none", "--executable-path", CHROME, "--chrome-arg", extra[0] ?? "", `--chrome-arg=${extra[1] ?? ""}`);
    expect(started["extraArgs"]).toEqual(extra);
    expect(started["dropArgs"]).toEqual([]);
    expect(started["dropArgsUnmatched"]).toEqual([]);
    expect(started["webdriver"]).toBe("hidden");
    const args = strs(started["args"]);
    expect(args).toContain(`--user-agent=${UA}`);
    const df = named(args, "--disable-features");
    expect(df).toHaveLength(1);
    expect(df[0]).toContain("PreconnectToSearch");
    expect(df[0]).toContain("TabcapS71Probe");

    await ok(home, "session", "start", "a");
    const bundle = s((await ok(home, "net", "start", ...S))["bundle"]);
    const from = site.reports.length;
    await ok(home, "navigate", `${site.origin}/s71`, ...S);
    expect(await reportSince(from)).toEqual({ header: UA, ua: UA, webdriver: "false" });
    expect(rec((await ok(home, "status"))["browser"])["extraArgs"]).toEqual(extra);
    expect((await ok(home, "browser", "status"))["args"]).toEqual(args);
    await ok(home, "net", "stop", ...S);

    const browser = rec(rec(rec(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")))["producer"])["browser"]);
    const margs = strs(browser["args"]);
    expect(margs).toContain(`--user-agent=${UA}`);
    expect(margs).toContain("--user-data-dir=<profile>");
    expect(JSON.stringify(margs)).not.toContain(home);
    expect(browser["extraArgs"]).toEqual(extra);
    expect(browser["dropArgs"]).toEqual([]);

    const again = await ok(home, "browser", "start");
    expect(again["alreadyRunning"]).toBe(true);
    expect(s(again["note"])).toContain("browser stop");
    await ok(home, "daemon", "stop");
  }, 90_000);

  test("2. config.json chrome.dropArgs: tabcap's switches and list items go, webdriver follows, unmatched drops are listed", async () => {
    const drops = ["--disable-blink-features", "--disable-features=PreconnectToSearch", "--tabcap-s71-absent"];
    const home = newHome({ chrome: { dropArgs: drops } });
    await ok(home, "daemon", "start");
    const started = await ok(home, "browser", "start", "--proxy", "none", "--executable-path", CHROME);
    expect(started["webdriver"]).toBe("visible");
    expect(started["dropArgs"]).toEqual(drops);
    expect(started["dropArgsUnmatched"]).toEqual(["--tabcap-s71-absent"]);
    const args = strs(started["args"]);
    expect(named(args, "--disable-blink-features")).toEqual([]);
    const df = named(args, "--disable-features");
    expect(df).toHaveLength(1);
    expect(df[0]).toContain("Translate");
    expect(df[0]).not.toContain("PreconnectToSearch");
    await ok(home, "session", "start", "a");
    const from = site.reports.length;
    await ok(home, "navigate", `${site.origin}/s71`, ...S);
    expect((await reportSince(from)).webdriver).toBe("true");
    await ok(home, "daemon", "stop");
  }, 90_000);

  test("3. refused: what would break tabcap, a proxy conflict, a positional, a bad config; the browser does not start", async () => {
    const home = newHome();
    await ok(home, "daemon", "start");
    for (const extra of [
      ["--chrome-arg", `--user-data-dir=${join(home, "other")}`],
      ["--chrome-arg", "--proxy-server=http://127.0.0.1:9"],
      ["--chrome-arg", "about:blank"],
      ["--drop-chrome-arg", "--remote-debugging-port"],
    ]) {
      const r = await tabcap(home, ["browser", "start", "--proxy", "none", "--executable-path", CHROME, ...extra]);
      expect(r.ok).toBe(false);
      expect(r.error?.["code"]).toBe("usage");
      expect((await ok(home, "browser", "status"))["running"]).toBe(false);
    }
    await ok(home, "daemon", "stop");

    const bad = newHome({ chrome: { args: "--x" } });
    await ok(bad, "daemon", "start");
    const r = await tabcap(bad, ["browser", "start", "--proxy", "none", "--executable-path", CHROME]);
    expect(r.ok).toBe(false);
    expect(r.error?.["code"]).toBe("bad-input");
    expect(s(r.error?.["message"])).toContain("chrome.args");
    expect((await ok(bad, "browser", "status"))["running"]).toBe(false);
    await ok(bad, "daemon", "stop");
  }, 90_000);
});
