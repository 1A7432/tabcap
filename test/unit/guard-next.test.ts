// The `next` of `waiting` / `guard.stopped` / `fetch.stopped` (owner 10-21):
// commands carry `--session <s>` unless the session is the default one, and a
// next that names `handoff wait` / `handoff continue` ends with the MCP tools
// for them (`tabcap handoff wait` is not runnable through tabcap_run,
// src/mcp/tools.ts EXCLUDED). Expected values: the owner's ruling and the tool
// names in src/mcp/tools.ts (HANDOFF_WAIT, toolName of `handoff continue`).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_NEXT, STOP_RULE_NEXT, TAKEOVER_NEXT, fetchStoppedError, handoffView, waitingError, type Handoff } from "../../src/daemon/guard.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { matchCommand } from "../../src/cli/commands.ts";
import { HANDOFF_WAIT, toolName } from "../../src/mcp/tools.ts";
import { paths } from "../../src/shared/paths.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-next-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const continueCmd = matchCommand(["handoff", "continue"]);
const CONTINUE_TOOL = continueCmd === null ? "?" : toolName(continueCmd);

function handoff(session: string, o: Partial<Handoff> = {}): Handoff {
  return { session, state: "waiting", reason: "verify-page", site: null, origin: null, url: "http://x.test/v", status: 403, request: "r-6", tab: "t1", since: 1, screenshot: null, handlers: [], resumedAt: null, resumedBy: null, delivered: false, ...o };
}

describe("waiting / guard.stopped next: --session and the MCP tools", () => {
  test("the MCP tool names are the ones the MCP server has", () => {
    expect(HANDOFF_WAIT).toBe("tabcap_handoff_wait");
    expect(CONTINUE_TOOL).toBe("tabcap_handoff_continue");
  });

  test("verify-page: default session without --session, another with it; MCP tools at the end", () => {
    const d = waitingError(handoff("default")).next;
    expect(d).toContain("`tabcap handoff continue`");
    expect(d).not.toContain("--session");
    expect(d).toEndWith(`(over MCP: ${HANDOFF_WAIT}, ${CONTINUE_TOOL}).`);
    const s = waitingError(handoff("shop")).next;
    expect(s).toContain("`tabcap handoff continue --session shop`");
    expect(s).toContain("`tabcap handoff wait --until-url <a URL only reached once they are done> --session shop`");
    expect(s).toEndWith(`(over MCP: ${HANDOFF_WAIT}, ${CONTINUE_TOOL}).`);
    expect(s).toBe(CONTINUE_NEXT("shop"));
  });

  test("human-takeover: the same", () => {
    const h = handoff("shop", { reason: "human-takeover", request: null, status: null, input: { event: "pointerdown", at: 1 } });
    const n = waitingError(h).next;
    expect(n).toBe(TAKEOVER_NEXT("shop"));
    expect(n).toContain("`tabcap handoff continue --session shop`");
    expect(n).toContain("`tabcap handoff wait --until-url <the URL after it> --session shop`");
    expect(n).toEndWith(`(over MCP: ${CONTINUE_TOOL}, ${HANDOFF_WAIT}).`);
    expect(TAKEOVER_NEXT("default")).not.toContain("--session");
  });

  test("stop-rule (guard.stopped): net body and handoff continue carry --session; guard resume is site-wide", () => {
    const h = handoff("shop", { reason: "stop-rule", site: "example", rule: "status>=500", ruleDetail: "status 503" });
    const e = waitingError(h);
    expect(e.code).toBe("guard.stopped");
    expect(e.next).toContain("`tabcap net body r-6 --session shop`");
    expect(e.next).toContain("`tabcap handoff continue --session shop` (or `tabcap guard resume --site example`)");
    expect(e.next).toEndWith(`(over MCP: ${CONTINUE_TOOL}).`);
    expect(STOP_RULE_NEXT({ session: "default", site: null, request: null })).toContain("`tabcap net body <r-N>`");
  });

  test("handoffView and the read-only commands' notice give the same next as the error", () => {
    const h = handoff("shop");
    expect(handoffView(h)["next"]).toBe(waitingError(h).next);
  });

  test("a fetch stop (guard.stopped of fetches): net body of the stopped request in the session that stopped it", () => {
    const e = fetchStoppedError({ site: "example", session: "shop", rule: "status>=500", detail: "status 503", request: "r-3", fetchId: "c-2:f-1", url: "http://x.test/a", status: 503, since: 1, reason: "fetch-stop" });
    expect(e.next).toContain("`tabcap net body r-3 --session shop`");
    expect(e.next).toContain("`tabcap guard resume --site example`");
    const dflt = fetchStoppedError({ site: "example", session: "default", rule: "status>=500", detail: "status 503", request: "r-3", fetchId: null, url: "http://x.test/a", status: 503, since: 1, reason: "fetch-stop" });
    expect(dflt.next).toContain("`tabcap net body r-3`");
  });
});

describe("handoff wait next: --session and the MCP tools", () => {
  const run = (d: Daemon, args: Record<string, unknown>, session: string) => handleCommand(d, { action: "handoff.wait", args, session }, () => undefined);
  const err = (env: Awaited<ReturnType<typeof handleCommand>>): Record<string, unknown> => (env.ok ? {} : env.error);

  test("timeout: run handoff wait again or handoff continue, both with --session, each with its MCP tool", async () => {
    const d = new Daemon(paths({ TABCAP_HOME: tmp() }));
    d.guard.takeover("shop", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    const e = err(await run(d, { timeoutMs: 100 }, "shop"));
    expect(e["code"]).toBe("waiting");
    expect(String(e["next"])).toContain(`\`tabcap handoff wait --session shop\` again (over MCP: ${HANDOFF_WAIT})`);
    expect(String(e["next"])).toContain(`\`tabcap handoff continue --session shop\` (over MCP: ${CONTINUE_TOOL})`);
    const d2 = new Daemon(paths({ TABCAP_HOME: tmp() }));
    d2.guard.takeover("default", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    expect(String(err(await run(d2, { timeoutMs: 100 }, "default"))["next"])).not.toContain("--session");
  });

  test("a stop-rule wait refuses --until-*: next with --session and the MCP tools", async () => {
    const d = new Daemon(paths({ TABCAP_HOME: tmp() }));
    d.guard.takeover("shop", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    const h = d.guard.get("shop");
    if (h === null) throw new Error("no handoff");
    h.reason = "stop-rule";
    h.request = "r-9";
    const e = err(await run(d, { untilUrl: "/home" }, "shop"));
    expect(e["code"]).toBe("usage");
    expect(String(e["next"])).toContain("`tabcap net body r-9 --session shop`");
    expect(String(e["next"])).toContain("`tabcap handoff continue --session shop`");
    expect(String(e["next"])).toContain("`tabcap handoff wait --session shop` without --until-*");
    expect(String(e["next"])).toEndWith(`(over MCP: ${CONTINUE_TOOL}, ${HANDOFF_WAIT}).`);
  });
});
