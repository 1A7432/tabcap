// docs/05 scenario index (the "场景索引" section): every `### sNN` scenario of
// docs/05 has exactly one row, and each row's status agrees with the code.
// A built scenario (already landed, an sNN-like equivalent, or unit tests
// only) must be findable by its number in test/e2e/site.ts or in a test file;
// one marked "not landed" must not be in site.ts yet (landing it means
// updating the table); one that only exists in the docs/12 comparison range
// must be in docs/compare/range.ts. Offline: reads files only.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

const DOC = read("docs", "05-local-range-scenarios.md");
const SITE = read("test", "e2e", "site.ts");
const COMPARE = read("docs", "compare", "range.ts");

const BUILT = ["已落地", "近似", "仅单测"];
const NOT_LANDED = "未落地";
const COMPARE_ONLY = "仅对照靶场";
const STATUSES = [...BUILT, NOT_LANDED, COMPARE_ONLY];

/** The scenario number as a token: not inside a longer word or number (`s07`, `/s22/`, `S40_`; not `s05f`). */
const mentions = (id: string): RegExp => new RegExp(`(?<![A-Za-z0-9])[sS]${id}(?![A-Za-z0-9])`);

/** Every .ts file under test/unit and test/e2e except site.ts (searched on its own) and this file (its comments name numbers). */
function testFiles(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const dir of ["unit", "e2e"]) {
    for (const name of readdirSync(join(ROOT, "test", dir))) {
      if (!name.endsWith(".ts") || (dir === "e2e" && name === "site.ts") || (dir === "unit" && name === "scenario-index.test.ts")) continue;
      out.push({ name: `test/${dir}/${name}`, text: read("test", dir, name) });
    }
  }
  return out;
}

/** The scenario headings of docs/05 (`### s01 plain-json（P1）` → "01"). */
function headingIds(): string[] {
  return [...DOC.matchAll(/^### s(\d{2}) /gm)].map((m) => m[1] ?? "");
}

/** The rows of the index table: `| s01 | name | status | … |`. */
function indexRows(): Array<{ id: string; status: string }> {
  const head = /^## \d+\. 场景索引$/m.exec(DOC);
  if (head === null) throw new Error("docs/05 has no 场景索引 section");
  const rest = DOC.slice(head.index + head[0].length);
  const next = /^## /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const rows: Array<{ id: string; status: string }> = [];
  for (const line of section.split("\n")) {
    const m = /^\| s(\d{2}) \| [^|]+ \| ([^|]+) \|/.exec(line);
    if (m !== null) rows.push({ id: m[1] ?? "", status: (m[2] ?? "").trim() });
  }
  return rows;
}

describe("docs/05 scenario index", () => {
  const rows = indexRows();
  const files = testFiles();

  test("one row per scenario heading, no extra rows, a known status each", () => {
    const ids = headingIds();
    expect(ids.length).toBeGreaterThan(40);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    for (const r of rows) expect({ id: r.id, status: STATUSES.includes(r.status) ? "known" : r.status }).toEqual({ id: r.id, status: "known" });
  });

  test("a built scenario's number is in site.ts or a test file", () => {
    const missing = rows
      .filter((r) => BUILT.includes(r.status))
      .filter((r) => !mentions(r.id).test(SITE) && !files.some((f) => mentions(r.id).test(f.text)))
      .map((r) => `s${r.id}`);
    expect(missing).toEqual([]);
  });

  test("a scenario marked not landed is not in site.ts", () => {
    const landed = rows.filter((r) => r.status === NOT_LANDED && mentions(r.id).test(SITE)).map((r) => `s${r.id}`);
    expect(landed).toEqual([]);
  });

  test("a comparison-only scenario is in docs/compare/range.ts", () => {
    const only = rows.filter((r) => r.status === COMPARE_ONLY);
    expect(only.length).toBeGreaterThan(0);
    for (const r of only) expect({ id: r.id, found: mentions(r.id).test(COMPARE) }).toEqual({ id: r.id, found: true });
  });
});
