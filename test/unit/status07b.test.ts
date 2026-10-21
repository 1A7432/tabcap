// 0.7-B `tabcap status`: the conflict rules (pure functions over the status
// facts), the `--text` screen, the answer read off a daemon without a
// browser, and the CLI fallback without a daemon. Expected values: the rule
// texts of the owner decision 2026-10-17 and the guard behaviour they
// describe (handoff.ts guardResume / handoffContinue), not tabcap's output.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import {
  conflictsOf,
  nextOf,
  offlineStatus,
  renderStatusText,
  ruleDecodePluginOutranksPage,
  ruleRecordingWithoutBrowser,
  ruleTraceWithoutRecording,
  ruleUnboundSession,
  ruleWaitingAndFetchStop,
  statusOf,
  STATUS_SCHEMA,
  type StatusFacts,
  type StatusGuardStop,
  type StatusSession,
} from "../../src/daemon/tools/status.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";

const OFF = { state: "off" as const, decode: false, weakRows: null };

function sess(name: string, o: Partial<StatusSession> = {}): StatusSession {
  return { session: name, site: "shop", account: "alice", tabSite: null, tabs: 1, current: "t1", url: null, recording: null, state: "running", reason: null, screenshot: null, trace: OFF, guardStops: [], protection: [], ...o };
}

const REC = { bundle: "/b/w-1", since: 1, entries: 7, decodePlugins: [] as string[] };

function facts(sessions: StatusSession[], o: Partial<StatusFacts> = {}): StatusFacts {
  return {
    schema: STATUS_SCHEMA,
    daemon: { running: true, pid: 42, version: "0", listener: "unix", socket: "/s", startedAt: 1 },
    browser: { running: true, pid: 7, mode: "direct", tabs: sessions.reduce((n, s) => n + s.tabs, 0), webdriver: "hidden", extraArgs: [], dropArgs: [] },
    sessions,
    plugins: { decode: [], challenge: [] },
    handoff: [],
    ...o,
  };
}

const stop = (o: Partial<StatusGuardStop> = {}): StatusGuardStop => ({ site: "shop", rule: "status>=400", since: 5, reason: "fetch-stop", by: "w", request: "r-6", ...o });

describe("conflict rules (pure)", () => {
  test("(a) waiting + a fetch stop on its site: guard resume does not end the wait; next is handoff continue", () => {
    const f = facts([sess("w", { state: "waiting", reason: "verify-page", screenshot: "/x.png", guardStops: [stop()] })]);
    const c = ruleWaitingAndFetchStop(f);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ code: "waiting-and-fetch-stop", session: "w" });
    expect(c[0]?.message).toContain("does not end the wait");
    expect(c[0]?.message).toContain("verify-page");
    expect(c[0]?.next).toContain("tabcap handoff continue --session w");
    expect(c[0]?.next).not.toContain("guard resume");
  });

  test("(a) a stop another session set off stays after handoff continue: next names guard resume for it", () => {
    const c = ruleWaitingAndFetchStop(facts([sess("w", { state: "waiting", reason: "verify-page", guardStops: [stop({ by: "other" })] })]));
    expect(c[0]?.next).toContain("tabcap guard resume --site shop");
  });

  test("(a) not raised: one site stop rule of this session (guard resume ends both), running sessions, no stop", () => {
    expect(ruleWaitingAndFetchStop(facts([sess("w", { state: "waiting", reason: "stop-rule", guardStops: [stop({ reason: "stop-rule" })] })]))).toEqual([]);
    expect(ruleWaitingAndFetchStop(facts([sess("w", { guardStops: [stop()] })]))).toEqual([]);
    expect(ruleWaitingAndFetchStop(facts([sess("w", { state: "waiting", reason: "verify-page" })]))).toEqual([]);
    // a stop-rule wait with a fetch-stop of the same session: guard resume lifts the fetch stop only
    expect(ruleWaitingAndFetchStop(facts([sess("w", { state: "waiting", reason: "stop-rule", guardStops: [stop()] })]))).toHaveLength(1);
  });

  test("(b) an enabled decode plugin while a session observes (trace --decode): plugin disable, which a recording follows from its next body", () => {
    const on = { state: "on" as const, decode: true, weakRows: 0 };
    const idle = ruleDecodePluginOutranksPage(facts([sess("u", { site: null, trace: on })], { plugins: { decode: ["xor-decode"], challenge: [] } }));
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ code: "decode-plugin-outranks-page", session: "u" });
    expect(idle[0]?.message).toContain("plugin views outrank page views");
    expect(idle[0]?.next).toBe("to observe the page: `tabcap plugin disable xor-decode`");
    // 0.7-E: a recording reads the enabled plugins per body: disabling applies from its next body, no restart
    const recd = ruleDecodePluginOutranksPage(facts([sess("u", { trace: on, recording: { ...REC, decodePlugins: ["xor-decode"] } })], { plugins: { decode: ["xor-decode"], challenge: [] } }));
    expect(recd[0]?.next).toBe("to observe the page: `tabcap plugin disable xor-decode` (applies from the next body; bodies already decoded keep their plugin view)");
    expect(recd[0]?.message).toContain("apply to its recording");
    // disabled since: nothing applies any more, whatever the recording used before
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: on, recording: { ...REC, decodePlugins: ["xor-decode"] } })]))).toEqual([]);
    // enabled after net start: it applies to the recording too
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: on, recording: REC })], { plugins: { decode: ["xor-decode"], challenge: [] } }))).toHaveLength(1);
    // two plugins: the placeholder
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: on })], { plugins: { decode: ["a", "b"], challenge: [] } }))[0]?.next).toContain("plugin disable <name>");
  });

  test("(b) not raised: no decode plugin enabled, trace without --decode, trace off", () => {
    const pl = { plugins: { decode: ["xor-decode"], challenge: [] } };
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: { state: "on", decode: true, weakRows: 0 } })]))).toEqual([]);
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: { state: "on", decode: false, weakRows: null } })], pl))).toEqual([]);
    expect(ruleDecodePluginOutranksPage(facts([sess("u")], pl))).toEqual([]);
    expect(ruleDecodePluginOutranksPage(facts([sess("u", { trace: { state: "off", decode: false, weakRows: null }, recording: REC })], pl))).toEqual([]);
  });

  test("(c) a session with tabs, no site, and its tab on a store site: fill --secret refused; session stop, then session start --site", () => {
    const c = ruleUnboundSession(facts([sess("u", { site: null, account: null, tabSite: "shop" }), sess("w")]));
    expect(c).toEqual([
      {
        code: "unbound-session",
        session: "u",
        message: 'session "u" is on store site shop but not bound to it: `fill --secret` will be refused',
        next: "if it needs a stored secret: `tabcap session stop u`, then `tabcap session start u --site shop`",
      },
    ]);
    expect(ruleUnboundSession(facts([sess("u", { site: null, tabSite: "shop", tabs: 0 })]))).toEqual([]);
  });

  test("(c) not raised for a plain browsing session (no store site under its tab), owner 10-17", () => {
    expect(ruleUnboundSession(facts([sess("default", { site: null, account: null, tabSite: null })]))).toEqual([]);
    expect(conflictsOf(facts([sess("default", { site: null, account: null, tabSite: null })]))).toEqual([]);
  });

  test("(d) a recording open on a session whose browser (or every tab) is gone", () => {
    const gone = ruleRecordingWithoutBrowser(facts([sess("w", { tabs: 0, recording: REC })], { browser: { running: false, pid: null, mode: null, tabs: 0, webdriver: null, extraArgs: null, dropArgs: null } }));
    expect(gone).toHaveLength(1);
    expect(gone[0]?.message).toContain("the browser is not running");
    expect(gone[0]?.next).toBe("`tabcap net stop --session w` finishes the bundle");
    const noTab = ruleRecordingWithoutBrowser(facts([sess("w", { tabs: 0, recording: REC })]));
    expect(noTab[0]?.message).toContain("has no open tab");
    expect(noTab[0]?.next).toContain("tabcap navigate <url> --session w");
    expect(ruleRecordingWithoutBrowser(facts([sess("w", { recording: REC })]))).toEqual([]);
    expect(ruleRecordingWithoutBrowser(facts([sess("w", { tabs: 0 })]))).toEqual([]);
  });

  test("(e) trace on without a recording: rows reach no bundle until net start", () => {
    const sig = ruleTraceWithoutRecording(facts([sess("w", { trace: { state: "on", decode: false, weakRows: null } })]));
    expect(sig[0]).toMatchObject({ code: "trace-without-recording", session: "w", next: "`tabcap net start --session w`, then load the page again" });
    expect(sig[0]?.message).toContain("signal rows reach no bundle until `tabcap net start`");
    const obs = ruleTraceWithoutRecording(facts([sess("w", { trace: { state: "paused", decode: true, weakRows: 0 } })]));
    expect(obs[0]?.message).toContain("observe rows reach no bundle");
    expect(ruleTraceWithoutRecording(facts([sess("w", { trace: { state: "on", decode: false, weakRows: null }, recording: REC })]))).toEqual([]);
    expect(ruleTraceWithoutRecording(facts([sess("w")]))).toEqual([]);
  });

  test("conflictsOf: every rule, in rule order; nothing on a clean state", () => {
    expect(conflictsOf(facts([sess("w", { recording: REC })]))).toEqual([]);
    const f = facts(
      [
        sess("w", { state: "waiting", reason: "verify-page", guardStops: [stop()], recording: REC }),
        sess("u", { site: null, account: null, tabSite: "shop", trace: { state: "on", decode: true, weakRows: 1 } }),
        sess("z", { tabs: 0, recording: REC }),
      ],
      { plugins: { decode: ["xor-decode"], challenge: [] } },
    );
    expect(conflictsOf(f).map((c) => `${c.code}:${c.session}`)).toEqual(["waiting-and-fetch-stop:w", "decode-plugin-outranks-page:u", "unbound-session:u", "recording-without-browser:z", "trace-without-recording:u"]);
  });
});

describe("--text", () => {
  test("one line per session, then the conflicts with their next commands", () => {
    const f = facts(
      [
        sess("w", { state: "waiting", reason: "verify-page", screenshot: "/shots/w.png", guardStops: [stop()], recording: REC }),
        sess("u", { site: null, account: null, tabSite: "shop", current: "t2", trace: { state: "on", decode: true, weakRows: 3 } }),
      ],
      { plugins: { decode: ["xor-decode"], challenge: ["fake-verify"] } },
    );
    const text = renderStatusText({ ...f, conflicts: conflictsOf(f) });
    const lines = text.split("\n");
    expect(lines[0]).toBe("tabcap status · daemon pid 42 (unix) · browser pid 7 direct, 2 tab(s), webdriver hidden · plugins: decode xor-decode, challenge fake-verify");
    expect(lines[1]).toBe("w: site shop (alice) · 1 tab(s) (current t1) · recording 7 req → /b/w-1 · WAITING verify-page (screenshot /shots/w.png) · trace off · fetch stopped: shop status>=400");
    expect(lines[2]).toBe("u: no site · 1 tab(s) (current t2) · not recording · running · trace on decode (weak 3)");
    expect(lines[3]).toBe("conflicts (4):");
    expect(lines[4]).toStartWith("- [waiting-and-fetch-stop] ");
    expect(lines[5]).toBe("  next: after the human finished in the browser: `tabcap handoff continue --session w`");
    expect(lines.filter((l) => l.startsWith("- [")).map((l) => l.slice(3, l.indexOf("]")))).toEqual(["waiting-and-fetch-stop", "decode-plugin-outranks-page", "unbound-session", "trace-without-recording"]);
    expect(lines).toHaveLength(4 + 2 * 4);
  });

  test("0.7-E: a waiting session shows its tab URL and screenshot; the top-level next says handoff continue after the human", () => {
    const w = sess("w", { state: "waiting", reason: "verify-page", url: "http://127.0.0.1:9/verify", screenshot: "/shots/w.png" });
    const f = facts([w, sess("u", { site: null, account: null })]);
    const conflicts = conflictsOf(f);
    expect(conflicts).toEqual([]);
    const next = nextOf(f, conflicts);
    expect(next).toBe('session "w" waits for the human (verify-page): tell the user (screenshot /shots/w.png); after they finished in the browser: `tabcap handoff continue --session w`');
    const lines = renderStatusText({ ...f, conflicts, next }).split("\n");
    expect(lines[1]).toBe("w: site shop (alice) · 1 tab(s) (current t1) · not recording · WAITING verify-page at http://127.0.0.1:9/verify (screenshot /shots/w.png) · trace off");
    expect(lines.at(-1)).toBe(`next: ${next}`);
    // nothing waits: the first conflict's next, else null
    const rec = facts([sess("r", { recording: REC, tabs: 0, current: null })], { browser: { running: false, pid: null, mode: null, tabs: 0, webdriver: null, extraArgs: null, dropArgs: null } });
    expect(nextOf(rec, conflictsOf(rec))).toBe(conflictsOf(rec)[0]?.next ?? "?");
    expect(nextOf(facts([sess("ok")]), [])).toBeNull();
  });

  test("no daemon, no sessions, no conflicts; malformed input does not throw", () => {
    expect(renderStatusText(offlineStatus(mkdtempSync(join(tmpdir(), "tabcap-st-")), "unix"))).toBe("tabcap status · daemon not running (`tabcap daemon start`) · plugins: none\n(no sessions)\nconflicts: none");
    expect(renderStatusText(null)).toContain("daemon not running");
    expect(renderStatusText({ sessions: [1, { session: 3, trace: "x" }], conflicts: "no" })).toContain("3: no site");
  });
});

describe("status off a daemon (no browser)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const daemon = () => {
    const root = mkdtempSync(join(tmpdir(), "tabcap-st07b-"));
    roots.push(root);
    return new Daemon(paths({ TABCAP_HOME: root }));
  };

  test("the action answers before the command path: daemon facts, browser off, a bound session and its fetch stop listed", async () => {
    const d = daemon();
    d.sites.set("w", { site: "shop", account: "alice", proxy: null });
    d.guard.stopFetch(undefined, { site: "shop", session: "w", rule: "status>=400", detail: "HTTP 403", request: "r-6", fetchId: "c-1:0", url: "https://shop.test/api", status: 403, since: 9, reason: "fetch-stop" }, { tab: null, account: "alice" });
    const env = await handleCommand(d, { action: "status", args: {}, session: "w" }, () => undefined);
    expect(env.ok).toBe(true);
    const data = env.ok && isRecord(env.data) ? env.data : {};
    expect(data["schema"]).toBe(STATUS_SCHEMA);
    expect(data["daemon"]).toMatchObject({ running: true, pid: process.pid, listener: d.paths.listener });
    expect(data["browser"]).toEqual({ running: false, pid: null, mode: null, tabs: 0, webdriver: null, extraArgs: null, dropArgs: null });
    expect(data["sessions"]).toEqual([
      {
        session: "w",
        site: "shop",
        account: "alice",
        tabSite: null,
        tabs: 0,
        current: null,
        url: null,
        recording: null,
        state: "running",
        reason: null,
        screenshot: null,
        trace: { state: "off", decode: false, weakRows: null },
        guardStops: [{ site: "shop", rule: "status>=400", since: 9, reason: "fetch-stop", by: "w", request: "r-6" }],
        protection: [],
      },
    ]);
    expect(data["handoff"]).toEqual([]);
    expect(data["conflicts"]).toEqual([]);
    // no `trace` / `handoff` notice fields: it is not a session command
    expect(data["next"]).toBeNull();
    expect(Object.keys(data).sort()).toEqual(["browser", "conflicts", "daemon", "handoff", "next", "plugins", "schema", "sessions"]);
  });

  test("statusOf on an empty daemon: nothing listed", () => {
    const s = statusOf(daemon(), { running: true, pid: 1, version: "0", listener: "unix", socket: null, startedAt: 0 });
    expect(s.sessions).toEqual([]);
    expect(s.conflicts).toEqual([]);
    expect(s.plugins).toEqual({ decode: [], challenge: [] });
  });
});
