// Owner 10-21 (docs/04 §39 / §37): `handoff wait` without --until-* only waits
// for the human and never touches the handoff's tab (it may be closed: an OAuth
// popup that closed itself); with --until-* a closed handoff tab is `no-tab`
// naming it, `next` pointing to `handoff continue`. When the browser goes away
// (crash or `browser stop`) every handoff ends (`resumed`, by `browser-gone`;
// a `handoff` event in a recording that still runs); `session stop` ends that
// session's handoff. The browser is the fake one in _fakechrome.ts (POSIX).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree, until } from "./_platform.ts";

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await handleCommand(d, { action: "browser.stop", args: {}, session: "x" }, () => undefined);
  for (const r of roots.splice(0)) await removeTree(r);
});

type Env = Awaited<ReturnType<typeof handleCommand>>;
const err = (env: Env): Record<string, unknown> => (env.ok ? {} : env.error);
const data = (env: Env): Record<string, unknown> => (env.ok && isRecord(env.data) ? env.data : {});

async function started(): Promise<{ d: Daemon; run: (action: string, args: Record<string, unknown>, session: string) => Promise<Env> }> {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-hgone-"));
  roots.push(dir);
  const p = paths({ TABCAP_HOME: dir });
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  const d = new Daemon(p);
  daemons.push(d);
  const run = (action: string, args: Record<string, unknown>, session: string) => handleCommand(d, { action, args, session }, () => undefined);
  const env = await run("browser.start", { executablePath: fakeChrome(dir, { url: "http://127.0.0.1:9/login" }), proxy: "none" }, "x");
  if (!env.ok) throw new Error(`fake browser did not start: ${JSON.stringify(env.error)}`);
  return { d, run };
}

async function takenOver(d: Daemon, session: string) {
  const b = d.browser;
  if (b === null) throw new Error("the fake browser is not running");
  const tab = await b.tabs.createTab(session);
  const h = d.guard.takeover(session, { tab: tab.id, url: tab.url, event: "pointerdown", at: 1 }, d.recorders.get(session));
  await h.started;
  return { b, tab, h };
}

const events = (dir: string): Array<Record<string, unknown>> =>
  readFileSync(join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l): unknown => JSON.parse(l))
    .filter(isRecord);

describe.skipIf(!FAKE_CHROME)("handoff wait and the handoff's tab (fake browser, POSIX)", () => {
  test(
    "without --until-*: the handoff's tab closed, the wait still waits for the human",
    async () => {
      const { d, run } = await started();
      const { b, tab } = await takenOver(d, "w");
      b.tabs.markClosed(tab);
      const waiting = run("handoff.wait", { timeoutMs: 5000 }, "w");
      setTimeout(() => d.guard.resume("w", "human"), 100);
      expect(data(await waiting)).toMatchObject({ session: "w", state: "resumed", by: "human" });
    },
    SLOW_IO_MS,
  );

  test(
    "with --until-*: a closed handoff tab is no-tab naming it; next is handoff continue (--session, MCP); the session still waits",
    async () => {
      const { d, run } = await started();
      const { b, tab } = await takenOver(d, "w");
      b.tabs.markClosed(tab);
      const e = err(await run("handoff.wait", { untilUrl: "/home", timeoutMs: 2000 }, "w"));
      expect(e).toMatchObject({ code: "no-tab", state: "waiting", reason: "human-takeover" });
      expect(String(e["message"])).toContain(`the handoff's tab ${tab.id}`);
      expect(String(e["message"])).toContain("closed");
      expect(String(e["next"])).toContain("`tabcap handoff continue --session w`");
      expect(String(e["next"])).toContain("tabcap_handoff_continue");
      expect(d.guard.isWaiting("w")).toBe(true);
    },
    SLOW_IO_MS,
  );

  test(
    "with --until-*: the tab closing during the wait is the same no-tab, before the timeout",
    async () => {
      const { d, run } = await started();
      const { b, tab } = await takenOver(d, "w");
      setTimeout(() => b.tabs.markClosed(tab), 300);
      const t0 = Date.now();
      const e = err(await run("handoff.wait", { untilUrl: "/never", timeoutMs: 8000 }, "w"));
      expect(e).toMatchObject({ code: "no-tab", reason: "human-takeover" });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(d.guard.isWaiting("w")).toBe(true);
    },
    SLOW_IO_MS,
  );
});

describe.skipIf(!FAKE_CHROME)("the browser goes away, session stop (fake browser, POSIX)", () => {
  test(
    "a crash ends every handoff (by browser-gone): an event in the recording that still ran, none without one; a running handoff wait answers it",
    async () => {
      const { d, run } = await started();
      const net = await run("net.start", {}, "r");
      expect(net.ok).toBe(true);
      const bundle = String(data(net)["bundle"] ?? "");
      await takenOver(d, "r");
      await takenOver(d, "q");
      const waiting = run("handoff.wait", { timeoutMs: 10_000 }, "q");
      await Bun.sleep(50);
      await d.browser?.t.send("FakeChrome.crash", {}, null, 5000).catch(() => undefined);
      await until(() => d.browser === null, 10_000);
      expect(d.browser).toBeNull();
      expect(d.guard.get("r")).toBeNull();
      expect(d.guard.get("q")).toBeNull();
      expect(d.guard.all()).toEqual([]);
      expect(data(await waiting)).toMatchObject({ session: "q", state: "resumed", by: "browser-gone" });
      const handoffs = events(bundle).filter((e) => e["kind"] === "handoff");
      expect(handoffs.map((e) => [e["state"], e["reason"], e["by"] ?? null])).toEqual([
        ["waiting", "human-takeover", null],
        ["resumed", "human-takeover", "browser-gone"],
      ]);
    },
    SLOW_IO_MS,
  );

  test(
    "browser stop ends every handoff the same way",
    async () => {
      const { d, run } = await started();
      const net = await run("net.start", {}, "r");
      const bundle = String(data(net)["bundle"] ?? "");
      await takenOver(d, "r");
      expect((await run("browser.stop", {}, "x")).ok).toBe(true);
      expect(d.guard.all()).toEqual([]);
      const handoffs = events(bundle).filter((e) => e["kind"] === "handoff");
      expect(handoffs.map((e) => [e["state"], e["by"] ?? null])).toEqual([
        ["waiting", null],
        ["resumed", "browser-gone"],
      ]);
    },
    SLOW_IO_MS,
  );

  test(
    "session stop ends that session's handoff, not another's",
    async () => {
      const { d, run } = await started();
      await takenOver(d, "s1");
      await takenOver(d, "s2");
      expect((await run("session.stop", { name: "s1" }, "s1")).ok).toBe(true);
      expect(d.guard.get("s1")).toBeNull();
      expect(d.guard.isWaiting("s2")).toBe(true);
      expect(data(await run("handoff.status", {}, "s1"))).toMatchObject({ session: "s1", state: "running", handoff: null });
    },
    SLOW_IO_MS,
  );
});
