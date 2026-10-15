// CI platform probe (docs/08 Windows 待验项): drives the CLI once with the
// default directories and prints what this OS actually did, for the job log:
// where the files went, how the daemon listens, which CDP channel the browser
// came up on, whether a visible browser window exists after start and after
// opening a tab, and the tail of the daemon / browser logs. It never prints the
// daemon token (daemon.json values are shown with the token masked).
// Needs a browser from `tabcap setup` first. Only 127.0.0.1 is contacted
// (--proxy none and a local page). Exit code 1 when a step failed.
//
//   bun scripts/ci-probe.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/shared/json.ts";
import { paths } from "../src/shared/paths.ts";

const MAIN = join(import.meta.dir, "..", "src", "cli", "main.ts");
let failed = 0;

function show(title: string, value: unknown): void {
  console.log(`\n=== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

async function tabcap(...args: string[]): Promise<Record<string, unknown>> {
  const p = Bun.spawn(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TABCAP_LOG: "info" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    env = { ok: false, raw: out };
  }
  const rec = isRecord(env) ? env : { ok: false, raw: out };
  if (rec["ok"] !== true) failed++;
  show(`tabcap ${args.join(" ")}`, { envelope: rec, stderr: err.trim().split("\n").slice(-15).join("\n") });
  return rec;
}

function visibleWindows(): unknown {
  if (process.platform === "win32") {
    const ps = [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; title = $_.MainWindowTitle } }) | ConvertTo-Json -Compress",
    ];
    const r = Bun.spawnSync(ps, { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const all = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "@(Get-Process chrome -ErrorAction SilentlyContinue).Count"], { stdout: "pipe", timeout: 20_000 });
    return { method: "Get-Process chrome, MainWindowHandle != 0", chromeProcesses: all.stdout.toString().trim(), windows: r.stdout.toString().trim() || "[]", stderr: r.stderr.toString().trim() };
  }
  if (process.platform === "linux") {
    const tool = Bun.which("xwininfo");
    if (tool === null) return { method: "xwininfo", available: false };
    const r = Bun.spawnSync([tool, "-root", "-tree"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const lines = r.stdout.toString().split("\n").filter((l) => /chrom/i.test(l));
    return { method: "xwininfo -root -tree (lines naming chrome)", windows: lines.map((l) => l.trim()) };
  }
  return { method: "none on this OS" };
}

function maskedDaemonInfo(file: string): unknown {
  if (!existsSync(file)) return { exists: false };
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw)) return { exists: true, parsed: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = k === "token" ? (typeof v === "string" ? `<${v.length} chars, masked>` : "<masked>") : v;
  return out;
}

function tree(dir: string, depth = 2): string[] {
  if (!existsSync(dir)) return [`${dir} (missing)`];
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      out.push(p + (name.isDirectory() ? "/" : ""));
      if (name.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return out;
}

function tail(file: string, n: number): string {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-n).join("\n") : `${file} (missing)`;
}

const p = paths();
show("platform", { platform: process.platform, arch: process.arch, bun: Bun.version, listener: p.listener, config: p.config, cache: p.cache, data: p.data });
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("<!doctype html><title>probe</title><button>Probe</button>", { headers: { "content-type": "text/html" } }),
});
try {
  await tabcap("daemon", "start");
  show("daemon.json (token masked)", maskedDaemonInfo(p.daemonInfo));
  const b = await tabcap("browser", "start", "--proxy", "none");
  const data = isRecord(b["data"]) ? b["data"] : {};
  show("summary: browser start", { channel: data["channel"], executableSource: data["executableSource"], front: data["front"] });
  await Bun.sleep(1500);
  show("visible browser windows after start (--no-startup-window)", visibleWindows());
  await tabcap("navigate", `http://127.0.0.1:${site.port}/`);
  await Bun.sleep(1000);
  show("visible browser windows after the first tab", visibleWindows());
  await tabcap("snapshot", "--interactive");
  await tabcap("daemon", "status");
  await tabcap("daemon", "stop");
} finally {
  site.stop(true);
  show("files under config/", tree(p.config));
  show("files under cache/ (depth 3)", tree(p.cache, 3));
  show("daemon.log (tail)", tail(p.logFile, 40));
  show("browser.log (tail)", tail(p.browserLog, 30));
}
console.log(`\nprobe finished with ${failed} failed step(s)`);
process.exit(failed === 0 ? 0 : 1);
