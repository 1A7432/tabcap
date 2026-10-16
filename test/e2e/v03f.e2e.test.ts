// L2 for 0.3-F (docs/08 §5): the chrome-devtools-mcp aligned names and the new
// commands against a local page that records what really happened in it
// (window.__log, element text, the server's own hit list). Expected values come
// from the page and the server, never from tabcap's own output. Only
// 127.0.0.1 / localhost are opened (--proxy none).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { imageSize } from "../../src/shared/png.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "f"];

/** How long /slow-dst holds its answer, and how long the page then keeps changing its DOM. */
const SLOW_MS = 400;
const MUTATE_STEPS = 4;
const API_CALLS = 23;

const HOME = (inner: string) => `<!doctype html><meta charset=utf-8><title>f home</title>
<h1>0.3-F</h1>
<button id=hov>Hover me</button><p id=hovered>not yet</p>
<button id=dbl>Double me</button><p id=dblout>no dbl</p>
<p><label>Query <input id=q></label></p><p id=keys>no keys</p>
<p><label>Files <input id=up type=file multiple></label></p><p id=files>no files</p>
<button id=pick>Pick a file</button><input id=hidden type=file style="display:none"><p id=picked>none picked</p>
<a id=slow href="/slow-dst">Go slow</a>
<button id=mut>Mutate later</button><p id=late>idle</p>
<iframe id=same srcdoc="<p>srcdoc-frame-text-31</p>"></iframe>
<iframe id=cross src="${inner}"></iframe>
<script>
window.__log = [];
document.getElementById("hov").addEventListener("mouseover", (e) => { document.getElementById("hovered").textContent = "hovered " + e.isTrusted; });
document.getElementById("dbl").addEventListener("dblclick", () => { document.getElementById("dblout").textContent = "dbl ok"; });
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("keys").textContent = "enter " + document.getElementById("q").value; });
document.getElementById("up").addEventListener("change", (e) => { document.getElementById("files").textContent = [...e.target.files].map((f) => f.name + ":" + f.size).join(","); });
document.getElementById("pick").addEventListener("click", () => document.getElementById("hidden").click());
document.getElementById("hidden").addEventListener("change", (e) => { document.getElementById("picked").textContent = [...e.target.files].map((f) => f.name).join(","); });
document.getElementById("mut").addEventListener("click", () => { setTimeout(() => { document.getElementById("late").textContent = "late change"; }, 50); });
for (let i = 0; i < 12; i++) console.log("f-log-" + i);
console.warn("f-warn-1");
console.error("f-error-1");
for (let i = 0; i < ${API_CALLS}; i++) fetch("/api/n?i=" + i);
</script>`;

const SLOW_DST = `<!doctype html><meta charset=utf-8><title>slow dst</title><h1>arrived</h1><ul id=items></ul>
<script>
let n = 0;
const step = () => { const li = document.createElement("li"); li.textContent = "item " + (++n); document.getElementById("items").appendChild(li);
  if (n < ${MUTATE_STEPS}) setTimeout(step, 60); else { const p = document.createElement("p"); p.id = "settled"; p.textContent = "settled"; document.body.appendChild(p); } };
setTimeout(step, 60);
</script>`;

const INNER = `<!doctype html><meta charset=utf-8><p>oopif-text-77</p>`;

type Env = { ok: boolean; data: Record<string, unknown>; error?: Record<string, unknown>; raw: string };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

let home = "";
let files = "";
let origin = "";
let server: ReturnType<typeof Bun.serve> | null = null;
const served: string[] = [];

async function tabcap(...args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdout: "pipe", stderr: "pipe", ...(files === "" ? {} : { cwd: files }) });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), ...(isRecord(env["error"]) ? { error: env["error"] } : {}), raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(...args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${JSON.stringify(e.error)}`);
  return e.data;
}

async function until<T>(what: string, f: () => Promise<T>, good: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!good(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await Bun.sleep(150);
    v = await f();
  }
  return v;
}

const page = async (expr: string): Promise<unknown> => (await ok("evaluate", expr, ...S))["value"];
const textOf = async (id: string): Promise<string> => s(await page(`document.getElementById(${JSON.stringify(id)}).textContent`));

/** The clickable ref `find` gives for a control. */
async function refOf(text: string): Promise<string> {
  const h = recs((await ok("find", text, ...S))["hits"]).find((x) => x["clickable"] !== null || x["ref"] !== null);
  if (h === undefined) throw new Error(`no hit for ${text}`);
  return s(h["clickable"] ?? h["ref"]);
}

/** A ref straight from the verbose snapshot text (the file inputs have no name in find). */
async function refFromTree(re: RegExp): Promise<string> {
  const tree = s((await ok("snapshot", "--verbose", ...S))["tree"]);
  const m = re.exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${re} in\n${tree}`);
  return m[1];
}

describe.skipIf(!enabled)("tabcap 0.3-F L2 (aligned names, new commands, post-action wait)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3f-"));
    files = mkdtempSync(join(tmpdir(), "tabcap-e2e3f-files-"));
    writeFileSync(join(files, "a.txt"), "alpha");
    writeFileSync(join(files, "b.txt"), "bravo!");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        served.push(`${req.method} ${u.pathname}`);
        const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (u.pathname === "/") return html(HOME(`http://localhost:${u.port}/inner`));
        if (u.pathname === "/inner") return html(INNER);
        if (u.pathname === "/slow-dst") {
          await Bun.sleep(SLOW_MS);
          return html(SLOW_DST);
        }
        if (u.pathname === "/api/n") return new Response(JSON.stringify({ i: u.searchParams.get("i") }), { headers: { "content-type": "application/json" } });
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("net", "start", ...S);
    await ok("navigate", `${origin}/`, ...S);
    await ok("wait", "--text", "0.3-F", ...S);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    server?.stop(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  });

  test("tab new opens a background tab and makes it current; tab select switches back without bringing anything to front", async () => {
    const before = await ok("tab", "list", ...S);
    const first = s(before["current"]);
    const n = await ok("tab", "new", `${origin}/inner`, ...S);
    expect(s(n["url"])).toBe(`${origin}/inner`);
    const after = await ok("tab", "list", ...S);
    expect(recs(after["tabs"])).toHaveLength(2);
    expect(after["current"]).toBe(n["tab"]);
    expect(await page("document.visibilityState")).toBe("hidden"); // a background tab
    const sel = await ok("tab", "select", first, ...S);
    expect(sel).toMatchObject({ current: first, broughtToFront: false });
    expect((await ok("tab", "list", ...S))["current"]).toBe(first);
    // the 0.3 aliases were removed in 0.4: the normal unknown-command error
    expect((await tabcap("tabs", ...S)).error).toMatchObject({ code: "usage", message: expect.stringMatching(/^unknown command: tabs/) });
    expect((await tabcap("tab", "use", first, ...S)).error).toMatchObject({ code: "usage", message: expect.stringMatching(/^unknown command: tab use/) });
    await ok("tab", "close", s(n["tab"]), ...S);
  }, 60_000);

  test("console list: page 0 of 30 (0.5-C) without paging flags, --page-size 0 for everything, page-index paging, --types, console show by msgid; the old bare `console` is gone", async () => {
    const all = await ok("console", "list", ...S);
    const entries = recs(all["entries"]);
    const texts = entries.map((e) => s(e["text"]));
    for (let i = 0; i < 12; i++) expect(texts).toContain(`f-log-${i}`);
    expect(all).toMatchObject({ pageSize: 30, pageIdx: 0 });
    expect(recs((await ok("console", "list", "--page-size", "0", ...S))["entries"]).map((e) => s(e["text"])).slice(0, texts.length)).toEqual(texts);
    const p0 = await ok("console", "list", "--page-size", "5", ...S);
    expect(recs(p0["entries"]).map((e) => s(e["text"]))).toEqual(texts.slice(0, 5));
    expect(p0).toMatchObject({ pageIdx: 0, nextPageIdx: 1 });
    expect(s(p0["pagination"])).toContain(`Showing 1-5 of ${texts.length} (Page 1 of ${Math.ceil(texts.length / 5)}).`);
    const p1 = await ok("console", "list", "--page-size", "5", "--page-idx", "1", ...S);
    expect(recs(p1["entries"]).map((e) => s(e["text"]))).toEqual(texts.slice(5, 10));
    // Chrome adds its own error lines (the favicon 404); the page's two must be there, nothing of another type.
    const warn = recs((await ok("console", "list", "--types", "warn,error", ...S))["entries"]);
    expect(warn.every((e) => e["type"] === "warn" || e["type"] === "error")).toBe(true);
    expect(warn.filter((e) => String(e["text"]).startsWith("f-")).map((e) => [e["type"], e["text"]])).toEqual([
      ["warn", "f-warn-1"],
      ["error", "f-error-1"],
    ]);
    const id = s(warn.find((e) => e["text"] === "f-warn-1")?.["msgid"]);
    expect(await ok("console", "show", id, ...S)).toMatchObject({ msgid: Number(id), type: "warn", text: "f-warn-1" });
    expect((await tabcap("console", "show", "99999", ...S)).error?.["code"]).toBe("not-found");
    expect(recs((await ok("console", "list", "--limit", "1", ...S))["entries"])).toHaveLength(1);
    expect((await tabcap("console", "--limit", "1", ...S)).error).toMatchObject({ code: "usage", message: expect.stringMatching(/^unknown command: console 1/) });
  }, 60_000);

  test("net list: page 0 of 30 (0.5-C) without paging flags, --page-size 0 for everything; --page-size / --page-idx pages with nextPageIdx; the old --limit / --offset / --type are unknown options", async () => {
    await until("all API calls recorded", () => ok("net", "list", "--filter", "/api/n", ...S), (d) => Number(d["matched"]) === API_CALLS);
    const all = await ok("net", "list", "--filter", "/api/n", ...S);
    const ids = recs(all["requests"]).map((r) => s(r["id"]));
    expect(ids).toHaveLength(API_CALLS);
    expect(all).toMatchObject({ pageSize: 30, pageIdx: 0, nextPageIdx: null });
    const everything = await ok("net", "list", "--filter", "/api/n", "--page-size", "0", ...S);
    expect(everything).toMatchObject({ pageSize: null, nextPageIdx: null });
    expect(recs(everything["requests"]).map((r) => s(r["id"]))).toEqual(ids);
    const p1 = await ok("net", "list", "--filter", "/api/n", "--page-size", "10", "--page-idx", "1", ...S);
    expect(recs(p1["requests"]).map((r) => s(r["id"]))).toEqual(ids.slice(10, 20));
    expect(p1).toMatchObject({ pageSize: 10, pageIdx: 1, totalPages: 3, nextPageIdx: 2 });
    expect(s(p1["pagination"])).toContain(`Showing 11-20 of ${API_CALLS} (Page 2 of 3).`);
    const last = await ok("net", "list", "--filter", "/api/n", "--page-size", "10", "--page-idx", "2", ...S);
    expect(last["nextPageIdx"]).toBeNull();
    const bad = await ok("net", "list", "--filter", "/api/n", "--page-size", "10", "--page-idx", "9", ...S);
    expect(bad).toMatchObject({ invalidPage: true, pageIdx: 0 });
    for (const k of ["offset", "limit", "nextOffset"]) expect(Object.keys(p1)).not.toContain(k);
    for (const flag of ["--limit", "--offset", "--type"]) expect((await tabcap("net", "list", flag, "10", ...S)).error).toMatchObject({ code: "usage", message: `unknown option ${flag}` });
    const typed = await ok("net", "list", "--resource-types", "fetch", "--filter", "/api/n", ...S);
    expect(typed["matched"]).toBe(API_CALLS);
  }, 60_000);

  test("post-action wait: a click that navigates returns only after the new document is there and its DOM is quiet", async () => {
    const link = await refOf("Go slow");
    const c = await ok("click", link, ...S);
    expect(s(c["url"])).toBe(`${origin}/slow-dst`);
    expect(rec(c["wait"])).toMatchObject({ navigated: true, domQuiet: true });
    // Read right after the command, with no wait of our own: the page's last DOM change is already there.
    expect(await page(`!!document.getElementById("settled") && document.querySelectorAll("#items li").length`)).toBe(MUTATE_STEPS);
    await ok("go", "back", ...S);
    await ok("wait", "--text", "0.3-F", ...S);
  }, 60_000);

  test("--no-wait returns right after the action; without it a late DOM change is in before the command answers", async () => {
    const mut = await refOf("Mutate later");
    const quick = await ok("click", mut, "--no-wait", ...S);
    expect(quick["wait"]).toBeNull();
    await ok("wait", "--text", "late change", ...S);
    await ok("evaluate", `document.getElementById("late").textContent = "idle"`, ...S);
    const waited = await ok("click", mut, ...S);
    expect(rec(waited["wait"])).toMatchObject({ navigated: false, domQuiet: true });
    expect(await textOf("late")).toBe("late change");
  }, 60_000);

  test("--snapshot brings back a fresh snapshot after the action; click --dbl-click fires dblclick", async () => {
    const dbl = await refOf("Double me");
    const r = await ok("click", dbl, "--dbl-click", "--snapshot", ...S);
    expect(r).toMatchObject({ dblClick: true });
    const snap = rec(r["snapshot"]);
    expect(s(snap["tree"])).toContain("dbl ok");
    expect(await textOf("dblout")).toBe("dbl ok");
  }, 60_000);

  test("hover moves a trusted pointer onto the element (the page sees a trusted mouseover)", async () => {
    const r = await ok("hover", await refOf("Hover me"), ...S);
    expect(r).toMatchObject({ trusted: true, level: 2 });
    expect(await textOf("hovered")).toBe("hovered true");
  }, 60_000);

  test("type --submit-key presses the key after typing; press-key works, the old press is gone", async () => {
    await ok("fill", await refFromTree(/textbox "Query"[^\n]*\[(e\d+)\]/), "ab", ...S); // focuses the field
    await ok("type", "c", "--submit-key", "Enter", ...S);
    expect(await textOf("keys")).toBe("enter abc");
    await ok("press-key", "End", ...S);
    expect((await tabcap("press", "End", ...S)).error).toMatchObject({ code: "usage", message: expect.stringMatching(/^unknown command: press End/) });
  }, 60_000);

  test("upload puts files into a file input (relative paths resolve against the caller), and answers a file chooser opened by a button", async () => {
    const input = await refFromTree(/(?:button|textbox) "Files"[^\n]*\[(e\d+)\]/);
    const r = await ok("upload", input, "a.txt", "b.txt", ...S);
    expect(r).toMatchObject({ method: "input", files: 2 });
    expect(await until("the change event", () => textOf("files"), (v) => v !== "no files")).toBe("a.txt:5,b.txt:6");
    const pick = await ok("upload", await refOf("Pick a file"), join(files, "a.txt"), ...S);
    expect(pick).toMatchObject({ method: "file-chooser", files: 1 });
    expect(await until("the chooser's change event", () => textOf("picked"), (v) => v !== "none picked")).toBe("a.txt");
  }, 60_000);

  test("resize sets the page's content size; emulate --viewport overrides it and a bare emulate clears it", async () => {
    // A size that fits every CI screen is exact everywhere.
    const fits = await ok("resize", "900", "500", ...S);
    expect(rec(fits["viewport"])).toEqual({ width: 900, height: 500 });
    expect(await page("[innerWidth, innerHeight]")).toEqual([900, 500]);
    const r = await ok("resize", "900", "700", ...S);
    const height = rec(r["viewport"])["height"];
    if (height !== 700) {
      // Windows never makes a window taller than the screen allows (the window's maximum
      // tracking size), and the CI runner's screen is 1024x768. Evidence, CI run 38840695217
      // (probe.log, 0.4-B): screen 1024x768, Chrome's frame 95 px (resize 900 500 → outerHeight
      // 595); resize 900 700 → Browser.getWindowBounds height 788 (795 needed), innerHeight 693,
      // devicePixelRatio 1. Only that case is let through: Windows, and a window at least as tall as the screen.
      expect(process.platform).toBe("win32");
      const fit = await page("outerHeight >= screen.height");
      expect(fit).toBe(true);
    }
    expect(rec(r["viewport"])).toEqual({ width: 900, height });
    expect(await page("[innerWidth, innerHeight]")).toEqual([900, height]);
    const nativeDpr = await page("devicePixelRatio");
    const e = await ok("emulate", "--viewport", "390x844x3,mobile,touch", ...S);
    expect(rec(e["emulation"])["viewport"]).toMatchObject({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    // A mobile viewport without <meta name=viewport> lays out 980 px wide (Chrome); the screen is the emulated one.
    expect(await page("[screen.width, screen.height, devicePixelRatio, navigator.maxTouchPoints > 0]")).toEqual([390, 844, 3, true]);
    await ok("emulate", "--viewport", "500x400", ...S);
    expect(await page("[innerWidth, innerHeight, devicePixelRatio]")).toEqual([500, 400, 1]);
    const cleared = await ok("emulate", ...S);
    expect(cleared["cleared"]).toContain("viewport");
    expect(await page("[innerWidth, devicePixelRatio]")).toEqual([900, nativeDpr]);
    expect((await tabcap("emulate", "--viewport", "wide", ...S)).error?.["code"]).toBe("usage");
  }, 60_000);

  test("wait --text matches in any frame and accepts several texts (any)", async () => {
    const same = await ok("wait", "--text", "srcdoc-frame-text-31", ...S);
    expect(same).toMatchObject({ text: "srcdoc-frame-text-31", matched: "text" });
    expect(s(same["frame"])).not.toBe("main");
    const cross = await ok("wait", "--text", "never-there-1", "--text", "oopif-text-77", ...S);
    expect(cross).toMatchObject({ text: "oopif-text-77" });
    expect(s(cross["frame"])).toContain("localhost");
    expect(served).toContain("GET /inner");
  }, 60_000);

  test("evaluate --function with --args (a ref passes the element); reload --ignore-cache; dialog --prompt-text", async () => {
    const ref = await refOf("Hover me");
    const r = await ok("evaluate", "--function", "(el, n) => el.id + n", "--args", JSON.stringify([{ ref }, 7]), ...S);
    expect(r).toMatchObject({ value: "hov7" });
    const before = served.filter((x) => x === "GET /").length;
    await ok("reload", "--ignore-cache", ...S);
    expect(served.filter((x) => x === "GET /").length).toBe(before + 1);
    await ok("evaluate", "setTimeout(() => { window.__answer = prompt('name?'); }, 10); 1", ...S);
    await until("the prompt", () => ok("dialog", "status", ...S), (d) => d["open"] === true);
    await ok("dialog", "accept", "--prompt-text", "zed", ...S);
    expect(await page("window.__answer")).toBe("zed");
  }, 60_000);

  test("screenshot --format jpeg --ref and --file-path (the old --out / --full are unknown options)", async () => {
    const out = join(files, "el.jpeg");
    const r = await ok("screenshot", "--format", "jpeg", "--quality", "70", "--ref", await refOf("Hover me"), "--file-path", out, ...S);
    expect(r).toMatchObject({ format: "jpeg", path: out });
    const bytes = new Uint8Array(readFileSync(out));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(imageSize(bytes)).toEqual({ width: Number(r["width"]), height: Number(r["height"]) });
    const old = join(files, "old.png");
    expect((await tabcap("screenshot", "--out", old, ...S)).error).toMatchObject({ code: "usage", message: "unknown option --out" });
    expect((await tabcap("screenshot", "--full", ...S)).error).toMatchObject({ code: "usage", message: "unknown option --full" });
    expect(existsSync(old)).toBe(false);
    expect((await tabcap("screenshot", "--ref", "e1", "--full-page", ...S)).error?.["code"]).toBe("usage");
  }, 60_000);
});
