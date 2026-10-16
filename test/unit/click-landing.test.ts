// 0.6-J click landing: the decision table on synthetic listener maps.
// Oracle: the owner's design in the 0.6-J brief (10-16): (a) the target or
// one of 3 ancestor levels listens for click / mousedown / pointerdown /
// touchstart → the target; (b) else exactly one descendant (depth <= 4, at
// most 64 nodes) listens or is marked → that descendant; (c) several →
// the target, with candidates; (d) nothing → unchanged. The listener shape is
// DOMDebugger.EventListener of the CDP protocol (type, backendNodeId).

import { describe, expect, test } from "bun:test";
import { candidateBy, decideLanding, LANDING_MAX, listenersByNode, parseInspection, type LandingDescendant, type LandingInspection } from "../../src/daemon/browser/landing.ts";
import { lineOf, type AxNode } from "../../src/daemon/browser/ax.ts";
import { landingFields } from "../../src/daemon/tools/input.ts";
import { landingTargets } from "../../src/daemon/tools/landing.ts";

const kid = (o: Partial<LandingDescendant> = {}): LandingDescendant => ({ depth: 1, listens: [], marks: [], visible: true, tag: "span", text: "", selector: "span", ...o });
const insp = (o: Partial<LandingInspection> = {}): LandingInspection => ({ target: [], ancestors: [], descendants: [], ...o });

describe("click landing decision table (0.6-J)", () => {
  test("(a) the target or an ancestor up to 3 levels listens: click the target", () => {
    expect(decideLanding(insp({ target: ["click"], descendants: [kid({ listens: ["click"] })] }))).toEqual({ kind: "target", by: "target" });
    for (const t of ["mousedown", "pointerdown", "touchstart"]) expect(decideLanding(insp({ target: [t] }))).toEqual({ kind: "target", by: "target" });
    expect(decideLanding(insp({ ancestors: [[], [], ["click"]], descendants: [kid({ marks: ["lay-event"] })] }))).toEqual({ kind: "target", by: "ancestor" });
  });

  test("a listener four ancestor levels up does not count (root delegation); other event types never count", () => {
    expect(decideLanding(insp({ ancestors: [[], [], [], ["click"]] }))).toEqual({ kind: "none" });
    expect(decideLanding(insp({ target: ["keydown", "mouseover", "mouseup", "pointerup"], ancestors: [["focus"]] }))).toEqual({ kind: "none" });
    expect(decideLanding(insp({ target: ["mouseover"], descendants: [kid({ listens: ["mouseover"] })] }))).toEqual({ kind: "none" });
  });

  test("(b) exactly one descendant listens or is marked: land on it", () => {
    expect(decideLanding(insp({ descendants: [kid(), kid({ depth: 2, listens: ["click"] })] }))).toEqual({ kind: "descendant", index: 1 });
    expect(decideLanding(insp({ descendants: [kid({ marks: ["lay-event"] })] }))).toEqual({ kind: "descendant", index: 0 });
    expect(decideLanding(insp({ descendants: [kid(), kid({ depth: 4, marks: ["cursor:pointer"] })] }))).toEqual({ kind: "descendant", index: 1 });
    // invisible, too deep, or past the 64-node cap: not a candidate
    expect(decideLanding(insp({ descendants: [kid({ listens: ["click"], visible: false }), kid({ depth: 5, listens: ["click"] }), kid({ marks: ["href"] })] }))).toEqual({ kind: "descendant", index: 2 });
    const many = Array.from({ length: LANDING_MAX + 1 }, (_, i) => kid({ marks: i === LANDING_MAX ? ["onclick"] : [] }));
    expect(decideLanding(insp({ descendants: many }))).toEqual({ kind: "none" });
  });

  test("(c) several candidates: click the target, report them", () => {
    expect(decideLanding(insp({ descendants: [kid({ listens: ["click"] }), kid(), kid({ marks: ["role=button"] })] }))).toEqual({ kind: "candidates", indexes: [0, 2] });
  });

  test("(d) nothing anywhere: unchanged", () => {
    expect(decideLanding(insp())).toEqual({ kind: "none" });
    expect(decideLanding(insp({ ancestors: [[], [], []], descendants: [kid(), kid({ depth: 2 })] }))).toEqual({ kind: "none" });
  });

  test("candidateBy lists the click listener types, then the markers", () => {
    expect(candidateBy(kid({ listens: ["mouseover", "click", "click"], marks: ["lay-event", "cursor:pointer"] }))).toEqual(["listener:click", "lay-event", "cursor:pointer"]);
    expect(candidateBy(kid({ listens: ["click"], visible: false }))).toEqual([]);
  });
});

describe("click landing inputs are untrusted", () => {
  test("listenersByNode keeps click-type listeners per backend node id and skips junk", () => {
    const m = listenersByNode({
      listeners: [
        { type: "click", backendNodeId: 7 },
        { type: "mousedown", backendNodeId: 7 },
        { type: "click", backendNodeId: 7 },
        { type: "keydown", backendNodeId: 7 },
        { type: "touchstart", backendNodeId: 9 },
        { type: "click", backendNodeId: "9" },
        { type: "click" },
        null,
        "x",
      ],
    });
    expect([...m]).toEqual([
      [7, ["click", "mousedown"]],
      [9, ["touchstart"]],
    ]);
    expect(listenersByNode(null).size).toBe(0);
    expect(listenersByNode({ listeners: "no" }).size).toBe(0);
  });

  test("parseInspection rejects malformed page output and clips strings", () => {
    expect(parseInspection(null)).toBeNull();
    expect(parseInspection({ target: [], ancestors: [] })).toBeNull();
    expect(parseInspection({ target: [], ancestors: [], descendants: [{ depth: "1" }] })).toBeNull();
    const x = parseInspection({ target: ["click", 3], ancestors: [["click"], "junk", [], [], ["click"]], descendants: [{ depth: 1, listens: [1, "click"], marks: ["href"], visible: true, tag: "a", text: "t".repeat(500), selector: 5 }] });
    expect(x).toEqual({ target: ["click"], ancestors: [["click"], [], []], descendants: [{ depth: 1, listens: ["click"], marks: ["href"], visible: true, tag: "a", text: "t".repeat(80), selector: "" }] });
  });
});

describe("click landing output (0.6-J)", () => {
  test("(b) adds target {ref, landedOn, reason}; (c) adds candidates; (a) / (d) add nothing", () => {
    const landedOn = { tag: "span", text: "编辑", selector: "#x" };
    expect(landingFields("e5", { kind: "descendant", node: { objectId: "o", backendNodeId: 3 }, landedOn })).toEqual({ target: { ref: "e5", landedOn, reason: "descendant-listener" } });
    const candidates = [{ ref: "e9", tag: "a", text: "x", selector: "a", by: ["href"] }];
    expect(landingFields("e5", { kind: "candidates", candidates })).toEqual({ candidates });
    expect(landingFields("e5", { kind: "target" })).toEqual({});
    expect(landingFields("e5", { kind: "none" })).toEqual({});
  });

  test("snapshot lines: landing=\"child\" on marked controls; only controls with a DOM node are inspected", () => {
    const n = (role: string, backendId: number | null, children: AxNode[] = []): AxNode => ({ role, name: role, value: null, description: "", backendId, password: false, flags: [], children });
    const btn = n("button", 4);
    expect(lineOf({ ...btn, landing: "child" }, "e1")).toBe('button "button" [e1] landing="child"');
    expect(lineOf(btn, "e1")).toBe('button "button" [e1]');
    const view = n("RootWebArea", 1, [n("group", 2, [btn, n("text", 5), n("link", null)]), n("menuitem", 6)]);
    expect(landingTargets(view).map((x) => x.backendId)).toEqual([4, 6]);
  });
});
