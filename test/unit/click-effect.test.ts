// 0.6-D click effect: the pure classification and which CDP events count.
// Oracle: the owner's rule in the 0.6-D brief (after a default DOM click: the
// first of DOM mutation / navigation / new request observed, else "none" with
// a note suggesting --trusted; the exit code never changes) and the CDP event
// names of the Page / Network domains (protocol.json).

import { describe, expect, test } from "bun:test";
import { classifyEffect, isNavigationEvent, isRequestEvent, NO_EFFECT_NOTE } from "../../src/daemon/tools/effect.ts";

describe("click effect classification (0.6-D)", () => {
  test("nothing seen → none with the --trusted note", () => {
    expect(classifyEffect({ dom: null, navigation: null, request: null })).toEqual({ effect: "none", note: NO_EFFECT_NOTE });
    expect(NO_EFFECT_NOTE).toContain("--trusted");
  });

  test("the first effect observed wins; ties go dom, navigation, request", () => {
    expect(classifyEffect({ dom: 30, navigation: null, request: 10 })).toEqual({ effect: "request" });
    expect(classifyEffect({ dom: 5, navigation: 7, request: 6 })).toEqual({ effect: "dom" });
    expect(classifyEffect({ dom: null, navigation: 4, request: 4 })).toEqual({ effect: "navigation" });
    expect(classifyEffect({ dom: 4, navigation: 4, request: 4 })).toEqual({ effect: "dom" });
    expect(classifyEffect({ dom: Number.NaN, navigation: null, request: 9 })).toEqual({ effect: "request" });
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
});
