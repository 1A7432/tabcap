// L2 for 0.6-G `analyze shape` / `analyze schema-diff` (Chrome for Testing,
// the real daemon, the range in site.ts). Expected values come from the range,
// never from tabcap:
//   s06 (startSearchSite): the page fetches /api/search (same body shape on
//   every run); `GET /api/list` answers LIST_V1, `GET /api/list?v=2` answers
//   LIST_V2 (title renamed to name, price string → number, currency added);
//   LIST_DRIFT is the scenario's expected drift and `served` holds the sha256
//   of every body the range really sent.
// Two recordings of the same flow, the second against the variant, then the
// shapes and the diff offline.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { LIST_DRIFT, LIST_V1, LIST_V2, startSearchSite, type SearchSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");


let home = "";
let site: SearchSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const sha = (t: string) => createHash("sha256").update(new TextEncoder().encode(t)).digest("hex");

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: null, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

/** One recording of the flow in its own session (bundle names are per second): the s06 page (its own /api/search), then GET /api/list<query> from the tab. */
async function record(session: string, query: string): Promise<string> {
  const S = ["--session", session];
  const bundle = s((await ok("net", "start", ...S))["bundle"]);
  await ok("navigate", `${site.origin}/s06`, ...S);
  await ok("wait", "--text", "hits x-1-a", ...S);
  await ok("net", "wait", "--url", "/api/search", ...S);
  const f = await ok("fetch", `/api/list${query}`, "--timeout", "30000", ...S);
  expect(f["status"]).toBe(200);
  await ok("net", "stop", ...S);
  return bundle;
}

describe.skipIf(!enabled)("tabcap 0.6-G L2 (response shapes and schema drift on s06 /api/list)", () => {
  let oldB = "";
  let newB = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6g-"));
    site = startSearchSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    oldB = await record("g6old", "");
    newB = await record("g6new", "?v=2");
  }, 120_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("the range sent both variants", () => {
    expect(site.served.get("/api/list")).toBe(sha(LIST_V1));
    expect(site.served.get("/api/list?v=2")).toBe(sha(LIST_V2));
  });

  test("analyze shape: GET /api/list from the recorded body, items' fields as the range wrote them, no values", async () => {
    const e = await tabcap(["analyze", "shape", oldB, "--template", "GET /api/list"]);
    expect(e.exit).toBe(0);
    expect(e.data["schema"]).toBe("tabcap-shape/0");
    const [list] = recs(e.data["endpoints"]);
    expect(list?.["key"]).toBe("GET /api/list");
    expect(list?.["exchanges"]).toBe(1);
    const items = rec(rec(rec(rec(rec(list?.["response"])["fields"])["items"])["type"])["items"]);
    const v1: unknown = JSON.parse(LIST_V1);
    const first = recs(rec(v1)["items"])[0] ?? {};
    expect(Object.keys(rec(items["fields"]))).toEqual(Object.keys(first));
    const t = (k: string) => rec(rec(rec(items["fields"])[k])["type"]);
    expect([t("id"), t("title"), t("price"), t("created")]).toEqual([
      { kind: "number", format: "int" },
      { kind: "string" },
      { kind: "string", format: "float" },
      { kind: "string", format: "datetime" },
    ]);
    // status: active ×3, sold ×1 in the range's list
    expect(t("status")).toEqual({ kind: "string", enum: ["active", "sold"] });
    for (const v of ["Blue mug", "12.50", "2026-10-01T09:00:00Z"]) expect(e.raw.includes(v)).toBe(false);

    const all = await ok("analyze", "shape", newB, "--write");
    expect(recs(all["endpoints"]).map((x) => x["key"])).toEqual(["GET /api/search", "GET /api/list"]);
    expect(s(all["written"])).toBe(join(newB, "exports", "shape.json"));
    expect(existsSync(join(newB, "exports", "shape.json"))).toBe(true);
  });

  test("analyze schema-diff: /api/list drifted exactly as the range changed it, /api/search is the same; exit 1", async () => {
    const e = await tabcap(["analyze", "schema-diff", oldB, newB]);
    expect(e.exit).toBe(1);
    expect(e.ok).toBe(true);
    expect(e.data["schema"]).toBe("tabcap-schema-diff/0");
    expect(e.data["drift"]).toBe(true);
    const eps = recs(e.data["endpoints"]);
    expect(eps.map((x) => [x["key"], x["verdict"]])).toEqual([
      ["GET /api/search", "same"],
      ["GET /api/list", "drift"],
    ]);
    const list = eps[1] ?? {};
    expect((Array.isArray(list["added"]) ? [...list["added"]] : []).sort()).toEqual(LIST_DRIFT.added);
    expect(list["removed"]).toEqual(LIST_DRIFT.removed);
    expect(list["changed"]).toEqual(LIST_DRIFT.changed);
    expect([list["optionalityChanged"], list["enumChanged"]]).toEqual([[], []]);
    expect(e.data["summary"]).toEqual({ same: 1, drift: 1, new: 0, gone: 0 });
    for (const v of ["Blue mug", "12.50", "EUR", "x-1-a"]) expect(e.raw.includes(v)).toBe(false);

    const text = await tabcap(["analyze", "schema-diff", oldB, newB, "--text"]);
    expect(text.exit).toBe(1);
    const lines = text.raw.trimEnd().split("\n");
    for (const a of LIST_DRIFT.added) expect(lines).toContain(`drift GET /api/list added ${a}`);
    for (const r of LIST_DRIFT.removed) expect(lines).toContain(`drift GET /api/list removed ${r}`);
    for (const c of LIST_DRIFT.changed) expect(lines).toContain(`drift GET /api/list changed ${c.path} ${c.from} -> ${c.to}`);
    expect(lines[lines.length - 1]).toBe("schema-diff: 1 drift, 1 same, 0 new, 0 gone");

    // the unchanged endpoint alone, and a recording against itself: exit 0
    const same = await tabcap(["analyze", "schema-diff", oldB, newB, "--template", "GET /api/search"]);
    expect([same.exit, same.data["drift"]]).toEqual([0, false]);
    const self = await tabcap(["analyze", "schema-diff", oldB, oldB]);
    expect([self.exit, rec(self.data["summary"])["drift"]]).toEqual([0, 0]);
  });
});
