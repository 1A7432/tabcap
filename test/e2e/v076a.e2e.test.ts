// L2 for 0.7.6-A: navigator.webdriver hidden by default (docs/04 §40, docs/05
// s66). Chrome for Testing launched by tabcap gets
// --disable-blink-features=AutomationControlled unless `--webdriver visible`
// (or config.json `webdriver: "visible"`). Oracle: the range's log of what the
// page and its iframe read from navigator.webdriver, and whether the getter is
// still native; tabcap's answers and the manifest are checked against §40.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebdriverSite, type S66Report, type WebdriverSite } from "./site.ts";
import { ok, rec, s, tabcap } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "a"];

let site: WebdriverSite;
const homes: string[] = [];

function newHome(config: unknown = null): string {
  const home = mkdtempSync(join(tmpdir(), "tabcap-e2e076a-"));
  homes.push(home);
  if (config !== null) {
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify(config), { mode: 0o600 });
  }
  return home;
}

/** The reports that arrived since `from`, once both the page and its iframe sent one. */
async function reportsSince(from: number): Promise<S66Report[]> {
  const end = Date.now() + 10_000;
  for (;;) {
    const got = site.reports.slice(from);
    if (got.length >= 2) return [...got].sort((a, b) => a.where.localeCompare(b.where));
    if (Date.now() > end) throw new Error(`reports: ${JSON.stringify(got)}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!enabled)("tabcap 0.7.6-A L2 (navigator.webdriver on s66)", () => {
  beforeAll(() => {
    site = startWebdriverSite();
  });

  afterAll(async () => {
    for (const h of homes) await tabcap(h, ["daemon", "stop"]).catch(() => null);
    site.stop();
    if (process.env["V076A_KEEP"] === undefined) for (const h of homes) removeHome(h, import.meta.file);
    else console.log(`[v076a] kept ${homes.join(" ")}`);
  });

  test("1. default: hidden in the page and its iframe, getter still native; status and manifest say hidden", async () => {
    const home = newHome();
    await ok(home, "daemon", "start");
    const started = await ok(home, "browser", "start", "--proxy", "none", "--executable-path", CHROME);
    expect(started["webdriver"]).toBe("hidden");
    await ok(home, "session", "start", "a");
    const bundle = s((await ok(home, "net", "start", ...S))["bundle"]);
    const from = site.reports.length;
    await ok(home, "navigate", `${site.origin}/s66`, ...S);
    expect(await reportsSince(from)).toEqual([
      { where: "frame", webdriver: "false", native: "true" },
      { where: "main", webdriver: "false", native: "true" },
    ]);
    expect(rec((await ok(home, "status"))["browser"])["webdriver"]).toBe("hidden");
    expect((await ok(home, "browser", "status"))["webdriver"]).toBe("hidden");
    await ok(home, "net", "stop", ...S);
    const manifest = rec(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
    expect(rec(rec(manifest["producer"])["browser"])["webdriver"]).toBe("hidden");
    await ok(home, "daemon", "stop");
  }, 90_000);

  test("2. --webdriver visible: Chrome's own value (true over the pipe), getter native", async () => {
    const home = newHome();
    await ok(home, "daemon", "start");
    const started = await ok(home, "browser", "start", "--proxy", "none", "--webdriver", "visible", "--executable-path", CHROME);
    expect(started["webdriver"]).toBe("visible");
    expect(started["channel"]).toBe("pipe");
    await ok(home, "session", "start", "a");
    const from = site.reports.length;
    await ok(home, "navigate", `${site.origin}/s66`, ...S);
    expect(await reportsSince(from)).toEqual([
      { where: "frame", webdriver: "true", native: "true" },
      { where: "main", webdriver: "true", native: "true" },
    ]);
    await ok(home, "daemon", "stop");
  }, 90_000);

  test("3. config.json webdriver: visible is the default; a bad value is a usage error before launch", async () => {
    const home = newHome({ webdriver: "visible" });
    await ok(home, "daemon", "start");
    expect((await ok(home, "browser", "start", "--proxy", "none", "--executable-path", CHROME))["webdriver"]).toBe("visible");
    await ok(home, "daemon", "stop");

    const bad = newHome({ webdriver: "sometimes" });
    await ok(bad, "daemon", "start");
    const r = await tabcap(bad, ["browser", "start", "--proxy", "none", "--executable-path", CHROME]);
    expect(r.ok).toBe(false);
    expect(r.error?.["code"]).toBe("usage");
    expect(s(r.error?.["message"])).toContain("sometimes");
    expect((await ok(bad, "browser", "status"))["running"]).toBe(false);
    await ok(bad, "daemon", "stop");
  }, 90_000);
});
