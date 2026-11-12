// L2 for docs/04 §52 (docs/05 s78): external navigations and `tab-changed`, per-tab
// command windows (the 11-11 shape), the page's own navigation. "Someone else" is a
// second CDP client on a DevTools port sending Page.navigate to the session's tab.
// Oracle: the range's request log, the port's /json/list, and §52's rules for the
// bundle's events.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { startVisibilitySite, type VisibilitySite } from "./site.ts";
import { cliFor, rec, recs, s, until } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const A = ["--session", "a"];

let home = "";
let site: VisibilitySite;
let port = 0;
const { tabcap, ok } = cliFor(() => home);

const freePort = (): number => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const p = probe.port ?? 0;
  probe.stop(true);
  return p;
};

type PortTab = { id: string; url: string; webSocketDebuggerUrl: string };

async function portTabs(): Promise<PortTab[]> {
  const list: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return (Array.isArray(list) ? list.filter(isRecord) : []).flatMap((x) => (x["type"] === "page" && typeof x["id"] === "string" && typeof x["url"] === "string" && typeof x["webSocketDebuggerUrl"] === "string" ? [{ id: x["id"], url: x["url"], webSocketDebuggerUrl: x["webSocketDebuggerUrl"] }] : []));
}

/** The target id of the one page whose URL ends with `suffix`. */
async function targetAt(suffix: string): Promise<string> {
  const hits = (await portTabs()).filter((x) => x.url.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected one tab at ${suffix}, got ${JSON.stringify(hits.map((x) => x.url))}`);
  return hits[0]?.id ?? "";
}

/** Another CDP client navigates the tab (outside tabcap); resolves on Page.navigate's answer. */
async function portNavigate(id: string, url: string): Promise<void> {
  const tab = (await portTabs()).find((x) => x.id === id);
  if (tab === undefined) throw new Error(`no tab ${id}`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    ws.onmessage = () => resolve();
    ws.onerror = () => reject(new Error("port socket failed"));
  });
  ws.close();
}

const waitHit = async (path: string, from = 0): Promise<void> => {
  await until(`${path} in the range log`, () => site.hits.slice(from), (h) => h.includes(path), 10_000, 100);
};

const refOf = async (text: string, ...args: string[]): Promise<string> => s(recs((await ok("find", text, ...args))["hits"])[0]?.["ref"]);

let t1Target = "";
let bundle = "";

describe.skipIf(!enabled)("tabcap browser-wide tabs L2 (s78)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e11a-"));
    site = startVisibilitySite();
    port = freePort();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME, "--chrome-arg", `--remote-debugging-port=${port}`);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("1. an external navigation is reported: page commands refused with tab-changed, read-only ones say changed", async () => {
    await ok("net", "start", ...A);
    const nav = await ok("navigate", `${site.origin}/s78/a`, ...A);
    expect(nav["tab"]).toBe("t1");
    const ref = await refOf("s78 send", ...A);
    t1Target = await targetAt("/s78/a");
    const from = site.hits.length;
    await portNavigate(t1Target, `${site.origin}/s78/b`);
    await waitHit("/s78/b", from);
    await until("the tab at /s78/b", async () => recs((await ok("tab", "list", ...A))["tabs"])[0], (r) => r !== undefined && "changed" in r, 5000);
    const r = await tabcap(["click", ref, ...A]);
    expect(r.error?.["code"]).toBe("tab-changed");
    const changed = rec(r.error?.["changed"]);
    expect(s(changed["from"]).endsWith("/s78/a")).toBe(true);
    expect(s(changed["to"]).endsWith("/s78/b")).toBe(true);
    expect(changed["by"]).toBe("external");
    expect(s(r.error?.["next"])).toContain("tab select t1");
    expect(site.hits.slice(from)).not.toContain("/s78/api");
    const snap = await ok("snapshot", ...A);
    expect(s(snap["tree"])).toContain("S78_B");
    expect(rec(snap["changed"])["by"]).toBe("external");
  });

  test("3. navigate on the tab acknowledges; the page works again", async () => {
    await ok("navigate", `${site.origin}/s78/a`, "--tab", "t1", ...A);
    expect("changed" in (recs((await ok("tab", "list", ...A))["tabs"])[0] ?? {})).toBe(false);
    const from = site.hits.length;
    await ok("click", await refOf("s78 send", ...A), ...A);
    await waitHit("/s78/api", from);
  });

  test("4. 11-11: an external navigation during a command on another tab is not that command's", async () => {
    await ok("tab", "new", `${site.origin}/s78/poll`, ...A);
    const waiting = tabcap(["wait", "--idle", "2500", "--tab", "t2", "--timeout", "4000", ...A]);
    await Bun.sleep(600);
    const from = site.hits.length;
    await portNavigate(t1Target, `${site.origin}/s78/b`);
    await waitHit("/s78/b", from);
    const w = await waiting;
    expect(w.error?.["code"]).toBe("timeout");
    const row = recs((await ok("tab", "list", ...A))["tabs"]).find((x) => x["tab"] === "t1");
    expect(s(rec(row?.["changed"])["to"]).endsWith("/s78/b")).toBe(true);
  });

  test("5. the page's own navigation is not external", async () => {
    expect((await ok("tab", "select", "t1", ...A))["current"]).toBe("t1");
    const from = site.hits.length;
    await ok("navigate", `${site.origin}/s78/self`, "--tab", "t1", ...A);
    await waitHit("/s78/c", from);
    await until("t1 at /s78/c", async () => s((await ok("snapshot", "--tab", "t1", ...A))["tree"]), (t) => t.includes("S78_C"), 5000);
    const r = await ok("click", await refOf("s78 send", "--tab", "t1", ...A), "--tab", "t1", ...A);
    expect("changed" in r).toBe(false);
  });

  let humanTarget = "";

  test("6. everything visible: another session lists a's tabs with their holder, the human's tab with none; --target reads without taking", async () => {
    expect((await ok("session", "start", "b", "--purpose", "s78 reader"))["purpose"]).toBe("s78 reader");
    const made = await fetch(`http://127.0.0.1:${port}/json/new?${site.origin}/s78/b`, { method: "PUT" });
    humanTarget = s(rec(await made.json())["id"]);
    const others = recs((await ok("tab", "list", "--all", "--session", "b"))["others"]);
    const t1Row = others.find((x) => x["target"] === t1Target.toLowerCase());
    expect(rec(t1Row?.["holder"])).toMatchObject({ session: "a", tab: "t1", owned: true, purpose: null, isolated: false });
    expect(rec(rec(t1Row?.["holder"])["lastAction"])["action"]).toBe("click");
    expect(others.find((x) => x["target"] === humanTarget.toLowerCase())?.["holder"]).toBeNull();
    const aOthers = recs((await ok("tab", "list", "--all", ...A))["others"]);
    expect(aOthers.some((x) => rec(x["holder"])["session"] === "a")).toBe(false);
    expect(aOthers.some((x) => x["target"] === humanTarget.toLowerCase())).toBe(true);
    // a's refs survive b's read of the same tab (the viewer has its own ref table)
    const aRef = await refOf("s78 send", "--tab", "t1", ...A);
    const view = await ok("snapshot", "--target", t1Target.slice(0, 8).toLowerCase(), "--session", "b");
    expect(s(view["tree"])).toContain("S78_C");
    const shot = await ok("screenshot", "--target", t1Target, "--session", "b");
    expect(typeof shot["path"] === "string" || typeof shot["file"] === "string").toBe(true);
    expect(recs((await ok("tab", "list", "--session", "b"))["tabs"])).toEqual([]);
    const aList = await ok("tab", "list", ...A);
    expect(aList["current"]).toBe("t1");
    expect(recs(aList["tabs"]).map((x) => x["tab"])).toEqual(["t1", "t2"]);
    const from = site.hits.length;
    await ok("click", aRef, "--tab", "t1", ...A);
    await waitHit("/s78/api", from);
    expect((await tabcap(["snapshot", "--target", t1Target, "--tab", "t1", "--session", "b"])).error?.["code"]).toBe("usage");
    const listed = recs((await ok("session", "list"))["sessions"]).find((x) => x["session"] === "b");
    expect(listed?.["purpose"]).toBe("s78 reader");
  });

  test("7. cross-session take: b adopts a's t1 without asking; a hears tab-taken once; a takes it back", async () => {
    const aRef = await refOf("s78 send", "--tab", "t1", ...A);
    const took = await ok("tab", "adopt", t1Target.slice(0, 8).toLowerCase(), "--session", "b");
    expect(took).toMatchObject({ session: "b", owned: false, reason: "borrowed", from: "a" });
    const bTab = s(took["tab"]);
    expect(took["current"]).toBe(bTab);
    const first = await tabcap(["click", aRef, "--tab", "t1", ...A]);
    expect(first.error?.["code"]).toBe("tab-taken");
    expect(first.error?.["by"]).toBe("b");
    expect(s(first.error?.["next"])).toContain("tab adopt");
    expect((await tabcap(["click", aRef, "--tab", "t1", ...A])).error?.["code"]).toBe("no-tab");
    // b reads and acts on it
    expect(s((await ok("snapshot", "--session", "b"))["tree"])).toContain("S78_C");
    const back = await ok("tab", "adopt", t1Target, ...A);
    expect(back).toMatchObject({ session: "a", from: "b" });
    expect((await tabcap(["snapshot", "--session", "b"])).error?.["code"]).toBe("tab-taken");
    const from = site.hits.length;
    await ok("click", await refOf("s78 send", ...A), ...A);
    await waitHit("/s78/api", from);
  });

  test("9. stop: the bundle is finished", async () => {
    bundle = s((await ok("session", "stop", "a"))["bundle"]);
    expect(bundle).not.toBe("");
  });

  test("2. the bundle: external navigations and their documents are external, cmd null; the session's own are ai", () => {
    const events = readFileSync(join(bundle, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l): unknown => JSON.parse(l))
      .filter(isRecord);
    const navs = events.filter((e) => e["kind"] === "nav");
    const toB = navs.filter((e) => s(e["url"]).endsWith("/s78/b"));
    expect(toB).toHaveLength(2);
    for (const e of toB) expect(e).toMatchObject({ actor: "external", cmd: null });
    const docsB = events.filter((e) => e["kind"] === "request" && e["type"] === "document" && s(e["url"]).endsWith("/s78/b"));
    expect(docsB.length).toBeGreaterThanOrEqual(2);
    for (const e of docsB) expect(e).toMatchObject({ actor: "external", cmd: null });
    for (const e of navs.filter((x) => /\/s78\/(a|self|c|poll)$/.test(s(x["url"])))) expect(e["actor"]).toBe("ai");
    const ownA = navs.find((e) => s(e["url"]).endsWith("/s78/a"));
    expect(s(ownA?.["cmd"])).toMatch(/^c-\d+$/);
    const api = events.filter((e) => e["kind"] === "request" && s(e["url"]).endsWith("/s78/api"));
    expect(api.length).toBe(4);
    for (const e of api) expect(e).toMatchObject({ actor: "ai", cmd: expect.stringMatching(/^c-\d+$/) });
    // 7: the take is in a's bundle; the tab came back as a borrowed tab from b
    expect(events.filter((e) => e["kind"] === "tab" && e["reason"] === "taken")).toMatchObject([{ phase: "detach", by: "b" }]);
    expect(events.filter((e) => e["kind"] === "tab" && e["from"] === "b")).toMatchObject([{ phase: "attach", reason: "borrowed", owned: false }]);
  });
});
