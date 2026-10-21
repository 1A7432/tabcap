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
// <path> is a JSON path of docs/04 §43 (shared/jsonpath.ts: `$`, then `.name`,
// `.*`, `[n]`, `[*]`, `["quoted name"]`). <value> is read as JSON when it
// parses (0, true, "x", null), else as the literal string. 0.7.5: json:
// rules judge JSON bodies only; a body that does not parse as JSON (an HTML
// page, an empty 204, a text beacon) never fires them, whatever the
// Content-Type says. A JSON body with nothing at the path has no value:
// never equal to anything (so `!=` fires). With a wildcard the path selects
// every matching value: `=` fires when one of them equals, `!=` when one of
// them differs or none is there (review wave 2, docs/04 §43).

import { TabcapError } from "../../shared/envelope.ts";
import { jsonEqual, pathText, scanJsonPath, valuesAt, type PathSeg } from "../../shared/jsonpath.ts";

export type StopRule =
  | { src: string; kind: "empty-body" }
  | { src: string; kind: "status-ge"; n: number }
  | { src: string; kind: "status-eq"; n: number }
  | { src: string; kind: "json"; path: PathSeg[]; op: "=" | "!="; value: unknown }
  | { src: string; kind: "text"; re: RegExp };

export const MAX_RULE_REGEX = 256;
const RULES_HELP = "Stop rules: empty-body | status>=<n> | status=<n> | json:<$.path>=<value> | json:<$.path>!=<value> | text:<regex>; JSON paths: docs/04 §43.";

const bad = (src: string, why: string) => new TabcapError("usage", `bad stop rule ${JSON.stringify(src.slice(0, 300))}: ${why}`, RULES_HELP);

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
    const at = "json:".length;
    if (s[at] !== "$") throw bad(s, "the JSON path must start with $");
    const p = scanJsonPath(s, at, { root: "required" });
    if (!p.ok) throw bad(s, `${p.why} of the path`);
    const op = /^\s*(!=|=)\s*/.exec(s.slice(p.end));
    if (op === null) throw bad(s, `expected = or != after the path, found ${JSON.stringify(s.slice(p.end, p.end + 10))} at character ${p.end - at + 1} of the path (write names with spaces, = or ! quoted: $["…"])`);
    const raw = s.slice(p.end + op[0].length);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = raw;
    }
    return { src: s, kind: "json", path: p.segs, op: op[1] === "!=" ? "!=" : "=", value };
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
        if (d === NO_VALUE) break; // not a JSON body: no opinion
        // Every value at the path (more than one with a wildcard); none: no value, never equal.
        const hits = valuesAt(d, rule.path);
        const hit = rule.op === "=" ? hits.find((h) => jsonEqual(h.value, rule.value)) : hits.length === 0 ? { path: rule.path, value: NO_VALUE } : hits.find((h) => !jsonEqual(h.value, rule.value));
        if (hit !== undefined) return { rule: rule.src, detail: `${pathText(hit.path)} is ${show(hit.value)}` };
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
