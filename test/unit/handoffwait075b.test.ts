// 0.7.5-B `tabcap handoff wait --until-*` (owner 10-20, docs/04 §39): the
// argument parsing, the "seen false first" rule over the baseline and the
// rounds, the guard's baseline read and the `condition` on resume, and the
// daemon answers that need no browser. The loop against a real page is the
// e2e test/e2e/v075b.e2e.test.ts (range s65). Oracle: the owner's rule
// ("代理事先设好、客观可查的条件满足了也算") and docs/04 §39.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_NEXT, Guard, TAKEOVER_NEXT, handoffView, type HandoffBaseline } from "../../src/daemon/guard.ts";
import { handleCommand } from "../../src/daemon/main.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { HANDOFF_WAIT_DEFAULT_MS, baselineFalse, decideRound, handoffWaitTimeout, parseUntil, type Until } from "../../src/daemon/tools/handoffwait.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FakeRec as BaseRec } from "./_fakes.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tabcap-075b-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `not a TabcapError: ${String(e)}`;
  }
};

class FakeRec extends BaseRec {
  constructor(session: string) {
    super(session, { indexed: "empty" });
  }
}

function guard(baseline?: (session: string, tab: string) => Promise<HandoffBaseline>): Guard {
  return new Guard({
    configDir: join(tmp(), "config"),
    secrets: new Secrets(),
    siteOf: () => null,
    screenshot: () => Promise.resolve(null),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
    ...(baseline === undefined ? {} : { baseline }),
  });
}

const u = (kind: Until["kind"], value: string): Until => ({ kind, value, key: `${kind}:${value}` });

describe("arguments", () => {
  test("--until-* in flag order (url, text, selector, cookie); empty is usage; none is fine (wait for the human)", () => {
    expect(parseUntil({ untilCookie: "sid", untilUrl: "/home" })).toEqual([u("url", "/home"), u("cookie", "sid")]);
    expect(parseUntil({})).toEqual([]);
    for (const k of ["untilUrl", "untilText", "untilSelector", "untilCookie"]) expect(codeOf(() => parseUntil({ [k]: "" }))).toBe("usage");
  });

  test("--timeout: default 60 s, clamped to 100 ms … 600 s", () => {
    expect(handoffWaitTimeout({})).toBe(HANDOFF_WAIT_DEFAULT_MS);
    expect(handoffWaitTimeout({ timeoutMs: 5 })).toBe(100);
    expect(handoffWaitTimeout({ timeoutMs: 9_000_000 })).toBe(600_000);
    expect(handoffWaitTimeout({ timeoutMs: 1234.4 })).toBe(1234);
  });
});

describe("seen false first (pure)", () => {
  test("the baseline counts as seen false for URL and cookie only, and only when it was readable", () => {
    const conds = [u("url", "/home"), u("cookie", "sid"), u("text", "Welcome"), u("selector", "#me")];
    expect(baselineFalse(conds, { url: "http://x.test/login", cookies: ["other"] })).toEqual(["url:/home", "cookie:sid"]);
    expect(baselineFalse(conds, { url: "http://x.test/home?next=1", cookies: ["sid"] })).toEqual([]); // already there when it began
    expect(baselineFalse(conds, { url: null, cookies: null })).toEqual([]);
    expect(baselineFalse(conds, undefined)).toEqual([]);
  });

  test("a condition fires only after it was seen false; all already true on the first round cannot prove anything", () => {
    const text = u("text", "Welcome");
    const url = u("url", "/home");
    const seen = new Set<string>();
    expect(decideRound([text], [true], seen, true)).toEqual({ fired: null, allAlready: true });
    expect(decideRound([text], [true], seen, false)).toEqual({ fired: null, allAlready: false }); // later rounds: keep waiting
    expect(decideRound([text], [false], seen, false)).toEqual({ fired: null, allAlready: false });
    expect(decideRound([text], [true], seen, false)).toEqual({ fired: text, allAlready: false });
    // one already true, another still false: wait for the other; unknown (null) is neither
    const s2 = new Set<string>();
    expect(decideRound([text, url], [true, false], s2, true)).toEqual({ fired: null, allAlready: false });
    expect(decideRound([text, url], [true, null], s2, false)).toEqual({ fired: null, allAlready: false });
    expect(decideRound([text, url], [true, true], s2, false)).toEqual({ fired: url, allAlready: false });
    // the baseline seeded it: true at once fires
    expect(decideRound([url], [true], new Set(["url:/home"]), true)).toEqual({ fired: url, allAlready: false });
    // no conditions: nothing to decide
    expect(decideRound([], [], new Set(), true)).toEqual({ fired: null, allAlready: false });
  });
});

describe("guard: baseline and condition", () => {
  test("a take-over reads the baseline of its tab; resume by a condition records it on the event and the view", async () => {
    const asked: string[] = [];
    const g = guard((s, tab) => {
      asked.push(`${s}/${tab}`);
      return Promise.resolve({ url: "http://x.test/login", cookies: ["pre"] });
    });
    const rec = new FakeRec("w");
    g.recorder = () => rec;
    const h = g.takeover("w", { tab: "t3", url: "http://x.test/login", event: "pointerdown", at: 1 }, rec);
    await h.started;
    expect(asked).toEqual(["w/t3"]);
    expect(h.start).toEqual({ url: "http://x.test/login", cookies: ["pre"] });
    g.resume("w", "condition", null, { kind: "url", value: "/home" });
    expect(rec.events.at(-1)).toEqual({ kind: "handoff", state: "resumed", reason: "human-takeover", question: null, timeoutMs: null, answerRef: null, by: "condition", condition: { kind: "url", value: "/home" } });
    expect(handoffView(h)).toMatchObject({ state: "resumed", resumedBy: "condition", condition: { kind: "url", value: "/home" }, next: "Go on." });
  });

  test("a verify page reads it too; a failing read leaves an unreadable baseline (nothing is seeded)", async () => {
    const g = guard(() => Promise.reject(new Error("tab gone")));
    const rec = new FakeRec("v");
    g.watch(rec);
    rec.emit({ id: "r-1", tab: "t1", type: "document", method: "GET", url: "http://x.test/verify", status: 403, mime: "text/html", size: 10, outcome: "finished", blob: null, bodyMissing: null, cmd: null, at: 0 });
    const h = g.get("v");
    expect(h?.reason).toBe("verify-page");
    await h?.started;
    expect(h?.start).toEqual({ url: null, cookies: null });
    await g.settle();
  });

  test("the waiting hints name handoff wait as the other way out", () => {
    expect(CONTINUE_NEXT("default")).toContain("tabcap handoff wait --until-url");
    expect(CONTINUE_NEXT("default")).toContain("tabcap handoff continue");
    expect(TAKEOVER_NEXT("default")).toContain("tabcap handoff wait --until-url");
  });
});

describe("daemon answers (no browser)", () => {
  const daemon = () => new Daemon(paths({ TABCAP_HOME: tmp() }));
  const run = (d: Daemon, args: Record<string, unknown>, session = "a") => handleCommand(d, { action: "handoff.wait", args, session }, () => undefined);
  const data = (env: Awaited<ReturnType<typeof handleCommand>>): Record<string, unknown> => (env.ok && isRecord(env.data) ? env.data : {});
  const err = (env: Awaited<ReturnType<typeof handleCommand>>): Record<string, unknown> => (env.ok ? {} : env.error);

  test("not waiting: answers the state at once", async () => {
    const d = daemon();
    expect(data(await run(d, { untilUrl: "/home" }))).toEqual({ session: "a", state: "running", handoff: null });
  });

  test("a stop-rule wait refuses --until-* (that needs a decision); without them it waits for the human", async () => {
    const d = daemon();
    const rec = new FakeRec("a");
    d.guard.recorder = () => rec;
    // a stop-rule handoff, as the guard's site rule check leaves it
    d.guard.takeover("a", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    const h = d.guard.get("a");
    if (h === null) throw new Error("no handoff");
    h.reason = "stop-rule";
    h.request = "r-9";
    const e = err(await run(d, { untilUrl: "/home" }));
    expect(e).toMatchObject({ code: "usage" });
    expect(String(e["next"])).toContain("tabcap net body r-9");
    const t0 = Date.now();
    const timedOut = err(await run(d, { timeoutMs: 150 }));
    expect(timedOut).toMatchObject({ code: "waiting", state: "waiting", reason: "stop-rule" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(String(timedOut["next"])).toContain("tabcap handoff wait");
  });

  test("without --until-*: returns as soon as the human continues elsewhere", async () => {
    const d = daemon();
    d.guard.takeover("a", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    const waiting = run(d, { timeoutMs: 5000 });
    setTimeout(() => d.guard.resume("a", "human"), 50);
    const t0 = Date.now();
    expect(data(await waiting)).toMatchObject({ session: "a", state: "resumed", by: "human" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("--until-* needs the browser: not-running, the session keeps waiting", async () => {
    const d = daemon();
    d.guard.takeover("a", { tab: "t1", url: "u", event: "pointerdown", at: 1 }, undefined);
    expect(err(await run(d, { untilCookie: "sid", timeoutMs: 100 }))).toMatchObject({ code: "not-running" });
    expect(d.guard.isWaiting("a")).toBe(true);
  });
});
