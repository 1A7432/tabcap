import { describe, expect, test } from "bun:test";
import { FrontGuard, restoreFront, type FrontOps } from "../../src/daemon/transport/direct/front.ts";
import { activateScript, parseFrontApp, type FrontApp } from "../../src/daemon/transport/direct/launcher.ts";

const app = (name: string, bundleId: string | null = null): FrontApp => ({ name, bundleId, pid: 1 });
const CHROME = app("Google Chrome for Testing", "com.google.chrome.for.testing");

/** Virtual clock + a scripted frontmost app: `timeline` says when Chrome steals the front. */
function fake(o: { start: FrontApp; stealAt?: number[]; activateWorks?: boolean }) {
  let t = 0;
  let front = o.start;
  const steals = [...(o.stealAt ?? [])];
  const activations: FrontApp[] = [];
  const tick = () => {
    while (steals.length > 0 && (steals[0] ?? Infinity) <= t) {
      steals.shift();
      front = CHROME;
    }
  };
  const ops: FrontOps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      tick();
    },
    read: async () => {
      t += 20;
      tick();
      return front;
    },
    activate: async (app) => {
      activations.push(app);
      t += 20;
      if (o.activateWorks !== false) front = app;
      return o.activateWorks !== false;
    },
  };
  return { ops, activations, front: () => front, set: (a: FrontApp) => (front = a) };
}

const GHOSTTY = app("ghostty");
const TERMINAL = app("Terminal", "com.apple.Terminal");
const OPTS = { watchMs: 2500, settleMs: 1200, pollMs: 100, maxAttempts: 4 };

describe("restoreFront (docs/05 s17)", () => {
  test("Chrome takes the front 800 ms later: handed back once", async () => {
    const f = fake({ start: GHOSTTY, stealAt: [800] });
    const r = await restoreFront(GHOSTTY, f.ops, OPTS);
    expect(r).toMatchObject({ before: "ghostty", beforeBundleId: null, stolen: true, restored: true, attempts: 1, after: "ghostty" });
    expect(f.activations).toEqual([GHOSTTY]);
  });

  test("Chrome re-activates itself after the hand-back: retried", async () => {
    const f = fake({ start: GHOSTTY, stealAt: [100, 700] });
    const r = await restoreFront(GHOSTTY, f.ops, OPTS);
    expect(r).toMatchObject({ stolen: true, restored: true, attempts: 2 });
  });

  test("never stolen: nothing activated", async () => {
    const f = fake({ start: GHOSTTY });
    const r = await restoreFront(GHOSTTY, f.ops, OPTS);
    expect(r).toMatchObject({ stolen: false, restored: null, attempts: 0 });
    expect(f.activations).toEqual([]);
  });

  test("activation keeps failing: bounded attempts, reported as not restored", async () => {
    const f = fake({ start: GHOSTTY, stealAt: [0], activateWorks: false });
    const r = await restoreFront(GHOSTTY, f.ops, OPTS);
    expect(r).toMatchObject({ stolen: true, restored: false, attempts: 4 });
  });
});

describe("FrontGuard", () => {
  test("hands back to the app read when the window appears", async () => {
    const f = fake({ start: TERMINAL, stealAt: [300] });
    const g = new FrontGuard(GHOSTTY, f.ops, true, OPTS);
    await g.onNewWindow();
    expect(f.activations).toEqual([TERMINAL]);
    expect(g.stats).toMatchObject({ windows: 1, stolen: 1, restored: 1, failed: 0, skipped: 0 });
  });

  test("Chrome already in front at the window: falls back to the last noted app", async () => {
    const f = fake({ start: GHOSTTY });
    const g = new FrontGuard(null, f.ops, true, OPTS);
    await g.note();
    expect(g.lastSeen).toEqual(GHOSTTY);
    f.set(CHROME);
    await g.onNewWindow();
    expect(f.activations).toEqual([GHOSTTY]);
    expect(g.stats.restored).toBe(1);
  });

  test("the human was working in the tabcap browser: nothing is restored", async () => {
    const f = fake({ start: CHROME });
    const g = new FrontGuard(GHOSTTY, f.ops, true, OPTS);
    await g.note();
    expect(g.lastSeen).toEqual(CHROME);
    await g.onNewWindow();
    expect(f.activations).toEqual([]);
    expect(g.stats.skipped).toBe(1);
  });

  test("disabled (not macOS / restore off): counts windows only", async () => {
    const f = fake({ start: GHOSTTY, stealAt: [0] });
    const g = new FrontGuard(GHOSTTY, f.ops, false, OPTS);
    await g.onNewWindow();
    expect(f.activations).toEqual([]);
    expect(g.stats.windows).toBe(1);
  });

  test("a second window during a hand-back is coalesced into another pass", async () => {
    const f = fake({ start: GHOSTTY, stealAt: [200, 2000] });
    const g = new FrontGuard(GHOSTTY, f.ops, true, OPTS);
    const a = g.onNewWindow();
    const b = g.onNewWindow();
    await Promise.all([a, b]);
    expect(g.stats.windows).toBe(2);
    expect(f.front()).toEqual(GHOSTTY);
  });
});

describe("hand-back command (process name can differ from the app name)", () => {
  const FIREFOX_DEV = app("firefox", "org.mozilla.firefoxdeveloperedition");

  test("an app with a bundle id is activated by id, one without falls back to its name", async () => {
    const withId = fake({ start: FIREFOX_DEV, stealAt: [300] });
    await new FrontGuard(null, withId.ops, true, OPTS).onNewWindow();
    expect(withId.activations.map(activateScript)).toEqual(['tell application id "org.mozilla.firefoxdeveloperedition" to activate']);

    const noId = fake({ start: GHOSTTY, stealAt: [300] });
    await new FrontGuard(null, noId.ops, true, OPTS).onNewWindow();
    expect(noId.activations.map(activateScript)).toEqual(['tell application "ghostty" to activate']);
  });

  test("never a Chrome app, never an unsafe string", () => {
    expect(activateScript(CHROME)).toBeNull();
    expect(activateScript(app('bad"name'))).toBeNull();
    expect(activateScript(app("x", 'a"b'))).toBeNull();
  });

  test("osascript output parsing", () => {
    expect(parseFrontApp("firefox, org.mozilla.firefoxdeveloperedition, 4242\n")).toEqual({ name: "firefox", bundleId: "org.mozilla.firefoxdeveloperedition", pid: 4242 });
    expect(parseFrontApp("ghostty, missing value, 77")).toEqual({ name: "ghostty", bundleId: null, pid: 77 });
    expect(parseFrontApp("Name, With Comma, com.x.y, 5")).toEqual({ name: "Name, With Comma", bundleId: "com.x.y", pid: 5 });
    expect(parseFrontApp("")).toBeNull();
    expect(parseFrontApp("garbage")).toBeNull();
  });
});
