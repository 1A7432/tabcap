// L2 for 0.3-B: record s01 / s02 / s06-like pages with the real daemon and
// Chrome for Testing, then replay the bundle offline. Oracles: the local
// sites' `served` maps (sha256 of the bytes they really sent) and the bundle's
// blobs; `replay check` against `replay serve` of the same bundle must report
// zero differences. Pages: test/e2e/site.ts (startSite: s01 list + s02
// before-leave race; startSearchSite: s06 search with a page-computed sig).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { isRecord } from "../../src/shared/json.ts";
import { requestBodyBytes } from "../../src/replay/common.ts";
import { TODO_MARK } from "../../src/replay/python.ts";
import { pyCompile } from "../unit/_python.ts";
import { SEARCH_BUILD, startSearchSite, startSite, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = "replay";

let home = "";
let site: Site;
let search: Site;
let bundle = "";

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: null, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, error: isRecord(env["error"]) ? env["error"] : null, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

const refOf = (tree: string, re: RegExp): string => {
  const m = re.exec(tree);
  if (m?.[1] === undefined) throw new Error(`no match for ${re} in:\n${tree}`);
  return m[1];
};

type Served = { url: string; info: Record<string, unknown>; stop: () => Promise<void> };

async function serve(dir: string): Promise<Served> {
  const proc = Bun.spawn(["bun", MAIN, "replay", "serve", dir, "--port", "0", "--once", "120", "--json"], { env: { ...process.env, TABCAP_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`replay serve exited early: ${buf}`);
    buf += dec.decode(value);
  }
  reader.releaseLock();
  const env: unknown = JSON.parse(buf.slice(0, buf.indexOf("\n")));
  if (!isRecord(env) || !isRecord(env["data"])) throw new Error(`bad envelope ${buf}`);
  const info = env["data"];
  return {
    url: s(info["url"]),
    info,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

describe.skipIf(!enabled)("tabcap 0.3-B L2 (replay serve / check / export-python on a real recording)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3b-"));
    site = startSite();
    search = startSearchSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    search.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("record s01 (list), s02 (before-leave race) and s06 (search ×2) into one bundle", async () => {
    const P = ["--session", S];
    bundle = s((await ok("net", "start", ...P))["bundle"]);
    // s01: the list XHR
    await ok("navigate", `${site.origin}/`, ...P);
    await ok("net", "wait", "--url", "/api/items", ...P);
    // s02: the click handler POSTs, then the link navigates at once
    const tree = s((await ok("snapshot", "--interactive", ...P))["tree"]);
    await ok("click", refOf(tree, /link "Go to page two" \[(e\d+)\]/), ...P);
    await ok("wait", "--url", "/two", ...P);
    expect(site.hits).toContain("POST /api/before-leave");
    // s06: two searches with page-computed t / nonce / sig
    for (const [q, page] of [["apple", "1"], ["banana", "2"]] as const) {
      await ok("navigate", `${search.origin}/s06?q=${q}&page=${page}`, ...P);
      await ok("wait", "--text", `hits ${q}-${page}-a`, ...P);
      await ok("net", "wait", "--url", `/api/search?q=${q}`, ...P);
    }
    await ok("net", "stop", ...P);
    const r = BundleReader.open(bundle);
    expect(r.isComplete()).toBe(true);
    const urls = r.requests().map((x) => `${x.method} ${new URL(x.url).pathname}`);
    for (const want of ["GET /", "GET /api/items", "POST /api/before-leave", "GET /two", "GET /s06", "GET /api/search"]) expect(urls).toContain(want);
  }, 90_000);

  test("replay serve gives back every recorded body byte for byte (= what the sites sent)", async () => {
    const srv = await serve(bundle);
    try {
      const r = BundleReader.open(bundle);
      let compared = 0;
      let againstSite = 0;
      for (const req of r.requests()) {
        const st = req.response?.status ?? null;
        if (st === null || st < 200 || req.type === "websocket" || !req.response?.body) continue;
        const blob = r.readBlob(req.response.body.blob);
        if (blob === null) continue;
        const u = new URL(req.url);
        const body = requestBodyBytes(req, r);
        const res = await fetch(`${srv.url}${u.pathname}${u.search}`, {
          method: req.method,
          ...("bytes" in body && body.bytes.length > 0 ? { body: body.bytes } : {}),
        });
        const got = new Uint8Array(await res.arrayBuffer());
        expect(res.status).toBe(st);
        expect(res.headers.get("x-tabcap-replay")).toMatch(new RegExp(`^${req.id};n=\\d+$`));
        expect(sha256Hex(got)).toBe(sha256Hex(blob));
        compared++;
        const oracle = u.origin === search.origin ? search.served.get(u.pathname + u.search) : u.origin === site.origin ? site.served.get(u.pathname) : undefined;
        if (oracle !== undefined) {
          expect(sha256Hex(got)).toBe(oracle);
          againstSite++;
        }
      }
      expect(compared).toBeGreaterThanOrEqual(6);
      // s01 list, s02 before-leave, two documents, s06 page ×2 and search ×2 are all checked against the sites
      expect(againstSite).toBeGreaterThanOrEqual(6);
    } finally {
      await srv.stop();
    }
  }, 60_000);

  test("replay check against replay serve of the same bundle: zero differences", async () => {
    const srv = await serve(bundle);
    try {
      const c = await tabcap(["replay", "check", bundle, "--against", srv.url, "--json"]);
      expect(c.exit).toBe(0);
      const totals = c.data["totals"];
      expect(totals).toMatchObject({ different: 0, errors: 0 });
      expect(isRecord(totals) ? Number(totals["requests"]) : 0).toBeGreaterThanOrEqual(6);
    } finally {
      await srv.stop();
    }
  }, 60_000);

  test("export-python: compiles; the signed search is a TODO, the list call is generated", async () => {
    const out = join(home, "client");
    const e = await ok("replay", "export-python", bundle, "-o", out);
    expect(pyCompile(["client.py", "conftest.py", "test_replay.py"].map((f) => join(out, f)))).toBeNull();
    const fns = Array.isArray(e["functions"]) ? e["functions"].filter(isRecord) : [];
    const searchFn = fns.find((f) => f["name"] === "get_api_search");
    expect(s(searchFn?.["todo"])).toContain("sig looks like a signature");
    expect(fns.find((f) => f["name"] === "get_api_items")?.["todo"]).toBeNull();
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).toContain("def get_api_search(");
    expect(client).toContain(`raise NotImplementedError("${TODO_MARK}`);
    // the page-computed signature is not baked into the client
    expect(client).not.toMatch(/[0-9a-f]{64}/);
    expect(SEARCH_BUILD).toBe("2026.10");
  }, 60_000);

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
