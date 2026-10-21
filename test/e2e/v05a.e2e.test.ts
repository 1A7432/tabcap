// L2 for 0.5-A `tabcap mcp` (Chrome for Testing, the real daemon, the range in site.ts).
// A real stdio MCP session: spawn `bun src/cli/main.ts mcp` with the e2e
// TABCAP_HOME, speak newline-delimited JSON-RPC 2.0 to it (MCP 2025-11-25:
// initialize → notifications/initialized → tools/list → tools/call), and
// compare each tool result with what the CLI prints for the same call. The
// default core set reaches the commands without their own tool through
// tabcap_run (daemon / browser start, daemon stop, analyze deps);
// `--all-tools` lists one tool per command.
// Expected values come from the MCP spec (protocolVersion, result shape),
// from the range page (title, the requests it makes, site.hits) and from the
// CLI itself for the same state (the envelope must be the same one), never
// from the MCP server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { startSite, type Site } from "./site.ts";
import { rec, tabcap } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let home = "";
let site: Site;

type Msg = Record<string, unknown>;

/** A minimal MCP client over the child's stdio: one JSON message per line, responses matched by id. */
class Client {
  readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  readonly lines: string[] = [];
  private waiters = new Map<number | string, (m: Msg) => void>();
  private nextId = 1;
  readonly done: Promise<void>;

  constructor(extra: string[] = []) {
    this.proc = Bun.spawn(["bun", MAIN, "mcp", ...extra], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.done = this.read();
  }

  private async read(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.lines.push(line);
        const m: unknown = JSON.parse(line);
        if (isRecord(m) && (typeof m["id"] === "number" || typeof m["id"] === "string")) this.waiters.get(m["id"])?.(m);
      }
    }
    if (buf !== "") this.lines.push(buf);
  }

  send(m: Msg): void {
    this.proc.stdin.write(JSON.stringify(m) + "\n");
  }

  request(method: string, params: Msg, ms = 90_000): Promise<Msg> {
    const id = this.nextId++;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} #${id} within ${ms} ms`)), ms);
      this.waiters.set(id, (m) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(m);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** tools/call → the envelope parsed from the single text item, plus isError. */
  async call(name: string, args: Msg = {}): Promise<{ env: Msg; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    const result = isRecord(r["result"]) ? r["result"] : null;
    if (result === null) throw new Error(`tools/call ${name}: ${JSON.stringify(r)}`);
    const content = Array.isArray(result["content"]) ? result["content"] : [];
    expect(content.length).toBe(1);
    const item: unknown = content[0];
    if (!isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") throw new Error(`not one text item: ${JSON.stringify(result)}`);
    const env: unknown = JSON.parse(item["text"]);
    if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${item["text"]}`);
    expect(item["text"]).toBe(JSON.stringify(env, null, 2));
    expect(result["isError"]).toBe(env["ok"] !== true);
    return { env, isError: result["isError"] === true };
  }
}

async function cli(args: string[]): Promise<Msg> {
  return (await tabcap(home, args)).envelope;
}

/** Drop what differs between two runs of the same read-only command: the per-command `cmd` window id. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (!isRecord(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "cmd").map(([k, x]) => [k, stable(x)]));
}

describe.skipIf(!enabled)("tabcap 0.5-A L2 (tabcap mcp over stdio)", () => {
  let c: Client;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e5a-"));
    site = startSite();
    c = new Client();
  });

  afterAll(async () => {
    if (c.proc.exitCode === null) c.proc.kill();
    await cli(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("initialize → initialized → tools/list", async () => {
    const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "v05a", version: "0" } });
    expect(rec(init["result"])).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "tabcap" } });
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await c.request("tools/list", {});
    const tools = Array.isArray(rec(list["result"])["tools"]) ? (rec(list["result"])["tools"] as unknown[]) : [];
    const names = tools.map((t) => rec(t)["name"]);
    for (const n of ["tabcap_navigate", "tabcap_snapshot", "tabcap_net_list", "tabcap_handoff_wait", "tabcap_run", "tabcap_help"]) expect(names).toContain(n);
    // the core set: commands outside it go through tabcap_run
    expect(names.length).toBe(24);
    for (const n of ["tabcap_mcp", "tabcap_daemon_start", "tabcap_analyze_deps"]) expect(names).not.toContain(n);
    const help = await c.call("tabcap_help", { command: "analyze deps" });
    expect(help.env).toMatchObject({ ok: true, data: { name: "analyze deps", via: "tabcap_run" } });
  });

  test("navigate → snapshot → net list → daemon stop; each envelope is the one the CLI gives for the same call", async () => {
    const S = { session: "m" };
    expect((await c.call("tabcap_run", { argv: ["daemon", "start"] })).env).toMatchObject({ ok: true });
    // Review 10-21: --executable-path / --chrome-arg are for the human over MCP; the daemon finds the browser through TABCAP_CHROME.
    expect((await c.call("tabcap_run", { argv: ["browser", "start", "--proxy", "none", "--executable-path", CHROME] })).env).toMatchObject({ ok: false, error: { code: "usage" } });
    expect((await c.call("tabcap_run", { argv: ["browser", "start", "--proxy", "none"] })).env).toMatchObject({ ok: true });
    expect((await c.call("tabcap_net_start", S)).env).toMatchObject({ ok: true });

    // navigate: the MCP call in session m, the CLI in session c (both recording), the same URL → the same page facts.
    expect(await cli(["net", "start", "--session", "c"])).toMatchObject({ ok: true });
    const url = `${site.origin}/`;
    const nav = await c.call("tabcap_navigate", { ...S, url });
    expect(nav.isError).toBe(false);
    const navCli = await cli(["navigate", url, "--session", "c"]);
    const navData = rec(nav.env["data"]);
    const navCliData = rec(navCli["data"]);
    expect(navData["url"]).toBe(url);
    expect(navData["title"]).toBe("tabcap e2e home");
    for (const k of ["url", "title", "readyState"]) expect(navData[k]).toEqual(navCliData[k]);
    expect(Object.keys(navData).sort()).toEqual(Object.keys(navCliData).sort());

    // snapshot and net list are read-only: the CLI right after the MCP call, same session, same envelope.
    const snap = await c.call("tabcap_snapshot", { ...S, interactive: true });
    const snapCli = await cli(["snapshot", "--interactive", "--session", "m"]);
    expect(snap.env["ok"]).toBe(true);
    expect(stable(snap.env)).toEqual(stable(snapCli));
    expect(JSON.stringify(snap.env)).toContain("Add item");

    // Let the page's trailing requests (a favicon on Windows CI) land before the two lists are compared.
    expect(await cli(["wait", "--idle", "500", "--session", "m"])).toMatchObject({ ok: true });
    const net = await c.call("tabcap_net_list", S);
    const netCli = await cli(["net", "list", "--session", "m"]);
    expect(net.env["ok"]).toBe(true);
    expect(stable(net.env)).toEqual(stable(netCli));
    // the range served the page and its XHR (site.hits) and both are in the list
    expect(site.hits).toContain("GET /api/items");
    const listed = JSON.stringify(net.env);
    expect(listed).toContain(`${site.origin}/api/items`);

    // usage errors are tool results, not protocol errors: one from the schema, one from the CLI / daemon for tabcap_run
    const bad = await c.call("tabcap_snapshot", { ...S, maxChars: "many" });
    expect(bad.isError).toBe(true);
    expect(bad.env).toMatchObject({ ok: false, error: { code: "usage" } });
    const badRun = await c.call("tabcap_run", { argv: ["go", "sideways", "--session", "m"] });
    expect(badRun.isError).toBe(true);
    expect(badRun.env).toEqual(await cli(["go", "sideways", "--session", "m"]));

    // analyze deps is not a core tool: tabcap_run on the finished bundle, the same envelope as the CLI
    const stopped = await c.call("tabcap_net_stop", S);
    const bundle = String(rec(stopped.env["data"])["bundle"]);
    expect(bundle).toStartWith(home);
    const deps = await c.call("tabcap_run", { argv: ["analyze", "deps", bundle] });
    expect(deps.env["ok"]).toBe(true);
    expect(deps.env).toEqual(await cli(["analyze", "deps", bundle]));
    // a command that would read the MCP channel is refused
    const refused = await c.call("tabcap_run", { argv: ["site", "add", "example", "--url", url, "--user", "alice"] });
    expect(refused.env).toMatchObject({ ok: false, error: { code: "usage" } });

    const stop = await c.call("tabcap_run", { argv: ["daemon", "stop"] });
    expect(stop.env).toMatchObject({ ok: true, data: { stopped: true } });
    expect(await cli(["daemon", "status"])).toMatchObject({ ok: true, data: { running: false } });
  }, 120_000);

  test("--all-tools lists one tool per command", async () => {
    const all = new Client(["--all-tools"]);
    await all.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const list = await all.request("tools/list", {});
    const tools = rec(list["result"])["tools"];
    const names = Array.isArray(tools) ? tools.map((t) => rec(t)["name"]) : [];
    for (const n of ["tabcap_daemon_start", "tabcap_analyze_deps", "tabcap_navigate", "tabcap_handoff_wait"]) expect(names).toContain(n);
    expect(names).not.toContain("tabcap_run");
    await all.proc.stdin.end();
    expect(await all.proc.exited).toBe(0);
  });

  test("closing stdin ends the server (exit 0); stdout held only JSON-RPC messages", async () => {
    await c.proc.stdin.end();
    const code = await Promise.race([c.proc.exited, Bun.sleep(10_000).then(() => "timeout")]);
    expect(code).toBe(0);
    await c.done;
    expect(c.lines.length).toBeGreaterThan(0);
    for (const l of c.lines) expect(rec(JSON.parse(l))["jsonrpc"]).toBe("2.0");
  });
});
