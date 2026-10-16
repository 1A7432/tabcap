// 0.4-I frame-path refs, L0: the ref grammar, the ref table across frames,
// frame-tree numbering on synthetic trees, the header lines, and the frame
// offset chain on CDP answers shaped like the s22 spike (Chrome for Testing
// 155, 10-16: box models of the s22 owners as measured; docs/07 §1.1).

import { describe, expect, test } from "bun:test";
import { chainTo, descendants, frameAt, frameHeaderLines, frameLine, framesOfTree, numberFrames, oopifTargets, placeChain, type RawFrame } from "../../src/daemon/browser/frames.ts";
import { parseFramePath, parseRef, RefTable, type DocIdentity, type FrameBinding } from "../../src/daemon/browser/refs.ts";
import type { AttachedTarget, Transport } from "../../src/daemon/transport/types.ts";

describe("ref grammar", () => {
  test("root refs and frame-path refs", () => {
    expect(parseRef("e12")).toEqual({ frames: [], path: "", n: 12 });
    expect(parseRef("f1/e3")).toEqual({ frames: [1], path: "f1", n: 3 });
    expect(parseRef("f2/f1/f1/e40")).toEqual({ frames: [2, 1, 1], path: "f2/f1/f1", n: 40 });
  });

  test("anything else is not a ref", () => {
    for (const bad of ["", "e", "e0", "E1", "e1x", "f1", "f1/", "/e1", "f0/e1", "f01/e1", "f1//e1", "f1/f/e1", "x1/e1", "f1/e1/e2", "e-1", "f1 /e1", " e1", "e1.5", `${"f1/".repeat(17)}e1`]) {
      expect(parseRef(bad)).toBeNull();
    }
    expect(parseRef(`${"f1/".repeat(16)}e1`)?.frames.length).toBe(16);
  });

  test("frame paths (--frame)", () => {
    expect(parseFramePath("f2/f1")).toEqual([2, 1]);
    expect(parseFramePath("")).toEqual([]);
    for (const bad of ["f0", "e1", "f1/", "f1/e2", "2", "f-1"]) expect(parseFramePath(bad)).toBeNull();
  });
});

const DOC: DocIdentity = { frameId: "ROOT", loaderId: "L0", url: "http://127.0.0.1:1/s22" };
const F2F1: FrameBinding = { path: "f2/f1", frameId: "FORM", sessionId: "S-oopif", loaderId: "LF" };

describe("ref table across frames", () => {
  test("one counter; the frame path is part of the ref; the same backend id in two processes gives two refs", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    expect(refs.refFor(3)).toBe("e1");
    expect(refs.refFor(3, F2F1)).toBe("f2/f1/e2");
    expect(refs.refFor(3, F2F1)).toBe("f2/f1/e2");
    expect(refs.refFor(3)).toBe("e1");
    expect(refs.lookup("f2/f1/e2", DOC)).toEqual({ ok: true, backendNodeId: 3, frame: F2F1 });
    expect(refs.lookup("e1", DOC)).toEqual({ ok: true, backendNodeId: 3, frame: null });
  });

  test("a wrong frame path is unknown, not expired, and the table says what the number was", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    refs.refFor(7, F2F1);
    expect(refs.lookup("e1", DOC)).toEqual({ ok: false, reason: "unknown" });
    expect(refs.lookup("f1/e1", DOC)).toEqual({ ok: false, reason: "unknown" });
    expect(refs.minted(1)).toBe("f2/f1/e1");
    expect(refs.lookup("f2/f1/e9", DOC)).toEqual({ ok: false, reason: "unknown" });
    expect(refs.lookup("f2/f1/x1", DOC)).toEqual({ ok: false, reason: "malformed" });
  });

  test("a frame renumbered by a later snapshot gets a new ref; the old one still points at the same node", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const old = refs.refFor(5, { ...F2F1, path: "f1/f1" });
    const now = refs.refFor(5, F2F1);
    expect([old, now]).toEqual(["f1/f1/e1", "f2/f1/e2"]);
    expect(refs.lookup(old, DOC)).toMatchObject({ ok: true, backendNodeId: 5 });
  });

  test("frame refs expire with the root document like root refs", () => {
    const refs = new RefTable();
    refs.setDocument(DOC);
    const r = refs.refFor(5, F2F1);
    expect(refs.lookup(r, { ...DOC, loaderId: "L1" })).toEqual({ ok: false, reason: "expired" });
    expect(refs.refFor(5, F2F1)).toBe("f2/f1/e2");
  });
});

// The s22 range: frameset (menu, main) on origin A; main holds two iframes on origin B
// (the search form with a nested same-origin table frame, and the modal layer).
const A = "http://127.0.0.1:1";
const B = "http://localhost:2";
const raw = (frameId: string, parentId: string | null, sessionId: string, oopif: boolean, origin: string, path: string): RawFrame => ({ frameId, parentId, sessionId, oopif, url: `${origin}${path}`, securityOrigin: origin, loaderId: `L-${frameId}` });
const S22: RawFrame[] = [
  raw("ROOT", null, "S0", false, A, "/s22"),
  raw("MENU", "ROOT", "S0", false, A, "/s22/menu"),
  raw("MAIN", "ROOT", "S0", false, A, "/s22/main"),
  // Frame-tree order differs from document order on purpose: numbering follows the owners.
  raw("MODAL", "MAIN", "S2", true, B, "/s22/modal"),
  raw("FORM", "MAIN", "S1", true, B, "/s22/form"),
  raw("TABLE", "FORM", "S1", false, B, "/s22/table"),
];
const ORDER = new Map<string, string[]>([
  ["ROOT", ["MENU", "MAIN"]],
  ["MAIN", ["FORM", "MODAL"]],
  ["FORM", ["TABLE"]],
]);
const TITLES = new Map([
  ["MENU", "s22 menu"],
  ["MAIN", "s22 main"],
  ["FORM", "s22 search"],
  ["TABLE", "s22 table"],
  ["MODAL", "s22 modal"],
]);

describe("frame tree numbering", () => {
  test("s22: document order, 1-based per parent, origin relative to the parent, depth", () => {
    const { root, omitted } = numberFrames(S22, ORDER, TITLES);
    expect(omitted).toBe(0);
    expect(descendants(root).map((f) => [f.path, f.frameId, f.origin, f.depth, f.title])).toEqual([
      ["f1", "MENU", "same-origin", 1, "s22 menu"],
      ["f2", "MAIN", "same-origin", 1, "s22 main"],
      ["f2/f1", "FORM", "cross-origin", 2, "s22 search"],
      ["f2/f1/f1", "TABLE", "same-origin", 3, "s22 table"],
      ["f2/f2", "MODAL", "cross-origin", 2, "s22 modal"],
    ]);
    expect(frameAt(root, "f2/f1/f1")?.frameId).toBe("TABLE");
    expect(frameAt(root, "f2/f1")?.sessionId).toBe("S1");
    expect(frameAt(root, "f3")).toBeNull();
    expect(frameAt(root, "f2/f9")).toBeNull();
  });

  test("children the owners did not show follow in frame-tree order; numbers stay 1-based", () => {
    const { root } = numberFrames(S22, new Map([["MAIN", ["MODAL"]]]), TITLES);
    expect(descendants(root).map((f) => `${f.path}=${f.frameId}`)).toEqual(["f1=MENU", "f2=MAIN", "f2/f1=MODAL", "f2/f2=FORM", "f2/f2/f1=TABLE"]);
  });

  test("a page without child frames has an empty tree and no header lines", () => {
    const { root } = numberFrames([raw("ROOT", null, "S0", false, A, "/")], new Map());
    expect(root.children).toEqual([]);
    expect(frameHeaderLines(root)).toEqual([]);
  });

  test("header lines: one per frame, indented by depth, label column like overlays / detected", () => {
    const { root } = numberFrames(S22, ORDER, TITLES);
    expect(frameHeaderLines(root)).toEqual([
      `frames    f1  ${A}/s22/menu  same-origin  depth 1  "s22 menu"`,
      `          f2  ${A}/s22/main  same-origin  depth 1  "s22 main"`,
      `            f2/f1  ${B}/s22/form  cross-origin  depth 2  "s22 search"`,
      `              f2/f1/f1  ${B}/s22/table  same-origin  depth 3  "s22 table"`,
      `            f2/f2  ${B}/s22/modal  cross-origin  depth 2  "s22 modal"`,
    ]);
    expect(frameHeaderLines(root, 0, 2)).toEqual([`frames    f1  ${A}/s22/menu  same-origin  depth 1  "s22 menu"`, `          f2  ${A}/s22/main  same-origin  depth 1  "s22 main"`, "          3 more frames not listed"]);
  });

  test("untrusted titles cannot break the header: control characters and quotes are escaped, long ones cut", () => {
    const { root } = numberFrames(S22, ORDER, new Map([["MENU", 'a\nfake line "x"\u0007' + "y".repeat(500)]]));
    const line = frameLine(root.children[0] ?? root);
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain('"a fake line \\"x\\" ');
    expect(line.length).toBeLessThan(300);
  });

  test("a frame whose parent no tree lists is left out and counted", () => {
    const { root, omitted } = numberFrames([...S22, raw("ORPHAN", "NOWHERE", "S9", true, B, "/x")], ORDER, TITLES);
    expect(descendants(root).some((f) => f.frameId === "ORPHAN")).toBe(false);
    expect(omitted).toBe(1);
  });
});

describe("CDP frame trees and sessions (untrusted JSON)", () => {
  test("Page.getFrameTree → frames, the tree's root marked as the OOPIF; malformed nodes dropped", () => {
    const r = { frameTree: { frame: { id: "FORM", parentId: "MAIN", url: `${B}/s22/form`, securityOrigin: B, loaderId: "LF" }, childFrames: [{ frame: { id: "TABLE", parentId: "FORM", url: `${B}/s22/table`, urlFragment: "#x", securityOrigin: B, loaderId: "LT" } }, { frame: { url: "no id" } }, "junk"] } };
    expect(framesOfTree(r, "S1", true)).toEqual([
      { frameId: "FORM", parentId: "MAIN", sessionId: "S1", oopif: true, url: `${B}/s22/form`, securityOrigin: B, loaderId: "LF" },
      { frameId: "TABLE", parentId: "FORM", sessionId: "S1", oopif: false, url: `${B}/s22/table#x`, securityOrigin: B, loaderId: "LT" },
    ]);
    expect(framesOfTree(null, "S1", true)).toEqual([]);
    expect(framesOfTree({ frameTree: "x" }, "S1", false)).toEqual([]);
  });

  test("OOPIF sessions of a tab: iframe targets attached under it, transitively; other tabs' and workers are not", () => {
    const tgt = (sessionId: string, type: AttachedTarget["type"], parentSessionId: string | null): AttachedTarget => ({ targetId: `T-${sessionId}`, sessionId, type, url: "", title: "", parentSessionId, openerId: null });
    const list = [tgt("S0", "page", null), tgt("S1", "iframe", "S0"), tgt("S3", "iframe", "S1"), tgt("S2", "worker", "S0"), tgt("X0", "page", null), tgt("X1", "iframe", "X0")];
    expect(oopifTargets(list, "S0").map((x) => x.sessionId)).toEqual(["S1", "S3"]);
  });

  test("chainTo: root first; a frame that is gone gives null", () => {
    expect(chainTo(S22, "TABLE")?.map((f) => f.frameId)).toEqual(["ROOT", "MAIN", "FORM", "TABLE"]);
    expect(chainTo(S22, "GONE")).toBeNull();
    expect(chainTo([raw("A", "B", "S", false, A, "/"), raw("B", "A", "S", false, A, "/")], "A")).toBeNull();
  });
});

describe("frame offset chain (docs/07 §1.1)", () => {
  // Content boxes the s22 spike measured (window 1280 wide, frameset cols 25%,75%):
  // <frame name=main> in the root: x 324, y 0; iframe#search in main via the tab
  // session (same process → already top-level): 334, 79.5; iframe#table in the
  // form's own session (OOPIF space): 10, 51.
  const boxes: Record<string, { session: string; owner: number; quad: number[] }> = {
    MAIN: { session: "S0", owner: 15, quad: [324, 0, 1280, 0, 1280, 657, 324, 657] },
    FORM: { session: "S0", owner: 41, quad: [334, 79.5, 814, 79.5, 814, 339.5, 334, 339.5] },
    TABLE: { session: "S1", owner: 23, quad: [10, 51, 410, 51, 410, 171, 10, 171] },
  };
  const fake = (): { t: Transport; calls: string[] } => {
    const calls: string[] = [];
    const t: Transport = {
      kind: "direct",
      closed: new Promise(() => undefined),
      async send(method, params = {}, sessionId = null) {
        calls.push(`${method}@${sessionId ?? "browser"}`);
        if (method === "DOM.getFrameOwner") {
          const b = boxes[String(params["frameId"])];
          if (b === undefined || b.session !== sessionId) throw new Error("no owner in this session");
          return { backendNodeId: b.owner };
        }
        if (method === "DOM.getBoxModel") {
          const b = Object.values(boxes).find((x) => x.owner === params["backendNodeId"] && x.session === sessionId);
          if (b === undefined) throw new Error("no box");
          return { model: { content: b.quad } };
        }
        throw new Error(`unexpected ${method}`);
      },
      onEvent: () => () => undefined,
      onAttach: () => () => undefined,
      onDetach: () => () => undefined,
      attach: () => Promise.reject(new Error("unused")),
      detach: async () => undefined,
      waitAttached: () => Promise.reject(new Error("unused")),
      targets: () => [],
    };
    return { t, calls };
  };

  test("same-process frames measure in the tab's space; an OOPIF and its same-process children in the OOPIF's", async () => {
    const chain = chainTo(S22, "TABLE");
    if (chain === null) throw new Error("no chain");
    const { t, calls } = fake();
    const at = await placeChain(t, chain);
    expect(at.origin).toEqual([
      { x: 0, y: 0 },
      { x: 324, y: 0 },
      { x: 334, y: 79.5 },
      { x: 344, y: 130.5 },
    ]);
    expect(at.space).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 334, y: 79.5 },
      { x: 334, y: 79.5 },
    ]);
    expect(at.owner).toEqual([null, 15, 41, 23]);
    // each owner is asked in its parent's session
    expect(calls).toEqual(["DOM.getFrameOwner@S0", "DOM.getBoxModel@S0", "DOM.getFrameOwner@S0", "DOM.getBoxModel@S0", "DOM.getFrameOwner@S1", "DOM.getBoxModel@S1"]);
  });

  test("an owner without a box fails instead of guessing", async () => {
    const chain = chainTo(S22, "MODAL");
    if (chain === null) throw new Error("no chain");
    await expect(placeChain(fake().t, chain)).rejects.toThrow();
  });
});
