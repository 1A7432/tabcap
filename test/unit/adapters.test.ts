// 0.3-D adapter registry: manifest validation (adapters from disk are
// untrusted) and the manifest half of the detect hook, a pure function over a
// DOM digest. The fake-ui adapter (test/fixtures/adapters/) exercises every
// feature kind and all five hooks.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combine, detectAdapter, digestNeeds, featureMatches, globalNames, globalsExpression, parseDigest, type Digest } from "../../src/daemon/adapters/detect.ts";
import { checkScript, hookNotImplemented, loadAdapterDir, parseAdapter, type Adapter } from "../../src/daemon/adapters/manifest.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const FAKE = join(import.meta.dir, "..", "fixtures", "adapters", "fake-ui");

function badDir(manifest: unknown, files: Record<string, string> = {}, name = "bad-one"): string {
  const root = mkdtempSync(join(tmpdir(), "tabcap-adapters-"));
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "adapter.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

const base = { schema: "tabcap-adapter/0", name: "bad-one", category: "widget", version: 1 };

function rejects(dir: string, needle: string): void {
  let err: unknown = null;
  try {
    loadAdapterDir(dir);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TabcapError);
  if (err instanceof TabcapError) {
    expect(err.code).toBe("bad-input");
    expect(err.message).toContain("rejected");
    expect(err.message).toContain(needle);
    expect(err.next.length).toBeGreaterThan(0);
  }
}

describe("adapter manifests (untrusted when loaded from disk)", () => {
  test("the fake-ui fixture loads with all five hooks", () => {
    const a = loadAdapterDir(FAKE);
    expect(a).toMatchObject({ name: "fake-ui", category: "widget", version: 1, source: FAKE });
    expect(Object.keys(a.hooks).sort()).toEqual(["act", "decode", "describe", "detect", "read"]);
    expect(a.hooks.describe).toEqual({ when: "detected" });
    expect(a.hooks.act).toEqual({ ops: ["select"] });
    expect(a.detect.map((f) => f.kind)).toEqual(["class-prefix", "global", "dom", "dom", "header"]);
    expect(a.detect[0]?.label).toBe("class fui-*");
    expect(a.script).toContain("describe()");
  });

  test("read and decode are validated but not run in 0.3", () => {
    const a = loadAdapterDir(FAKE);
    for (const h of ["read", "decode"] as const) {
      const e = hookNotImplemented(a, h);
      expect(e.code).toBe("unsupported");
      expect(e.message).toContain(`${h} hook is declared and validated`);
    }
  });

  test("bad manifests are rejected with the file and field named", () => {
    rejects(badDir("{not json"), "adapter.json is not JSON");
    rejects(badDir([1, 2]), "adapter.json: must be an object");
    rejects(badDir({ ...base, schema: "tabcap-adapter/9" }), "adapter.json.schema");
    rejects(badDir({ ...base, name: "Other" }, {}, "Other"), "adapter.json.name: has an invalid form");
    rejects(badDir({ ...base, name: "other-name" }), 'must equal the directory name "bad-one"');
    rejects(badDir({ ...base, category: "protection" }), "adapter.json.category: must be one of widget, overlay, channel, framework");
    rejects(badDir({ ...base, version: 0 }), "adapter.json.version");
    rejects(badDir({ ...base, extra: true }), 'unknown key "extra"');
    rejects(badDir({ ...base, detect: [{ kind: "class-prefix", prefix: "x", confidence: 1.5 }] }), "adapter.json.detect[0].confidence: must be a number in (0, 1]");
    rejects(badDir({ ...base, detect: [{ kind: "class-prefix", prefix: "a b", confidence: 0.5 }] }), "adapter.json.detect[0].prefix: has an invalid form");
    rejects(badDir({ ...base, detect: [{ kind: "global", name: "a.b()", confidence: 0.5 }] }), "adapter.json.detect[0].name: has an invalid form");
    rejects(badDir({ ...base, detect: [{ kind: "css", selector: "*", confidence: 0.5 }] }), "adapter.json.detect[0].kind");
    rejects(badDir({ ...base, detect: [{ kind: "dom", match: {}, confidence: 0.5 }] }), "adapter.json.detect[0].match: needs at least one of");
    rejects(badDir({ ...base, detect: [{ kind: "header", name: "server", pattern: "(", confidence: 0.5 }] }), "adapter.json.detect[0].pattern: is not a valid regular expression");
    rejects(badDir({ ...base, detect: Array.from({ length: 65 }, () => ({ kind: "global", name: "x", confidence: 0.1 })) }), "at most 64 features");
    rejects(badDir({ ...base, hooks: { describe: { when: "always" } } }), "adapter.json.script: is required");
    rejects(badDir({ ...base, script: "page.js", hooks: { describe: { when: "always" } } }), "page.js: is missing");
    rejects(badDir({ ...base, script: "../evil.js", hooks: { describe: {} } }), "adapter.json.script: has an invalid form");
    rejects(badDir({ ...base, script: "page.js", hooks: { describe: {} } }, { "page.js": "({ describe() { return 1 }" }), "page.js: does not parse as a JavaScript expression");
    rejects(badDir({ ...base, hooks: { read: { mode: "always" } } }), "adapter.json.hooks.read.mode: must be explicit");
    rejects(badDir({ ...base, hooks: { act: { ops: [] } } }), "adapter.json.hooks.act.ops");
    rejects(badDir({ ...base, hooks: { decode: { contentTypes: ["not a type"] } } }), "adapter.json.hooks.decode.contentTypes[0]");
    rejects(badDir({ ...base, hooks: { teleport: {} } }), 'unknown key "teleport"');
    rejects(badDir({ ...base, description: "x".repeat(300) }), "adapter.json.description: must be 1..200 characters");
    rejects(badDir(JSON.stringify({ ...base, description: "x".repeat(40_000) })), "larger than 32768 bytes");
  });

  test("a script is syntax-checked but never run", () => {
    // Would throw if it ran; compiling it must not.
    expect(checkScript("({ describe() { throw new Error('ran') } })", "page.js")).toContain("describe");
    expect(() => checkScript("({ a: 1 }); globalThis.pwned = 1; ({", "page.js")).toThrow();
    expect((globalThis as Record<string, unknown>)["pwned"]).toBeUndefined();
  });

  test("parseAdapter validates embedded manifests the same way", () => {
    expect(() => parseAdapter({ ...base, name: "x" }, null, "builtin:x")).toThrow(/rejected: adapter.json.name/);
  });
});

/** A digest like DIGEST_FN returns: body > div.fui-grid > table, div[data-fui-version], span.other */
const DIGEST: Digest = {
  els: [
    { t: "body", id: "", c: "", a: {}, p: -1 },
    { t: "div", id: "g", c: "wrap fui-grid fui-grid--dense", a: {}, p: 0 },
    { t: "table", id: "", c: "", a: {}, p: 1 },
    { t: "div", id: "", c: "", a: { "data-fui-version": "1.2" }, p: 0 },
    { t: "span", id: "", c: "other", a: {}, p: 0 },
  ],
  total: 9,
  truncated: false,
};

describe("detect: manifest features over a digest", () => {
  const a: Adapter = loadAdapterDir(FAKE);

  test("digest needs and global probes come from the manifests", () => {
    expect(digestNeeds([a])).toEqual({ attrs: ["data-fui-version"], tags: ["table"] });
    expect(globalNames([a])).toEqual(["FakeUI"]);
    expect(globalsExpression(["FakeUI", "layer"])).toBe('["FakeUI" in globalThis, "layer" in globalThis]');
  });

  test("every kind matches, confidences combine as noisy-OR", () => {
    const d = detectAdapter(a, { digest: DIGEST, globals: { FakeUI: true }, headers: { "X-Fake-UI": "1.4.0" } });
    expect(d.evidence).toEqual(["class fui-*", "global FakeUI", "dom *.fui-grid* > … table", "dom *[data-fui-version]", "header x-fake-ui ~ /^1\\./"]);
    expect(d.unchecked).toEqual([]);
    expect(d.confidence).toBe(combine([0.5, 0.6, 0.4, 0.3, 0.2]));
    expect(d.confidence).toBe(0.93);
  });

  test("features without input are unchecked, not false", () => {
    const d = detectAdapter(a, { digest: DIGEST, globals: null, headers: null });
    expect(d.unchecked).toEqual(["global FakeUI", "header x-fake-ui ~ /^1\\./"]);
    expect(d.confidence).toBe(combine([0.5, 0.4, 0.3]));
  });

  test("`has` needs a real descendant; nothing matched means confidence 0", () => {
    const flat: Digest = { els: [{ t: "div", id: "", c: "fui-grid", a: {}, p: -1 }, { t: "table", id: "", c: "", a: {}, p: -1 }], total: 2, truncated: false };
    const f = a.detect[2];
    if (f === undefined) throw new Error("fixture changed");
    expect(featureMatches(f, { digest: flat, globals: null, headers: null })).toBe(false);
    const none = detectAdapter(a, { digest: { els: [], total: 0, truncated: false }, globals: { FakeUI: false }, headers: {} });
    expect(none).toMatchObject({ confidence: 0, evidence: [] });
  });

  test("a malformed digest from the page is dropped row by row, never trusted", () => {
    const d = parseDigest({ els: [null, { t: 3, c: ["x"], a: { k: 1, ok: "v" }, p: 99 }, { t: "div", id: "a", c: "fui-x", a: {}, p: 0 }], total: "lots" });
    expect(d.els).toEqual([
      { t: "", id: "", c: "", a: { ok: "v" }, p: -1 },
      { t: "div", id: "a", c: "fui-x", a: {}, p: 0 },
    ]);
    expect(d.total).toBe(2);
    expect(parseDigest("nope").els).toEqual([]);
  });
});
