// L2 for `tab adopt` (docs/04 §51, docs/05 s77). A human's tab is simulated by opening it through a
// DevTools port (no opener, not through tabcap). Oracle: the range's request log and the port's own
// /json/list; tabcap's answers are checked against §51.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { frontmostApp } from "../../src/daemon/transport/direct/launcher.ts";
import { startAdoptSite, type AdoptSite } from "./site.ts";
import { cliFor, rec, recs, s, until as pollUntil } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const A = ["--session", "a"];

let home = "";
let site: AdoptSite;
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

/** Opens a tab the way a human would look to tabcap; its target id. */
async function humanTab(url: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" });
  const v: unknown = await r.json();
  if (!isRecord(v) || typeof v["id"] !== "string") throw new Error(`json/new: ${JSON.stringify(v)}`);
  return v["id"];
}

/** Navigates a tab over its own DevTools socket, outside tabcap; resolves on the command's answer. */
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
  for (let i = 0; i < 100; i++) {
    if (site.hits.slice(from).includes(path)) return;
    await Bun.sleep(100);
  }
  throw new Error(`no ${path} in ${JSON.stringify(site.hits.slice(from))}`);
};

const othersOf = async (session: string[]): Promise<Record<string, unknown>[]> => recs((await ok("tab", "list", "--all", ...session))["others"]);

describe.skipIf(!enabled)("tabcap tab adopt L2 (s77)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e10a-"));
    site = startAdoptSite();
    port = freePort();
    const add = await tabcap(["site", "add", "s77site", "--url", `${site.origin}/s77`, "--user", "u77", "--password-stdin"], "p77-secret\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME, "--chrome-arg", `--remote-debugging-port=${port}`);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  let human = "";
  let tabId = "";
  let bundle = "";

  test("1. before adopting: not in `tab list`, listed by --all; tabcap's own tab is not an other", async () => {
    human = await humanTab(`${site.origin}/s77/before`);
    await waitHit("/s77/before");
    const plain = await ok("tab", "list", ...A);
    expect(recs(plain["tabs"])).toEqual([]);
    expect("others" in plain).toBe(false);
    await ok("tab", "new", `${site.origin}/s77`, ...A);
    const others = await othersOf(A);
    expect(others.map((x) => x["target"])).toEqual([human.toLowerCase()]);
    expect(s(others[0]?.["target"])).toMatch(/^[0-9a-f]+$/);
    expect(others[0]?.["url"]).toBe(`${site.origin}/s77/before`);
  });

  test("2. errors", async () => {
    expect((await tabcap(["tab", "adopt", "deadbeef", ...A])).error?.["code"]).toBe("not-found");
    expect((await tabcap(["tab", "adopt", "ab", ...A])).error?.["code"]).toBe("usage");
  });

  test("3. adopted while recording: borrowed, current, recording", async () => {
    await ok("net", "start", ...A);
    const from = site.hits.length;
    await portNavigate(human, `${site.origin}/s77`);
    await waitHit("/s77", from);
    await Bun.sleep(300);
    const before = process.platform === "darwin" ? frontmostApp()?.name : undefined;
    const r = await ok("tab", "adopt", human.slice(0, 8).toLowerCase(), ...A);
    // 10. nothing moved on screen
    if (process.platform === "darwin") expect(frontmostApp()?.name).toBe(before);
    expect(r).toMatchObject({ session: "a", owned: false, reason: "borrowed", recording: true, url: `${site.origin}/s77` });
    tabId = s(r["tab"]);
    expect(r["current"]).toBe(tabId);
  });

  test("4. readable and operable; what it sends is recorded, what came before is not", async () => {
    expect(s((await ok("snapshot", ...A))["tree"] ?? "") + s((await ok("snapshot", ...A))["snapshot"] ?? "")).toContain("S77_MARK");
    const from = site.hits.length;
    await ok("evaluate", "document.getElementById('go').click()", ...A);
    await waitHit("/s77/api", from);
    // The request is indexed once its response is in: a moment after the server saw it.
    const rows = await pollUntil(
      "the request in net list",
      async () => recs((await ok("net", "list", "--filter", "/s77", "--tab", tabId, "--page-size", "0", ...A))["requests"]),
      (r) => r.length > 0,
      5000,
    );
    const urls = rows.map((x) => s(x["url"]));
    expect(urls.some((u) => u.endsWith("/s77/api"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/s77/before"))).toBe(false);
  });

  test("6. again in the session is idempotent; another session takes it (docs/04 §52.4) and a takes it back", async () => {
    expect(await ok("tab", "adopt", human, ...A)).toMatchObject({ tab: tabId, alreadyAdopted: true });
    const other = await ok("tab", "adopt", human, "--session", "other");
    expect(other).toMatchObject({ session: "other", from: "a", owned: false });
    expect((await tabcap(["snapshot", "--tab", tabId, ...A])).error?.["code"]).toBe("tab-taken");
    const back = await ok("tab", "adopt", human, ...A);
    expect(back).toMatchObject({ session: "a", from: "other" });
    tabId = s(back["tab"]);
  });

  test("7. tab close refuses; the tab is still there", async () => {
    expect((await tabcap(["tab", "close", tabId, ...A])).error?.["code"]).toBe("conflict");
    expect((await portTabs()).some((x) => x.id === human)).toBe(true);
  });

  test("8. session stop releases: open, loads normally, listed again, adoptable under a new id", async () => {
    const r = await ok("session", "stop", "a");
    expect(r["released"]).toEqual([tabId]);
    bundle = s(r["bundle"]);
    expect((await portTabs()).some((x) => x.id === human)).toBe(true);
    const from = site.hits.length;
    await portNavigate(human, `${site.origin}/s77/before`);
    await waitHit("/s77/before", from);
    expect((await othersOf(A)).map((x) => x["target"])).toContain(human.toLowerCase());
    const again = await ok("tab", "adopt", human, ...A);
    expect(again["tab"]).not.toBe(tabId);
  });

  test("5. the bundle's tab event and manifest say borrowed", () => {
    const events = readFileSync(join(bundle, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l): unknown => JSON.parse(l));
    // Step 6 took it to "other" and back: a second borrowed attach (from "other") after a taken detach (docs/04 §52.4).
    expect(events.filter(isRecord).filter((e) => e["kind"] === "tab" && e["reason"] === "borrowed")).toMatchObject([
      { phase: "attach", owned: false, tab: expect.any(String) },
      { phase: "attach", owned: false, from: "other" },
    ]);
    expect(events.filter(isRecord).filter((e) => e["kind"] === "tab" && e["reason"] === "taken")).toMatchObject([{ phase: "detach", by: "other" }]);
    const manifest: unknown = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    expect(recs(rec(rec(manifest)["session"])["tabs"]).filter((x) => x["owned"] === false)).toHaveLength(2);
  });

  test("9. a session with its own browser context does not take a default-context tab", async () => {
    const lone = await humanTab(`${site.origin}/s77/before`);
    await ok("session", "start", "bound", "--site", "s77site", "--isolate");
    await until(lone);
    const r = await tabcap(["tab", "adopt", lone, "--session", "bound"]);
    expect(r.error?.["code"]).toBe("conflict");
    expect(recs((await ok("tab", "list", "--session", "bound"))["tabs"])).toEqual([]);
  });
});

async function until(id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await othersOf(A)).some((x) => s(x["target"]) === id.toLowerCase())) return;
    await Bun.sleep(100);
  }
  throw new Error(`tab ${id} never listed`);
}
