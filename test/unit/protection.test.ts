// Protection family identification (0.8-A, docs/04 §41): the rule format and
// its validation, the confidence limits every built-in family keeps, each rule
// kind and combinations, that no cookie / header value ever reaches the output,
// user files overriding built-ins, the HTML scan, and the offline path through
// a synthetic bundle. Expected values come from what each test plants and from
// the rule files, never from running the identifier on itself.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { buildDossier, type ReconPage } from "../../src/analyze/recon.ts";
import { evidenceFromBundle, scanHtml } from "../../src/analyze/protection/evidence.ts";
import { MIN_REPORT, identify, identifyFamily, urlPointer, type Evidence, type EvidenceRequest } from "../../src/analyze/protection/identify.ts";
import { builtinFamilies, loadFamilies } from "../../src/analyze/protection/registry.ts";
import { confidenceViolations, layerOf, parseFamily, type Family } from "../../src/analyze/protection/rules.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { buildBundle, idOf, tmp } from "./_analyze.ts";

const O = "http://127.0.0.1:4310";
const C = 1760900000000;

const fam = (rules: unknown[], extra: Record<string, unknown> = {}): Family =>
  parseFamily({ schema: "tabcap-protection/0", id: "t", name: "T", vendor: "V", category: "anti-bot", version: 1, rules, ...extra }, "test", false);

const req = (o: Partial<EvidenceRequest> & { id: string; url: string }): EvidenceRequest => ({ method: "GET", type: "xhr", status: 200, requestHeaders: {}, responseHeaders: {}, body: null, postData: null, ...o });

const byId = (id: string): Family => {
  const f = builtinFamilies().find((x) => x.id === id);
  if (f === undefined) throw new Error(`no built-in ${id}`);
  return f;
};

describe("built-in families (docs/14)", () => {
  test("every file parses, its id is its file name, and non-fingerprint families name public sources", () => {
    const files = readdirSync(join(import.meta.dir, "..", "..", "src", "analyze", "protection", "families")).filter((f) => f.endsWith(".json"));
    const fams = builtinFamilies();
    expect(fams.map((f) => `${f.id}.json`).sort()).toEqual(files.sort());
    for (const f of fams) {
      expect(f.origin).toBe(`builtin:${f.id}`);
      if (f.category !== "fingerprint") {
        expect(f.sources.length).toBeGreaterThan(0);
        for (const s of f.sources) expect(s.url).toMatch(/^https:\/\//);
      }
    }
  });

  test("confidence limits: 100 only from vendor-only signals, shared kinds capped, combinations ≤ 95 below the top tier", () => {
    for (const f of builtinFamilies()) expect([f.id, confidenceViolations(f)]).toEqual([f.id, []]);
  });

  test("the families docs/14 lists: anti-bot and captcha with strong / medium sources; weak ones stay out", () => {
    const ids = new Set(builtinFamilies().map((f) => f.id));
    for (const id of ["cloudflare-bot-management", "akamai-bot-manager", "datadome", "human-perimeterx", "aws-waf", "recaptcha", "turnstile", "hcaptcha", "geetest-v4", "tencent-captcha", "netease-yidun", "aliyun-captcha", "dingxiang", "shumei", "jiasule", "ruishu"]) expect(ids.has(id)).toBe(true);
    // docs/14 §5 backlog (owner 10-20: weak sources are not added)
    for (const id of ["imperva", "incapsula", "kasada", "f5-shape", "aliyun-waf"]) expect(ids.has(id)).toBe(false);
    expect(builtinFamilies().filter((f) => f.category === "fingerprint").length).toBe(10);
  });

  test("fingerprint techniques use only API names the trace mode watches", async () => {
    const { DEFAULT_SIGNALS_JSON } = await import("../../src/daemon/trace/signals.ts");
    const watched = new Set(JSON.parse(DEFAULT_SIGNALS_JSON) as string[]);
    for (const f of builtinFamilies()) for (const r of f.rules) if (r.kind === "api") expect([f.id, r.target, watched.has(r.target)]).toEqual([f.id, r.target, true]);
  });
});

describe("validation (untrusted rule files)", () => {
  const bad = (raw: Record<string, unknown>, field: string) => {
    let err: unknown = null;
    try {
      parseFamily({ schema: "tabcap-protection/0", id: "t", name: "T", vendor: "V", category: "anti-bot", version: 1, rules: [{ id: "a", kind: "cookie", name: "x", confidence: 50, note: "n" }], ...raw }, "f.json", false);
    } catch (e) {
      err = e;
    }
    expect(err instanceof TabcapError ? err.message : String(err)).toContain(field);
  };
  test("unknown keys, bad regex, bad confidence, duplicate ids, unknown combination rule, missing sources on a built-in", () => {
    bad({ extra: 1 }, "(top).extra");
    bad({ schema: "x" }, "schema");
    bad({ rules: [{ id: "a", kind: "request", url: "(", confidence: 50, note: "n" }] }, "rules[0].url");
    bad({ rules: [{ id: "a", kind: "cookie", name: "x", confidence: 101, note: "n" }] }, "rules[0].confidence");
    bad({ rules: [{ id: "a", kind: "cookie", name: "x", confidence: 50, note: "n", surprise: true }] }, "rules[0].surprise");
    bad({ rules: [{ id: "a", kind: "cookie", name: "x", confidence: 50, note: "n" }, { id: "a", kind: "cookie", name: "y", confidence: 50, note: "n" }] }, "duplicate rule id a");
    bad({ combinations: [{ id: "c", name: "c", confidence: 90, when: { all: [{ rule: "nope" }] } }] }, "combinations[0].when.all[0].rule");
    bad({ rules: [{ id: "a", kind: "global", path: "a b", confidence: 50, note: "n" }] }, "rules[0].path");
    bad({ rules: [{ id: "a", kind: "challenge", confidence: 50, note: "n" }] }, "needs status or text");
    expect(() => parseFamily({ schema: "tabcap-protection/0", id: "t", name: "T", vendor: "V", category: "captcha", version: 1, rules: [{ id: "a", kind: "cookie", name: "xx", confidence: 50, note: "n" }] }, "builtin:t", true)).toThrow("sources");
  });

  test("confidence violations are reported for a family that breaks the limits", () => {
    const f = parseFamily(
      {
        schema: "tabcap-protection/0",
        id: "t",
        name: "T",
        vendor: "V",
        category: "captcha",
        version: 1,
        rules: [
          { id: "short", kind: "cookie", name: "_px", confidence: 100, note: "short name, no shape" },
          { id: "g", kind: "global", path: "x", confidence: 70, note: "a global above the captcha cap" },
          { id: "host", kind: "request", url: "vendor\\.example/", confidence: 100, note: "vendor host" },
        ],
        combinations: [
          { id: "top", name: "top", confidence: 100, when: { all: [{ rule: "host" }, { rule: "g" }] } },
          { id: "mid", name: "mid", confidence: 97, when: { any: [{ rule: "host" }] } },
        ],
      },
      "t.json",
      false,
    );
    const v = confidenceViolations(f).join("\n");
    expect(v).toContain("short: 100 needs a vendor-only signal");
    expect(v).toContain("g: a global rule is at most 60 in a captcha family");
    expect(v).toContain("top: a combination reaches 100 only from vendor-only signals (not g)");
    expect(v).toContain("mid: a combination below the top tier is at most 95");
    expect(v).not.toContain("host:");
  });

  test("layers follow the rule kind", () => {
    expect(["cookie", "request", "responseHeader", "requestHeader", "challenge", "requestBody"].map((k) => layerOf(k as never))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(["global", "dom", "frame"].map((k) => layerOf(k as never))).toEqual([2, 2, 2]);
    expect(layerOf("api")).toBe(3);
  });
});

describe("identify: each rule kind", () => {
  test("cookie: exact name, regex name, value shape checked but never output", () => {
    const f = fam([
      { id: "exact", kind: "cookie", name: "vendor_sid", confidence: 60, note: "n" },
      { id: "shaped", kind: "cookie", name: "^t[sk]$", nameRegex: true, valueShape: "^[0-9a-f]{8}~", confidence: 90, note: "n" },
    ]);
    const x: Evidence = { cookies: [{ name: "vendor_sid", value: "SECRET-1", request: "r-3" }, { name: "ts", value: "0123abcd~rest-SECRET-2", request: null }, { name: "tk", value: "nope", request: null }] };
    const d = identifyFamily(f, x);
    expect(d?.confidence).toBe(90);
    expect(d?.matched).toEqual([
      { rule: "exact", layer: 1, kind: "cookie", where: ["cookie vendor_sid (r-3)"] },
      { rule: "shaped", layer: 1, kind: "cookie", where: ["cookie ts"] },
    ]);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  test("request: by URL on recorded requests and on loaded resources; method / type narrow it; the query never shows", () => {
    const f = fam([
      { id: "host", kind: "request", url: "^https?://cdn\\.vendor\\.example(?::\\d+)?/", confidence: 100, note: "n" },
      { id: "post", kind: "request", url: "/collect$", method: "post", confidence: 40, note: "n" },
    ]);
    const d = identifyFamily(f, { requests: [req({ id: "r-4", url: "https://cdn.vendor.example/tag.js?key=SECRET" }), req({ id: "r-5", url: `${O}/collect`, method: "GET" })], resources: ["https://cdn.vendor.example/v2.js#x"] });
    expect(d?.matched).toEqual([{ rule: "host", layer: 1, kind: "request", where: ["r-4 https://cdn.vendor.example/tag.js", "https://cdn.vendor.example/v2.js"] }]);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  test("headers by name (value pattern optional, value never output), challenge pages, request bodies", () => {
    const f = fam([
      { id: "rh", kind: "responseHeader", name: "X-Vendor-Id", confidence: 100, note: "n" },
      { id: "rhv", kind: "responseHeader", name: "x-cdn", value: "^vendor", confidence: 80, note: "n" },
      { id: "qh", kind: "requestHeader", name: "x-vendor-token", confidence: 100, note: "n" },
      { id: "page", kind: "challenge", status: [412], text: "\\$_vendor\\s*=", confidence: 80, note: "n" },
      { id: "body", kind: "requestBody", text: "(?:^|&)vendor-response=", confidence: 60, note: "n" },
    ]);
    const x: Evidence = {
      requests: [
        req({ id: "r-1", url: `${O}/`, type: "document", status: 412, responseHeaders: { "X-Vendor-Id": "SECRET-ID", "content-type": "text/html" }, body: "<script>$_vendor = 1</script>" }),
        req({ id: "r-2", url: `${O}/a`, responseHeaders: { "X-CDN": "other" }, requestHeaders: { "X-Vendor-Token": "SECRET-T" } }),
        req({ id: "r-3", url: `${O}/form`, method: "POST", postData: "user=a&vendor-response=SECRET-B" }),
        req({ id: "r-4", url: `${O}/p`, type: "xhr", status: 412, body: "$_vendor = 1" }), // not a document: no challenge
      ],
    };
    const d = identifyFamily(f, x);
    expect(d?.matched.map((m) => [m.rule, m.where])).toEqual([
      ["rh", ["r-1 header x-vendor-id"]],
      ["qh", ["r-2 header x-vendor-token"]],
      ["page", [`r-1 412 ${O}/`]],
      ["body", [`r-3 body ${O}/form`]],
    ]);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  test("L2: globals by kind (an accessor only counts as exists), DOM with a descendant, frames", () => {
    const f = fam([
      { id: "fn", kind: "global", path: "initVendor", condition: "function", confidence: 60, note: "n" },
      { id: "acc", kind: "global", path: "vendorKey", condition: "string", confidence: 60, note: "n" },
      { id: "accx", kind: "global", path: "vendorKey", confidence: 50, note: "n" },
      { id: "widget", kind: "dom", match: { classPrefix: "v-captcha" }, has: { tag: "iframe" }, confidence: 60, note: "n" },
      { id: "frame", kind: "frame", url: "//challenge\\.vendor\\.example/", confidence: 70, note: "n" },
    ]);
    const x: Evidence = {
      globals: { initVendor: "function", vendorKey: "accessor" },
      dom: { els: [{ t: "div", id: "", c: "v-captcha box", a: {}, p: -1 }, { t: "iframe", id: "", c: "", a: { src: "x" }, p: 0 }], total: 2, truncated: false },
      frames: ["https://challenge.vendor.example/c?SECRET=1"],
    };
    const d = identifyFamily(f, x);
    expect(d?.matched.map((m) => m.rule)).toEqual(["fn", "accx", "widget", "frame"]);
    expect(d?.layers).toEqual([2]);
    expect(identifyFamily(f, { dom: { els: [{ t: "div", id: "", c: "v-captcha", a: {}, p: -1 }], total: 1, truncated: false } })).toBeNull(); // no iframe inside
  });

  test("L3: API calls, optionally only from a matching caller", () => {
    const f = fam([
      { id: "any", kind: "api", target: "HTMLCanvasElement.prototype.toDataURL", confidence: 40, note: "n" },
      { id: "vendor", kind: "api", target: "Navigator.prototype.plugins", caller: "vendor\\.example/", confidence: 50, note: "n" },
    ]);
    const d = identifyFamily(f, { api: [{ target: "HTMLCanvasElement.prototype.toDataURL", caller: "https://a.example/app.js?v=1", count: 3 }, { target: "Navigator.prototype.plugins", caller: "https://other.example/x.js", count: 1 }] });
    expect(d?.matched).toEqual([{ rule: "any", layer: 3, kind: "api", where: ["api HTMLCanvasElement.prototype.toDataURL by https://a.example/app.js"] }]);
  });

  test("scoring: strongest standalone rule or holding combination; standalone:false only counts inside one; below MIN_REPORT nothing", () => {
    const f = fam(
      [
        { id: "weak", kind: "cookie", name: "_v", confidence: 40, standalone: false, note: "n" },
        { id: "mid", kind: "cookie", name: "v_session", confidence: 60, note: "n" },
        { id: "tiny", kind: "cookie", name: "v_tiny", confidence: MIN_REPORT - 1, note: "n" },
      ],
      { combinations: [{ id: "pair", name: "pair", confidence: 90, when: { all: [{ rule: "weak" }, { any: [{ rule: "mid" }] }] } }] },
    );
    expect(identifyFamily(f, { cookies: [{ name: "_v", value: null, request: null }] })).toBeNull();
    expect(identifyFamily(f, { cookies: [{ name: "v_tiny", value: null, request: null }] })).toBeNull();
    expect(identifyFamily(f, { cookies: [{ name: "v_session", value: null, request: null }] })).toMatchObject({ confidence: 60, combination: null });
    expect(identifyFamily(f, { cookies: [{ name: "_v", value: null, request: null }, { name: "v_session", value: null, request: null }] })).toMatchObject({ confidence: 90, combination: "pair" });
  });

  test("urlPointer keeps scheme, host and path only", () => {
    expect(urlPointer("https://a.example:8443/p/q?token=x#f")).toBe("https://a.example:8443/p/q");
    expect(urlPointer("not a url?x=1")).toBe("not a url");
  });
});

describe("identify: built-in families on planted evidence", () => {
  const all = () => builtinFamilies();
  test("DataDome cookie + tag → 100; Akamai _abck → 100; reCAPTCHA by its loader; nothing on generic signals", () => {
    const r = identify(all(), {
      cookies: [{ name: "datadome", value: "x", request: "r-2" }, { name: "_abck", value: "y", request: "r-3" }, { name: "TS01ab12cd", value: "z", request: "r-4" }],
      requests: [req({ id: "r-5", url: "https://js.datadome.co/tags.js" }), req({ id: "r-6", url: "https://www.google.com/recaptcha/api.js?render=k", type: "script" }), req({ id: "r-7", url: `${O}/cdn-cgi/trace` })],
    });
    expect(r.detections.map((d) => [d.family, d.confidence])).toEqual([
      ["akamai-bot-manager", 100],
      ["datadome", 100],
      ["recaptcha", 100],
    ]);
    expect(r.fingerprinting).toEqual([]);
  });

  test("瑞数: the 412 page with $_ts and the global → 90 by the combination", () => {
    const r = identify(all(), { requests: [req({ id: "r-1", url: `${O}/`, type: "document", status: 412, body: '<meta content="x"><script>$_ts=window.$_ts||{};</script>' })], globals: { $_ts: "object" } });
    expect(r.detections.find((d) => d.family === "ruishu")).toMatchObject({ confidence: 90, combination: "page-and-global", layers: [1, 2] });
  });

  test("fingerprinting: techniques from API calls, callers counted, attributed to the vendor whose script made them", () => {
    const tm = "https://h.online-metrix.net/fp/tags.js?org_id=SECRET";
    const r = identify(all(), {
      requests: [req({ id: "r-2", url: tm, type: "script" })],
      api: [
        { target: "HTMLCanvasElement.prototype.toDataURL", caller: tm, count: 2 },
        { target: "CanvasRenderingContext2D.prototype.getImageData", caller: tm, count: 1 },
        { target: "Navigator.prototype.hardwareConcurrency", caller: tm, count: 1 },
        { target: "Navigator.prototype.deviceMemory", caller: tm, count: 1 },
      ],
    });
    expect(r.detections.map((d) => [d.family, d.confidence])).toEqual([
      ["threatmetrix", 100],
      ["fp-canvas", 70],
      ["fp-hardware", 60],
    ]);
    expect(r.fingerprinting).toEqual([
      { technique: "Canvas fingerprinting", family: "fp-canvas", apis: ["CanvasRenderingContext2D.prototype.getImageData", "HTMLCanvasElement.prototype.toDataURL"], callers: [{ url: "https://h.online-metrix.net/fp/tags.js", count: 3 }], attributedTo: "threatmetrix" },
      { technique: "Hardware fingerprinting", family: "fp-hardware", apis: ["Navigator.prototype.deviceMemory", "Navigator.prototype.hardwareConcurrency"], callers: [{ url: "https://h.online-metrix.net/fp/tags.js", count: 2 }], attributedTo: "threatmetrix" },
    ]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("user rule files (config/protection/)", () => {
  test("same id overrides a built-in, a new id is added, a bad file is skipped with a warning naming it", () => {
    const dir = join(tmp("tabcap-prot-"), "protection");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "datadome.json"), JSON.stringify({ schema: "tabcap-protection/0", id: "datadome", name: "DataDome (mine)", vendor: "DataDome", category: "anti-bot", version: 2, rules: [{ id: "c", kind: "cookie", name: "dd_mine", confidence: 70, note: "mine" }] }));
    writeFileSync(join(dir, "mine.json"), JSON.stringify({ schema: "tabcap-protection/0", id: "mine", name: "Mine", vendor: "Me", category: "captcha", version: 1, rules: [{ id: "g", kind: "global", path: "mine", confidence: 50, note: "n" }] }));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "badregex.json"), JSON.stringify({ schema: "tabcap-protection/0", id: "bad", name: "B", vendor: "B", category: "anti-bot", version: 1, rules: [{ id: "r", kind: "request", url: "(", confidence: 50, note: "n" }] }));
    const { families, warnings } = loadFamilies(dir);
    expect(families.find((f) => f.id === "datadome")?.name).toBe("DataDome (mine)");
    expect(families.some((f) => f.id === "mine")).toBe(true);
    expect(families.length).toBe(builtinFamilies().length + 1);
    expect(warnings.length).toBe(2);
    expect(warnings.join("\n")).toContain("broken.json");
    expect(warnings.join("\n")).toContain("badregex.json skipped: ");
    expect(loadFamilies(join(dir, "missing")).families.length).toBe(builtinFamilies().length);
  });
});

describe("HTML scan (offline L2)", () => {
  test("start tags with attributes, script / iframe src, comments and script bodies skipped", () => {
    const s = scanHtml(`<!doctype html><html><body class="x"><!-- <div class="g-recaptcha"> -->
<div id=box class='g-recaptcha big' data-sitekey="K"></div>
<script src="/a.js"></script><script>var s = '<div class="h-captcha">';</script>
<iframe src="https://geo.captcha-delivery.com/c"></iframe></body></html>`);
    const divs = s.digest.els.filter((e) => e.t === "div");
    expect(divs).toEqual([{ t: "div", id: "box", c: "g-recaptcha big", a: { id: "box", class: "g-recaptcha big", "data-sitekey": "K" }, p: -1 }]);
    expect(s.scripts).toEqual(["/a.js"]);
    expect(s.frames).toEqual(["https://geo.captcha-delivery.com/c"]);
  });
});

describe("offline: a recorded bundle through recon", () => {
  test("cookies from Set-Cookie, the page's markup and script src, trace signals → families and fingerprinting in the dossier; values stay out", async () => {
    const dir = tmp("tabcap-prot-");
    const ids = { doc: "", tag: "" };
    await buildBundle(dir, { name: "prot", created: C, seed: 41 }, async (b) => {
      ids.doc = idOf(
        await b.request({
          url: `${O}/shop`,
          type: "document",
          mime: "text/html",
          body: `<html><body><div class="cf-turnstile" data-sitekey="K"></div><script src="https://static.geetest.com/v4/gt4.js"></script></body></html>`,
          respHeaders: { "set-cookie": "datadome=SECRETVALUE; Path=/" },
          ts: C + 100,
        }),
      );
      ids.tag = idOf(await b.request({ url: "https://js.datadome.co/tags.js", type: "script", mime: "text/javascript", body: "/* stub */", ts: C + 200 }));
      b.w.append({ actor: "system", tab: "t1", cmd: null, ts: C + 300, mono: null, kind: "signal", frame: null, nav: null, api: "MediaDevices.prototype.enumerateDevices", access: "call", args: null, caller: { kind: "page", url: "https://js.datadome.co/tags.js", scriptId: "1", line: 0, col: 0 }, stack: [], count: 1, firstMono: null, lastMono: null });
    });
    const reader = BundleReader.open(dir);
    const x = evidenceFromBundle(reader);
    expect(x.globals).toBeNull();
    expect(x.cookies?.some((c) => c.name === "datadome" && c.request === ids.doc)).toBe(true);
    const page: ReconPage = { url: `${O}/shop`, title: null, text: "", source: "recorded-document", request: ids.doc, adapters: null };
    const d = buildDossier(reader, page);
    const fams = d.protection.filter((p) => p.source === "family").map((p) => (p.source === "family" ? [p.family, p.confidence] : []));
    expect(fams).toEqual([
      ["datadome", 100],
      ["geetest-v4", 100],
      ["turnstile", 60],
    ]);
    expect(d.fingerprinting).toEqual([{ technique: "Media device enumeration", family: "fp-media-devices", apis: ["MediaDevices.prototype.enumerateDevices"], callers: [{ url: "https://js.datadome.co/tags.js", count: 1 }], attributedTo: "datadome" }]);
    expect(JSON.stringify(d)).not.toContain("SECRETVALUE");
  });
});
