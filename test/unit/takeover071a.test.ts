// 0.7.1-A human take-over (docs/04 §37): tabcap's own input windows, the
// pure decision, the listener's payload and source, the config switch, the
// guard's waiting state and the daemon answers built on it. Expected values
// come from the design in docs/04 §37 (the window [start, end + 500 ms], the
// four event kinds, the decision table, `waiting` with reason
// `human-takeover`, resume only by `handoff continue`), not from running tabcap.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTable } from "../../src/daemon/browser/refs.ts";
import type { Tab } from "../../src/daemon/browser/targets.ts";
import {
  TAKEOVER_BINDING,
  TAKEOVER_COALESCE_MS,
  TAKEOVER_EVENTS,
  TAKEOVER_SOURCE,
  decideTakeover,
  onHumanInput,
  parseTakeoverPayload,
  type TakeoverDeps,
} from "../../src/daemon/browser/takeover.ts";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { BLOCKED_WHILE_WAITING, Guard, TAKEOVER_NEXT, handoffView, waitingError, type GuardRecorder } from "../../src/daemon/guard.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { STATUS_SCHEMA, nextOf, type StatusFacts, type StatusSession } from "../../src/daemon/tools/status.ts";
import { INPUT_GRACE_MS, INPUT_KEEP_MS, InputWindows, coveredBy } from "../../src/daemon/transport/inputwindows.ts";
import { HANDOFF_DEFAULTS, parseHandoffConfig } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), "tabcap-071a-"));
  roots.push(r);
  return r;
};

/** A recording stand-in: collects the events the guard and the take-over write. */
class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  constructor(readonly session: string) {}
  onIndexed(_fn: (e: NetEntry) => void): () => void {
    return () => undefined;
  }
  event(kind: string, fields: Record<string, unknown>, o: { tab?: string | null; actor?: string; cmd?: null } = {}): number | null {
    this.events.push({ kind, ...fields, _tab: o.tab ?? null, _actor: o.actor ?? "system", _cmd: o.cmd === null ? null : "window" });
    return this.events.length;
  }
  cmdStart(): string | null {
    return null;
  }
  cmdEnd(): void {}
}

function guard(): Guard {
  return new Guard({
    configDir: join(tmp(), "config"),
    secrets: new Secrets(),
    siteOf: (s) => (s === "w" ? { site: "shop", account: "alice" } : null),
    screenshot: () => Promise.resolve("/tmp/never.png"),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
  });
}

function tabOf(session: string, id = "t1"): Tab {
  return {
    id,
    targetId: `T-${id}`,
    sessionId: `S-${id}`,
    session,
    owned: true,
    reason: "ai-opened",
    opener: null,
    url: "http://127.0.0.1:9/s62",
    title: "s62",
    navType: "navigation",
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

describe("tabcap's own input windows (transport/inputwindows.ts)", () => {
  test("an event of the same tab from the window's start to its end + 500 ms is tabcap's own", () => {
    let now = 1000;
    const w = new InputWindows(() => now);
    const id = w.begin("S-t1");
    now = 1010;
    expect(w.covers("S-t1")).toBe(true); // in flight (pointerdown arrives before the answer)
    expect(w.covers("S-t2")).toBe(false); // another tab
    expect(w.covers("S-t1", 999)).toBe(false); // before it went out
    w.end(id);
    now = 1010 + INPUT_GRACE_MS;
    expect(w.covers("S-t1")).toBe(true); // a wheel ~5 ms after the answer (spike-071a)
    now = 1010 + INPUT_GRACE_MS + 1;
    expect(w.covers("S-t1")).toBe(false);
    w.end(id); // unknown / ended twice: ignored
    expect(w.list()).toHaveLength(1);
    now = 1010 + INPUT_KEEP_MS + 1;
    expect(w.list()).toEqual([]);
  });

  test("coveredBy (pure): open windows cover any later time, closed ones their grace", () => {
    const ws = [
      { key: "a", start: 10, end: 20 },
      { key: "b", start: 100, end: null },
    ];
    expect(coveredBy(ws, "a", 10)).toBe(true);
    expect(coveredBy(ws, "a", 20 + INPUT_GRACE_MS)).toBe(true);
    expect(coveredBy(ws, "a", 21 + INPUT_GRACE_MS)).toBe(false);
    expect(coveredBy(ws, "a", 9)).toBe(false);
    expect(coveredBy(ws, "b", 1_000_000)).toBe(true);
    expect(coveredBy(ws, "c", 15)).toBe(false);
    expect(coveredBy(ws, "a", 25, 0)).toBe(false);
  });
});

describe("decideTakeover (pure, docs/04 §37)", () => {
  test("the decision table", () => {
    const d = (o: Partial<{ event: string; trusted: boolean; inWindow: boolean; waiting: boolean }>) => decideTakeover({ event: "pointerdown", trusted: true, inWindow: false, waiting: false, ...o });
    expect(d({})).toEqual({ verdict: "takeover" });
    for (const event of ["keydown", "wheel", "touchstart"]) expect(d({ event })).toEqual({ verdict: "takeover" });
    expect(d({ trusted: false })).toEqual({ verdict: "ignore", why: "untrusted" });
    expect(d({ trusted: false, inWindow: true })).toEqual({ verdict: "ignore", why: "untrusted" });
    for (const event of ["pointermove", "click", "focus", "scroll", "mousedown"]) expect(d({ event })).toEqual({ verdict: "ignore", why: "kind" });
    expect(d({ inWindow: true })).toEqual({ verdict: "ignore", why: "tabcap-input" });
    expect(d({ inWindow: true, waiting: true })).toEqual({ verdict: "ignore", why: "tabcap-input" });
    expect(d({ waiting: true })).toEqual({ verdict: "human-input" });
  });
});

describe("the listener's payload and source", () => {
  test("parseTakeoverPayload: kind, trust and page time; malformed input is null", () => {
    expect(parseTakeoverPayload(JSON.stringify({ k: "pointerdown", t: 1760700000123.4, tr: true }))).toEqual({ event: "pointerdown", trusted: true, at: 1760700000123 });
    expect(parseTakeoverPayload(JSON.stringify({ k: "keydown", t: "x" }))).toEqual({ event: "keydown", trusted: false, at: null });
    for (const bad of [null, 7, "", "{", "[]", JSON.stringify({ t: 1 }), JSON.stringify({ k: "" }), JSON.stringify({ k: "x".repeat(33) }), "x".repeat(300)]) expect(parseTakeoverPayload(bad)).toBeNull();
  });

  test("the source listens to the four kinds only, capture + passive, trusted only, and never reads keys, text, targets or coordinates", () => {
    expect([...TAKEOVER_EVENTS]).toEqual(["pointerdown", "keydown", "wheel", "touchstart"]);
    expect(TAKEOVER_SOURCE).toContain("capture: true, passive: true");
    expect(TAKEOVER_SOURCE).toContain("e.isTrusted !== true");
    for (const no of [".key", ".code", "target", "clientX", "pageX", "screenX", "value", "textContent", "preventDefault", "stopPropagation", "document."]) expect(TAKEOVER_SOURCE).not.toContain(no);
  });

  test("run against a fake window: trusted events of the four kinds are sent once per kind per 250 ms; untrusted ones never", () => {
    const listeners = new Map<string, (e: { type: string; isTrusted: boolean; timeStamp: number; key?: string }) => void>();
    const sent: unknown[] = [];
    const fakeGlobal: Record<string, unknown> = { [TAKEOVER_BINDING]: (p: string) => sent.push(JSON.parse(p)) };
    const run = new Function("globalThis", "addEventListener", "performance", TAKEOVER_SOURCE);
    const add = (k: string, fn: (e: { type: string; isTrusted: boolean; timeStamp: number }) => void, opts: unknown) => {
      expect(opts).toEqual({ capture: true, passive: true });
      listeners.set(k, fn);
    };
    run(fakeGlobal, add, { timeOrigin: 1_000_000 });
    run(fakeGlobal, add, { timeOrigin: 1_000_000 }); // armed once per document
    expect([...listeners.keys()]).toEqual(["pointerdown", "keydown", "wheel", "touchstart"]);
    const fire = (type: string, isTrusted: boolean, timeStamp: number) => listeners.get(type)?.({ type, isTrusted, timeStamp, key: "s3cret" });
    fire("pointerdown", false, 10);
    expect(sent).toEqual([]);
    fire("pointerdown", true, 10.4);
    fire("pointerdown", true, 10 + TAKEOVER_COALESCE_MS - 1);
    fire("keydown", true, 20);
    fire("pointerdown", true, 10 + TAKEOVER_COALESCE_MS + 1);
    expect(sent).toEqual([
      { k: "pointerdown", t: 1_000_010, tr: true },
      { k: "keydown", t: 1_000_020, tr: true },
      { k: "pointerdown", t: 1_000_261, tr: true },
    ]);
    expect(JSON.stringify(sent)).not.toContain("s3cret");
  });
});

describe("config.json handoff.detectTakeover", () => {
  test("on by default; false turns it off; a wrong value is bad-input", () => {
    expect(HANDOFF_DEFAULTS).toEqual({ detectTakeover: true });
    expect(parseHandoffConfig(undefined)).toEqual({ detectTakeover: true });
    expect(parseHandoffConfig(null)).toEqual({ detectTakeover: true });
    expect(parseHandoffConfig({})).toEqual({ detectTakeover: true });
    expect(parseHandoffConfig({ detectTakeover: false })).toEqual({ detectTakeover: false });
    for (const bad of [{ detectTakeover: "no" }, { detectTakeover: 0 }, "off", [1]]) {
      let err: unknown = null;
      try {
        parseHandoffConfig(bad);
      } catch (e) {
        err = e;
      }
      expect(err instanceof TabcapError && err.code === "bad-input").toBe(true);
    }
  });
});

describe("the guard's take-over state", () => {
  test("take-over: waiting, reason human-takeover, no screenshot, a handoff event, acting commands refused; only handoff continue resumes", () => {
    const g = guard();
    const rec = new FakeRec("w");
    const h = g.takeover("w", { tab: "t1", url: "http://127.0.0.1:9/s62", event: "pointerdown", at: 1234 }, rec);
    expect(h).toMatchObject({ state: "waiting", reason: "human-takeover", site: "shop", origin: null, request: null, status: null, screenshot: null, tab: "t1", input: { event: "pointerdown", at: 1234 } });
    expect(g.isWaiting("w")).toBe(true);
    expect(g.isHumanActive("w")).toBe(true);
    expect(rec.events).toEqual([
      expect.objectContaining({ kind: "handoff", state: "waiting", reason: "human-takeover", request: null, url: "http://127.0.0.1:9/s62", screenshot: null, input: { event: "pointerdown", at: 1234 }, timeoutMs: null, _actor: "system", _tab: "t1" }),
    ]);
    for (const a of BLOCKED_WHILE_WAITING) expect(g.blocking("w", a, "http://127.0.0.1:9/x")).toBe(h);
    expect(g.blocking("w", "snapshot", null)).toBeNull();
    // no origin block: another session may still navigate to the same origin
    expect(g.blocking("other", "navigate", "http://127.0.0.1:9/s62")).toBeNull();
    const e = waitingError(h);
    expect(e.code).toBe("waiting");
    expect(e.next).toBe(TAKEOVER_NEXT);
    expect(e.message).toContain("took over tab t1 (pointerdown at http://127.0.0.1:9/s62)");
    expect(handoffView(h)).toMatchObject({ reason: "human-takeover", input: { event: "pointerdown", at: 1234 }, next: TAKEOVER_NEXT });
    expect(g.waitingNotice("w")).toEqual({ state: "waiting", reason: "human-takeover", screenshot: null, next: TAKEOVER_NEXT });
    // a second take-over while waiting does not start a new hand-off
    expect(g.takeover("w", { tab: "t1", url: "x", event: "keydown", at: 2 }, rec)).toBe(h);
    expect(rec.events).toHaveLength(1);
    g.resume("w", "human");
    expect(g.isWaiting("w")).toBe(false);
    expect(g.isHumanActive("w")).toBe(false);
    expect(g.get("w")).toMatchObject({ state: "resumed", resumedBy: "human" });
  });

  test("human input during another wait marks it human-active (docs/04 §16)", () => {
    const g = guard();
    g.markHumanActive("w"); // not waiting: nothing
    expect(g.isHumanActive("w")).toBe(false);
    const h = g.takeover("w", { tab: "t1", url: "u", event: "wheel", at: 1 }, undefined);
    h.humanActive = false; // as a verify-page wait starts
    expect(g.isHumanActive("w")).toBe(false);
    g.markHumanActive("w");
    expect(g.isHumanActive("w")).toBe(true);
  });
});

describe("onHumanInput (daemon wiring with fakes)", () => {
  const deps = (g: Guard, rec: FakeRec): TakeoverDeps => ({ guard: g, recorder: (s) => (s === rec.session ? rec : undefined), navOf: () => "n-3" });

  test("outside a window: take-over, then the input as a human action (cmd null); while waiting: recorded, no new hand-off; tabcap's own: nothing", () => {
    const g = guard();
    const rec = new FakeRec("w");
    const tab = tabOf("w");
    expect(onHumanInput(deps(g, rec), tab, { event: "pointerdown", trusted: true, at: 500 }, 900, true)).toEqual({ verdict: "ignore", why: "tabcap-input" });
    expect(g.isWaiting("w")).toBe(false);
    expect(rec.events).toEqual([]);
    expect(onHumanInput(deps(g, rec), tab, { event: "pointerdown", trusted: true, at: 500 }, 900, false)).toEqual({ verdict: "takeover" });
    expect(g.get("w")).toMatchObject({ reason: "human-takeover", input: { event: "pointerdown", at: 500 } });
    expect(onHumanInput(deps(g, rec), tab, { event: "keydown", trusted: true, at: null }, 950, false)).toEqual({ verdict: "human-input" });
    expect(rec.events.map((e) => [e["kind"], e["state"] ?? e["event"], e["_actor"], e["_cmd"]])).toEqual([
      ["handoff", "waiting", "system", "window"],
      ["action", "pointerdown", "human", null],
      ["action", "keydown", "human", null],
    ]);
    expect(rec.events[1]).toEqual({ kind: "action", op: "input", event: "pointerdown", at: 500, target: null, value: null, phase: "done", error: null, shots: null, nav: "n-3", trusted: true, _tab: "t1", _actor: "human", _cmd: null });
    expect(rec.events[2]?.["at"]).toBe(950); // no page time: the daemon's receipt time
    expect(onHumanInput(deps(g, rec), tab, { event: "click", trusted: true, at: 1 }, 1, false)).toEqual({ verdict: "ignore", why: "kind" });
    expect(onHumanInput(deps(g, rec), tab, { event: "pointerdown", trusted: false, at: 1 }, 1, false)).toEqual({ verdict: "ignore", why: "untrusted" });
    expect(rec.events).toHaveLength(3);
  });

  test("no recording: the session still waits (nothing is written)", () => {
    const g = guard();
    onHumanInput(deps(g, new FakeRec("other")), tabOf("u"), { event: "touchstart", trusted: true, at: 7 }, 8, false);
    expect(g.get("u")).toMatchObject({ state: "waiting", reason: "human-takeover", site: null });
  });
});

describe("daemon answers (no browser)", () => {
  const daemon = () => new Daemon(paths({ TABCAP_HOME: tmp() }));
  const err = (env: Awaited<ReturnType<typeof handleCommand>>): Record<string, unknown> => (env.ok ? {} : env.error);

  test("acting commands answer waiting/human-takeover, status explains it, handoff continue resumes", async () => {
    const d = daemon();
    d.guard.takeover("a", { tab: "t1", url: "http://127.0.0.1:9/s62", event: "pointerdown", at: 42 }, undefined);
    const click = await handleCommand(d, { action: "click", args: { ref: "e1" }, session: "a" }, () => undefined);
    expect(click.ok).toBe(false);
    expect(err(click)).toMatchObject({ code: "waiting", reason: "human-takeover", input: { event: "pointerdown", at: 42 }, screenshot: null, next: TAKEOVER_NEXT });
    const st = await handleCommand(d, { action: "status", args: {}, session: "a" }, () => undefined);
    const data = st.ok && isRecord(st.data) ? st.data : {};
    expect(data["next"]).toBe('session "a": the user took over its tab (human-takeover); do not act on the page; when they say they are done: `tabcap handoff continue --session a`');
    expect(data["handoff"]).toEqual([expect.objectContaining({ session: "a", reason: "human-takeover", url: "http://127.0.0.1:9/s62", screenshot: null })]);
    const hs = await handleCommand(d, { action: "handoff.status", args: {}, session: "a" }, () => undefined);
    expect(hs.ok && isRecord(hs.data) ? hs.data : {}).toMatchObject({ state: "waiting", handoff: { reason: "human-takeover" } });
    const cont = await handleCommand(d, { action: "handoff.continue", args: {}, session: "a" }, () => undefined);
    expect(cont.ok && isRecord(cont.data) ? cont.data : {}).toMatchObject({ state: "resumed", reason: "human-takeover" });
    expect(d.guard.isWaiting("a")).toBe(false);
  });

  test("status next for a take-over (pure): nobody to tell, the user is at the tab", () => {
    const s: StatusSession = {
      session: "a",
      site: null,
      account: null,
      tabSite: null,
      tabs: 1,
      current: "t1",
      url: "http://x/",
      recording: null,
      state: "waiting",
      reason: "human-takeover",
      screenshot: null,
      trace: { state: "off", decode: false, weakRows: null },
      guardStops: [],
      protection: [],
    };
    const f: StatusFacts = { schema: STATUS_SCHEMA, daemon: { running: true, pid: 1, version: "0", listener: "unix", socket: null, startedAt: 0 }, browser: { running: true, pid: 1, mode: "direct", tabs: 1, webdriver: "hidden", extraArgs: [], dropArgs: [], warnings: [], protectionLive: true }, sessions: [s], plugins: { decode: [], challenge: [] }, handoff: [] };
    expect(nextOf(f, [])).toContain("the user took over its tab (human-takeover)");
    expect(nextOf(f, [])).not.toContain("tell the user");
    expect(nextOf({ ...f, sessions: [{ ...s, reason: "verify-page" }] }, [])).toContain("tell the user");
  });

  test("e2e.human-input is refused unless the daemon started with TABCAP_E2E_HUMAN=1", async () => {
    const d = daemon();
    const env = await handleCommand(d, { action: "e2e.human-input", args: {}, session: "a" }, () => undefined);
    expect(err(env)).toMatchObject({ code: "usage", message: "e2e.human-input is a test-only action" });
    d.e2eHuman = true;
    const env2 = await handleCommand(d, { action: "e2e.human-input", args: {}, session: "a" }, () => undefined);
    expect(err(env2)["code"]).toBe("not-running"); // allowed now; there is no browser
  });
});
