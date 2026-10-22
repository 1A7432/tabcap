// 0.8.2 (docs/04 §18): the daemon's shutdown gives the browser stop a budget; past it the
// browser is killed so it does not outlive the daemon (`daemon stop` kills the daemon at 15 s;
// Windows CI, PR #29: an orphaned Chrome held the test home, EBUSY).

import { describe, expect, test } from "bun:test";
import { SHUTDOWN_BROWSER_MS, STOP_SETTLE_MS, stopWithin } from "../../src/daemon/tools/browser.ts";

describe("stopWithin", () => {
  test("a stop that finishes in time: no kill", async () => {
    let killed = false;
    expect(await stopWithin(() => Bun.sleep(10), 500, async () => void (killed = true))).toBe(true);
    expect(killed).toBe(false);
  });

  test("a stop that hangs: killed at the budget, without waiting for the stop", async () => {
    let killed = false;
    const t0 = Date.now();
    expect(await stopWithin(() => new Promise(() => undefined), 80, async () => void (killed = true), 50)).toBe(false);
    expect(killed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("killed: the stop gets a moment to settle after the kill; a late failure is caught, not an unhandled rejection", async () => {
    const order: string[] = [];
    let fail: (e: Error) => void = () => undefined;
    const stop = () => new Promise<void>((_, reject) => (fail = reject)).finally(() => order.push("stop settled"));
    const kill = async () => {
      order.push("killed");
      setTimeout(() => fail(new Error("CDP closed")), 20); // the transport died under the stop
    };
    expect(await stopWithin(stop, 50, kill, 1000)).toBe(false);
    expect(order).toEqual(["killed", "stop settled"]);
  });

  test("killed: a stop that never settles holds the caller for the settle time only", async () => {
    const t0 = Date.now();
    expect(await stopWithin(() => new Promise(() => undefined), 30, async () => undefined, 60)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a stop that fails in time: the error goes to the caller, no kill", async () => {
    let killed = false;
    expect(await stopWithin(() => Promise.reject(new Error("boom")), 500, async () => void (killed = true)).catch((e: unknown) => String(e))).toBe("Error: boom");
    expect(killed).toBe(false);
  });

  test("the budget, the kill (<= 2 s) and the settle leave room under the 15 s `daemon stop` waits", () => {
    expect(SHUTDOWN_BROWSER_MS + 2000 + STOP_SETTLE_MS).toBeLessThanOrEqual(13_000);
  });
});
