import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN, standaloneReadme } from "../../scripts/release.ts";
import { REPO_ROOT } from "./_fixtures.ts";

describe("release README (quick start only)", () => {
  const out = standaloneReadme(readFileSync(join(REPO_ROOT, "README.md"), "utf8"), "9.9.9");
  test("cut from the quick start, with the generated table and without markers", () => {
    expect(out.startsWith("# tabcap 9.9.9\n\n## Quick start\n")).toBe(true);
    expect(out).toContain("| `tabcap net body <id> [--out path]` |");
    expect(out).toContain("0.1.0 was released under the name `bbl`");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("## What it is");
  });
  test("no lab or internal wording", () => {
    for (const re of FORBIDDEN) expect(re.test(out)).toBe(false);
    expect(() => standaloneReadme("## Quick start\n\nsee evidence/\n", "1")).toThrow();
  });
});
