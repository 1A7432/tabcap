// Text codecs shared by the decode chain (decoders.ts) and the embedded-state
// scanner (embedded.ts): strict base64, HTML character references, and the
// size cap of one decode step. A leaf module (it imports nothing of src/), so
// neither of the two needs the other for these (review wave 3: the import
// cycle decoders.ts <-> embedded.ts).
// Spec: RFC 4648 §4 / §5 (base64, base64url), the HTML Living Standard's
// named / numeric character references (a common subset of the names).
// Oracle: test/unit/find.test.ts (decodeBase64Strict, decodeHtmlEntities) and
// test/unit/embedded.test.ts (viewstate fields). Reproduce:
//   bun test test/unit/find.test.ts test/unit/embedded.test.ts

/** Size cap of one decode step's output: 32 MiB, the body cap (docs/04 decision c). */
export const STEP_CAP = 32 * 1024 * 1024;

/** Shortest text decodeBase64Strict takes by default: plain words would otherwise "decode". */
const MIN_BASE64 = 12;

const B64_STD = /^[A-Za-z0-9+/]+={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Strict base64: one alphabet (standard or url-safe), '=' only as final
 * padding to a multiple of 4, or no padding at all (length % 4 != 1).
 * Whitespace (line wrapping) is
 * ignored. Returns null for anything else, including strings shorter than
 * `min` characters (default MIN_BASE64: plain words would otherwise "decode";
 * a field known to be base64, such as a viewstate, passes a smaller one).
 */
export function decodeBase64Strict(text: string, min: number = MIN_BASE64): Uint8Array | null {
  if (text.length < min || text.length > STEP_CAP * 2) return null;
  const s = /\s/.test(text) ? text.replace(/\s+/g, "") : text;
  if (s.length < min) return null;
  const padded = s.endsWith("=");
  let std: string;
  if (B64_STD.test(s) && (padded ? s.length % 4 === 0 : s.length % 4 !== 1)) std = s;
  else if (B64_URL.test(s) && (padded ? s.length % 4 === 0 : s.length % 4 !== 1)) std = s.replace(/-/g, "+").replace(/_/g, "/");
  else return null;
  std += "=".repeat((4 - (std.length % 4)) % 4); // unpadded input (base64url style)
  const pad = std.endsWith("==") ? 2 : std.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(Buffer.from(std, "base64"));
  // Round trip guards against Buffer's lenient decoder accepting junk bits.
  if (out.length !== (std.length / 4) * 3 - pad) return null;
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", middot: "·", bull: "•", times: "×", divide: "÷",
  yen: "¥", euro: "€", pound: "£", cent: "¢", deg: "°", plusmn: "±", sect: "§", para: "¶", iexcl: "¡",
  iquest: "¿", shy: "­", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", check: "✓", hearts: "♥", star: "☆", starf: "★",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", micro: "µ", permil: "‰", prime: "′", Prime: "″",
  dagger: "†", Dagger: "‡", circ: "ˆ", tilde: "˜", acute: "´", cedil: "¸", uml: "¨", macr: "¯", ordf: "ª", ordm: "º",
  not: "¬", brvbar: "¦", curren: "¤", infin: "∞", ne: "≠", le: "≤", ge: "≥", minus: "−", lowast: "∗",
};

const ENTITY = /&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

/** Decode HTML named (common subset) and numeric character references. Null when there are none. */
export function decodeHtmlEntities(text: string): string | null {
  let changed = false;
  const out = text.replace(ENTITY, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      changed = true;
      return codePointToString(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      changed = true;
      return codePointToString(parseInt(body.slice(1), 10));
    }
    const v = NAMED_ENTITIES[body];
    if (v === undefined) return m;
    changed = true;
    return v;
  });
  return changed ? out : null;
}
