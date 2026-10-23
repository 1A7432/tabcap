// L2 for 0.9-A: `status` on navigate / go / reload / tab new answers (docs/04
// §45, docs/05 s72). Oracle: the range's own log of every request's path and
// the status it answered (the last /s72/ hop of a navigation is the document the
// tab shows), plus what the page itself says about its performance entry.
// tabcap's answers are checked against both; the literal statuses are the
// range's routes (200 / 404 / 500 / 203 / 302 → 404 / 302 → 200 cross-origin /
// script replace → 404).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNavStatusSite, type NavStatusSite } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "a"];

let home = "";
let site: NavStatusSite;
const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

/** The last /s72/ request the range answered since log position `from`: the document the navigation ended on. */
function lastHop(from: number): { url: string; status: number } {
  const hops = site.log.slice(from).filter((h) => h.path.startsWith("/s72/"));
  const h = hops.at(-1);
  if (h === undefined) throw new Error(`no /s72/ request since ${from}: ${JSON.stringify(site.log.slice(from))}`);
  return { url: `${h.origin === "a" ? site.a : site.b}${h.path}`, status: h.status };
}

/** A navigation-like command; its answer's `status` and `url` must be the last hop's. */
async function hop(args: string[]): Promise<Record<string, unknown>> {
  const from = site.log.length;
  const ans = await ok(...args, ...S);
  const oracle = lastHop(from);
  expect(ans["status"]).toBe(oracle.status);
  expect(ans["url"]).toBe(oracle.url);
  return ans;
}

describe.skipIf(!enabled)("tabcap 0.9-A L2 (navigation status on s72)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e09a-"));
    site = startNavStatusSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("1. navigate: 200, 404, 500, 203, redirect to 404, cross-origin redirect to 200 — the last hop's status; script replace — url and status of one document", async () => {
    const cases: Array<[string, number]> = [
      [`${site.a}/s72/ok`, 200],
      [`${site.a}/s72/missing`, 404],
      [`${site.a}/s72/boom`, 500],
      [`${site.a}/s72/partial`, 203],
      [`${site.a}/s72/moved`, 404],
      [`${site.a}/s72/away`, 200],
    ];
    for (const [url, status] of cases) {
      const ans = await hop(["navigate", url]);
      expect([url, ans["status"]]).toEqual([url, status]);
    }
    // /s72/js replaces itself with /s72/missing from a page script. docs/04 §45: the answer is the document the
    // tab shows when tabcap answers, and url and status come from that ONE document. Which one it is depends on
    // when the replacement commits (location.replace cancels the old page's loads, so it turns `complete` for a
    // moment; measured 0.9-D review: once url /s72/js came with the 404 of /s72/missing), so the oracle is the
    // range's own log: the answered URL is one of the two documents it served, with the status it served for it.
    const jsFrom = site.log.length;
    const js = await ok("navigate", `${site.a}/s72/js`, ...S);
    const until = Date.now() + 5000;
    while (!site.log.slice(jsFrom).some((h) => h.path === "/s72/missing") && Date.now() < until) await Bun.sleep(50);
    const served = site.log.slice(jsFrom).filter((h) => h.path === "/s72/js" || h.path === "/s72/missing");
    expect(served).toEqual([
      { origin: "a", path: "/s72/js", status: 200 },
      { origin: "a", path: "/s72/missing", status: 404 },
    ]);
    const shown = served.find((h) => `${site.a}${h.path}` === js["url"]);
    expect(shown).toBeDefined();
    expect(js["status"]).toBe(shown?.status ?? -1);
    // the redirects really were followed by the browser: the range saw both hops
    const moved = site.log.filter((h) => h.path === "/s72/moved" || h.path === "/s72/away");
    expect(moved).toEqual([
      { origin: "a", path: "/s72/moved", status: 302 },
      { origin: "a", path: "/s72/away", status: 302 },
    ]);
    // the answer keeps its other fields
    const ans = await ok("navigate", `${site.a}/s72/ok`, ...S);
    expect(Object.keys(ans)).toEqual(expect.arrayContaining(["tab", "url", "title", "readyState", "nav", "status", "wait"]));
    expect(ans["title"]).toBe("s72 ok");
    expect(ans["readyState"]).toBe("complete");
  }, 120_000);

  test("2. same-document navigation keeps the document's status; reload and go back give the status of the document they load", async () => {
    await ok("navigate", `${site.a}/s72/missing`, ...S);
    // #x does not change the document: its status is the one it had
    const hash = await ok("navigate", `${site.a}/s72/missing#x`, ...S);
    expect(hash["status"]).toBe(404);
    // pushState changes the URL, not the document; reload loads /s72/pushed, which the range answers 404 for unknown paths
    await ok("evaluate", "history.pushState({}, '', '/s72/pushed')", ...S);
    const re = await hop(["reload"]);
    expect(re["status"]).toBe(404);
    expect(re["url"]).toBe(`${site.a}/s72/pushed`);
    // ok is a 200 document; going back to /s72/pushed loads that (404) document again
    expect((await hop(["navigate", `${site.a}/s72/ok`]))["status"]).toBe(200);
    const back = await hop(["go", "back"]);
    expect(back["status"]).toBe(404);
    expect(back["url"]).toBe(`${site.a}/s72/pushed`);
    const fwd = await hop(["go", "forward"]);
    expect(fwd["status"]).toBe(200);
  }, 120_000);

  test("3. 204 commits no document: the usual page error, no status, the tab stays on the previous page", async () => {
    const before = recs((await ok("tab", "list", ...S))["tabs"]).find((t) => t["current"] === true);
    expect(before?.["url"]).toBe(`${site.a}/s72/ok`);
    const from = site.log.length;
    const e = await tabcap(["navigate", `${site.a}/s72/empty`, ...S]);
    expect(e.ok).toBe(false);
    expect(e.error?.["code"]).toBe("page");
    expect(s(e.error?.["message"])).toContain("net::ERR_ABORTED");
    expect(e.data["status"]).toBeUndefined();
    expect(JSON.stringify(e.envelope)).not.toContain('"status"');
    expect(site.log.slice(from).filter((h) => h.path === "/s72/empty")).toEqual([{ origin: "a", path: "/s72/empty", status: 204 }]);
    const after = recs((await ok("tab", "list", ...S))["tabs"]).find((t) => t["current"] === true);
    expect(after?.["url"]).toBe(`${site.a}/s72/ok`);
  }, 60_000);

  test("4. tab new answers the status; about:blank has none (null); --no-wait still reads it", async () => {
    const fresh = await hop(["tab", "new", `${site.a}/s72/boom`]);
    expect(fresh["status"]).toBe(500);
    const blank = await ok("navigate", "about:blank", ...S);
    expect(blank["status"]).toBeNull();
    expect(blank["url"]).toBe("about:blank");
    const quick = await ok("navigate", `${site.a}/s72/partial`, "--no-wait", ...S);
    expect(quick["status"]).toBe(203);
    expect(quick["wait"]).toBeNull();
  }, 60_000);

  test("5. a page that rewrites performance.getEntriesByType in its own world cannot change the status", async () => {
    const forged = await hop(["navigate", `${site.a}/s72/forge`]);
    expect(forged["status"]).toBe(200);
    // the forgery is real: the page's own world says 299
    const mine = await ok("evaluate", "performance.getEntriesByType('navigation')[0].responseStatus", ...S);
    expect(mine["value"]).toBe(299);
    expect(rec(forged)["status"]).not.toBe(299);
  }, 60_000);
});
