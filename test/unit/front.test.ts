import { describe, expect, test } from "bun:test";
import { FrontGuard, restoreFront, type FrontOps } from "../../src/daemon/transport/direct/front.ts";

const CHROME = "Google Chrome for Testing";

/** Virtual clock + a scripted frontmost app: `timeline` says when Chrome steals the front. */
function fake(o: { start: string; stealAt?: number[]; activateWorks?: boolean }) {
  let t = 0;
  let front = o.start;
  const steals = [...(o.stealAt ?? [])];
  const activations: string[] = [];
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
  return { ops, activations, front: () => front, set: (a: string) => (front = a) };
}

const OPTS = { watchMs: 2500, settleMs: 1200, pollMs: 100, maxAttempts: 4 };

describe("restoreFront (docs/05 s17)", () => {
  test("Chrome takes the front 800 ms later: handed back once", async () => {
    const f = fake({ start: "ghostty", stealAt: [800] });
    const r = await restoreFront("ghostty", f.ops, OPTS);
    expect(r).toMatchObject({ before: "ghostty", stolen: true, restored: true, attempts: 1, after: "ghostty" });
    expect(f.activations).toEqual(["ghostty"]);
  });

  test("Chrome re-activates itself after the hand-back: retried", async () => {
    const f = fake({ start: "ghostty", stealAt: [100, 700] });
    const r = await restoreFront("ghostty", f.ops, OPTS);
    expect(r).toMatchObject({ stolen: true, restored: true, attempts: 2 });
  });

  test("never stolen: nothing activated", async () => {
    const f = fake({ start: "ghostty" });
    const r = await restoreFront("ghostty", f.ops, OPTS);
    expect(r).toMatchObject({ stolen: false, restored: null, attempts: 0 });
    expect(f.activations).toEqual([]);
  });

  test("activation keeps failing: bounded attempts, reported as not restored", async () => {
    const f = fake({ start: "ghostty", stealAt: [0], activateWorks: false });
    const r = await restoreFront("ghostty", f.ops, OPTS);
    expect(r).toMatchObject({ stolen: true, restored: false, attempts: 4 });
  });
});

describe("FrontGuard", () => {
  test("hands back to the app read when the window appears", async () => {
    const f = fake({ start: "Terminal", stealAt: [300] });
    const g = new FrontGuard("ghostty", f.ops, true, OPTS);
    await g.onNewWindow();
    expect(f.activations).toEqual(["Terminal"]);
    expect(g.stats).toMatchObject({ windows: 1, stolen: 1, restored: 1, failed: 0, skipped: 0 });
  });

  test("Chrome already in front at the window: falls back to the last noted app", async () => {
    const f = fake({ start: "ghostty" });
    const g = new FrontGuard(null, f.ops, true, OPTS);
    await g.note();
    expect(g.lastSeen).toBe("ghostty");
    f.set(CHROME);
    await g.onNewWindow();
    expect(f.activations).toEqual(["ghostty"]);
    expect(g.stats.restored).toBe(1);
  });

  test("the human was working in the tabcap browser: nothing is restored", async () => {
    const f = fake({ start: CHROME });
    const g = new FrontGuard("ghostty", f.ops, true, OPTS);
    await g.note();
    expect(g.lastSeen).toBe(CHROME);
    await g.onNewWindow();
    expect(f.activations).toEqual([]);
    expect(g.stats.skipped).toBe(1);
  });

  test("disabled (not macOS / restore off): counts windows only", async () => {
    const f = fake({ start: "ghostty", stealAt: [0] });
    const g = new FrontGuard("ghostty", f.ops, false, OPTS);
    await g.onNewWindow();
    expect(f.activations).toEqual([]);
    expect(g.stats.windows).toBe(1);
  });

  test("a second window during a hand-back is coalesced into another pass", async () => {
    const f = fake({ start: "ghostty", stealAt: [200, 2000] });
    const g = new FrontGuard("ghostty", f.ops, true, OPTS);
    const a = g.onNewWindow();
    const b = g.onNewWindow();
    await Promise.all([a, b]);
    expect(g.stats.windows).toBe(2);
    expect(f.front()).toBe("ghostty");
  });
});
