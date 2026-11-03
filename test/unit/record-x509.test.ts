// 0.9-F ephemeral CA (docs/04 §50.1). Oracles: node:crypto X509Certificate
// (issuer check, signature, SAN, validity, CA flag) and, when the machine has
// it, `openssl verify -x509_strict` plus `openssl x509 -text` for the
// extensions Python 3.13's VERIFY_X509_STRICT looks at (AKI, basic constraints).

import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthority, ipBytes } from "../../src/record/x509.ts";

const hasOpenssl = Bun.which("openssl") !== null;

describe("createAuthority", () => {
  test("CA and leaves read back with node:crypto: issuer, signature, SAN, validity", async () => {
    const now = Date.UTC(2026, 10, 3, 4, 5, 6);
    const ca = await createAuthority("abcd1234", now);
    const c = new X509Certificate(ca.certPem);
    expect(c.ca).toBe(true);
    expect(c.subject).toBe("CN=tabcap record abcd1234");
    expect(c.issuer).toBe(c.subject);
    expect(new Date(c.validFrom).getTime()).toBe(now - 3600_000);
    expect(new Date(c.validTo).getTime()).toBe(now + 7 * 86400_000);
    for (const [host, san] of [
      ["localhost", "DNS:localhost"],
      ["API.Example.test", "DNS:api.example.test"],
      ["127.0.0.1", "IP Address:127.0.0.1"],
      ["::1", "IP Address:0:0:0:0:0:0:0:1"],
    ] as const) {
      const l = new X509Certificate(await ca.leafFor(host));
      expect(l.ca).toBe(false);
      expect(l.subjectAltName).toBe(san);
      expect(l.checkIssued(c)).toBe(true);
      expect(l.verify(c.publicKey)).toBe(true);
      expect(l.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]); // node reports extKeyUsage here: serverAuth
    }
    expect(ca.issued).toBe(4);
    await ca.leafFor("localhost");
    expect(ca.issued).toBe(4); // cached per host
  });

  test("two runs have different CAs; a run's leaf does not verify under another run's CA", async () => {
    const a = await createAuthority("a");
    const b = await createAuthority("b");
    const leaf = new X509Certificate(await a.leafFor("localhost"));
    expect(leaf.verify(new X509Certificate(b.certPem).publicKey)).toBe(false);
  });

  test.skipIf(!hasOpenssl)("openssl verify -x509_strict accepts the leaves; AKI and critical basic constraints are there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-x509-"));
    try {
      const ca = await createAuthority("strict");
      writeFileSync(join(dir, "ca.pem"), ca.certPem);
      for (const host of ["localhost", "127.0.0.1", "::1"]) {
        const f = join(dir, `${host.replace(/:/g, "_")}.pem`);
        writeFileSync(f, await ca.leafFor(host));
        const v = Bun.spawnSync(["openssl", "verify", "-x509_strict", "-CAfile", join(dir, "ca.pem"), f]);
        expect(v.stdout.toString().trim()).toBe(`${f}: OK`);
        const text = Bun.spawnSync(["openssl", "x509", "-in", f, "-noout", "-text"]).stdout.toString();
        expect(text).toContain("X509v3 Authority Key Identifier");
        expect(text).toContain("X509v3 Subject Key Identifier");
        expect(text).toMatch(/X509v3 Basic Constraints: critical/);
        expect(text).toContain("TLS Web Server Authentication");
      }
      const caText = Bun.spawnSync(["openssl", "x509", "-in", join(dir, "ca.pem"), "-noout", "-text"]).stdout.toString();
      expect(caText).toMatch(/CA:TRUE, pathlen:0/);
      expect(caText).toMatch(/Certificate Sign, CRL Sign/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ipBytes", () => {
  test("IPv4, IPv6 (compressed, bracketed, embedded IPv4) and names", () => {
    expect([...(ipBytes("10.1.2.3") ?? [])]).toEqual([10, 1, 2, 3]);
    expect([...(ipBytes("[::1]") ?? [])]).toEqual([...new Array<number>(15).fill(0), 1]);
    expect([...(ipBytes("2001:db8::1") ?? [])]).toEqual([0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 1]);
    expect([...(ipBytes("::ffff:1.2.3.4") ?? [])]).toEqual([...new Array<number>(10).fill(0), 0xff, 0xff, 1, 2, 3, 4]);
    expect(ipBytes("example.test")).toBeNull();
  });
});
