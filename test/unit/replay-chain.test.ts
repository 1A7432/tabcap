// replay export-python in chain mode (0.4-A): the deps graph and the chain
// drive TODO parameters, arguments taken from earlier replies, and the
// generated verify() + verify_expected.json. Oracle: the planted flows of
// _deps.ts (LOGIN: login → set-cookie sid + {csrf} → data; SIGN: sig =
// sha256(q|t)); verify() runs against `replay serve` of the same bundle through
// uv offline, each generated package in its own .venv (no uv / cache: only
// py_compile, reason printed; under CI it fails instead, _python.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPython, TODO_MARK, TODO_SECRET } from "../../src/replay/python.ts";
import { run } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { DepsGraph } from "../../src/analyze/deps.ts";
import { defaultTarget } from "../../src/analyze/chain.ts";
import { ACCESS_TOKEN, CSRF, PASSWORD, QUOTED, SIGN_ONE, SIGN_ONE_SIG, USER, buildLogin, buildReport, buildSign, buildToken } from "./_deps.ts";
import { SLOW_IO_MS, expectMode } from "./_platform.ts";
import { need, packageReason, pyCompile, runInPackage, runInPackageAsync, skipWithout, syncPackage } from "./_python.ts";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PY = packageReason();
const SKIP_PY = skipWithout(PY, "replay-chain generated verify() run");
const SPELLINGS = [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2), JSON.stringify(PASSWORD).slice(1, -1)];

let root = "";
let login = "";
let sign = "";
let token = "";
let report = "";

beforeAll(async () => {
  root = tmp("tabcap-replay-chain-");
  login = await buildLogin(join(root, "login"));
  sign = await buildSign(join(root, "sign"));
  token = await buildToken(join(root, "token"));
  report = await buildReport(join(root, "report"));
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

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

/** `uv sync` the generated package into its own .venv (once per output directory). */
function ready(out: string): void {
  need(PY);
  need(syncPackage(out));
}

function py(args: string[], cwd: string, env: Record<string, string>): { code: number; out: string; err: string } {
  return runInPackage(cwd, args, env);
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

  test("the recorded password is written into no generated file, with or without the chain", () => {
    for (const chain of [true, false]) {
      const out = join(root, `secret-${chain ? "chain" : "nochain"}`);
      const r = exportPython({ bundle: login, out, chain });
      expect(r.functions.find((f) => f.name === "post_api_login")?.args).toContain("password");
      const client = readFileSync(join(out, "client.py"), "utf8");
      expect(client).toContain("password: Any = TODO");
      expect(client).toContain(`_need("${TODO_SECRET}", password=password)`);
      expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
      for (const f of walk(out)) {
        const text = readFileSync(f, "utf8");
        for (const sp of SPELLINGS) expect([chain, f, text.includes(sp)]).toEqual([chain, f, false]);
      }
    }
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

  test.skipIf(SKIP_PY)("verify() against replay serve: passes with the secret from the environment, fails without it", async () => {
    const out = join(root, "login-run");
    exportPython({ bundle: login, out });
    ready(out);
    const s = await serve(login);
    try {
      const ok = py(["python", "client.py", "verify", "--base-url", s.url], out, { TABCAP_SECRET_POST_API_LOGIN_PASSWORD: PASSWORD });
      expect(ok.err).toBe("");
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/^1\s+r-\d+\s+post_api_login\s+200->200\s+pass$/m);
      expect(ok.out).toMatch(/^2\s+r-\d+\s+post_api_data\s+200->200\s+pass$/m);
      expect(ok.out).toContain("verify: 2 step(s), 2 pass, 0 fail");
      const no = py(["python", "client.py", "verify", "--base-url", s.url], out, {});
      expect(no.code).toBe(1);
      expect(no.out).toContain("secret password not given: set TABCAP_SECRET_POST_API_LOGIN_PASSWORD");
      const usage = py(["python", "client.py", "verify"], out, { TABCAP_REPLAY: "" });
      expect(usage.code).toBe(2);
      // the generated pytest suite still passes against the same server
      const t = py(["pytest", "-q", "-p", "no:cacheprovider"], out, { TABCAP_REPLAY: s.url });
      expect(t.code).toBe(0);
    } finally {
      await s.stop();
    }
  }, 60_000);

  test.skipIf(SKIP_PY)("the caller fills a TODO in todo_inputs.py: the right computation passes, a wrong one fails", async () => {
    const out = join(root, "sign-run");
    expect((await run(["replay", "export-python", sign, "-o", out, "--chain"])).code).toBe(0);
    ready(out);
    const s = await serve(sign);
    try {
      expect(py(["python", "client.py", "verify", "--base-url", s.url], out, {}).code).toBe(0);
      writeFileSync(join(out, "todo_inputs.py"), `import hashlib\n\ndef fill(function, args):\n    return {"sig": hashlib.sha256(f"${SIGN_ONE.q}|{args['t']}".encode()).hexdigest()}\n`);
      const good = py(["python", "client.py", "verify", "--base-url", s.url], out, {});
      expect(good.code).toBe(0);
      expect(good.out).toContain("todo_inputs.fill: sig");
      writeFileSync(join(out, "todo_inputs.py"), `def fill(function, args):\n    return {"sig": "0" * 64}\n`);
      const bad = py(["python", "client.py", "verify", "--base-url", s.url], out, {});
      expect(bad.code).toBe(1);
      expect(bad.out).toMatch(/fail/);
      expect(SIGN_ONE_SIG).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await s.stop();
    }
  }, 60_000);
});

// 0.6-E: a header that carries a response leaf behind a scheme prefix / in quotes, and caller-input parameters.
describe("export-python, chain mode: prefixed header values and caller-input (0.6-E)", () => {
  test("Authorization: the argument is the token, the header is 'Bearer ' + it; verify derives it from $.access_token", () => {
    const out = join(root, "token-py");
    const r = exportPython({ bundle: token, out });
    expect(r.chain?.steps.length).toBe(2);
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).toContain('("authorization", "Bearer " + authorization),');
    expect(client).toContain('("x-ref", "\\"" + x_ref + "\\""),');
    expect(client).toMatch(/header authorization: response of post_api_token \(r-\d+\) \$\.access_token with prefix 'Bearer ' -> authorization/);
    expect(client).toMatch(/header x-ref: response of post_api_token \(r-\d+\) \$\.ref in quotes -> x_ref/);
    const v: unknown = JSON.parse(readFileSync(join(out, "verify_expected.json"), "utf8"));
    const steps = isRecord(v) && Array.isArray(v["steps"]) ? v["steps"].filter(isRecord) : [];
    expect(steps[1]?.["derived"]).toEqual({ authorization: { from: r.chain?.steps[0], path: "$.access_token", as: "text" }, x_ref: { from: r.chain?.steps[0], path: "$.ref", as: "text" } });
    expect(steps[1]?.["args"]).toEqual({});
    // the token is a sensitive input: in no generated file except the recorded answer of the token call
    for (const f of walk(out).filter((x) => !x.endsWith("verify_expected.json") && !x.includes("fixtures"))) expect([f, readFileSync(f, "utf8").includes(ACCESS_TOKEN)]).toEqual([f, false]);
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
  });

  test("caller-input: plain parameters whose default is the recorded value (typed for JSON), no TODO for them", () => {
    const out = join(root, "report-py");
    const r = exportPython({ bundle: report, out, chain: true });
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).toContain('def get_api_report(session: Session, *, cat: str = "books", groupby: str = "day", nonce: Any = TODO, page: str = "1", period: str = "2026-09", sessionkind: Any = TODO, base_url: str | None = None)');
    expect(client).toContain('def post_api_stats(session: Session, *, groupby: str = "month", year: int = 2025, base_url: str | None = None)');
    expect(client).toContain("query page: caller-input (varies with period, groupBy, cat, nonce, sessionKind) -> page");
    expect(client).toContain('_need("TODO: computed in the page; see docs/03 §6", nonce=nonce, sessionkind=sessionkind)');
    expect(r.functions.find((f) => f.name === "post_api_stats")?.todo).toBeNull();
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
  });

  test.skipIf(SKIP_PY)("the generated call sends 'Bearer <token>' and the quoted value (a local echo server is the oracle); verify passes", async () => {
    const out = join(root, "token-run");
    exportPython({ bundle: token, out });
    ready(out);
    const seen: { auth: string | null; ref: string | null }[] = [];
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push({ auth: req.headers.get("authorization"), ref: req.headers.get("x-ref") });
        return Response.json({ name: "demo" });
      },
    });
    try {
      const code = `import client; s = client.Session(); print(client.get_api_me(s, authorization=${JSON.stringify(ACCESS_TOKEN)}, x_ref=${JSON.stringify(QUOTED)}, base_url="http://127.0.0.1:${echo.port}").status)`;
      const p = await runInPackageAsync(out, ["python", "-c", code]);
      expect(p.err).toBe("");
      expect(p.out.trim()).toBe("200");
      expect(seen).toEqual([{ auth: `Bearer ${ACCESS_TOKEN}`, ref: `"${QUOTED}"` }]);
    } finally {
      echo.stop(true);
    }
    const s = await serve(token);
    try {
      const ok = py(["python", "client.py", "verify", "--base-url", s.url], out, {});
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("verify: 2 step(s), 2 pass, 0 fail");
    } finally {
      await s.stop();
    }
  }, 60_000);
});

describe("export-python and analyze chain pick the same target (0.6-C)", () => {
  test("event order the other way round from the start times: both take the request that started last", async () => {
    // planted: /api/data starts later (timing.start 5300) but its event is written first; /api/report
    // starts first (5100) and its event comes last. Both are data-bearing fetches.
    const C = 1760700000000;
    const M = 5000;
    const dir = await buildBundle(join(root, "start-order"), { name: "start-order", created: C, seed: 21 }, async (b) => {
      await b.request({ url: "http://127.0.0.1:4310/api/data", type: "fetch", mime: "application/json", body: '{"data":"ok"}', ts: C + 400, extra: { mono: M + 350, timing: { start: M + 300, responseStart: M + 340, end: M + 350, cdp: null } } });
      await b.request({ url: "http://127.0.0.1:4310/api/report", type: "fetch", mime: "application/json", body: '{"report":1}', ts: C + 500, extra: { mono: M + 450, timing: { start: M + 100, responseStart: M + 440, end: M + 450, cdp: null } } });
    });
    const g = DepsGraph.open(dir);
    const [data, rep] = g.requests;
    expect([data?.url, (data?.seq ?? 0) < (rep?.seq ?? 0)]).toEqual(["http://127.0.0.1:4310/api/data", true]);
    const r = exportPython({ bundle: dir, out: join(root, "start-order-client"), chain: true });
    expect(r.chain?.target).toBe(defaultTarget(g).id);
    expect(r.chain?.target).toBe(data?.id ?? "?");
  }, SLOW_IO_MS);
});
