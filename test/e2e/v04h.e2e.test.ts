// L2 for 0.4-H: embedded-state decoders on docs/05 s41 (Chrome for Testing,
// the real daemon). Walk as docs/05 s41: net start → navigate /s41 →
// snapshot → `where <amount cell>` → click submit (POST /api/s41/submit with
// __VIEWSTATE and the token cut out of it) → net stop → `analyze find` for
// four values → `analyze deps`. Oracle: the range site (test/e2e/site.ts
// S41_*, written by hand) and the node grammar of docs/05 s04 / s41. Every
// expected path below is a literal read off the page source in site.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { S41_TOKEN, S41_VIEWSTATE, startEmbeddedSite, type EmbeddedSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "s41"];

let home = "";
let site: EmbeddedSite;
let bundle = "";
let docId = "";
let postId = "";

type Env = { ok: boolean; data: Record<string, unknown>; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

function refOf(tree: string, role: string, name: string): string {
  for (const m of tree.matchAll(/- (\w+) "([^"]*)"[^\n]*?\[(e\d+)\]/g)) if (m[1] === role && m[2] === name && m[3] !== undefined) return m[3];
  throw new Error(`no ${role} ${JSON.stringify(name)} in:\n${tree}`);
}

/** find hits reduced to what s41 states: where, which steps, which path, which node. */
async function hits(text: string): Promise<unknown[]> {
  const r = await ok("analyze", "find", bundle, text);
  return recs(r["hits"]).map((h) => ({ ref: h["ref"], part: h["part"], decode: h["decode"], path: h["path"], innerPath: h["innerPath"], node: h["node"] ?? null }));
}

const NEXT = { step: "script-json", address: "script[0]", id: "__NEXT_DATA__", type: "application/json" };
const LD = { step: "script-json", address: "script[1]", type: "application/ld+json" };
const STATE = { step: "inline-assign", address: "assign[__STATE__]" };
const VSNODE = { step: "viewstate", address: "viewstate[__VIEWSTATE]" };

describe.skipIf(!enabled)("tabcap 0.4-H L2 (embedded state on docs/05 s41)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4h-"));
    site = startEmbeddedSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("walk: where on the amount cell lists the script / assign paths before the cell; submit posts the viewstate and its token", async () => {
    await ok("navigate", `${site.origin}/s41`, ...S);
    await ok("wait", "--text", "ready", ...S);
    const list = await ok("net", "list", "--filter", "/s41", ...S);
    docId = s(recs(list["requests"]).find((r) => typeof r["url"] === "string" && r["url"].endsWith("/s41"))?.["id"]);
    expect(docId).toMatch(/^r-\d+$/);
    const tree = s((await ok("snapshot", ...S))["tree"]);

    const w = await ok("where", refOf(tree, "cell", "1234.56"), ...S);
    expect(w["normalized"]).toEqual([{ value: "1234.56", rules: [] }, { value: "123456", rules: ["dotted-code"] }]);
    expect(w["candidates"]).toEqual([
      { request: docId, path: "script[0].$.props.pageProps.rows[0].amount", chain: ["script-json"], match: "exact", score: 1 },
      { request: docId, path: "assign[__STATE__].rows[0].amount", chain: ["inline-assign"], match: "exact", score: 1 },
      { request: docId, selector: "form > table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)", chain: [], match: "exact", score: 1 },
    ]);

    await ok("click", refOf(tree, "button", "submit"), ...S);
    await ok("wait", "--text", "submitted true", ...S);
    await ok("net", "wait", "--url", "/api/s41/submit", ...S);
    await ok("net", "stop", ...S);

    // the site's journal: one submit carrying the form's viewstate and the token from inside it
    expect(site.submits.map((f) => [f.get("__VIEWSTATE"), f.get("token")])).toEqual([[S41_VIEWSTATE, S41_TOKEN]]);
    const post = BundleReader.open(bundle).requests().find((r) => r.url.endsWith("/api/s41/submit"));
    postId = post?.id ?? "";
    expect(postId).toMatch(/^r-\d+$/);
  });

  test('find "1234.56": __NEXT_DATA__, the __STATE__ literal and the cell', async () => {
    expect(await hits("1234.56")).toEqual([
      { ref: docId, part: "response", decode: ["script-json"], path: "script[0].$.props.pageProps.rows[0].amount", innerPath: null, node: NEXT },
      { ref: docId, part: "response", decode: ["inline-assign"], path: "assign[__STATE__].rows[0].amount", innerPath: null, node: STATE },
      { ref: docId, part: "response", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test('find "100101": adds the JSON-LD sku', async () => {
    expect(await hits("100101")).toEqual([
      { ref: docId, part: "response", decode: ["script-json"], path: "script[0].$.props.pageProps.rows[0].code", innerPath: null, node: NEXT },
      { ref: docId, part: "response", decode: ["script-json"], path: 'script[1].$["@graph"][0].sku', innerPath: null, node: LD },
      { ref: docId, part: "response", decode: ["inline-assign"], path: "assign[__STATE__].rows[0].code", innerPath: null, node: STATE },
      { ref: docId, part: "response", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test('find "VIEWSTATE-TOKEN-7f3a9c": a string inside the decoded __VIEWSTATE (and the POST that sent it)', async () => {
    expect(await hits(S41_TOKEN)).toEqual([
      { ref: docId, part: "response", decode: ["viewstate"], path: "viewstate[__VIEWSTATE].strings[0]", innerPath: null, node: VSNODE },
      { ref: postId, part: "request-body", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test('find "条目甲": the __STATE__ user, the UTF-16LE string in __VIEWSTATE, the cell', async () => {
    expect(await hits("条目甲")).toEqual([
      { ref: docId, part: "response", decode: ["inline-assign"], path: "assign[__STATE__].user.name", innerPath: null, node: STATE },
      { ref: docId, part: "response", decode: ["viewstate"], path: "viewstate[__VIEWSTATE].strings[1]", innerPath: null, node: VSNODE },
      { ref: docId, part: "response", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test("deps: the POST's __VIEWSTATE is the document's field, its token a string inside it", async () => {
    const d = await ok("analyze", "deps", bundle);
    const q = recs(d["requests"]).find((r) => r["id"] === postId);
    const primary = (name: string) => recs(q?.["inputs"]).find((i) => i["location"] === "body" && i["name"] === name)?.["primary"] ?? null;
    expect(primary("__VIEWSTATE")).toEqual({ kind: "response", request: docId, path: "viewstate[__VIEWSTATE]", decode: ["viewstate"], match: "exact" });
    expect(primary("token")).toEqual({ kind: "response", request: docId, path: "viewstate[__VIEWSTATE].strings[0]", decode: ["viewstate"], match: "exact" });
  });
});
