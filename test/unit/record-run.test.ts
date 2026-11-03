// 0.9-F `tabcap record` and `replay serve -- <cmd>` as a whole (docs/04
// §50.2 / §50.3). The recorded command is `bun -e …` (fetch honours
// HTTPS_PROXY and NODE_EXTRA_CA_CERTS), so the test needs no Python and runs
// on every CI platform. Oracles: the local target's request log, the child's
// own output (status, the CA file path it was given), the §50 rules for exit
// codes, the temporary directory and the bundle directory.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "../../src/record/run.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { tmp } from "./_analyze.ts";

const CERTS = join(import.meta.dir, "../../src/wire/certs");
const RANGE_CA = join(CERTS, "ca.pem");
const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

let root = "";
let target: ReturnType<typeof Bun.serve>;
const seen: string[] = [];
/** The environment of the owner's shell that bit the spike: a lowercase system proxy and a no_proxy for loopback. */
const SHELL_ENV = { ...process.env, https_proxy: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", no_proxy: "127.0.0.1,localhost" };

beforeAll(() => {
  root = tmp("tabcap-recrun-");
  target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(join(CERTS, "leaf.pem")), key: Bun.file(join(CERTS, "leaf-key.pem")) },
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.text();
      seen.push(`${req.method} ${u.pathname}${u.search} ${body}`);
      return Response.json({ path: u.pathname, q: u.searchParams.get("q"), body });
    },
  });
});
afterAll(() => {
  void target.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const base = () => `https://localhost:${target.port}`;
/** A bun child that sends `paths` in order and prints each status; writes the CA file path it was given to `caOut`; exits `code`. */
const child = (paths: string[], code = 0, caOut = "") => [
  process.execPath,
  "-e",
  `for (const p of ${JSON.stringify(paths)}) { const [m, path] = p.split(" "); const r = await fetch(${JSON.stringify(base())} + path, m === "POST" ? { method: "POST", body: "b=" + path } : {}); console.log(r.status, r.headers.get("x-tabcap-replay") ?? ""); } if (${JSON.stringify(caOut)} !== "") await Bun.write(${JSON.stringify(caOut)}, process.env.SSL_CERT_FILE ?? ""); process.exit(${code});`,
];

describe("record", () => {
  test("records the child's requests in order; the CA's temporary directory is gone afterwards; the child's exit code is passed on", async () => {
    seen.length = 0;
    const out = join(root, "b1");
    const caOut = join(root, "child-ca-path.txt");
    const a = await record({ out, command: child(["GET /s/list?q=1", "POST /s/item", "GET /s/list?q=2"], 3, caOut), upstream: { kind: "none" }, upstreamCa: [RANGE_CA], env: SHELL_ENV, site: "range" });
    expect(seen).toEqual(["GET /s/list?q=1 ", "POST /s/item b=/s/item", "GET /s/list?q=2 "]);
    expect(a).toMatchObject({ bundle: out, requests: 3, events: 3, exitCode: 3, upstream: "direct", failed: 0, tunnels: 0, websockets: 0, tlsRefused: 0, warnings: [] });
    const caPath = readFileSync(caOut, "utf8");
    expect(caPath).toContain("tabcap-record-");
    expect(existsSync(caPath)).toBe(false);
    const r = BundleReader.open(out);
    expect(r.isComplete()).toBe(true);
    expect(r.manifest.session.site).toBe("range");
    expect(r.manifest["capture"]).toEqual({ via: "record", client: expect.stringMatching(/^bun/), ca: "ephemeral", upstream: "direct" });
    expect(r.events.map((e) => [e.seq, e["method"], String(e["url"]).replace(base(), "")])).toEqual([
      [1, "GET", "/s/list?q=1"],
      [2, "POST", "/s/item"],
      [3, "GET", "/s/list?q=2"],
    ]);
  });

  test("a non-empty -o is a conflict; a command that cannot start leaves no bundle behind", async () => {
    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "x");
    await expect(record({ out: full, command: ["true"], upstream: { kind: "none" }, upstreamCa: [] })).rejects.toThrow(/not empty/);
    const out = join(root, "never");
    await expect(record({ out, command: ["/nonexistent/tabcap-test-binary"], upstream: { kind: "none" }, upstreamCa: [] })).rejects.toThrow(/cannot start/);
    expect(existsSync(out)).toBe(false);
  });

  test("nothing recorded: a warning says why it may be", async () => {
    const a = await record({ out: join(root, "empty"), command: [process.execPath, "-e", "0"], upstream: { kind: "none" }, upstreamCa: [] });
    expect(a.requests).toBe(0);
    expect(a.warnings[0]).toContain("no request was recorded");
  });

  test("--timeout stops the child", async () => {
    const started = performance.now();
    const a = await record({ out: join(root, "slow"), command: [process.execPath, "-e", "await Bun.sleep(30000)"], upstream: { kind: "none" }, upstreamCa: [], timeoutSec: 0.3 });
    expect(performance.now() - started).toBeLessThan(10000);
    expect(a.exitCode).not.toBe(0);
  });
});

describe("tabcap record / replay serve -- <cmd> (CLI)", () => {
  test("record, then replay with the target gone: order ok exits 0, a reordered run exits 1, the child's failure wins", async () => {
    seen.length = 0;
    const out = join(root, "cli");
    const rec = Bun.spawn([process.execPath, MAIN, "record", "-o", out, "--upstream", "none", "--upstream-ca", RANGE_CA, "--", ...child(["GET /s/a", "GET /s/b", "GET /s/c"])], { env: SHELL_ENV, stdout: "pipe", stderr: "pipe" });
    const recOut = await new Response(rec.stdout).text();
    expect(await rec.exited).toBe(0);
    expect(JSON.parse(recOut.trim().split("\n").pop() ?? "{}")).toMatchObject({ ok: true, data: { requests: 3, exitCode: 0 } });
    expect(seen.length).toBe(3);
    seen.length = 0;

    const replay = async (paths: string[], code = 0) => {
      const p = Bun.spawn([process.execPath, MAIN, "replay", "serve", out, "--order", "strict", "--json", "--", ...child(paths, code)], { env: SHELL_ENV, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(p.stdout).text();
      const exit = await p.exited;
      const lines = text.trim().split("\n");
      const stop = JSON.parse(lines.filter((l) => l.startsWith("{")).pop() ?? "{}") as { data?: { exitCode?: number; order?: { ok: boolean; moved: { id: string; position: number; index: number }[] } } };
      return { exit, stop, statuses: lines.filter((l) => /^\d{3} /.test(l)) };
    };
    const good = await replay(["GET /s/a", "GET /s/b", "GET /s/c"]);
    expect(good.exit).toBe(0);
    expect(good.stop.data?.order?.ok).toBe(true);
    expect(good.statuses.map((s) => s.split(" ")[0])).toEqual(["200", "200", "200"]);
    const moved = await replay(["GET /s/b", "GET /s/c", "GET /s/a"]);
    expect(moved.exit).toBe(1);
    expect(moved.stop.data?.order?.moved).toEqual([{ id: expect.any(String), position: 1, index: 3 }]);
    const failed = await replay(["GET /s/a", "GET /s/b", "GET /s/c"], 4);
    expect(failed.exit).toBe(4);
    expect(failed.stop.data?.exitCode).toBe(4);
    // replay never reached the real target
    expect(seen).toEqual([]);
  }, 60000);

  test("--upstream with credentials is a usage error and starts nothing", async () => {
    const out = join(root, "cred");
    const p = Bun.spawn([process.execPath, MAIN, "record", "-o", out, "--upstream", "http://u:secret@127.0.0.1:9", "--", "true"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    expect(await p.exited).toBe(2);
    expect(text).toContain("credentials never go on the command line");
    expect(text).not.toContain("secret");
    expect(existsSync(out)).toBe(false);
  });
});
