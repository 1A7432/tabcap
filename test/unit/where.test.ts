// tabcap where, the pure part (src/analyze/where.ts, htmltext.ts). Oracle:
// synthetic bundles whose values are planted by construction (s40-like
// /api/rows and its server-rendered page, a base64 field, an escaped JSON
// string, a GBK HTML page whose bytes are written by hand from the GBK table:
// 合 = ba cf, 计 = bc c6, １ = a3 b1 …), and the 0.4-C ranking rules.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { htmlTextNodes } from "../../src/analyze/htmltext.ts";
import { renderWhereText, where, whereFindings, whereIn, whereResultOf, type WhereQuery } from "../../src/analyze/where.ts";
import { appendFindings } from "../../src/analyze/finding.ts";
import { b64, buildBundle, idOf, tmp } from "./_analyze.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const ROWS = `[{"id":4101,"amount":1234.56,"qty":1234,"date":"2026-09-15","code":"100101","dir":1},{"id":4102,"amount":-123456.00,"qty":48,"date":"2026-03-04","code":"200202","dir":-1}]`;
const PAGE = `<!doctype html><meta charset=utf-8><title>rows</title>
<table><tbody>
<tr><td>1.234,56</td><td>1.234</td><td>15/09/2026</td><td>1001.01</td><td>DR</td></tr>
<tr><td>-123.456,00</td><td>48</td><td>04/03/2026</td><td>2002.02</td><td>CR</td></tr>
</tbody></table>`;
/** GBK bytes of `<table><tr><td>合计</td><td>１２３４</td></tr></table>`. */
const GBK_TABLE = new Uint8Array([
  ...new TextEncoder().encode("<table><tr><td>"),
  0xba, 0xcf, 0xbc, 0xc6,
  ...new TextEncoder().encode("</td><td>"),
  0xa3, 0xb1, 0xa3, 0xb2, 0xa3, 0xb3, 0xa3, 0xb4,
  ...new TextEncoder().encode("</td></tr></table>"),
]);

let root = "";
let rows = "";
let gbk = "";
const id = { page: "", rows1: "", b64: "", esc: "", rows2: "", gbk: "", unknown: "" };

const text = (t: string): WhereQuery => ({ input: t, kind: "text", text: t });

beforeAll(async () => {
  root = tmp("tabcap-where-");
  rows = await buildBundle(join(root, "rows"), { name: "example", created: 1_790_000_000_000, seed: 40 }, async (b) => {
    id.page = idOf(await b.request({ url: "http://127.0.0.1:4310/s40?locale=de-DE", type: "document", mime: "text/html; charset=utf-8", body: PAGE, ts: 1_790_000_000_100 }));
    id.rows1 = idOf(await b.request({ url: "http://127.0.0.1:4310/api/rows", type: "fetch", mime: "application/json", body: ROWS, ts: 1_790_000_000_200 }));
    id.b64 = idOf(await b.request({ url: "http://127.0.0.1:4310/api/packed", type: "fetch", mime: "application/json", body: JSON.stringify({ data: b64(`{"total":"98765.43"}`) }), ts: 1_790_000_000_300 }));
    id.esc = idOf(await b.request({ url: "http://127.0.0.1:4310/api/label", type: "fetch", mime: "application/json", body: `{"label":"\\u20ac5 off"}`, ts: 1_790_000_000_400 }));
    id.rows2 = idOf(await b.request({ url: "http://127.0.0.1:4310/api/rows", type: "fetch", mime: "application/json", body: ROWS, ts: 1_790_000_000_500 }));
  });
  gbk = await buildBundle(join(root, "gbk"), { name: "example", created: 1_790_000_100_000, seed: 41 }, async (b) => {
    id.gbk = idOf(await b.request({ url: "http://127.0.0.1:4310/report", type: "document", mime: "text/html; charset=gbk", body: GBK_TABLE, ts: 1_790_000_100_100 }));
    id.unknown = idOf(await b.request({ url: "http://127.0.0.1:4310/legacy", type: "document", mime: "text/html; charset=x-tabcap-unknown", body: GBK_TABLE, ts: 1_790_000_100_200 }));
  });
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

describe("where: candidates", () => {
  test("normalized: a de-DE amount finds /api/rows $[0].amount first; the earlier copy wins the tie; the page's own cell comes after", () => {
    const r = where(rows, text("1.234,56"));
    expect(r.schema).toBe("tabcap-where/0");
    expect(r.query).toEqual({ input: "1.234,56", kind: "text", text: "1.234,56" });
    expect(r.normalized).toEqual([{ value: "1234.56", rules: ["thousands-sep", "decimal-comma"] }]);
    expect(r.candidates).toEqual([
      { request: id.rows1, path: "$[0].amount", chain: [], match: "normalized", rules: ["thousands-sep", "decimal-comma"], score: 0.333 },
      { request: id.rows2, path: "$[0].amount", chain: [], match: "normalized", rules: ["thousands-sep", "decimal-comma"], score: 0.333 },
      { request: id.page, selector: "table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)", chain: [], match: "exact", score: 1 },
    ]);
    expect(r.reason).toBeUndefined();
    expect(r.ambiguous).toBeUndefined();
  });

  test("exact: equal after trim scores 1 and lists no rules", () => {
    const r = where(rows, text(" 48 "), { top: 1 });
    expect(r.candidates).toEqual([{ request: id.rows1, path: "$[1].qty", chain: [], match: "exact", score: 1 }]);
  });

  test("every s40 column of the page maps to its /api/rows field", () => {
    const first = (q: string) => where(rows, text(q), { top: 1 }).candidates[0];
    expect(first("-123.456,00")).toMatchObject({ request: id.rows1, path: "$[1].amount", rules: ["thousands-sep", "decimal-comma", "trailing-zeros"], score: 0.25 });
    expect(first("1.234")).toMatchObject({ request: id.rows1, path: "$[0].qty", rules: ["thousands-sep"], score: 0.5 });
    expect(first("1001.01")).toMatchObject({ request: id.rows1, path: "$[0].code", rules: ["dotted-code"], score: 0.5 });
    expect(first("CR")).toMatchObject({ request: id.rows1, path: "$[1].dir", rules: ["dr-cr"], score: 0.5 });
    expect(first("2026-09")).toMatchObject({ request: id.rows1, path: "$[0].date", rules: ["date-yyyymm"], score: 0.5 });
    expect(first("202603")).toMatchObject({ request: id.rows1, path: "$[1].date", rules: ["date-yyyymm"], score: 0.5 });
  });

  test("the decode chain is analyze find's: base64 field, then the inner JSON path", () => {
    const r = where(rows, text("98,765.43"), { top: 1 });
    expect(r.candidates).toEqual([{ request: id.b64, path: "$.data -> $.total", chain: ["base64", "json"], match: "normalized", rules: ["thousands-sep"], score: 0.5 }]);
  });

  test("json-unescape is judged per leaf: an escaped string leaf gets the step, plain leaves do not", () => {
    const r = where(rows, text("€5 off"), { top: 1 });
    expect(r.candidates).toEqual([{ request: id.esc, path: "$.label", chain: ["json-unescape"], match: "exact", score: 1 }]);
  });

  test("--top bounds the list", () => {
    expect(where(rows, text("1.234,56"), { top: 2 }).candidates.length).toBe(2);
    expect(() => where(rows, text("1"), { top: 0 })).toThrow("--top");
  });

  test("no match: empty candidates with reason no-match", () => {
    const r = where(rows, text("not on any page"));
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe("no-match");
  });
});

describe("where: ambiguity and too-common", () => {
  test("DD/MM vs MM/DD without a page: no candidates, both readings listed, reason ambiguous-date", () => {
    const r = where(rows, text("04/03/2026"));
    expect(r.candidates).toEqual([]);
    expect(r.normalized).toEqual([]);
    expect(r.reason).toBe("ambiguous-date");
    expect(r.ambiguous).toEqual([
      { value: "2026-03-04", rules: ["date-yyyymm"], reason: "DD/MM/YYYY reading; text input: no page to disambiguate" },
      { value: "2026-04-03", rules: ["date-yyyymm"], reason: "MM/DD/YYYY reading; text input: no page to disambiguate" },
    ]);
  });

  test("a page whose dates prove nothing keeps the cell ambiguous", () => {
    const r = whereIn(BundleReader.open(rows), { input: "e7", kind: "ref", ref: "e7", text: "04/03/2026" }, { pageText: "04/03/2026 05/06/2026" });
    expect(r.reason).toBe("ambiguous-date");
    expect(r.ambiguous?.map((a) => a.reason)).toEqual(["DD/MM/YYYY reading; no date on the page has a day over 12", "MM/DD/YYYY reading; no date on the page has a day over 12"]);
  });

  test("another date on the page with a day > 12 picks the reading: a candidate, no ambiguity", () => {
    const r = whereIn(BundleReader.open(rows), { input: "e7", kind: "ref", ref: "e7", text: "04/03/2026" }, { pageText: "15/09/2026\n04/03/2026", top: 1 });
    expect(r.normalized).toEqual([{ value: "2026-03-04", rules: ["date-yyyymm"] }]);
    expect(r.ambiguous).toBeUndefined();
    expect(r.candidates).toEqual([{ request: id.rows1, path: "$[1].date", chain: [], match: "normalized", rules: ["date-yyyymm"], score: 0.5 }]);
  });

  test("a query that normalises only to the empty-zero-null class: no candidates, reason too-common", () => {
    for (const q of ["—", "-", "0", "null", "0.00"]) {
      const r = where(rows, text(q));
      expect(r.candidates).toEqual([]);
      expect(r.reason).toBe("too-common");
    }
  });
});

describe("where: charsets", () => {
  test("GBK bodies decode through TextDecoder: exact Chinese text and a full-width number, with selectors", () => {
    const r = where(gbk, text("合计"));
    expect(r.candidates).toEqual([
      { request: id.gbk, selector: "table > tr > td:nth-of-type(1)", chain: [], match: "exact", score: 1 },
    ]);
    const n = where(gbk, text("1,234"), { top: 1 });
    expect(n.candidates).toEqual([{ request: id.gbk, selector: "table > tr > td:nth-of-type(2)", chain: [], match: "normalized", rules: ["fullwidth", "thousands-sep"], score: 0.333 }]);
  });

  test("a charset TextDecoder does not know: candidate-less reason unsupported-charset", () => {
    const r = where(gbk, text("not there"));
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe("unsupported-charset");
  });
});

describe("where: html text nodes", () => {
  test("selectors: tag path, nth-of-type only among same-tag siblings; script / style / comments are not text; entities flagged", () => {
    const nodes = htmlTextNodes(`<body><p>a &amp; b</p><p>c<!-- x --></p><script>var s = "<td>no</td>";</script><style>p{}</style><ul><li>one<li>two</ul><br>tail</body>`);
    expect(nodes).toEqual([
      { text: "a & b", entities: true, selector: "body > p:nth-of-type(1)" },
      { text: "c", entities: false, selector: "body > p:nth-of-type(2)" },
      { text: "one", entities: false, selector: "body > ul > li:nth-of-type(1)" },
      { text: "two", entities: false, selector: "body > ul > li:nth-of-type(2)" },
      { text: "tail", entities: false, selector: "body" },
    ]);
  });

  test("broken markup never throws", () => {
    for (const s of ["<", "<<<td", "</x>", "<td a='>", "<!--", "<script>", "<a b=\"c>d</a>", "&#xffffffff;"]) expect(() => htmlTextNodes(s)).not.toThrow();
  });
});

describe("where: rendering and findings", () => {
  test("--text report and the JSON round trip", () => {
    const r = where(rows, text("1.234,56"), { top: 1 });
    expect(renderWhereText(r)).toBe([`where "1.234,56" (text)`, "normalized: 1234.56 [thousands-sep, decimal-comma]", `1. ${id.rows1} $[0].amount  normalized [thousands-sep, decimal-comma]  score 0.333  chain []`].join("\n"));
    expect(whereResultOf(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(whereResultOf({ schema: "other" })).toBeNull();
  });

  test("findings: one per candidate, 实测 for exact, 推断 for normalized, tool where", () => {
    const f = whereFindings(where(rows, text("1.234,56")));
    expect(f.map((x) => [x.tool, x.grade, x.evidence])).toEqual([
      ["where", "推断", [{ request: id.rows1, path: "$[0].amount" }]],
      ["where", "推断", [{ request: id.rows2, path: "$[0].amount" }]],
      ["where", "实测", [{ request: id.page, path: "table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)" }]],
    ]);
    expect(f[0]?.claim).toBe(`the queried text is carried by ${id.rows1} $[0].amount (normalized: thousands-sep, decimal-comma; score 0.333)`);
  });

  test("findings append to a finished bundle as finding events", () => {
    const saved = appendFindings(rows, whereFindings(where(rows, text("48"), { top: 1 })));
    expect(saved.seqs.length).toBe(1);
    const ev = BundleReader.open(rows).events.find((e) => e.seq === saved.seqs[0]);
    expect(ev).toMatchObject({ kind: "finding", actor: "ai", tool: "where", grade: "实测", evidence: [{ request: id.rows1, path: "$[1].qty" }] });
  });
});
