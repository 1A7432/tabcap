// `tabcap status` top-level `next` per waiting reason. Expected values: the
// guard's own advice for the same wait (src/daemon/guard.ts STOP_RULE_NEXT,
// docs/04 §18 0.6-I and §39: a stop-rule wait is decided after looking at the
// response, then `handoff continue` or `guard resume --site`), the §35 clause
// for a verify page and the §37 clause for a take-over; not tabcap's output.

import { describe, expect, test } from "bun:test";
import { conflictsOf, nextOf, STATUS_SCHEMA, type StatusFacts, type StatusGuardStop, type StatusSession } from "../../src/daemon/tools/status.ts";

const OFF = { state: "off" as const, decode: false, weakRows: null };

function sess(name: string, o: Partial<StatusSession> = {}): StatusSession {
  return { session: name, site: "shop", account: "alice", tabSite: null, tabs: 1, current: "t1", url: null, recording: null, state: "running", reason: null, screenshot: null, trace: OFF, guardStops: [], protection: [], ...o };
}

function facts(sessions: StatusSession[], o: Partial<StatusFacts> = {}): StatusFacts {
  return {
    schema: STATUS_SCHEMA,
    daemon: { running: true, pid: 42, version: "0", listener: "unix", socket: "/s", startedAt: 1 },
    browser: { running: true, pid: 7, mode: "direct", tabs: 1, webdriver: "hidden", extraArgs: [], dropArgs: [] },
    sessions,
    plugins: { decode: [], challenge: [] },
    handoff: [],
    ...o,
  };
}

const ruleStop = (o: Partial<StatusGuardStop> = {}): StatusGuardStop => ({ site: "shop", rule: "status>=400", since: 5, reason: "stop-rule", by: "w", request: "r-6", ...o });

const next = (f: StatusFacts): string => nextOf(f, conflictsOf(f)) ?? "";

describe("status next for a waiting session, by reason", () => {
  test("stop-rule: look at the response first, then handoff continue or guard resume --site (the guard's own advice), not 'after they finished in the browser'", () => {
    const f = facts([sess("w", { state: "waiting", reason: "stop-rule", screenshot: "/shots/w.png", guardStops: [ruleStop()] })], {
      handoff: [{ session: "w", reason: "stop-rule", site: "shop", url: "https://shop.test/api", since: 5, screenshot: "/shots/w.png" }],
    });
    const n = next(f);
    expect(n).toContain("`tabcap net body r-6 --session w`");
    expect(n).toContain("`tabcap handoff continue --session w`");
    expect(n).toContain("`tabcap guard resume --site shop`");
    expect(n).toContain("status>=400");
    expect(n).not.toContain("after they finished in the browser");
    expect(n).not.toContain("tell the user");
  });

  test("stop-rule without its stop listed (lifted meanwhile): r-N placeholder, the handoff's site for guard resume", () => {
    const f = facts([sess("w", { state: "waiting", reason: "stop-rule" })], { handoff: [{ session: "w", reason: "stop-rule", site: "shop", url: "https://shop.test/api", since: 5, screenshot: null }] });
    const n = next(f);
    expect(n).toContain("`tabcap net body <r-N> --session w`");
    expect(n).toContain("`tabcap guard resume --site shop`");
    // no site at all: no guard resume clause (STOP_RULE_NEXT with site null)
    expect(next(facts([sess("w", { state: "waiting", reason: "stop-rule" })]))).not.toContain("guard resume");
  });

  test("stop-rule: a stop another session set off on the same site is not taken for this session's request", () => {
    const f = facts([sess("w", { state: "waiting", reason: "stop-rule", guardStops: [ruleStop({ by: "other", request: "r-99", site: "other-site" }), ruleStop()] })]);
    const n = next(f);
    expect(n).toContain("net body r-6 --session w");
    expect(n).not.toContain("r-99");
  });

  test("verify-page keeps the docs/04 §35 clause; human-takeover keeps the §37 clause", () => {
    const v = next(facts([sess("w", { state: "waiting", reason: "verify-page", screenshot: "/shots/w.png" })]));
    expect(v).toBe('session "w" waits for the human (verify-page): tell the user (screenshot /shots/w.png); after they finished in the browser: `tabcap handoff continue --session w`');
    const t = next(facts([sess("h", { state: "waiting", reason: "human-takeover" })]));
    expect(t).toBe('session "h": the user took over its tab (human-takeover); do not act on the page; when they say they are done: `tabcap handoff continue --session h`');
  });

  test("several waiting sessions: one clause each, joined with '; '", () => {
    const f = facts([sess("a", { state: "waiting", reason: "verify-page" }), sess("b", { state: "waiting", reason: "stop-rule", guardStops: [ruleStop({ by: "b", request: "r-3" })] })]);
    const parts = next(f).split("; session ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("tabcap handoff continue --session a");
    expect(parts[1]).toContain("net body r-3 --session b");
  });
});
