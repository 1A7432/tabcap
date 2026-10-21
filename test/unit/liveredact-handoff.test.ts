// Live output redaction (docs/04 §8.3) on the hand-off surfaces (review
// 2026-10-21, owner: all as proposed): handoff status / wait and the
// `waiting` / `guard.stopped` errors (handoffView and their message text),
// `tabcap status` (handoff[].url; the session url and the --text WAITING line
// read the same field) and the rule detail of a json: stop / end rule. URLs by
// the §8.3 query rule; a json: rule's detail shows `<redacted:name>` when the
// path's last name is sensitive. The bundle keeps what was recorded.
// Oracle: the §8 name rule (isSensitiveName) as docs/04 §8 states it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffView, waitingError, type Handoff } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { handoffStatus } from "../../src/daemon/tools/handoff.ts";
import { redactRuleDetail } from "../../src/daemon/tools/liveredact.ts";
import { renderStatusText, statusOf } from "../../src/daemon/tools/status.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";

const SECRET = "tok-LIVE-77";
const RAW = `https://shop.example/cb?access_token=${SECRET}&lang=zh`;
const SHOWN = "https://shop.example/cb?access_token=<redacted:access_token>&lang=zh";
const plain = { scrub: (s: string) => s };
const store = new Secrets();
store.setStored([{ ref: "example.password", value: "St0re-pa55" }]);
const withStore = { scrub: (s: string) => store.scrub(s) };

const handoff = (o: Partial<Handoff> = {}): Handoff => ({
  session: "w",
  state: "waiting",
  reason: "verify-page",
  site: "shop",
  origin: "https://shop.example",
  url: RAW,
  status: 403,
  request: "r-3",
  tab: "t1",
  since: 1,
  screenshot: null,
  handlers: [],
  resumedAt: null,
  resumedBy: null,
  delivered: false,
  ...o,
});

describe("rule detail (stoprules.ts firstStop)", () => {
  test("a json: detail shows <redacted:name> when the path's last name is sensitive; other details as they are", () => {
    expect(redactRuleDetail('$.data.token is "abc123"', plain)).toBe("$.data.token is <redacted:token>");
    expect(redactRuleDetail("$.items[0].sid is 7", plain)).toBe("$.items[0].sid is <redacted:sid>");
    expect(redactRuleDetail('$.tokens[2] is "x"', plain)).toBe("$.tokens[2] is <redacted:tokens>");
    expect(redactRuleDetail('$.auth is {"a":1}', plain)).toBe("$.auth is <redacted:auth>");
    expect(redactRuleDetail('$.password is "St0re-pa55"', withStore)).toBe("$.password is <secret:example.password>");
    for (const same of ["$.code is 1", '$.data.ticket is "ST-1"', "$.token is no value", "status 403", "the body is empty", "the body matches at character 3", "HTTP 403"]) expect(redactRuleDetail(same, plain)).toBe(same);
  });
});

describe("handoffView and the waiting / guard.stopped errors", () => {
  test("verify-page: the view's url and the message text by the query rule", () => {
    const h = handoff();
    expect(handoffView(h)["url"]).toBe(SHOWN);
    const e = waitingError(h);
    expect(e.code).toBe("waiting");
    expect(e.message).toContain(`at ${SHOWN}`);
    expect(JSON.stringify([e.message, e.extra])).not.toContain(SECRET);
    expect(h.url).toBe(RAW);
  });

  test("human take-over: the message names the redacted URL", () => {
    const e = waitingError(handoff({ reason: "human-takeover", input: { event: "pointerdown", at: 5 }, request: null, status: null }));
    expect(e.message).toContain(`(pointerdown at ${SHOWN})`);
    expect(JSON.stringify([e.message, e.extra])).not.toContain(SECRET);
  });

  test("stop-rule: the view's detail and the guard.stopped message hide a sensitive json: value", () => {
    const h = handoff({ reason: "stop-rule", rule: "json:$.auth.token!=x", ruleDetail: '$.auth.token is "abc123secret"' });
    expect(handoffView(h)).toMatchObject({ url: SHOWN, rule: "json:$.auth.token!=x", detail: "$.auth.token is <redacted:token>" });
    const e = waitingError(h);
    expect(e.code).toBe("guard.stopped");
    expect(e.message).toContain("($.auth.token is <redacted:token>)");
    expect(JSON.stringify([e.message, e.extra])).not.toContain("abc123secret");
    expect(h.ruleDetail).toBe('$.auth.token is "abc123secret"');
  });
});

describe("status and handoff status (daemon, no browser)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const daemon = () => {
    const root = mkdtempSync(join(tmpdir(), "tabcap-lrh-"));
    roots.push(root);
    return new Daemon(paths({ TABCAP_HOME: root }));
  };

  test("status: handoff[].url redacted; the --text rendering carries no secret", () => {
    const d = daemon();
    d.guard.takeover("w", { tab: "t1", url: RAW, event: "pointerdown", at: 1 }, undefined);
    const s = statusOf(d, { running: true, pid: 1, version: "0", listener: "unix", socket: null, startedAt: 0 });
    expect(s.handoff.map((h) => h.url)).toEqual([SHOWN]);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(renderStatusText(s)).not.toContain(SECRET);
  });

  test("handoff status: the session's handoff and the others' url redacted", async () => {
    const d = daemon();
    d.guard.takeover("w", { tab: "t1", url: RAW, event: "pointerdown", at: 1 }, undefined);
    d.guard.takeover("v", { tab: "t2", url: RAW, event: "keydown", at: 2 }, undefined);
    const out = await handoffStatus(d, {}, "v");
    expect(isRecord(out) && isRecord(out["handoff"]) ? out["handoff"]["url"] : null).toBe(SHOWN);
    expect(isRecord(out) && Array.isArray(out["others"]) ? out["others"].map((x: unknown) => (isRecord(x) ? x["url"] : null)) : null).toEqual([SHOWN]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});
