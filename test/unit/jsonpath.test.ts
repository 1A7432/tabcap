// One JSON path grammar (review wave 2, docs/04 §43): `--select`, stop / end
// rules (`--stop-on`, `--end-on`, site guard rules), `--business-code` and the
// replay key rules (`ignoreBodyFields`, `ignorePaths`) all parse a path with
// src/shared/jsonpath.ts. The oracle is the grammar as docs/04 §43 writes it:
// `$`, then `.name`, `.*`, `[n]`, `[*]`, `["quoted name"]`; a bare name has
// none of . [ ] = ! or whitespace. The same expression gives the same steps on
// every path; what the grammar refuses, every path refuses with a position.

import { describe, expect, test } from "bun:test";
import { parseJsonPath, pathText, valuesAt, type PathSeg } from "../../src/shared/jsonpath.ts";
import { parsePath as parseSelect, selectPath } from "../../src/shared/filter.ts";
import { firstStop, parseStopRule } from "../../src/daemon/fetch/stoprules.ts";
import { businessErrorIn, parseBusinessRule } from "../../src/bundle/usage.ts";
import { canonicalJson, parseFieldPattern } from "../../src/replay/rules.ts";

const key = (k: string): PathSeg => ({ kind: "key", key: k });
const idx = (n: number): PathSeg => ({ kind: "index", index: n });
const ALL: PathSeg = { kind: "all" };

const VALID: Array<[string, PathSeg[]]> = [
  ["$.code", [key("code")]],
  ["$.data.items[1].state", [key("data"), key("items"), idx(1), key("state")]],
  ["$.items[*].id", [key("items"), ALL, key("id")]],
  ["$.items.*.id", [key("items"), ALL, key("id")]],
  ['$["x y"].z', [key("x y"), key("z")]],
  ['$["a=b"]["c!d"]', [key("a=b"), key("c!d")]],
  ['$["*"]', [key("*")]],
  ['$["q\\"uote"]', [key('q"uote')]],
  ["$.x-csrf", [key("x-csrf")]],
  ["$.名字.$id", [key("名字"), key("$id")]],
  ["$[0][01]", [idx(0), idx(1)]],
];

const INVALID = ["$..a", "$.a[x]", "$.a[", "$.a]", "$.a b", "$.a.", '$.["x"]', '$["x"', '$["x"y]', "$[-1]", "$[1234567890]", "$['x']"];

/** Every path that parses a JSON path; null when it refuses. Messages must say where. */
const PATHS: Array<[string, (p: string) => PathSeg[] | null]> = [
  ["shared", (p) => {
    const r = parseJsonPath(p, { root: "required" });
    if (!r.ok) {
      expect(r.why).toMatch(/at character \d+/);
      return null;
    }
    return r.segs;
  }],
  ["--select", (p) => attempt(() => parseSelect(p))],
  ["stop rule", (p) => attempt(() => {
    const r = parseStopRule(`json:${p}=1`);
    return r.kind === "json" ? r.path : [];
  })],
  ["--business-code", (p) => attempt(() => parseBusinessRule(`${p}=1`).path)],
  ["replay rules", (p) => {
    const r = parseFieldPattern(p);
    if (typeof r === "string") {
      expect(r).toMatch(/at character \d+/);
      return null;
    }
    return r.segs;
  }],
];

function attempt(f: () => PathSeg[]): PathSeg[] | null {
  try {
    return f();
  } catch (e) {
    expect(e).toMatchObject({ code: "usage" });
    expect(String(e instanceof Error ? e.message : e)).toMatch(/character \d+|must start with \$|expected/);
    return null;
  }
}

describe("one grammar, every path (docs/04 §43)", () => {
  test.each(VALID)("%s parses to the same steps everywhere", (p, segs) => {
    for (const [name, parse] of PATHS) expect([name, parse(p)]).toEqual([name, segs]);
    expect(parseJsonPath(pathText(segs), { root: "required" })).toMatchObject({ ok: true, segs });
  });

  test.each(INVALID.map((p) => [p]))("%s is refused everywhere", (p) => {
    for (const [name, parse] of PATHS) expect([name, parse(p)]).toEqual([name, null]);
  });

  test("--select: $ is optional; a bare first name; $ alone is the whole answer; caps stay", () => {
    expect(parseSelect("requests[*].url")).toEqual([key("requests"), ALL, key("url")]);
    expect(parseSelect("$.requests[*].url")).toEqual([key("requests"), ALL, key("url")]);
    expect(parseSelect("[*].id")).toEqual([ALL, key("id")]);
    expect(parseSelect('requests[0]["x y"]')).toEqual([key("requests"), idx(0), key("x y")]);
    expect(parseSelect("$foo.a")).toEqual([key("$foo"), key("a")]);
    expect(parseSelect("$")).toEqual([]);
    const data = { requests: [{ url: "/a", "x y": 1 }, { url: "/b" }] };
    expect(selectPath(data, "$.requests[*].url", parseSelect("$.requests[*].url"))).toEqual({ value: ["/a", "/b"], count: 2 });
    expect(selectPath(data, 'requests[0]["x y"]', parseSelect('requests[0]["x y"]'))).toEqual({ value: 1, count: null });
    for (const bad of ["", ".a", "a".repeat(257), Array.from({ length: 33 }, () => "k").join(".")]) expect(() => parseSelect(bad)).toThrow(/^--select .*: (empty path|expected a name|longer than 256|more than 32)/);
  });

  test("= and ! end a bare name: a rule's operator follows the path; a whole-string path refuses them (quote such names)", () => {
    expect(parseStopRule("json:$.a=b=1")).toMatchObject({ kind: "json", path: [key("a")], op: "=", value: "b=1" });
    expect(parseStopRule("json:$.a!=1")).toMatchObject({ kind: "json", path: [key("a")], op: "!=", value: 1 });
    expect(parseBusinessRule("$.a=b=1")).toMatchObject({ path: [key("a")], ok: "b=1" });
    expect(attempt(() => parseSelect("a=b"))).toBeNull();
    expect(parseFieldPattern("$.a=b")).toMatch(/at character 4/);
    expect(parseSelect('["a=b"]')).toEqual([key("a=b")]);
  });

  test("rules still need $; replay names without $ stay names; $ alone is not a replay path", () => {
    expect(attempt(() => parseBusinessRule("code=1").path)).toBeNull();
    expect(() => parseStopRule("json:code=1")).toThrow(/must start with \$/);
    expect(parseFieldPattern("user.name")).toEqual({ text: "user.name", segs: [key("user.name")], name: "user.name" });
    expect(parseFieldPattern("$")).toMatch(/whole body/);
  });
});

describe("what a path selects", () => {
  const doc = { items: [{ code: 0, state: "ok" }, { code: 3, state: "locked" }], "err msg": "locked", empty: [] };

  test("valuesAt: every value, with its own concrete path; missing branches give nothing", () => {
    const at = (p: string) => {
      const r = parseJsonPath(p, { root: "required" });
      if (!r.ok) throw new Error(r.why);
      return valuesAt(doc, r.segs).map((h) => [pathText(h.path), h.value]);
    };
    expect(at("$.items[*].code")).toEqual([["$.items[0].code", 0], ["$.items[1].code", 3]]);
    expect(at('$["err msg"]')).toEqual([['$["err msg"]', "locked"]]);
    expect(at("$.items[5].code")).toEqual([]);
    expect(at("$.empty[*]")).toEqual([]);
    expect(at("$")).toEqual([["$", doc]]);
  });

  test("stop rules: = fires when some value equals; != when some value differs or there is none", () => {
    const input = (v: unknown) => ({ status: 200, bytes: 10, text: JSON.stringify(v) });
    expect(firstStop([parseStopRule("json:$.items[*].code!=0")], input(doc))).toEqual({ rule: "json:$.items[*].code!=0", detail: "$.items[1].code is 3" });
    expect(firstStop([parseStopRule("json:$.items[*].code!=0")], input({ items: [{ code: 0 }] }))).toBeNull();
    expect(firstStop([parseStopRule("json:$.items[*].code!=0")], input({ items: [] }))).toEqual({ rule: "json:$.items[*].code!=0", detail: "$.items[*].code is no value" });
    expect(firstStop([parseStopRule("json:$.items[*].state=locked")], input(doc))).toEqual({ rule: "json:$.items[*].state=locked", detail: "$.items[1].state is \"locked\"" });
    expect(firstStop([parseStopRule('json:$["err msg"]="locked"')], input(doc))?.detail).toBe('$["err msg"] is "locked"');
    expect(firstStop([parseStopRule("json:$.code != 0")], input({ code: 1 }))?.detail).toBe("$.code is 1");
  });

  test("--business-code: an error when some value is not the ok value, or there is none", () => {
    const rules = [parseBusinessRule("$.items[*].code=0")];
    expect(businessErrorIn(doc, rules)).toBe(true);
    expect(businessErrorIn({ items: [{ code: 0 }, { code: 0 }] }, rules)).toBe(false);
    expect(businessErrorIn({ items: [] }, rules)).toBe(true);
    expect(businessErrorIn({ code: 0 }, [parseBusinessRule("$.code=0")])).toBe(false);
  });

  test("replay rules: a quoted name is dropped like any other path", () => {
    const p = parseFieldPattern('$["err msg"]');
    if (typeof p === "string") throw new Error(p);
    expect(canonicalJson({ "err msg": "x", keep: 1 }, [p])?.value).toEqual({ keep: 1 });
  });
});
