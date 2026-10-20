// CI failure ledger (owner decision 2026-10-20: no blind re-runs): which tests
// failed in the recent ci.yml runs, how often, on which jobs. A test that keeps
// coming back is a flake to fix at its root, not to re-run.
//
//   bun scripts/ci-flakes.ts [--limit 50] [--branch main] [--json]
//
// Reads every failed run and every earlier attempt of a re-run through `gh`
// (`gh run list`, `gh run view --attempt <n> --log-failed`), so it needs gh
// and network; the parsing and tallying below are pure and unit-tested.

import { isRecord } from "../src/shared/json.ts";

export type Failure = { job: string; test: string };
export type RunFailures = { run: number; attempt: number; branch: string; date: string; failures: Failure[] };
export type LedgerRow = { test: string; count: number; jobs: string[]; runs: string[]; last: string };

/**
 * Pure: the failed tests in one `gh run view --log-failed` text. Lines are
 * `<job>\t<step>\t<timestamp> <text>`; bun prints `(fail) <name> [<ms>ms]` once
 * where the test ran and again in its summary, so each (job, test) counts once.
 */
export function failuresFromLog(text: string): Failure[] {
  const seen = new Set<string>();
  const out: Failure[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    const job = cols[0] ?? "";
    const rest = cols.slice(2).join("\t");
    const m = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/.exec(rest);
    if (m === null || m[1] === undefined || job === "") continue;
    const key = `${job}\u0000${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ job, test: m[1] });
  }
  return out;
}

/** Pure: one row per test, most failures first (then most recent). */
export function tally(runs: readonly RunFailures[]): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  for (const r of runs) {
    for (const f of r.failures) {
      const row = rows.get(f.test) ?? { test: f.test, count: 0, jobs: [], runs: [], last: "" };
      row.count++;
      if (!row.jobs.includes(f.job)) row.jobs.push(f.job);
      const id = r.attempt > 1 ? `${r.run}#${r.attempt}` : String(r.run);
      if (!row.runs.includes(id)) row.runs.push(id);
      if (r.date > row.last) row.last = r.date;
      rows.set(f.test, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`gh ${args.join(" ")}: ${err.trim()}`);
  return out;
}

type RunRow = { databaseId: number; conclusion: string; attempt: number; headBranch: string; createdAt: string };

function isRunRow(r: unknown): r is RunRow {
  return isRecord(r) && typeof r["databaseId"] === "number" && typeof r["attempt"] === "number" && typeof r["headBranch"] === "string" && typeof r["createdAt"] === "string";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const limit = Number(opt("--limit") ?? "50");
  const branch = opt("--branch");
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("usage: bun scripts/ci-flakes.ts [--limit N] [--branch name] [--json]");
    process.exit(2);
  }
  const listed: unknown = JSON.parse(
    await gh(["run", "list", "--workflow", "ci.yml", "--limit", String(limit), "--json", "databaseId,conclusion,attempt,headBranch,createdAt", ...(branch === null ? [] : ["--branch", branch])]),
  );
  const rows = (Array.isArray(listed) ? listed : []).filter(isRunRow);
  const runs: RunFailures[] = [];
  for (const r of rows) {
    // A failed run's last attempt, and every earlier attempt of a run that was re-run.
    const attempts = Array.from({ length: r.attempt }, (_, i) => i + 1).filter((a) => a < r.attempt || r.conclusion === "failure");
    for (const attempt of attempts) {
      const log = await gh(["run", "view", String(r.databaseId), "--attempt", String(attempt), "--log-failed"]).catch(() => "");
      runs.push({ run: r.databaseId, attempt, branch: r.headBranch, date: r.createdAt.slice(0, 10), failures: failuresFromLog(log) });
    }
  }
  const ledger = tally(runs);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ runs: rows.length, failedAttempts: runs.length, ledger }, null, 2));
  } else {
    console.log(`${rows.length} ci.yml runs${branch === null ? "" : ` on ${branch}`}, ${runs.length} failed attempt(s)`);
    for (const row of ledger) console.log(`${String(row.count).padStart(3)}×  ${row.last}  ${row.test}\n      jobs: ${row.jobs.join(", ")}\n      runs: ${row.runs.join(" ")}`);
    const silent = runs.filter((r) => r.failures.length === 0);
    if (silent.length > 0) console.log(`failed attempts with no (fail) line (setup, timeout, cancelled): ${silent.map((r) => (r.attempt > 1 ? `${r.run}#${r.attempt}` : r.run)).join(" ")}`);
  }
}
