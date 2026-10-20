// L2 for 0.4-C: `tabcap where` on docs/05 s40 locale-numbers (Chrome for
// Testing, the real daemon). Walk as docs/05 s40: net start → the five
// locales in turn → snapshot → `where <ref>` for every cell; then
// `where "1.234,56"` as text. Oracle: the range site (test/e2e/site.ts
// S40_ROWS / S40_TABLES, written by hand) and the 0.4-C rule list. Every
// expected value below is a literal written here, not computed:
//   - the first candidate of every cell is the first recorded GET /api/rows at
//     the cell's `$[row].field`;
//   - `normalized` and the candidate's rules / score per cell;
//   - DD/MM vs MM/DD: the day <= 12 cell gets its candidate because the page
//     also shows the day > 12 date; as a text query it stays ambiguous.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { S40_LOCALES, startLocaleSite, type S40Locale, type Site } from "./site.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const S = ["--session", "s40"];

let home = "";
let site: Site;
let bundle = "";
/** The first recorded GET /api/rows: every cell's first candidate. */
let rowsId = "";
/** de-DE amount row 0 by ref, compared with the text form. */
let deRefFirst: Record<string, unknown> | null = null;

type Env = { ok: boolean; data: Record<string, unknown>; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

/** The ref of the table cell whose accessible name is `shown` (whitespace, incl. U+00A0 / U+202F, ignored). */
function cellRef(tree: string, shown: string): string {
  const want = shown.replace(/\s/g, "");
  for (const m of tree.matchAll(/- cell "([^"]*)"[^\n]*?\[(e\d+)\]/g)) if ((m[1] ?? "").replace(/\s/g, "") === want && m[2] !== undefined) return m[2];
  throw new Error(`no cell ${JSON.stringify(shown)} in:\n${tree}`);
}

type N = { value: string; rules: string[] };
/** One cell: visible text (innerText), the /api/rows path, `normalized`, and the first candidate's match / rules / score. */
type Cell = { text: string; path: string; normalized: N[]; match: "exact" | "normalized"; rules?: string[]; score: number };

const NBSP = " ";
const NNBSP = " ";

const COMMON: Cell[] = [
  { text: "1001.01", path: "$[0].code", normalized: [{ value: "1001.01", rules: [] }, { value: "100101", rules: ["dotted-code"] }], match: "normalized", rules: ["dotted-code"], score: 0.5 },
  { text: "2002.02", path: "$[1].code", normalized: [{ value: "2002.02", rules: [] }, { value: "200202", rules: ["dotted-code"] }], match: "normalized", rules: ["dotted-code"], score: 0.5 },
  { text: "DR", path: "$[0].dir", normalized: [{ value: "1", rules: ["dr-cr"] }], match: "normalized", rules: ["dr-cr"], score: 0.5 },
  { text: "CR", path: "$[1].dir", normalized: [{ value: "-1", rules: ["dr-cr"] }], match: "normalized", rules: ["dr-cr"], score: 0.5 },
  { text: `${NBSP}${NBSP}１２３４`, path: "$[0].qty", normalized: [{ value: "1234", rules: ["nbsp", "fullwidth"] }], match: "normalized", rules: ["nbsp", "fullwidth"], score: 0.333 },
  { text: `${NBSP}${NBSP}４８`, path: "$[1].qty", normalized: [{ value: "48", rules: ["nbsp", "fullwidth"] }], match: "normalized", rules: ["nbsp", "fullwidth"], score: 0.333 },
];

const AMOUNT_0_COMMA: Cell = { text: "1,234.56", path: "$[0].amount", normalized: [{ value: "1234.56", rules: ["thousands-sep"] }], match: "normalized", rules: ["thousands-sep"], score: 0.5 };
const QTY_0_COMMA: Cell = { text: "1,234", path: "$[0].qty", normalized: [{ value: "1234", rules: ["thousands-sep"] }, { value: "1.234", rules: ["decimal-comma"] }], match: "normalized", rules: ["thousands-sep"], score: 0.5 };
const QTY_1: Cell = { text: "48", path: "$[1].qty", normalized: [{ value: "48", rules: [] }], match: "exact", score: 1 };

const EXPECTED: Record<S40Locale, Cell[]> = {
  "en-US": [
    AMOUNT_0_COMMA,
    { text: "-123,456.00", path: "$[1].amount", normalized: [{ value: "-123456", rules: ["thousands-sep", "trailing-zeros"] }], match: "normalized", rules: ["thousands-sep", "trailing-zeros"], score: 0.333 },
    QTY_0_COMMA,
    QTY_1,
    { text: "09/15/2026", path: "$[0].date", normalized: [{ value: "2026-09-15", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    // MM/DD: 09/15/2026 on the same page proves the order
    { text: "03/04/2026", path: "$[1].date", normalized: [{ value: "2026-03-04", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    ...COMMON,
  ],
  "de-DE": [
    { text: "1.234,56", path: "$[0].amount", normalized: [{ value: "1234.56", rules: ["thousands-sep", "decimal-comma"] }], match: "normalized", rules: ["thousands-sep", "decimal-comma"], score: 0.333 },
    { text: "-123.456,00", path: "$[1].amount", normalized: [{ value: "-123456", rules: ["thousands-sep", "decimal-comma", "trailing-zeros"] }], match: "normalized", rules: ["thousands-sep", "decimal-comma", "trailing-zeros"], score: 0.25 },
    { text: "1.234", path: "$[0].qty", normalized: [{ value: "1.234", rules: [] }, { value: "1234", rules: ["thousands-sep"] }], match: "normalized", rules: ["thousands-sep"], score: 0.5 },
    QTY_1,
    { text: "2026-09", path: "$[0].date", normalized: [{ value: "2026-09", rules: [] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    { text: "2026-03", path: "$[1].date", normalized: [{ value: "2026-03", rules: [] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    ...COMMON,
  ],
  "fr-FR": [
    { text: `1${NNBSP}234,56`, path: "$[0].amount", normalized: [{ value: "1234.56", rules: ["nbsp", "thousands-sep", "decimal-comma"] }], match: "normalized", rules: ["nbsp", "thousands-sep", "decimal-comma"], score: 0.25 },
    {
      text: `-123${NNBSP}456,00`,
      path: "$[1].amount",
      normalized: [{ value: "-123456", rules: ["nbsp", "thousands-sep", "decimal-comma", "trailing-zeros"] }],
      match: "normalized",
      rules: ["nbsp", "thousands-sep", "decimal-comma", "trailing-zeros"],
      score: 0.2,
    },
    { text: `1${NNBSP}234`, path: "$[0].qty", normalized: [{ value: "1234", rules: ["nbsp", "thousands-sep"] }], match: "normalized", rules: ["nbsp", "thousands-sep"], score: 0.333 },
    QTY_1,
    { text: "15/09/2026", path: "$[0].date", normalized: [{ value: "2026-09-15", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    // DD/MM: 15/09/2026 on the same page proves the order
    { text: "04/03/2026", path: "$[1].date", normalized: [{ value: "2026-03-04", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    ...COMMON,
  ],
  "en-IN": [
    AMOUNT_0_COMMA,
    { text: "-1,23,456.00", path: "$[1].amount", normalized: [{ value: "-123456", rules: ["thousands-sep", "trailing-zeros"] }], match: "normalized", rules: ["thousands-sep", "trailing-zeros"], score: 0.333 },
    QTY_0_COMMA,
    QTY_1,
    { text: "202609", path: "$[0].date", normalized: [{ value: "202609", rules: [] }, { value: "2026-09", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    { text: "202603", path: "$[1].date", normalized: [{ value: "202603", rules: [] }, { value: "2026-03", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    ...COMMON,
  ],
  accounting: [
    AMOUNT_0_COMMA,
    {
      text: "(123,456.00)",
      path: "$[1].amount",
      normalized: [{ value: "-123456", rules: ["thousands-sep", "accounting-negative", "trailing-zeros"] }],
      match: "normalized",
      rules: ["thousands-sep", "accounting-negative", "trailing-zeros"],
      score: 0.25,
    },
    { text: "1234.56", path: "$[0].amount", normalized: [{ value: "1234.56", rules: [] }, { value: "123456", rules: ["dotted-code"] }], match: "exact", score: 1 },
    { text: "123456.00-", path: "$[1].amount", normalized: [{ value: "-123456", rules: ["trailing-minus", "trailing-zeros"] }], match: "normalized", rules: ["trailing-minus", "trailing-zeros"], score: 0.333 },
    QTY_0_COMMA,
    QTY_1,
    { text: "09/2026", path: "$[0].date", normalized: [{ value: "2026-09", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    { text: "03/2026", path: "$[1].date", normalized: [{ value: "2026-03", rules: ["date-yyyymm"] }], match: "normalized", rules: ["date-yyyymm"], score: 0.5 },
    ...COMMON,
  ],
};

describe.skipIf(!enabled)("tabcap 0.4-C L2 (where on docs/05 s40 locale-numbers)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4c-"));
    site = startLocaleSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  for (const locale of S40_LOCALES) {
    test(`s40 ${locale}: every cell's first candidate is /api/rows at its $[row].field, with the expected normalisation`, async () => {
      await ok("navigate", `${site.origin}/s40?locale=${locale}`, ...S);
      await ok("wait", "--text", "rows 2", ...S);
      await ok("net", "wait", "--url", "/api/rows", ...S);
      if (rowsId === "") {
        const list = await ok("net", "list", "--filter", "/api/rows", ...S);
        rowsId = s(recs(list["requests"])[0]?.["id"]);
        expect(rowsId).toMatch(/^r-\d+$/);
      }
      const tree = s((await ok("snapshot", ...S))["tree"]);
      for (const cell of EXPECTED[locale]) {
        const ref = cellRef(tree, cell.text);
        const r = await ok("where", ref, ...S);
        const label = `${locale} ${JSON.stringify(cell.text)} (${ref})`;
        expect({ label, schema: r["schema"], query: r["query"] }).toEqual({ label, schema: "tabcap-where/0", query: { input: ref, kind: "ref", ref, text: cell.text } });
        expect({ label, normalized: r["normalized"] }).toEqual({ label, normalized: cell.normalized });
        const first = recs(r["candidates"])[0] ?? null;
        expect({ label, first }).toEqual({ label, first: { request: rowsId, path: cell.path, chain: [], match: cell.match, ...(cell.rules === undefined ? {} : { rules: cell.rules }), score: cell.score } });
        expect({ label, reason: r["reason"] ?? null, ambiguous: r["ambiguous"] ?? null }).toEqual({ label, reason: null, ambiguous: null });
        if (locale === "de-DE" && cell.text === "1.234,56") deRefFirst = first;
      }
    });
  }

  test("text input: where \"1.234,56\" hits the same path as the de-DE ref", async () => {
    const r = await ok("where", "1.234,56", ...S);
    expect(r["query"]).toEqual({ input: "1.234,56", kind: "text", text: "1.234,56" });
    expect(r["normalized"]).toEqual([{ value: "1234.56", rules: ["thousands-sep", "decimal-comma"] }]);
    expect(recs(r["candidates"])[0]).toEqual({ request: rowsId, path: "$[0].amount", chain: [], match: "normalized", rules: ["thousands-sep", "decimal-comma"], score: 0.333 });
    expect(deRefFirst).toEqual(recs(r["candidates"])[0] ?? {});
  });

  test("ambiguity: a day <= 12 date as text (no page to prove the order) lists both readings, no candidate", async () => {
    const r = await ok("where", "04/03/2026", ...S);
    expect(r["candidates"]).toEqual([]);
    expect(r["normalized"]).toEqual([]);
    expect(r["reason"]).toBe("ambiguous-date");
    expect(r["ambiguous"]).toEqual([
      { value: "2026-03-04", rules: ["date-yyyymm"], reason: "DD/MM/YYYY reading; text input: no page to disambiguate" },
      { value: "2026-04-03", rules: ["date-yyyymm"], reason: "MM/DD/YYYY reading; text input: no page to disambiguate" },
    ]);
  });

  test("--as text searches a ref-looking input literally; too-common; --text report", async () => {
    const t = await ok("where", "e1", "--as", "text", ...S);
    expect(t["query"]).toEqual({ input: "e1", kind: "text", text: "e1" });
    expect(t["reason"]).toBe("no-match");
    const common = await ok("where", "—", ...S);
    expect([common["candidates"], common["reason"]]).toEqual([[], "too-common"]);
    const txt = await tabcap(["where", "1.234,56", "--text", "--top", "1", ...S]);
    expect(txt.exit).toBe(0);
    expect(txt.raw.split("\n").slice(0, 3)).toEqual(['where "1.234,56" (text)', "normalized: 1234.56 [thousands-sep, decimal-comma]", `1. ${rowsId} $[0].amount  normalized [thousands-sep, decimal-comma]  score 0.333  chain []`]);
  });

  test("--write-findings while recording: finding events (tool where) in the live bundle; 实测 exact, 推断 normalized", async () => {
    const tree = s((await ok("snapshot", ...S))["tree"]); // the accounting page is still shown
    const exact = await ok("where", cellRef(tree, "1234.56"), "--top", "1", "--write-findings", ...S);
    const norm = await ok("where", cellRef(tree, "(123,456.00)"), "--top", "1", "--write-findings", ...S);
    const seqs = [exact, norm].map((r) => (isRecord(r["saved"]) && Array.isArray(r["saved"]["seqs"]) ? r["saved"]["seqs"] : []));
    expect(seqs.map((x) => x.length)).toEqual([1, 1]);
    await ok("net", "stop", ...S);
    const events = BundleReader.open(bundle).events.filter((e) => e.kind === "finding");
    expect(events.map((e) => [e["tool"], e["grade"], e["evidence"]])).toEqual([
      ["where", "实测", [{ request: rowsId, path: "$[0].amount" }]],
      ["where", "推断", [{ request: rowsId, path: "$[1].amount" }]],
    ]);
    expect(events.map((e) => e.seq)).toEqual(seqs.flat());
  });

  test("after net stop the session's last recording is still searched", async () => {
    const r = await ok("where", "-1,23,456.00", "--top", "1", ...S);
    expect(recs(r["candidates"])[0]).toEqual({ request: rowsId, path: "$[1].amount", chain: [], match: "normalized", rules: ["thousands-sep", "trailing-zeros"], score: 0.333 });
  });
});
