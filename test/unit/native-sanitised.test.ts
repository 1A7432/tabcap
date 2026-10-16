// native/wireprint/ is imported from the author's own workspace: nothing in it
// may carry internal wording (the release FORBIDDEN list), personal paths,
// real MAC addresses or private IPv4 / link-local addresses. Build outputs
// (.zig-cache, zig-out) are git-ignored and not scanned.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FORBIDDEN } from "../../scripts/release.ts";
import { REPO_ROOT } from "./_fixtures.ts";

const NATIVE = join(REPO_ROOT, "native", "wireprint");
const SKIP_DIRS = new Set([".zig-cache", "zig-out", "zig-pkg"]);

const PERSONAL_PATH = /\/Users\//;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
const PRIVATE_IPV4 = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/;
const LINK_LOCAL_V6 = /\bfe80::/i;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...files(join(dir, e.name)));
    } else if (e.isFile()) out.push(join(dir, e.name));
  }
  return out;
}

/** A MAC is acceptable only when locally administered (bit 0x02 of the first octet) or broadcast. */
export function realMacs(text: string): string[] {
  return [...text.matchAll(MAC)].map((m) => m[0]).filter((mac) => {
    const first = Number.parseInt(mac.slice(0, 2), 16);
    return (first & 0x02) === 0 && mac.toLowerCase().replace(/-/g, ":") !== "ff:ff:ff:ff:ff:ff";
  });
}

export function hits(text: string): string[] {
  const out = FORBIDDEN.filter((re) => re.test(text)).map(String);
  if (PERSONAL_PATH.test(text)) out.push(String(PERSONAL_PATH));
  if (PRIVATE_IPV4.test(text)) out.push("private IPv4");
  if (LINK_LOCAL_V6.test(text)) out.push("IPv6 link-local");
  const macs = realMacs(text);
  if (macs.length > 0) out.push(`MAC ${macs.join(", ")}`);
  return out;
}

describe("native/wireprint is sanitised", () => {
  test("the checks catch what they are meant to catch", () => {
    expect(hits("see /Users/someone/x")).toContain(String(PERSONAL_PATH));
    expect(hits("gw 192.168.1.1")).toContain("private IPv4");
    expect(hits("host 10.0.0.7 and 172.20.1.2")).toContain("private IPv4");
    expect(hits("fe80::1%en0")).toContain("IPv6 link-local");
    expect(hits("a4:83:e7:12:34:56")).toEqual(["MAC a4:83:e7:12:34:56"]);
    expect(hits("占位")).toEqual([String(/占位/)]);
    // Synthetic fixture addresses stay allowed: documentation prefixes, loopback,
    // locally administered and broadcast MACs, version-like strings.
    expect(hits("192.0.2.23 2001:db8::17 127.0.0.1 02:00:00:00:00:17 ff:ff:ff:ff:ff:ff Mac OS X 10_15_7 153.0.8010.53")).toEqual([]);
  });

  test("no file carries forbidden wording, personal paths, real MACs or private addresses", () => {
    const all = files(NATIVE);
    expect(all.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const f of all) {
      // latin1 keeps every byte, so binary fixtures are scanned too (ASCII matches only).
      const raw = readFileSync(f);
      const text = raw.toString("utf8").includes("�") ? raw.toString("latin1") : raw.toString("utf8");
      const h = hits(text);
      if (h.length > 0) bad.push(`${relative(NATIVE, f)}: ${h.join("; ")}`);
    }
    expect(bad).toEqual([]);
  });
});
