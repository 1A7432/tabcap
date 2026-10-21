// Value normalisation for `tabcap where` (docs/09 §3.1 "匹配前先归一化值",
// docs/05 s40 locale-numbers; 0.4-C brief, owner decisions 2026-10-16).
// Spec: normalize(raw) returns ALL plausible interpretations of a displayed
// value, each with the names of the rules that produced it, fewest rules
// first. Two kinds of rules, both table-driven:
//   text rules   rewrite the string: js-escape and html-entity are decodings
//                (the raw string stays an alternative), fullwidth / nbsp /
//                trim are foldings (always applied);
//   value rules  read the folded string as a number, a date, a dotted code,
//                a DR / CR direction or the empty-zero-null class.
// Oracle: test/unit/normalize.test.ts, whose expected values are the s40
// literals of test/e2e/site.ts (written by hand per locale, not with Intl).
// Reproduce: bun test test/unit/normalize.test.ts
//
// Not in 0.4 (backlog): relative time ("2 days ago"), timezone conversion.

import { decodeHtmlEntities } from "./codecs.ts";

export const RULES = [
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
] as const;

export type RuleName = (typeof RULES)[number];

/** A `DD/MM/YYYY` vs `MM/DD/YYYY` reading of an a/b/YYYY date with both parts <= 12. */
export type DateReading = "DD/MM/YYYY" | "MM/DD/YYYY";

export type Interpretation = {
  value: string;
  rules: RuleName[];
  /** Set on the two readings of an a/b/YYYY date whose parts are both <= 12. */
  ambiguous?: true;
  reading?: DateReading;
};

/** The canonical value of the empty-zero-null class ("" / "-" / "—" / "null" / 0). */
export const EMPTY_CLASS_VALUE = "0";
/** Year bounds for the digit-only date forms (YYYYMM, YYYYMMDD), so codes such as 100101 are not dates. */
export const DIGIT_DATE_YEARS = { min: 1900, max: 2100 } as const;

const RULE_INDEX = new Map<RuleName, number>(RULES.map((r, i) => [r, i]));
const ruleIndex = (r: RuleName): number => RULE_INDEX.get(r) ?? RULES.length;

/** Rule names in table order, without repeats. */
export function sortRules(rules: Iterable<RuleName>): RuleName[] {
  return [...new Set(rules)].sort((a, b) => ruleIndex(a) - ruleIndex(b));
}

// ------------------------------------------------------------ text rules

/** A text rule's result: the new text, and whether the change counts as using the rule. */
type TextStep = { text: string; counts: boolean };
type TextRule = { name: RuleName; kind: "decode" | "fold"; apply: (s: string) => TextStep | null };

const JS_ESCAPE = /\\(u[0-9a-fA-F]{4}|[nrtbf"'\\/])/g;
const JS_SIMPLE: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\", "/": "/" };

/** JS / JSON string escapes (`\uXXXX`, `\n`, `\"` …) in text copied from a script. Null when there are none. */
export function unescapeJs(s: string): string | null {
  if (!s.includes("\\")) return null;
  let changed = false;
  const out = s.replace(JS_ESCAPE, (_m, esc: string) => {
    changed = true;
    return esc.length === 5 ? String.fromCharCode(parseInt(esc.slice(1), 16)) : (JS_SIMPLE[esc] ?? esc);
  });
  return changed ? out : null;
}

/** Full-width ASCII forms (U+FF01..U+FF5E: digits, letters, punctuation) and U+3000 to ASCII. */
export function foldFullwidth(s: string): string | null {
  if (!/[　！-～]/.test(s)) return null;
  return s.replace(/[　！-～]/g, (c) => (c === "　" ? " " : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
}

const NBSP = /[   ]/g;
const step = (out: string | null): TextStep | null => (out === null ? null : { text: out, counts: true });

/** Decodings first (a wrong one is only an extra interpretation), then the foldings. */
export const TEXT_RULES: readonly TextRule[] = [
  { name: "js-escape", kind: "decode", apply: (s) => step(unescapeJs(s)) },
  { name: "html-entity", kind: "decode", apply: (s) => step(decodeHtmlEntities(s)) },
  { name: "fullwidth", kind: "fold", apply: (s) => step(foldFullwidth(s)) },
  // U+00A0 / U+202F / U+2009 become a space: trimmed at the edges (padding), a grouping inside numbers.
  { name: "nbsp", kind: "fold", apply: (s) => step(/[   ]/.test(s) ? s.replace(NBSP, " ") : null) },
  // Edge whitespace is free (exact matching trims too); collapsing internal runs is the rule.
  {
    name: "trim",
    kind: "fold",
    apply: (s) => {
      const t = s.trim();
      const c = t.replace(/\s+/g, " ");
      if (c !== t) return { text: c, counts: true };
      return t === s ? null : { text: t, counts: false };
    },
  },
];

type Variant = { text: string; rules: RuleName[] };

/** The text variants of a raw string: with and without each applicable decoding, every folding applied. */
export function textVariants(raw: string): Variant[] {
  let variants: Variant[] = [{ text: raw, rules: [] }];
  for (const r of TEXT_RULES) {
    const next: Variant[] = [];
    for (const v of variants) {
      const out = r.apply(v.text);
      if (r.kind === "decode") next.push(v);
      if (out === null || out.text === v.text) {
        if (r.kind === "fold") next.push(v);
      } else next.push({ text: out.text, rules: out.counts ? [...v.rules, r.name] : v.rules });
    }
    variants = next;
  }
  return variants;
}

// ------------------------------------------------------------ numbers

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Canonical number string: no exponent, no trailing zeros in the fraction,
 * no trailing ".", `-0` -> `0`. Leading zeros of the integer part are kept
 * (codes such as 007). Null when `s` is not a plain decimal number.
 */
export function canonicalNumber(s: string): string | null {
  const m = NUMBER.exec(s);
  if (m === null) return null;
  const sign = m[1] ?? "";
  const int = m[2] ?? "";
  const frac = m[3] ?? "";
  const exp = m[4];
  let digits = int + frac;
  let point = int.length;
  if (exp !== undefined) {
    const e = Number(exp);
    if (!Number.isSafeInteger(e) || Math.abs(e) > 400) return null;
    point += e;
    if (point <= 0) {
      digits = "0".repeat(1 - point) + digits;
      point = 1;
    }
    if (point > digits.length) digits += "0".repeat(point - digits.length);
    // an exponent form has no meaningful leading zeros
    const lead = /^0+(?=\d)/.exec(digits.slice(0, point))?.[0].length ?? 0;
    digits = digits.slice(lead);
    point -= lead;
  }
  const ip = digits.slice(0, point) || "0";
  const fp = digits.slice(point).replace(/0+$/, "");
  const zero = /^0*$/.test(ip + fp);
  return `${zero ? "" : sign}${ip}${fp === "" ? "" : `.${fp}`}`;
}

const GROUP_CHARS = new Set([",", ".", "'", " "]);

/**
 * Digits of a grouped integer part, or null. One grouping character (not the
 * decimal one), groups either western (1-3 digits, then threes) or Indian
 * (1-2 digits, then twos, the last group three: 1,23,456).
 */
export function ungroup(intPart: string, decimal: string): string | null {
  const seps = new Set(intPart.replace(/\d/g, ""));
  if (seps.size !== 1) return null;
  const g = [...seps][0] ?? "";
  if (!GROUP_CHARS.has(g) || g === decimal) return null;
  const groups = intPart.split(g);
  if (groups.length < 2 || groups.some((x) => !/^\d+$/.test(x))) return null;
  const first = groups[0] ?? "";
  const rest = groups.slice(1);
  const western = first.length >= 1 && first.length <= 3 && rest.every((x) => x.length === 3);
  const last = rest[rest.length - 1] ?? "";
  const indian = first.length >= 1 && first.length <= 2 && last.length === 3 && rest.slice(0, -1).every((x) => x.length === 2);
  return western || indian ? groups.join("") : null;
}

type Raw = { value: string; rules: RuleName[]; ambiguous?: true; reading?: DateReading };

/** Number readings of a folded string: both decimal conventions, signs, grouping. */
export function parseNumber(t: string): Raw[] {
  let s = t;
  const sign: RuleName[] = [];
  let neg = false;
  const paren = /^\((.+)\)$/.exec(s);
  const trailing = /^([^-].*?) ?-$/.exec(s);
  if (paren?.[1] !== undefined) {
    s = paren[1].trim();
    neg = true;
    sign.push("accounting-negative");
  } else if (trailing?.[1] !== undefined) {
    s = trailing[1];
    neg = true;
    sign.push("trailing-minus");
  } else if (s.startsWith("-")) {
    s = s.slice(1);
    neg = true;
  }
  if (!/^\d/.test(s) || !/\d$/.test(s) || /[^0-9.,' ]/.test(s)) return [];
  const out: Raw[] = [];
  for (const dec of [".", ","]) {
    const parts = s.split(dec);
    if (parts.length > 2) continue;
    const intPart = parts[0] ?? "";
    const frac = parts[1];
    if (frac !== undefined && !/^\d+$/.test(frac)) continue;
    const rules: RuleName[] = [...sign];
    let digits: string | null = intPart;
    if (!/^\d+$/.test(intPart)) {
      digits = ungroup(intPart, dec);
      if (digits === null) continue;
      rules.push("thousands-sep");
    }
    if (dec === "," && frac !== undefined) rules.push("decimal-comma");
    const plain = `${neg ? "-" : ""}${digits}${frac === undefined ? "" : `.${frac}`}`;
    const canon = canonicalNumber(plain);
    if (canon === null) continue;
    if (canon !== plain) rules.push("trailing-zeros");
    out.push({ value: canon, rules });
  }
  return out;
}

// ------------------------------------------------------------ dates

const pad2 = (n: number): string => String(n).padStart(2, "0");

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ym(year: number, month: number): string | null {
  return month >= 1 && month <= 12 ? `${year}-${pad2(month)}` : null;
}

function ymd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const digitYear = (y: number): boolean => y >= DIGIT_DATE_YEARS.min && y <= DIGIT_DATE_YEARS.max;

type DateForm = { re: RegExp; read: (m: RegExpExecArray) => Raw[] };

const n = (m: RegExpExecArray, i: number): number => Number(m[i] ?? "");
const one = (value: string | null, rules: RuleName[]): Raw[] => (value === null ? [] : [{ value, rules }]);

/** Date forms: canonical ISO month / day (no rule), and the date-yyyymm spellings. */
export const DATE_FORMS: readonly DateForm[] = [
  { re: /^(\d{4})-(\d{2})$/, read: (m) => one(ym(n(m, 1), n(m, 2)), []) },
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, read: (m) => one(ymd(n(m, 1), n(m, 2), n(m, 3)), []) },
  { re: /^(\d{4})(\d{2})$/, read: (m) => (digitYear(n(m, 1)) ? one(ym(n(m, 1), n(m, 2)), ["date-yyyymm"]) : []) },
  { re: /^(\d{4})(\d{2})(\d{2})$/, read: (m) => (digitYear(n(m, 1)) ? one(ymd(n(m, 1), n(m, 2), n(m, 3)), ["date-yyyymm"]) : []) },
  { re: /^(\d{1,2})\/(\d{4})$/, read: (m) => one(ym(n(m, 2), n(m, 1)), ["date-yyyymm"]) },
  {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    read: (m) => {
      const a = n(m, 1);
      const b = n(m, 2);
      const y = n(m, 3);
      const dm = ymd(y, b, a); // DD/MM/YYYY
      const md = ymd(y, a, b); // MM/DD/YYYY
      if (dm !== null && md !== null && dm !== md) {
        return [
          { value: dm, rules: ["date-yyyymm"], ambiguous: true, reading: "DD/MM/YYYY" },
          { value: md, rules: ["date-yyyymm"], ambiguous: true, reading: "MM/DD/YYYY" },
        ];
      }
      return one(dm ?? md, ["date-yyyymm"]);
    },
  },
];

export function parseDate(t: string): Raw[] {
  for (const f of DATE_FORMS) {
    const m = f.re.exec(t);
    if (m !== null) return f.read(m);
  }
  return [];
}

const SLASH_DATE = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g;

/**
 * The day / month order of a page's a/b/YYYY dates: "DD/MM/YYYY" when some
 * date has a first part > 12, "MM/DD/YYYY" when some has a second part > 12,
 * null when none does or both orders occur.
 */
export function pageDateOrder(pageText: string): DateReading | null {
  const { dm, md } = pageDateOrders(pageText);
  return dm === md ? null : dm ? "DD/MM/YYYY" : "MM/DD/YYYY";
}

/** Which a/b/YYYY orders the page's dates prove: dm (a day > 12 first), md (a day > 12 second). */
export function pageDateOrders(pageText: string): { dm: boolean; md: boolean } {
  let dm = false;
  let md = false;
  for (const m of pageText.matchAll(SLASH_DATE)) {
    const a = Number(m[1] ?? "");
    const b = Number(m[2] ?? "");
    if (a > 12 && b >= 1 && b <= 12) dm = true;
    else if (b > 12 && a >= 1 && a <= 12) md = true;
  }
  return { dm, md };
}

// ------------------------------------------------------------ other value rules

type ValueRule = { name: RuleName; read: (t: string) => Raw[] };

const EMPTY_CLASS = new Set(["", "-", "—", "null"]);

/** Value rules after the text stage. A string read by none of them is plain text. */
export const VALUE_RULES: readonly ValueRule[] = [
  { name: "empty-zero-null", read: (t) => (EMPTY_CLASS.has(t.toLowerCase()) ? [{ value: EMPTY_CLASS_VALUE, rules: ["empty-zero-null"] }] : []) },
  { name: "thousands-sep", read: parseNumber },
  { name: "date-yyyymm", read: parseDate },
  { name: "dotted-code", read: (t) => (/^\d+(?:\.\d+)+$/.test(t) ? [{ value: t.replace(/\./g, ""), rules: ["dotted-code"] }] : []) },
  { name: "dr-cr", read: (t) => (/^dr$/i.test(t) ? [{ value: "1", rules: ["dr-cr"] }] : /^cr$/i.test(t) ? [{ value: "-1", rules: ["dr-cr"] }] : []) },
];

function compareRules(a: readonly RuleName[], b: readonly RuleName[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = ruleIndex(a[i] ?? "trim") - ruleIndex(b[i] ?? "trim");
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Every plausible interpretation of a displayed value, fewest rules first
 * (then rule table order, then value). One entry per value and reading; an
 * empty input is the empty-zero-null class.
 */
export function normalize(raw: string): Interpretation[] {
  const found: Raw[] = [];
  for (const v of textVariants(raw)) {
    const t = v.text.trim();
    const structured: Raw[] = [];
    for (const r of VALUE_RULES) {
      const got = r.read(t);
      structured.push(...got);
      if (r.name === "empty-zero-null" && got.length > 0) break;
    }
    if (structured.length === 0) found.push({ value: t, rules: v.rules });
    else for (const s of structured) found.push({ ...s, rules: [...v.rules, ...s.rules] });
  }
  const best = new Map<string, Raw>();
  for (const f of found) {
    const r: Raw = { ...f, rules: sortRules(f.rules) };
    const key = `${r.value}\u0000${r.reading ?? ""}`;
    const have = best.get(key);
    if (have === undefined || compareRules(r.rules, have.rules) < 0) best.set(key, r);
  }
  return [...best.values()]
    .sort((a, b) => compareRules(a.rules, b.rules) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0) || (a.reading ?? "").localeCompare(b.reading ?? ""))
    .map((r) => ({ value: r.value, rules: r.rules, ...(r.ambiguous === true ? { ambiguous: true as const } : {}), ...(r.reading === undefined ? {} : { reading: r.reading }) }));
}

/**
 * A query that normalises only to the empty-zero-null class (nothing to
 * search for). Zero spelled with more digits (`0.00` read as the dotted code
 * `000`) is still zero.
 */
export function onlyEmptyClass(interps: readonly Interpretation[]): boolean {
  return interps.length > 0 && interps.every((i) => /^0+$/.test(i.value));
}

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The cheapest common interpretation of a query and a value: equal values,
 * or a query month (YYYY-MM) and a value date of that month (rule
 * date-yyyymm: the page shows a month view of a full date). Null when none.
 */
export function commonInterpretation(query: readonly Interpretation[], value: readonly Interpretation[]): { value: string; rules: RuleName[] } | null {
  let best: { value: string; rules: RuleName[] } | null = null;
  for (const q of query) {
    for (const v of value) {
      let rules: RuleName[] | null = null;
      if (q.value === v.value) rules = sortRules([...q.rules, ...v.rules]);
      else if (MONTH.test(q.value) && DAY.test(v.value) && v.value.startsWith(`${q.value}-`)) rules = sortRules([...q.rules, ...v.rules, "date-yyyymm"]);
      if (rules !== null && (best === null || compareRules(rules, best.rules) < 0)) best = { value: q.value, rules };
    }
  }
  return best;
}
