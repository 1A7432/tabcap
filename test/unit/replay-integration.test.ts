// replay end to end without a browser: the CLI's `replay serve --once` on the
// synthetic bundle of _replay.ts, real HTTP from fetch, `replay check` against
// it (must be 0 differences), `replay export-python` (must py_compile) and,
// when a Python with httpx + pytest is available offline, the generated pytest
// suite against a fresh server. Oracle: the bundle's blobs (sha256).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { tmp } from "./_analyze.ts";
import { pyCompile, pytestPython } from "./_python.ts";
import { FEED, HTML, LOGIN_BODY, PNG, SEARCH, SID, buildReplayBundle } from "./_replay.ts";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PY = pytestPython();
if ("reason" in PY) console.warn(`[replay-integration] generated pytest run SKIPPED: ${PY.reason}`);

type Server = { url: string; info: Record<string, unknown>; proc: ReturnType<typeof Bun.spawn>; stop: () => Promise<void> };

async function serve(bundle: string, ...extra: string[]): Promise<Server> {
  const proc = Bun.spawn(["bun", MAIN, "replay", "serve", bundle, "--port", "0", "--once", "120", "--json", ...extra], { stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let buf = "";
  const dec = new TextDecoder();
  const deadline = Date.now() + 15_000;
  while (!buf.includes("\n")) {
    if (Date.now() > deadline) throw new Error("replay serve did not print its envelope");
    const { value, done } = await reader.read();
    if (done) throw new Error(`replay serve exited: ${buf} ${await new Response(proc.stderr).text()}`);
    buf += dec.decode(value);
  }
  reader.releaseLock();
  const env: unknown = JSON.parse(buf.slice(0, buf.indexOf("\n")));
  if (!isRecord(env) || env["ok"] !== true || !isRecord(env["data"])) throw new Error(`bad envelope: ${buf}`);
  const info = env["data"];
  return {
    url: String(info["url"]),
    info,
    proc,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

let root = "";
let bundle = "";

beforeAll(async () => {
  root = tmp("tabcap-replay-i-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = async (r: Response) => sha256Hex(new Uint8Array(await r.arrayBuffer()));

describe("replay serve over HTTP", () => {
  test("envelope; bodies equal the blobs; headers; cycling; missing; 404 with candidates", async () => {
    const s = await serve(bundle);
    try {
      expect(s.info).toMatchObject({ bundle, host: "127.0.0.1", complete: true, routeCount: 14, recordings: 16, skippedCount: 1 });
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const reader = BundleReader.open(bundle);
      const blobOf = (suffix: string, i = 0) => {
        const r = reader.requests().filter((x) => x.url.endsWith(suffix))[i];
        const b = r?.response?.body ? reader.readBlob(r.response.body.blob) : null;
        if (b === null || r === undefined) throw new Error(`no blob for ${suffix}`);
        return { id: r.id, sha: sha256Hex(b), size: b.length };
      };

      const home = await fetch(`${s.url}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await home.text()).toBe(HTML);

      const login = await fetch(`${s.url}/api/login`, { method: "POST", body: LOGIN_BODY });
      expect(login.status).toBe(200);
      expect(login.headers.getSetCookie()).toEqual([`sid=${SID}; Path=/; HttpOnly`, "theme=dark; Path=/"]);
      expect(login.headers.get("content-encoding")).toBeNull();
      expect(login.headers.get("content-length")).toBe(String(blobOf("/api/login").size));
      expect(login.headers.get("x-tabcap-replay")).toBe(`${blobOf("/api/login").id};n=1`);
      expect(await sha(login)).toBe(blobOf("/api/login").sha);

      for (const [i, body] of [...FEED, FEED[0] ?? ""].entries()) {
        const r = await fetch(`${s.url}/api/feed`);
        expect(r.headers.get("x-tabcap-replay")).toBe(`${blobOf("/api/feed", i % 3).id};n=${(i % 3) + 1}`);
        expect(await r.text()).toBe(body);
      }

      const search = await fetch(`${s.url}/api/search`, { method: "POST", body: JSON.stringify(SEARCH[1]), headers: { "content-type": "application/json" } });
      expect(await sha(search)).toBe(blobOf("/api/search", 1).sha);

      const png = await fetch(`${s.url}/img/logo.png`);
      expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);

      const ev = await fetch(`${s.url}/api/evicted`);
      expect(ev.status).toBe(200);
      expect(ev.headers.get("x-tabcap-replay-missing")).toBe("evicted");
      expect(ev.headers.get("content-length")).toBe("0");
      expect(await ev.text()).toBe("");

      const go = await fetch(`${s.url}/go`, { redirect: "manual" });
      expect(go.status).toBe(302);
      expect(go.headers.get("location")).toBe("/final?x=1");

      const miss = await fetch(`${s.url}/api/items?page=7&client=web`);
      expect(miss.status).toBe(404);
      const body: unknown = await miss.json();
      expect(body).toMatchObject({ error: "no-match", candidates: [{ path: "/api/items", differs: { query: { changed: ["page"] } } }, { path: "/api/items" }] });
    } finally {
      await s.stop();
    }
  });

  test("--strict and --match-cookies; non-loopback --host refused", async () => {
    const s = await serve(bundle, "--strict", "x-client-build", "--match-cookies");
    try {
      expect(s.info["match"]).toEqual({ strict: ["x-client-build"], cookies: true, host: false });
      expect((await fetch(`${s.url}/api/items?page=1&client=web`)).status).toBe(404);
      const ok = await fetch(`${s.url}/api/items?page=1&client=web`, { headers: { "x-client-build": "2026.10", cookie: `theme=dark; sid=${SID}` } });
      expect(ok.status).toBe(200);
    } finally {
      await s.stop();
    }
    const bad = await cli(["replay", "serve", bundle, "--host", "0.0.0.0", "--port", "0", "--once", "1", "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("loopback only");
  });

  test("--once stops the server by itself", async () => {
    const t0 = Date.now();
    const r = await cli(["replay", "serve", bundle, "--port", "0", "--once", "1"]);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.out).toContain("route(s)");
    expect(r.err).toContain("stopped after 0 request(s)");
  });
});

describe("replay check against replay serve of the same bundle", () => {
  test("zero differences, exit 0; a changed bundle gives differences and exit 1", async () => {
    const s = await serve(bundle);
    try {
      const r = await cli(["replay", "check", bundle, "--against", s.url, "--json"]);
      const env: unknown = JSON.parse(r.out);
      expect(env).toMatchObject({ ok: true, data: { totals: { requests: 16, same: 15, unverified: 1, different: 0, errors: 0, skipped: 1 } } });
      expect(r.code).toBe(0);
    } finally {
      await s.stop();
    }
    // the other way round: serve a bundle whose answers differ
    const other = join(root, "other");
    const { buildBundle } = await import("./_analyze.ts");
    await buildBundle(other, { name: "other", created: 1760600000000, seed: 8 }, async (b) => {
      await b.request({ url: "http://127.0.0.1:4310/api/items?page=1&client=web", mime: "application/json", body: JSON.stringify({ items: [], page: "1", served: "items-v2", more: true }), ts: 1760600001000 });
    });
    const s2 = await serve(other);
    try {
      const r = await cli(["replay", "check", bundle, "--against", s2.url, "--filter", "/api/items"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("different");
      expect(r.out).toContain("$.items");
      expect(r.out).toMatch(/totals: 2 request\(s\), 0 same, 2 different/);
    } finally {
      await s2.stop();
    }
  });
});

describe("export-python against replay serve", () => {
  test("generated files compile", async () => {
    const out = join(root, "py");
    const r = await cli(["replay", "export-python", bundle, "-o", out]);
    expect(r.code).toBe(0);
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
  });

  test.skipIf("reason" in PY)("generated pytest suite passes against a fresh replay serve", async () => {
    if (!("python" in PY)) return;
    const out = join(root, "py-run");
    expect((await cli(["replay", "export-python", bundle, "-o", out])).code).toBe(0);
    const s = await serve(bundle);
    try {
      const p = Bun.spawn([PY.python, "-m", "pytest", "-q", "-p", "no:cacheprovider", out], { cwd: out, stdout: "pipe", stderr: "pipe", env: { ...process.env, TABCAP_REPLAY: s.url } });
      const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      if (code !== 0) console.error(o, e);
      expect(code).toBe(0);
      expect(o).toMatch(/10 passed/);
    } finally {
      await s.stop();
    }
  }, 60_000);
});
