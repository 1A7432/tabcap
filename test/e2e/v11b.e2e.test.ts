// L2 for docs/04 §53 (docs/05 s79): the rest of the 0.9.1 field report on pages
// shaped like Element UI 2 (hand-written, test/e2e/site.ts startPageOpsSite).
// Oracle: what the page recorded (`window.__s79`, read with evaluate), the range's
// request and Authorization logs, and the bundle's events.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPageOpsSite, type PageOpsSite } from "./site.ts";
import { cliFor, rec, recs, s, until } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const P = ["--session", "p"];
const PLUGIN = join(import.meta.dir, "plugins", "b64-decode");

let home = "";
let site: PageOpsSite;
let bundle = "";
const { tabcap, ok } = cliFor(() => home);

const log = async (tab = "t1"): Promise<string[]> => {
  const v = (await ok("evaluate", "window.__s79", "--tab", tab, ...P))["value"];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};
/** The ref of the first line of `snapshot --css <sel>` (an accessible line or a DOM-backed one). */
const cssRef = async (sel: string): Promise<string> => {
  const tree = s((await ok("snapshot", "--css", sel, ...P))["tree"]);
  const m = /\[((?:f\d+\/)*e\d+)\]/.exec(tree.split("\n").filter((l) => !l.startsWith("overlays") && !l.startsWith("detected") && !l.startsWith("frames")).join("\n"));
  if (m === null || m[1] === undefined) throw new Error(`no ref for ${sel} in ${tree.slice(0, 2000)}`);
  return m[1];
};
const hitRef = async (text: string, ...more: string[]): Promise<string> => s(recs((await ok("find", text, ...more, ...P))["hits"])[0]?.["ref"]);

describe.skipIf(!enabled)("tabcap page operations L2 (s79)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e11b-"));
    site = startPageOpsSite();
    mkdirSync(join(home, "config", "plugins"), { recursive: true, mode: 0o700 });
    cpSync(PLUGIN, join(home, "config", "plugins", "b64-decode"), { recursive: true });
    await ok("plugin", "enable", "b64-decode");
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", ...P))["bundle"]);
    await ok("navigate", `${site.origin}/s79`, ...P);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("1. a text hit's ref is the option itself; clicking the whole list is ambiguous-target", async () => {
    await ok("evaluate", "s79toggle()", ...P);
    const ref = await hitRef("S79_TARGET 1001");
    expect((await ok("html", ref, ...P))["tag"]).toBe("li");
    const listRef = await cssRef(".s79-layer ul");
    const r = await tabcap(["click", listRef, ...P]);
    expect(r.error?.["code"]).toBe("ambiguous-target");
    expect(s(rec(r.error?.["landedOn"])["tag"])).toBe("li");
    expect((await log()).filter((x) => x.startsWith("pick:"))).toEqual([]);
    const c = await ok("click", ref, "--trusted", ...P);
    expect(s(rec(c["landedOn"])["text"])).toContain("S79_TARGET");
    expect((await log()).at(-1)).toBe("pick:S79_TARGET 1001");
  });

  test("2. a dialog at the end of a page of 8000+ elements: found, its lines first, the page behind it folded", async () => {
    expect((await ok("evaluate", "document.querySelectorAll('body *').length", ...P))["value"]).toBeGreaterThan(8000);
    await ok("evaluate", "s79open()", ...P);
    const snap = await ok("snapshot", "--interactive", ...P);
    const tree = s(snap["tree"]);
    expect(tree).toMatch(/overlays {2}o1 dialog/);
    expect(tree).toContain("order     o1 first");
    expect(tree).toContain("S79 建账");
    expect(tree).toMatch(/… \d+ lines behind o1 \(--behind to show\)/);
    expect(tree).not.toContain("S79 菜单 10");
    expect(rec(snap["behind"])["overlay"]).toBe("o1");
    const all = s((await ok("snapshot", "--interactive", "--behind", "--max-chars", "400000", ...P))["tree"]);
    expect(all).toContain("S79 菜单 10");
    expect(all.indexOf("S79 建账")).toBeLessThan(all.indexOf("S79 菜单 10"));
  });

  test("3. invisible copies get no line and no ref; a DOM ref to one is not-visible; the icon button has a name", async () => {
    const tree = s((await ok("snapshot", ...P))["tree"]);
    expect(tree).toContain('button "S79 建账"');
    expect(tree.split("S79 建账").length - 1).toBe(1);
    expect(tree).toContain('button "(icon: close)"');
    expect((await ok("find", "S79 建账", ...P))["total"]).toBe(1);
    const ghost = await cssRef("#ghost");
    const r = await tabcap(["click", ghost, ...P]);
    expect(r.error?.["code"]).toBe("not-visible");
    expect(await log()).not.toContain("hidden-build");
    await ok("click", await hitRef("S79 建账"), ...P);
    expect((await log()).at(-1)).toBe("build");
    await ok("evaluate", "s79close()", ...P);
  });

  test("4. select: the layer, ARIA, native; not-found lists options; a decoy pick is not-selected", async () => {
    const pick = await cssRef("#pick");
    const a = await ok("select", pick, "S79_TARGET 1001", ...P);
    expect(a["via"]).toBe("layer");
    expect(s(a["value"])).toContain("S79_TARGET");
    expect((await log()).at(-1)).toBe("pick:S79_TARGET 1001");
    const b = await ok("select", await cssRef("#aria"), "S79 乙", ...P);
    expect(b["via"]).toBe("aria");
    expect((await log()).at(-1)).toBe("aria:S79 乙");
    const c = await ok("select", await cssRef("#nat"), "S79 二", ...P);
    expect(c["via"]).toBe("native");
    expect((await log()).filter((x) => x === "change:S79 二")).toHaveLength(1);
    const none = await tabcap(["select", pick, "不存在的项", ...P]);
    expect(none.error?.["code"]).toBe("not-found");
    const cands = none.error?.["candidates"];
    expect(Array.isArray(cands) ? cands.length : 0).toBeGreaterThan(0);
    await ok("evaluate", "window.__s79decoy = true", ...P);
    const d = await tabcap(["select", pick, "S79_TARGET 1001", ...P]);
    expect(d.error?.["code"]).toBe("not-selected");
    expect(s(d.error?.["got"])).toContain("S79_DECOY");
    await ok("evaluate", "window.__s79decoy = false", ...P);
  });

  test("5. notices: the alert and the field error of one click, gone from a later snapshot", async () => {
    const r = await ok("click", await hitRef("S79 保存"), ...P);
    const notices = recs(r["notices"]);
    expect(notices).toContainEqual({ kind: "alert", text: "S79 科目为空" });
    expect(notices).toContainEqual({ kind: "text", text: "S79 名称不能为空" });
    await Bun.sleep(3000);
    expect(s((await ok("snapshot", ...P))["tree"])).not.toContain("S79 科目为空");
  });

  test("6. table rows: copies merged by index, named by their cells; find --within picks one row", async () => {
    const lines = s((await ok("snapshot", "--grep", "S79 公司03", "--max-matches", "20", ...P))["tree"]).split("\n").filter((l) => /- row /.test(l));
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l).toContain("A03");
    expect(lines.filter((l) => l.includes("(same row as "))).toHaveLength(2);
    const f = await ok("find", "S79 删除", "--within", "S79 公司03", ...P);
    expect(recs(f["hits"])).toHaveLength(1);
    await ok("click", s(recs(f["hits"])[0]?.["ref"]), ...P);
    expect((await log()).at(-1)).toBe("del:S79 公司03");
  });

  test("7. --wait requests waits for the command's own request, not the long poll", async () => {
    const slow = await hitRef("S79 慢请求");
    const r = await ok("click", slow, "--wait", "requests", ...P);
    const req = rec(rec(r["wait"])["requests"]);
    expect(req["finished"]).toBe(1);
    expect(req["pending"]).toBeUndefined();
    const ids = Array.isArray(req["ids"]) ? req["ids"].map(String) : [];
    expect(ids).toHaveLength(1);
    const listed = recs((await ok("net", "list", "--filter", "/s79/api/slow", ...P))["requests"]).map((x) => s(x["id"]));
    expect(listed).toContain(ids[0] ?? "");
    const q = await ok("click", slow, ...P);
    expect(rec(q["wait"])["requests"]).toBeUndefined();
    expect(Number(rec(q["wait"])["ms"])).toBeLessThan(800);
  });

  test("8. fetch --like: authentication from the sending tab, storage templates, decoded answers", async () => {
    await ok("click", await hitRef("S79 查询"), "--wait", "requests", ...P);
    const rA = s(recs((await ok("net", "list", "--filter", "/s79/api/list", ...P))["requests"]).at(-1)?.["id"]);
    await ok("navigate", `${site.origin}/s79?acct=B`, "--new-tab", ...P);
    await ok("click", await hitRef("S79 查询"), "--wait", "requests", ...P);
    const from = site.auth.length;
    const f = await ok("fetch", "--like", rA, "--json", '{"acct":"B"}', "--tab", "t2", ...P);
    expect(site.auth.slice(from)).toEqual(["Bearer tok-B"]);
    expect(rec(f["auth"])["tab"]).toBe("t2");
    expect(f["decoded"]).toBe("plugin:b64-decode");
    expect(JSON.parse(s(f["body"]))).toEqual({ code: 0, acct: "B", list: ["B-1", "B-2"] });
    const raw = await ok("fetch", "--like", rA, "--json", '{"acct":"B"}', "--tab", "t2", "--raw", ...P);
    expect(raw["decoded"]).toBeUndefined();
    expect(typeof raw["bodyBase64"]).toBe("string");
    const st = await tabcap(["fetch", "--like", rA, "--json", '{"acct":"B"}', "--tab", "t2", "--header-from-storage", "Authorization=Bearer {local:@session:s79key}", ...P]);
    expect(st.ok).toBe(true);
    expect(site.auth.at(-1)).toBe("Bearer tok-B");
    expect(st.raw).not.toContain("tok-B");
    await until("the bundle's cmd events", () => readFileSync(join(bundle, "events.jsonl"), "utf8"), (t) => t.includes("--header-from-storage") || t.includes("headerFromStorage"), 5000);
    const cmds = readFileSync(join(bundle, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"kind":"cmd"'));
    expect(cmds.some((l) => l.includes("tok-B"))).toBe(false);
  });
});
