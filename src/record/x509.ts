// Ephemeral certificate authority for `tabcap record` and `replay serve -- <cmd>`
// (0.9-F, docs/04 §50.1). Bun parses X.509 but cannot issue it, so the
// certificates are built here: WebCrypto ECDSA P-256 keys, a hand-assembled
// DER TBSCertificate (RFC 5280 §4.1), signed with ecdsa-with-SHA256.
// CA: basicConstraints critical CA:TRUE pathlen 0, keyUsage critical
// keyCertSign|cRLSign, subjectKeyIdentifier. Leaf: basicConstraints critical
// (empty), keyUsage critical digitalSignature, extKeyUsage serverAuth,
// subjectAltName (dNSName or iPAddress), subjectKeyIdentifier,
// authorityKeyIdentifier (Python 3.13 VERIFY_X509_STRICT needs it; see
// src/wire/certs.ts). Validity: one hour before now to seven days after.
// The CA private key is a non-extractable CryptoKey: it is never serialised.
// One leaf key pair per run (PEM, memory only) serves every host's certificate.
// Oracle: node:crypto X509Certificate (checkIssued / verify / subjectAltName)
// and `openssl verify -x509_strict` in test/unit/record-x509.test.ts.
// Reproduce: bun test test/unit/record-x509.test.ts

import { isIP } from "node:net";

const te = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

function tlv(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return cat(new Uint8Array([tag, ...len]), body);
}

const seq = (...p: Uint8Array[]) => tlv(0x30, cat(...p));
const set = (...p: Uint8Array[]) => tlv(0x31, cat(...p));
const octets = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, cat(new Uint8Array([0]), b));
const utf8String = (s: string) => tlv(0x0c, te.encode(s));
const TRUE = tlv(0x01, new Uint8Array([0xff]));
/** Context-specific tag [n]: constructed (explicit) or primitive (implicit). */
const ctx = (n: number, body: Uint8Array, constructed: boolean) => tlv((constructed ? 0xa0 : 0x80) | n, body);

/** DER INTEGER of unsigned big-endian bytes. */
function integer(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const t = b.slice(i);
  return tlv(0x02, (t[0] ?? 0) & 0x80 ? cat(new Uint8Array([0]), t) : t);
}

function oid(dotted: string): Uint8Array {
  const p = dotted.split(".").map(Number);
  const out = [40 * (p[0] ?? 0) + (p[1] ?? 0)];
  for (const v of p.slice(2)) {
    const t = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) t.unshift((x & 0x7f) | 0x80);
    out.push(...t);
  }
  return tlv(0x06, new Uint8Array(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(ms: number): Uint8Array {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString(); // 2026-11-03T04:05:06.000Z
  const digits = iso.replace(/[-:T]/g, "").slice(0, 14); // 20261103040506
  const year = Number(digits.slice(0, 4));
  return year < 2050 ? tlv(0x17, te.encode(`${digits.slice(2)}Z`)) : tlv(0x18, te.encode(`${digits}Z`));
}

const commonName = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8String(cn.slice(0, 64)))));
const extension = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [TRUE] : []), octets(value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

function sha1(b: Uint8Array): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha1").update(b).digest());
}

/** RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits (the 65-byte uncompressed P-256 point ends the SPKI). */
function keyId(spki: Uint8Array): Uint8Array {
  return sha1(spki.slice(spki.length - 65));
}

/** WebCrypto's raw r||s signature → DER Ecdsa-Sig-Value. */
function signatureDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(integer(raw.slice(0, half)), integer(raw.slice(half)));
}

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** IPv4 / IPv6 literal → 4 / 16 bytes; null for a host name. */
export function ipBytes(host: string): Uint8Array | null {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const kind = isIP(h);
  if (kind === 4) return new Uint8Array(h.split(".").map(Number));
  if (kind !== 6) return null;
  const [head = "", tail = ""] = h.includes("::") ? h.split("::") : [h, ""];
  const words = (s: string) => (s === "" ? [] : s.split(":"));
  let hw = words(head);
  let tw = words(tail);
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two words.
  const v4 = (ws: string[]) => {
    const last = ws[ws.length - 1];
    if (last === undefined || !last.includes(".")) return ws;
    const b = last.split(".").map(Number);
    return [...ws.slice(0, -1), (((b[0] ?? 0) << 8) | (b[1] ?? 0)).toString(16), (((b[2] ?? 0) << 8) | (b[3] ?? 0)).toString(16)];
  };
  if (tw.length > 0) tw = v4(tw);
  else hw = v4(hw);
  const fill = h.includes("::") ? new Array<string>(8 - hw.length - tw.length).fill("0") : [];
  const all = [...hw, ...fill, ...tw];
  const out = new Uint8Array(16);
  all.forEach((w, i) => {
    const n = parseInt(w, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

export type CertAuthority = {
  /** The CA certificate (PEM): the only part that is written to disk, for the child's trust settings. */
  certPem: string;
  /** Subject common name (names the run). */
  name: string;
  /** Leaf certificate (PEM) for a host, issued once per host and cached. */
  leafFor: (host: string) => Promise<string>;
  /** The private key (PKCS#8 PEM) every leaf certificate carries. */
  leafKeyPem: string;
  /** How many leaf certificates were issued. */
  readonly issued: number;
};

type Signer = { key: CryptoKey; name: string; keyId: Uint8Array };

async function certificate(o: { subject: Uint8Array; issuer: Uint8Array; spki: Uint8Array; extensions: Uint8Array[]; signer: CryptoKey; now: number }): Promise<Uint8Array> {
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] ?? 0) & 0x7f; // positive
  const tbs = seq(
    ctx(0, integer(new Uint8Array([2])), true), // v3
    integer(serial),
    ECDSA_SHA256,
    o.issuer,
    seq(time(o.now - 3600_000), time(o.now + 7 * 86400_000)),
    o.subject,
    o.spki,
    ctx(3, seq(...o.extensions), true),
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.signer, new Uint8Array(tbs)));
  return seq(tbs, ECDSA_SHA256, bitString(signatureDer(sig)));
}

function subjectAltName(host: string): Uint8Array {
  const ip = ipBytes(host);
  return seq(ip !== null ? ctx(7, ip, false) : ctx(2, te.encode(host.toLowerCase()), false));
}

/** A new CA for one run, with its leaf issuer. `now` for tests. */
export async function createAuthority(runId: string, now: number = Date.now()): Promise<CertAuthority> {
  const name = `tabcap record ${runId}`;
  const ca = (await crypto.subtle.generateKey(ALG, false, ["sign", "verify"])) as CryptoKeyPair;
  const caSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ca.publicKey));
  const signer: Signer = { key: ca.privateKey, name, keyId: keyId(caSpki) };
  const caDer = await certificate({
    subject: commonName(name),
    issuer: commonName(name),
    spki: caSpki,
    extensions: [
      extension("2.5.29.19", true, seq(TRUE, integer(new Uint8Array([0])))),
      extension("2.5.29.15", true, bitString(new Uint8Array([0x06]))), // keyCertSign | cRLSign
      extension("2.5.29.14", false, octets(signer.keyId)),
    ],
    signer: signer.key,
    now,
  });
  const leafKeys = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const leafSpki = new Uint8Array(await crypto.subtle.exportKey("spki", leafKeys.publicKey));
  const leafKeyPem = pem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", leafKeys.privateKey)));
  const leafKeyId = keyId(leafSpki);
  const cache = new Map<string, Promise<string>>();
  let issued = 0;
  const leafFor = (host: string): Promise<string> => {
    const h = host.toLowerCase();
    let p = cache.get(h);
    if (p === undefined) {
      issued++;
      p = certificate({
        subject: commonName(h),
        issuer: commonName(name),
        spki: leafSpki,
        extensions: [
          extension("2.5.29.19", true, seq()),
          extension("2.5.29.15", true, bitString(new Uint8Array([0x80]))), // digitalSignature
          extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
          extension("2.5.29.17", false, subjectAltName(h)),
          extension("2.5.29.14", false, octets(leafKeyId)),
          extension("2.5.29.35", false, seq(ctx(0, signer.keyId, false))),
        ],
        signer: signer.key,
        now,
      }).then((der) => pem("CERTIFICATE", der));
      cache.set(h, p);
    }
    return p;
  };
  return {
    certPem: pem("CERTIFICATE", caDer),
    name,
    leafFor,
    leafKeyPem,
    get issued() {
      return issued;
    },
  };
}
