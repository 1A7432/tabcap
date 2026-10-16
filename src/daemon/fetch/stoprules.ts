// Stop rules of `tabcap fetch` (0.6-A, owner design 10-16): when a rule fires
// on a recorded response the command returns `fetch.stopped`, the guard writes
// a `breaker` event (reason `fetch-stop`) and the site refuses further fetches
// until `tabcap guard resume --site <s>`. Pure: parsing and evaluation only.
//
// Rules (`--stop-on`, repeatable; config.json `fetch.stopOn` / `sites.<name>.fetch.stopOn`):
//   empty-body             the body is missing, empty or only whitespace
//   status>=<n>            the status is at least n (e.g. status>=400)
//   status=<n>             the status is exactly n
//   json:<path>=<value>    the JSON body's value at path equals value
//   json:<path>!=<value>   … differs from value (business error codes, e.g. json:$.code!=0)
//   text:<regex>           the decoded body matches the regex (JavaScript, u flag, ≤ 256 chars)
// <path> is `$` followed by `.name` / `[n]` steps. <value> is read as JSON when
// it parses (0, true, "x", null), else as the literal string. A body that is
// not JSON, or has nothing at the path, has no value: never equal to anything.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";

export type PathStep = string | number;

export type StopRule =
  | { src: string; kind: "empty-body" }
  | { src: string; kind: "status-ge"; n: number }
  | { src: string; kind: "status-eq"; n: number }
  | { src: string; kind: "json"; path: PathStep[]; op: "=" | "!="; value: unknown }
  | { src: string; kind: "text"; re: RegExp };

export const MAX_RULE_REGEX = 256;
const RULES_HELP = "Stop rules: empty-body | status>=<n> | status=<n> | json:<$.path>=<value> | json:<$.path>!=<value> | text:<regex>.";

const bad = (src: string, why: string) => new TabcapError("usage", `bad stop rule ${JSON.stringify(src.slice(0, 300))}: ${why}`, RULES_HELP);

/** Parse a JSON path of the form `$`, `$.a.b`, `$.items[0].code`. */
export function parsePath(src: string, rule: string): PathStep[] {
  if (!src.startsWith("$")) throw bad(rule, "the JSON path must start with $");
  const steps: PathStep[] = [];
  let i = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === ".") {
      const m = /^[A-Za-z0-9_$-]+/.exec(src.slice(i + 1));
      if (m === null) throw bad(rule, `expected a key after "." at position ${i + 1} of the path`);
      steps.push(m[0]);
      i += 1 + m[0].length;
    } else if (c === "[") {
      const m = /^\[(\d{1,9})\]/.exec(src.slice(i));
      if (m === null || m[1] === undefined) throw bad(rule, `expected [<index>] at position ${i + 1} of the path`);
      steps.push(Number(m[1]));
      i += m[0].length;
    } else throw bad(rule, `unexpected ${JSON.stringify(c)} in the path`);
  }
  return steps;
}

function statusNumber(s: string, rule: string): number {
  if (!/^\d{3}$/.test(s)) throw bad(rule, "the status must be a 3-digit number");
  return Number(s);
}

export function parseStopRule(src: string): StopRule {
  if (typeof src !== "string" || src.trim() === "") throw bad(String(src), "empty");
  const s = src.trim();
  if (s === "empty-body") return { src: s, kind: "empty-body" };
  let m = /^status\s*>=\s*(\S+)$/.exec(s);
  if (m !== null) return { src: s, kind: "status-ge", n: statusNumber(m[1] ?? "", s) };
  m = /^status\s*=\s*(\S+)$/.exec(s);
  if (m !== null) return { src: s, kind: "status-eq", n: statusNumber(m[1] ?? "", s) };
  if (s.startsWith("json:")) {
    const j = /^json:(\$[^=!]*?)\s*(!=|=)\s*([\s\S]*)$/.exec(s);
    if (j === null) throw bad(s, "expected json:<$.path>=<value> or json:<$.path>!=<value>");
    const path = parsePath((j[1] ?? "").trim(), s);
    const raw = j[3] ?? "";
    let value: unknown = raw;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = raw;
    }
    return { src: s, kind: "json", path, op: j[2] === "!=" ? "!=" : "=", value };
  }
  if (s.startsWith("text:")) {
    const re = s.slice(5);
    if (re === "") throw bad(s, "text: needs a regular expression");
    if (re.length > MAX_RULE_REGEX) throw bad(s, `the regular expression is longer than ${MAX_RULE_REGEX} characters`);
    try {
      return { src: s, kind: "text", re: new RegExp(re, "u") };
    } catch (e) {
      throw bad(s, `not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  throw bad(s, "unknown rule");
}

/** Parse a list of rules (config first, then the command's own); the first bad one is a usage error. */
export function parseStopRules(list: readonly string[]): StopRule[] {
  return list.map(parseStopRule);
}

/** What the rules look at: the recorded response. `text` is the decoded body (null: binary or no body). */
export type StopInput = { status: number | null; bytes: number; text: string | null };

const NO_VALUE: unique symbol = Symbol("no value");

/** The value at `path` in a JSON document, or NO_VALUE. */
export function valueAt(doc: unknown, path: readonly PathStep[]): unknown {
  let cur: unknown = doc;
  for (const step of path) {
    if (typeof step === "number") {
      if (!Array.isArray(cur) || step >= cur.length) return NO_VALUE;
      cur = cur[step];
    } else {
      if (!isRecord(cur) || !Object.hasOwn(cur, step)) return NO_VALUE;
      cur = cur[step];
    }
  }
  return cur;
}

/** Structural equality of JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function show(v: unknown): string {
  if (v === NO_VALUE) return "no value";
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** The first rule that fires, with a one-line detail, or null. */
export function firstStop(rules: readonly StopRule[], r: StopInput): { rule: string; detail: string } | null {
  let parsed: unknown = NO_VALUE;
  let parsedDone = false;
  const doc = (): unknown => {
    if (!parsedDone) {
      parsedDone = true;
      if (r.text !== null) {
        try {
          parsed = JSON.parse(r.text) as unknown;
        } catch {
          parsed = NO_VALUE;
        }
      }
    }
    return parsed;
  };
  for (const rule of rules) {
    switch (rule.kind) {
      case "empty-body":
        if (r.bytes === 0 || (r.text !== null && r.text.trim() === "")) return { rule: rule.src, detail: r.bytes === 0 ? "the body is empty" : `the body is only whitespace (${r.bytes} bytes)` };
        break;
      case "status-ge":
        if (r.status !== null && r.status >= rule.n) return { rule: rule.src, detail: `status ${r.status}` };
        break;
      case "status-eq":
        if (r.status === rule.n) return { rule: rule.src, detail: `status ${r.status}` };
        break;
      case "json": {
        const d = doc();
        const v = d === NO_VALUE ? NO_VALUE : valueAt(d, rule.path);
        const equal = v !== NO_VALUE && jsonEqual(v, rule.value);
        if (rule.op === "=" ? equal : !equal) {
          const where = d === NO_VALUE ? "the body is not JSON" : `${pathText(rule.path)} is ${show(v)}`;
          return { rule: rule.src, detail: where };
        }
        break;
      }
      case "text":
        if (r.text !== null) {
          rule.re.lastIndex = 0;
          const m = rule.re.exec(r.text);
          if (m !== null) return { rule: rule.src, detail: `the body matches at character ${m.index}` };
        }
        break;
    }
  }
  return null;
}

export function pathText(path: readonly PathStep[]): string {
  return "$" + path.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");
}
