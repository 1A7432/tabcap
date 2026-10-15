// Content-addressed blob store: <bundle>/blobs/sha256/<xx>/<64 hex> (docs/04 §2).
// Writes go to a temp file in the target directory, are fsynced, then renamed
// onto the hash name, so a crash never leaves a partial blob under a hash.
// Same content is stored once. Bodies over `sizeCap` are not written (§5.2.4).
// Files 0600, directories 0700, like the rest of the bundle (docs/04 §16).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { open, rename, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TabcapError } from "../shared/envelope.ts";
import { blobHex, blobRef, sha256Hex } from "../shared/ids.ts";

export const DEFAULT_SIZE_CAP = 32 * 1024 * 1024; // 32 MiB, decision c

export type PutResult =
  | { outcome: "stored"; ref: string; size: number; existed: boolean }
  | { outcome: "too-large"; size: number; cap: number };

export type BlobStoreOptions = { sizeCap?: number };

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export class BlobStore {
  readonly root: string;
  readonly sizeCap: number;

  constructor(bundleDir: string, opts: BlobStoreOptions = {}) {
    this.root = join(bundleDir, "blobs", "sha256");
    this.sizeCap = opts.sizeCap ?? DEFAULT_SIZE_CAP;
  }

  /** Path of a blob on disk, or null when the ref is malformed. */
  pathOf(ref: string): string | null {
    const hex = blobHex(ref);
    return hex === null ? null : join(this.root, hex.slice(0, 2), hex);
  }

  has(ref: string): boolean {
    const p = this.pathOf(ref);
    return p !== null && existsSync(p);
  }

  async put(data: Uint8Array | string): Promise<PutResult> {
    const bytes = toBytes(data);
    if (bytes.length > this.sizeCap) return { outcome: "too-large", size: bytes.length, cap: this.sizeCap };
    const hex = sha256Hex(bytes);
    const ref = blobRef(hex);
    const dir = join(this.root, hex.slice(0, 2));
    const target = join(dir, hex);
    if (await exists(target)) return { outcome: "stored", ref, size: bytes.length, existed: true };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw new TabcapError("io", `cannot store blob ${ref}: ${e instanceof Error ? e.message : String(e)}`, "Check free disk space and permissions on the bundle directory.");
    }
    return { outcome: "stored", ref, size: bytes.length, existed: false };
  }

  /** Read a blob's bytes. Throws not-found / bad-input as TabcapError. */
  read(ref: string): Uint8Array {
    const p = this.pathOf(ref);
    if (p === null) throw new TabcapError("bad-input", `malformed blob ref: ${ref}`, "Blob refs look like sha256:<64 lowercase hex>.");
    if (!existsSync(p)) throw new TabcapError("not-found", `blob ${ref} is not in ${this.root}`, "The bundle is missing this blob; it may have been imported or copied partially.");
    return new Uint8Array(readFileSync(p));
  }

  /** Read or null when missing / malformed. */
  tryRead(ref: string): Uint8Array | null {
    const p = this.pathOf(ref);
    if (p === null || !existsSync(p)) return null;
    return new Uint8Array(readFileSync(p));
  }

  ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
