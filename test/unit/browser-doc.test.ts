// The shared CDP document helpers (docIdentity, settle, resolveRef,
// callResult): many tools and the live protection probe use them. The CDP
// answers come from a fake transport shaped like CDP's Page.getFrameTree /
// DOM.resolveNode / Runtime.callFunctionOn results (CDP protocol.json); the
// expectations are the helpers' documented behaviour (stale-ref and usage
// errors, root document identity with its URL fragment).

import { describe, expect, test } from "bun:test";
import { callResult, docIdentity, resolveRef, settle } from "../../src/daemon/browser/doc.ts";
import { RefTable } from "../../src/daemon/browser/refs.ts";
import type { Tab } from "../../src/daemon/browser/targets.ts";
import type { CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

type Page = { frame: Record<string, unknown> | null; sent: Array<{ method: string; params: CdpParams; sessionId: string | null }> };

function fakeTransport(page: Page): Transport {
  return {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}, sessionId: string | null = null): Promise<CdpResult> => {
      page.sent.push({ method, params, sessionId });
      if (method === "Page.getFrameTree") return page.frame === null ? {} : { frameTree: { frame: page.frame } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "DOM.resolveNode") {
        const id = params["backendNodeId"];
        if (id === 404) return {};
        return { object: { objectId: `${params["executionContextId"] === undefined ? "main" : "iso"}-${String(id)}` } };
      }
      throw new Error(`unexpected ${method}`);
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => {
      throw new Error("no attach");
    },
    detach: async () => undefined,
    waitAttached: async () => {
      throw new Error("no attach");
    },
    targets: () => [],
  };
}

function tab(): Tab {
  return {
    id: "t1",
    targetId: "T1",
    sessionId: "S1",
    session: "default",
    owned: true,
    reason: "ai-opened",
    opener: null,
    url: "https://a.test/p",
    title: "",
    navType: null,
    navEpoch: 1,
    pendingNavType: null,
    loading: false,
    refs: new RefTable(),
    dialog: null,
    queue: Promise.resolve(),
    closed: false,
    dialogWaiters: new Set(),
    pointer: null,
    emulation: {},
  };
}

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error && "code" in e ? String(e.code) : "thrown";
  }
};

describe("docIdentity", () => {
  test("root frame id, loaderId and URL with its fragment; no root frame is a cdp error", async () => {
    const page: Page = { frame: { id: "F1", loaderId: "L1", url: "https://a.test/p", urlFragment: "#x" }, sent: [] };
    expect(await docIdentity(fakeTransport(page), tab())).toEqual({ frameId: "F1", loaderId: "L1", url: "https://a.test/p#x" });
    expect(page.sent[0]).toEqual({ method: "Page.getFrameTree", params: {}, sessionId: "S1" });
    expect(await codeOf(docIdentity(fakeTransport({ frame: null, sent: [] }), tab()))).toBe("cdp");
    expect(await docIdentity(fakeTransport({ frame: { id: "F2" }, sent: [] }), tab())).toEqual({ frameId: "F2", loaderId: "", url: "" });
  });
});

describe("callResult", () => {
  test("the by-value result; an exception is a page error with the description", () => {
    expect(callResult({ result: { type: "number", value: 5 } })).toBe(5);
    expect(callResult({})).toBeUndefined();
    let err: unknown = null;
    try {
      callResult({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function" } } });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "page", message: "page script failed: TypeError: x is not a function" });
  });
});

describe("settle", () => {
  test("waits while the tab loads, at most ms", async () => {
    const t = tab();
    t.loading = true;
    setTimeout(() => {
      t.loading = false;
    }, 60);
    const t0 = Date.now();
    await settle(t, 5000);
    expect(t.loading).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000);
    const stuck = tab();
    stuck.loading = true;
    const t1 = Date.now();
    await settle(stuck, 0);
    expect(Date.now() - t1).toBeLessThan(1000);
  });
});

describe("resolveRef", () => {
  test("a ref of the current document → its node in the main world (or tabcap's isolated world); unknown, malformed, expired refs are errors", async () => {
    const page: Page = { frame: { id: "F1", loaderId: "L1", url: "https://a.test/p" }, sent: [] };
    const t = fakeTransport(page);
    const tb = tab();
    tb.refs.setDocument({ frameId: "F1", loaderId: "L1", url: "https://a.test/p" });
    const ref = tb.refs.refFor(42);
    const gone = tb.refs.refFor(404);
    expect(await resolveRef(t, tb, ref)).toEqual({ objectId: "main-42", backendNodeId: 42, sessionId: "S1", frame: null });
    expect(await resolveRef(t, tb, ref, { isolated: true })).toEqual({ objectId: "iso-42", backendNodeId: 42, sessionId: "S1", frame: null });
    expect(page.sent.some((x) => x.method === "Page.createIsolatedWorld" && x.params["frameId"] === "F1")).toBe(true);
    expect(await codeOf(resolveRef(t, tb, gone))).toBe("stale-ref");
    expect(await codeOf(resolveRef(t, tb, "e99"))).toBe("stale-ref");
    expect(await codeOf(resolveRef(t, tb, "nope"))).toBe("usage");
    page.frame = { id: "F1", loaderId: "L2", url: "https://a.test/p" };
    expect(await codeOf(resolveRef(t, tb, ref))).toBe("stale-ref");
  });
});
