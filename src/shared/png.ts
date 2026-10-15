// Minimal PNG reader: dimensions from IHDR, and a "single colour?" check over
// decoded pixels (8-bit RGB / RGBA / grey, non-interlaced). Used to detect
// blank screenshots of hidden tabs. Input is untrusted: anything unexpected
// yields null instead of throwing.

import { inflateSync } from "node:zlib";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; interlace: number };

export function pngInfo(b: Uint8Array): PngInfo | null {
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0) !== "IHDR") return null;
  return { width: dv.getUint32(16), height: dv.getUint32(20), bitDepth: b[24] ?? 0, colorType: b[25] ?? 0, interlace: b[28] ?? 0 };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** True when every pixel has the same value; null when the PNG cannot be decoded here. */
export function pngIsUniform(b: Uint8Array): boolean | null {
  const info = pngInfo(b);
  const ch = info === null ? undefined : CHANNELS[info.colorType];
  if (info === null || ch === undefined || info.bitDepth !== 8 || info.interlace !== 0) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= b.length; ) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4] ?? 0, b[off + 5] ?? 0, b[off + 6] ?? 0, b[off + 7] ?? 0);
    if (off + 12 + len > b.length) return null;
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  } catch {
    return null;
  }
  const stride = info.width * ch;
  if (raw.length < info.height * (stride + 1)) return null;
  let prev = new Uint8Array(stride);
  let first: Uint8Array | null = null;
  for (let y = 0; y < info.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? (cur[x - ch] ?? 0) : 0;
      const up = prev[x] ?? 0;
      const ul = x >= ch ? (prev[x - ch] ?? 0) : 0;
      const v = line[x] ?? 0;
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + left; break;
        case 2: out = v + up; break;
        case 3: out = v + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          out = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: return null;
      }
      cur[x] = out & 0xff;
    }
    if (first === null) first = cur.slice(0, ch);
    for (let x = 0; x < stride; x++) if (cur[x] !== first[x % ch]) return false;
    prev = cur;
  }
  return true;
}

/** Width / height of a PNG, JPEG or WebP image (untrusted bytes; null when it cannot tell). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const png = pngInfo(b);
  if (png !== null) return { width: png.width, height: png.height };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // JPEG: walk the markers to the first SOFn (C0–CF except C4, C8, CC).
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let off = 2; off + 9 < b.length; ) {
      if (b[off] !== 0xff) return null;
      const m = b[off + 1] ?? 0;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = dv.getUint16(off + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7) };
      if (len < 2) return null;
      off += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  const tag = (o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
  if (b.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const chunk = tag(12);
    if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const u24 = (o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
      return { width: u24(24) + 1, height: u24(27) + 1 };
    }
  }
  return null;
}
