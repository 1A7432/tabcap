// 0.9-B: `tabcap permission grant|deny|reset <name>...` (docs/04 §46, docs/05 s73).
// The arguments, the origin rules, the descriptor, the mapping of Chrome's
// refusals and the loop over several names are checked here with a fake
// transport; what Chrome really does with them is test/e2e/v09b.e2e.test.ts.
// Oracle for the CDP shapes: docs/07 §1.1 (spike-dp5 E2: `Invalid
// PermissionDescriptor name: <x>`, `push` needs `userVisibleOnly:true`,
// `browserContextId` limits the effect to that context).
// Reproduce: bun test test/unit/permission.test.ts

import { describe, expect, test } from "bun:test";
import { COMMANDS, matchCommand, parseCommand } from "../../src/cli/commands.ts";
import { actionsWhere } from "../../src/daemon/tools/registry.ts";
import { TOOLS } from "../../src/daemon/tools/index.ts";
import {
  KNOWN_PERMISSIONS,
  applyPermissions,
  closestPermission,
  descriptorOf,
  directOnly,
  parseNames,
  parseSetting,
  permissionError,
  permissionNote,
  permissionOrigin,
  type PermissionRequest,
} from "../../src/daemon/tools/permission.ts";
import { CdpClosedError, CdpError, CdpTimeoutError } from "../../src/daemon/transport/direct/cdp.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import type { CdpParams, CdpResult, Transport } from "../../src/daemon/transport/types.ts";

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
  return "none";
};

describe("arguments", () => {
  test("the fixed setting is one of the three CDP settings", () => {
    expect(parseSetting({ setting: "granted" })).toBe("granted");
    expect(parseSetting({ setting: "denied" })).toBe("denied");
    expect(parseSetting({ setting: "prompt" })).toBe("prompt");
    for (const bad of [{}, { setting: "allow" }, { setting: "" }, { setting: "GRANTED" }]) expect([bad, code(() => parseSetting(bad))]).toEqual([bad, "usage"]);
    expect(code(() => parseSetting({ setting: 1 }))).toBe("usage");
  });

  test("names keep their order, duplicates are dropped, one string is a list of one", () => {
    expect(parseNames({ names: ["geolocation", "notifications"] })).toEqual(["geolocation", "notifications"]);
    expect(parseNames({ names: ["notifications", "geolocation", "notifications"] })).toEqual(["notifications", "geolocation"]);
    expect(parseNames({ names: "midi" })).toEqual(["midi"]);
    expect(parseNames({ names: ["clipboard-read", "top-level-storage-access", "a_b"] })).toEqual(["clipboard-read", "top-level-storage-access", "a_b"]);
  });

  test("none, an empty or odd-looking name, too many names: usage", () => {
    for (const bad of [{}, { names: [] }, { names: [""] }, { names: ["geo location"] }, { names: ["geo;location"] }, { names: ['"x"'] }, { names: ["1abc"] }, { names: ["-camera"] }, { names: ["x".repeat(65)] }, { names: ["ok", "bad name"] }, { names: [5] }, { names: 5 }]) {
      expect([JSON.stringify(bad), code(() => parseNames(bad))]).toEqual([JSON.stringify(bad), "usage"]);
    }
    expect(code(() => parseNames({ names: Array.from({ length: 33 }, (_, i) => `n${i}`) }))).toBe("usage");
    expect(parseNames({ names: Array.from({ length: 32 }, (_, i) => `n${i}`) })).toHaveLength(32);
  });

  test("the commands: grant / deny / reset carry their setting and a list of names, flags --origin and --tab", () => {
    for (const [verb, setting] of [["grant", "granted"], ["deny", "denied"], ["reset", "prompt"]] as const) {
      const c = matchCommand(["permission", verb]);
      if (c === null) throw new Error(`no command permission ${verb}`);
      const p = parseCommand(c, ["geolocation", "notifications", "--origin", "https://example.com/x?y=1", "--tab", "t2"]);
      expect(p.args).toMatchObject({ setting, names: ["geolocation", "notifications"], origin: "https://example.com/x?y=1", tab: "t2" });
      expect(c.action).toBe("permission");
      expect(() => parseCommand(c, [])).toThrow(TabcapError);
    }
    expect(COMMANDS.filter((c) => c.path[0] === "permission").map((c) => c.path.join(" "))).toEqual(["permission grant", "permission deny", "permission reset"]);
  });

  test("the action: a tool, in the same row class as emulate (refused while waiting for the human, no command window)", () => {
    expect(typeof TOOLS["permission"]).toBe("function");
    expect(actionsWhere("blockedWhileWaiting").has("permission")).toBe(actionsWhere("blockedWhileWaiting").has("emulate"));
    expect(actionsWhere("actsOnPage").has("permission")).toBe(actionsWhere("actsOnPage").has("emulate"));
    expect(actionsWhere("cmdWindow").has("permission")).toBe(actionsWhere("cmdWindow").has("emulate"));
    expect(actionsWhere("blockedWhileWaiting").has("permission")).toBe(true);
  });
});

describe("permissionOrigin", () => {
  test("the current tab's origin: scheme, host and port, nothing else", () => {
    expect(permissionOrigin("http://127.0.0.1:8080/s73?a=1#x", null)).toBe("http://127.0.0.1:8080");
    expect(permissionOrigin("https://example.com/", null)).toBe("https://example.com");
    expect(permissionOrigin("https://example.com:443/p", null)).toBe("https://example.com");
    expect(permissionOrigin("http://[::1]:3000/p", null)).toBe("http://[::1]:3000");
    expect(permissionOrigin("https://user:pw@example.com/p", null)).toBe("https://example.com");
  });

  test("--origin: the URL's origin; path, query and fragment are dropped, and it wins over the tab", () => {
    expect(permissionOrigin("about:blank", "https://shop.example/any/path?q=1#frag")).toBe("https://shop.example");
    expect(permissionOrigin("http://127.0.0.1:1/", "http://127.0.0.1:2/x")).toBe("http://127.0.0.1:2");
    expect(permissionOrigin("http://a.test/", "https://b.test:8443")).toBe("https://b.test:8443");
  });

  test("a tab without an http(s) origin: usage that names --origin and navigate", () => {
    for (const url of ["about:blank", "data:text/html,<p>x</p>", "chrome-error://chromewebdata/", "file:///tmp/x.html", "", "not a url", "chrome://version/", "blob:http://a.test/uuid"]) {
      try {
        permissionOrigin(url, null);
        throw new Error(`accepted ${url}`);
      } catch (e) {
        expect(e instanceof TabcapError && e.code).toBe("usage");
        expect((e as TabcapError).next).toContain("--origin");
        expect((e as TabcapError).next).toContain("navigate");
      }
    }
  });

  test("--origin that is no http(s) URL: usage, and the value is not echoed", () => {
    for (const bad of ["file:///tmp", "about:blank", "data:text/plain,secret-x", "ftp://example.com/", "not a url", "", "example.com", "chrome://version"]) {
      try {
        permissionOrigin("http://a.test/", bad);
        throw new Error(`accepted ${bad}`);
      } catch (e) {
        expect([bad, e instanceof TabcapError && e.code]).toEqual([bad, "usage"]);
        expect((e as TabcapError).message).not.toContain("secret-x");
      }
    }
  });
});

describe("descriptorOf and closestPermission", () => {
  test("push carries userVisibleOnly, fullscreen allowWithoutGesture, every other name goes as a bare name", () => {
    expect(descriptorOf("push")).toEqual({ name: "push", userVisibleOnly: true });
    expect(descriptorOf("fullscreen")).toEqual({ name: "fullscreen", allowWithoutGesture: true });
    for (const n of ["geolocation", "notifications", "clipboard-read", "midi", "camera", "somethingnew"]) expect(descriptorOf(n)).toEqual({ name: n });
  });

  test("the nearest known name, case-insensitively; nothing near: null", () => {
    expect(closestPermission("geolocaton")).toBe("geolocation");
    expect(closestPermission("Geolocation")).toBe("geolocation");
    expect(closestPermission("notificatons")).toBe("notifications");
    expect(closestPermission("clipboard_read")).toBe("clipboard-read");
    expect(closestPermission("microfon")).toBe("microphone");
    expect(closestPermission("xyzzy-plugh")).toBeNull();
    expect(closestPermission("zzzzzzzzzzzz")).toBeNull();
    expect(closestPermission("geolocaton", ["geolocation"])).toBe("geolocation");
    expect(closestPermission("geo", ["geolocation"])).toBeNull(); // a prefix is not a typo
    expect(closestPermission("x", [])).toBeNull();
  });

  test("the hint table has no duplicates and only Chrome-style names", () => {
    expect(new Set(KNOWN_PERMISSIONS).size).toBe(KNOWN_PERMISSIONS.length);
    for (const n of KNOWN_PERMISSIONS) expect(n).toMatch(/^[a-z][a-z-]*$/);
    for (const n of ["geolocation", "notifications", "push", "midi", "camera", "microphone", "clipboard-read"]) expect(KNOWN_PERMISSIONS).toContain(n);
  });
});

const invalid = (name: string): CdpError => new CdpError("Browser.setPermission", `Invalid PermissionDescriptor name: ${name}`, -32602);

describe("permissionError: what a refusal becomes", () => {
  test("Chrome's refusal of a name: usage with Chrome's words, the nearest name, and what was applied before", () => {
    const e = permissionError(invalid("geolocaton"), "geolocaton", ["notifications"]);
    expect(e).toBeInstanceOf(TabcapError);
    if (!(e instanceof TabcapError)) return;
    expect(e.code).toBe("usage");
    expect(e.message).toBe("Browser.setPermission: Invalid PermissionDescriptor name: geolocaton");
    expect(e.next).toContain("`geolocation`");
    expect(e.next).toContain("notifications");
    expect(e.extra).toEqual({ result: { applied: ["notifications"] } });
  });

  test("the first name failing: applied is empty; no near name: the next lists known names", () => {
    const e = permissionError(invalid("qqqqqqqqqqqq"), "qqqqqqqqqqqq", []);
    if (!(e instanceof TabcapError)) throw new Error("not a TabcapError");
    expect(e.code).toBe("usage");
    expect(e.extra).toEqual({ result: { applied: [] } });
    expect(e.next).toContain("geolocation");
    expect(e.next).not.toContain("Did you mean");
  });

  test("another refusal from Chrome stays a cdp error with the same result", () => {
    const e = permissionError(new CdpError("Browser.setPermission", "Push Permission without userVisibleOnly:true isn't supported", -32602), "push", ["camera"]);
    if (!(e instanceof TabcapError)) throw new Error("not a TabcapError");
    expect(e.code).toBe("cdp");
    expect(e.message).toContain("userVisibleOnly");
    expect(e.extra).toEqual({ result: { applied: ["camera"] } });
  });

  test("a timeout or a closed connection is passed on for the daemon's own mapping; a non-Error becomes one", () => {
    const timeout = new CdpTimeoutError("Browser.setPermission", 100);
    expect(permissionError(timeout, "midi", [])).toBe(timeout);
    const closed = new CdpClosedError("Browser.setPermission", "pipe ended");
    expect(permissionError(closed, "midi", [])).toBe(closed);
    expect(permissionError("boom", "midi", [])).toBeInstanceOf(Error);
  });
});

type Sent = { method: string; params: CdpParams; sessionId: string | null | undefined };

/** A transport whose Browser.setPermission fails for the names in `refuse` (with Chrome's refusal of a name). */
function fakeBrowser(refuse: string[] = []) {
  const sent: Sent[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}, sessionId): Promise<CdpResult> => {
      sent.push({ method, params, sessionId });
      const d = params["permission"];
      const name = typeof d === "object" && d !== null && "name" in d && typeof d.name === "string" ? d.name : "";
      if (refuse.includes(name)) throw invalid(name);
      return {};
    },
    onEvent: () => () => undefined,
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => {
      throw new Error("unused");
    },
    detach: async () => undefined,
    waitAttached: async () => {
      throw new Error("unused");
    },
    targets: () => [],
  };
  return { t, sent };
}

const req = (o: Partial<PermissionRequest> = {}): PermissionRequest => ({ names: ["geolocation"], setting: "granted", origin: "http://127.0.0.1:9", browserContextId: null, ...o });

describe("applyPermissions", () => {
  test("one Browser.setPermission per name, in order, browser level, with the origin and the setting", async () => {
    const f = fakeBrowser();
    await applyPermissions(f.t, req({ names: ["geolocation", "notifications", "push"], setting: "denied" }), 5000);
    expect(f.sent.map((s) => s.method)).toEqual(["Browser.setPermission", "Browser.setPermission", "Browser.setPermission"]);
    expect(f.sent.map((s) => s.params["permission"])).toEqual([{ name: "geolocation" }, { name: "notifications" }, { name: "push", userVisibleOnly: true }]);
    for (const s of f.sent) {
      expect(s.params["setting"]).toBe("denied");
      expect(s.params["origin"]).toBe("http://127.0.0.1:9");
      expect(s.sessionId).toBeNull();
      expect("browserContextId" in s.params).toBe(false);
    }
  });

  test("a session with its own context passes that browserContextId on every call, and only then", async () => {
    const f = fakeBrowser();
    await applyPermissions(f.t, req({ names: ["midi", "camera"], browserContextId: "CTX-1" }), 5000);
    expect(f.sent.map((s) => s.params["browserContextId"])).toEqual(["CTX-1", "CTX-1"]);
  });

  test("reset is prompt for the one origin: never Browser.resetPermissions", async () => {
    const f = fakeBrowser();
    await applyPermissions(f.t, req({ setting: "prompt" }), 5000);
    expect(f.sent.map((s) => s.method)).toEqual(["Browser.setPermission"]);
    expect(f.sent[0]?.params["setting"]).toBe("prompt");
  });

  test("the first refusal stops the loop: later names are not sent, the error lists what was applied", async () => {
    const f = fakeBrowser(["geolocaton"]);
    const err = await applyPermissions(f.t, req({ names: ["notifications", "geolocaton", "camera"] }), 5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TabcapError);
    if (!(err instanceof TabcapError)) return;
    expect(err.code).toBe("usage");
    expect(err.extra).toEqual({ result: { applied: ["notifications"] } });
    expect(f.sent.map((s) => rec(s.params["permission"])["name"])).toEqual(["notifications", "geolocaton"]);
  });
});

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {});

describe("answer note and mode", () => {
  test("shared default context: the note says who sees it; geolocation adds the hidden-tab caveat; neither: no note", () => {
    const shared = permissionNote({ names: ["midi"], origin: "http://a.test", shared: true });
    expect(shared).toContain("default context");
    expect(shared).toContain("http://a.test");
    expect(shared).not.toContain("geolocation");
    const geo = permissionNote({ names: ["geolocation", "notifications"], origin: "http://a.test", shared: false });
    expect(geo).toContain("hidden");
    expect(geo).toContain("visible tab");
    expect(geo).toContain("not a reliable way");
    expect(geo).toContain("emulate --geolocation");
    expect(geo).not.toContain("default context");
    const both = permissionNote({ names: ["geolocation"], origin: "http://a.test", shared: true });
    expect(both).toContain("default context");
    expect(both).toContain("not a reliable way");
    expect(permissionNote({ names: ["midi"], origin: "http://a.test", shared: false })).toBeNull();
  });

  test("ext mode is refused as unsupported, direct is fine", () => {
    expect(code(() => directOnly("ext"))).toBe("unsupported");
    expect(code(() => directOnly("direct"))).toBe("none");
  });
});
