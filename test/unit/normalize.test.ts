// Value normalisation (src/analyze/normalize.ts). Oracle: docs/05 s40 and the
// 0.4-C rule list. The display strings are the s40 literals of
// test/e2e/site.ts (S40_TABLES, written by hand per locale); the expected
// interpretations below are written by hand from the rule definitions, never
// computed by the code under test.

import { describe, expect, test } from "bun:test";
import { RULES, canonicalNumber, commonInterpretation, normalize, onlyEmptyClass, pageDateOrder, textVariants, ungroup, type Interpretation } from "../../src/analyze/normalize.ts";

type Row = [raw: string, expected: Interpretation[]];

const NNBSP = " ";
const NBSP = " ";

/** docs/05 s40: every display string of the five locales (site.ts S40_TABLES) and what it normalises to. */
const S40: Row[] = [
  // en-US
  ["1,234.56", [{ value: "1234.56", rules: ["thousands-sep"] }]],
  ["-123,456.00", [{ value: "-123456", rules: ["thousands-sep", "trailing-zeros"] }]],
  ["1,234", [{ value: "1234", rules: ["thousands-sep"] }, { value: "1.234", rules: ["decimal-comma"] }]],
  ["48", [{ value: "48", rules: [] }]],
  ["09/15/2026", [{ value: "2026-09-15", rules: ["date-yyyymm"] }]],
  [
    "03/04/2026",
    [
      { value: "2026-03-04", rules: ["date-yyyymm"], ambiguous: true, reading: "MM/DD/YYYY" },
      { value: "2026-04-03", rules: ["date-yyyymm"], ambiguous: true, reading: "DD/MM/YYYY" },
    ],
  ],
  // de-DE
  ["1.234,56", [{ value: "1234.56", rules: ["thousands-sep", "decimal-comma"] }]],
  ["-123.456,00", [{ value: "-123456", rules: ["thousands-sep", "decimal-comma", "trailing-zeros"] }]],
  ["1.234", [{ value: "1.234", rules: [] }, { value: "1234", rules: ["thousands-sep"] }]],
  ["2026-09", [{ value: "2026-09", rules: [] }]],
  ["2026-03", [{ value: "2026-03", rules: [] }]],
  // fr-FR (U+202F narrow no-break space groups thousands)
  [`1${NNBSP}234,56`, [{ value: "1234.56", rules: ["nbsp", "thousands-sep", "decimal-comma"] }]],
  [`-123${NNBSP}456,00`, [{ value: "-123456", rules: ["nbsp", "thousands-sep", "decimal-comma", "trailing-zeros"] }]],
  [`1${NNBSP}234`, [{ value: "1234", rules: ["nbsp", "thousands-sep"] }]],
  ["15/09/2026", [{ value: "2026-09-15", rules: ["date-yyyymm"] }]],
  [
    "04/03/2026",
    [
      { value: "2026-03-04", rules: ["date-yyyymm"], ambiguous: true, reading: "DD/MM/YYYY" },
      { value: "2026-04-03", rules: ["date-yyyymm"], ambiguous: true, reading: "MM/DD/YYYY" },
    ],
  ],
  // en-IN
  ["-1,23,456.00", [{ value: "-123456", rules: ["thousands-sep", "trailing-zeros"] }]],
  ["202609", [{ value: "202609", rules: [] }, { value: "2026-09", rules: ["date-yyyymm"] }]],
  ["202603", [{ value: "202603", rules: [] }, { value: "2026-03", rules: ["date-yyyymm"] }]],
  // accounting
  ["(123,456.00)", [{ value: "-123456", rules: ["thousands-sep", "accounting-negative", "trailing-zeros"] }]],
  ["1234.56", [{ value: "1234.56", rules: [] }, { value: "123456", rules: ["dotted-code"] }]], // digits and dots only: also a dotted code
  ["123456.00-", [{ value: "-123456", rules: ["trailing-minus", "trailing-zeros"] }]],
  ["09/2026", [{ value: "2026-09", rules: ["date-yyyymm"] }]],
  ["03/2026", [{ value: "2026-03", rules: ["date-yyyymm"] }]],
  // every locale: dotted code, direction, full-width qty padded with &nbsp; (innerText keeps U+00A0)
  ["1001.01", [{ value: "1001.01", rules: [] }, { value: "100101", rules: ["dotted-code"] }]],
  ["2002.02", [{ value: "2002.02", rules: [] }, { value: "200202", rules: ["dotted-code"] }]],
  ["DR", [{ value: "1", rules: ["dr-cr"] }]],
  ["CR", [{ value: "-1", rules: ["dr-cr"] }]],
  [`${NBSP}${NBSP}１２３４`, [{ value: "1234", rules: ["nbsp", "fullwidth"] }]],
  [`${NBSP}${NBSP}４８`, [{ value: "48", rules: ["nbsp", "fullwidth"] }]],
];

/** The other rules of the 0.4-C list. */
const OTHER: Row[] = [
  ["1'234.56", [{ value: "1234.56", rules: ["thousands-sep"] }]],
  ["1,23,456", [{ value: "123456", rules: ["thousands-sep"] }]],
  ["1234,56", [{ value: "1234.56", rules: ["decimal-comma"] }]],
  ["1234.5600", [{ value: "1234.56", rules: ["trailing-zeros"] }, { value: "12345600", rules: ["dotted-code"] }]],
  ["1234-", [{ value: "-1234", rules: ["trailing-minus"] }]],
  ["(1,234.56)", [{ value: "-1234.56", rules: ["thousands-sep", "accounting-negative"] }]],
  ["-0", [{ value: "0", rules: ["trailing-zeros"] }]],
  ["20260915", [{ value: "20260915", rules: [] }, { value: "2026-09-15", rules: ["date-yyyymm"] }]],
  ["2026-09-15", [{ value: "2026-09-15", rules: [] }]],
  ["03/03/2026", [{ value: "2026-03-03", rules: ["date-yyyymm"] }]],
  ["100101", [{ value: "100101", rules: [] }]], // year 1001 is outside DIGIT_DATE_YEARS: a code, not a date
  ["Order  placed", [{ value: "Order placed", rules: ["trim"] }]],
  ["  Order placed ", [{ value: "Order placed", rules: [] }]], // edge whitespace is free
  ["ＡＢＣ－１", [{ value: "ABC-1", rules: ["fullwidth"] }]],
  ["Tom &amp; Jerry", [{ value: "Tom &amp; Jerry", rules: [] }, { value: "Tom & Jerry", rules: ["html-entity"] }]],
  ["\\u20ac5 \\\"x\\\"", [{ value: '\\u20ac5 \\"x\\"', rules: [] }, { value: '€5 "x"', rules: ["js-escape"] }]],
  ["&#49;,&#50;34", [{ value: "&#49;,&#50;34", rules: [] }, { value: "1234", rules: ["html-entity", "thousands-sep"] }, { value: "1.234", rules: ["html-entity", "decimal-comma"] }]],
  ["dr", [{ value: "1", rules: ["dr-cr"] }]],
  ["", [{ value: "0", rules: ["empty-zero-null"] }]],
  ["-", [{ value: "0", rules: ["empty-zero-null"] }]],
  ["—", [{ value: "0", rules: ["empty-zero-null"] }]],
  ["null", [{ value: "0", rules: ["empty-zero-null"] }]],
  ["0", [{ value: "0", rules: [] }]],
];

describe("normalize: docs/05 s40 display strings", () => {
  for (const [raw, want] of S40) test(JSON.stringify(raw), () => expect(normalize(raw)).toEqual(want));
});

describe("normalize: the other rules", () => {
  for (const [raw, want] of OTHER) test(JSON.stringify(raw), () => expect(normalize(raw)).toEqual(want));
});

describe("normalize: properties", () => {
  test("the rule names are the 0.4-C list, in that order", () => {
    expect([...RULES]).toEqual([
      "trim",
      "nbsp",
      "html-entity",
      "js-escape",
      "fullwidth",
      "thousands-sep",
      "decimal-comma",
      "accounting-negative",
      "trailing-minus",
      "trailing-zeros",
      "date-yyyymm",
      "dotted-code",
      "dr-cr",
      "empty-zero-null",
    ]);
  });

  test("deterministic: fewest rules first, the same answer every time", () => {
    for (const [raw] of [...S40, ...OTHER]) {
      const a = normalize(raw);
      expect(normalize(raw)).toEqual(a);
      for (let i = 1; i < a.length; i++) expect((a[i]?.rules.length ?? 0) >= (a[i - 1]?.rules.length ?? 0)).toBe(true);
    }
  });

  test("canonical numbers: no exponent, no trailing zeros, -0 is 0, leading zeros kept", () => {
    expect(canonicalNumber("1e21")).toBe("1000000000000000000000");
    expect(canonicalNumber("1.5e-7")).toBe("0.00000015");
    expect(canonicalNumber("12e2")).toBe("1200");
    expect(canonicalNumber("0.10")).toBe("0.1");
    expect(canonicalNumber("-0.00")).toBe("0");
    expect(canonicalNumber("007")).toBe("007");
    expect(canonicalNumber("1,234")).toBeNull();
  });

  test("grouping: western threes or Indian twos, one separator, not the decimal one", () => {
    expect(ungroup("1,234,567", ".")).toBe("1234567");
    expect(ungroup("12,34,567", ".")).toBe("1234567");
    expect(ungroup("1,2345", ".")).toBeNull();
    expect(ungroup("1.234,567", ".")).toBeNull();
    expect(ungroup("1.234", ".")).toBeNull();
  });

  test("text variants: decodings are alternatives, foldings always apply", () => {
    expect(textVariants("&amp;").map((v) => v.text)).toEqual(["&amp;", "&"]);
    expect(textVariants(`${NBSP}x`)).toEqual([{ text: "x", rules: ["nbsp"] }]);
  });

  test("page date order: a part > 12 proves the order; none or both orders prove nothing", () => {
    expect(pageDateOrder("15/09/2026 04/03/2026")).toBe("DD/MM/YYYY");
    expect(pageDateOrder("09/15/2026 03/04/2026")).toBe("MM/DD/YYYY");
    expect(pageDateOrder("04/03/2026 05/06/2026")).toBeNull();
    expect(pageDateOrder("15/09/2026 09/15/2026")).toBeNull();
  });

  test("a query month matches a value date of that month (date-yyyymm), not the other way round", () => {
    expect(commonInterpretation(normalize("2026-09"), normalize("2026-09-15"))).toEqual({ value: "2026-09", rules: ["date-yyyymm"] });
    expect(commonInterpretation(normalize("09/2026"), normalize("2026-09-15"))).toEqual({ value: "2026-09", rules: ["date-yyyymm"] });
    expect(commonInterpretation(normalize("2026-09-15"), normalize("2026-09"))).toBeNull();
    expect(commonInterpretation(normalize("1.234,56"), normalize("1234.56"))).toEqual({ value: "1234.56", rules: ["thousands-sep", "decimal-comma"] });
  });

  test("empty-zero-null: only that class is too common", () => {
    for (const raw of ["", "-", "—", "null", "0", "0.00", " "]) expect(onlyEmptyClass(normalize(raw))).toBe(true);
    for (const raw of ["0.5", "DR", "1,234"]) expect(onlyEmptyClass(normalize(raw))).toBe(false);
  });
});
