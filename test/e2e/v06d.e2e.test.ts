// L2 for 0.6-D daemon fixes (Chrome for Testing, the real daemon, the range
// in site.ts). Expected values come from the range, never from tabcap:
//   - ids, labels, values and file names are literals of startDaemonFixSite
//     (S47_* … S52_*), startFrameSite (S22_*) and startPoolSite;
//   - what the page received (filled values, hover, upload, which handler
//     ran) is what the page itself wrote down (#s47-out, window.__s23, the
//     s48 sub-menu's display);
//   - request bodies, requests and cookies are what the servers logged
//     (`posts`, `hits`);
//   - the s52 date reading follows the page's dates (a day over 12 in the
//     frame decides DD/MM);
//   - image sizes are the elements' CSS sizes times the page's own
//     devicePixelRatio.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import {
  S22_MENU_LINKS,
  S22_TABLE_CELLS,
  S47_PASS,
  S47_UPLOAD_NAME,
  S47_USER,
  S48_ITEM,
  S49_FETCH_BODY,
  S50_IMG_ALT,
  S52_FRAME_DATE,
  S52_ROOT_DATE,
  startDaemonFixSite,
  startFrameSite,
  startPoolSite,
  type DaemonFixSite,
  type FrameSite,
  type PoolSite,
} from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let home = "";
let site: DaemonFixSite;
let frames: FrameSite;
let pool: PoolSite;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[], stdin?: string): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && p.stdin !== undefined && typeof p.stdin !== "number") {
    p.stdin.write(stdin);
    await p.stdin.end();
  }
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

const value = async (expr: string, S: string[]): Promise<unknown> => (await ok("evaluate", expr, ...S))["value"];

/** The ref on the last line of a `snapshot --css <one element>` tree (its AX line, or its `(no accessible node)` line). */
async function cssRef(css: string, S: string[]): Promise<{ ref: string; line: string }> {
  const snap = await ok("snapshot", "--css", css, ...S);
  const line = s(snap["tree"]).split("\n").at(-1) ?? "";
  const m = /\[((?:f\d+\/)*e\d+)\][^[]*$/.exec(line);
  if (m === null || m[1] === undefined) throw new Error(`no ref for ${css} in:\n${s(snap["tree"])}`);
  return { ref: m[1], line };
}

describe.skipIf(!enabled)("tabcap 0.6-D L2 (docs/05 s22, s47–s52: DOM-backed refs, click effect, find in frames, POST across a redirect, image captcha advisory, one context per account)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6d-"));
    site = startDaemonFixSite();
    frames = startFrameSite();
    pool = startPoolSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    frames.stop();
    pool.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("D1 s47: --css matches without an accessibility node get DOM-backed refs; fill, type, click, html, screenshot --ref, hover, upload drive them; a reload expires them", async () => {
    const S = ["--session", "d1"];
    await ok("navigate", `${site.origin}/s47`, ...S);
    const snap = await ok("snapshot", "--css", "#s47-user, #s47-pass, #s47-go, #s47-file, #s47-hover", ...S);
    const tree = s(snap["tree"]);
    expect(rec(snap["search"])).toMatchObject({ mode: "css", matches: 5, shown: 5, noAccessible: 5, domRefs: 5 });
    const refOf = (id: string, cls: string) => {
      const m = new RegExp(`- \\(no accessible node\\) <[a-z]+#${id}\\.${cls}> \\[(e\\d+)\\]`).exec(tree);
      if (m === null || m[1] === undefined) throw new Error(`no DOM-backed ref for #${id} in:\n${tree}`);
      return m[1];
    };
    const user = refOf("s47-user", "el-input__inner");
    const pass = refOf("s47-pass", "el-input__inner");
    const go = refOf("s47-go", "el-button");
    const file = refOf("s47-file", "el-upload__input");
    const hover = refOf("s47-hover", "s47-hover");
    // the full snapshot has no line for any of them (aria-hidden)
    const full = s((await ok("snapshot", ...S))["tree"]);
    for (const r of [user, pass, go, file, hover]) expect(full).not.toContain(`[${r}]`);

    expect(await ok("fill", user, S47_USER, ...S)).toMatchObject({ ref: user, kind: "input", length: S47_USER.length });
    expect(await ok("type", "-t", ...S)).toMatchObject({ eventShape: "insert" });
    expect(await ok("fill", pass, S47_PASS, ...S)).toMatchObject({ ref: pass, masked: true });
    expect(await ok("click", go, ...S)).toMatchObject({ ref: go, trusted: false, effect: "dom" });
    expect(await value("document.getElementById('s47-out').textContent", S)).toBe(`user=${S47_USER}-t;pass=${S47_PASS.length}`);

    expect(rec((await ok("html", user, "--attrs", ...S))["attrs"])).toMatchObject({ id: "s47-user", class: "el-input__inner", type: "text" });
    const dpr = Number(await value("window.devicePixelRatio", S));
    const shot = await ok("screenshot", "--ref", hover, ...S);
    expect({ width: shot["width"], height: shot["height"] }).toEqual({ width: Math.round(120 * dpr), height: Math.round(30 * dpr) });
    expect(await ok("hover", hover, ...S)).toMatchObject({ ref: hover, trusted: true });
    expect(await value("window.__s23.hover", S)).toBe(true);
    const up = join(home, S47_UPLOAD_NAME);
    writeFileSync(up, "s47 upload\n");
    expect(await ok("upload", file, up, ...S)).toMatchObject({ ref: file, method: "input", files: 1 });
    expect(await value("window.__s23.file", S)).toBe(S47_UPLOAD_NAME);

    await ok("reload", ...S);
    const stale = await tabcap(["click", go, ...S]);
    expect(stale.error?.["code"]).toBe("stale-ref");
  }, 120_000);

  test("D2 s48: a DOM click nothing reacts to says effect none and suggests --trusted (exit 0); dom / navigation / request otherwise", async () => {
    const S = ["--session", "d2"];
    await ok("navigate", `${site.origin}/s48`, ...S);
    const sub = (await cssRef("#s48-sub", S)).ref;
    const cell = (await cssRef("#s48-cell", S)).ref;
    const count = (await cssRef("#s48-count", S)).ref;
    const ping = (await cssRef("#s48-ping", S)).ref;
    const link = (await cssRef("#s48-link", S)).ref;

    const none = await tabcap(["click", sub, ...S]);
    expect(none.exit).toBe(0);
    expect(none.data).toMatchObject({ ref: sub, trusted: false, effect: "none" });
    expect(s(none.data["note"])).toContain("--trusted");
    expect(await value("getComputedStyle(document.getElementById('s48-items')).display", S)).toBe("none");
    expect((await ok("click", cell, ...S))["effect"]).toBe("none");
    expect(await value("document.getElementById('s48-cell').textContent", S)).toBe("单元格");

    expect((await ok("click", count, ...S))["effect"]).toBe("dom");
    expect(await value("document.getElementById('s48-n').textContent", S)).toBe("1");
    const before = site.hits.filter((h) => h === "GET /s48/ping").length;
    expect((await ok("click", ping, ...S))["effect"]).toBe("request");
    expect(site.hits.filter((h) => h === "GET /s48/ping").length).toBe(before + 1);

    // the handler does react to trusted input; the trusted path reports no effect field
    const t = await ok("click", sub, "--trusted", ...S);
    expect(t["trusted"]).toBe(true);
    expect(t["effect"]).toBeUndefined();
    expect(await value("getComputedStyle(document.getElementById('s48-items')).display", S)).toBe("block");
    expect(s((await ok("find", S48_ITEM, ...S))["hits"])).toContain(S48_ITEM);

    expect((await ok("click", link, ...S))["effect"]).toBe("navigation");
    expect(site.hits).toContain("GET /s48/next");
    // --no-wait: no post-action wait, so no effect is claimed
    await ok("navigate", `${site.origin}/s48`, ...S);
    const again = (await cssRef("#s48-count", S)).ref;
    expect((await ok("click", again, "--no-wait", ...S))["effect"]).toBeUndefined();
  }, 120_000);
});
