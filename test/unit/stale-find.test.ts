import { describe, expect, test } from "bun:test";
import { findCandidates, hitOf, rankClickable, type AxNode } from "../../src/daemon/browser/ax.ts";
import { ACTIVE_FN, CLICK_FN, FILL_FN, FOCUS_SELECT_FN, SCROLL_FN, activeFieldOf, liveOrStale } from "../../src/daemon/tools/input.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

/** Compile one of the page functions and call it with a fake `this` (it never touches the page when stale). */
const pageFn = (src: string): ((this: unknown, ...a: unknown[]) => unknown) => new Function(`return ${src};`)();

describe("stale-ref guard in the page functions (docs/05 s18)", () => {
  const detachedEl = { nodeType: 1, isConnected: false };
  const detachedText = { nodeType: 3, parentElement: detachedEl };
  const orphanText = { nodeType: 3, parentElement: null };
  for (const [name, src] of [
    ["CLICK_FN", CLICK_FN],
    ["SCROLL_FN", SCROLL_FN],
    ["FILL_FN", FILL_FN],
    ["FOCUS_SELECT_FN", FOCUS_SELECT_FN],
  ] as const) {
    test(`${name}: a detached node or a node without an element is stale`, () => {
      const f = pageFn(src);
      expect(f.call(detachedEl, "x")).toEqual({ stale: true });
      expect(f.call(detachedText, "x")).toEqual({ stale: true });
      expect(f.call(orphanText, "x")).toEqual({ stale: true });
    });
  }

  test("CLICK_FN on a connected element clicks it", () => {
    let clicked = 0;
    const el = { nodeType: 1, isConnected: true, tagName: "SPAN", scrollIntoView: () => undefined, click: () => clicked++ };
    expect(pageFn(CLICK_FN).call(el)).toEqual({ ok: true, tag: "span" });
    expect(clicked).toBe(1);
  });

  test("liveOrStale: stale → stale-ref with `run snapshot again`", () => {
    expect(liveOrStale({ ok: true }, "e3")).toEqual({ ok: true });
    try {
      liveOrStale({ stale: true }, "e3");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TabcapError);
      if (!(e instanceof TabcapError)) return;
      expect(e.code).toBe("stale-ref");
      expect(e.message).toContain("e3");
      expect(e.next.startsWith("run snapshot again")).toBe(true);
    }
  });
});

describe("type: the focused element must still be in the page (docs/04 §17)", () => {
  const evalActive = (doc: unknown): Record<string, unknown> => {
    const v: unknown = new Function("document", `return ${ACTIVE_FN};`)(doc);
    if (typeof v !== "object" || v === null) throw new Error("ACTIVE_FN returned no object");
    return Object.fromEntries(Object.entries(v));
  };
  const input = (o: Record<string, unknown> = {}) => ({ isConnected: true, isContentEditable: false, shadowRoot: null, tagName: "INPUT", getAttribute: (n: string) => (n === "type" ? "password" : null), ...o });
  const body = { isConnected: true, isContentEditable: false, shadowRoot: null, tagName: "BODY", getAttribute: () => null };
  const doc = (active: unknown, designMode = "off") => ({ activeElement: active, body, documentElement: {}, designMode });

  test("a connected focused field passes and reports password-like fields", () => {
    const v = evalActive(doc(input()));
    expect(v).toMatchObject({ connected: true, none: false, tag: "input", type: "password" });
    expect(activeFieldOf(v)).toEqual({ sensitive: true });
  });

  test("focus inside an open shadow root is followed", () => {
    const inner = input({ getAttribute: () => null });
    const host = { ...input(), tagName: "X-FIELD", shadowRoot: { activeElement: inner } };
    expect(evalActive(doc(host))).toMatchObject({ connected: true, none: false, tag: "input", type: null });
  });

  test("a detached focused element, or focus back on <body>, is stale-ref; an editable body is not", () => {
    for (const v of [evalActive(doc(input({ isConnected: false }))), evalActive(doc(body)), evalActive(doc(null))]) {
      try {
        activeFieldOf(v);
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(TabcapError);
        if (!(e instanceof TabcapError)) return;
        expect(e.code).toBe("stale-ref");
        expect(e.next.startsWith("run snapshot again")).toBe(true);
      }
    }
    expect(activeFieldOf(evalActive(doc(body, "on")))).toEqual({ sensitive: false });
  });
});

const node = (role: string, name: string, backendId: number | null, children: AxNode[] = []): AxNode => ({ role, name, value: null, description: "", backendId, password: false, flags: [], children });

describe("find: clickable hits first (docs/05 s19)", () => {
  // Element-UI style: a note mentioning the label, the custom checkbox's label text, a heading and a div role=none "button".
  const root = node("RootWebArea", "login", null, [
    node("heading", "登录", 10),
    node("form", "", 20, [
      node("text", "请勾选记住密码以便下次自动登录", 21),
      node("checkbox", "", 22),
      node("text", "记住密码", 23),
      node("text", "登录", 24),
    ]),
    node("button", "记住密码 help", 30),
  ]);

  test("candidates keep document order; AX controls carry clickId", () => {
    const { cands, total } = findCandidates(root, "记住密码", 200);
    expect(total).toBe(3);
    expect(cands.map((c) => c.node.backendId)).toEqual([21, 23, 30]);
    expect(cands.map((c) => c.clickId)).toEqual([null, null, 30]);
    expect(cands.map((c) => c.ownId)).toEqual([20, 20, 30]);
  });

  test("rankClickable is a stable partition", () => {
    expect(rankClickable([1, 2, 3, 4, 5, 6], (n) => n % 3 === 0)).toEqual([3, 6, 1, 2, 4, 5]);
    expect(rankClickable([], () => true)).toEqual([]);
  });

  test("a DOM-clickable element (cursor / listener) ranks before plain text and becomes the click target", () => {
    const { cands } = findCandidates(root, "记住密码", 200);
    const dom = new Map([[cands[1], { backendId: 99, by: "listener" }]]);
    const ranked = rankClickable(cands, (c) => c.clickId !== null || dom.has(c));
    let n = 0;
    const refs = new Map<number, string>();
    const refFor = (id: number) => refs.get(id) ?? (refs.set(id, `e${++n}`), `e${n}`);
    const hits = ranked.map((c) => hitOf(c, refFor, dom.get(c) ?? null));
    expect(hits.map((h) => [h.name, h.clickable !== null, h.clickableBy])).toEqual([
      ["记住密码", true, "listener"],
      ["记住密码 help", true, "role"],
      ["请勾选记住密码以便下次自动登录", false, null],
    ]);
    expect(hits[0]?.clickable).toBe(refFor(99));
  });
});

describe("type: focus followed into frames (0.4-I)", () => {
  const evalActive = (doc: unknown): Record<string, unknown> => {
    const v: unknown = new Function("document", `return ${ACTIVE_FN};`)(doc);
    if (typeof v !== "object" || v === null) throw new Error("ACTIVE_FN returned no object");
    return Object.fromEntries(Object.entries(v));
  };
  const el = (tagName: string, o: Record<string, unknown> = {}) => ({ isConnected: true, isContentEditable: false, shadowRoot: null, tagName, getAttribute: () => null, ...o });
  const body = el("BODY");
  const doc = (active: unknown) => ({ activeElement: active, body, documentElement: {}, designMode: "off" });

  test("a same-origin frame's focused password field is found through its contentDocument", () => {
    const pw = el("INPUT", { getAttribute: (n: string) => (n === "type" ? "password" : null) });
    const frame = el("IFRAME", { contentDocument: doc(pw) });
    expect(evalActive(doc(el("FRAME", { contentDocument: doc(frame) })))).toMatchObject({ connected: true, none: false, tag: "input", type: "password" });
    expect(activeFieldOf(evalActive(doc(el("FRAME", { contentDocument: doc(frame) }))))).toEqual({ sensitive: true });
  });

  test("a cross-origin frame (no contentDocument) asks the caller to continue in its session", () => {
    expect(evalActive(doc(el("IFRAME", { contentDocument: null })))).toMatchObject({ cross: true, connected: true, none: false, tag: "iframe" });
    const throwing = el("IFRAME");
    Object.defineProperty(throwing, "contentDocument", {
      get() {
        throw new Error("blocked");
      },
    });
    expect(evalActive(doc(throwing))).toMatchObject({ cross: true });
  });

  test("focus on <body> inside a same-origin frame is still `none` (the field went away)", () => {
    expect(evalActive(doc(el("IFRAME", { contentDocument: doc(body) })))).toMatchObject({ none: true });
  });
});
