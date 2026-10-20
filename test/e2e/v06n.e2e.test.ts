// L2 for 0.6-N `browser start --proxy <url>` sends loopback through the proxy too
// (Chrome for Testing, the real daemon, the range smoke site and a tiny forward proxy from site.ts).
// Oracle: the proxy's own log of the URLs it was asked for (`seen`) and the range site's access
// log (`hits`), never tabcap's output. `--proxy none` must leave the proxy log untouched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { startProxySite, startSmokeSite, type ProxySite, type Site } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let home = "";
let range: Site;
let proxy: ProxySite;

type Env = { ok: boolean; data: Record<string, unknown>; raw: string };

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

describe.skipIf(!enabled)("tabcap 0.6-N L2 (--proxy <url> carries loopback traffic)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6n-"));
    range = startSmokeSite();
    proxy = startProxySite();
    await ok("daemon", "start");
  }, 60_000);

  afterAll(async () => {
    await tabcap(["browser", "stop"]).catch(() => null);
    await tabcap(["daemon", "stop"]).catch(() => null);
    range.stop();
    proxy.stop();
    removeHome(home, import.meta.file);
  });

  test("--proxy <url>: the page on 127.0.0.1 is fetched through the proxy; --proxy none: the proxy sees nothing new", async () => {
    await ok("browser", "start", "--proxy", proxy.url, "--executable-path", CHROME);
    await ok("session", "start", "s6n");
    await ok("navigate", `${range.origin}/plain`, "--session", "s6n");
    expect(proxy.seen).toContain(`${range.origin}/plain`);
    expect(range.hits).toContain("GET /plain"); // the proxy forwarded it to the range
    // localhost and [::1] are loopback too: the proxy is asked for them (it answers 502 for [::1], only the log matters)
    const port = new URL(range.origin).port;
    for (const host of ["localhost", "[::1]"]) await tabcap(["navigate", `http://${host}:${port}/plain`, "--session", "s6n"]);
    expect(proxy.seen).toContain(`http://localhost:${port}/plain`);
    expect(proxy.seen).toContain(`http://[::1]:${port}/plain`);
    await ok("session", "stop", "s6n");
    await ok("browser", "stop");

    const before = proxy.seen.length;
    const hitsBefore = range.hits.filter((h) => h === "GET /plain").length;
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "s6n2");
    await ok("navigate", `${range.origin}/plain`, "--session", "s6n2");
    expect(proxy.seen.length).toBe(before);
    expect(range.hits.filter((h) => h === "GET /plain").length).toBe(hitsBefore + 1); // reached the range directly
    await ok("session", "stop", "s6n2");
  }, 120_000);
});
