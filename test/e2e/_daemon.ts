// A script's view of the daemon API, for the e2e tests that talk to the daemon
// without the CLI (POST /fetch as _tabcap_fetch.py does, the test-only
// e2e.human-input action). It resolves the endpoint the way src/cli/client.ts
// does: the Unix socket recorded in config/daemon.json, or on Windows the
// loopback port with the bearer token from the same file (0.7.3: the three
// callers used `unix:` only, which was every Windows e2e failure).
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { rec } from "./_cli.ts";

export async function daemonRequest(home: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const info = rec(JSON.parse(readFileSync(join(home, "config", "daemon.json"), "utf8")));
  const init: BunFetchRequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  let res: Response;
  if (info["listener"] === "tcp") {
    const host = typeof info["host"] === "string" ? info["host"] : "127.0.0.1";
    res = await fetch(`http://${host}:${String(info["port"])}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${String(info["token"])}` } });
  } else {
    res = await fetch(`http://localhost${path}`, { ...init, unix: String(info["socket"]) });
  }
  return rec(await res.json());
}

/**
 * Remove a test's temp TABCAP_HOME. With TABCAP_E2E_KEEP set (CI), first copy
 * its config/*.log (daemon.log, browser.log) to <KEEP>/<test file>/<home>/, and
 * with `bundles` its data/bundles too, so a failed run leaves its logs behind.
 */
export function removeHome(home: string, testFile: string, o: { bundles?: boolean } = {}): void {
  const keep = process.env["TABCAP_E2E_KEEP"] ?? "";
  if (keep !== "" && home !== "") {
    const to = join(keep, basename(testFile).replace(/\.e2e\.test\.ts$/, ""), basename(home));
    for (const sub of ["config", ...(o.bundles === true ? [join("data", "bundles")] : [])]) {
      const src = join(home, sub);
      if (!existsSync(src)) continue;
      cpSync(src, join(to, sub), { recursive: true, filter: (f) => sub !== "config" || f === src || f.endsWith(".log") });
    }
  }
  rmSync(home, { recursive: true, force: true });
}
