// The wire echo's certificate: one test CA and a leaf for localhost /
// 127.0.0.1 / probe.test (with Authority Key Identifier, which Python 3.13's
// strict verification and rustls require). Generated once with openssl and
// committed under src/wire/certs/; the private key is public by design and
// only ever serves 127.0.0.1 (README there). Embedded as text, so a compiled
// tabcap carries them; clients get the CA as a file (`tabcap wire ca-path`).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import CA_PEM from "./certs/ca.pem" with { type: "text" };
import LEAF_PEM from "./certs/leaf.pem" with { type: "text" };
import LEAF_KEY_PEM from "./certs/leaf-key.pem" with { type: "text" };

export const CA_CERT = CA_PEM;
export const LEAF_CERT = LEAF_PEM;
export const LEAF_KEY = LEAF_KEY_PEM;

export const CA_FILE_NAME = "tabcap-wire-ca.pem";

/** <cache>/wire/tabcap-wire-ca.pem, written when missing or different (the CA certificate only, never a key). */
export function caPath(cacheDir: string): string {
  const dir = join(cacheDir, "wire");
  const file = join(dir, CA_FILE_NAME);
  if (existsSync(file) && readFileSync(file, "utf8") === CA_CERT) return file;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, CA_CERT, { mode: 0o644 });
  renameSync(tmp, file);
  return file;
}
