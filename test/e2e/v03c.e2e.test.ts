// L2 for 0.3-C: cookie `state` snapshots (docs/04 §4.1) on an s07-like login
// page, `replay session` from that real bundle, the store's saved session after
// `session stop` (`replay session --site` without a bundle), and the docs/04
// §17 items (timing on one clock, HAR 0600, `type` on a removed field).
// Oracles: the local site's own record of the sid it issued (site.sids), the
// spec's field list and file modes; never tabcap's own output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, type GuardSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "range-demo";

let home = "";
let site: GuardSite;
/** Every byte any tabcap command printed (stdout and stderr). */
const printed: string[] = [];

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  printed.push(out, err);
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: null, raw: out };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

const blobJson = (r: BundleReader, ref: unknown): unknown => {
  const b = r.readBlob(typeof ref === "string" ? ref : "");
  return b === null ? null : JSON.parse(new TextDecoder().decode(b));
};
const cookieNamed = (v: unknown, name: string): Record<string, unknown> | undefined => (Array.isArray(v) ? v.filter(isRecord).find((c) => c["name"] === name) : undefined);

describe.skipIf(!enabled)("tabcap 0.3-C L2 (state snapshots, saved sessions, §17)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3c-"));
    site = startGuardSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  let bundle = "";
  test("s07: state cookie events at session start (0), after the next navigation (1: the sid the site issued) and at stop (1)", async () => {
    const S = ["--session", "s07c"];
    await ok("session", "start", "s07c", "--site", SITE);
    await ok("navigate", `${site.origin}/s07/login`, ...S);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), "--secret", `${SITE}.username`, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    expect(site.sids.length).toBe(1);
    await ok("navigate", `${site.origin}/s07/login?again=1`, ...S); // a root `navigation` nav
    await ok("net", "stop", ...S);

    const r = BundleReader.open(bundle);
    const states = r.events.filter((e) => e.kind === "state");
    expect(states.map((e) => [e["what"], e["reason"], e["origin"], e["count"]])).toEqual([
      ["cookies", "session-start", site.origin, 0],
      ["cookies", "nav", site.origin, 1],
      ["cookies", "session-stop", site.origin, 1],
    ]);
    for (const e of states) expect(e).toMatchObject({ actor: "system", tab: "t1" });
    // the snapshot after the navigation holds the sid the site issued, as CDP reports cookies
    const sid = cookieNamed(blobJson(r, states[1]?.["blob"]), "sid");
    expect(sid).toMatchObject({ name: "sid", value: site.sids[0], domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax", session: true });
    expect(blobJson(r, states[0]?.["blob"])).toEqual([]);
    // manifest counts include the new events
    expect(r.manifest.counts.events).toBe(r.events.length);
    // docs/04 §17: timing on one clock — responseStart never after end
    const timed = r.requests().filter((q) => q.timing !== null && q.timing.end !== null && q.timing.responseStart !== null);
    expect(timed.length).toBeGreaterThan(2);
    for (const q of timed) {
      const t = q.timing;
      if (t === null) continue;
      expect([q.id, (t.responseStart ?? 0) <= (t.end ?? 0), (t.start ?? 0) <= (t.responseStart ?? 0)]).toEqual([q.id, true, true]);
    }
  }, 90_000);

  test("replay session from the real bundle: storageState with the site's sid, 0600, value never printed", async () => {
    const out = join(home, "out", "state.json");
    const d = await ok("replay", "session", bundle, "-o", out);
    expect(d).toMatchObject({ out, cookies: 1, sensitive: true, mode: "0600", source: { kind: "bundle" } });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const st: unknown = JSON.parse(readFileSync(out, "utf8"));
    expect(rec(st)["cookies"]).toEqual([{ name: "sid", value: site.sids[0], domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }]);
  }, 30_000);

  test("session stop saves the site session in the store; replay session --site works without a bundle", async () => {
    const stop = await ok("session", "stop", "s07c");
    expect(stop["storeSession"]).toMatchObject({ site: SITE, account: LOGIN_USER, cookies: 1 });
    const out = join(home, "out", "from-store.json");
    const d = await ok("replay", "session", "--site", SITE, "-o", out);
    expect(d).toMatchObject({ source: { kind: "store", site: SITE, account: LOGIN_USER }, cookies: 1 });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(rec(JSON.parse(readFileSync(out, "utf8")))["cookies"]).toEqual([{ name: "sid", value: site.sids[0], domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }]);
    // the saved cookie is a secret now: a page that prints it shows the reference
    await ok("navigate", `${site.origin}/s07/login`, "--session", "echo");
    const echoed = await ok("evaluate", `"sid=${site.sids[0]}"`, "--session", "echo");
    expect(echoed["value"]).toBe(`sid=<secret:${SITE}.cookie.sid>`);
    // nothing tabcap printed holds the sid or the password
    const sidValue = site.sids[0] ?? "x";
    expect(printed.filter((p) => p.includes(sidValue) || p.includes(LOGIN_PASSWORD))).toEqual([]);
    expect(readFileSync(join(home, "config", "daemon.log"), "utf8").includes(sidValue)).toBe(false);
  }, 60_000);

  test("§17: HAR export is 0600; type on a removed focused field is stale-ref, on a live one it types", async () => {
    const har = await ok("bundle", "export", "har", bundle);
    expect(statSync(s(har["out"])).mode & 0o777).toBe(0o600);
    const S = ["--session", "typing"];
    await ok("navigate", `${site.origin}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("click", refOf(tree, "textbox", "用户名"), ...S);
    await ok("evaluate", "document.getElementById('user').focus()", ...S);
    expect(await ok("type", "abc", ...S)).toMatchObject({ length: 3 });
    expect((await ok("evaluate", "document.getElementById('user').value", ...S))["value"]).toBe("abc");
    await ok("evaluate", "document.getElementById('user').remove()", ...S);
    const stale = await tabcap(["type", "xyz", ...S]);
    expect(stale.ok).toBe(false);
    expect(stale.error?.["code"]).toBe("stale-ref");
    expect(s(stale.error?.["next"])).toContain("snapshot");
  }, 60_000);

  test("daemon stop leaves no browser", async () => {
    await ok("daemon", "stop");
    let left = "";
    for (let i = 0; i < 50; i++) {
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes("Chrome for Testing") && l.includes(home)).join("\n").trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
