// `replay check --live` guardrails (review wave 2, docs/04 §31 「`replay
// check --live`」): it sends from the CLI, outside the daemon, so it reads the
// same pacing floor as `tabcap fetch` (config.json `fetch.minIntervalMs`, the
// site's `sites.<s>.fetch` over it; docs/04 §26 "命令行不能绕过限速"), refuses
// while the daemon holds a fetch stop on the site, and says so when no daemon
// runs. The oracle is docs/04 §26 / §31 as written; the clock and the network
// are fakes, nothing is sent anywhere.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, type CheckOptions, type LiveGuardState } from "../../src/replay/check.ts";
import { daemonGuardState } from "../../src/cli/replay.ts";
import { Store } from "../../src/daemon/store/db.ts";
import type { HttpClient } from "../../src/daemon/pool/proxy.ts";
import { TabcapError, fail, ok } from "../../src/shared/envelope.ts";
import { paths } from "../../src/shared/paths.ts";
import { tmp } from "./_analyze.ts";
import { buildReplayBundle, FEED } from "./_replay.ts";
import { SLOW_IO_MS } from "./_platform.ts";

let root = "";
let bundle = "";

beforeAll(async () => {
  root = tmp("tabcap-live-guard-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

let n = 0;
/** A config dir with site "ex" (example.invalid) and an optional config.json. */
function configDir(config: unknown = null): string {
  const dir = join(root, `cfg-${++n}`);
  const s = Store.open(dir);
  s.addSite({ name: "ex", entryUrl: "https://example.invalid/", domains: [], username: "u", password: "Site-pass-7kq" });
  s.close();
  if (config !== null) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

/** Fake clock and network: each request takes 500 ms; starts are recorded. */
function rig() {
  const clock = { t: 1_000_000 };
  const starts: number[] = [];
  const fetch: HttpClient = async () => {
    starts.push(clock.t);
    clock.t += 500;
    return new Response(FEED[0] ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { clock, starts, fetch, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
}

const NO_DAEMON = async (): Promise<LiveGuardState> => ({ running: false });
const DAEMON_OK = async (): Promise<LiveGuardState> => ({ running: true, stops: [] });

function opts(cfg: string, r: ReturnType<typeof rig>, extra: Partial<CheckOptions> = {}): CheckOptions {
  return { bundle, against: "https://example.invalid", live: true, site: "ex", filter: "/api/feed", withCookies: false, headers: [], configDir: cfg, fetch: r.fetch, now: r.now, sleep: r.sleep, guardState: DAEMON_OK, ...extra };
}

const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - (xs[i] ?? 0));

describe("pacing floor: fetch.minIntervalMs (docs/04 §26: the command line cannot get around it)", () => {
  test("--rate faster than the floor is paced at the floor, after the previous answer ended, with a warning", async () => {
    const r = rig();
    const res = await check(opts(configDir(), r, { rate: 10 }));
    expect(r.starts.length).toBe(3);
    expect(gaps(r.starts)).toEqual([3500, 3500]); // 500 ms answer + 3000 ms floor
    expect(res.warnings).toContain("--rate 10 is faster than fetch.minIntervalMs of site ex (3000 ms): paced at one request per 3000 ms instead");
    expect(res.warnings.some((w) => w.startsWith("live target: requests paced at one per 3000 ms"))).toBe(true);
  });

  test("the site's fetch.minIntervalMs overrides the global one; without --rate the slower of 2000 ms and the floor, no rate warning", async () => {
    const r = rig();
    const res = await check(opts(configDir({ fetch: { minIntervalMs: 1000 }, sites: { ex: { fetch: { minIntervalMs: 5000 } } } }), r));
    expect(gaps(r.starts)).toEqual([5500, 5500]);
    expect(res.warnings.some((w) => w.startsWith("--rate"))).toBe(false);
    const r2 = rig();
    await check(opts(configDir({ fetch: { minIntervalMs: 0 } }), r2));
    expect(gaps(r2.starts)).toEqual([2500, 2500]); // the default live pace, 2000 ms
    const r3 = rig();
    const res3 = await check(opts(configDir({ fetch: { minIntervalMs: 0 } }), r3, { rate: 10 }));
    expect(gaps(r3.starts)).toEqual([600, 600]);
    expect(res3.warnings.some((w) => w.startsWith("--rate"))).toBe(false);
  });

  test("a bad fetch config refuses the check before anything is sent", async () => {
    const r = rig();
    await expect(check(opts(configDir({ fetch: { minIntervalMs: "fast" } }), r))).rejects.toMatchObject({ code: "bad-input" });
    expect(r.starts).toEqual([]);
  });
});

describe("the daemon's fetch stops", () => {
  test("a stop on the site refuses the check with guard.stopped and the guard resume next; nothing is sent", async () => {
    const r = rig();
    const stopped = async (): Promise<LiveGuardState> => ({ running: true, stops: [{ site: "ex", rule: "json:$.code!=0", request: "r-7", session: "scrape", reason: "fetch-stop" }] });
    let err: unknown = null;
    try {
      await check(opts(configDir(), r, { guardState: stopped }));
    } catch (e) {
      err = e;
    }
    // (plain strings: toMatchObject with an asymmetric matcher rewrites the received property in Bun 1.4.3)
    const next = err instanceof TabcapError ? err.next : "";
    expect(err).toMatchObject({ code: "guard.stopped", extra: { site: "ex", rule: "json:$.code!=0", request: "r-7" } });
    expect(err instanceof Error ? err.message : "").toContain("fetches on ex are stopped");
    expect(next).toContain("tabcap guard resume --site ex");
    expect(next).toContain("tabcap net body r-7 --session scrape");
    expect(r.starts).toEqual([]);
  });

  test("a stop on another site does not; no daemon: a warning that the guard's stop rules do not apply", async () => {
    const r = rig();
    const other = async (): Promise<LiveGuardState> => ({ running: true, stops: [{ site: "elsewhere", rule: "status>=500", request: "r-1", session: "default", reason: "fetch-stop" }] });
    const res = await check(opts(configDir(), r, { guardState: other }));
    expect(r.starts.length).toBe(3);
    expect(res.warnings.some((w) => /daemon/.test(w))).toBe(false);
    const r2 = rig();
    const res2 = await check(opts(configDir(), r2, { guardState: NO_DAEMON }));
    expect(r2.starts.length).toBe(3);
    expect(res2.warnings).toContain("the daemon is not running: this live check is not under its guard, so fetch stops and stop rules are not checked");
  });
});

describe("daemonGuardState (CLI side: the status answer's guardStops)", () => {
  const p = paths({ TABCAP_HOME: join("/nonexistent", "tabcap-home") });

  test("every session's guardStops; not running; another failure is passed on", async () => {
    const status = ok({
      sessions: [
        { session: "a", guardStops: [{ site: "ex", rule: "status>=500", since: 1, reason: "fetch-stop", by: "a", request: "r-3" }] },
        { session: "b", guardStops: [{ site: "ex", rule: "status>=500", since: 1, reason: "fetch-stop", by: "a", request: "r-3" }, { site: 5, rule: null }] },
        { session: "c" },
      ],
    });
    const seen: string[] = [];
    expect(await daemonGuardState(p, async (_p, action) => (seen.push(action), status))).toEqual({ running: true, stops: [{ site: "ex", rule: "status>=500", request: "r-3", session: "a", reason: "fetch-stop" }] });
    expect(seen).toEqual(["status"]);
    expect(await daemonGuardState(p, async () => fail("not-running", "the tabcap daemon is not running", "x"))).toEqual({ running: false });
    await expect(daemonGuardState(p, async () => fail("daemon-version", "the daemon runs tabcap 0.1.0", "restart"))).rejects.toMatchObject({ code: "daemon-version" });
  });
});
