// L2 for 0.8-A protection family identification (docs/04 §41, docs/05 s67–s70).
// The range serves our own stub pages whose cookie names, hosts, globals and
// class names are the ones docs/14 sources name; vendor hosts reach it through
// the forward proxy (test/e2e/fwdproxy.ts), so nothing leaves the machine.
// Oracle: the range's request log and what each page plants; expected family
// names and scores follow from the built-in rule files.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { startForwardProxy, type FwdProxy } from "./fwdproxy.ts";
import { startProtectionSite, type ProtectionSite } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

let home = "";
let site: ProtectionSite;
let proxy: FwdProxy;

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const env: unknown = JSON.parse(out);
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

/** `protection` of an answer as [name, confidence] pairs (absent field = no pairs). */
const hints = (d: Record<string, unknown>): [string, number][] => recs(d["protection"]).map((p) => [s(p["name"]), Number(p["confidence"])]);

function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => rec(JSON.parse(l)));
}

describe.skipIf(!enabled)("tabcap 0.8-A L2 (protection families on s67–s70)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e08a-"));
    site = startProtectionSite();
    proxy = startForwardProxy();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", proxy.url, "--executable-path", CHROME);
  }, 90_000);

  afterAll(async () => {
    await tabcap(["browser", "stop"]).catch(() => null);
    await tabcap(["daemon", "stop"]).catch(() => null);
    proxy.stop();
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("s67 live (no recording): DataDome, Akamai, reCAPTCHA on their pages; nothing on generic signals", async () => {
    const S = ["--session", "a"];
    expect("protection" in (await ok("navigate", site.at("none.range.test", "/s67/none"), ...S))).toBe(false);
    expect(hints(await ok("navigate", site.at("dd.range.test", "/s67/datadome"), ...S))).toEqual([["DataDome", 100]]);
    expect(hints(await ok("navigate", site.at("ak.range.test", "/s67/akamai"), ...S))).toEqual([["Akamai Bot Manager", 100]]);
    expect(hints(await ok("navigate", site.at("rc.range.test", "/s67/recaptcha"), ...S))).toEqual([["Google reCAPTCHA", 100]]);
    expect(hints(await ok("snapshot", ...S))).toEqual([["Google reCAPTCHA", 100]]);
    const st = recs((await ok("status"))["sessions"]).find((x) => x["session"] === "a");
    expect(st?.["protection"]).toEqual(["Google reCAPTCHA"]);
    // the stubs really came through the proxy as vendor hosts
    expect(site.hits.some((h) => h.host === "js.datadome.co" && h.path === "/tags.js")).toBe(true);
    expect(site.hits.some((h) => h.host === "www.google.com" && h.path === "/recaptcha/api.js")).toBe(true);
  }, 90_000);

  test("s67 recorded: a protection event in the bundle (also when the page was probed before net start); recon lists the family; no cookie value anywhere", async () => {
    const S = ["--session", "b"];
    // probed before the recording starts (Bugbot on PR #25): the cached answer still reaches the new bundle
    expect(hints(await ok("navigate", site.at("dd2.range.test", "/s67/datadome"), ...S))).toEqual([["DataDome", 100]]);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    expect(hints(await ok("snapshot", ...S))).toEqual([["DataDome", 100]]);
    await ok("net", "stop", ...S);
    const prot = events(bundle).filter((e) => e["kind"] === "protection");
    expect(prot.length).toBe(1);
    expect(recs(prot[0]?.["detections"]).map((x) => [x["family"], x["confidence"]])).toEqual([["datadome", 100]]);
    const r = await ok("analyze", "recon", bundle);
    expect(rec(r["summary"])["protection"]).toContain("DataDome (anti-bot, 100)");
    const dossier = readFileSync(join(bundle, "exports", "dossier.json"), "utf8");
    expect(dossier).toContain('"source": "family"');
    for (const text of [dossier, readFileSync(join(bundle, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"kind":"protection"')).join("\n")]) expect(text).not.toContain("AbCdEf0123456789");
  }, 90_000);

  test("s68 page markers (L2): GeeTest v4, Dingxiang, Turnstile, DataDome's frame; the page's getter never runs", async () => {
    const S = ["--session", "c"];
    const r = await ok("navigate", site.at("pg.range.test", "/s68"), ...S);
    const got = new Map(hints(r));
    expect([...got.keys()].sort()).toEqual(["Cloudflare Turnstile", "DataDome", "极验 GeeTest v4", "顶象 (验证码 / 设备指纹)"].sort());
    expect(got.get("DataDome")).toBe(90);
    await Bun.sleep(500);
    expect(site.hits.some((h) => h.path === "/s68/getter-ran")).toBe(false);
  }, 90_000);

  test("s69 trace (L3): canvas, WebGL and hardware techniques, attributed to the ThreatMetrix stub", async () => {
    const S = ["--session", "d"];
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("trace", "start", ...S);
    await ok("navigate", site.at("tm.range.test", "/s69"), ...S);
    const end = Date.now() + 5000;
    while (s((await ok("evaluate", "window.__s69 || ''", ...S))["value"]) !== "done" && Date.now() < end) await Bun.sleep(100);
    // The page says whether it got a WebGL context (oracle); only then does it call getParameter, what
    // fp-webgl looks for. macOS and Windows have one (PR #25: required there, green), so it is required;
    // Linux CI (Xvfb, no GPU) has none (NOTES 0.4-G CI run: "no webgl context"), so there it is reported, not checked.
    const webgl = (await ok("evaluate", "window.__s69webgl === true", ...S))["value"] === true;
    if (process.platform !== "linux") expect(webgl).toBe(true);
    else if (!webgl) console.warn("[v08a] s69: no WebGL context on this Linux host (no GPU); fp-webgl is not checked here");
    await ok("trace", "stop", ...S);
    await ok("net", "stop", ...S);
    await ok("analyze", "recon", bundle);
    const d = rec(JSON.parse(readFileSync(join(bundle, "exports", "dossier.json"), "utf8")));
    const fp = recs(d["fingerprinting"]);
    const by = new Map(fp.map((f) => [s(f["family"]), f]));
    expect(by.has("fp-webgl")).toBe(webgl);
    for (const id of webgl ? ["fp-canvas", "fp-webgl", "fp-hardware"] : ["fp-canvas", "fp-hardware"]) {
      expect(by.has(id)).toBe(true);
      expect(by.get(id)?.["attributedTo"]).toBe("threatmetrix");
      expect(s(recs(by.get(id)?.["callers"])[0]?.["url"])).toContain("h.online-metrix.net");
    }
  }, 120_000);

  test("s70 challenge pages: the guard's waiting answer names Cloudflare; the 加速乐 page is identified by its cookie", async () => {
    const S = ["--session", "e"];
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await tabcap(["navigate", site.at("cf.range.test", "/s70/cf"), ...S]);
    const end = Date.now() + 8000;
    let h: Record<string, unknown> = {};
    for (;;) {
      const st = await ok("handoff", "status", ...S);
      h = rec(st["handoff"]);
      if (st["state"] === "waiting" && Array.isArray(h["protection"])) break;
      if (Date.now() > end) throw new Error(`no waiting handoff with protection: ${JSON.stringify(st)}`);
      await Bun.sleep(200);
    }
    expect(h["reason"]).toBe("verify-page");
    expect(h["protection"]).toEqual(["Cloudflare Bot Management"]);
    expect(s(h["next"])).toStartWith("This is Cloudflare Bot Management (identified, not bypassed; a human handles it). ");
    await ok("handoff", "continue", ...S);
    await ok("net", "stop", ...S);
    const waiting = events(bundle).filter((e) => e["kind"] === "handoff" && e["state"] === "waiting");
    expect(waiting.map((e) => e["protection"])).toEqual([["Cloudflare Bot Management"]]);

    const J = ["--session", "f"];
    const j = await ok("navigate", site.at("jsl.range.test", "/s70/jsl"), ...J);
    expect(hints(j).map(([n]) => n)).toContain("知道创宇 加速乐");
  }, 120_000);
});
