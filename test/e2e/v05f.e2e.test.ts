// L2 for 0.5-F in-command search (Chrome for Testing, the real daemon, the range in site.ts).
// Expected values come from the range pages, never from tabcap:
//   - s22 (frames): the table cells S22_TABLE_CELLS (2 rows × 2 cells) in frame f2/f1/f1;
//   - s40 (locale tables): S40_TABLES["en-US"] cells and S40_ROWS;
//   - the search range: SEARCH_MIN_HTML / SEARCH_MIN_JS / SEARCH_MIN_API literals;
//     `trace list` gives the caller positions, the expected text at each
//     position is cut from the literal source with that position;
//   - refs: a filtered snapshot must give an element the ref the full snapshot gave it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S22_TABLE_CELLS, S40_ROWS, S40_TABLES, SEARCH_MIN_API, SEARCH_MIN_HTML, SEARCH_MIN_JS, SEARCH_MIN_TOKEN, startFrameSite, startLocaleSite, startTraceSite, type FrameSite, type Site, type TraceSite } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let home = "";
let frames: FrameSite;
let locale: Site;
let trace: TraceSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

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

async function until<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T = await get();
  while (!done(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await Bun.sleep(150);
    last = await get();
  }
  return last;
}

/** The ref on the first tree line that contains `text` (quoted) and a ref starting with `prefix`. */
function refWith(tree: string, text: string, prefix = ""): string {
  const line = tree.split("\n").find((l) => l.includes(JSON.stringify(text)) && l.includes(`[${prefix}e`));
  const m = /\[((?:f\d+\/)*e\d+)\]/.exec(line ?? "");
  if (m === null || m[1] === undefined) throw new Error(`no line with ${text} in:\n${tree}`);
  return m[1];
}

/** The ref on the first line of a role (e.g. "table"). */
function refOfRole(tree: string, role: string, prefix = ""): string {
  const line = tree.split("\n").find((l) => new RegExp(`^\\s*- ${role}\\b`).test(l) && l.includes(`[${prefix}e`));
  const m = /\[((?:f\d+\/)*e\d+)\]/.exec(line ?? "");
  if (m === null || m[1] === undefined) throw new Error(`no ${role} line in:\n${tree}`);
  return m[1];
}

describe.skipIf(!enabled)("tabcap 0.5-F L2 (in-command search: snapshot filters, html, body line search, net grep)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e5f-"));
    frames = startFrameSite();
    locale = startLocaleSite();
    trace = startTraceSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    frames.stop();
    locale.stop();
    trace.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("s22: snapshot --grep across --frames keeps the full snapshot's frame refs and the ancestor chain; --css in one frame; --ref --depth", async () => {
    const S = ["--session", "fr"];
    await ok("navigate", `${frames.a}/s22`, ...S);
    await ok("wait", "--text", S22_TABLE_CELLS[1][0], ...S);
    const full = s((await ok("snapshot", "--frames", ...S))["tree"]);
    const [c00, c01] = S22_TABLE_CELLS[0];
    const fullRef = refWith(full, c00, "f2/f1/f1/");

    const g = await ok("snapshot", "--frames", "--grep", `^\\S+ "${c00}"`, ...S);
    expect(rec(g["search"])).toMatchObject({ mode: "grep", matches: 1, shown: 1 });
    const gt = s(g["tree"]);
    expect(refWith(gt, c00, "f2/f1/f1/")).toBe(fullRef);
    expect(gt).not.toContain(JSON.stringify(c01)); // only the match and its ancestors, no siblings
    // header lines stay; the match sits under its frame heading and an ancestor chain
    expect(gt).toContain("frames ");
    const lines = gt.split("\n");
    const at = lines.findIndex((l) => l.includes(`[${fullRef}]`));
    const heading = lines.findLastIndex((l, i) => i < at && l.startsWith("frame f2/f1/f1"));
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(at - heading).toBeGreaterThan(1); // at least one ancestor line between

    const ctx = await ok("snapshot", "--frames", "--grep", `^\\S+ "${c00}"`, "--context", "1", ...S);
    expect(s(ctx["tree"])).toContain(JSON.stringify(c01)); // the sibling cell

    const css = await ok("snapshot", "--frame", "f2/f1/f1", "--css", "td", ...S);
    expect(rec(css["search"])).toMatchObject({ mode: "css", matches: 4, shown: 4 });
    const ct = s(css["tree"]);
    for (const row of S22_TABLE_CELLS) for (const cell of row) expect(ct).toContain(JSON.stringify(cell));
    expect(refWith(ct, c00, "f2/f1/f1/")).toBe(fullRef);

    const xp = await ok("snapshot", "--frame", "f2/f1/f1", "--xpath", "//tr[2]/td[1]", ...S);
    expect(rec(xp["search"])).toMatchObject({ mode: "xpath", matches: 1 });
    expect(s(xp["tree"])).toContain(JSON.stringify(S22_TABLE_CELLS[1][0]));

    const table = refOfRole(full, "(table|LayoutTable)", "f2/f1/f1/");
    const sub = await ok("snapshot", "--ref", table, "--depth", "1", ...S);
    const st = s(sub["tree"]);
    const body = st.split("\n").filter((l) => /^\s*- /.test(l) && !l.startsWith("- frame") && l.includes("["));
    expect(st).toContain(`[${table}]`);
    expect(rec(sub["search"])["hidden"]).toBeGreaterThan(0);
    // depth 1: no cell text yet; with no depth limit every cell is in
    for (const row of S22_TABLE_CELLS) for (const cell of row) expect(st).not.toContain(JSON.stringify(cell));
    const all = s((await ok("snapshot", "--ref", table, ...S))["tree"]);
    for (const row of S22_TABLE_CELLS) for (const cell of row) expect(all).toContain(JSON.stringify(cell));
    expect(body.length).toBeGreaterThan(0);

    // html on a frame ref: its own document, read in the isolated world
    const h = await ok("html", table, "--text", ...S);
    expect(h).toMatchObject({ ref: table, frame: "f2/f1/f1", mode: "text", tag: "table", truncated: false });
    expect(s(h["text"])).toBe(S22_TABLE_CELLS.flat().join(""));

    const bad = await tabcap(["snapshot", "--grep", "(", ...S]);
    expect(bad.ok).toBe(false);
    expect(rec(bad.error)["code"]).toBe("usage");
    const badCss = await tabcap(["snapshot", "--css", "td[", ...S]);
    expect(rec(badCss.error)["code"]).toBe("usage");
  }, 90_000);

  test("s40: snapshot --css / --grep on a table; html outer / inner / text / attrs with --max-chars", async () => {
    const S = ["--session", "lc"];
    await ok("navigate", `${locale.origin}/s40?locale=en-US`, ...S);
    await ok("wait", "--text", "rows 2", ...S);
    const cols = S40_TABLES["en-US"];
    const amount = cols[0]?.cells[0] ?? "?";
    const tr = await ok("snapshot", "--css", "table#rows tbody tr", ...S);
    expect(rec(tr["search"])).toMatchObject({ mode: "css", matches: 2, shown: 2 });
    const g = await ok("snapshot", "--grep", amount.replaceAll(".", "\\."), ...S);
    expect(rec(g["search"])).toMatchObject({ matches: 1 });
    expect(s(g["tree"])).toContain(amount);
    const cap = await ok("snapshot", "--css", "td", "--max-matches", "3", ...S);
    expect(rec(cap["search"])).toMatchObject({ matches: cols.length * 2, shown: 3 });
    expect(cap["truncated"]).toBe(true);
    expect(s(cap["note"])).toContain("--max-matches");

    const outer = await ok("html", "--css", "table#rows", ...S);
    expect(outer).toMatchObject({ selector: "table#rows", matched: 1, mode: "outer", tag: "table" });
    expect(s(outer["html"]).startsWith('<table id="rows">')).toBe(true);
    const cut = await ok("html", "--css", "table#rows", "--max-chars", "50", ...S);
    expect(cut["truncated"]).toBe(true);
    expect(s(cut["html"])).toHaveLength(50);
    expect(Number(cut["chars"])).toBe(s(outer["html"]).length);
    const td = await ok("html", "--css", "#rows tbody td", "--text", ...S);
    expect(td).toMatchObject({ matched: cols.length * 2, text: amount });
    expect(s(td["first"])).toContain(`first of ${cols.length * 2}`);
    const attrs = await ok("html", "--css", "table#rows", "--attrs", ...S);
    expect(attrs["attrs"]).toEqual({ id: "rows" });
    const tableRef = refOfRole(s((await ok("snapshot", ...S))["tree"]), "(table|LayoutTable)");
    const inner = await ok("html", tableRef, "--inner", ...S);
    expect(s(inner["html"]).startsWith("<thead>")).toBe(true);
    const none = await tabcap(["html", "--css", "#nope", ...S]);
    expect(rec(none.error)["code"]).toBe("not-found");

    // the JSON rows body, pretty-printed and sliced
    await ok("net", "start", ...S);
    await ok("reload", ...S);
    await ok("wait", "--text", "rows 2", ...S);
    const list = await until("the rows request", () => ok("net", "list", "--filter", "/api/rows", ...S), (l) => recs(l["requests"]).length > 0);
    const id = s(recs(list["requests"])[0]?.["id"]);
    const pretty = await ok("net", "body", id, "--pretty", "--lines", "1-4", ...S);
    const want = JSON.stringify(JSON.parse(S40_ROWS), null, 2).split("\n");
    expect(pretty).toMatchObject({ pretty: true, lines: want.length, from: 1, to: 4 });
    expect(recs(pretty["content"]).map((c) => c["text"])).toEqual(want.slice(0, 4));
    await ok("net", "stop", ...S);
  }, 90_000);

  test("search range: trace list → net body --url … --at (raw and --pretty), --grep, --lines; net grep across the session", async () => {
    const S = ["--session", "mn"];
    await ok("net", "start", ...S);
    await ok("trace", "start", ...S);
    await ok("navigate", `${trace.a}/trace/min.html`, ...S);
    await ok("wait", "--text", SEARCH_MIN_TOKEN, ...S);
    const scriptUrl = `${trace.a}/trace/min.js`;
    const docUrl = `${trace.a}/trace/min.html`;
    const list = await until(
      "both callers",
      () => ok("trace", "list", ...S),
      (l) => ["Navigator.prototype.userAgent", "Navigator.prototype.platform"].every((api) => recs(l["rows"]).some((r) => r["api"] === api)),
    );
    const row = (api: string) => recs(list["rows"]).find((r) => r["api"] === api);
    const ua = row("Navigator.prototype.userAgent");
    const pf = row("Navigator.prototype.platform");
    expect(ua?.["script"]).toBe(scriptUrl);
    expect(pf?.["script"]).toBe(docUrl);
    const uaAt = recs(ua?.["callers"])[0] ?? {};
    const pfAt = recs(pf?.["callers"])[0] ?? {};
    expect(uaAt["line"]).toBe(1);
    expect(pfAt["line"]).toBe(2);

    // --at on the external script: the raw line around the caller column
    const uaCol = Number(uaAt["col"]);
    const raw = await ok("net", "body", "--url", scriptUrl, "--at", `1:${uaCol}`, "--context", "0", ...S);
    expect(raw).toMatchObject({ resolvedBy: "url", sameUrl: 1, pretty: false, lines: 1 });
    expect(rec(raw["at"])).toMatchObject({ line: 1, col: uaCol, text: SEARCH_MIN_JS });
    // the caller column (V8's, via trace list) lies on the property access in the literal source
    const uaSpan = SEARCH_MIN_JS.indexOf("navigator.userAgent");
    expect(uaCol - 1).toBeGreaterThanOrEqual(uaSpan);
    expect(uaCol - 1).toBeLessThan(uaSpan + "navigator.userAgent".length);
    const tail = SEARCH_MIN_JS.slice(uaCol - 1, SEARCH_MIN_JS.indexOf(";", uaCol));
    // with --pretty the same raw position lands on the pretty line that holds it
    const pr = await ok("net", "body", "--url", scriptUrl, "--at", `1:${uaCol}`, "--pretty", "--context", "1", ...S);
    const pat = rec(pr["at"]);
    expect(pr["pretty"]).toBe(true);
    expect(Number(pr["lines"])).toBeGreaterThan(5);
    expect(pat["raw"]).toEqual({ line: 1, col: uaCol });
    expect(Number(pat["line"])).toBeGreaterThan(1);
    expect(s(pat["text"])).toContain("navigator.userAgent");
    // the text from the mapped column is the raw text from the caller column, up to the statement end
    expect(s(pat["text"]).slice(Number(pat["col"]) - 1).startsWith(tail)).toBe(true);

    // --at on the inline script: the document's own line 2
    const pfCol = Number(pfAt["col"]);
    const doc = await ok("net", "body", "--url", docUrl, "--at", `2:${pfCol}`, "--context", "1", ...S);
    const docLines = SEARCH_MIN_HTML.split("\n");
    expect(rec(doc["at"])).toMatchObject({ line: 2, col: pfCol, text: docLines[1], before: [docLines[0]], after: [] });
    const pfSpan = s(docLines[1]).indexOf("navigator.platform");
    expect(pfCol - 1).toBeGreaterThanOrEqual(pfSpan);
    expect(pfCol - 1).toBeLessThan(pfSpan + "navigator.platform".length);

    // --grep / --lines on the script by id
    const reqs = recs((await ok("net", "list", "--all", "--page-size", "0", ...S))["requests"]);
    const jsId = s(reqs.find((r) => s(r["url"]) === scriptUrl)?.["id"]);
    const apiId = s(reqs.find((r) => s(r["url"]).endsWith("/trace/min-api"))?.["id"]);
    const g = await ok("net", "body", jsId, "--grep", "s05f-key", ...S);
    expect(g).toMatchObject({ total: 1, shown: 1, lines: 1, bytes: SEARCH_MIN_JS.length });
    expect(rec(recs(g["matches"])[0])).toMatchObject({ line: 1, col: SEARCH_MIN_JS.indexOf("s05f-key") + 1 });
    const gp = await ok("net", "body", jsId, "--grep", "function", "--pretty", "--context", "0", ...S);
    expect(gp["total"]).toBe(SEARCH_MIN_JS.split("function").length - 1);
    expect(new Set(recs(gp["matches"]).map((m) => m["line"])).size).toBe(Number(gp["total"])); // one per pretty line
    const ln = await ok("net", "body", jsId, "--lines", "1-3", ...S);
    expect(ln).toMatchObject({ from: 1, to: 1, content: [{ line: 1, text: SEARCH_MIN_JS }] });

    // net grep: raw text across every recorded body of the session
    const tok = await ok("net", "grep", SEARCH_MIN_TOKEN, ...S);
    const hits = recs(tok["requests"]);
    // the token literal is only in the API body (the script reads j.token)
    expect(hits.map((h) => h["id"])).toEqual([apiId]);
    expect(rec(hits[0])).toMatchObject({ url: `${trace.a}/trace/min-api`, count: 1 });
    expect(rec(recs(rec(hits[0])["matches"])[0])["text"]).toBe(SEARCH_MIN_API);
    const sku = await ok("net", "grep", "S05F-\\d", "--resource-types", "fetch", "--max-matches", "1", ...S);
    expect(recs(sku["requests"]).map((h) => [h["id"], h["count"], recs(h["matches"]).length])).toEqual([[apiId, 2, 1]]);
    const scripts = await ok("net", "grep", "s05f", "--resource-types", "script", ...S);
    expect(recs(scripts["requests"]).map((h) => h["id"])).toEqual([jsId]);
    const both = await ok("net", "grep", "navigator\\.(userAgent|platform)", ...S);
    expect(recs(both["requests"]).map((h) => h["url"]).sort()).toEqual([docUrl, scriptUrl].sort());
    expect(both).toMatchObject({ more: 0, skipped: [] });

    // 0.5-F2 net body --file: the decoded body as a file in the open recording's exports/bodies/, 0600
    const bundle = s((await ok("net", "list", ...S))["bundle"]);
    const fd = await ok("net", "body", "--url", docUrl, "--file", ...S);
    expect(fd).toMatchObject({ mime: "text/html", pretty: false, scrubbed: true, bytes: SEARCH_MIN_HTML.length, lines: 2, url: docUrl });
    expect(Object.keys(fd).filter((k) => k !== "trace").sort()).toEqual(["bytes", "file", "id", "lines", "mime", "pretty", "scrubbed", "url"]);
    expect(fd["file"]).toBe(join(bundle, "exports", "bodies", `${s(fd["id"])}.html`));
    expect(readFileSync(s(fd["file"]), "utf8")).toBe(SEARCH_MIN_HTML);
    if (process.platform !== "win32") expect(statSync(s(fd["file"])).mode & 0o777).toBe(0o600);
    const fj = await ok("net", "body", jsId, "--file", ...S);
    expect(readFileSync(s(fj["file"]), "utf8")).toBe(SEARCH_MIN_JS);
    expect(fj).toMatchObject({ lines: 1, pretty: false, bytes: SEARCH_MIN_JS.length });
    const fjp = await ok("net", "body", jsId, "--file", "--pretty", ...S);
    expect(fjp["file"]).toBe(join(bundle, "exports", "bodies", `${jsId}.pretty.js`));
    expect(fjp["pretty"]).toBe(true);
    const pt = readFileSync(s(fjp["file"]), "utf8");
    expect(pt.split("\n").length).toBe(Number(fjp["lines"]));
    expect(Number(fjp["lines"])).toBeGreaterThan(5);
    expect(pt.replace(/\s+/g, "")).toBe(SEARCH_MIN_JS.replace(/\s+/g, "")); // whitespace insertions only
    const clash = await tabcap(["net", "body", jsId, "--file", "--grep", "sign", ...S]);
    expect(clash.ok).toBe(false);
    expect(clash.error?.["code"]).toBe("usage");
    await ok("trace", "stop", ...S);
    await ok("net", "stop", ...S);
  }, 90_000);
});
