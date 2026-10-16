// Snapshot filters (0.5-F), pure functions over the built AX tree:
//   --grep <re>        lines whose text (role, name, value, states,
//                      description; not the ref) matches, each with its
//                      ancestor chain, indented as in the full snapshot;
//   --css / --xpath    the lines of given DOM nodes (by backendNodeId), with
//                      ancestors;
//   --context N        N sibling lines before and after each match;
//   --ref e12 --depth  the subtree under one element, n levels.
// Refs are minted for the whole document in the same order as the full
// snapshot (`flattenAx` calls `refFor` exactly like `renderAxTree`), so a
// filtered snapshot gives every element the ref the full one would.

import { lineOf, wantsRef, type AxNode, type RefFor } from "./ax.ts";

export type AxLine = {
  depth: number;
  /** The snapshot line as rendered (indentation, "- ", ref). */
  text: string;
  /** What --grep looks at: the line without indentation and ref. */
  match: string;
  backendId: number | null;
  parent: number;
  kids: number[];
};

/** Every line of the tree in document order, minting refs like renderAxTree. */
export function flattenAx(root: AxNode, refFor: RefFor): { lines: AxLine[]; refs: number } {
  const lines: AxLine[] = [];
  let refs = 0;
  const walk = (n: AxNode, depth: number, parent: number) => {
    const ref = wantsRef(n) && n.backendId !== null ? refFor(n.backendId) : null;
    if (ref !== null) refs++;
    const i = lines.length;
    lines.push({ depth, text: `${"  ".repeat(depth)}- ${lineOf(n, ref)}`, match: lineOf(n, null), backendId: n.backendId, parent, kids: [] });
    lines[parent]?.kids.push(i);
    for (const c of n.children) walk(c, depth + 1, i);
  };
  walk(root, 0, -1);
  return { lines, refs };
}

/** Indexes of the lines --grep matches (a non-global regex: test is stateless). */
export function grepAx(lines: readonly AxLine[], re: RegExp): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(l.match)) out.push(i);
  });
  return out;
}

/** Indexes of the lines whose node is one of `ids`, plus the ids that have no line. */
export function nodesAx(lines: readonly AxLine[], ids: readonly number[]): { hits: number[]; missing: number[] } {
  const want = new Set(ids);
  const seen = new Set<number>();
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (l.backendId !== null && want.has(l.backendId)) {
      hits.push(i);
      seen.add(l.backendId);
    }
  });
  return { hits, missing: ids.filter((id) => !seen.has(id)) };
}

/** The text of the picked lines with their ancestors and `context` siblings each side, in document order. */
export function pickLines(lines: readonly AxLine[], hits: readonly number[], context: number): string {
  const keep = new Set<number>();
  for (const h of hits) {
    const line = lines[h];
    if (line === undefined) continue;
    for (let p = line.parent; p >= 0; p = lines[p]?.parent ?? -1) keep.add(p);
    keep.add(h);
    if (context > 0 && line.parent >= 0) {
      const sib = lines[line.parent]?.kids ?? [];
      const k = sib.indexOf(h);
      for (let j = Math.max(0, k - context); j <= Math.min(sib.length - 1, k + context); j++) {
        const s = sib[j];
        if (s !== undefined) keep.add(s);
      }
    }
  }
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i]?.text ?? "")
    .join("\n");
}

/** The subtree under line `at`, `depth` levels below it (null: all), re-indented from 0; `hidden` counts deeper lines. */
export function subtreeLines(lines: readonly AxLine[], at: number, depth: number | null): { text: string; shown: number; hidden: number } {
  const root = lines[at];
  if (root === undefined) return { text: "", shown: 0, hidden: 0 };
  const out: string[] = [];
  let hidden = 0;
  const cut = root.depth * 2;
  const walk = (i: number, level: number) => {
    const l = lines[i];
    if (l === undefined) return;
    if (depth !== null && level > depth) {
      hidden++;
      for (const k of l.kids) walk(k, level + 1);
      return;
    }
    out.push(l.text.slice(cut));
    for (const k of l.kids) walk(k, level + 1);
  };
  walk(at, 0);
  return { text: out.join("\n"), shown: out.length, hidden };
}
