// L2 for 0.4-G signal probe (Chrome for Testing, the real daemon).
// Oracles:
//   - the field names: the brief's field list, written out below as literals;
//   - the reference: what the same CfT presented when its tab opened
//     `fingerprint serve` and pressed "Save as reference" (the CfT stands in
//     for the user's own browser here); two loads of the same browser must
//     give `same` for every field, so a field that varies per load fails here;
//   - the edited reference: the three edits below decide the verdicts
//     (two values changed → differs, one field removed from the reference → extra);
//   - the bundle: the `state` env events read back from events.jsonl.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

const NAMES = [
  "Date.prototype.getTimezoneOffset",
  "FontFaceSet.prototype.check",
  "HTMLCanvasElement.prototype.toDataURL",
  "Intl.DateTimeFormat.prototype.resolvedOptions().calendar",
  "Intl.DateTimeFormat.prototype.resolvedOptions().locale",
  "Intl.DateTimeFormat.prototype.resolvedOptions().numberingSystem",
  "Intl.DateTimeFormat.prototype.resolvedOptions().timeZone",
  "Navigator.prototype.deviceMemory",
  "Navigator.prototype.hardwareConcurrency",
  "Navigator.prototype.language",
  "Navigator.prototype.languages",
  "Navigator.prototype.maxTouchPoints",
  "Navigator.prototype.platform",
  "Navigator.prototype.plugins",
  "Navigator.prototype.plugins.length",
  "Navigator.prototype.userAgent",
  "Navigator.prototype.vendor",
  "Navigator.prototype.webdriver",
  "NavigatorUAData.prototype.brands",
  "NavigatorUAData.prototype.getHighEntropyValues(architecture)",
  "NavigatorUAData.prototype.getHighEntropyValues(bitness)",
  "NavigatorUAData.prototype.getHighEntropyValues(formFactors)",
  "NavigatorUAData.prototype.getHighEntropyValues(fullVersionList)",
  "NavigatorUAData.prototype.getHighEntropyValues(model)",
  "NavigatorUAData.prototype.getHighEntropyValues(platformVersion)",
  "NavigatorUAData.prototype.getHighEntropyValues(uaFullVersion)",
  "NavigatorUAData.prototype.getHighEntropyValues(wow64)",
  "NavigatorUAData.prototype.mobile",
  "NavigatorUAData.prototype.platform",
  "OfflineAudioContext.prototype.startRendering",
  "Permissions.prototype.query(geolocation)",
  "Permissions.prototype.query(notifications)",
  "Screen.prototype.availHeight",
  "Screen.prototype.availWidth",
  "Screen.prototype.colorDepth",
  "Screen.prototype.height",
  "Screen.prototype.pixelDepth",
  "Screen.prototype.width",
  "SpeechSynthesis.prototype.getVoices",
  "WebGLRenderingContext.prototype.getParameter(RENDERER)",
  "WebGLRenderingContext.prototype.getParameter(SHADING_LANGUAGE_VERSION)",
  "WebGLRenderingContext.prototype.getParameter(UNMASKED_RENDERER_WEBGL)",
  "WebGLRenderingContext.prototype.getParameter(UNMASKED_VENDOR_WEBGL)",
  "WebGLRenderingContext.prototype.getParameter(VENDOR)",
  "WebGLRenderingContext.prototype.getParameter(VERSION)",
  "WebGLRenderingContext.prototype.getSupportedExtensions",
  "Window.prototype.devicePixelRatio",
  "Window.prototype.matchMedia(prefers-color-scheme)",
  "Window.prototype.matchMedia(prefers-reduced-motion)",
];

let home = "";

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

/** name → verdict of a fingerprint result. */
const verdicts = (r: Record<string, unknown>): Record<string, string> => Object.fromEntries(recs(r["fields"]).map((f) => [s(f["name"]), s(f["verdict"])]));
const byVerdict = (r: Record<string, unknown>, v: string): string[] => Object.entries(verdicts(r)).filter(([, x]) => x === v).map(([n]) => n).sort();

describe.skipIf(!enabled)("tabcap 0.4-G L2 (signal probe: this browser vs a reference captured by hand)", () => {
  const S = ["--session", "fp"];
  let bundle = "";
  let refFile = "";
  let edited: Record<string, unknown> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4g-"));
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    removeHome(home, import.meta.file);
  });

  test("fingerprint probe while recording: every field, a background tab closed afterwards, the current tab kept, a state env event", async () => {
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", "data:text/html,<title>home</title>home", ...S);
    const before = await ok("tab", "list", ...S);
    const r = await ok("fingerprint", "probe", ...S);
    expect(r["schema"]).toBe("tabcap-fingerprint/0");
    expect(s(rec(r["browser"])["version"])).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const fields = recs(r["fields"]);
    expect(fields.map((f) => f["name"])).toEqual(NAMES);
    // values come from the page; "not reported" / "malformed field" would be a probe bug
    expect(fields.filter((f) => f["error"] === "not reported" || f["error"] === "malformed field").map((f) => f["name"])).toEqual([]);
    const errs = fields.filter((f) => typeof f["error"] === "string").map((f) => `${s(f["name"])}: ${s(f["error"])}`);
    console.log(`[v04g] ${fields.length} fields; errors reported by this browser: ${errs.length === 0 ? "none" : errs.join("; ")}`);
    for (const n of ["HTMLCanvasElement.prototype.toDataURL", "OfflineAudioContext.prototype.startRendering"]) expect(s(fields.find((f) => f["name"] === n)?.["value"])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r["summary"]).toEqual({ same: 0, differs: 0, missing: 0, extra: 0 });
    expect("ref" in r).toBe(false);
    expect(rec(r["state"])["bundle"]).toBe(bundle);
    expect(typeof rec(r["state"])["seq"]).toBe("number");
    const after = await ok("tab", "list", ...S);
    expect(recs(after["tabs"]).map((t) => [t["tab"], t["current"]])).toEqual(recs(before["tabs"]).map((t) => [t["tab"], t["current"]]));
  }, 60_000);

  test("fingerprint serve --once: the CfT tab saves a reference by the form (0600 in 0700 dirs), then serve exits", async () => {
    const proc = Bun.spawn(["bun", MAIN, "fingerprint", "serve", "--once"], { env: { ...process.env, TABCAP_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`fingerprint serve exited early: ${buf}`);
      buf += dec.decode(value);
    }
    reader.releaseLock();
    const info = rec(rec(JSON.parse(buf.slice(0, buf.indexOf("\n"))))["data"]);
    const url = s(info["url"]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const opened = await ok("tab", "new", url, ...S);
    await ok("wait", "--text", `read ${NAMES.length} fields`, ...S);
    const box = recs((await ok("find", "reference name", ...S))["hits"]).find((h) => h["role"] === "textbox");
    await ok("fill", s(box?.["ref"]), "daily", ...S);
    const btn = recs((await ok("find", "Save as reference", ...S))["hits"]).find((h) => h["role"] === "button");
    await ok("click", s(btn?.["ref"]), ...S);
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "timeout")]);
    const err = await new Response(proc.stderr).text();
    expect([exit, err]).toEqual([0, expect.stringContaining("saved reference daily (49 fields)")]);
    await ok("wait", "--text", "saved reference daily", ...S);
    await ok("tab", "close", s(opened["tab"]), ...S);
    refFile = join(s(info["refs"]), "daily.json");
    expect(existsSync(refFile)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(refFile).mode & 0o777).toBe(0o600);
      expect(statSync(s(info["refs"])).mode & 0o777).toBe(0o700);
      expect(statSync(join(s(info["refs"]), "..")).mode & 0o777).toBe(0o700);
    }
    const list = await ok("fingerprint", "ref", "list");
    expect(recs(list["refs"]).map((x) => x["name"])).toEqual(["daily"]);
  }, 60_000);

  test("probe --ref: the same browser gives same for every field", async () => {
    const r = await ok("fingerprint", "probe", "--ref", "daily", ...S);
    const ref = rec(r["ref"]);
    expect([ref["name"], typeof ref["savedAt"]]).toEqual(["daily", "number"]);
    expect(ref["userAgent"]).toBe(recs(r["fields"]).find((f) => f["name"] === "Navigator.prototype.userAgent")?.["value"]);
    const notSame = recs(r["fields"]).filter((f) => f["verdict"] !== "same");
    if (notSame.length > 0) console.log(`[v04g] not same between two loads: ${JSON.stringify(notSame)}`);
    expect(notSame).toEqual([]);
    expect(r["summary"]).toEqual({ same: 49, differs: 0, missing: 0, extra: 0 });
    const text = await tabcap(["fingerprint", "probe", "--ref", "daily", "--text", ...S]);
    expect(text.exit).toBe(0);
    expect(text.raw.trimEnd().split("\n").at(-1)).toBe("same 49, differs 0, missing 0, extra 0");
  }, 60_000);

  test("an edited reference: two changed values are differs, a field removed from the reference is extra", async () => {
    const doc = rec(JSON.parse(readFileSync(refFile, "utf8")));
    const fields = recs(doc["fields"])
      .filter((f) => f["name"] !== "Navigator.prototype.vendor")
      .map((f) => {
        if (f["name"] === "Screen.prototype.width") return { ...f, value: Number(f["value"]) + 1 };
        if (f["name"] === "Navigator.prototype.userAgent") return { ...f, value: `${s(f["value"])} edited` };
        return f;
      });
    writeFileSync(refFile, JSON.stringify({ ...doc, fields }, null, 2));
    edited = await ok("fingerprint", "probe", "--ref", "daily", ...S);
    expect(byVerdict(edited, "differs")).toEqual(["Navigator.prototype.userAgent", "Screen.prototype.width"]);
    expect(byVerdict(edited, "missing")).toEqual([]);
    expect(byVerdict(edited, "extra")).toEqual(["Navigator.prototype.vendor"]);
    expect(edited["summary"]).toEqual({ same: 46, differs: 2, missing: 0, extra: 1 });
  }, 60_000);

  test("the bundle has the probes as state env events; fingerprint diff on it gives the same verdicts", async () => {
    await ok("net", "stop", ...S);
    const envs = BundleReader.open(bundle).events.filter((e) => e.kind === "state" && e["what"] === "env");
    // test 1, test 3 (JSON and --text) and test 4
    expect(envs.map((e) => [e["source"], e["reason"], e["count"]])).toEqual(Array.from({ length: 4 }, () => ["fingerprint-probe", "manual", 49]));
    const last = envs.at(-1);
    expect(recs(last?.["fields"]).map((f) => f["name"])).toEqual(NAMES);
    const values = (fs: Record<string, unknown>[]) => fs.map((f) => [f["name"], f["value"] ?? f["hash"] ?? f["error"]]);
    expect(values(recs(last?.["fields"]))).toEqual(values(recs(edited["fields"])));
    const d = await ok("fingerprint", "diff", bundle, "--ref", "daily");
    expect(rec(d["state"])["seq"]).toBe(last?.seq);
    expect(verdicts(d)).toEqual(verdicts(edited));
    expect(d["summary"]).toEqual(edited["summary"]);
    expect(rec(d["browser"])["version"]).toBe(rec(edited["browser"])["version"]);
    const text = await tabcap(["fingerprint", "diff", bundle, "--ref", "daily", "--text"]);
    expect(text.raw.trimEnd().split("\n").at(-1)).toBe("same 46, differs 2, missing 0, extra 1");
  }, 60_000);

  test("ref remove; daemon stop leaves no browser process of this TABCAP_HOME", async () => {
    expect((await ok("fingerprint", "ref", "remove", "daily"))["removed"]).toBe("daily");
    expect(recs((await ok("fingerprint", "ref", "list"))["refs"])).toEqual([]);
    await ok("daemon", "stop");
    if (process.platform === "win32") return;
    let left = "";
    for (let i = 0; i < 50; i++) {
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes("Chrome for Testing") && l.includes(home)).join("\n").trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
