// Live protection probe (0.8-A2, docs/04 §41.3): the page-side functions read
// globals through descriptors only (a getter never runs), page answers are
// untrusted and filtered, the hints keep ≥ 50 and leave fingerprinting out,
// the guard's `next` names the families, and `status --text` shows them.

import { describe, expect, test } from "bun:test";
import { protectionPrefix } from "../../src/daemon/guard.ts";
import { GLOBALS_FN, RESOURCES_FN, globalPaths, parseCookies, parseGlobals, parseResources } from "../../src/daemon/protection/probe.ts";
import { LIVE_MIN, liveHints } from "../../src/daemon/protection/live.ts";
import { renderStatusText } from "../../src/daemon/tools/status.ts";
import { builtinFamilies } from "../../src/analyze/protection/registry.ts";
import type { Identification } from "../../src/analyze/protection/identify.ts";

/** Run the page function against a stand-in global object (the parameter shadows globalThis). */
function runGlobals(fake: object, paths: string[]): unknown {
  const fn = new Function("globalThis", `return (${GLOBALS_FN})`)(fake) as (p: string[]) => unknown;
  return fn(paths);
}

describe("probe: globals by descriptor", () => {
  test("kinds along a dotted path, inherited properties found, an accessor reported and never called", () => {
    let ran = 0;
    const proto = { inherited: () => 1 };
    const fake = Object.create(proto) as Record<string, unknown>;
    fake["initVendor"] = () => 1;
    fake["_dx"] = { Captcha: () => 1 };
    fake["cfg"] = { n: 3, s: "x", nil: null };
    Object.defineProperty(fake, "trap", {
      get() {
        ran++;
        return "k";
      },
    });
    const out = runGlobals(fake, ["initVendor", "_dx.Captcha", "cfg.n", "cfg.s", "cfg.nil", "inherited", "trap", "trap.deeper", "missing", "cfg.n.deeper"]);
    expect(out).toEqual({ initVendor: "function", "_dx.Captcha": "function", "cfg.n": "number", "cfg.s": "string", "cfg.nil": "object", inherited: "function", trap: "accessor", "trap.deeper": "accessor", missing: "undefined", "cfg.n.deeper": "undefined" });
    expect(ran).toBe(0);
  });

  test("the paths asked are the families' global rules, validated and sorted", () => {
    const paths = globalPaths(builtinFamilies());
    expect(paths).toContain("grecaptcha");
    expect(paths).toContain("_dx.Captcha");
    expect(paths).toContain("$_ts");
    expect([...paths].sort()).toEqual(paths);
  });

  test("page functions are plain function expressions (they are sent as text)", () => {
    expect(GLOBALS_FN.startsWith("function (paths)")).toBe(true);
    expect(RESOURCES_FN.startsWith("function (maxRes, maxFrames)")).toBe(true);
  });
});

describe("probe: untrusted page answers", () => {
  test("globals: only asked paths with known kinds", () => {
    expect(parseGlobals({ a: "function", b: "weird", c: 1, extra: "object" }, ["a", "b", "c"])).toEqual({ a: "function" });
    expect(parseGlobals("nope", ["a"])).toEqual({});
  });

  test("resources and frames: http(s) strings only, capped", () => {
    const many = Array.from({ length: 600 }, (_, i) => `https://h.example/${i}.js`);
    const r = parseResources({ resources: [...many, 3, "javascript:alert(1)", "data:x"], frames: ["https://f.example/", null, "about:blank"] });
    expect(r.resources.length).toBe(500);
    expect(r.frames).toEqual(["https://f.example/"]);
    expect(parseResources(null)).toEqual({ resources: [], frames: [] });
  });

  test("cookies: names with values (for shapes), malformed rows dropped", () => {
    expect(parseCookies({ cookies: [{ name: "a", value: "1" }, { name: "" }, { value: "x" }, { name: "b" }, 7] })).toEqual([
      { name: "a", value: "1", request: null },
      { name: "b", value: null, request: null },
    ]);
    expect(parseCookies({})).toEqual([]);
  });
});

describe("hints, guard and status", () => {
  test("hints: ≥ LIVE_MIN, fingerprinting left out", () => {
    const det = (family: string, category: "anti-bot" | "captcha" | "fingerprint", confidence: number) => ({ family, name: family.toUpperCase(), vendor: "v", category, confidence, layers: [1 as const], matched: [], combination: null, grade: "推断" as const });
    const found: Identification = { detections: [det("a", "anti-bot", 100), det("b", "captcha", LIVE_MIN), det("c", "captcha", LIVE_MIN - 1), det("fp", "fingerprint", 70)], fingerprinting: [] };
    expect(liveHints(found)).toEqual([
      { name: "A", category: "anti-bot", confidence: 100 },
      { name: "B", category: "captcha", confidence: LIVE_MIN },
    ]);
  });

  test("the guard's next starts with the identified families, nothing when there are none", () => {
    expect(protectionPrefix({ protection: ["Cloudflare Bot Management"] })).toBe("This is Cloudflare Bot Management (identified, not bypassed; a human handles it). ");
    expect(protectionPrefix({ protection: ["A", "B"] })).toContain("This is A + B");
    expect(protectionPrefix({})).toBe("");
    expect(protectionPrefix({ protection: [] })).toBe("");
  });

  test("status --text: the session line ends with the families", () => {
    const text = renderStatusText({
      daemon: { running: true, pid: 1, listener: "unix" },
      browser: { running: true, pid: 2, mode: "direct", tabs: 1, webdriver: "hidden" },
      plugins: { decode: [], challenge: [] },
      sessions: [{ session: "a", site: null, tabs: 1, current: "t1", recording: null, state: "running", trace: { state: "off" }, guardStops: [], protection: ["DataDome", "Google reCAPTCHA"] }],
      conflicts: [],
      next: null,
    });
    expect(text).toContain("a: no site · 1 tab(s) (current t1) · not recording · running · trace off · protection DataDome, Google reCAPTCHA");
  });
});
