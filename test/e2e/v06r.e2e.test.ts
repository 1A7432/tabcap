// L2 for 0.6-R session leftovers (Chrome for Testing, the real daemon, the s07
// login page of the guard range in test/e2e/site.ts): a failed
// `session start --site` starts nothing; a following `net start` makes an
// unbound session of that name (by design); `fill --secret` there is refused
// before the page is touched and its `next` is the way out, which this test
// then follows. Oracle: the owner's 0.6-R brief, the range page's own field
// value and the range's login journal, never tabcap's word alone.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, type GuardSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SITE = "range-6r";
const NAME = "s6r";
const S = ["--session", NAME];

let home = "";
let site: GuardSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: { code: string; message: string; next: string } | null; raw: string };

const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  const e = isRecord(env["error"]) ? env["error"] : null;
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, error: e === null ? null : { code: s(e["code"]), message: s(e["message"]), next: s(e["next"]) }, raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

/** A ref from the snapshot text: `- textbox "密码" [e7]`. */
function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

const sessionNames = async () => recs((await ok("session", "list"))["sessions"]).map((x) => x["session"]);

describe.skipIf(!enabled)("tabcap 0.6-R L2 (session leftovers after a failed session start --site)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6r-"));
    site = startGuardSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("a failed session start --site starts nothing; net start's unbound session refuses fill --secret; the next it names works", async () => {
    // 1. the site is not in the store yet: nothing is started, and the error says so
    const failed = await tabcap(["session", "start", NAME, "--site", SITE]);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("not-found");
    expect(failed.error?.message).toContain(`session "${NAME}" was not started`);
    expect(failed.error?.next).toContain(`tabcap session start ${NAME} --site ${SITE}`);
    expect(await sessionNames()).not.toContain(NAME);

    // 2. the human adds the site; the agent (wrongly) goes on with net start: an unbound session, by design
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    expect(add.ok).toBe(true);
    await ok("net", "start", ...S);
    const listed = recs((await ok("session", "list"))["sessions"]).find((x) => x["session"] === NAME);
    expect(listed).toMatchObject({ session: NAME, site: null, account: null, recording: true });
    await ok("navigate", `${site.origin}/s07/login`, ...S);
    const pw = refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "textbox", "密码");

    // 3. fill --secret is refused before the page is touched, with the way out
    const refused = await tabcap(["fill", pw, "--secret", `${SITE}.password`, ...S]);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("not-found");
    expect(refused.error?.message).toContain(`session "${NAME}" is not bound to a site`);
    expect(refused.error?.next).toContain(`tabcap session stop ${NAME}`);
    expect(refused.error?.next).toContain(`tabcap session start ${NAME} --site ${SITE}`);
    expect((await ok("evaluate", "document.getElementById('pw').value", ...S))["value"]).toBe("");

    // 4. follow the next: stop, start bound, navigate, fill
    await ok("session", "stop", NAME);
    expect(await ok("session", "start", NAME, "--site", SITE)).toMatchObject({ session: NAME, site: SITE, account: LOGIN_USER });
    await ok("navigate", `${site.origin}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), "--secret", `${SITE}.username`, ...S);
    expect(await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S)).toMatchObject({ secret: `${SITE}.password`, value: `<secret:${SITE}.password>` });
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    expect(site.loginBodies.length).toBe(1);
    expect(new URLSearchParams(site.loginBodies[0] ?? "").get("password")).toBe(LOGIN_PASSWORD);
    await ok("session", "stop", NAME);
  }, 90_000);
});
