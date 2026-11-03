// L2 for 0.9-E / 0.9-F: record an external client (a Python requests / httpx
// scraper) with `tabcap record`, replay it with `replay serve --order strict
// -- <cmd>` (docs/04 §49 / §50, docs/05 s76). Oracle: the s76 range's own log
// of every request in arrival order (method, path, query, body sha256, the
// sha256 of the body it answered) and the request sequence each client mode
// sends (test/fixtures/clients/s76_client.py), never tabcap's output.
// No Chrome. Python only through uv, offline (CI warms the cache); without it
// the file skips with the reason, except under CI, where it fails.
// The environment imitates the owner's shell: a lowercase https_proxy that
// nobody listens on and a no_proxy for loopback, so a client that bypassed
// tabcap's proxy would fail instead of silently reaching the range.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { startClientSite, type ClientSite, type S76Hit } from "./site.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");
const CLIENT = join(import.meta.dir, "../fixtures/clients/s76_client.py");
const RANGE_CA = join(import.meta.dir, "../../src/wire/certs/ca.pem");
const UV = Bun.which("uv");
const MUST_RUN = (process.env["CI"] ?? "") !== "";
const E2E = process.env["TABCAP_E2E"] === "1";

/** null when uv runs a Python with requests and httpx offline; else why not. */
function pythonReason(): string | null {
  if (UV === null) return "uv is not installed";
  const p = Bun.spawnSync([UV, "run", "--no-project", "--offline", "-q", "--with", "requests", "--with", "httpx", "python", "-c", "import requests, httpx"], { env: { ...process.env, UV_OFFLINE: "1", UV_NO_PROGRESS: "1" }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return p.exitCode === 0 ? null : `uv has no Python with requests + httpx offline: ${p.stderr.toString().trim().slice(0, 300)}`;
}
const reason = E2E ? pythonReason() : "TABCAP_E2E is not 1";
if (reason !== null && E2E) {
  if (MUST_RUN) throw new Error(`v09e needs Python under CI: ${reason}`);
  console.warn(`v09e skipped: ${reason}`);
}
const enabled = E2E && reason === null;

const py = (...args: string[]) => [UV ?? "uv", "run", "--no-project", "--offline", "-q", "--with", "requests", "--with", "httpx", "python", CLIENT, ...args];

let home = "";
let work = "";
let site: ClientSite;
let base = "";
/** The owner's shell: lowercase proxy variables pointing at a dead port, loopback in no_proxy. */
const shellEnv = (): Record<string, string> => ({ ...(process.env as Record<string, string>), TABCAP_HOME: home, UV_OFFLINE: "1", UV_NO_PROGRESS: "1", https_proxy: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", no_proxy: "127.0.0.1,localhost" });

type Run = { exit: number; out: string; err: string; last: Record<string, unknown> };
async function tabcap(args: string[], env: Record<string, string> = shellEnv()): Promise<Run> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  // the client's own stdout lines come first; tabcap's envelopes are the JSON lines
  const json = out.split("\n").filter((l) => l.startsWith('{"ok":'));
  let last: unknown = {};
  try {
    last = JSON.parse(json[json.length - 1] ?? "{}");
  } catch {
    last = {};
  }
  return { exit, out, err, last: isRecord(last) ? last : {} };
}
const data = (r: Run): Record<string, unknown> => (isRecord(r.last["data"]) ? r.last["data"] : {});
const order = (r: Run): Record<string, unknown> => {
  const o = data(r)["order"];
  return isRecord(o) ? o : {};
};
/** The client's "<status> <sha256>" lines. */
const clientLines = (r: Run) => r.out.split("\n").filter((l) => /^\d{3} [0-9a-f]{64}$/.test(l));
const hitKey = (h: S76Hit) => `${h.method} ${h.path}${h.query === "" ? "" : `?${h.query}`}`;

async function record(name: string, mode: string, extra: string[] = [], env?: Record<string, string>): Promise<{ run: Run; bundle: string; hits: S76Hit[] }> {
  const bundle = join(work, name);
  const from = site.hits.length;
  const run = await tabcap(["record", "-o", bundle, ...extra, "--", ...py(mode === "plain" ? site.http : base, mode)], env);
  return { run, bundle, hits: site.hits.slice(from) };
}

beforeAll(() => {
  if (!enabled) return;
  home = mkdtempSync(join(tmpdir(), "tabcap-v09e-home-"));
  work = mkdtempSync(join(tmpdir(), "tabcap-v09e-"));
  site = startClientSite();
  base = site.https;
});
afterAll(() => {
  if (!enabled) return;
  site.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const NORMAL = ["POST /s76/login", "GET /s76/list?page=1", "POST /s76/item", "GET /s76/list?page=2", "POST /s76/item"];

describe.skipIf(!enabled)("s76 client-order", () => {
  let b1 = "";
  let b1Hits: S76Hit[] = [];

  test("1. record: the range's log, request by request; the CA directory is gone; no HAR anywhere", async () => {
    const { run, bundle, hits } = await record("b1", "normal", ["--upstream", "none", "--upstream-ca", RANGE_CA]);
    expect(run.exit).toBe(0);
    expect(data(run)).toMatchObject({ requests: 5, exitCode: 0, upstream: "direct", failed: 0 });
    expect(hits.map(hitKey)).toEqual(NORMAL);
    const r = BundleReader.open(bundle);
    const reqs = r.events.filter((e) => e.kind === "request");
    expect(reqs.map((e) => `${String(e["method"])} ${String(e["url"]).replace(base, "")}`)).toEqual(NORMAL);
    for (const [i, e] of reqs.entries()) {
      const resp = isRecord(e["response"]) ? e["response"] : {};
      const body = isRecord(resp["body"]) ? resp["body"] : {};
      const bytes = r.readBlob(String(body["blob"])) ?? new Uint8Array();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(hits[i]?.respSha256 ?? "");
      expect(isRecord(e["request"]) ? e["request"]["headersSource"] : null).toBe("wire");
      expect(resp["protocol"]).toBe("http/1.1");
      expect(e["mono"]).not.toBeNull();
    }
    expect(r.manifest["capture"]).toMatchObject({ via: "record", ca: "ephemeral", client: expect.stringMatching(/^uv(\.exe)?$/) }); // basename of the command (§50.2): uv.exe on Windows
    expect(new Bun.Glob("**/*.har").scanSync(bundle).next().done).toBe(true);
    b1 = bundle;
    b1Hits = hits;
    // the CA file the client was given is gone afterwards
    const caRun = await tabcap(["record", "-o", join(work, "b1-ca2"), "--", ...py(site.http, "plain", "--print-ca-path")]);
    const caPath = /CA (\S+)/.exec(caRun.err)?.[1] ?? "";
    expect(caPath).toContain("tabcap-record-");
    expect(existsSync(caPath)).toBe(false);
  }, 120_000);

  test("2. upstream env: through the shell's proxy (CONNECT seen there); no_proxy for the range host goes direct", async () => {
    const connects: string[] = [];
    const fwd = net.createServer((c) => {
      c.once("data", (d: Buffer) => {
        const m = /^CONNECT ([^\s]+) HTTP/.exec(d.toString("latin1"));
        if (m === null) return c.destroy();
        connects.push(m[1] ?? "");
        const [, port] = (m[1] ?? "").split(/:(?=\d+$)/);
        const up = net.connect(Number(port), "127.0.0.1", () => {
          c.write("HTTP/1.1 200 OK\r\n\r\n");
          c.pipe(up);
          up.pipe(c);
        });
        up.on("error", () => c.destroy());
      });
    });
    await new Promise<void>((r) => fwd.listen(0, "127.0.0.1", () => r()));
    const fwdUrl = `http://127.0.0.1:${(fwd.address() as net.AddressInfo).port}`;
    try {
      const via = await record("b2-env", "normal", ["--upstream-ca", RANGE_CA], { ...shellEnv(), https_proxy: fwdUrl, no_proxy: "example.invalid" });
      expect(via.run.exit).toBe(0);
      expect(String(data(via.run)["upstream"])).toBe(`env ${fwdUrl}`);
      expect(connects).toContain(`localhost:${site.httpsPort}`);
      expect(via.hits.map(hitKey)).toEqual(NORMAL);
      const before = connects.length;
      const direct = await record("b2-noproxy", "normal", ["--upstream-ca", RANGE_CA], { ...shellEnv(), https_proxy: fwdUrl, no_proxy: "localhost" });
      expect(direct.run.exit).toBe(0);
      expect(connects.length).toBe(before);
      expect(direct.hits.map(hitKey)).toEqual(NORMAL);
    } finally {
      fwd.close();
    }
  }, 120_000);

  test("3. httpx and plain http are recorded too", async () => {
    const hx = await record("b3-httpx", "httpx", ["--upstream", "none", "--upstream-ca", RANGE_CA]);
    expect(data(hx.run)["requests"]).toBe(hx.hits.length);
    expect(hx.hits.map(hitKey)).toEqual(NORMAL);
    const plain = await record("b3-plain", "plain", ["--upstream", "none"]);
    expect(data(plain.run)["requests"]).toBe(1);
    expect(plain.hits.map(hitKey)).toEqual(["GET /s76/plain"]);
  }, 120_000);

  describe("replay with the range gone", () => {
    let counter: net.Server | null = null;
    let contacts = 0;
    beforeAll(async () => {
      site.stop();
      await Bun.sleep(200);
      // anything that still reaches the range's port is counted
      counter = net.createServer((c) => {
        contacts++;
        c.destroy();
      });
      await new Promise<void>((r) => counter?.listen(site.httpsPort, "127.0.0.1", () => r()));
    });
    afterAll(() => {
      counter?.close();
    });

    const replay = (bundle: string, mode: string, extra: string[] = []) => tabcap(["replay", "serve", bundle, "--order", "strict", "--json", ...extra, "--", ...py(base, mode)]);

    test("4. the recorded order: exit 0, ok, every body as recorded, nothing reaches the range", async () => {
      const report = join(work, "order-ok.json");
      const r = await replay(b1, "normal", ["--order-report", report]);
      expect(r.exit).toBe(0);
      expect(order(r)).toMatchObject({ ok: true, expected: 5, received: 5, matched: 5, missing: [], extra: [], changed: [], moved: [] });
      expect(clientLines(r).map((l) => l.split(" ")[1])).toEqual(b1Hits.map((h) => h.respSha256));
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ ok: true });
      expect(contacts).toBe(0);
    }, 120_000);

    test("5. four ways to be out of order: exit 1, the client itself exits 0", async () => {
      const ids = BundleReader.open(b1).events.filter((e) => e.kind === "request").map((e) => String(e["id"]));
      const reorder = await replay(b1, "reorder");
      expect(reorder.exit).toBe(1);
      expect(data(reorder)["exitCode"]).toBe(0);
      expect(order(reorder)).toMatchObject({ matched: 4, missing: [], extra: [], changed: [], moved: [{ id: ids[1], position: 2, index: 5 }], firstDivergence: { position: 2, expected: ids[1], index: 2, received: "/s76/item" } });
      const extra = await replay(b1, "extra");
      expect(extra.exit).toBe(1);
      expect(order(extra)["extra"]).toEqual([{ index: 6, method: "GET", url: "/s76/list?page=3", matched: null }]);
      const missing = await replay(b1, "missing");
      expect(missing.exit).toBe(1);
      expect(order(missing)["missing"]).toEqual([{ position: 3, id: ids[2], method: "POST", url: "/s76/item" }]);
      const changed = await replay(b1, "changed");
      expect(changed.exit).toBe(1);
      const ch = order(changed)["changed"];
      expect(Array.isArray(ch) ? ch.length : 0).toBe(1);
      expect(ch).toMatchObject([{ id: ids[3], position: 4, index: 4, differs: { query: { changed: ["page"] } } }]);
      expect(contacts).toBe(0);
    }, 180_000);

    test("7. without a command: the test sends the requests itself", async () => {
      const ids = BundleReader.open(b1).events.filter((e) => e.kind === "request").map((e) => String(e["id"]));
      const send = async (count: number) => {
        const p = Bun.spawn(["bun", MAIN, "replay", "serve", b1, "--order", "strict", "--port", "0", "--json", "--once", "3"], { env: shellEnv(), stdout: "pipe", stderr: "pipe" });
        const reader = p.stdout.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        const url = String((JSON.parse(first.split("\n")[0] ?? "{}") as { data: { url: string } }).data.url);
        const reqs: [string, string, RequestInit][] = [
          ["POST", "/s76/login", { body: "user=s76&password=s76-range-password", headers: { "content-type": "application/x-www-form-urlencoded" } }],
          ["GET", "/s76/list?page=1", {}],
          ["POST", "/s76/item", { body: '{"id": 1}', headers: { "content-type": "application/json" } }],
          ["GET", "/s76/list?page=2", {}],
          ["POST", "/s76/item", { body: '{"id": 2}', headers: { "content-type": "application/json" } }],
        ];
        for (const [method, path, init] of reqs.slice(0, count)) await fetch(url + path, { method, ...init }).then((x) => x.arrayBuffer());
        let rest = "";
        for (;;) {
          const c = await reader.read();
          if (c.done) break;
          rest += new TextDecoder().decode(c.value);
        }
        const exit = await p.exited;
        const stop = JSON.parse((first + rest).trim().split("\n").pop() ?? "{}") as { data: { order: Record<string, unknown> } };
        return { exit, order: stop.data.order };
      };
      const all = await send(5);
      expect(all.order["ok"]).toBe(true);
      expect(all.exit).toBe(0);
      const four = await send(4);
      expect(four.exit).toBe(1);
      expect(four.order["missing"]).toMatchObject([{ id: ids[4], position: 5 }]);
    }, 60_000);
  });

  test("6. a subset: exclude, rules order: skip, include (b2 recorded with noise; the range is up again)", async () => {
    site = startClientSite();
    base = site.https;
    const b2 = await record("b6-noise", "noise", ["--upstream", "none", "--upstream-ca", RANGE_CA]);
    expect(data(b2.run)["requests"]).toBe(9);
    site.stop();
    const replay = (extra: string[]) => tabcap(["replay", "serve", b2.bundle, "--order", "strict", "--json", ...extra, "--", ...py(base, "normal")]);
    const plain = await replay([]);
    expect(plain.exit).toBe(1);
    const missing = order(plain)["missing"];
    expect(Array.isArray(missing) ? missing.map((m: unknown) => (isRecord(m) ? m["position"] : null)) : []).toEqual([2, 4, 6, 8]);
    const ex = await replay(["--order-exclude", "/s76/static.js"]);
    expect(ex.exit).toBe(0);
    expect(order(ex)).toMatchObject({ ok: true, skipped: { expected: 4, received: 0 } });
    const rulesFile = join(work, "rules.json");
    writeFileSync(rulesFile, JSON.stringify({ schema: "tabcap-replay-rules/0", rules: [{ match: { path: "/s76/static.js" }, order: "skip" }] }));
    const rules = await replay(["--rules", rulesFile]);
    expect(rules.exit).toBe(0);
    expect(order(rules)).toMatchObject({ ok: true, skipped: { expected: 4, received: 0 } });
    const inc = await replay(["--order-include", "/s76/list"]);
    expect(inc.exit).toBe(0);
    expect(order(inc)).toMatchObject({ ok: true, expected: 2 });
  }, 180_000);

  test("8. the upstream certificate is not trusted: 502 to the client, recorded as failed, nothing reaches the range", async () => {
    site = startClientSite();
    base = site.https;
    try {
      const r = await record("b8-untrusted", "normal", ["--upstream", "none"]);
      expect(r.run.exit).toBe(0);
      expect(r.run.err).toContain("502 x-tabcap-record-error: upstream-tls");
      expect(data(r.run)).toMatchObject({ exitCode: 3, requests: 1, failed: 1 });
      const ev = BundleReader.open(r.bundle).events.filter((e) => e.kind === "request");
      expect(ev.map((e) => e["outcome"])).toEqual(["failed"]);
      expect(String(isRecord(ev[0]?.["error"]) ? ev[0]["error"]["text"] : "")).toContain("upstream");
      expect(r.hits).toEqual([]);
    } finally {
      site.stop();
    }
  }, 120_000);
});
