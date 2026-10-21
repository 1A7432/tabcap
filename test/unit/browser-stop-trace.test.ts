// `browser stop` ends trace mode too (review 10-21): before, only the browser
// going away by itself (Daemon.browserGone) stopped the tracers, so after a
// `browser stop` with trace on `d.tracers` kept a tracer bound to the closed
// browser (`trace status` said on, `tabcap status` listed the session). Like
// `session stop`, the trace stops before the recordings finish, so what it saw
// still reaches them. The browser is the fake in _fakechrome.ts (it answers
// the Debugger / Runtime calls of Tracer.start with {}).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.browser?.t.shutdown().catch(() => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

describe.skipIf(!FAKE_CHROME)("browser stop with trace mode on (fake browser; POSIX)", () => {
  test(
    "no tracer is left; trace status says off; a new browser can trace again",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tabcap-bstop-trace-"));
      roots.push(dir);
      const p = paths({ TABCAP_HOME: dir });
      mkdirSync(p.config, { recursive: true, mode: 0o700 });
      const d = new Daemon(p);
      daemons.push(d);
      const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);
      const exe = fakeChrome(dir, {});
      expect((await run("browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      const on = await run("trace.start", { decode: false });
      if (!on.ok) throw new Error(JSON.stringify(on));
      expect(d.tracers.has("a")).toBe(true);
      const stop = await run("browser.stop");
      expect(stop.ok).toBe(true);
      expect(d.tracers.size).toBe(0);
      const st = await run("trace.status");
      expect(st.ok && isRecord(st.data) ? st.data["trace"] : null).toBe("off");
      expect((await run("browser.start", { executablePath: exe, proxy: "none" })).ok).toBe(true);
      expect((await run("trace.start", { decode: false })).ok).toBe(true);
      expect(d.tracers.has("a")).toBe(true);
    },
    SLOW_IO_MS,
  );
});
