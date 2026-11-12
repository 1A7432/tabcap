// 0.6-R session leftovers: a failed `session start --site` leaves no account
// context behind (bindAccount is all or nothing), and `fill --secret` on a
// session that no `session start --site` bound is refused with the command
// that binds it. Oracle: the owner's 0.6-R brief (a failed start leaves no
// half-made session; an unbound fill fails with a clear `next`), and the CDP
// Target domain (createBrowserContext / disposeBrowserContext).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/state.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { unboundSecretError } from "../../src/daemon/tools/input.ts";
import { bindAccount, defaultContextClash } from "../../src/daemon/tools/session.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { paths } from "../../src/shared/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): { d: Daemon; s: Store } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-06r-"));
  dirs.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  const s = Store.open(p.config);
  s.addSite({ name: "example", entryUrl: "http://127.0.0.1:4310/", domains: [], username: "alice", password: "Site-pass-123" });
  const d = new Daemon(p);
  d.store = s;
  return { d, s };
}

/** Browser-level calls only; records every send. */
function fakeBrowser() {
  const sent: Array<{ method: string; params: CdpParams }> = [];
  const target = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const listeners = new Set<(e: CdpEvent) => void>();
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method, params = {}) => {
      sent.push({ method, params });
      if (method === "Target.createBrowserContext") return { browserContextId: "CTX1" };
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: () => () => undefined,
    attach: async () => target(),
    detach: async () => undefined,
    waitAttached: async () => target(),
    targets: () => [],
  };
  return { t, sent };
}

describe("bindAccount is all or nothing (0.6-R; an own context: --isolate since docs/04 §52.6)", () => {
  test("a failure after the account's context opened disposes it: no context in the pool or the session's tab map", async () => {
    const { d, s } = home();
    const f = fakeBrowser();
    const tabs = { sessionTabs: () => [], contexts: new Map<string, string>() };
    s.patchAccount = () => {
      throw new TabcapError("io", "disk full", "free some space");
    };
    let err: unknown = null;
    await bindAccount(d, f.t, tabs, "s1", "example", null, true).catch((e: unknown) => {
      err = e;
    });
    expect(err instanceof TabcapError ? err.message : String(err)).toBe("disk full");
    expect(d.pool.contexts.has("s1")).toBe(false);
    expect(tabs.contexts.has("s1")).toBe(false);
    expect(f.sent.map((x) => x.method)).toEqual(["Target.createBrowserContext", "Target.disposeBrowserContext"]);
    expect(f.sent[1]?.params).toEqual({ browserContextId: "CTX1" });
    s.close();
  });

  test("the success path keeps the context and binds the account", async () => {
    const { d, s } = home();
    const f = fakeBrowser();
    const tabs = { sessionTabs: () => [], contexts: new Map<string, string>() };
    const r = await bindAccount(d, f.t, tabs, "s1", "example", null, true);
    expect(r.binding).toEqual({ site: "example", account: "alice", proxy: null });
    expect(tabs.contexts.get("s1")).toBe("CTX1");
    expect(d.pool.contexts.get("s1")?.browserContextId).toBe("CTX1");
    expect(f.sent.map((x) => x.method)).toEqual(["Target.createBrowserContext"]);
    s.close();
  });

  test("a check that fails before the context opens sends nothing", async () => {
    const { d, s } = home();
    const f = fakeBrowser();
    const tabs = { sessionTabs: () => [{ id: "t1" }], contexts: new Map<string, string>() };
    const got: { code: string | null } = { code: null };
    await bindAccount(d, f.t, tabs, "s1", "example", null, true).catch((e: unknown) => {
      got.code = e instanceof TabcapError ? e.code : "other";
    });
    expect(got.code).toBe("conflict");
    expect(f.sent).toEqual([]);
    expect(d.pool.contexts.size).toBe(0);
    s.close();
  });
});

describe("bindAccount in the default context (docs/04 §52.6)", () => {
  test("no browser context is made; the account is bound; saved cookies go to the default context", async () => {
    const { d, s } = home();
    const f = fakeBrowser();
    const tabs = { sessionTabs: () => [{ id: "t1" }], contexts: new Map<string, string>() };
    const r = await bindAccount(d, f.t, tabs, "s1", "example", null);
    expect(r.binding).toEqual({ site: "example", account: "alice", proxy: null });
    expect(tabs.contexts.has("s1")).toBe(false);
    expect(d.pool.contexts.has("s1")).toBe(false);
    expect(f.sent.map((x) => x.method).filter((m) => m.includes("BrowserContext"))).toEqual([]);
    s.close();
  });

  test("another live session with another account of the same site in the default context: conflict naming --isolate", async () => {
    const { d, s } = home();
    const f = fakeBrowser();
    d.sites.set("other", { site: "example", account: "bob", proxy: null });
    const tabs = { sessionTabs: () => [], contexts: new Map<string, string>() };
    const got: { code: string | null; next: string } = { code: null, next: "" };
    await bindAccount(d, f.t, tabs, "s1", "example", null).catch((e: unknown) => {
      got.code = e instanceof TabcapError ? e.code : "other";
      got.next = e instanceof TabcapError ? e.next : "";
    });
    expect(got.code).toBe("conflict");
    expect(got.next).toContain("--isolate");
    expect(f.sent).toEqual([]);
    s.close();
  });
});

describe("defaultContextClash (docs/04 §52.6)", () => {
  const o = (session: string, site: string, account: string | null, isolated = false) => ({ session, site, account, isolated });
  test("another account of the same site in the default context clashes; the same account, another site, an isolated one or no account do not", () => {
    expect(defaultContextClash("shop", "alice", [o("b", "shop", "bob")])).toBe("b");
    expect(defaultContextClash("shop", "alice", [o("b", "shop", "alice")])).toBeNull();
    expect(defaultContextClash("shop", "alice", [o("b", "mail", "bob")])).toBeNull();
    expect(defaultContextClash("shop", "alice", [o("b", "shop", "bob", true)])).toBeNull();
    expect(defaultContextClash("shop", "alice", [o("b", "shop", null)])).toBeNull();
  });
});

describe("fill --secret needs a bound session (0.6-R)", () => {
  test("bound: no error", () => {
    expect(unboundSecretError("s1", { site: "example" }, "example")).toBeNull();
  });

  test("unbound: not-found; next stops the session, then starts it bound (an account's tabs open in its own context)", () => {
    const e = unboundSecretError("s1", undefined, "example");
    expect(e?.code).toBe("not-found");
    expect(e?.message).toContain('session "s1" is not bound to a site');
    expect(e?.extra).toEqual({ session: "s1", site: "example" });
    expect(e?.next).toContain("`tabcap session stop s1`");
    expect(e?.next).toContain("`tabcap session start s1 --site example`");
    expect((e?.next ?? "").indexOf("session stop")).toBeLessThan((e?.next ?? "").indexOf("session start"));
    expect(e?.next).not.toContain("--trusted");
  });
});
