// CI e2e warm-up (ci.yml, before each shard's tests):
//   bun scripts/e2e-warmup.ts
// One throwaway TABCAP_HOME: daemon start, browser start (--proxy none, the
// TABCAP_CHROME binary), navigate a data: page, screenshot, browser stop, daemon
// stop. Nothing outside the runner is contacted. A cold runner's first Chrome
// pays for reading Chrome from disk, the font cache and the GPU / SwiftShader
// path: in main run 39608432213 (ubuntu e2e 3/3) the shard's first file lost a
// click --trusted to a paint stall 7 s after its browser started. The CLI runs
// from source with TABCAP_HOME, the way the e2e tests drive it, so no product
// default changes. Each step's time goes to the job log; exit 1 when a step
// failed (ci.yml runs the shard anyway, its tests decide).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/shared/json.ts";

const MAIN = join(import.meta.dir, "..", "src", "cli", "main.ts");

/** A page that draws: text, a button and a running animation (the compositor has frames to make). */
export const WARMUP_PAGE =
  "data:text/html," +
  encodeURIComponent(
    '<!doctype html><title>tabcap warm-up</title><p>warm-up</p><button>warm-up</button><div style="width:40px;height:40px;background:#888;animation:s 1s linear infinite"></div><style>@keyframes s{to{transform:rotate(360deg)}}</style>',
  );

/** Pure: the CLI calls of the warm-up, in order (daemon stop runs afterwards in any case). */
export function warmupSteps(chrome: string): string[][] {
  const session = ["--session", "warmup"];
  return [
    ["daemon", "start"],
    ["browser", "start", "--proxy", "none", "--executable-path", chrome],
    ["navigate", WARMUP_PAGE, ...session],
    ["screenshot", ...session],
    ["browser", "stop"],
  ];
}

async function tabcap(home: string, args: string[]): Promise<{ ok: boolean; ms: number; detail: string }> {
  const started = performance.now();
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const ms = Math.round(performance.now() - started);
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    // not an envelope: reported below with the raw output
  }
  const ok = isRecord(env) && env["ok"] === true;
  const detail = ok ? "" : `${out.trim().slice(0, 400)} ${err.trim().split("\n").slice(-5).join(" | ")}`.trim();
  return { ok, ms, detail };
}

const label = (args: string[]): string => args.map((a) => (a.startsWith("data:") ? "data:<warm-up page>" : a)).join(" ");

if (import.meta.main) {
  const chrome = process.env["TABCAP_CHROME"] ?? "";
  if (chrome === "") {
    console.log("::warning::warm-up skipped: TABCAP_CHROME is empty");
    process.exit(1);
  }
  const home = mkdtempSync(join(tmpdir(), "tabcap-warmup-"));
  let failed = 0;
  try {
    for (const args of warmupSteps(chrome)) {
      const r = await tabcap(home, args);
      console.log(`warm-up: tabcap ${label(args)}: ${r.ok ? "ok" : "FAILED"} in ${r.ms} ms${r.ok ? "" : `: ${r.detail}`}`);
      if (!r.ok) {
        failed++;
        break;
      }
    }
  } finally {
    const r = await tabcap(home, ["daemon", "stop"]);
    console.log(`warm-up: tabcap daemon stop: ${r.ok ? "ok" : "failed"} in ${r.ms} ms`);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (e) {
      // a Chrome that is still exiting can hold files on Windows; the runner's temp dir is thrown away
      console.log(`warm-up: ${home} not removed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed > 0) {
    console.log("::warning::the e2e warm-up failed; the shard runs anyway");
    process.exit(1);
  }
}
