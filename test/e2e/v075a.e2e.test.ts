// L2 for 0.7.5-A (Chrome for Testing, the real daemon, the range in site.ts):
//   - s64 end rules: with config.json sites.example.guard {stopOn:
//     ["json:$.code!=0"], endOn: ["json:$.code=203"]} (the owner's rule; since
//     0.7.5 json: rules judge JSON bodies only, so the HTML page itself does
//     not trip it), the "no more pages"
//     answer (code 203) of `tabcap fetch` and of the page's own request ends
//     the list instead of stopping the site; a real error (code 500) still
//     stops it; `fetch --end-on` adds a rule for one call. The codes are the
//     range's own log (`api`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S64_END_CODE, startHandoffSite, type HandoffSite } from "./site.ts";
import { cliFor, rec, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const SITE = "example";
const S = ["--session", "ex"];
const STOP = "json:$.code!=0";

let home = "";
let site: HandoffSite;

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

function refOf(tree: string, role: string, name: string): string {
  const line = tree.split("\n").find((l) => l.includes(`${role} "${name}"`));
  const m = /\[(e\d+)\]/.exec(line ?? "");
  if (m === null || m[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8").trim().split("\n").map((l): unknown => JSON.parse(l)).filter(isRecord);
}

describe.skipIf(!enabled)("tabcap 0.7.5-A L2 (end rules)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e075a-"));
    site = startHandoffSite();
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    const config = { fetch: { minIntervalMs: 0 }, sites: { [SITE]: { guard: { stopOn: [STOP], endOn: [`json:$.code=${S64_END_CODE}`] } } } };
    writeFileSync(join(home, "config", "config.json"), JSON.stringify(config, null, 2) + "\n");
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s64`, "--user", "s64-user", "--password-stdin"], "s64-Pa55word-e2e\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "ex", "--site", SITE);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    if (process.env["V075A_KEEP"] === undefined) removeHome(home, import.meta.file);
    else console.log(`[v075a] kept ${home}`);
  });

  test("s64: code 203 ends the list (fetch and page request), nothing stops; code 500 still stops; --end-on adds a rule for one call", async () => {
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${site.origin}/s64`, ...S);
    for (const page of [1, 2, 3]) {
      const r = await ok("fetch", `/s64/api?page=${page}`, ...S);
      expect([r["status"], "end" in r, "stopped" in r]).toEqual([200, false, false]);
    }
    const last = await ok("fetch", "/s64/api?page=4", ...S);
    expect(last["end"]).toEqual({ rule: "json:$.code=203", detail: "$.code is 203" });
    expect("stopped" in last).toBe(false);
    expect((await ok("fetch", "/s64/api?page=1", ...S))["status"]).toBe(200); // the site is not stopped
    // the page's own requests: four clicks, the fourth answers 203
    const next = refOf(s((await ok("snapshot", "--interactive", ...S))["tree"]), "button", "下一页");
    for (const page of [1, 2, 3, 4]) {
      await ok("click", next, ...S);
      await ok("wait", "--text", `p${page}=`, ...S);
    }
    await ok("wait", "--text", "p4=203", ...S);
    expect((await ok("handoff", "status", ...S))["state"]).toBe("running");
    // a real error still stops the site
    const bad = await tabcap(["fetch", "/s64/api?page=bad", ...S]);
    expect(bad.error).toMatchObject({ code: "fetch.stopped", reason: "stop-rule", rule: STOP });
    expect(await ok("guard", "resume", "--site", SITE, ...S)).toMatchObject({ resumed: true, reason: "stop-rule", handoffResumed: "ex" });
    const own = await ok("fetch", "/s64/api?page=bad", "--end-on", "json:$.code=500", ...S);
    expect(own["end"]).toEqual({ rule: "json:$.code=500", detail: "$.code is 500" });
    await ok("net", "stop", ...S);
    // the range's log (oracle): what was asked, in order, and what it answered
    expect(site.api.map((a) => `${a.page}:${a.code}`)).toEqual(["1:0", "2:0", "3:0", "4:203", "1:0", "1:0", "2:0", "3:0", "4:203", "bad:500", "bad:500"]);
    const evs = events(bundle);
    // Each request picked by what it is, not by its place in events.jsonl: a request's
    // seq is given when its body is written, so it can come after a later one's (0.7.4).
    const one = (what: string, hits: Record<string, unknown>[]): unknown => {
      expect([what, hits.length]).toEqual([what, 1]);
      return hits[0]?.["id"];
    };
    const apiReqs = (page: string) => evs.filter((e) => e["kind"] === "request" && s(e["url"]).endsWith(`/s64/api?page=${page}`));
    const fetchCmd = (endOn: boolean) =>
      one(
        `fetch page=bad${endOn ? " --end-on" : ""} command`,
        evs.filter((e) => e["kind"] === "cmd" && e["phase"] === "start" && rec(e["input"])["action"] === "fetch" && s(e["argv"]).includes("/s64/api?page=bad") && s(e["argv"]).includes("--end-on") === endOn),
      );
    const badCmd = fetchCmd(false);
    const badEndOnCmd = fetchCmd(true);
    const fetch4 = one("fetch page=4", apiReqs("4").filter((e) => "fetchId" in e));
    const page4 = one("the page's own page=4", apiReqs("4").filter((e) => !("fetchId" in e)));
    const badReq = one("fetch page=bad", apiReqs("bad").filter((e) => e["cmd"] === badCmd));
    const badEndOnReq = one("fetch page=bad --end-on", apiReqs("bad").filter((e) => e["cmd"] === badEndOnCmd));
    const guard = evs.filter((e) => e["kind"] === "guard");
    expect(guard.map((g) => [g["event"], g["site"], g["rule"], g["request"]])).toEqual([
      ["end", SITE, "json:$.code=203", fetch4],
      ["end", SITE, "json:$.code=203", page4],
      ["breaker", SITE, STOP, badReq],
      ["resume", SITE, STOP, badReq],
      ["end", SITE, "json:$.code=500", badEndOnReq],
    ]);
    expect(rec(guard[0]?.["detail"])).toMatchObject({ detail: "$.code is 203", status: 200 });
    expect(typeof rec(guard[0]?.["detail"])["fetchId"]).toBe("string");
    expect("fetchId" in rec(guard[1]?.["detail"])).toBe(false); // the page's own request
  }, 90_000);
});
