// Identifier helpers (docs/04 §6). All ids are derived from `seq`, except
// tab ids (attach order), blob refs (content hash) and the manifest ULID.

import { createHash, randomBytes } from "node:crypto";

export const tabId = (n: number): string => `t${n}`;
export const navId = (seq: number): string => `n-${seq}`;
export const requestId = (seq: number): string => `r-${seq}`;
export const cmdId = (seq: number): string => `c-${seq}`;

const BLOB_REF = /^sha256:[0-9a-f]{64}$/;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function blobRef(hex: string): string {
  const ref = `sha256:${hex.toLowerCase()}`;
  if (!BLOB_REF.test(ref)) throw new TypeError(`not a sha256 hex digest: ${hex}`);
  return ref;
}

export function isBlobRef(value: unknown): value is string {
  return typeof value === "string" && BLOB_REF.test(value);
}

/** `sha256:<hex>` -> `<hex>`, or null when the ref is malformed. */
export function blobHex(ref: string): string | null {
  return BLOB_REF.test(ref) ? ref.slice("sha256:".length) : null;
}

/** Parse `r-57` / `n-3` / `c-9` back to the seq, or null. */
export function seqOf(id: string, prefix: "r" | "n" | "c"): number | null {
  const m = /^([rnc])-(\d+)$/.exec(id);
  if (m === null || m[1] !== prefix || m[2] === undefined) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ULID (https://github.com/ulid/spec): 48-bit ms timestamp + 80 random bits,
// Crockford base32, 26 chars. Written here to stay dependency free.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(timeMs: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > 0xffffffffffff) {
    throw new RangeError(`ULID time out of range: ${timeMs}`);
  }
  if (random.length !== 10) throw new RangeError("ULID randomness must be 10 bytes");
  let out = "";
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[t % 32] ?? "0") + out;
    t = Math.floor(t / 32);
  }
  // 80 bits -> 16 base32 chars, consumed 5 bits at a time, MSB first.
  let acc = 0;
  let bits = 0;
  for (const byte of random) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31] ?? "0";
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}
