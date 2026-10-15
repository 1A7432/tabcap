// replay export-python in chain mode (0.4-A): the deps graph and the chain
// drive TODO parameters, arguments taken from earlier replies, and the
// generated verify() + verify_expected.json. Oracle: the planted flows of
// _deps.ts (LOGIN: login → set-cookie sid + {csrf} → data; SIGN: sig =
// sha256(q|t)); verify() runs against `replay serve` of the same bundle when a
// Python with httpx is available offline (else only py_compile, reason printed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPython, TODO_MARK, TODO_SECRET } from "../../src/replay/python.ts";
import { run } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { tmp } from "./_analyze.ts";
import { CSRF, PASSWORD, SIGN_ONE, SIGN_ONE_SIG, USER, buildLogin, buildSign } from "./_deps.ts";
import { expectMode } from "./_platform.ts";
import { pyCompile, pytestPython } from "./_python.ts";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PY = pytestPython();
if ("reason" in PY) console.warn(`[replay-chain] generated verify() run SKIPPED: ${PY.reason}`);
const SPELLINGS = [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2), JSON.stringify(PASSWORD).slice(1, -1)];

let root = "";
let login = "";
let sign = "";

beforeAll(async () => {
  root = tmp("tabcap-replay-chain-");
  login = await buildLogin(join(root, "login"));
  sign = await buildSign(join(root, "sign"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

type Served = { url: string; stop: () => Promise<void> };

async function serve(bundle: string): Promise<Served> {
  const proc = Bun.spawn(["bun", MAIN, "replay", "serve", bundle, "--port", "0", "--once", "60", "--json"], { stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let buf = "";
  const dec = new TextDecoder();
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`replay serve exited: ${buf}`);
    buf += dec.decode(value);
  }
  reader.releaseLock();
  const env: unknown = JSON.parse(buf.slice(0, buf.indexOf("\n")));
  const url = isRecord(env) && isRecord(env["data"]) ? String(env["data"]["url"]) : "";
  return {
    url,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

function py(args: string[], cwd: string, env: Record<string, string>): { code: number; out: string; err: string } {
  if ("reason" in PY) throw new Error(PY.reason);
  const p = Bun.spawnSync([PY.python, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("export-python, chain mode", () => {
  test("on by default when the graph links requests; arguments from earlier replies, secrets as TODO parameters", () => {
    const out = join(root, "login-py");
    const r = exportPython({ bundle: login, out });
    expect(r.chain).not.toBeNull();
    expect(r.chain?.steps.length).toBe(2);
    expect(r.chain?.target).toBe(r.chain?.steps[1]);
    const fn = (n: string) => r.functions.find((f) => f.name === n);
    expect(fn("post_api_login")?.args).toEqual(["user", "password"]);
    expect(fn("post_api_data")?.args).toEqual(["x_csrf"]);
    expect(r.files).toContain("verify_expected.json");
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).toContain("def post_api_login(session: Session, *, user: str, password: Any = TODO, base_url: str | None = None)");
    expect(client).toContain(`_need("${TODO_SECRET}", password=password)`);
    expect(client).toContain("def post_api_data(session: Session, *, x_csrf: str, base_url: str | None = None)");
    expect(client).toMatch(/header x-csrf: response of post_api_login \(r-\d+\) \$\.csrf -> x_csrf/);
    expect(client).toContain("def verify(base_url: str | None = None");
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
    // the recorded password is in the bundle (the page sent it) but in no generated file
    for (const f of walk(out)) {
      const text = readFileSync(f, "utf8");
      for (const sp of SPELLINGS) expect(text.includes(sp)).toBe(false);
    }
    expectMode(join(out, "verify_expected.json"), 0o600);
  });

  test("verify_expected.json: steps in recording order, recorded args, args derived from earlier replies, the recorded answer", () => {
    const out = join(root, "login-py2");
    const r = exportPython({ bundle: login, out });
    const v: unknown = JSON.parse(readFileSync(join(out, "verify_expected.json"), "utf8"));
    if (!isRecord(v)) throw new Error("not an object");
    expect(v["schema"]).toBe("tabcap-verify/0");
    expect(v["redacted"]).toBe(false);
    expect(String(v["note"])).toContain("--redacted");
    const steps = Array.isArray(v["steps"]) ? v["steps"].filter(isRecord) : [];
    expect(steps.map((s) => s["request"])).toEqual(r.chain?.steps ?? []);
    expect(steps[0]).toMatchObject({ function: "post_api_login", method: "POST", path: "/api/login", skip: null, args: { user: USER, password: "<secret:post_api_login.password>" }, derived: {} });
    expect(steps[0]?.["expect"]).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: { kind: "json", fields: [["$.csrf", CSRF]] } });
    expect(steps[1]).toMatchObject({ function: "post_api_data", args: {}, derived: { x_csrf: { from: r.chain?.steps[0], path: "$.csrf", as: "text" } } });
  });

  test("--no-chain keeps 0.3 output; --chain forces chain mode; both is a usage error", async () => {
    const off = exportPython({ bundle: login, out: join(root, "off"), chain: false });
    expect(off.chain).toBeNull();
    expect(existsSync(join(root, "off", "verify_expected.json"))).toBe(false);
    expect(readFileSync(join(root, "off", "client.py"), "utf8")).not.toContain("def verify(");
    // SIGN has no request-to-request link: 0.3 behaviour unless --chain
    const plain = exportPython({ bundle: sign, out: join(root, "sign-off") });
    expect(plain.chain).toBeNull();
    expect(plain.functions[0]?.todo).toBe("query sig looks like a signature");
    const forced = await run(["replay", "export-python", sign, "-o", join(root, "sign-on"), "--chain"]);
    expect(forced.code).toBe(0);
    const client = readFileSync(join(root, "sign-on", "client.py"), "utf8");
    expect(client).toContain("sig: Any = TODO");
    expect(client).toContain(`_need("${TODO_MARK}", sig=sig)`);
    expect(client).toContain("#   - query sig looks like a signature; computed-in-page (looks-signature)");
    expect((await run(["replay", "export-python", sign, "-o", join(root, "x"), "--chain", "--no-chain"])).code).toBe(2);
  });

  test.skipIf("reason" in PY)("verify() against replay serve: passes with the secret from the environment, fails without it", async () => {
    const out = join(root, "login-run");
    exportPython({ bundle: login, out });
    const s = await serve(login);
    try {
      const ok = py(["client.py", "verify", "--base-url", s.url], out, { TABCAP_SECRET_POST_API_LOGIN_PASSWORD: PASSWORD });
      expect(ok.err).toBe("");
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/^1\s+r-\d+\s+post_api_login\s+200->200\s+pass$/m);
      expect(ok.out).toMatch(/^2\s+r-\d+\s+post_api_data\s+200->200\s+pass$/m);
      expect(ok.out).toContain("verify: 2 step(s), 2 pass, 0 fail");
      const no = py(["client.py", "verify", "--base-url", s.url], out, {});
      expect(no.code).toBe(1);
      expect(no.out).toContain("secret password not given: set TABCAP_SECRET_POST_API_LOGIN_PASSWORD");
      const usage = py(["client.py", "verify"], out, { TABCAP_REPLAY: "" });
      expect(usage.code).toBe(2);
      // the generated pytest suite still passes against the same server
      const t = py(["-m", "pytest", "-q", "-p", "no:cacheprovider", out], out, { TABCAP_REPLAY: s.url });
      expect(t.code).toBe(0);
    } finally {
      await s.stop();
    }
  }, 60_000);

  test.skipIf("reason" in PY)("the caller fills a TODO in todo_inputs.py: the right computation passes, a wrong one fails", async () => {
    const out = join(root, "sign-run");
    expect((await run(["replay", "export-python", sign, "-o", out, "--chain"])).code).toBe(0);
    const s = await serve(sign);
    try {
      expect(py(["client.py", "verify", "--base-url", s.url], out, {}).code).toBe(0);
      writeFileSync(join(out, "todo_inputs.py"), `import hashlib\n\ndef fill(function, args):\n    return {"sig": hashlib.sha256(f"${SIGN_ONE.q}|{args['t']}".encode()).hexdigest()}\n`);
      const good = py(["client.py", "verify", "--base-url", s.url], out, {});
      expect(good.code).toBe(0);
      expect(good.out).toContain("todo_inputs.fill: sig");
      writeFileSync(join(out, "todo_inputs.py"), `def fill(function, args):\n    return {"sig": "0" * 64}\n`);
      const bad = py(["client.py", "verify", "--base-url", s.url], out, {});
      expect(bad.code).toBe(1);
      expect(bad.out).toMatch(/fail/);
      expect(SIGN_ONE_SIG).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await s.stop();
    }
  }, 60_000);
});
