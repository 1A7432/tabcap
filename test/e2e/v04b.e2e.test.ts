// L2 for 0.4-B B7: `emulate --network-conditions` really throttles, and keeps
// throttling across `wait --idle` (whose idle tracking turns the Network domain
// on and off again on a session that is not recording). The oracle is the
// page's own clock (performance.now around a fetch of a ~300 KB response from
// the local range site) and the byte count it received; the expected lower
// bound comes from the preset numbers in src/ (Puppeteer's presets). Only
// 127.0.0.1 is opened (--proxy none).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PredefinedNetworkConditions } from "../../src/daemon/tools/emulatespec.ts";
import { BIG_BYTES, startThrottleSite, type Site } from "./site.ts";
import { cliFor, rec, type Env } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "thr"];

// The slowest throttling preset (Offline aside): "Slow 3G", download in bytes per second.
const PRESET = "Slow 3G";
const DOWNLOAD = PredefinedNetworkConditions[PRESET].download; // (500 * 1000 / 8) * 0.8 = 50000 B/s
// Lower bound of a throttled transfer: the body alone needs BIG_BYTES / DOWNLOAD seconds
// (300000 / 50000 = 6 s); the preset's latency (2000 ms) and the headers only add to it.
const LOWER_BOUND_MS = (BIG_BYTES / DOWNLOAD) * 1000;

let home = "";
let site: Site;

const cli = cliFor(() => home);
const tabcap = (...args: string[]): Promise<Env> => cli.tabcap(args);
const { ok } = cli;

/** One timed transfer of /big, measured by the page: wall ms and bytes received. */
async function timedFetch(label: string): Promise<{ ms: number; bytes: number }> {
  const expr = "(async () => { const t0 = performance.now(); const r = await fetch('/big?n=' + Math.random(), { cache: 'no-store' }); const b = await r.arrayBuffer(); return { ms: performance.now() - t0, bytes: b.byteLength }; })()";
  const v = rec((await ok("evaluate", expr, "--await", "--timeout", "60000", ...S))["value"]);
  const ms = typeof v["ms"] === "number" ? v["ms"] : NaN;
  const bytes = typeof v["bytes"] === "number" ? v["bytes"] : NaN;
  console.log(`[v04b] ${label}: ${BIG_BYTES} B in ${ms.toFixed(0)} ms (lower bound under ${PRESET}: ${LOWER_BOUND_MS.toFixed(0)} ms)`);
  return { ms, bytes };
}

describe.skipIf(!enabled)("tabcap 0.4-B L2 (emulate network throttling)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4b-"));
    site = startThrottleSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("navigate", `${site.origin}/`, ...S);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test(`emulate --network-conditions "${PRESET}" makes a ${BIG_BYTES} B transfer take at least size / download; it survives wait --idle; a bare emulate clears it`, async () => {
    const plain = await timedFetch("no throttling");
    expect(plain.bytes).toBe(BIG_BYTES);
    // Measurably slower: the unthrottled transfer must be far below the throttled lower bound.
    expect(plain.ms).toBeLessThan(LOWER_BOUND_MS / 4);

    const e = await ok("emulate", "--network-conditions", PRESET, ...S);
    expect(rec(e["emulation"])["networkConditions"]).toBe(PRESET);
    const throttled = await timedFetch(`emulate ${PRESET}`);
    expect(throttled.bytes).toBe(BIG_BYTES);
    expect(throttled.ms).toBeGreaterThanOrEqual(LOWER_BOUND_MS);

    // wait --idle on a session that is not recording enables Network for its tracking and disables it after.
    const idle = await ok("wait", "--idle", "300", ...S);
    expect(idle["tracking"]).toBe("since-wait");
    const after = await timedFetch(`emulate ${PRESET}, then wait --idle`);
    expect(after.bytes).toBe(BIG_BYTES);
    expect(after.ms).toBeGreaterThanOrEqual(LOWER_BOUND_MS);

    const cleared = await ok("emulate", ...S);
    expect(cleared["cleared"]).toContain("networkConditions");
    const again = await timedFetch("bare emulate (cleared)");
    expect(again.bytes).toBe(BIG_BYTES);
    expect(again.ms).toBeLessThan(LOWER_BOUND_MS / 4);
    expect(site.hits.filter((h) => h === "GET /big")).toHaveLength(4);
  }, 120_000);

  test(`the throttle also survives net stop (the recording turns Network off on its tabs)`, async () => {
    await ok("net", "start", ...S);
    await ok("emulate", "--network-conditions", PRESET, ...S);
    await ok("net", "stop", ...S);
    const stopped = await timedFetch(`net start, emulate ${PRESET}, net stop`);
    expect(stopped.bytes).toBe(BIG_BYTES);
    expect(stopped.ms).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    await ok("emulate", ...S);
    const again = await timedFetch("bare emulate (cleared)");
    expect(again.ms).toBeLessThan(LOWER_BOUND_MS / 4);
  }, 120_000);
});
