import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FORMULA_TARGETS, TEMPLATE, parseSums, renderFormula } from "../../scripts/homebrew-formula.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SUMS = [`${A}  tabcap-v1.2.3-darwin-arm64.tar.gz`, `${B}  tabcap-v1.2.3-linux-x64.tar.gz`, `${C}  tabcap-v1.2.3-linux-arm64.tar.gz`, `${"d".repeat(64)}  tabcap-v1.2.3-windows-x64.zip`].join("\n") + "\n";

describe("Homebrew formula from a release's SHA256SUMS", () => {
  test("parseSums: `<sha>  <file>` lines, lowercase sha, other lines ignored", () => {
    const m = parseSums(`${A.toUpperCase()}  one.tar.gz\r\nnot a sum line\n${B} *two.zip\n\n`);
    expect([...m.entries()]).toEqual([
      ["one.tar.gz", A],
      ["two.zip", B],
    ]);
  });

  test("render: version in the URLs, one sha per built target, no placeholder left", () => {
    const out = renderFormula(readFileSync(TEMPLATE, "utf8"), "1.2.3", parseSums(SUMS));
    expect(out).toContain('version "1.2.3"');
    expect(out).toContain("releases/download/v1.2.3/tabcap-v1.2.3-darwin-arm64.tar.gz");
    expect(out).toContain("releases/download/v1.2.3/tabcap-v1.2.3-linux-x64.tar.gz");
    expect(out).toContain("releases/download/v1.2.3/tabcap-v1.2.3-linux-arm64.tar.gz");
    expect(out).toContain(`sha256 "${A}"`);
    expect(out).toContain(`sha256 "${B}"`);
    expect(out).toContain(`sha256 "${C}"`);
    expect(out).not.toContain("{{");
    expect(out).toContain("class Tabcap < Formula");
    expect(Object.keys(FORMULA_TARGETS)).toEqual(["darwin-arm64", "linux-x64", "linux-arm64"]);
  });

  test("a missing target, a bad version or an unfilled placeholder is an error", () => {
    const tpl = readFileSync(TEMPLATE, "utf8");
    expect(() => renderFormula(tpl, "1.2.3", parseSums(SUMS.replace("linux-arm64", "linux-arm65")))).toThrow(/tabcap-v1.2.3-linux-arm64.tar.gz/);
    expect(() => renderFormula(tpl, "v1.2.3", parseSums(SUMS))).toThrow(/major.minor.patch/);
    expect(() => renderFormula(tpl + "\n# {{OTHER}}\n", "1.2.3", parseSums(SUMS))).toThrow(/\{\{OTHER\}\}/);
  });
});
