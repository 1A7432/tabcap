// 0.6-D click effect: the pure classification and which CDP events count.
// Oracle: the owner's rule in the 0.6-D brief (after a default DOM click: the
// first of DOM mutation / navigation / new request observed, else "none" with
// a note suggesting --trusted; the exit code never changes) and the CDP event
// names of the Page / Network domains (protocol.json).
// 0.6-R popup: the owner's 0.6-R brief (a click that opens a page the session
// owns reports effect "popup" with the new tab id, URL when known, and no
// --trusted hint) and TargetInfo.openerId / type of the Target domain.
// 0.6-U popup window: the owner's 0.6-U brief (a popup seen at any point before
// the watch returns is in the answer and outranks; the grace after the wait
// stays within POPUP_REGISTER_MS).

import { describe, expect, test } from "bun:test";
import { classifyEffect, isNavigationEvent, isRequestEvent, NO_EFFECT_NOTE, POPUP_REGISTER_MS, POPUP_SETTLE_MS, popupGraceOver, popupNote, popupTargetOf } from "../../src/daemon/tools/effect.ts";

describe("click effect classification (0.6-D)", () => {
  test("nothing seen → none with the --trusted note", () => {
    expect(classifyEffect({ dom: null, navigation: null, request: null, popup: null })).toEqual({ effect: "none", note: NO_EFFECT_NOTE });
    expect(NO_EFFECT_NOTE).toContain("--trusted");
  });

  test("the first effect observed wins; ties go dom, navigation, request", () => {
    expect(classifyEffect({ dom: 30, navigation: null, request: 10, popup: null })).toEqual({ effect: "request" });
    expect(classifyEffect({ dom: 5, navigation: 7, request: 6, popup: null })).toEqual({ effect: "dom" });
    expect(classifyEffect({ dom: null, navigation: 4, request: 4, popup: null })).toEqual({ effect: "navigation" });
    expect(classifyEffect({ dom: 4, navigation: 4, request: 4, popup: null })).toEqual({ effect: "dom" });
    expect(classifyEffect({ dom: Number.NaN, navigation: null, request: 9, popup: null })).toEqual({ effect: "request" });
  });

  test("which CDP events count", () => {
    expect(isNavigationEvent({ method: "Page.frameRequestedNavigation", params: {} })).toBe(true);
    expect(isNavigationEvent({ method: "Page.frameStartedNavigating", params: {} })).toBe(true);
    expect(isNavigationEvent({ method: "Page.navigatedWithinDocument", params: {} })).toBe(true);
    expect(isNavigationEvent({ method: "Page.loadEventFired", params: {} })).toBe(false);
    expect(isRequestEvent({ method: "Network.requestWillBeSent", params: { request: { url: "http://127.0.0.1:9/api" } } })).toBe(true);
    expect(isRequestEvent({ method: "Network.requestWillBeSent", params: { request: { url: "data:image/png;base64,AA" } } })).toBe(false);
    expect(isRequestEvent({ method: "Network.requestWillBeSent", params: { request: "junk" } })).toBe(true);
    expect(isRequestEvent({ method: "Network.responseReceived", params: {} })).toBe(false);
  });

  test("0.6-R: a popup outranks every other effect; its note names the tab and never suggests --trusted", () => {
    const popup = { at: 50, tab: "t2", url: "http://127.0.0.1:9/popup-target" };
    expect(classifyEffect({ dom: 10, navigation: null, request: 20, popup })).toEqual({ effect: "popup", popup: { tab: "t2", url: "http://127.0.0.1:9/popup-target" }, note: popupNote("t2") });
    expect(classifyEffect({ dom: null, navigation: null, request: null, popup: { at: 1, tab: "t3", url: "about:blank" } })).toEqual({ effect: "popup", popup: { tab: "t3" }, note: popupNote("t3") });
    expect(classifyEffect({ dom: null, navigation: null, request: null, popup: { at: 1, tab: "t3", url: "" } })).toEqual({ effect: "popup", popup: { tab: "t3" }, note: popupNote("t3") });
    expect(classifyEffect({ dom: null, navigation: null, request: null, popup: { at: 1, tab: null, url: null } })).toEqual({ effect: "popup", popup: { tab: null }, note: popupNote(null) });
    for (const tab of ["t2", null]) {
      expect(popupNote(tab)).not.toContain("--trusted");
      expect(popupNote(tab)).toContain("tab select");
    }
    expect(popupNote("t2")).toContain("--tab t2");
  });

  test("0.6-R: which Target events name a page opened by the clicked tab", () => {
    const info = (o: Record<string, unknown>) => ({ targetInfo: { targetId: "P2", type: "page", url: "", openerId: "T1", ...o } });
    expect(popupTargetOf({ method: "Target.targetCreated", params: info({}), sessionId: null }, "T1")).toBe("P2");
    expect(popupTargetOf({ method: "Target.attachedToTarget", params: { sessionId: "S2", ...info({}) }, sessionId: null }, "T1")).toBe("P2");
    expect(popupTargetOf({ method: "Target.targetCreated", params: info({ openerId: "T9" }), sessionId: null }, "T1")).toBeNull();
    expect(popupTargetOf({ method: "Target.targetCreated", params: info({ openerId: undefined }), sessionId: null }, "T1")).toBeNull();
    expect(popupTargetOf({ method: "Target.targetCreated", params: info({ type: "iframe" }), sessionId: null }, "T1")).toBeNull();
    expect(popupTargetOf({ method: "Target.targetCreated", params: info({}), sessionId: "S1" }, "T1")).toBeNull();
    expect(popupTargetOf({ method: "Target.targetInfoChanged", params: info({}), sessionId: null }, "T1")).toBeNull();
    expect(popupTargetOf({ method: "Target.targetCreated", params: { targetInfo: "junk" }, sessionId: null }, "T1")).toBeNull();
  });

  test("0.6-U: request seen first, popup later (after the wait, in the grace) → effect popup with the popup field", () => {
    const late = { at: 1900, tab: "t2", url: "http://127.0.0.1:9/popup-target" };
    expect(classifyEffect({ dom: null, navigation: null, request: 100, popup: late })).toEqual({ effect: "popup", popup: { tab: "t2", url: "http://127.0.0.1:9/popup-target" }, note: popupNote("t2") });
    expect(classifyEffect({ dom: 50, navigation: 60, request: 100, popup: { at: 2100, tab: null, url: null } })).toEqual({ effect: "popup", popup: { tab: null }, note: popupNote(null) });
  });

  test("0.6-U: the grace after the wait: registration of a seen popup, or a watched request that may still open one; never past the deadline", () => {
    const base = { now: 1000, deadline: 1000 + POPUP_REGISTER_MS, popup: null, inflight: 0, lastEnd: null, requests: true };
    expect(POPUP_REGISTER_MS).toBe(2000);
    // no popup, no request: over at once (a plain click is not slowed)
    expect(popupGraceOver(base)).toBe(true);
    // a watched request still in flight: keep looking; a dialog (requests false) does not
    expect(popupGraceOver({ ...base, inflight: 1 })).toBe(false);
    expect(popupGraceOver({ ...base, inflight: 1, requests: false })).toBe(true);
    // the last request ended just now: wait POPUP_SETTLE_MS for its handler
    expect(popupGraceOver({ ...base, lastEnd: 1000 - POPUP_SETTLE_MS + 1 })).toBe(false);
    expect(popupGraceOver({ ...base, lastEnd: 1000 - POPUP_SETTLE_MS })).toBe(true);
    // a popup seen: until it is registered, whatever the requests do
    expect(popupGraceOver({ ...base, popup: { registered: false } })).toBe(false);
    expect(popupGraceOver({ ...base, popup: { registered: true }, inflight: 3 })).toBe(true);
    // the deadline ends everything
    expect(popupGraceOver({ ...base, now: base.deadline, popup: { registered: false }, inflight: 2 })).toBe(true);
  });
});
