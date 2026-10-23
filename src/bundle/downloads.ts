// Download files of an evidence bundle (0.9-D, docs/04 §48): a download that
// completed while the session recorded is moved from the browser run's staging
// directory into <bundle>/downloads/<sha256> (lowercase hex, no extension),
// one file per content, 0600 in a 0700 directory. The `download` event names
// it as "downloads/<sha256>". The staging file is Chrome's own (named by the
// download guid under `allowAndName`), so it is checked to be a plain file
// before it is read; a symlink or anything else is refused.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";

export const DOWNLOADS_DIR = "downloads";

export type StoredDownload = {
  /** "downloads/<sha256>", relative to the bundle directory. */
  file: string;
  sha256: string;
  bytes: number;
  /** A file with the same content was already in the bundle; the staging file was removed. */
  existed: boolean;
};

/** sha256 (lowercase hex) and size of a file, read as a stream (a download can be 200 MiB). */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const b = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
    h.update(b);
    bytes += b.length;
  }
  return { sha256: h.digest("hex"), bytes };
}

/**
 * Move a finished download into the bundle: hash it, then rename it to
 * downloads/<sha256> (a copy and unlink when the rename crosses file
 * systems). Same content twice is stored once. Throws `io` when the staging
 * path is not a plain file or cannot be read or moved.
 */
export async function storeDownload(bundleDir: string, staged: string): Promise<StoredDownload> {
  const st = lstatSync(staged, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) throw new TabcapError("io", "the finished download is not a plain file in the staging directory", "Nothing to do: the download is recorded without a file.");
  const { sha256, bytes } = await hashFile(staged);
  const dir = join(bundleDir, DOWNLOADS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dest = join(dir, sha256);
  const file = `${DOWNLOADS_DIR}/${sha256}`;
  if (existsSync(dest)) {
    rmSync(staged, { force: true });
    return { file, sha256, bytes, existed: true };
  }
  try {
    renameSync(staged, dest);
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "EXDEV") throw e;
    copyFileSync(staged, dest);
    rmSync(staged, { force: true });
  }
  chmodSync(dest, 0o600);
  return { file, sha256, bytes, existed: false };
}
