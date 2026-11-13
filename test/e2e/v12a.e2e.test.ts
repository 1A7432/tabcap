// L2 for docs/04 §54 (docs/05 s80): evaluate --file, screenshot --scale, the cut-preview and redaction
// hints, --ascii, and the no-tab error's lastUrl. Oracle: the page itself (title, the striped and the solid
// band), the site's `served` hash and `loginBodies`, and the image files' own headers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize, pngIsUniform } from "../../src/shared/png.ts";
import { GAPS_BOX, GAPS_PWD, GAPS_SOLID_TOP, GAPS_TITLE, startGapsSite, type GapsSite } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";

let home = "";
let work = "";
let site: GapsSite;
const { tabcap, ok } = cliFor(() => home);

const sizeOf = (path: unknown): { width: number; height: number } => {
  const z = imageSize(readFileSync(s(path)));
  if (z === null) throw new Error(`not an image: ${s(path)}`);
  return z;
};
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;

describe.skipIf(!enabled)("docs/04 §54 gaps L2 (s80)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e12a-"));
    work = mkdtempSync(join(tmpdir(), "tabcap-e2e12a-work-"));
    site = startGapsSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("navigate", `${site.origin}/s80`);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
    removeHome(work, import.meta.file);
  });

  test("1. evaluate --file: a UTF-8 script with non-ASCII text and quotes runs as written; UTF-16 with a mark too", async () => {
    const script = "// 中文注释，'单引号' \"双引号\" `反引号`\nconst t = document.title;\n({ title: t, mark: '文件脚本 ✓' })";
    const f8 = join(work, "s80.js");
    writeFileSync(f8, script, "utf8");
    const a = await ok("evaluate", "--file", f8);
    expect(a["value"]).toEqual({ title: GAPS_TITLE, mark: "文件脚本 ✓" });
    const f16 = join(work, "s80-utf16.js");
    const le = Buffer.alloc(2 + script.length * 2);
    le.writeUInt16LE(0xfeff, 0);
    for (let i = 0; i < script.length; i++) le.writeUInt16LE(script.charCodeAt(i), 2 + i * 2);
    writeFileSync(f16, le);
    // the same page, a second run: the script's top-level `const t` did not stay behind (it runs as a block)
    expect((await ok("evaluate", "--file", f16))["value"]).toEqual({ title: GAPS_TITLE, mark: "文件脚本 ✓" });
    expect((await ok("evaluate", "typeof t"))["value"]).toBe("undefined");
    // `var` and assignments to window are the way to keep something
    writeFileSync(join(work, "keep.js"), "var s80Kept = 7;\nwindow.s80Also = 8;\n// ends with a comment", "utf8");
    await ok("evaluate", "--file", join(work, "keep.js"));
    expect((await ok("evaluate", "s80Kept + s80Also"))["value"]).toBe(15);
    // an exception names the file's own line
    writeFileSync(join(work, "throws.js"), "const a = 1;\nthrow new Error('第二行');", "utf8");
    const thrown = await tabcap(["evaluate", "--file", join(work, "throws.js")]);
    expect(thrown.error?.["code"]).toBe("page");
    expect(s(thrown.error?.["message"])).toContain("第二行");
    expect(s(thrown.error?.["message"])).toMatch(/:2:\d+/);
  });

  test("2. evaluate --file: a relative path is the caller's directory; another code page, or an expression as well, is refused before the page is touched", async () => {
    writeFileSync(join(work, "rel.js"), "document.title", "utf8");
    const relative = cliFor(() => home, { cwd: work });
    expect((await relative.ok("evaluate", "--file", "rel.js"))["value"]).toBe(GAPS_TITLE);
    // "密码" in GBK
    writeFileSync(join(work, "gbk.js"), Buffer.from([0x2f, 0x2f, 0x20, 0xc3, 0xdc, 0xc2, 0xeb, 0x0a, 0x64, 0x6f, 0x63, 0x75, 0x6d, 0x65, 0x6e, 0x74, 0x2e, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3d, 0x27, 0x78, 0x27]));
    const gbk = await tabcap(["evaluate", "--file", join(work, "gbk.js")]);
    expect(gbk.error?.["code"]).toBe("bad-input");
    const both = await tabcap(["evaluate", "1+1", "--file", join(work, "rel.js")]);
    expect(both.error?.["code"]).toBe("usage");
    expect(both.exit).toBe(2);
    expect((await ok("evaluate", "document.title"))["value"]).toBe(GAPS_TITLE);
  });

  test("3. screenshot --scale 0.5: half the width and height of the same shot, of the visible part of the page", async () => {
    await ok("evaluate", `window.scrollTo(0, ${GAPS_SOLID_TOP + 500}); window.scrollY`);
    const whole = await ok("screenshot");
    const half = await ok("screenshot", "--scale", "0.5");
    const w = sizeOf(whole["path"]);
    const h = sizeOf(half["path"]);
    expect(near(h.width * 2, w.width)).toBe(true);
    expect(near(h.height * 2, w.height)).toBe(true);
    expect(half["scale"]).toBe(0.5);
    expect("scale" in whole).toBe(false);
    // the page is scrolled into the solid band: only a clip of the visible part is one colour (the top of the page is striped)
    expect(pngIsUniform(readFileSync(s(half["path"])))).toBe(true);
    expect(pngIsUniform(readFileSync(s(whole["path"])))).toBe(true);
    await ok("evaluate", "window.scrollTo(0, 0); window.scrollY");
    expect(pngIsUniform(readFileSync(s((await ok("screenshot", "--scale", "0.5"))["path"])))).toBe(false);
  });

  test("4. --scale goes with --ref and --full-page; out of range is a usage error", async () => {
    const snap = await ok("snapshot", "--css", "#box");
    const ref = /\[(e\d+)\]/.exec(s(snap["tree"] ?? snap["text"] ?? JSON.stringify(snap)))?.[1] ?? "";
    expect(ref).not.toBe("");
    const box = sizeOf((await ok("screenshot", "--ref", ref))["path"]);
    const small = sizeOf((await ok("screenshot", "--ref", ref, "--scale", "0.5"))["path"]);
    expect(near(box.width / box.height, GAPS_BOX.width / GAPS_BOX.height) || near(box.width * GAPS_BOX.height, box.height * GAPS_BOX.width)).toBe(true);
    expect(near(small.width * 2, box.width)).toBe(true);
    expect(near(small.height * 2, box.height)).toBe(true);
    const page = sizeOf((await ok("screenshot", "--full-page"))["path"]);
    const pageHalf = sizeOf((await ok("screenshot", "--full-page", "--scale", "0.5"))["path"]);
    expect(near(pageHalf.width * 2, page.width)).toBe(true);
    expect(near(pageHalf.height * 2, page.height)).toBe(true);
    const bad = await tabcap(["screenshot", "--scale", "2"]);
    expect(bad.error?.["code"]).toBe("usage");
  });

  test("5. net body: a cut preview says where the whole body is; --out has every byte the server sent", async () => {
    await ok("net", "start");
    await ok("evaluate", "document.getElementById('load').click()");
    const w = await ok("net", "wait", "--url", "/s80/big");
    const id = s(w["id"]);
    const b = await ok("net", "body", id, "--full");
    expect(b["previewTruncated"]).toBe(true);
    expect(s(b["textPreview"]).length).toBeLessThanOrEqual(10_100);
    expect(s(b["previewHint"])).toContain("--out");
    expect(s(b["previewHint"])).toContain("--full does not");
    const out = join(work, "big.json");
    await ok("net", "body", id, "--out", out);
    expect(createHash("sha256").update(readFileSync(out)).digest("hex")).toBe(site.served.get("/s80/big") ?? "");
    // a body that fits has no hint
    const lw = await ok("net", "wait", "--url", "/s80/login", "--since", "start");
    const small = await ok("net", "body", s(lw["id"]));
    expect(small["previewTruncated"]).toBe(false);
    expect("previewHint" in small).toBe(false);
  });

  test("6. net show: a redacted field comes with the --reveal hint; --reveal shows what the server got, without it", async () => {
    const lw = await ok("net", "wait", "--url", "/s80/login", "--since", "start");
    const id = s(lw["id"]);
    expect(site.loginBodies).toEqual([`user=u80&ecLoginPwd=${GAPS_PWD}`]);
    const shown = await ok("net", "show", id);
    const text = JSON.stringify(shown);
    expect(text).toContain("<redacted:ecLoginPwd>");
    expect(text).not.toContain(GAPS_PWD);
    expect(s(shown["redactedHint"])).toContain("--reveal");
    const real = await ok("net", "show", id, "--reveal");
    expect(JSON.stringify(real)).toContain(GAPS_PWD);
    expect("redactedHint" in real).toBe(false);
    await ok("net", "stop");
  });

  test("7. --ascii and TABCAP_OUTPUT_ASCII=1: stdout is ASCII only and parses to the same answer", async () => {
    await ok("navigate", `${site.origin}/s80`);
    const plain = await tabcap(["evaluate", "document.title"]);
    expect(plain.raw).toContain(GAPS_TITLE);
    const flag = await tabcap(["evaluate", "document.title", "--ascii"]);
    expect(/^[\x0a\x20-\x7e]*$/.test(flag.raw)).toBe(true);
    expect(flag.data["value"]).toBe(GAPS_TITLE);
    const byEnv = await cliFor(() => home, { env: { TABCAP_OUTPUT_ASCII: "1" } }).tabcap(["evaluate", "document.title"]);
    expect(/^[\x0a\x20-\x7e]*$/.test(byEnv.raw)).toBe(true);
    expect(byEnv.data["value"]).toBe(GAPS_TITLE);
    // an error envelope too
    const err = await tabcap(["evaluate", "throw new Error('出错了')", "--ascii"]);
    expect(err.ok).toBe(false);
    expect(/^[\x0a\x20-\x7e]*$/.test(err.raw)).toBe(true);
    expect(s(err.error?.["message"])).toContain("出错了");
  });

  test("8. the session's last tab is closed: no-tab says where it was; navigate there opens it again, tabcap did not", async () => {
    const tabs = recs((await ok("tab", "list"))["tabs"]);
    expect(tabs.length).toBe(1);
    await ok("tab", "close", s(tabs[0]?.["tab"]));
    const e = await tabcap(["snapshot"]);
    expect(e.error?.["code"]).toBe("no-tab");
    expect(e.error?.["lastUrl"]).toBe(`${site.origin}/s80`);
    expect(s(e.error?.["message"])).toContain(`(it was at ${site.origin}/s80)`);
    expect(recs((await ok("tab", "list"))["tabs"])).toEqual([]);
    const again = await ok("navigate", s(e.error?.["lastUrl"]));
    expect(rec(again)["title"]).toBe(GAPS_TITLE);
  });
});
