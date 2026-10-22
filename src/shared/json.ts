// Small runtime checks for untrusted JSON (bundle files, HAR imports).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}

export function num(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function bool(o: Record<string, unknown>, key: string): boolean | null {
  const v = o[key];
  return typeof v === "boolean" ? v : null;
}

export function rec(o: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = o[key];
  return isRecord(v) ? v : null;
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `text` without one leading byte order mark (U+FEFF, as Windows editors save
 * it); anything else unchanged. RFC 8259 §8.1: a parser may ignore a BOM
 * rather than treat it as an error, but JSON.parse refuses one. Only one is
 * dropped, so a second is still a syntax error.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Type guard: `v` is one of the string literals in `list`. */
export function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX = /^[0-9A-Fa-f]$/;

/**
 * Where `text` stops being JSON (RFC 8259): the UTF-16 offset of the first
 * character that cannot continue the document (`text.length` when it ends too
 * early), or null when it is valid. For error messages only: Bun's JSON.parse
 * says what is wrong but not where. Iterative, so deep nesting cannot overflow
 * the stack. No byte order mark is accepted (JSON.parse does not accept one).
 */
export function jsonSyntaxErrorAt(text: string): number | null {
  const n = text.length;
  let i = 0;
  const stack: Array<"{" | "["> = [];
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      i++;
    }
  };
  // At a '"': past the closing quote (true), or at the offending character (false).
  const string = (): boolean => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return true;
      }
      if (c < 0x20) return false;
      if (c !== 0x5c) {
        i++;
        continue;
      }
      i++;
      const e = text[i];
      if (e === undefined) return false;
      if (JSON_ESCAPES.has(e)) {
        i++;
        continue;
      }
      if (e !== "u") return false;
      for (let k = 1; k <= 4; k++) {
        if (!HEX.test(text[i + k] ?? "")) {
          i += k;
          return false;
        }
      }
      i += 5;
    }
    return false;
  };
  // At the start of an object member: past `"name" :` (true), or at the offending character.
  const member = (): boolean => {
    ws();
    if (text[i] !== '"' || !string()) return false;
    ws();
    if (text[i] !== ":") return false;
    i++;
    return true;
  };
  let wantValue = true;
  for (;;) {
    ws();
    if (wantValue) {
      const c = text[i];
      if (c === undefined) return i;
      if (c === "{" || c === "[") {
        i++;
        ws();
        if (text[i] === (c === "{" ? "}" : "]")) {
          i++;
          wantValue = false;
          continue;
        }
        stack.push(c);
        if (c === "{" && !member()) return i;
        continue;
      }
      if (c === '"') {
        if (!string()) return i;
        wantValue = false;
        continue;
      }
      JSON_NUMBER.lastIndex = i;
      const num = JSON_NUMBER.exec(text);
      if (num !== null) {
        i += num[0].length;
        wantValue = false;
        continue;
      }
      const lit = ["true", "false", "null"].find((w) => text.startsWith(w, i));
      if (lit === undefined) return i;
      i += lit.length;
      wantValue = false;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === undefined) return i < n ? i : null;
    const c = text[i];
    if (c === ",") {
      i++;
      if (top === "{" && !member()) return i;
      wantValue = true;
      continue;
    }
    if (c !== (top === "{" ? "}" : "]")) return i;
    i++;
    stack.pop();
  }
}

/** 1-based line and column (UTF-16 units) of `offset` in `text`; lines end at "\n". */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastNl };
}
