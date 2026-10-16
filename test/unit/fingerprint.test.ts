// 0.4-G signal probe, offline. Oracles:
//   - the field list: the brief's field list (docs/08 §3 0.4 line, owner 10-16)
//     written out below as literals, in the trace signal list's IDL names;
//   - hashes: fixtures/fingerprint/canvas-4x2.png (a 4x2 RGBA PNG written with
//     Python zlib / struct) and audio-samples.json with audio-samples.f32le
//     (Python struct.pack("<8f", …) of the same numbers); the expected digests
//     are `shasum -a 256` of those two files, not computed by tabcap;
//   - verdicts: the brief's definitions (same / differs / missing = the
//     reference lacks it / extra = this browser lacks it; hashes as strings,
//     arrays in order).
// The helpers under test are the probe page's own <script id="probe-lib">.
// Real-browser coverage: test/e2e/v04g.e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capValue, compareFields, FIELD_NAMES, fingerprintResult, mapFieldText, normalizeFields, renderFingerprintText, sha256Text, verdictOf, VALUE_MAX, type Field } from "../../src/fingerprint/fields.ts";
import { checkRefName, listRefs, loadRef, refsDir, removeRef, saveRef } from "../../src/fingerprint/refs.ts";
import { PROBE_HTML, probePage, startProbeServer } from "../../src/fingerprint/server.ts";
import { lastEnvState } from "../../src/cli/fingerprint.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { expectMode, POSIX_MODES } from "./_platform.ts";

const FIX = join(import.meta.dir, "..", "..", "fixtures", "fingerprint");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const EXPECTED_NAMES = [
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

/** A full field set: every name with a small value (tests vary single fields). */
const full = (over: Record<string, Field> = {}): Field[] => FIELD_NAMES.map((name) => over[name] ?? { name, value: name.length });

/** The probe page's <script id="probe-lib">, evaluated as one function that returns its helpers. */
function pageLib(): Record<string, unknown> {
  const m = /<script id="probe-lib">([\s\S]*?)<\/script>/.exec(PROBE_HTML);
  if (m === null || m[1] === undefined) throw new Error("probe-lib script not found in probe.html");
  const lib: unknown = new Function(`${m[1]}\nreturn { pngBytes, float32LeBytes, sha256Of, capField };`)();
  if (!isRecord(lib)) throw new Error("probe-lib did not return its helpers");
  return lib;
}

/** Call one helper of the page's lib (the caller checks the result). */
function call(name: string, ...args: unknown[]): unknown {
  const f = pageLib()[name];
  if (typeof f !== "function") throw new Error(`probe-lib has no ${name}`);
  return Reflect.apply(f, undefined, args);
}

function bytesOf(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error("expected bytes");
  return v;
}

describe("field list", () => {
  test("is the brief's list, sorted in code-unit order (as the page sorts), no duplicates", () => {
    expect([...FIELD_NAMES]).toEqual(EXPECTED_NAMES);
    expect([...FIELD_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...FIELD_NAMES]);
    expect(new Set(FIELD_NAMES).size).toBe(FIELD_NAMES.length);
    expect(FIELD_NAMES.length).toBe(49);
  });

  test("the page is self-contained: no external URL, no storage or cookie write; the token and mode are filled in", () => {
    expect(PROBE_HTML).not.toMatch(/\b(src|href)=/i);
    expect(PROBE_HTML).not.toMatch(/https?:\/\//);
    expect(PROBE_HTML).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    const page = probePage("ab12", "serve");
    expect(page).toContain('const TOKEN = "ab12";');
    expect(page).toContain('const MODE = "serve";');
    expect(page).not.toContain("__TABCAP_");
  });
});

describe("hashing (the page's probe-lib on fixtures)", () => {
  test("canvas: sha256 of the PNG bytes behind the data URL", async () => {
    const png = readFileSync(join(FIX, "canvas-4x2.png"));
    const bytes = bytesOf(call("pngBytes", `data:image/png;base64,${png.toString("base64")}`));
    expect(Buffer.from(bytes).equals(png)).toBe(true);
    expect(await call("sha256Of", bytes)).toBe("sha256:051f584b1cfd4ee291897a38d08b22a189d554126f4c17cd994b96c7e3ea9031");
    expect(() => call("pngBytes", "data:image/jpeg;base64,AAAA")).toThrow("not a PNG data URL");
  });

  test("audio: sha256 of the samples as little-endian float32", async () => {
    const samples: unknown = JSON.parse(readFileSync(join(FIX, "audio-samples.json"), "utf8"));
    if (!Array.isArray(samples)) throw new Error("fixture is not an array");
    const bytes = bytesOf(call("float32LeBytes", new Float32Array(samples.map(Number))));
    expect(Buffer.from(bytes).equals(readFileSync(join(FIX, "audio-samples.f32le")))).toBe(true);
    expect(await call("sha256Of", bytes)).toBe("sha256:0ff5d7292c4c1a1ebc9e90a8f1acc170f5eb5b94d04d6a47bea1cd2aef37acaa");
  });

  test("values over 1 KB of JSON become the sha256 of that JSON, in the page and on the server alike", async () => {
    const small = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const big = Array.from({ length: 200 }, (_, i) => `voice-${i}`);
    expect(await call("capField", "x", small)).toEqual({ name: "x", value: small });
    expect(await call("capField", "x", big)).toEqual({ name: "x", hash: sha256Text(JSON.stringify(big)) });
    expect(capValue("x", big)).toEqual({ name: "x", hash: sha256Text(JSON.stringify(big)) });
    expect(await call("capField", "x", undefined)).toEqual({ name: "x", error: "undefined" });
    // exactly at the limit stays inline
    const edge = "a".repeat(VALUE_MAX - 2);
    expect(capValue("x", edge)).toEqual({ name: "x", value: edge });
    expect("hash" in capValue("x", edge + "a")).toBe(true);
  });
});

describe("normalizeFields (untrusted page posts and reference files)", () => {
  test("keeps exactly the field list, in order; unknown dropped, absent and malformed marked", () => {
    const n = normalizeFields([
      { name: "Screen.prototype.width", value: 1512 },
      { name: "Screen.prototype.width", value: 1 },
      { name: "HTMLCanvasElement.prototype.toDataURL", hash: `sha256:${"ab".repeat(32)}` },
      { name: "OfflineAudioContext.prototype.startRendering", hash: "sha256:XYZ" },
      { name: "Navigator.prototype.languages", value: ["en-US", { nested: true }] },
      { name: "Navigator.prototype.deviceMemory", error: "x".repeat(500) },
      { name: "evil.prototype.thing", value: 1 },
      "not a record",
      null,
    ]);
    expect(n.fields.map((f) => f.name)).toEqual([...FIELD_NAMES]);
    const by = new Map(n.fields.map((f) => [f.name, f]));
    expect(by.get("Screen.prototype.width")).toEqual({ name: "Screen.prototype.width", value: 1512 });
    expect(by.get("HTMLCanvasElement.prototype.toDataURL")).toEqual({ name: "HTMLCanvasElement.prototype.toDataURL", hash: `sha256:${"ab".repeat(32)}` });
    expect(by.get("OfflineAudioContext.prototype.startRendering")).toEqual({ name: "OfflineAudioContext.prototype.startRendering", error: "malformed field" });
    expect(by.get("Navigator.prototype.languages")).toEqual({ name: "Navigator.prototype.languages", error: "malformed field" });
    const dm = by.get("Navigator.prototype.deviceMemory");
    expect(dm !== undefined && "error" in dm ? dm.error.length : 0).toBe(200);
    expect(by.get("Screen.prototype.height")).toEqual({ name: "Screen.prototype.height", error: "not reported" });
    expect(n.dropped).toEqual(["evil.prototype.thing"]);
    expect(() => normalizeFields({ fields: [] })).toThrow(TabcapError);
  });

  test("known-secret substitution reaches every string of values and errors", () => {
    const f: Field[] = [
      { name: "a", value: "x-secret-y" },
      { name: "b", value: ["secret", 1] },
      { name: "c", error: "secret!" },
      { name: "d", hash: "sha256:00" },
    ];
    expect(mapFieldText(f, (s) => s.replaceAll("secret", "<secret:k>"))).toEqual([
      { name: "a", value: "x-<secret:k>-y" },
      { name: "b", value: ["<secret:k>", 1] },
      { name: "c", error: "<secret:k>!" },
      { name: "d", hash: "sha256:00" },
    ]);
  });
});

describe("verdicts", () => {
  const n = "Screen.prototype.width";
  test("same / differs / missing (reference lacks it) / extra (this browser lacks it)", () => {
    expect(verdictOf({ name: n, value: 1 }, { name: n, value: 1 })).toBe("same");
    expect(verdictOf({ name: n, value: 1 }, { name: n, value: 2 })).toBe("differs");
    expect(verdictOf({ name: n, value: "1" }, { name: n, value: 1 })).toBe("differs");
    expect(verdictOf({ name: n, value: ["a", "b"] }, { name: n, value: ["b", "a"] })).toBe("differs");
    expect(verdictOf({ name: n, value: ["a", "b"] }, { name: n, value: ["a", "b"] })).toBe("same");
    expect(verdictOf({ name: n, hash: "sha256:aa" }, { name: n, hash: "sha256:aa" })).toBe("same");
    expect(verdictOf({ name: n, hash: "sha256:aa" }, { name: n, hash: "sha256:bb" })).toBe("differs");
    expect(verdictOf({ name: n, hash: "sha256:aa" }, { name: n, value: "sha256:aa" })).toBe("differs");
    expect(verdictOf({ name: n, value: 1 }, { name: n, error: "undefined" })).toBe("missing");
    expect(verdictOf({ name: n, value: 1 }, undefined)).toBe("missing");
    expect(verdictOf({ name: n, error: "undefined" }, { name: n, value: 1 })).toBe("extra");
    expect(verdictOf({ name: n, error: "undefined" }, { name: n, error: "not reported" })).toBe("same");
    expect(verdictOf({ name: n, value: null }, { name: n, value: null })).toBe("same");
  });

  test("compareFields: every field of the list, the reference column, the summary", () => {
    const cur = full({ "Screen.prototype.width": { name: "Screen.prototype.width", value: 1512 }, "Navigator.prototype.deviceMemory": { name: "Navigator.prototype.deviceMemory", error: "undefined" } });
    const ref = full({ "Screen.prototype.width": { name: "Screen.prototype.width", value: 1440 }, "Navigator.prototype.platform": { name: "Navigator.prototype.platform", error: "not reported" } });
    const r = compareFields(cur, ref);
    expect(r.fields.length).toBe(49);
    expect(r.summary).toEqual({ same: 46, differs: 1, missing: 1, extra: 1 });
    expect(r.fields.find((x) => x.name === "Screen.prototype.width")).toEqual({ name: "Screen.prototype.width", value: 1512, ref: 1440, verdict: "differs" });
    expect(r.fields.find((x) => x.name === "Navigator.prototype.deviceMemory")).toEqual({ name: "Navigator.prototype.deviceMemory", value: null, error: "undefined", ref: "Navigator.prototype.deviceMemory".length, verdict: "extra" });
    expect(r.fields.find((x) => x.name === "Navigator.prototype.platform")).toEqual({ name: "Navigator.prototype.platform", value: "Navigator.prototype.platform".length, ref: null, refError: "not reported", verdict: "missing" });
    const noRef = compareFields(cur, null);
    expect(noRef.summary).toEqual({ same: 0, differs: 0, missing: 0, extra: 0 });
    expect(noRef.fields.every((x) => !("verdict" in x) && !("ref" in x))).toBe(true);
  });
});

describe("text table", () => {
  test("columns, truncation, summary; no advice", () => {
    const cur = full({ "Navigator.prototype.userAgent": { name: "Navigator.prototype.userAgent", value: "U".repeat(100) }, "Screen.prototype.width": { name: "Screen.prototype.width", value: 1512 } });
    const ref = full({ "Screen.prototype.width": { name: "Screen.prototype.width", value: 1440 } });
    const res = fingerprintResult("155.0.8059.79", cur, { info: { name: "daily", savedAt: Date.UTC(2026, 9, 16), userAgent: "U" }, fields: ref });
    const text = renderFingerprintText(res);
    const lines = text.split("\n");
    expect(lines[0]).toBe("browser 155.0.8059.79; reference daily saved 2026-10-16T00:00:00.000Z");
    expect(lines[2]).toMatch(/^field +this browser +reference daily +verdict$/);
    expect(lines.length).toBe(3 + 49 + 2);
    const w = lines.find((l) => l.startsWith("Screen.prototype.width "));
    expect(w?.split(/ {2,}/)).toEqual(["Screen.prototype.width", "1512", "1440", "differs"]);
    const ua = lines.find((l) => l.startsWith("Navigator.prototype.userAgent "));
    expect(ua).toContain(`${"U".repeat(71)}…`);
    // userAgent and width differ from the reference, the other 47 are equal
    expect(lines[lines.length - 1]).toBe("same 47, differs 2, missing 0, extra 0");
    expect(text.toLowerCase()).not.toMatch(/should|recommend|to match|change|spoof/);
    const plain = renderFingerprintText(fingerprintResult("1", cur, null)).split("\n");
    expect(plain[2]).toMatch(/^field +this browser$/);
    expect(plain.length).toBe(3 + 49);
  });
});

describe("references", () => {
  test("name validation", () => {
    for (const ok of ["daily", "a", "my-laptop-2", "x".repeat(40)]) expect(checkRefName(ok)).toBe(ok);
    for (const bad of ["", "Daily", "a_b", "a.b", "../x", "x".repeat(41), "a b", "é"]) expect(() => checkRefName(bad)).toThrow(TabcapError);
  });

  test("save (0600 in 0700 dirs), refuse an existing one unless force, load, list, remove", () => {
    const cfg = tmp("tabcap-fpref-");
    const fields = full({ "Navigator.prototype.userAgent": { name: "Navigator.prototype.userAgent", value: "UA/1" } });
    const s = saveRef(cfg, "daily", fields, { force: false, now: 1000 });
    expect(s).toEqual({ name: "daily", path: join(refsDir(cfg), "daily.json"), savedAt: 1000, userAgent: "UA/1", replaced: false });
    expectMode(s.path, 0o600);
    expectMode(refsDir(cfg), 0o700);
    expectMode(join(cfg, "fingerprint"), 0o700);
    expect(() => saveRef(cfg, "daily", fields, { force: false, now: 2000 })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(saveRef(cfg, "daily", fields, { force: true, now: 2000 }).replaced).toBe(true);
    const r = loadRef(cfg, "daily");
    expect([r.savedAt, r.userAgent, r.fields]).toEqual([2000, "UA/1", fields]);
    expect(listRefs(cfg).refs.map((x) => [x.name, x.savedAt])).toEqual([["daily", 2000]]);
    // a hand-edited file: bad fields are normalized, broken JSON is a bad-input error
    writeFileSync(s.path, JSON.stringify({ savedAt: "x", fields: [{ name: "Screen.prototype.width", value: { o: 1 } }] }));
    const edited = loadRef(cfg, "daily");
    expect(edited.savedAt).toBeNull();
    expect(edited.fields.find((f) => f.name === "Screen.prototype.width")).toEqual({ name: "Screen.prototype.width", error: "malformed field" });
    writeFileSync(s.path, "{");
    expect(() => loadRef(cfg, "daily")).toThrow(expect.objectContaining({ code: "bad-input" }));
    expect(listRefs(cfg).refs[0]?.error).toContain("not valid JSON");
    expect(removeRef(cfg, "daily").removed).toBe("daily");
    expect(existsSync(s.path)).toBe(false);
    expect(() => removeRef(cfg, "daily")).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(() => loadRef(cfg, "../x")).toThrow(expect.objectContaining({ code: "usage" }));
    if (POSIX_MODES) expect(listRefs(tmp("tabcap-fpnone-")).refs).toEqual([]);
  });
});

describe("probe server", () => {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("serve mode: page with token; posts need the token, JSON and this origin; references are saved and not overwritten", async () => {
    const cfg = tmp("tabcap-fpsrv-");
    const probes: Field[][] = [];
    const s = startProbeServer({ port: 0, mode: "serve", onProbe: (f) => probes.push(f), onRef: (name, fields) => ({ saved: saveRef(cfg, name, fields, { force: false, now: 5 }).name }) });
    try {
      const page = await fetch(s.url);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      const token = /const TOKEN = "([0-9a-f]{32})";/.exec(html)?.[1] ?? "";
      expect(token.length).toBe(32);
      const fields = [{ name: "Screen.prototype.width", value: 1 }, { name: "x.y", value: 2 }];
      const p = await post(`${s.url}probe`, { token, fields });
      expect(p.status).toBe(200);
      const pj: unknown = await p.json();
      expect(isRecord(pj) && Array.isArray(pj["fields"]) ? pj["fields"].length : 0).toBe(49);
      expect(isRecord(pj) ? pj["dropped"] : null).toEqual(["x.y"]);
      expect(probes.length).toBe(1);
      expect((await post(`${s.url}probe`, { token: "nope", fields })).status).toBe(403);
      expect((await fetch(`${s.url}probe`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, fields }) })).status).toBe(415);
      expect((await post(`${s.url}probe`, { token, fields }, { origin: "http://example.com" })).status).toBe(403);
      expect((await post(`${s.url}probe`, { token, fields: "x" })).status).toBe(400);
      expect((await post(`${s.url}ref/Bad_Name`, { token, fields })).status).toBe(400);
      expect((await post(`${s.url}ref/%E0%A4%A`, { token, fields })).status).toBe(400);
      const saved = await post(`${s.url}ref/daily`, { token, fields });
      expect([saved.status, await saved.json()]).toEqual([200, { saved: "daily" }]);
      expectMode(join(refsDir(cfg), "daily.json"), 0o600);
      expect((await post(`${s.url}ref/daily`, { token, fields })).status).toBe(409);
      expect((await fetch(`${s.url}other`)).status).toBe(404);
      expect((await fetch(s.url.replace("127.0.0.1", "127.0.0.1"), { headers: { host: "evil.example:80" } })).status).toBe(421);
    } finally {
      s.stop();
    }
  });

  test("probe mode: no references", async () => {
    const s = startProbeServer({ port: 0, mode: "probe" });
    try {
      const html = await (await fetch(s.url)).text();
      const token = /const TOKEN = "([0-9a-f]{32})";/.exec(html)?.[1] ?? "";
      expect(html).toContain('const MODE = "probe";');
      expect((await post(`${s.url}ref/daily`, { token, fields: [] })).status).toBe(404);
    } finally {
      s.stop();
    }
  });
});

describe("fingerprint diff input", () => {
  test("the last state env event of a bundle; none is not-found", async () => {
    const dir = join(tmp("tabcap-fpdiff-"), "b");
    const w = await BundleWriter.open(dir, { now: () => 1000 });
    const base = { mono: null, actor: "system" as const, tab: "t1", cmd: null };
    w.append({ ...base, ts: 1001, kind: "state", what: "env", source: "fingerprint-probe", origin: "http://127.0.0.1:1", count: 1, reason: "manual", fields: [{ name: "Screen.prototype.width", value: 1 }] });
    w.append({ ...base, ts: 1002, kind: "state", what: "env", source: "fingerprint-probe", origin: "http://127.0.0.1:1", count: 1, reason: "manual", fields: [{ name: "Screen.prototype.width", value: 2 }] });
    await w.close();
    const st = lastEnvState(dir);
    expect(st.seq).toBe(2);
    expect(st.source).toBe("fingerprint-probe");
    expect(st.fields.find((f) => f.name === "Screen.prototype.width")).toEqual({ name: "Screen.prototype.width", value: 2 });
    const empty = join(tmp("tabcap-fpdiff-"), "b");
    const w2 = await BundleWriter.open(empty, { now: () => 1000 });
    await w2.close();
    expect(() => lastEnvState(empty)).toThrow(expect.objectContaining({ code: "not-found" }));
  });
});
