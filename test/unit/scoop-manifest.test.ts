// The Scoop manifest from a published release's SHA256SUMS (scripts/scoop-manifest.ts,
// run by .github/workflows/homebrew.yml): the four release-specific values change,
// everything else and the key order stay; an older release never overwrites a newer one.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSums } from "../../scripts/homebrew-formula.ts";
import { MANIFEST, RELEASES, compareVersions, manifestVersion, renderScoopManifest } from "../../scripts/scoop-manifest.ts";
import { isRecord } from "../../src/shared/json.ts";
import { REPO_ROOT } from "./_fixtures.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const W = "e".repeat(64);
// A fake SHA256SUMS of release 1.2.3 (sorted like scripts/release.ts writes it).
const SUMS = [`${"a".repeat(64)}  tabcap-v1.2.3-darwin-arm64.tar.gz`, `${"b".repeat(64)}  tabcap-v1.2.3-linux-arm64.tar.gz`, `${"c".repeat(64)}  tabcap-v1.2.3-linux-x64.tar.gz`, `${W}  tabcap-v1.2.3-windows-x64.zip`].join("\n") + "\n";
const CURRENT = readFileSync(MANIFEST, "utf8");

const obj = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error("not an object");
  return v;
};
const x64Of = (m: Record<string, unknown>) => obj(obj(m["architecture"])["64bit"]);

describe("Scoop manifest from a release's SHA256SUMS", () => {
  test("version, url, hash and extract_dir of that release; every other field and the key order kept", () => {
    const out = renderScoopManifest(CURRENT, "1.2.3", parseSums(SUMS));
    const m = obj(JSON.parse(out));
    const was = obj(JSON.parse(CURRENT));
    expect(m["version"]).toBe("1.2.3");
    expect(x64Of(m)).toEqual({ ...x64Of(was), url: `${RELEASES}/v1.2.3/tabcap-v1.2.3-windows-x64.zip`, hash: W, extract_dir: "tabcap-v1.2.3-windows-x64" });
    for (const k of Object.keys(was)) if (k !== "version" && k !== "architecture") expect(m[k]).toEqual(was[k]);
    expect(Object.keys(m)).toEqual(Object.keys(was));
    expect(Object.keys(x64Of(m))).toEqual(Object.keys(x64Of(was)));
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).toContain('\n    "version": "1.2.3",\n');
  });

  test("the checked-in manifest is what the script renders for its own version and hash", () => {
    const v = manifestVersion(CURRENT);
    const hash = String(x64Of(obj(JSON.parse(CURRENT)))["hash"]);
    expect(renderScoopManifest(CURRENT, v, new Map([[`tabcap-v${v}-windows-x64.zip`, hash]]))).toBe(CURRENT);
  });

  test("no line for the zip, a bad version or a manifest without architecture.64bit is an error", () => {
    expect(() => renderScoopManifest(CURRENT, "1.2.3", parseSums(SUMS.replace("windows-x64.zip", "windows-x64.tar.gz")))).toThrow(/tabcap-v1\.2\.3-windows-x64\.zip/);
    expect(() => renderScoopManifest(CURRENT, "v1.2.3", parseSums(SUMS))).toThrow(/major\.minor\.patch/);
    expect(() => renderScoopManifest("[]", "1.2.3", parseSums(SUMS))).toThrow(/not a JSON object/);
    expect(() => renderScoopManifest('{"architecture":{"32bit":{}}}', "1.2.3", parseSums(SUMS))).toThrow(/architecture\.64bit/);
    expect(() => manifestVersion('{"version":"next","architecture":{"64bit":{}}}')).toThrow(/major\.minor\.patch/);
  });

  test("versions compare numerically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.8.1", "0.8.1")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(() => compareVersions("0.8", "0.8.1")).toThrow(/major\.minor\.patch/);
  });

  test("the command writes a newer release and leaves the manifest alone for an older one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-scoop-"));
    try {
      const sums = join(dir, "SHA256SUMS");
      const manifest = join(dir, "tabcap.json");
      writeFileSync(sums, SUMS);
      writeFileSync(manifest, renderScoopManifest(CURRENT, "1.2.4", new Map([["tabcap-v1.2.4-windows-x64.zip", "f".repeat(64)]])));
      const before = readFileSync(manifest, "utf8");
      const cli = (...a: string[]) => Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "scoop-manifest.ts"), "--version", "1.2.3", "--sums", sums, "--manifest", manifest, "--out", manifest, ...a], { stdout: "pipe", stderr: "pipe" });
      const older = cli();
      expect([older.exitCode, older.stderr.toString().trim()]).toEqual([0, "the Scoop manifest already has 1.2.4, newer than 1.2.3: nothing written"]);
      expect(readFileSync(manifest, "utf8")).toBe(before);
      writeFileSync(manifest, CURRENT.replace(/"version": "[^"]+"/, '"version": "1.2.2"'));
      const newer = cli();
      expect(newer.exitCode).toBe(0);
      expect(readFileSync(manifest, "utf8")).toBe(renderScoopManifest(CURRENT, "1.2.3", parseSums(SUMS)));
    } finally {
      await removeTree(dir);
    }
  }, SLOW_IO_MS);
});
