// L2 for 0.6-B: decode plugins on docs/05 s42 (Chrome for Testing, the real
// daemon, the range plugin test/e2e/plugins/xor-decode installed into the
// test TABCAP_HOME). Walk: plugin enable → net start → navigate /s42 (token,
// items: encoded responses) → `where <name cell>` → click order (encoded POST
// body) → net stop → request events carry `decoded` → find / deps / net body
// read the plaintext → a second recording with the plugin disabled has no
// views until `bundle decode`, which appends them to the decoded.jsonl
// sidecar and leaves events.jsonl byte for byte as recorded. 0.7-E: a plugin
// enabled while a recording runs gives views from the next body on (reload).
// Oracle: the range site (test/e2e/site.ts S42_*, plaintexts written by hand)
// and the docs/04 §28 shapes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { S42_ITEMS_JSON, S42_ORDER, S42_ORDER_JSON, S42_POST_JSON, S42_TOKEN, S42_TOKEN_JSON, startDecodeSite, xorEncode, type DecodeSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const PLUGIN = join(import.meta.dir, "plugins", "xor-decode");
const S = ["--session", "s42"];
const P = "plugin:xor-decode";

let home = "";
let site: DecodeSite;
let bundle = "";
const ids = { doc: "", token: "", items: "", order: "" };

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown>; raw: string; exit: number };
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
    return { ok: exit === 0, data: {}, error: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, error: isRecord(env["error"]) ? env["error"] : {}, raw: out, exit };
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

const hits = async (dir: string, text: string) => recs((await ok("analyze", "find", dir, text))["hits"]).map((h) => ({ ref: h["ref"], part: h["part"], decode: h["decode"], path: h["path"] }));

describe.skipIf(!enabled)("tabcap 0.6-B L2 (decode plugins on docs/05 s42)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6b-"));
    site = startDecodeSite();
    mkdirSync(join(home, "config", "plugins"), { recursive: true, mode: 0o700 });
    cpSync(PLUGIN, join(home, "config", "plugins", "xor-decode"), { recursive: true });
    const listed = await ok("plugin", "list");
    expect(recs(listed["plugins"])).toEqual([expect.objectContaining({ name: "xor-decode", kind: "decode", enabled: false, error: null })]);
    expect(await ok("plugin", "enable", "xor-decode")).toEqual({ name: "xor-decode", enabled: true, hooks: [], kind: "decode" });
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("walk: the recording's request events carry decoded views; where resolves the cell to the decoded path", async () => {
    const started = await ok("net", "start", ...S);
    expect(started["decode"]).toEqual(["xor-decode"]);
    bundle = s(started["bundle"]);
    await ok("navigate", `${site.origin}/s42`, ...S);
    await ok("wait", "--text", "ready", ...S);
    await ok("net", "wait", "--url", "/s42/api/items", ...S);
    const tree = s((await ok("snapshot", ...S))["tree"]);
    const list = recs((await ok("net", "list", "--filter", "/s42", ...S))["requests"]);
    const idOf = (suffix: string) => s(list.find((r) => typeof r["url"] === "string" && r["url"].endsWith(suffix))?.["id"]);
    ids.doc = idOf("/s42");
    ids.token = idOf("/s42/api/token");
    ids.items = idOf("/s42/api/items");

    const w = await ok("where", refOf(tree, "cell", "甲号商品"), ...S);
    expect(w["candidates"]).toEqual([{ request: ids.items, path: "$.items[0].name", chain: [P], match: "exact", score: 1 }]);

    await ok("click", refOf(tree, "button", "order"), ...S);
    await ok("wait", "--text", `ordered ${S42_ORDER}`, ...S);
    ids.order = s((await ok("net", "wait", "--url", "/s42/api/order", ...S))["id"]);
    await ok("net", "stop", ...S);
    expect(site.orders).toEqual([S42_POST_JSON]);

    const reader = BundleReader.open(bundle);
    const byId = (id: string) => reader.requests().find((r) => r.id === id);
    const text = (ref: string | null | undefined) => (typeof ref === "string" ? new TextDecoder().decode(reader.readBlob(ref) ?? new Uint8Array()) : null);
    const view = (json: string, direction: "request" | "response") => ({ by: "xor-decode", version: "1", direction, mime: "application/json", blob: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bytes: new TextEncoder().encode(json).length, ok: true });
    const rawSide = (id: string, side: "request" | "response") => {
      const e = reader.events.find((x) => x["id"] === id);
      const v = e?.[side];
      return isRecord(v) ? v["decoded"] : undefined;
    };
    expect(rawSide(ids.token, "response")).toEqual(view(S42_TOKEN_JSON, "response"));
    expect(rawSide(ids.items, "response")).toEqual(view(S42_ITEMS_JSON, "response"));
    expect(rawSide(ids.order, "response")).toEqual(view(S42_ORDER_JSON, "response"));
    expect(rawSide(ids.order, "request")).toEqual(view(S42_POST_JSON, "request"));
    expect(rawSide(ids.doc, "response")).toBeUndefined();
    expect(rawSide(ids.token, "request")).toBeUndefined();
    expect([ids.token, ids.items, ids.order].map((id) => text(byId(id)?.response?.decoded?.blob))).toEqual([S42_TOKEN_JSON, S42_ITEMS_JSON, S42_ORDER_JSON]);
    expect(text(byId(ids.order)?.request.decoded?.blob)).toBe(S42_POST_JSON);
    // the originals are what the site sent
    expect(text(byId(ids.items)?.response?.body?.blob)).toBe(xorEncode(S42_ITEMS_JSON));
    expect(byId(ids.order)?.request.postData).toEqual({ inline: xorEncode(S42_POST_JSON) });
  });

  test("find: the token, only in plaintext, with chain [plugin:xor-decode]", async () => {
    expect(await hits(bundle, S42_TOKEN)).toEqual([
      { ref: ids.token, part: "response", decode: [P], path: "$.token" },
      { ref: ids.order, part: "request-body", decode: [P], path: "$.token" },
    ]);
  });

  test("deps: the POST's inputs come from the decoded body and resolve to the decoded responses (no cycle)", async () => {
    const d = await ok("analyze", "deps", bundle);
    const q = recs(d["requests"]).find((r) => r["id"] === ids.order);
    const primary = (location: string, name: string) => recs(q?.["inputs"]).find((i) => i["location"] === location && (i["path"] ?? i["name"]) === name)?.["primary"] ?? null;
    const tokenSrc = { kind: "response", request: ids.token, path: "$.token", decode: [P], match: "exact" };
    expect(primary("body", "$.token")).toEqual(tokenSrc);
    expect(primary("body", "$.item")).toEqual({ kind: "response", request: ids.items, path: "$.items[0].id", decode: [P], match: "exact" });
    expect(primary("header", "x-auth")).toEqual(tokenSrc);
  });

  test("net body: the decoded view by default, --raw the original, --decoded without a view fails", async () => {
    const dv = await ok("net", "body", ids.items, ...S);
    expect([dv["view"], dv["decoded"], dv["mime"], dv["textPreview"]]).toEqual(["decoded", { by: "xor-decode", version: "1", mime: "application/json" }, "application/json", S42_ITEMS_JSON]);
    const raw = await ok("net", "body", ids.items, "--raw", ...S);
    expect([raw["view"], raw["textPreview"]]).toEqual(["raw", xorEncode(S42_ITEMS_JSON)]);
    const doc = await ok("net", "body", ids.doc, ...S);
    expect(doc["view"]).toBeUndefined();
    const none = await tabcap(["net", "body", ids.doc, "--decoded", ...S]);
    expect([none.ok, none.error["code"]]).toEqual([false, "not-found"]);
    const both = await tabcap(["net", "body", ids.items, "--decoded", "--raw", ...S]);
    expect([both.ok, both.error["code"]]).toEqual([false, "usage"]);
  });

  test("bundle decode: a recording made with the plugin disabled gets its views afterwards", async () => {
    await ok("plugin", "disable", "xor-decode");
    const started = await ok("net", "start", ...S);
    expect(started["decode"]).toBeUndefined();
    const b2 = s(started["bundle"]);
    await ok("navigate", `${site.origin}/s42`, ...S);
    await ok("wait", "--text", "ready", ...S);
    await ok("net", "wait", "--url", "/s42/api/items", ...S);
    await ok("net", "stop", ...S);
    const before = BundleReader.open(b2).requests();
    expect(before.filter((r) => r.response?.decoded !== undefined || r.request.decoded !== undefined)).toEqual([]);
    expect(await hits(b2, S42_TOKEN)).toEqual([]);
    const token2 = s(before.find((r) => r.url.endsWith("/s42/api/token"))?.id);
    const items2 = s(before.find((r) => r.url.endsWith("/s42/api/items"))?.id);

    const eventsBefore = readFileSync(join(b2, "events.jsonl"));
    const res = await ok("bundle", "decode", b2, "--plugin", "xor-decode");
    expect([res["requests"], res["decoded"], res["failed"], res["kept"], res["appended"]]).toEqual([before.length, 2, 0, 0, 2]);
    expect(readFileSync(join(b2, "events.jsonl")).equals(eventsBefore)).toBe(true);
    expect(readFileSync(join(b2, "decoded.jsonl"), "utf8").trim().split("\n").length).toBe(2);
    expect((await ok("bundle", "info", b2))["decodedSidecar"]).toBe(true);
    const again = await ok("bundle", "decode", b2, "--plugin", "xor-decode");
    expect([again["appended"], again["unchanged"]]).toEqual([0, 2]);
    expect(recs(res["rows"]).map((r) => [r["request"], r["direction"], r["by"], r["ok"]])).toEqual([
      [token2, "response", "xor-decode", true],
      [items2, "response", "xor-decode", true],
    ]);
    expect(BundleReader.open(b2).requests().map((r) => [r.id, r.seq])).toEqual(before.map((r) => [r.id, r.seq]));
    expect(await hits(b2, S42_TOKEN)).toEqual([{ ref: token2, part: "response", decode: [P], path: "$.token" }]);
    // net body of the session's last (finished) recording reads the view bundle decode added
    const dv = await ok("net", "body", items2, ...S);
    expect([dv["view"], dv["textPreview"]]).toEqual(["decoded", S42_ITEMS_JSON]);
  });

  test("0.7-E: plugin enable during a recording applies from the next body; earlier bodies keep none; status lists the plugin", async () => {
    // the plugin is disabled (previous test)
    const started = await ok("net", "start", ...S);
    expect(started["decode"]).toBeUndefined();
    await ok("navigate", `${site.origin}/s42`, ...S);
    await ok("wait", "--text", "ready", ...S);
    await ok("net", "wait", "--url", "/s42/api/items", ...S);
    const itemsIds = async () =>
      recs((await ok("net", "list", "--filter", "/s42/api/items", ...S))["requests"])
        .filter((r) => typeof r["url"] === "string" && r["url"].endsWith("/s42/api/items"))
        .map((r) => s(r["id"]));
    const [before] = await itemsIds();
    const statusRec = async () => {
      const st = await ok("status");
      const me = recs(st["sessions"]).find((x) => x["session"] === "s42");
      return isRecord(me?.["recording"]) ? me["recording"]["decodePlugins"] : undefined;
    };
    expect(await statusRec()).toEqual([]);
    expect((await ok("net", "body", s(before), ...S))["view"]).toBeUndefined();

    expect(await ok("plugin", "enable", "xor-decode")).toMatchObject({ name: "xor-decode", enabled: true });
    await ok("reload", ...S);
    await ok("wait", "--text", "ready", ...S);
    let ids = await itemsIds();
    for (let i = 0; ids.length < 2 && i < 50; i++) {
      await Bun.sleep(100);
      ids = await itemsIds();
    }
    const after = ids[ids.length - 1] ?? "";
    expect(after).not.toBe(before);
    const dv = await ok("net", "body", after, ...S);
    expect([dv["view"], dv["decoded"], dv["textPreview"]]).toEqual(["decoded", { by: "xor-decode", version: "1", mime: "application/json" }, S42_ITEMS_JSON]);
    // the body recorded before enabling has no view (bundle decode adds it after net stop)
    expect((await ok("net", "body", s(before), ...S))["view"]).toBeUndefined();
    expect(await statusRec()).toEqual(["xor-decode"]);
    await ok("net", "stop", ...S);
  });
});
