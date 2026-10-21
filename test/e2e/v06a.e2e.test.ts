// L2 for 0.6-A `tabcap fetch` (Chrome for Testing, the real daemon, the range in site.ts).
// Expected values come from the range, never from tabcap:
//   - bodies: what the range's `served` map says it sent for that path + query;
//   - the marker header: the range's access log (every request's headers);
//   - the interval: the range's arrival times of consecutive requests;
//   - CORS: origin B allows origin A on /api/cors and not on /api/nocors.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { FETCH_BIG, FETCH_BIZ_ERROR, FETCH_CORS_BODY, FETCH_ITEM, FETCH_OK, LOGIN_PASSWORD, LOGIN_USER, startFetchSite, type FetchSite } from "./site.ts";
import { cliFor, rec, s } from "./_cli.ts";
import { daemonRequest, removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const SITE = "example";
const S = ["--session", "ex"];
const MARKER = "x-tabcap-fetch";

let home = "";
let site: FetchSite;
let bundle = "";

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

/** A small script client: POST /fetch on the daemon's socket, or its port + token on Windows (what _tabcap_fetch.py does with httpx). */
function endpoint(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return daemonRequest(home, "/fetch", body);
}

function refOf(tree: string, role: string, name: string): string {
  const line = tree.split("\n").find((l) => l.includes(`${role} "${name}"`));
  const m = /\[(e\d+)\]/.exec(line ?? "");
  if (m === null || m[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

function events(): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
}

/** fetchId → r-N of every envelope a test got, for the bundle checks at the end. */
const fetched = new Map<string, string>();
const gaps: number[] = [];

describe.skipIf(!enabled)("tabcap 0.6-A L2 (fetch through the logged-in tab: attribution, pacing, stop rules, endpoint)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6a-"));
    site = startFetchSite();
    const add = await tabcap(["site", "add", SITE, "--url", `${site.a}/s07/login`, "--user", LOGIN_USER, "--password-stdin"], LOGIN_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "ex", "--site", SITE);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    // s07: log in like a human would, the scraper's requests then ride on that session
    await ok("navigate", `${site.a}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    await ok("fill", refOf(tree, "textbox", "用户名"), LOGIN_USER, ...S);
    await ok("fill", refOf(tree, "textbox", "密码"), "--secret", `${SITE}.password`, ...S);
    await ok("click", refOf(tree, "button", "登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("5 concurrent fetches (a 3-line --batch and 2 endpoint calls): own fetchIds, the range's bodies, no marker on the wire, ≥ 3 s apart", async () => {
    const file = join(home, "batch.jsonl");
    writeFileSync(file, ["1", "2", "3"].map((n) => JSON.stringify({ url: `/api/item?n=${n}` })).join("\n") + "\n");
    const [batch, e4, e5] = await Promise.all([
      tabcap(["fetch", "--batch", file, "--timeout", "60000", ...S]),
      endpoint({ session: "ex", url: `${site.a}/api/item?n=4`, timeoutMs: 60_000 }),
      endpoint({ session: "ex", url: `${site.a}/api/item?n=5`, timeoutMs: 60_000 }),
    ]);
    const lines = batch.raw.trim().split("\n").map((l): unknown => JSON.parse(l)).map(rec);
    expect(batch.exit).toBe(0);
    expect(lines.length).toBe(3);
    const envs = [...lines, e4, e5];
    for (const e of envs) expect(e["ok"]).toBe(true);
    const data = envs.map((e) => rec(e["data"]));
    const ns = ["1", "2", "3", "4", "5"];
    data.forEach((d, i) => {
      const n = ns[i] ?? "";
      // the oracle: the bytes the range sent for this query, for the logged-in user
      expect(d["body"]).toBe(site.served.get(`/api/item?n=${n}`));
      expect(d["body"]).toBe(FETCH_ITEM(n, LOGIN_USER));
      expect(d["status"]).toBe(200);
      expect(Object.keys(d).sort()).toEqual(["body", "bytes", "fetchId", "headers", "id", "mime", "status", "statusText", "timing", "waitedMs"]);
      // 0.7-E: CLI and POST /fetch alike name the duration totalMs (0.7-C naming table)
      expect(Object.keys(rec(d["timing"])).sort()).toEqual(["endMono", "startMono", "totalMs"]);
      expect(typeof rec(d["timing"])["totalMs"]).toBe("number");
      fetched.set(s(d["fetchId"]), s(d["id"]));
    });
    // batch lines share one command window: c-N:f-1..f-3; the endpoint calls have their own
    const ids = data.map((d) => s(d["fetchId"]));
    expect(new Set(ids).size).toBe(5);
    const batchCmd = ids[0]?.split(":")[0];
    expect(ids.slice(0, 3)).toEqual([`${batchCmd}:f-1`, `${batchCmd}:f-2`, `${batchCmd}:f-3`]);
    expect(new Set(data.map((d) => d["id"])).size).toBe(5);
    // the range never saw the marker header; every request carried the session cookie
    const hits = site.log.filter((h) => h.path === "/api/item");
    expect(hits.length).toBe(5);
    for (const h of hits) {
      expect(Object.keys(h.headers).map((k) => k.toLowerCase())).not.toContain(MARKER);
      expect(h.headers["cookie"] ?? "").toMatch(/sid=[0-9a-f]+/);
    }
    // the interval: consecutive arrivals at the range at least 3000 ms apart
    const at = hits.map((h) => h.at).sort((x, y) => x - y);
    for (let i = 1; i < at.length; i++) gaps.push((at[i] ?? 0) - (at[i - 1] ?? 0));
    console.log(`[v06a] arrival gaps at the range (ms): ${gaps.join(", ")}; waitedMs: ${data.map((d) => d["waitedMs"]).join(", ")}`);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(3000);
    expect(data.filter((d) => typeof d["waitedMs"] === "number" && d["waitedMs"] >= 2900).length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  test("cross-origin (origin B allows A by CORS): no marker, attributed by the initiator; CORS-blocked → fetch.blocked with the console reason", async () => {
    const r = await ok("fetch", `${site.b}/api/cors`, ...S);
    expect(r["body"]).toBe(FETCH_CORS_BODY);
    expect(r["body"]).toBe(site.served.get("b/api/cors"));
    fetched.set(s(r["fetchId"]), s(r["id"]));
    const hit = site.log.find((h) => h.origin === "b" && h.path === "/api/cors");
    expect(hit?.headers["origin"]).toBe(site.a);
    expect(Object.keys(hit?.headers ?? {})).not.toContain(MARKER);
    const blocked = await tabcap(["fetch", `${site.b}/api/nocors`, ...S]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.["code"]).toBe("fetch.blocked");
    expect(s(blocked.error?.["reason"])).toContain("CORS policy");
    expect(s(blocked.error?.["reason"])).toContain(`${site.b}/api/nocors`);
    if (typeof blocked.error?.["request"] === "string") fetched.set(s(blocked.error["fetchId"]), blocked.error["request"]);
    expect(typeof blocked.error?.["request"]).toBe("string");
  }, 60_000);

  test("a body over 8 KB comes back as bodyFile with the range's bytes; --out writes the given file", async () => {
    const r = await ok("fetch", "/api/big", ...S);
    expect(r["body"]).toBeUndefined();
    expect(readFileSync(s(r["bodyFile"]), "utf8")).toBe(FETCH_BIG);
    fetched.set(s(r["fetchId"]), s(r["id"]));
    const out = join(home, "ok.json");
    const o = await ok("fetch", "/api/ok", "--out", out, ...S);
    expect(o["bodyFile"]).toBe(out);
    expect(readFileSync(out, "utf8")).toBe(FETCH_OK);
    fetched.set(s(o["fetchId"]), s(o["id"]));
  }, 60_000);

  test("stop rule json:$.code!=0 trips on {code:1}: recorded, fetch.stopped, next fetch refused until guard resume", async () => {
    const stop = await tabcap(["fetch", "/api/biz", "--stop-on", "json:$.code!=0", ...S]);
    expect(stop.ok).toBe(false);
    expect(stop.error).toMatchObject({ code: "fetch.stopped", site: SITE, rule: "json:$.code!=0", detail: "$.code is 1" });
    expect(rec(stop.error?.["result"])["body"]).toBe(FETCH_BIZ_ERROR);
    const stopped = s(stop.error?.["request"]);
    fetched.set(s(stop.error?.["fetchId"]), stopped);
    const okBefore = site.log.filter((h) => h.path === "/api/ok").length;
    const refused = await tabcap(["fetch", "/api/ok", ...S]);
    expect(refused.error).toMatchObject({ code: "guard.stopped", site: SITE, request: stopped });
    const viaEndpoint = await endpoint({ session: "ex", url: `${site.a}/api/ok` });
    expect(rec(viaEndpoint["error"])["code"]).toBe("guard.stopped");
    expect(site.log.filter((h) => h.path === "/api/ok").length).toBe(okBefore); // nothing was sent
    expect(await ok("guard", "resume", "--site", SITE, ...S)).toMatchObject({ site: SITE, resumed: true, request: stopped });
    const again = await ok("fetch", "/api/ok", ...S);
    expect(again["body"]).toBe(FETCH_OK);
    fetched.set(s(again["fetchId"]), s(again["id"]));
  }, 60_000);

  test("the bundle: every fetch request event has its fetchId and its own cmd, no marker; cmd end events list the r-N; the guard breaker and resume", async () => {
    await ok("net", "stop", ...S);
    const evs = events();
    const reqs = evs.filter((e) => e["kind"] === "request" && typeof e["fetchId"] === "string");
    const byId = new Map(reqs.map((e) => [s(e["id"]), e]));
    expect(fetched.size).toBe(11); // 5 + cors, blocked + big, out + stopped, after resume
    for (const [fid, rid] of fetched) {
      const e = byId.get(rid);
      expect(e?.["fetchId"]).toBe(fid);
      expect(e?.["cmd"]).toBe(fid.split(":")[0]);
      const headers = rec(rec(e?.["request"])["headers"]);
      expect(Object.keys(headers)).not.toContain(MARKER);
    }
    // the cross-origin one went by the initiator path (script initiator, no marker ever)
    const cors = reqs.find((e) => s(e["url"]).endsWith("/api/cors"));
    expect(rec(cors?.["initiator"])["type"]).toBe("script");
    const ends = evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "end");
    for (const [fid, rid] of fetched) {
      const end = ends.find((e) => e["ref"] === fid.split(":")[0]);
      const listed = rec(end?.["outputSummary"])["requests"];
      expect(Array.isArray(listed) && listed.includes(rid)).toBe(true);
    }
    const guard = evs.filter((e) => e["kind"] === "guard" && e["reason"] === "fetch-stop");
    expect(guard.map((g) => [g["event"], g["site"], g["rule"]])).toEqual([
      ["breaker", SITE, "json:$.code!=0"],
      ["resume", SITE, "json:$.code!=0"],
    ]);
  }, 60_000);
});
