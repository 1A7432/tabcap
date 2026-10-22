// CI load sampler (0.8.2): runs in the background of the e2e step and appends to a
// log what the runner is busy with, so a stall in the e2e logs can be matched to the
// machine at that moment (PR #29: a Windows shard slowed to a third of its speed with
// nothing in the daemon logs to say why). Every 10 s one line: time, CPU use over the
// interval (all cores), free memory, how many Chrome / Bun processes are running.
// Every 30 s the 15 busiest processes (ps on Linux, Get-Process on Windows: the e2e OSes).
// Runs until killed; only reads, never contacts the network.
//
//   bun scripts/ci-sampler.ts <log file>

import { appendFileSync, mkdirSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { dirname } from "node:path";

const out = process.argv[2];
if (out === undefined || out === "") {
  console.error("usage: bun scripts/ci-sampler.ts <log file>");
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const windows = process.platform === "win32";

function write(line: string): void {
  appendFileSync(out ?? "", line + "\n");
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    total += t;
    busy += t - c.times.idle;
  }
  return { busy, total };
}

async function run(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [text] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return text;
  } catch (e) {
    return `(${cmd[0]} failed: ${String(e)})`;
  }
}

/** Process names, one per line. */
async function names(): Promise<string[]> {
  const text = windows ? await run(["tasklist", "/fo", "csv", "/nh"]) : await run(["ps", "-eo", "comm="]);
  return text
    .split(/\r?\n/)
    .map((l) => (windows ? (l.split('","')[0] ?? "").replace(/^"/, "") : l.trim()))
    .filter((l) => l !== "");
}

async function busiest(): Promise<string> {
  if (windows) {
    return run(["powershell", "-NoProfile", "-Command", "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Id,CPU,@{n='WS(MB)';e={[int]($_.WS/1MB)}},StartTime,ProcessName | Format-Table -AutoSize | Out-String -Width 200"]);
  }
  const text = await run(["ps", "-eo", "pid,pcpu,rss,etime,comm", "--sort=-pcpu"]);
  return text.split("\n").slice(0, 16).join("\n");
}

let prev = cpuTimes();
for (let tick = 0; ; tick++) {
  await Bun.sleep(10_000);
  const now = cpuTimes();
  const cpu = now.total > prev.total ? Math.round((100 * (now.busy - prev.busy)) / (now.total - prev.total)) : 0;
  prev = now;
  const ps = await names();
  const count = (re: RegExp) => ps.filter((n) => re.test(n)).length;
  write(`${new Date().toISOString()} cpu=${cpu}% free=${Math.round(freemem() / 1048576)}/${Math.round(totalmem() / 1048576)}MB chrome=${count(/chrom/i)} bun=${count(/^bun/i)} procs=${ps.length}`);
  if (tick % 3 === 2) write((await busiest()).trimEnd().replace(/^/gm, "  "));
}
