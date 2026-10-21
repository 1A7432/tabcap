// L2 for 0.6-E live output redaction (Chrome for Testing, the real daemon, the range in site.ts).
// Expected values come from the range, never from tabcap:
//   s07 token variant (startGuardSite, `/s07/login?token=1`): POST /api/login
//   answers set-cookie sid plus {csrf, token} (the site's journal `sids`,
//   `csrfs`, `tokens`); the page sends `authorization: Bearer <token>` +
//   `x-csrf: <csrf>` with the cookie sid to /api/data. docs/04 §8 rule:
//   the `sid` cookie, `Authorization` and (one sensitive-header test since
//   2026-10-21) `x-csrf` are sensitive, and the URL parameter `token` has a
//   sensitive name. The password comes from
//   the store (`fill --secret`), so it stays `<secret:range-demo.password>`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, type GuardSite } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const SITE = "range-demo";

let home = "";
let guard: GuardSite;

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

describe.skipIf(!enabled)("tabcap 0.6-E L2 (live output redaction on s07)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6e-"));
    guard = startGuardSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${guard.origin}/s07/login?token=1`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    guard.stop();
    removeHome(home, import.meta.file);
  });

  test("net show / net list / net body / recon: sid cookie, Authorization, x-csrf and the token URL parameter redacted; --reveal prints them; the bundle keeps them", async () => {
    const S = ["--session", "s07e"];
    const st = await ok("session", "start", "s07e", "--site", SITE);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", s(st["entryUrl"]), ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    await ok("net", "wait", "--url", "/api/data", ...S);

    // the range's journal: one login with its sid, csrf and token
    expect([guard.sids.length, guard.csrfs.length, guard.tokens.length]).toEqual([1, 1, 1]);
    const sid = guard.sids[0] ?? "";
    const csrf = guard.csrfs[0] ?? "";
    const token = guard.tokens[0] ?? "";

    const rows = recs((await ok("net", "list", ...S))["requests"]);
    const id = (path: string) => s(rows.find((r) => s(r["url"]).includes(path))?.["id"]);
    const data = await ok("net", "show", id("/api/data"), ...S);
    const dh = rec(rec(data["request"])["headers"]);
    expect(dh["x-csrf"]).toBe("<redacted:x-csrf>");
    expect(dh["authorization"]).toBe("<redacted:authorization>");
    expect(dh["cookie"]).toBe("sid=<redacted:sid>");
    const login = await ok("net", "show", id("/api/login"), ...S);
    expect(login["url"]).toBe(`${guard.origin}/api/login?token=<redacted:token>`);
    expect(s(rec(rec(login["response"])["headers"])["set-cookie"])).toBe("sid=<redacted:sid>; Path=/; HttpOnly; SameSite=Lax");
    // the password typed from the store keeps its store placeholder; the user name is not sensitive
    expect(rec(rec(login["request"])["postData"])["inline"]).toBe(`user=${LOGIN_USER}&password=<secret:${SITE}.password>`);
    for (const out of [JSON.stringify(data), JSON.stringify(login), JSON.stringify(rows)]) for (const v of [sid, token]) expect(out.includes(v)).toBe(false);

    // net list: the login page's and the login call's `token=1` (a sensitive name)
    expect(rows.map((r) => s(r["url"]))).toContain(`${guard.origin}/s07/login?token=<redacted:token>`);
    const body = await ok("net", "body", id("/s07/login"), ...S);
    expect(body["url"]).toBe(`${guard.origin}/s07/login?token=<redacted:token>`);

    // --reveal: the values as recorded (the store password still a placeholder)
    const dataR = await ok("net", "show", id("/api/data"), "--reveal", ...S);
    const dr = rec(rec(dataR["request"])["headers"]);
    expect([dr["authorization"], dr["cookie"], dr["x-csrf"]]).toEqual([`Bearer ${token}`, `sid=${sid}`, csrf]);
    const loginR = await ok("net", "show", id("/api/login"), "--reveal", ...S);
    expect(loginR["url"]).toBe(`${guard.origin}/api/login?token=1`);
    expect(s(JSON.stringify(loginR)).includes(LOGIN_PASSWORD)).toBe(false);
    const rowsR = recs((await ok("net", "list", "--reveal", ...S))["requests"]);
    expect(rowsR.map((r) => s(r["url"]))).toContain(`${guard.origin}/s07/login?token=1`);

    // recon: the answer and the dossier file
    const rc = await ok("recon", ...S);
    expect(rec(rc["page"])["url"]).toBe(`${guard.origin}/s07/login?token=<redacted:token>`);
    const dossier: unknown = JSON.parse(readFileSync(s(rc["dossier"]), "utf8"));
    expect(rec(rec(dossier)["page"])["url"]).toBe(`${guard.origin}/s07/login?token=<redacted:token>`);
    expect(rec((await ok("recon", "--reveal", ...S))["page"])["url"]).toBe(`${guard.origin}/s07/login?token=1`);

    await ok("net", "stop", ...S);
    // the bundle is the evidence: recorded as sent
    const reqs = BundleReader.open(bundle).requests();
    const rd = reqs.find((r) => r.url.endsWith("/api/data"));
    expect([rd?.request.headers["authorization"], rd?.request.headers["x-csrf"]]).toEqual([`Bearer ${token}`, csrf]);
    expect(s(rd?.request.headers["cookie"])).toContain(`sid=${sid}`);
    await ok("session", "stop", "s07e");
  }, 120_000);

  test("daemon stop leaves no browser process of this TABCAP_HOME", async () => {
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
