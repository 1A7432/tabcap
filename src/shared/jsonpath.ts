// JSON paths (docs/04 §43): the one grammar that `--select`
// (shared/filter.ts), stop and end rules (`json:` in `--stop-on`, `--end-on`,
// config.json `fetch.stopOn` / `sites.<s>.guard`; daemon/fetch/stoprules.ts),
// `--business-code` (bundle/usage.ts) and the replay key rules
// (`ignoreBodyFields`, `ignorePaths`; replay/rules.ts) parse.
//
//   path  = root step*            root "$"; optional only for --select,
//                                 where the first step may also be a bare name
//   step  = "." name | ".*" | "[" digits "]" | "[*]" | "[" json-string "]"
//   name  = one or more characters, none of . [ ] = ! or whitespace / control
//           characters; "*" alone is the wildcard (write ["*"] for the name)
//   digits = 1 to 9 decimal digits (an array index)
//
// A bare name stops at = and ! so a rule's operator can follow the path
// (`json:$.code!=0`); a name with those characters, spaces or brackets is
// written quoted (`$["err msg"]`). A key step reads objects only, an index
// step arrays only; a wildcard reads every element of an array and every
// value of an object. Paths are untrusted input: a bad one is reported with
// the 1-based character where it went wrong, never thrown out of here.
// Oracle: docs/04 §43. Reproduce: bun test test/unit/jsonpath.test.ts

import { isRecord } from "./json.ts";

export type PathSeg = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "all" };

/** A path found in a text: its steps and the offset right after it; or where and why it is not one. */
export type PathScan = { ok: true; segs: PathSeg[]; end: number } | { ok: false; at: number; why: string };

/** Characters that end a bare name. */
const NAME_END = /[.[\]=!\s\u0000-\u001f\u007f]/u;
const INDEX = /^\d{1,9}$/;

/** The index of the quote that closes the JSON string opening at `open`, or -1. */
function closingQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** The end (exclusive) of the bare name starting at `i`. */
function nameEnd(src: string, i: number): number {
  let j = i;
  while (j < src.length && !NAME_END.test(src[j] ?? "")) j++;
  return j;
}

/**
 * Read a path from `src` at `start`. It ends at the first character that
 * cannot continue it (for a rule: the operator or a space); the caller says
 * whether more may follow. `root: "optional"` (--select): `$` is the root only
 * when the end, "." or "[" follows it, and the first step may be a bare name.
 */
export function scanJsonPath(src: string, start: number, opts: { root: "required" | "optional" }): PathScan {
  const segs: PathSeg[] = [];
  const err = (at: number, why: string): PathScan => ({ ok: false, at, why: `${why} at character ${at - start + 1}` });
  let i = start;
  const next = src[i + 1];
  if (src[i] === "$" && (opts.root === "required" || next === undefined || next === "." || next === "[")) i++;
  else if (opts.root === "required") return err(i, "a JSON path starts with $");
  else if (src[i] !== "[") {
    const j = nameEnd(src, i);
    if (j === i) return err(i, src[i] === undefined ? "empty path" : `expected a name, [ or $, found ${JSON.stringify(src[i])}`);
    const name = src.slice(i, j);
    segs.push(name === "*" ? { kind: "all" } : { kind: "key", key: name });
    i = j;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === ".") {
      const j = nameEnd(src, i + 1);
      if (j === i + 1) return err(i + 1, src[i + 1] === undefined ? "expected a name or * after ." : `expected a name or * after ., found ${JSON.stringify(src[i + 1])}`);
      const name = src.slice(i + 1, j);
      segs.push(name === "*" ? { kind: "all" } : { kind: "key", key: name });
      i = j;
    } else if (c === "[") {
      if (src[i + 1] === '"') {
        const close = closingQuote(src, i + 1);
        if (close < 0) return err(i, "unclosed quoted name");
        if (src[close + 1] !== "]") return err(close + 1, "expected ] after the quoted name");
        let name: unknown;
        try {
          name = JSON.parse(src.slice(i + 1, close + 1));
        } catch {
          name = null;
        }
        if (typeof name !== "string") return err(i, "bad quoted name (a JSON string)");
        segs.push({ kind: "key", key: name });
        i = close + 2;
      } else {
        const close = src.indexOf("]", i);
        if (close < 0) return err(i, "unclosed [");
        const inner = src.slice(i + 1, close);
        if (inner === "*") segs.push({ kind: "all" });
        else if (INDEX.test(inner)) segs.push({ kind: "index", index: Number(inner) });
        else return err(i, `[${inner.slice(0, 20)}] is not an index, [*] or a quoted key ["…"]`);
        i = close + 1;
      }
    } else break;
  }
  return { ok: true, segs, end: i };
}

/** A whole text as one path; anything after the path is an error with its position. */
export function parseJsonPath(src: string, opts: { root: "required" | "optional" }): { ok: true; segs: PathSeg[] } | { ok: false; why: string } {
  const r = scanJsonPath(src, 0, opts);
  if (!r.ok) return { ok: false, why: r.why };
  if (r.end < src.length) {
    const c = src[r.end] ?? "";
    const quote = c === "=" || c === "!" || c === "]" || /\s/u.test(c) ? ` (write a name with spaces, =, ! or brackets quoted: ["…"])` : "";
    return { ok: false, why: `unexpected ${JSON.stringify(c)} at character ${r.end + 1}${quote}` };
  }
  return { ok: true, segs: r.segs };
}

const BARE = (k: string): boolean => k !== "" && k !== "*" && !k.split("").some((c) => NAME_END.test(c));

/** One step as text: `.name`, `["quoted name"]`, `[n]`, `[*]`. */
export function segText(s: PathSeg): string {
  if (s.kind === "index") return `[${s.index}]`;
  if (s.kind === "all") return "[*]";
  return BARE(s.key) ? `.${s.key}` : `[${JSON.stringify(s.key)}]`;
}

/** A path as text that parses back to the same steps. */
export function pathText(segs: readonly PathSeg[]): string {
  return "$" + segs.map(segText).join("");
}

/** Does one step match one concrete step (an object key or an array index)? */
export function segMatches(s: PathSeg, step: string | number): boolean {
  if (s.kind === "all") return true;
  if (s.kind === "key") return typeof step === "string" && s.key === step;
  return typeof step === "number" && s.index === step;
}

/** Every value at the path, each with its concrete path (wildcards expanded); none when a branch is missing. */
export function valuesAt(doc: unknown, segs: readonly PathSeg[]): Array<{ path: PathSeg[]; value: unknown }> {
  let nodes: Array<{ path: PathSeg[]; value: unknown }> = [{ path: [], value: doc }];
  for (const s of segs) {
    const out: Array<{ path: PathSeg[]; value: unknown }> = [];
    for (const n of nodes) {
      const v = n.value;
      if (s.kind === "key") {
        if (isRecord(v) && Object.hasOwn(v, s.key)) out.push({ path: [...n.path, s], value: v[s.key] });
      } else if (s.kind === "index") {
        if (Array.isArray(v) && s.index < v.length) out.push({ path: [...n.path, s], value: v[s.index] });
      } else if (Array.isArray(v)) v.forEach((x, i) => out.push({ path: [...n.path, { kind: "index", index: i }], value: x }));
      else if (isRecord(v)) for (const [k, x] of Object.entries(v)) out.push({ path: [...n.path, { kind: "key", key: k }], value: x });
    }
    nodes = out;
  }
  return nodes;
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
