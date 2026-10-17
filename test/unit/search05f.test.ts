// 0.5-F in-command search: snapshot filters (pure, over AX trees), the JS
// line-breaker, line search / ranges / --at over bodies, cross-body grep caps,
// html field shaping. The AX inputs are the captured fixtures/ax trees
// (Chrome for Testing 155) and small synthetic trees; body inputs are literals.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAxTree, renderAxTree, type AxNode } from "../../src/daemon/browser/ax.ts";
import { flattenAx, grepAx, nodesAx, pickLines, subtreeLines } from "../../src/daemon/browser/axfilter.ts";
import { RefTable, type DocIdentity } from "../../src/daemon/browser/refs.ts";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { htmlFields } from "../../src/daemon/tools/html.ts";
import { bodySearchOf, decodeBody, grepBodies, prettify, requestByUrl, searchBody } from "../../src/daemon/tools/netsearch.ts";
import { mapOffset, prettyJs, prettyJson, prettyKind } from "../../src/daemon/tools/pretty.ts";
import { snapshotOptions } from "../../src/daemon/tools/snapshot.ts";
import { around, compileRegex, grepLines, lineRange, LINE_MAX, parsePos, parseRange, splitLines, windowAt } from "../../src/daemon/tools/textsearch.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const DOC: DocIdentity = { frameId: "F1", loaderId: "L1", url: "http://127.0.0.1:PORT/" };
type Fixture = { passwordBackendIds: number[]; ax: unknown };
const home: Fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "ax", "home.json"), "utf8")) as Fixture;

function homeTree(): AxNode {
  const t = buildAxTree(home.ax, new Set(home.passwordBackendIds));
  if (t === null) throw new Error("empty tree");
  return t;
}

const node = (role: string, name: string, backendId: number | null, children: AxNode[] = []): AxNode => ({ role, name, value: null, description: "", backendId, password: false, flags: [], children });

// RootWebArea "T" > main > [heading "Cart" (1), list > [item a (2), item b (3), item c (4)], button "Pay" (5)]
function synthetic(): AxNode {
  return node("RootWebArea", "T", 100, [
    node("main", "", 10, [
      node("heading", "Cart", 1),
      node("list", "", 20, [node("listitem", "apple", 2), node("listitem", "banana", 3), node("listitem", "cherry", 4)]),
      node("button", "Pay now", 5),
    ]),
  ]);
}

const usageOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof TabcapError) return `${e.code}: ${e.message}`;
    throw e;
  }
  return "no error";
};

describe("snapshot filters (axfilter.ts)", () => {
  test("flattenAx mints the same refs, in the same order, as the full render", () => {
    const a = new RefTable();
    a.setDocument(DOC);
    const full = renderAxTree(homeTree(), (id) => a.refFor(id), 1e9);
    const b = new RefTable();
    b.setDocument(DOC);
    const flat = flattenAx(homeTree(), (id) => b.refFor(id));
    expect(flat.lines.map((l) => l.text).join("\n")).toBe(full.text);
    expect(flat.refs).toBe(full.refs);
  });

  test("--grep keeps the matching lines with their ancestor chain, indented as in the full tree", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const flat = flattenAx(synthetic(), (id) => refs.refFor(id));
    const hits = grepAx(flat.lines, compileRegex("banana", "--grep"));
    expect(hits).toHaveLength(1);
    expect(pickLines(flat.lines, hits, 0)).toBe(['- RootWebArea "T"', "  - main [e1]", "    - list [e3]", '      - listitem "banana" [e5]'].join("\n"));
  });

  test("--grep never matches the ref text itself; it sees role, name and states", () => {
    const refs = new RefTable();
    const flat = flattenAx(synthetic(), (id) => refs.refFor(id));
    expect(grepAx(flat.lines, compileRegex("e5", "--grep"))).toEqual([]);
    expect(grepAx(flat.lines, compileRegex("^button", "--grep"))).toHaveLength(1);
  });

  test("--context N adds N siblings each side (not their subtrees)", () => {
    const refs = new RefTable();
    const flat = flattenAx(synthetic(), (id) => refs.refFor(id));
    const hits = grepAx(flat.lines, compileRegex("cherry", "--grep"));
    expect(pickLines(flat.lines, hits, 1)).toBe(['- RootWebArea "T"', "  - main [e1]", "    - list [e3]", '      - listitem "banana" [e5]', '      - listitem "cherry" [e6]'].join("\n"));
    // the list's sibling heading / button with context 1 around the list's child: only siblings of the hit
    const pay = grepAx(flat.lines, compileRegex("Pay", "--grep"));
    expect(pickLines(flat.lines, pay, 1)).toBe(['- RootWebArea "T"', "  - main [e1]", "    - list [e3]", '    - button "Pay now" [e7]'].join("\n"));
  });

  test("--css mapping: DOM backend ids → their lines; ids without a line are reported missing", () => {
    const refs = new RefTable();
    const flat = flattenAx(synthetic(), (id) => refs.refFor(id));
    const r = nodesAx(flat.lines, [4, 2, 999]);
    expect(r.missing).toEqual([999]);
    expect(pickLines(flat.lines, r.hits, 0)).toBe(['- RootWebArea "T"', "  - main [e1]", "    - list [e3]", '      - listitem "apple" [e4]', '      - listitem "cherry" [e6]'].join("\n"));
  });

  test("--ref --depth: the subtree, re-indented, deeper lines counted", () => {
    const refs = new RefTable();
    const flat = flattenAx(synthetic(), (id) => refs.refFor(id));
    const main = flat.lines.findIndex((l) => l.backendId === 10);
    expect(subtreeLines(flat.lines, main, 1)).toEqual({ text: ["- main [e1]", '  - heading "Cart" [e2]', "  - list [e3]", '  - button "Pay now" [e7]'].join("\n"), shown: 4, hidden: 3 });
    expect(subtreeLines(flat.lines, main, null).hidden).toBe(0);
    expect(subtreeLines(flat.lines, main, 0)).toEqual({ text: "- main [e1]", shown: 1, hidden: 6 });
  });

  test("grep on a captured tree (fixtures/ax/home): the password field's value never shows, its line does", () => {
    const refs = new RefTable();
    const flat = flattenAx(homeTree(), (id) => refs.refFor(id));
    const hits = grepAx(flat.lines, compileRegex("Password", "--grep"));
    const text = pickLines(flat.lines, hits, 0);
    expect(text).toMatch(/textbox "Password" \[e\d+\]/);
    expect(text.split("\n")[0]).toMatch(/^- RootWebArea/);
  });

  test("snapshotOptions: one filter at a time, regex rules, irrelevant flags ignored", () => {
    expect(snapshotOptions({}).search).toBeNull();
    expect(snapshotOptions({ context: 0, maxMatches: 50 }).search).toBeNull();
    expect(usageOf(() => snapshotOptions({ grep: "a", css: "b" }))).toMatch(/^usage: give one of --grep/);
    expect(usageOf(() => snapshotOptions({ grep: "(" }))).toMatch(/^usage: --grep: invalid regular expression/);
    expect(usageOf(() => snapshotOptions({ grep: "x".repeat(257) }))).toMatch(/^usage: --grep pattern is 257 chars; at most 256/);
    expect(snapshotOptions({ grep: "x".repeat(256) }).search?.mode).toBe("grep");
    expect(usageOf(() => snapshotOptions({ css: "  " }))).toMatch(/^usage: --css needs an expression/);
    expect(snapshotOptions({ ref: "f2/e7", depth: 2 }).search).toEqual({ mode: "ref", ref: "f2/e7", depth: 2 });
    const g = snapshotOptions({ grep: "\\p{L}+", context: 99, maxMatches: 0 }).search;
    expect(g?.mode === "grep" ? [g.context, g.max, g.re.unicode] : null).toEqual([20, 1, true]);
  });
});

/** The pretty text minus what was inserted must be the raw text, and every raw char must land on itself. */
function checkMap(raw: string): string {
  const p = prettyJs(raw);
  for (let k = 0; k < raw.length; k++) expect(p.text[mapOffset(p, k)]).toBe(raw[k]);
  expect(stripInserted(p)).toBe(raw);
  return p.text;
}

function stripInserted(p: ReturnType<typeof prettyJs>): string {
  let out = "";
  let from = 0;
  p.at.forEach((pos, i) => {
    const before = i === 0 ? 0 : (p.cum[i - 1] ?? 0);
    const start = pos + before; // pretty offset where the insertion begins
    out += p.text.slice(from, start);
    from = start + ((p.cum[i] ?? 0) - before);
  });
  return out + p.text.slice(from);
}

describe("JS line-breaker (pretty.ts)", () => {
  const cases: Array<[string, string, string]> = [
    ["statements", "a=1;b=2;c()", "a=1;\nb=2;\nc()"],
    ["for (;;) stays", "for(i=0;i<n;i++){x()}y()", "for(i=0;i<n;i++){\n  x()}\ny()"],
    ["strings", 'a="x;{y},";b=\'p;q\'', 'a="x;{y},";\nb=\'p;q\''],
    ["template with ${}", "a=`x;${b;{c}};y`;d", "a=`x;${b;{c}};y`;\nd"],
    ["regex literal", "a=/[;/]+;/g;b=c/d;e", "a=/[;/]+;/g;\nb=c/d;\ne"],
    ["regex after return", "function f(){return /;/.test(x)}", "function f(){\n  return /;/.test(x)}"],
    ["line comment", "a();// x;y\nb()", "a();// x;y\nb()"],
    ["block comment", "a();/* x;{y} */b()", "a();/* x;{y} */b()"],
    ["IIFE body breaks inside its braces", "(function(){a();b()})()", "(function(){\n  a();\n  b()})()"],
    ["object commas at depth 0 of the block", "x={a:1,b:[1,2,3]}", "x={\n  a:1,\n  b:[1,2,3]}"],
    ["nested braces indent; a closing brace after a closing brace gets its own line", "if(a){if(b){c()}}d()", "if(a){\n  if(b){\n    c()}\n}\nd()"],
    ["call args stay", "f(a,b,c);g()", "f(a,b,c);\ng()"],
    ["empty block", "function f(){}g()", "function f(){}\ng()"],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      expect(checkMap(raw)).toBe(want);
    });
  }

  test("never throws on unbalanced or truncated input, and stays a pure insertion", () => {
    const junk = ["}}}{{", "'unterminated;", "`tpl ${ a; b", "/re[;", "/*", "a=/", ")))(((", "\\", "${}}", "x`${`${`"];
    for (const j of junk) expect(() => checkMap(j)).not.toThrow();
    // deterministic pseudo-random soup of the tokenizer's special characters
    let seed = 7;
    const alphabet = "ab1 ;,{}()[]`$'\"/\\*\n=+r";
    for (let n = 0; n < 200; n++) {
      let s = "";
      for (let k = 0; k < 40; k++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += alphabet[seed % alphabet.length] ?? "";
      }
      expect(stripInserted(prettyJs(s))).toBe(s);
    }
  });

  test("prettyJson / prettyKind", () => {
    expect(prettyJson('{"a":[1,2],"b":{"c":null}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}');
    expect(prettyJson("{nope")).toBeNull();
    expect(prettyKind("application/json; charset=utf-8", "xhr")).toBe("json");
    expect(prettyKind("text/javascript", null)).toBe("js");
    expect(prettyKind("text/plain", "script")).toBe("js");
    expect(prettyKind("text/html", "document")).toBeNull();
  });
});

describe("line search (textsearch.ts)", () => {
  const body = ["alpha", "beta token=1", "gamma", "delta token=2 token=3", "eps"];

  test("grepLines: every occurrence with 1-based line / col and context; total counts past the cap", () => {
    const r = grepLines(body, compileRegex("token=\\d", "--grep", true), 1, 2);
    expect(r.total).toBe(3);
    expect(r.matches).toEqual([
      { line: 2, col: 6, text: "beta token=1", before: ["alpha"], after: ["gamma"] },
      { line: 4, col: 7, text: "delta token=2 token=3", before: ["gamma"], after: ["eps"] },
    ]);
  });

  test("an empty-matching regex terminates", () => {
    expect(grepLines(["ab"], compileRegex("x*", "--grep", true), 0, 10).total).toBe(3);
  });

  test("long lines: a 500-char window around the match, with the clip said", () => {
    const line = `${"a".repeat(3000)}NEEDLE${"b".repeat(3000)}`;
    const m = grepLines([line], compileRegex("NEEDLE", "--grep", true), 0, 5).matches[0];
    expect(m?.col).toBe(3001);
    expect(m?.text.startsWith("…")).toBe(true);
    expect(m?.text.endsWith("…")).toBe(true);
    expect(m?.text).toContain("NEEDLE");
    expect(m?.text.length).toBe(LINE_MAX + 2);
    expect(m?.clip?.chars).toBe(6006);
    const from = m?.clip?.from ?? 0;
    expect(line.slice(from - 1, from - 1 + LINE_MAX)).toBe(m?.text.slice(1, -1) ?? "");
    expect(windowAt("short", 2).clip).toBeNull();
  });

  test("lineRange: inclusive, capped at 500 per call with the next range", () => {
    const many = Array.from({ length: 1200 }, (_, i) => `l${i + 1}`);
    const r = lineRange(many, 2, 3);
    expect(r).toEqual({ from: 2, to: 3, content: [{ line: 2, text: "l2" }, { line: 3, text: "l3" }], clipped: 0, more: null });
    const big = lineRange(many, 1, 1200);
    expect(big.content).toHaveLength(500);
    expect(big.more).toBe("--lines 501-1000");
    expect(lineRange(many, 1190, 5000)).toMatchObject({ from: 1190, to: 1200, more: null });
  });

  test("parseRange / parsePos / around", () => {
    expect(parseRange("120-180")).toEqual([120, 180]);
    expect(parseRange("7")).toEqual([7, 7]);
    expect(usageOf(() => parseRange("9-3"))).toMatch(/^usage: --lines 9-3\?/);
    expect(usageOf(() => parseRange("0-3"))).toMatch(/^usage/);
    expect(parsePos("1:20345")).toEqual([1, 20345]);
    expect(parsePos("12")).toEqual([12, 1]);
    expect(usageOf(() => parsePos("a:b"))).toMatch(/^usage: --at a:b\?/);
    expect(around(body, 3, 2, 1)).toEqual({ line: 3, col: 2, text: "gamma", before: ["beta token=1"], after: ["delta token=2 token=3"] });
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b", ""]);
  });
});

describe("net body search (netsearch.ts)", () => {
  const minified = 'var a=1;function sign(t){return t+navigator.userAgent};window.x=sign("k");';
  const base = { id: "r-3", url: "http://127.0.0.1:1/min.js" };

  test("flags: one of --grep / --lines / --at; none → the old preview", () => {
    expect(bodySearchOf({})).toBeNull();
    expect(bodySearchOf({ pretty: true })?.search.mode).toBe("preview");
    expect(usageOf(() => bodySearchOf({ grep: "a", lines: "1-2" }))).toMatch(/^usage: give one of --grep, --lines and --at/);
    const g = bodySearchOf({ grep: "x" });
    expect(g?.search.mode === "grep" ? [g.search.context, g.search.max] : null).toEqual([3, 50]);
    const at = bodySearchOf({ at: "1:5" });
    expect(at?.search.mode === "at" ? at.search.context : null).toBe(5);
  });

  test("--grep on the raw and on the pretty text", () => {
    const s = bodySearchOf({ grep: "userAgent", context: 1 });
    if (s === null) throw new Error("no search");
    const raw = searchBody(base, minified, minified.length, "text/javascript", "script", s);
    expect(raw).toMatchObject({ lines: 1, pretty: false, total: 1, shown: 1, truncated: false });
    const pretty = searchBody(base, minified, minified.length, "text/javascript", "script", { ...s, pretty: true });
    expect(pretty).toMatchObject({ pretty: true, lines: 4, total: 1 });
    expect(pretty["matches"]).toEqual([{ line: 3, col: 22, text: "  return t+navigator.userAgent};", before: ["function sign(t){"], after: ['window.x=sign("k");'] }]);
  });

  test("--at maps a raw position (as trace list prints it) into the pretty text", () => {
    const col = minified.indexOf("navigator") + 1;
    const s = bodySearchOf({ at: `1:${col}`, context: 0, pretty: true });
    if (s === null) throw new Error("no search");
    const r = searchBody(base, minified, minified.length, "application/javascript", "script", s);
    const at = r["at"];
    expect(at).toEqual({ line: 3, col: 12, text: "  return t+navigator.userAgent};", before: [], after: [], raw: { line: 1, col } });
    const pretty = prettify(minified, minified.length, "application/javascript", "script").text;
    expect(splitLines(pretty)[2]?.slice(11, 20)).toBe("navigator");
    // without --pretty: the raw line around the column
    const plain = searchBody(base, minified, minified.length, "application/javascript", "script", { search: { mode: "at", line: 1, col, context: 0 }, pretty: false });
    expect(plain["at"]).toEqual({ line: 1, col, text: minified, before: [], after: [] });
  });

  test("--lines and --pretty refusals are said, never silent", () => {
    const r = searchBody(base, "<p>a</p>\n<p>b</p>", 17, "text/html", "document", { search: { mode: "lines", from: 2, to: 9 }, pretty: true });
    expect(r).toMatchObject({ pretty: false, from: 2, to: 2, content: [{ line: 2, text: "<p>b</p>" }] });
    expect(String(r["note"])).toContain("--pretty applies to JavaScript and JSON bodies");
    expect(usageOf(() => searchBody(base, "a\nb", 3, "text/plain", null, { search: { mode: "lines", from: 5, to: 6 }, pretty: false }))).toMatch(/the body has 2 line\(s\)/);
    const over = prettify("a;b", 9 * 1024 * 1024, "text/javascript", "script");
    expect(over).toMatchObject({ pretty: false, text: "a;b" });
    expect(over.note).toContain("over the 8 MB limit");
    const bad = prettify("{nope", 5, "application/json", "xhr");
    expect(bad.note).toContain("not valid JSON");
  });

  test("decodeBody: UTF-8, the response charset, binary", () => {
    expect(decodeBody(new TextEncoder().encode("héllo"), "text/plain", () => null)).toBe("héllo");
    // GBK bytes of 你好 (not valid UTF-8): decoded with the recorded charset
    expect(decodeBody(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), "text/html", () => "gbk")).toBe("你好");
    expect(decodeBody(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]), "image/png", () => null)).toBeNull();
    expect(decodeBody(new Uint8Array([0x00, 0x01, 0x02]), "font/woff2", () => null)).toBeNull();
  });

  test("--url picks the last request with a body; the fragment is ignored", () => {
    const e = (id: string, url: string, blob: string | null): NetEntry => ({ id, tab: "t1", type: "script", method: "GET", url, status: 200, mime: "text/javascript", size: 1, outcome: "finished", blob, bodyMissing: null, cmd: null, at: 0 });
    const idx = [e("r-1", "http://h/a.js", "b1"), e("r-2", "http://h/a.js", "b2"), e("r-3", "http://h/a.js", null), e("r-4", "http://h/b.js", "b4")];
    expect(requestByUrl(idx, "http://h/a.js#x")).toEqual({ entry: idx[1] as NetEntry, count: 3 });
    expect(requestByUrl(idx, "http://h/none.js")).toBeNull();
  });
});

describe("net grep (grepBodies)", () => {
  const entry = (n: number, over: Partial<NetEntry> = {}): NetEntry => ({ id: `r-${n}`, tab: "t1", type: "script", method: "GET", url: `http://h/${n}.js`, status: 200, mime: "text/javascript", size: 20, outcome: "finished", blob: `b${n}`, bodyMissing: null, cmd: null, at: 0, ...over });
  const opts = { context: 0, max: 2, pretty: false, scrub: (s: string) => s.replaceAll("hunter2", "<secret:example.password>"), charset: () => null };
  const enc = (s: string) => () => new TextEncoder().encode(s);

  test("per request count and capped matches; 50 requests then more:n", () => {
    const items = Array.from({ length: 53 }, (_, i) => ({ entry: entry(i + 1), bytes: enc("sig sig sig") }));
    const r = grepBodies(items, compileRegex("sig", "net grep", true), opts);
    expect(r.requests).toHaveLength(50);
    expect(r.more).toBe(3);
    expect(r.total).toBe(53 * 3);
    expect(r.requests[0]).toEqual({ id: "r-1", url: "http://h/1.js", resourceType: "script", count: 3, matches: [{ line: 1, col: 1, text: "sig sig sig", before: [], after: [] }, { line: 1, col: 5, text: "sig sig sig", before: [], after: [] }] });
  });

  test("over 8 MB skipped and listed, binary counted, secrets never searchable", () => {
    const items = [
      { entry: entry(1, { size: 9 * 1024 * 1024 }), bytes: () => null },
      { entry: entry(2, { mime: "image/png", type: "image" }), bytes: () => new Uint8Array([0x89, 0x50, 0x00, 0xff]) },
      { entry: entry(3), bytes: enc("pw=hunter2") },
    ];
    const r = grepBodies(items, compileRegex("hunter2", "net grep", true), opts);
    expect(r.skipped).toEqual([{ id: "r-1", url: "http://h/1.js", bytes: 9 * 1024 * 1024, reason: "over 8 MB" }]);
    expect(r.binary).toBe(1);
    expect(r.searched).toBe(1);
    expect(r.requests).toEqual([]);
    const ph = grepBodies(items.slice(2), compileRegex("secret:example", "net grep", true), opts);
    expect(ph.requests[0]?.matches[0]?.text).toBe("pw=<secret:example.password>");
  });

  test("--pretty applies to JS / JSON bodies only", () => {
    const items = [
      { entry: entry(1), bytes: enc("a();b();sig()") },
      { entry: entry(2, { mime: "text/html", type: "document" }), bytes: enc("a();b();sig()") },
    ];
    const r = grepBodies(items, compileRegex("sig", "net grep", true), { ...opts, pretty: true });
    expect(r.requests.map((x) => x.matches[0]?.line)).toEqual([3, 1]);
  });
});

describe("html fields (html.ts)", () => {
  const scrub = (s: string) => s.replaceAll("hunter2", "<secret:example.password>");

  test("outer / inner / text: cut after scrubbing, total length and truncated said", () => {
    const v = { tag: "div", total: 30, value: '<div data-pw="hunter2">x</div>' };
    expect(htmlFields(v, "outer", 4000, scrub)).toEqual({ tag: "div", mode: "outer", chars: 30, truncated: false, html: '<div data-pw="<secret:example.password>">x</div>' });
    const cut = htmlFields(v, "inner", 20, scrub);
    expect(cut).toMatchObject({ mode: "inner", truncated: true, html: '<div data-pw="<secre' });
    expect(String(cut["note"])).toContain("cut at 20 of 30 chars");
    expect(htmlFields({ tag: "p", total: 5, value: "hello" }, "text", 4000, scrub)).toEqual({ tag: "p", mode: "text", chars: 5, truncated: false, text: "hello" });
  });

  test("attrs: an object, values cut at --max-chars, untrusted shapes tolerated", () => {
    expect(htmlFields({ tag: "a", attrs: { href: "/x", title: "hunter2 and more" }, count: 2 }, "attrs", 10, scrub)).toMatchObject({ tag: "a", mode: "attrs", count: 2, truncated: true, attrs: { href: "/x", title: "<secret:ex" } });
    expect(htmlFields(null, "attrs", 10, scrub)).toEqual({ tag: "?", mode: "attrs", count: 0, truncated: false, attrs: {} });
    expect(htmlFields("junk", "outer", 10, scrub)).toEqual({ tag: "?", mode: "outer", chars: 0, truncated: false, html: "" });
  });
});
