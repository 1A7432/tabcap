// A stand-in for Chrome for Testing in L0 tests: a small Bun script behind a
// POSIX `#!/bin/sh` wrapper, launched by tabcap's own launcher like the real
// browser. It speaks just enough CDP over --remote-debugging-pipe (fd 3 in,
// fd 4 out, NUL-separated JSON; docs/07 §1.1) for DirectTransport.start, the
// auto-attach of new tabs and the probe / poll calls a test scripts, and it
// writes to its stderr, which the launcher points at browser.log. So
// `d.browser` is a real Running (DirectTransport has no public constructor)
// without a real Chrome. POSIX only: Windows cannot spawn a shell script.
//
// A control method a test sends through the transport (not CDP):
//   FakeChrome.crash {stderr?}   write stderr, exit 133 (as after SIGTRAP) without answering

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_CHROME = process.platform !== "win32";

export type FakeChromeConfig = {
  /** Written to stderr (tabcap's browser.log) as soon as the process starts. */
  stderrAtStart?: string;
  /** Exit with this code right after stderrAtStart, before answering any CDP. */
  exitAtStart?: number;
  /** Network.getCookies answers `{cookies}` (every session). */
  cookies?: Array<{ name: string; value: string }>;
  /** The root document Page.getFrameTree reports for page sessions. */
  url?: string;
  /** Runtime.evaluate: the first entry whose `when` occurs in the expression answers `{result: {type: "object", value}}`; otherwise undefined. */
  evaluate?: Array<{ when: string; value: unknown }>;
};

const SCRIPT = String.raw`
import { readFileSync, writeFileSync, writeSync, createReadStream } from "node:fs";
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
writeFileSync(process.argv[2] + ".pid", String(process.pid));
if (typeof cfg.stderrAtStart === "string") writeSync(2, cfg.stderrAtStart);
if (typeof cfg.exitAtStart === "number") process.exit(cfg.exitAtStart);
const out = (m) => writeSync(4, JSON.stringify(m) + "\0");
const event = (method, params, sessionId) => out(sessionId === undefined ? { method, params } : { method, params, sessionId });
const targets = new Map(); // sessionId -> targetId
let n = 0;
let ctx = 0;
function answer(method, params, sessionId) {
  switch (method) {
    case "Browser.getVersion":
      return { product: "FakeChrome/1.0", userAgent: "FakeChrome" };
    case "Target.createTarget": {
      const targetId = "T" + ++n;
      const sid = "S" + n;
      targets.set(sid, targetId);
      event("Target.attachedToTarget", { sessionId: sid, targetInfo: { targetId, type: "page", url: "about:blank", title: "", attached: true }, waitingForDebugger: true });
      return { targetId };
    }
    case "Target.closeTarget": {
      for (const [sid, id] of targets) {
        if (id !== params.targetId) continue;
        targets.delete(sid);
        event("Target.detachedFromTarget", { sessionId: sid, targetId: id });
        event("Target.targetDestroyed", { targetId: id });
      }
      return { success: true };
    }
    case "Page.getFrameTree": {
      const id = targets.get(sessionId) ?? "F0";
      return { frameTree: { frame: { id, loaderId: "L-" + id, url: cfg.url ?? "about:blank" }, childFrames: [] } };
    }
    case "Page.createIsolatedWorld":
      return { executionContextId: ++ctx };
    case "Network.getCookies":
      return { cookies: cfg.cookies ?? [] };
    case "Runtime.evaluate": {
      const hit = (cfg.evaluate ?? []).find((e) => String(params.expression).includes(e.when));
      return { result: hit === undefined ? { type: "undefined" } : { type: "object", value: hit.value } };
    }
    default:
      return {};
  }
}
let buf = Buffer.alloc(0);
const input = createReadStream("", { fd: 3 });
input.on("end", () => process.exit(0)); // tabcap went away: never linger
input.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
    const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
    buf = buf.subarray(i + 1);
    const { id, method, params = {}, sessionId } = msg;
    if (method === "FakeChrome.crash") {
      if (typeof params.stderr === "string") writeSync(2, params.stderr);
      process.exit(133);
    }
    out(sessionId === undefined ? { id, result: answer(method, params, sessionId) } : { id, result: answer(method, params, sessionId), sessionId });
    if (method === "Browser.close") process.exit(0);
  }
});
`;

/** The pid of the fake browser last started from `dir` (its own record), or null. */
export function fakeChromePid(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, "fake-chrome.json.pid"), "utf8"));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** True while a process with this pid exists (signal 0 checks without sending anything). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Write the fake browser into `dir`; returns the executable to launch. */
export function fakeChrome(dir: string, cfg: FakeChromeConfig = {}): string {
  const script = join(dir, "fake-chrome.mjs");
  const config = join(dir, "fake-chrome.json");
  const exe = join(dir, "fake-chrome");
  writeFileSync(script, SCRIPT);
  writeFileSync(config, JSON.stringify(cfg));
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  writeFileSync(exe, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} ${q(config)} "$@"\n`);
  chmodSync(exe, 0o755);
  return exe;
}
