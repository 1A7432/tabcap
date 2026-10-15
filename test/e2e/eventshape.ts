// Event-shape comparison for docs/05 s46 / docs/06 A7.6: tabcap's events on the
// input probe page against the Playwright oracle exports in
// fixtures/probe/oracle/. Pure functions (unit-tested in
// test/unit/eventshape.test.ts); the e2e prints the report it builds.
//
// Structure fields (types, order, isTrusted, buttons, pressure, keys …) are
// compared one by one; rhythm fields (timeStamp, dt, the number of moves, the
// press gap, movementX/Y along the path) are only listed (owner decision D7:
// the target is a trusted, human-like shape, not a copy of Playwright's rhythm).

export type Ev = Record<string, unknown>;

/** Never compared field by field: timing, and coordinates that depend on the window position. */
export const RHYTHM_FIELDS: readonly string[] = ["seq", "timeStamp", "dt", "screenX", "screenY"];
const MOVES = new Set(["pointermove", "mousemove"]);

const typeOf = (e: Ev): string => (typeof e["type"] === "string" ? e["type"] : "?");
const numOf = (e: Ev | undefined, k: string): number | null => (e !== undefined && typeof e[k] === "number" ? e[k] : null);

/** Runs of pointermove / mousemove collapse to their last pointermove and last mousemove. */
export function collapseMoves(evs: readonly Ev[]): Ev[] {
  const out: Ev[] = [];
  let run: Ev[] = [];
  const flush = () => {
    const pm = run.filter((e) => typeOf(e) === "pointermove").at(-1);
    const mm = run.filter((e) => typeOf(e) === "mousemove").at(-1);
    // keep their original order
    for (const e of run) if (e === pm || e === mm) out.push(e);
    run = [];
  };
  for (const e of evs) {
    if (MOVES.has(typeOf(e))) run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

/**
 * The part of a click that happens on the target: from the last pointerover
 * on `target` before the first pointerdown, through the first click after it.
 * Null when the run has no pointerdown or click.
 */
export function clickSegment(evs: readonly Ev[], target = "target"): Ev[] | null {
  const down = evs.findIndex((e) => typeOf(e) === "pointerdown");
  if (down < 0) return null;
  let from = -1;
  for (let i = down - 1; i >= 0; i--) {
    const e = evs[i];
    if (e !== undefined && typeOf(e) === "pointerover" && e["target"] === target) {
      from = i;
      break;
    }
  }
  if (from < 0) from = down;
  const click = evs.findIndex((e, i) => i > down && typeOf(e) === "click");
  if (click < 0) return null;
  return evs.slice(from, click + 1);
}

/** Typing on the field: everything from the first keydown / beforeinput on `field`. */
export function typingSegment(evs: readonly Ev[], field = "field"): Ev[] {
  const i = evs.findIndex((e) => e["target"] === field && (typeOf(e) === "keydown" || typeOf(e) === "beforeinput"));
  return i < 0 ? [] : evs.slice(i);
}

export type FieldDiff = { i: number; type: string; field: string; ours: unknown; oracle: unknown };
export type ShapeDiff = { types: { ours: string[]; oracle: string[]; equal: boolean }; fields: FieldDiff[] };

/** Pairwise by position: event types, then every field of either side except `ignore`. */
export function diffEvents(ours: readonly Ev[], oracle: readonly Ev[], ignore: readonly string[] = RHYTHM_FIELDS): ShapeDiff {
  const a = ours.map(typeOf);
  const b = oracle.map(typeOf);
  const fields: FieldDiff[] = [];
  const n = Math.max(ours.length, oracle.length);
  for (let i = 0; i < n; i++) {
    const x = ours[i];
    const y = oracle[i];
    if (x === undefined || y === undefined) {
      fields.push({ i, type: typeOf(x ?? y ?? {}), field: "(event)", ours: x === undefined ? null : typeOf(x), oracle: y === undefined ? null : typeOf(y) });
      continue;
    }
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !ignore.includes(k)).sort();
    for (const k of keys) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) fields.push({ i, type: typeOf(x), field: k, ours: x[k] ?? null, oracle: y[k] ?? null });
    }
  }
  return { types: { ours: a, oracle: b, equal: JSON.stringify(a) === JSON.stringify(b) }, fields };
}

export type ClickRhythm = {
  movesBeforeDown: number;
  pointerMovesBeforeDown: number;
  /** Last pointermove before pointerdown vs pointerdown (clientX / clientY), px. */
  endGapPx: number | null;
  /** First to last pointermove before pointerdown, ms (page clock). */
  pathMs: number | null;
  /** pointerdown → pointerup, ms (page clock). */
  pressGapMs: number | null;
  allTrusted: boolean;
};

export function clickRhythm(evs: readonly Ev[]): ClickRhythm {
  const down = evs.findIndex((e) => typeOf(e) === "pointerdown");
  const before = down < 0 ? [] : evs.slice(0, down);
  const pms = before.filter((e) => typeOf(e) === "pointermove");
  const last = pms.at(-1);
  const d = down < 0 ? undefined : evs[down];
  const up = evs.find((e, i) => i > down && typeOf(e) === "pointerup");
  const lx = numOf(last, "clientX");
  const ly = numOf(last, "clientY");
  const dx = numOf(d, "clientX");
  const dy = numOf(d, "clientY");
  const t0 = numOf(pms[0], "timeStamp");
  const t1 = numOf(last, "timeStamp");
  const td = numOf(d, "timeStamp");
  const tu = numOf(up, "timeStamp");
  const click = evs.findIndex((e) => typeOf(e) === "click");
  return {
    movesBeforeDown: before.filter((e) => MOVES.has(typeOf(e))).length,
    pointerMovesBeforeDown: pms.length,
    endGapPx: lx === null || ly === null || dx === null || dy === null ? null : Math.round(Math.hypot(lx - dx, ly - dy) * 1000) / 1000,
    pathMs: t0 === null || t1 === null ? null : Math.round((t1 - t0) * 10) / 10,
    pressGapMs: td === null || tu === null ? null : Math.round((tu - td) * 10) / 10,
    allTrusted: evs.slice(0, click < 0 ? evs.length : click + 1).every((e) => e["isTrusted"] === true),
  };
}

/** A readable, field-by-field report (A7.6), one line per difference. */
export function formatDiff(title: string, d: ShapeDiff): string {
  const lines = [`## ${title}`, `types equal: ${d.types.equal}`, `  tabcap:     ${d.types.ours.join(" > ")}`, `  playwright: ${d.types.oracle.join(" > ")}`];
  if (d.fields.length === 0) lines.push("fields: no differences");
  else for (const f of d.fields) lines.push(`  #${f.i} ${f.type}.${f.field}: tabcap=${JSON.stringify(f.ours)} playwright=${JSON.stringify(f.oracle)}`);
  return lines.join("\n");
}
