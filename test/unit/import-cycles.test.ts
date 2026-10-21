// Layering (review wave 2): the static runtime import graph of src/ has no
// cycle through the modules below, the core daemon layer does not import
// tools/fetch.ts, and bundle/usage.ts does not import daemon/fetch.
// Type-only imports are left out (Bun.Transpiler drops them; tsconfig has
// verbatimModuleSyntax, so a runtime import is always written as one).
// Offline and deterministic: it reads the source files only.
// Reproduce: bun test test/unit/import-cycles.test.ts

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dir, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rel = (p: string): string => relative(SRC, p).split(sep).join("/");

/** module → the modules it imports at run time (relative imports inside src/). */
function importGraph(): Map<string, string[]> {
  const files = sourceFiles(SRC);
  const known = new Set(files);
  const scan = new Bun.Transpiler({ loader: "ts" });
  const g = new Map<string, string[]>();
  for (const f of files) {
    const to: string[] = [];
    for (const i of scan.scanImports(readFileSync(f, "utf8"))) {
      if (!i.path.startsWith(".")) continue;
      const target = resolve(dirname(f), i.path);
      if (known.has(target)) to.push(rel(target));
    }
    g.set(rel(f), to);
  }
  return g;
}

/** Strongly connected components with more than one module (Tarjan). */
function cycles(g: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of g.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) === index.get(v)) {
      const c: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        c.push(w);
        if (w === v) break;
      }
      if (c.length > 1) out.push(c.sort());
    }
  };
  for (const v of [...g.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

const graph = importGraph();
const cyclic = cycles(graph);

describe("import layering (review wave 2)", () => {
  test("the scan sees the source tree", () => {
    expect(graph.size).toBeGreaterThan(100);
    expect(graph.get("daemon/tools/snapshot.ts")).toContain("daemon/browser/doc.ts");
  });

  test("no runtime import cycle through snapshot / challenge / landing / navigate / protection/live, or siterules / tools/fetch", () => {
    const watched = ["daemon/tools/snapshot.ts", "daemon/tools/challenge.ts", "daemon/tools/landing.ts", "daemon/tools/navigate.ts", "daemon/protection/live.ts", "daemon/siterules.ts", "daemon/tools/fetch.ts"];
    for (const m of watched) expect(graph.has(m)).toBe(true);
    expect(cyclic.filter((c) => c.some((m) => watched.includes(m)))).toEqual([]);
  });

  test("bundle/usage.ts does not import daemon/fetch (the JSON path parser is shared/jsonpath.ts)", () => {
    expect(graph.get("bundle/usage.ts")?.filter((m) => m.startsWith("daemon/fetch/"))).toEqual([]);
    expect(graph.get("shared/jsonpath.ts")?.every((m) => m.startsWith("shared/"))).toBe(true);
  });

  test("the core layer does not import tools/fetch.ts (the site rule is shared/sites.ts)", () => {
    for (const m of ["daemon/state.ts", "daemon/guard.ts", "daemon/trace/observe.ts", "daemon/tools/status.ts", "daemon/siterules.ts"]) {
      expect([m, graph.get(m)?.includes("daemon/tools/fetch.ts")]).toEqual([m, false]);
    }
  });
});
