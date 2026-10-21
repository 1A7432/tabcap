// `fingerprint probe` when the probe page does not report in time (review
// 10-21; CI of PR #31, windows e2e v04g: one probe of four timed out after
// 28000 ms with an empty browser.log, so there was nothing to look at). Before
// the timeout error, the probe tab is read once, read-only: document.readyState,
// location.href and the page's own progress marks (src/fingerprint/probe.html:
// `#status` says "reading…" until the POST is answered, `#rows` fills once the
// fields are collected, body[data-done] is set at the end). The result goes
// into the error message and the daemon log (`fingerprint probe: page did not
// report {…}`). The page answers come from the fake browser in _fakechrome.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { probeStage } from "../../src/daemon/tools/fingerprint.ts";
import { setLogScrubber } from "../../src/shared/log.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

describe("probeStage: the page's progress marks", () => {
  test("loading, collecting, posting, answered, post failed, done; anything malformed is unknown", () => {
    const st = (v: Record<string, unknown>) => probeStage({ readyState: "complete", href: "http://127.0.0.1:1/", status: "reading…", rows: 0, done: null, ...v });
    expect(st({ readyState: "loading" })).toEqual({ readyState: "loading", url: "http://127.0.0.1:1/", stage: "loading", status: "reading…", rows: 0 });
    expect(st({}).stage).toBe("collecting");
    expect(st({ rows: 31 }).stage).toBe("posting");
    expect(st({ rows: 31, status: "read 31 fields" }).stage).toBe("answered");
    expect(st({ rows: 31, status: "read 31 fields; tabcap did not answer: Failed to fetch" }).stage).toBe("post-failed");
    expect(st({ rows: 31, status: "read 31 fields", done: "1" }).stage).toBe("done");
    expect(probeStage("x")).toEqual({ readyState: null, url: null, stage: "unknown", status: null, rows: null });
    expect(probeStage({ readyState: 5, href: [], status: "s".repeat(500), rows: "3" })).toEqual({ readyState: null, url: null, stage: "unknown", status: "s".repeat(200), rows: null });
  });
});

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  setLogScrubber(null);
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

describe.skipIf(!FAKE_CHROME)("the timeout (fake browser; POSIX)", () => {
  test(
    "the error names the page's state; the daemon log has the same line",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tabcap-fptimeout-"));
      roots.push(dir);
      const p = paths({ TABCAP_HOME: dir });
      mkdirSync(p.config, { recursive: true, mode: 0o700 });
      const d = new Daemon(p);
      daemons.push(d);
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      // the page collected its fields (rows) but its POST /probe was never answered
      const exe = fakeChrome(dir, { evaluate: [{ when: "document.readyState", value: { readyState: "complete", href: "http://127.0.0.1:1/", status: "reading…", rows: 31, done: null } }] });
      expect((await run("browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      const lines: string[] = [];
      setLogScrubber((line) => {
        lines.push(line);
        return line;
      });
      const env = await run("fingerprint.probe", { timeoutMs: 1000 });
      expect(env.ok).toBe(false);
      const e: Record<string, unknown> = env.ok ? {} : env.error;
      expect(e["code"]).toBe("timeout");
      expect(String(e["message"])).toBe("the probe page did not report within 5000 ms (readyState complete, stage posting: fields collected, POST /probe not answered; url http://127.0.0.1:1/)");
      expect(e["page"]).toEqual({ readyState: "complete", url: "http://127.0.0.1:1/", stage: "posting", status: "reading…", rows: 31 });
      expect(lines.some((l) => l.includes("fingerprint probe: page did not report") && l.includes('"stage":"posting"'))).toBe(true);
    },
    SLOW_IO_MS,
  );
});
