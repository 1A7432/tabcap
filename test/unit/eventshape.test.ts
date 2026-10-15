// L0 for the s46 event-shape diff helper (test/e2e/eventshape.ts, docs/06 A7.6).
// Inputs: the Playwright oracle exports in fixtures/probe/oracle/ and small
// hand-built sequences whose answer is obvious from their construction.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { clickRhythm, clickSegment, collapseMoves, diffEvents, formatDiff, typingSegment, type Ev } from "../e2e/eventshape.ts";

const DIR = join(import.meta.dir, "..", "..", "fixtures", "probe", "oracle");
function events(mode: string): Ev[] {
  const f = readdirSync(DIR).find((n) => n.endsWith(`-${mode}.json`));
  if (f === undefined) throw new Error(`no ${mode} export`);
  const doc: unknown = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  const r = isRecord(doc) && isRecord(doc["report"]) ? doc["report"] : {};
  return Array.isArray(r["events"]) ? r["events"].filter(isRecord) : [];
}
const types = (evs: Ev[]) => evs.map((e) => e["type"]);
const ev = (type: string, target = "target", extra: Ev = {}): Ev => ({ type, target, isTrusted: true, ...extra });

describe("collapse / segments", () => {
  test("runs of moves keep their last pointermove and mousemove, in order", () => {
    const seq = [ev("pointerover", "HTML"), ev("pointermove", "HTML", { clientX: 1 }), ev("mousemove", "HTML", { clientX: 1 }), ev("pointermove", "HTML", { clientX: 2 }), ev("mousemove", "HTML", { clientX: 2 }), ev("pointerdown")];
    const c = collapseMoves(seq);
    expect(types(c)).toEqual(["pointerover", "pointermove", "mousemove", "pointerdown"]);
    expect(c[1]?.["clientX"]).toBe(2);
  });

  test("click segment starts at the last pointerover on the target before pointerdown and ends at click", () => {
    const seq = [ev("pointerover", "HTML"), ev("pointermove", "HTML"), ev("pointerover"), ev("mouseover"), ev("pointermove"), ev("mousemove"), ev("pointerdown"), ev("mousedown"), ev("pointerup"), ev("mouseup"), ev("click"), ev("focus", "field")];
    expect(types(clickSegment(seq) ?? [])).toEqual(["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(clickSegment([ev("click")])).toBeNull();
    // the Playwright click is its own segment
    expect(clickSegment(events("click"))).toEqual(events("click"));
  });

  test("typing segment: from the first keydown / beforeinput on the field", () => {
    const t = typingSegment(events("type"));
    expect(t[0]?.["type"]).toBe("keydown");
    expect(t.at(-1)?.["data"]).toBe("中");
    expect(typingSegment(events("fill"))[0]?.["type"]).toBe("beforeinput");
    expect(typingSegment([ev("focus", "field")])).toEqual([]);
  });
});

describe("diff and rhythm", () => {
  test("an export against itself: equal types, no field differences; timing fields are ignored", () => {
    const a = events("click");
    const shifted = a.map((e) => ({ ...e, timeStamp: Number(e["timeStamp"]) + 50, dt: 9, screenX: 1, seq: 99 }));
    const d = diffEvents(shifted, a);
    expect(d.types.equal).toBe(true);
    expect(d.fields).toEqual([]);
  });

  test("structure differences are listed field by field, missing events as (event)", () => {
    const a = events("click");
    const b = a.map((e) => (e["type"] === "pointerdown" ? { ...e, pressure: 0 } : e)).slice(0, -1);
    const d = diffEvents(b, a);
    expect(d.types.equal).toBe(false);
    expect(d.fields).toEqual([
      { i: 4, type: "pointerdown", field: "pressure", ours: 0, oracle: 0.5 },
      { i: 8, type: "click", field: "(event)", ours: null, oracle: "click" },
    ]);
    expect(formatDiff("x", d)).toContain("#4 pointerdown.pressure: tabcap=0 playwright=0.5");
  });

  test("rhythm of the Playwright click: one move pair at the target, 0 px to pointerdown, all trusted; the JS click is untrusted", () => {
    expect(clickRhythm(events("click"))).toMatchObject({ movesBeforeDown: 2, pointerMovesBeforeDown: 1, endGapPx: 0, pathMs: 0, allTrusted: true });
    expect(clickRhythm(events("js_click"))).toMatchObject({ movesBeforeDown: 0, endGapPx: null, allTrusted: false });
  });
});
