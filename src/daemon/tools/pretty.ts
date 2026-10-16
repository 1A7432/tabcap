// Bounded pretty-printing for `net body --pretty` / `net grep --pretty` (0.5-F).
//
// JavaScript: a small tokenizer, no parser. It only *inserts* text (a newline
// plus indentation) after `;`, `{`, `}` and `,` when the bracket depth since the
// innermost open `{` is 0 — `(` and `[` count as brackets, so `for (;;)`,
// argument lists and array literals stay on one line, while the bodies of
// functions inside `(function () { … })()` still break. It never inserts
// inside strings, template literals (including their `${…}` parts), regular
// expression literals or comments. A `/` starts a regex literal unless the
// previous significant token is an identifier, a number, `)`, `]` or `}`
// (keywords such as `return` / `typeof` do start one). Because text is only
// inserted, every raw offset maps to a pretty offset (`mapOffset`), which is
// how `--at line:col` (positions from `trace list` / console stacks, raw)
// lands in the pretty text. It never throws: malformed input (unterminated
// strings, unbalanced braces) just ends up with fewer breaks.
//
// JSON: `JSON.stringify(JSON.parse(text), null, 2)` when it parses (no offset
// map: the text is re-serialised).

/** Bodies over this size are never prettified (the answer says so). */
export const PRETTY_MAX_BYTES = 8 * 1024 * 1024;

const MAX_INDENT = 20;

const REGEX_AFTER_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

export type PrettyJs = {
  text: string;
  /** Raw offsets before which text was inserted, ascending, with the cumulative inserted length up to and including each. */
  at: number[];
  cum: number[];
};

const isIdent = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x24 || c === 0x5f || c >= 0x80;

type Ctx = { kind: "root" | "brace" | "tpl"; brackets: number };

/** Insert line breaks into (minified) JavaScript; see the file comment for the rules. */
export function prettyJs(src: string): PrettyJs {
  const out: string[] = [];
  const at: number[] = [];
  const cum: number[] = [];
  let inserted = 0;
  let last = 0; // raw offset up to which `src` was copied to `out`
  const stack: Ctx[] = [{ kind: "root", brackets: 0 }];
  let braces = 0; // "brace" contexts on the stack (the indent level)
  let tpl = 0; // "tpl" contexts on the stack: no breaks inside template expressions
  // Previous significant token: "word" (identifier / number / keyword), "close" (`)` `]` `}`), "punct".
  let prev: "word" | "close" | "punct" = "punct";
  let prevWord = "";
  const n = src.length;
  let i = 0;

  const top = (): Ctx => stack[stack.length - 1] ?? { kind: "root", brackets: 0 };
  const breakAfter = (pos: number) => {
    // pos: raw offset just after the token
    if (tpl > 0 || top().brackets !== 0) return;
    let j = pos;
    while (j < n && (src.charCodeAt(j) === 0x20 || src.charCodeAt(j) === 0x09)) j++;
    if (j >= n) return;
    const next = src.charCodeAt(j);
    if (next === 0x0a || next === 0x0d) return; // already a line break
    const tokenChar = src.charCodeAt(pos - 1);
    if (tokenChar === 0x7d /* } */ && (next === 0x29 || next === 0x5d || next === 0x2c || next === 0x3b || next === 0x2e)) return; // `})`, `}]`, `},`, `};`, `}.`
    if (tokenChar === 0x7b /* { */ && next === 0x7d) return; // empty block `{}`
    if (next === 0x2f && (src.charCodeAt(j + 1) === 0x2f || src.charCodeAt(j + 1) === 0x2a)) return; // a comment follows on the same line
    const level = Math.max(0, Math.min(MAX_INDENT, next === 0x7d ? braces - 1 : braces));
    const ins = `\n${"  ".repeat(level)}`;
    out.push(src.slice(last, j), ins);
    last = j;
    inserted += ins.length;
    at.push(j);
    cum.push(inserted);
  };

  // Skip a quoted string starting at the quote at i; returns the offset after it.
  const skipString = (q: number, from: number): number => {
    let k = from + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 0x5c) k += 2;
      else if (c === q) return k + 1;
      else if (c === 0x0a) return k; // unterminated: stop at the line end
      else k++;
    }
    return n;
  };
  const skipRegex = (from: number): number => {
    let k = from + 1;
    let inClass = false;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 0x5c) k += 2;
      else if (c === 0x0a) return k;
      else if (inClass) {
        if (c === 0x5d) inClass = false;
        k++;
      } else if (c === 0x5b) {
        inClass = true;
        k++;
      } else if (c === 0x2f) {
        k++;
        while (k < n && isIdent(src.charCodeAt(k))) k++; // flags
        return k;
      } else k++;
    }
    return n;
  };
  // Inside a template literal from `from` (just after "`" or "}"): returns the offset after the closing "`", or after "${" (then pushes a context).
  const scanTemplate = (from: number): number => {
    let k = from;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 0x5c) k += 2;
      else if (c === 0x60) return k + 1;
      else if (c === 0x24 && src.charCodeAt(k + 1) === 0x7b) {
        stack.push({ kind: "tpl", brackets: 0 });
        tpl++;
        return k + 2;
      } else k++;
    }
    return n;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // whitespace
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i++;
      continue;
    }
    // comments
    if (c === 0x2f && src.charCodeAt(i + 1) === 0x2f) {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === 0x2f && src.charCodeAt(i + 1) === 0x2a) {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      i = skipString(c, i);
      prev = "word";
      prevWord = "";
      continue;
    }
    if (c === 0x60) {
      i = scanTemplate(i + 1);
      // A finished template is a value; an opened `${` context is code (prev reset).
      prev = top().kind === "tpl" && src.charCodeAt(i - 1) === 0x7b ? "punct" : "word";
      prevWord = "";
      continue;
    }
    if (c === 0x2f) {
      const regex = prev === "punct" || (prev === "word" && REGEX_AFTER_WORDS.has(prevWord));
      if (regex) {
        i = skipRegex(i);
        prev = "word";
        prevWord = "";
      } else {
        i++;
        prev = "punct";
      }
      continue;
    }
    if (isIdent(c)) {
      let k = i + 1;
      while (k < n && isIdent(src.charCodeAt(k))) k++;
      prevWord = src.slice(i, k);
      prev = "word";
      i = k;
      continue;
    }
    i++;
    switch (c) {
      case 0x28: // (
      case 0x5b: // [
        top().brackets++;
        prev = "punct";
        break;
      case 0x29: // )
      case 0x5d: {
        // ]
        const t = top();
        if (t.brackets > 0) t.brackets--;
        prev = "close";
        break;
      }
      case 0x7b: // {
        stack.push({ kind: "brace", brackets: 0 });
        braces++;
        prev = "punct";
        breakAfter(i);
        break;
      case 0x7d: {
        // }
        const t = top();
        if (t.kind === "tpl") {
          stack.pop();
          tpl--;
          i = scanTemplate(i);
          prev = top().kind === "tpl" && src.charCodeAt(i - 1) === 0x7b ? "punct" : "word";
          prevWord = "";
          break;
        }
        if (t.kind === "brace") {
          stack.pop();
          braces--;
        }
        prev = "close";
        breakAfter(i);
        break;
      }
      case 0x3b: // ;
      case 0x2c: // ,
        prev = "punct";
        breakAfter(i);
        break;
      default:
        prev = "punct";
    }
    prevWord = "";
  }
  out.push(src.slice(last));
  return { text: out.join(""), at, cum };
}

/** Pretty offset of a raw offset (text inserted before raw offset k lands before it). */
export function mapOffset(p: PrettyJs, raw: number): number {
  // Number of insertions at raw offsets <= raw (binary search over the ascending `at`).
  let lo = 0;
  let hi = p.at.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((p.at[mid] ?? Number.MAX_SAFE_INTEGER) <= raw) lo = mid + 1;
    else hi = mid;
  }
  return raw + (lo === 0 ? 0 : (p.cum[lo - 1] ?? 0));
}

/** JSON re-indented with 2 spaces, or null when it does not parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Which pretty-printer a body gets: by MIME type, or by resource type for scripts served as something else. */
export function prettyKind(mime: string | null, resourceType: string | null): "js" | "json" | null {
  const m = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (m.includes("json")) return "json";
  if (m.includes("javascript") || m.includes("ecmascript")) return "js";
  if (resourceType === "script") return "js";
  return null;
}
