// `replay serve --order strict` (0.9-E, docs/04 §49): the server answers as
// always (key match, §31) and only notes the order in which requests arrive;
// at stop the received sequence is aligned with the bundle's recorded order
// and reported. Nothing is rejected mid-run (owner 2026-11-03: record the
// differences, report them at the end).
// Expected sequence: the replayable requests by seq, minus the skipped ones
// (rule `order: "skip"`, `--order-include` / `--order-exclude` path globs).
// Received sequence: every checked request in arrival order, at most
// MAX_RECEIVED. Comparison key: method + path + canonical query + the rule's
// body reading (match.ts OrderKey). Alignment: longest common subsequence;
// when it is not unique the earlier expected item is matched first. Then:
// moved = an unmatched expected and an unmatched received item with equal
// keys; changed = what is left of one diff block with equal method + path;
// the rest is missing / extra.
// Oracle: hand-built sequences in test/unit/replay-order.test.ts whose
// alignment is unique; s76 (docs/05 §20) end to end.
// Reproduce: bun test test/unit/replay-order.test.ts

import type { Candidate, Incoming, OrderKey, Recording, ReplayIndex } from "./match.ts";
import { orderKeyEqual } from "./match.ts";
import { globMatcher } from "./common.ts";
import type { RuleSet } from "./rules.ts";
import { rulesInfo } from "./rules.ts";

export const MAX_RECEIVED = 10000;
/** Above this many table cells the alignment is greedy (and says so). */
export const MAX_CELLS = 20_000_000;

export type OrderMissing = { position: number; id: string; method: string; url: string; notServed?: true };
export type OrderExtra = { index: number; method: string; url: string; matched: string | null };
export type OrderChanged = { position: number; id: string; index: number; differs: Pick<Candidate["differs"], "query" | "body">; notServed?: true };
export type OrderMoved = { id: string; position: number; index: number; notServed?: true };
export type OrderDivergence = { position: number; expected: string | null; index: number; received: string | null };

export type OrderReport = {
  mode: "strict";
  ok: boolean;
  expected: number;
  received: number;
  matched: number;
  missing: OrderMissing[];
  extra: OrderExtra[];
  changed: OrderChanged[];
  moved: OrderMoved[];
  firstDivergence: OrderDivergence | null;
  skipped: { expected: number; received: number };
  truncated: boolean;
  rules: ReturnType<typeof rulesInfo>;
  include: string | null;
  exclude: string | null;
  warnings: string[];
};

export type OrderOptions = { include?: string | undefined; exclude?: string | undefined; rules: RuleSet; scrub?: (s: string) => string };

type Expected = { position: number; rec: Recording; key: OrderKey; url: string; notServed: boolean };
type Received = { index: number; method: string; url: string; matched: string | null; key: OrderKey };

/** Path + query of a URL (absolute or not). */
function pathQuery(url: string): string {
  try {
    const u = new URL(url, "http://replay.invalid");
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://replay.invalid").pathname;
  } catch {
    return url;
  }
}

/**
 * Matched index pairs of a longest common subsequence of a[0..n) and b[0..m),
 * ascending. Ties: the earlier item of `a` is matched first. Above MAX_CELLS
 * (after the common prefix) a greedy pass is used instead (`approximate`).
 */
export function alignSequences(n: number, m: number, eq: (i: number, j: number) => boolean, maxCells = MAX_CELLS): { pairs: [number, number][]; approximate: boolean } {
  const pairs: [number, number][] = [];
  let s = 0;
  while (s < n && s < m && eq(s, s)) {
    pairs.push([s, s]);
    s++;
  }
  const rn = n - s;
  const rm = m - s;
  if (rn === 0 || rm === 0) return { pairs, approximate: false };
  if ((rn + 1) * (rm + 1) > maxCells) {
    // Greedy: each received item takes the earliest unmatched expected item after the last match.
    let i = s;
    for (let j = s; j < m && i < n; j++) {
      for (let k = i; k < n; k++) {
        if (eq(k, j)) {
          pairs.push([k, j]);
          i = k + 1;
          break;
        }
      }
    }
    return { pairs, approximate: true };
  }
  const w = rm + 1;
  // L[i][j]: LCS length of a[s+i..n) and b[s+j..m); values never exceed min(rn, rm) <= MAX_RECEIVED.
  const L = rm < 65535 || rn < 65535 ? new Uint16Array((rn + 1) * w) : new Uint32Array((rn + 1) * w);
  for (let i = rn - 1; i >= 0; i--) {
    for (let j = rm - 1; j >= 0; j--) {
      L[i * w + j] = eq(s + i, s + j) ? (L[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(L[(i + 1) * w + j] ?? 0, L[i * w + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rn && j < rm) {
    const here = L[i * w + j] ?? 0;
    if (here === 0) break;
    if (eq(s + i, s + j) && here === (L[(i + 1) * w + j + 1] ?? 0) + 1) {
      pairs.push([s + i, s + j]);
      i++;
      j++;
    } else if ((L[i * w + j + 1] ?? 0) === here) j++; // keep a[i] in play: skip the received item
    else i++;
  }
  return { pairs, approximate: false };
}

export class OrderTracker {
  private readonly expectedList: Expected[] = [];
  private readonly receivedList: Received[] = [];
  private receivedCount = 0;
  private skippedExpected = 0;
  private skippedReceived = 0;
  private readonly include: ((p: string) => boolean) | null;
  private readonly exclude: ((p: string) => boolean) | null;
  private readonly scrub: (s: string) => string;
  private readonly warnings: string[] = [];

  constructor(
    private readonly index: ReplayIndex,
    private readonly opts: OrderOptions,
  ) {
    this.include = globMatcher(opts.include);
    this.exclude = globMatcher(opts.exclude);
    this.scrub = opts.scrub ?? ((s) => s);
    const recs = [...index.recordings].sort((a, b) => a.seq - b.seq);
    let anyNotServed = false;
    for (const rec of recs) {
      if (!this.checks(rec.rule.order, rec.path)) {
        this.skippedExpected++;
        continue;
      }
      const notServed = !index.servedFor(rec).includes(rec);
      if (notServed) anyNotServed = true;
      this.expectedList.push({ position: this.expectedList.length + 1, rec, key: index.recordingOrderKey(rec), url: pathQuery(rec.request.url), notServed });
    }
    if (anyNotServed) this.warnings.push("a prefer other than recorded answers some keys with a different recording than at record time; the client may have taken another path from there, so later differences can follow from it");
  }

  private checks(order: "check" | "skip", path: string): boolean {
    if (order === "skip") return false;
    if (this.exclude?.(path) === true) return false;
    if (this.include !== null && !this.include(path)) return false;
    return true;
  }

  /** Note one served request; returns its index in the received sequence, or null when it is not checked. */
  note(req: Incoming, matched: Recording | null): number | null {
    const rule = matched?.rule ?? this.index.ruleOf(req);
    if (!this.checks(rule.order, pathOf(req.url))) {
      this.skippedReceived++;
      return null;
    }
    this.receivedCount++;
    const index = this.receivedCount;
    if (index <= MAX_RECEIVED) this.receivedList.push({ index, method: req.method.toUpperCase(), url: pathQuery(req.url), matched: matched?.id ?? null, key: this.index.incomingOrderKey(req, matched) });
    return index;
  }

  report(): OrderReport {
    const exp = this.expectedList;
    const rec = this.receivedList;
    const truncated = this.receivedCount > MAX_RECEIVED;
    const warnings = [...this.warnings];
    const eq = (i: number, j: number): boolean => {
      const a = exp[i];
      const b = rec[j];
      return a !== undefined && b !== undefined && orderKeyEqual(a.key, b.key);
    };
    const { pairs, approximate } = alignSequences(exp.length, rec.length, eq);
    if (approximate) warnings.push(`the sequences are too long for an exact alignment (${exp.length} x ${rec.length}): a greedy one was used, so moved / missing / extra may be more than needed`);
    if (truncated) warnings.push(`more than ${MAX_RECEIVED} checked requests: only the first ${MAX_RECEIVED} were compared`);
    // Diff blocks: block k lies between the (k-1)-th and k-th matched pair.
    const expBlock = new Array<number>(exp.length).fill(-1);
    const recBlock = new Array<number>(rec.length).fill(-1);
    let pi = 0;
    let pj = 0;
    let block = 0;
    for (const [i, j] of [...pairs, [exp.length, rec.length] as [number, number]]) {
      for (; pi < i; pi++) expBlock[pi] = block;
      for (; pj < j; pj++) recBlock[pj] = block;
      pi = i + 1;
      pj = j + 1;
      block++;
    }
    const missingIdx = exp.map((_, i) => i).filter((i) => expBlock[i] !== -1);
    const extraIdx = new Set(rec.map((_, j) => j).filter((j) => recBlock[j] !== -1));
    const moved: OrderMoved[] = [];
    const changed: OrderChanged[] = [];
    const left: number[] = [];
    for (const i of missingIdx) {
      const e = exp[i];
      if (e === undefined) continue;
      const j = [...extraIdx].find((x) => {
        const r = rec[x];
        return r !== undefined && orderKeyEqual(e.key, r.key);
      });
      if (j === undefined) {
        left.push(i);
        continue;
      }
      extraIdx.delete(j);
      moved.push({ id: e.rec.id, position: e.position, index: rec[j]?.index ?? 0, ...(e.notServed ? { notServed: true as const } : {}) });
    }
    const missing: OrderMissing[] = [];
    for (const i of left) {
      const e = exp[i];
      if (e === undefined) continue;
      const j = [...extraIdx].find((x) => {
        const r = rec[x];
        return r !== undefined && recBlock[x] === expBlock[i] && r.key.method === e.key.method && r.key.path === e.key.path;
      });
      const r = j === undefined ? undefined : rec[j];
      if (j === undefined || r === undefined) {
        missing.push({ position: e.position, id: e.rec.id, method: e.rec.method, url: this.scrub(e.url), ...(e.notServed ? { notServed: true as const } : {}) });
        continue;
      }
      extraIdx.delete(j);
      changed.push({ position: e.position, id: e.rec.id, index: r.index, differs: this.index.orderDiffers(e.key, r.key), ...(e.notServed ? { notServed: true as const } : {}) });
    }
    const extra: OrderExtra[] = [...extraIdx]
      .sort((a, b) => a - b)
      .flatMap((j) => {
        const r = rec[j];
        return r === undefined ? [] : [{ index: r.index, method: r.method, url: this.scrub(r.url), matched: r.matched }];
      });
    let firstDivergence: OrderDivergence | null = null;
    for (let k = 0; k < Math.max(exp.length, rec.length); k++) {
      const a = exp[k];
      const b = rec[k];
      if (a !== undefined && b !== undefined && orderKeyEqual(a.key, b.key)) continue;
      firstDivergence = { position: k + 1, expected: a?.rec.id ?? null, index: k + 1, received: b === undefined ? null : this.scrub(b.url) };
      break;
    }
    if (firstDivergence === null && truncated) {
      // the kept entries all agree; what came after them was not kept
      const k = rec.length;
      firstDivergence = { position: k + 1, expected: exp[k]?.rec.id ?? null, index: k + 1, received: null };
    }
    const ok = missing.length + extra.length + changed.length + moved.length === 0 && !truncated;
    return {
      mode: "strict",
      ok,
      expected: exp.length,
      received: this.receivedCount,
      matched: pairs.length,
      missing,
      extra,
      changed,
      moved: moved.sort((a, b) => a.position - b.position),
      firstDivergence: ok ? null : firstDivergence,
      skipped: { expected: this.skippedExpected, received: this.skippedReceived },
      truncated,
      rules: rulesInfo(this.opts.rules),
      include: this.opts.include ?? null,
      exclude: this.opts.exclude ?? null,
      warnings,
    };
  }
}

/** The report as text lines (stderr): one summary line, then up to 20 lines per kind of difference. */
export function orderText(r: OrderReport): string {
  const lines = [`order: ${r.ok ? "ok" : "DIFFERENT"}, ${r.matched}/${r.expected} expected matched, ${r.received} received${r.skipped.expected + r.skipped.received > 0 ? `, skipped ${r.skipped.expected} expected / ${r.skipped.received} received` : ""}${r.truncated ? ", truncated" : ""}`];
  const some = <T>(xs: T[], f: (x: T) => string) => {
    for (const x of xs.slice(0, 20)) lines.push(f(x));
    if (xs.length > 20) lines.push(`  … ${xs.length - 20} more`);
  };
  if (r.firstDivergence !== null) {
    const d = r.firstDivergence;
    lines.push(`  first divergence at #${d.position}: expected ${d.expected ?? "(end)"}, received ${d.received ?? "(end)"}`);
  }
  some(r.moved, (m) => `  moved ${m.id} expected #${m.position}, received #${m.index}`);
  some(r.changed, (c) => `  changed ${c.id} expected #${c.position}, received #${c.index}: ${Object.keys(c.differs).join(", ") || "key"} differ`);
  some(r.missing, (m) => `  missing ${m.id} expected #${m.position} ${m.method} ${m.url}`);
  some(r.extra, (e) => `  extra received #${e.index} ${e.method} ${e.url}${e.matched === null ? " (no match: 404)" : ` (answered by ${e.matched})`}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}
