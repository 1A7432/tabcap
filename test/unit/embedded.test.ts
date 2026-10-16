// Embedded-state decoders (src/analyze/embedded.ts) and their place in the
// analyze decode chain (find / where / deps). Oracle: the HTML and bytes are
// written here by hand; every expected address, path, value and string below
// is read off that input with the node grammar of docs/05 s04 / s41
// (`script[<n>].$…`, `assign[<name>]…`, `viewstate[<name>]…`), not produced by
// the code under test. sha256 values are computed with node:crypto over the
// hand-written bytes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MAX_ASSIGNMENTS, MAX_LITERAL_BYTES, MAX_SCRIPT_JSON_BYTES, MAX_VIEWSTATE_BYTES, extractEmbedded, parseTolerant, printableRuns, type EmbeddedNode } from "../../src/analyze/embedded.ts";
import { STEP_NAMES } from "../../src/analyze/decoders.ts";
import { find, renderFindText } from "../../src/analyze/find.ts";
import { where } from "../../src/analyze/where.ts";
import { deps } from "../../src/analyze/deps.ts";
import { buildBundle, idOf, tmp } from "./_analyze.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
/** Nodes without the source text and span (asserted separately). */
const brief = (nodes: EmbeddedNode[]) => nodes.map(({ text: _t, span: _s, ...n }) => n);

describe("step names", () => {
  test("the three embedded steps are decode-chain steps, the page step last (docs/05 s04, docs/04 §33)", () => {
    expect(STEP_NAMES.slice(-4)).toEqual(["script-json", "inline-assign", "viewstate", "page"]);
  });
});

describe("script-json", () => {
  const PAGE = `<!doctype html><title>t</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"rows":[{"amount":1.5}]}}}</script>
<!-- <script type="application/json">{"commented":1}</script> -->
<script type="text/template">{"template":1}</script>
<script type="application/ld+json">{"@graph":[{"@type":"Product","sku":"x-1"}]}</script>
<SCRIPT TYPE="application/json; charset=utf-8">{"a":</SCRIPT>
<script type='application/json' id=cfg>[1, 2]</script>`;

  test("JSON scripts in document order, addressed among themselves; id / type recorded; others ignored", () => {
    const d = extractEmbedded(PAGE);
    expect(brief(d.nodes)).toEqual([
      { step: "script-json", address: "script[0]", root: "script[0].$", id: "__NEXT_DATA__", type: "application/json", value: { props: { pageProps: { rows: [{ amount: 1.5 }] } } } },
      { step: "script-json", address: "script[1]", root: "script[1].$", type: "application/ld+json", value: { "@graph": [{ "@type": "Product", sku: "x-1" }] } },
      { step: "script-json", address: "script[3]", root: "script[3].$", id: "cfg", type: "application/json", value: [1, 2] },
    ]);
    expect(d.notes).toEqual([{ step: "script-json", address: "script[2]", status: "unparsed", detail: 'not JSON: "{\\"a\\":"', type: "application/json; charset=utf-8" }]);
  });

  test("the node claims exactly the script body", () => {
    const d = extractEmbedded(PAGE);
    const n = d.nodes[2];
    expect(n === undefined ? null : PAGE.slice(n.span[0], n.span[1])).toBe("[1, 2]");
  });

  test(`over ${MAX_SCRIPT_JSON_BYTES} bytes: truncated note, no node; the bound itself is decoded`, () => {
    const body = (n: number) => `{"p":"${"x".repeat(n - 8)}"}`; // n bytes
    const over = extractEmbedded(`<script type="application/json">${body(MAX_SCRIPT_JSON_BYTES + 1)}</script>`);
    expect(over.nodes).toEqual([]);
    expect(over.notes).toEqual([{ step: "script-json", address: "script[0]", status: "truncated", detail: `${MAX_SCRIPT_JSON_BYTES + 1} bytes, over the ${MAX_SCRIPT_JSON_BYTES} byte bound; not decoded`, type: "application/json" }]);
    const at = extractEmbedded(`<script type="application/json">${body(MAX_SCRIPT_JSON_BYTES)}</script>`);
    expect(at.nodes.map((n) => n.address)).toEqual(["script[0]"]);
  });

  test("an unclosed script runs to the end of the document", () => {
    expect(brief(extractEmbedded(`<script type="application/json">{"a":1}`).nodes)).toEqual([{ step: "script-json", address: "script[0]", root: "script[0].$", type: "application/json", value: { a: 1 } }]);
  });
});

describe("inline-assign", () => {
  const SCRIPT = `<script>
window.__STATE__ = {user:{id:1,name:'a\\'b'},list:[1,2,],flag:undefined,};
var conf = [ {"k": "v"} ];
let t = {a: 1}
const q = {b: 2};
window.notLiteral = JSON.parse("{\\"x\\":1}");
window.expr = {a: 1}.a;
var tpl = \`{"a":1}\`;
function f() { window.__INNER__ = {c: 3}; }
(function () { var hidden = {d: 4}; })();
var re = /[{]/g; window.after = {e: 5};
const s = "window.__FAKE__ = {f: 6};";
// window.__COMMENT__ = {g: 7};
/* window.__BLOCK__ = {h: 8}; */
window.bad = {a: function () {}};
</script>
<script src="/app.js">window.__SRC__ = {i: 9};</script>
<script type="text/x-template">window.__TPL__ = {j: 10};</script>
<script type="module">window.__MOD__ = ['m',];</script>`;

  test("top-level window.X / var / let / const literals only; tolerant superset; expressions, calls, templates, nested scopes, strings, comments, src and non-JS scripts are not decoded", () => {
    const d = extractEmbedded(SCRIPT);
    expect(brief(d.nodes)).toEqual([
      { step: "inline-assign", address: "assign[__STATE__]", root: "assign[__STATE__]", value: { user: { id: 1, name: "a'b" }, list: [1, 2], flag: null } },
      { step: "inline-assign", address: "assign[conf]", root: "assign[conf]", value: [{ k: "v" }] },
      { step: "inline-assign", address: "assign[t]", root: "assign[t]", value: { a: 1 } },
      { step: "inline-assign", address: "assign[q]", root: "assign[q]", value: { b: 2 } },
      { step: "inline-assign", address: "assign[after]", root: "assign[after]", value: { e: 5 } },
      { step: "inline-assign", address: "assign[__MOD__]", root: "assign[__MOD__]", value: ["m"] },
    ]);
    expect(d.notes).toEqual([{ step: "inline-assign", address: "assign[bad]", status: "unparsed", detail: 'not a JSON literal: "{a: function () {}}"' }]);
  });

  test("the node claims exactly the literal", () => {
    const d = extractEmbedded(SCRIPT);
    const n = d.nodes[3];
    expect(n === undefined ? null : SCRIPT.slice(n.span[0], n.span[1])).toBe("{b: 2}");
  });

  test("an unparsed literal is quoted to its first 80 characters", () => {
    const lit = `{k: [${"x,".repeat(100)}]}`;
    const d = extractEmbedded(`<script>window.big = ${lit};</script>`);
    expect(d.nodes).toEqual([]);
    expect(d.notes).toEqual([{ step: "inline-assign", address: "assign[big]", status: "unparsed", detail: `not a JSON literal: ${JSON.stringify(`{k: [${"x,".repeat(37)}x`)}` }]);
  });

  test(`at most ${MAX_ASSIGNMENTS} assignments per document`, () => {
    const lines = Array.from({ length: 70 }, (_, i) => `window.v${i} = [${i}];`);
    const d = extractEmbedded(`<script>${lines.slice(0, 40).join("\n")}</script><script>${lines.slice(40).join("\n")}</script>`);
    expect(d.nodes.map((n) => n.address)).toEqual(Array.from({ length: 64 }, (_, i) => `assign[v${i}]`));
    expect(d.notes).toEqual([{ step: "inline-assign", address: "assign[v64]", status: "truncated", detail: "more than 64 assignments in the document; this and later ones are not decoded" }]);
  });

  test(`a literal over ${MAX_LITERAL_BYTES} bytes is truncated; scanning goes on after it`, () => {
    const d = extractEmbedded(`<script>window.huge = {"p":"${"y".repeat(MAX_LITERAL_BYTES)}"};\nwindow.small = [1];</script>`);
    expect(brief(d.nodes)).toEqual([{ step: "inline-assign", address: "assign[small]", root: "assign[small]", value: [1] }]);
    expect(d.notes).toEqual([{ step: "inline-assign", address: "assign[huge]", status: "truncated", detail: `literal over the ${MAX_LITERAL_BYTES} byte bound; not decoded` }]);
  });

  test("unbalanced and deeply nested literals are notes, never exceptions", () => {
    const open = extractEmbedded(`<script>window.x = {a: 'unterminated`);
    expect(open.nodes).toEqual([]);
    expect(open.notes.map((n) => [n.address, n.status])).toEqual([["assign[x]", "unparsed"]]);
    // JSON.parse rejects the trailing comma; the tolerant parser stops at its nesting bound
    const deep = extractEmbedded(`<script>window.deep = ${"[".repeat(100_000)}1,${"]".repeat(100_000)};</script>`);
    expect(deep.nodes).toEqual([]);
    expect(deep.notes.map((n) => [n.address, n.status])).toEqual([["assign[deep]", "unparsed"]]);
  });
});

describe("tolerant JSON", () => {
  test("JSON plus identifier keys, single quotes, trailing commas, undefined", () => {
    expect(parseTolerant(`{a:1,'b':'x\\ny',"c":[true,false,null,undefined,],$d_1:{},}`)).toEqual({ value: { a: 1, b: "x\ny", c: [true, false, null, null], $d_1: {} } });
    expect(parseTolerant(`{"__proto__":{"polluted":1}}`)?.value).toEqual(JSON.parse(`{"__proto__":{"polluted":1}}`));
    expect(parseTolerant(`{__proto__: 1}`)?.value).toEqual(JSON.parse(`{"__proto__":1}`));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("anything else is rejected", () => {
    for (const bad of ["{a: f()}", "{a: 1 + 2}", "{a: NaN}", "{1: 'x'}", "[1,,2]", "{a: `t`}", "{a: 'x\ny'}", "{a: 01}", "[1] [2]", "{a: /re/}", "{a: .5}", ""]) {
      expect({ bad, r: parseTolerant(bad) }).toEqual({ bad, r: null });
    }
  });
});

describe("viewstate", () => {
  // made-up header, ASCII "TOKEN-abc1", the same ASCII again (de-duplicated),
  // then "名称:甲乙" in UTF-16LE written unit by unit:
  // 名 U+540D 0d 54, 称 U+79F0 f0 79, : 3a 00, 甲 U+7532 32 75, 乙 U+4E59 59 4e
  const BYTES = Uint8Array.from([0xff, 0x01, 0x0a, ...ascii("TOKEN-abc1"), 0x00, 0x0a, ...ascii("TOKEN-abc1"), 0x05, 0x0d, 0x54, 0xf0, 0x79, 0x3a, 0x00, 0x32, 0x75, 0x59, 0x4e, 0x00, 0x00]);
  const VS = b64(BYTES);

  test("hidden fields: the value as sent, its bytes (length, sha256) and printable runs in order", () => {
    const html = `<form><input type="hidden" name="__VIEWSTATE" value="${VS.replace(/\//g, "&#x2F;")}">
<input type=text name=__VIEWSTATE value="${VS}">
<input type=HIDDEN name=__EVENTVALIDATION value='${b64(Uint8Array.from([0xff, 0x14, ...ascii("event-ok")]))}'>
<input type="hidden" name="javax.faces.ViewState" value="-4417:-9921">
<input type="hidden" name="__OTHER" value="${VS}"></form>`;
    const d = extractEmbedded(html);
    expect(brief(d.nodes)).toEqual([
      // "2uYN": the UTF-16LE bytes of 甲乙 (32 75 59 4e) are also a run of 4 printable ASCII bytes
      { step: "viewstate", address: "viewstate[__VIEWSTATE]", root: "viewstate[__VIEWSTATE]", raw: VS, value: { bytes: { length: BYTES.length, sha256: sha(BYTES) }, strings: ["TOKEN-abc1", "名称:甲乙", "2uYN"] } },
      {
        step: "viewstate",
        address: "viewstate[__EVENTVALIDATION]",
        root: "viewstate[__EVENTVALIDATION]",
        raw: b64(Uint8Array.from([0xff, 0x14, ...ascii("event-ok")])),
        value: { bytes: { length: 10, sha256: sha(Uint8Array.from([0xff, 0x14, ...ascii("event-ok")])) }, strings: ["event-ok"] },
      },
      { step: "viewstate", address: "viewstate[javax.faces.ViewState]", root: "viewstate[javax.faces.ViewState]", raw: "-4417:-9921" },
    ]);
    expect(d.notes).toEqual([{ step: "viewstate", address: "viewstate[javax.faces.ViewState]", status: "unparsed", detail: 'not base64: "-4417:-9921"' }]);
  });

  test(`over ${MAX_VIEWSTATE_BYTES} bytes: only the value as sent, with a truncated note`, () => {
    const big = "QUJD".repeat(MAX_VIEWSTATE_BYTES / 3 + 1); // 3 bytes per 4 chars
    const d = extractEmbedded(`<input type=hidden name=__VIEWSTATE value="${big}">`);
    expect(brief(d.nodes)).toEqual([{ step: "viewstate", address: "viewstate[__VIEWSTATE]", root: "viewstate[__VIEWSTATE]", raw: big }]);
    expect(d.notes.map((n) => [n.address, n.status])).toEqual([["viewstate[__VIEWSTATE]", "truncated"]]);
  });

  test("printable runs: ASCII >= 4, UTF-16LE >= 4 at either alignment; ASCII is not re-read as UTF-16", () => {
    // "Ωmega" in UTF-16LE (Ω U+03A9 a9 03), then "Hello" in UTF-16LE at an odd offset
    const b = Uint8Array.from([0x00, ...ascii("abcd"), 0x00, ...ascii("abc"), 0x01, 0xa9, 0x03, 0x6d, 0x00, 0x65, 0x00, 0x67, 0x00, 0x61, 0x00, 0x01, 0x48, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f, 0x00, 0x02]);
    expect(printableRuns(b)).toEqual({ strings: ["abcd", "Ωmega", "Hello"], truncated: false });
    expect(printableRuns(new Uint8Array())).toEqual({ strings: [], truncated: false });
    expect(printableRuns(Uint8Array.from(ascii("VIEWSTATE-TOKEN-7f3a9c")))).toEqual({ strings: ["VIEWSTATE-TOKEN-7f3a9c"], truncated: false });
  });
});

describe("untrusted input never throws", () => {
  test("random markup and script fragments", () => {
    let seed = 0x41;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const parts = ["<script>", "</script>", '<script type="application/json">', "<input type=hidden name=__VIEWSTATE value=", "window.a = ", "var b = ", "{", "}", "[", "]", "'", '"', "`", "${", "/", "/*", "*/", "//", "\n", ",", ":", "x", "1", "\\", "<!--", "-->", "=", ";", "(", ")", "条"];
    for (let k = 0; k < 300; k++) {
      let s = "";
      for (let i = 0; i < 400; i++) s += parts[rnd() % parts.length] ?? "";
      expect(() => extractEmbedded(s)).not.toThrow();
      expect(() => parseTolerant(s)).not.toThrow();
    }
  });
});

// ------------------------------------------------------------ through the decode chain

const ORIGIN = "http://127.0.0.1:4310";
const VS_BYTES = Uint8Array.from([0xff, 0x01, 0x16, ...ascii("VS-TOKEN-0011aa"), 0x05, 0x75, 0x00, 0x73, 0x00, 0x65, 0x00, 0x72, 0x00, 0x3a, 0x00, 0x61, 0x67, 0xee, 0x76, 0x32, 0x75, 0x00, 0x00]); // "user:条目甲" UTF-16LE as in site.ts
const VS = b64(VS_BYTES);
const DOC = `<!doctype html><meta charset=utf-8><title>doc</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{"rows":[{"amount":1234.56,"name":"\\u6761\\u76ee\\u7532"}],"payload":"{\\"deep\\":\\"inner-7788\\"}"}}</script>
<script type="application/json">{"broken":</script>
<script>window.__STATE__ = {rows:[{amount:1234.56}],};</script>
<form><input type="hidden" name="__VIEWSTATE" value="${VS}">
<table><tr><td>1234.56</td><td>条目甲</td></tr></table></form>`;

let root = "";
let bundle = "";
const id = { doc: "", post: "" };

beforeAll(async () => {
  root = tmp("tabcap-embedded-");
  bundle = await buildBundle(join(root, "b"), { name: "example", created: 1_790_100_000_000, seed: 43 }, async (b) => {
    id.doc = idOf(await b.request({ url: `${ORIGIN}/s41`, type: "document", mime: "text/html; charset=utf-8", body: DOC, ts: 1_790_100_000_100 }));
    id.post = idOf(
      await b.request({
        url: `${ORIGIN}/api/s41/submit`,
        method: "POST",
        type: "fetch",
        mime: "application/json",
        body: `{"ok":true}`,
        reqHeaders: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        postData: new URLSearchParams({ __VIEWSTATE: VS, token: "VS-TOKEN-0011aa" }).toString(),
        ts: 1_790_100_000_900,
      }),
    );
  });
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

const hitsOf = (text: string) => find(bundle, text).hits.map((h) => ({ ref: h.ref, part: h.part, decode: h.decode, path: h.path, innerPath: h.innerPath, node: h.node ?? null }));

describe("find through embedded state", () => {
  test("a value in script JSON, an inline literal and a table cell: one hit per place, decoded ones addressed", () => {
    expect(hitsOf("1234.56")).toEqual([
      { ref: id.doc, part: "response", decode: ["script-json"], path: "script[0].$.props.rows[0].amount", innerPath: null, node: { step: "script-json", address: "script[0]", id: "__NEXT_DATA__", type: "application/json" } },
      { ref: id.doc, part: "response", decode: ["inline-assign"], path: "assign[__STATE__].rows[0].amount", innerPath: null, node: { step: "inline-assign", address: "assign[__STATE__]" } },
      { ref: id.doc, part: "response", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test("escaped text in script JSON gets json-unescape; viewstate strings; the cell", () => {
    expect(hitsOf("条目甲")).toEqual([
      { ref: id.doc, part: "response", decode: ["script-json", "json-unescape"], path: "script[0].$.props.rows[0].name", innerPath: null, node: { step: "script-json", address: "script[0]", id: "__NEXT_DATA__", type: "application/json" } },
      { ref: id.doc, part: "response", decode: ["viewstate"], path: "viewstate[__VIEWSTATE].strings[1]", innerPath: null, node: { step: "viewstate", address: "viewstate[__VIEWSTATE]" } },
      { ref: id.doc, part: "response", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test("nested JSON string inside script JSON continues the chain", () => {
    expect(hitsOf("inner-7788")).toEqual([
      { ref: id.doc, part: "response", decode: ["script-json", "json-string", "json"], path: "script[0].$.props.payload", innerPath: "$.deep", node: { step: "script-json", address: "script[0]", id: "__NEXT_DATA__", type: "application/json" } },
    ]);
  });

  test("the viewstate token: the blob's string and the literal request body", () => {
    expect(hitsOf("VS-TOKEN-0011aa")).toEqual([
      { ref: id.doc, part: "response", decode: ["viewstate"], path: "viewstate[__VIEWSTATE].strings[0]", innerPath: null, node: { step: "viewstate", address: "viewstate[__VIEWSTATE]" } },
      { ref: id.post, part: "request-body", decode: [], path: null, innerPath: null, node: null },
    ]);
  });

  test("decoder stats and nodes that were not decoded", () => {
    const r = find(bundle, "1234.56");
    expect(r.searched.decoders).toMatchObject({ "script-json": 1, "inline-assign": 1, viewstate: 1 });
    expect(r.searched.embedded).toEqual([{ ref: id.doc, part: "response", step: "script-json", address: "script[1]", status: "unparsed", detail: 'not JSON: "{\\"broken\\":"', type: "application/json", decode: [] }]);
    const text = renderFindText(r);
    expect(text).toContain("decode [script-json] exact  script[0].$.props.rows[0].amount  (script[0] #__NEXT_DATA__ application/json)");
    expect(text).toContain(" script-json=1 inline-assign=1 viewstate=1");
    expect(text).toContain(`not decoded: ${id.doc} script[1] unparsed: not JSON: "{\\"broken\\":"`);
  });
});

describe("where and deps through embedded state", () => {
  test("where: the decoded candidates come before the page's own cell", () => {
    const r = where(bundle, { input: "1234.56", kind: "text", text: "1234.56" });
    expect(r.candidates).toEqual([
      { request: id.doc, path: "script[0].$.props.rows[0].amount", chain: ["script-json"], match: "exact", score: 1 },
      { request: id.doc, path: "assign[__STATE__].rows[0].amount", chain: ["inline-assign"], match: "exact", score: 1 },
      { request: id.doc, selector: "form > table > tr > td:nth-of-type(1)", chain: [], match: "exact", score: 1 },
    ]);
  });

  test("deps: __VIEWSTATE comes from the document's field, the token from a string inside it", () => {
    const r = deps(bundle);
    const post = r.requests.find((q) => q.id === id.post);
    const primary = (name: string) => post?.inputs.find((i) => i.location === "body" && i.name === name)?.primary ?? null;
    expect(primary("__VIEWSTATE")).toEqual({ kind: "response", request: id.doc, path: "viewstate[__VIEWSTATE]", decode: ["viewstate"], match: "exact" });
    expect(primary("token")).toEqual({ kind: "response", request: id.doc, path: "viewstate[__VIEWSTATE].strings[0]", decode: ["viewstate"], match: "exact" });
  });
});
