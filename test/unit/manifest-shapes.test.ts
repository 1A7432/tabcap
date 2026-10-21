// manifest.json is untrusted input (AGENTS.md): parseManifest checks the shape
// of producer.browser, record and sample (review 10-21, low item) and answers
// bad-input for a malformed one, instead of passing it on typed as if it were
// valid (HAR export then wrote a `log.browser` without name / version, which
// HAR 1.2 requires). Absent stays absent, `browser: null` stays allowed, and
// unknown fields inside a valid object are kept, like everywhere in the
// manifest. Oracle: docs/04 §7 (the manifest example and its field notes).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHar, importHar } from "../../src/bundle/har.ts";
import { newManifest, parseManifest } from "../../src/bundle/manifest.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";

const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(newManifest({ id: "01TEST", created: 1 })));
const withField = (path: "browser" | "record" | "sample", v: unknown): Record<string, unknown> => {
  const m = base();
  if (path === "browser") m["producer"] = { tool: "tabcap", version: "1", browser: v };
  else m[path] = v;
  return m;
};

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
}

describe("producer.browser", () => {
  test("valid: name and version strings, optional userAgent, webdriver hidden | visible, string lists; extra fields kept; null allowed", () => {
    const b = { name: "Chrome", version: "155.0", userAgent: "UA", webdriver: "visible", args: ["--a"], extraArgs: [], dropArgs: ["--b"], later: 1 };
    const got: unknown = parseManifest(withField("browser", b)).producer.browser;
    expect(got).toEqual(b);
    expect(parseManifest(withField("browser", null)).producer.browser).toBeNull();
    expect(parseManifest(withField("browser", { name: "Chrome", version: "1", userAgent: null })).producer.browser).toEqual({ name: "Chrome", version: "1", userAgent: null });
    expect(parseManifest(base()).producer.browser).toBeUndefined();
  });

  test("malformed: bad-input naming the field", () => {
    for (const bad of ["Chrome", 1, [], { version: "1" }, { name: "Chrome" }, { name: 1, version: "1" }, { name: "C", version: "1", webdriver: "maybe" }, { name: "C", version: "1", args: "--a" }, { name: "C", version: "1", extraArgs: [1] }, { name: "C", version: "1", userAgent: 5 }]) {
      let msg = "";
      try {
        parseManifest(withField("browser", bad));
      } catch (e) {
        msg = e instanceof TabcapError ? `${e.code} ${e.message}` : String(e);
      }
      expect([JSON.stringify(bad), msg.startsWith("bad-input manifest.json: producer.browser")]).toEqual([JSON.stringify(bad), true]);
    }
  });
});

describe("record and sample", () => {
  test("record: {bodies: all | api | api+script | none}; anything else is bad-input", () => {
    for (const bodies of ["all", "api", "api+script", "none"]) {
      const got: unknown = parseManifest(withField("record", { bodies })).record;
      expect(got).toEqual({ bodies });
    }
    for (const bad of ["all", { bodies: "some" }, {}, null]) expect([JSON.stringify(bad), codeOf(() => parseManifest(withField("record", bad)))]).toEqual([JSON.stringify(bad), "bad-input"]);
  });

  test("sample: {challengeRequests: string[], scripts: [{request, sha256, inline}], env: string | null}; anything else is bad-input", () => {
    const ok = { challengeRequests: ["r-1"], scripts: [{ request: "r-2", sha256: "ab", inline: false }], env: null };
    expect(parseManifest(withField("sample", ok)).sample).toEqual(ok);
    for (const bad of [[], { ...ok, challengeRequests: "r-1" }, { ...ok, scripts: [{ request: "r-2" }] }, { ...ok, env: 1 }]) expect([JSON.stringify(bad), codeOf(() => parseManifest(withField("sample", bad)))]).toEqual([JSON.stringify(bad), "bad-input"]);
  });
});

describe("through HAR", () => {
  test("a HAR _manifest with a malformed producer.browser is bad-input; a valid one exports log.browser with name and version", async () => {
    const view = { manifest: parseManifest(withField("browser", { name: "Chrome", version: "155.0" })), events: [], readBlob: () => null };
    const { har } = exportHar(view, { embedEvents: true });
    expect(har.log.browser).toEqual({ name: "Chrome", version: "155.0" });
    const doc: unknown = JSON.parse(JSON.stringify(har));
    if (!isRecord(doc) || !isRecord(doc["log"]) || !isRecord(doc["log"]["_manifest"])) throw new Error("no _manifest");
    doc["log"]["_manifest"]["producer"] = { tool: "tabcap", version: "1", browser: "Chrome" };
    let code: string | null = null;
    try {
      await importHar(doc, join(mkdtempSync(join(tmpdir(), "tabcap-mshape-")), "out"));
    } catch (e) {
      code = e instanceof TabcapError ? e.code : String(e);
    }
    expect(code).toBe("bad-input");
  });
});
