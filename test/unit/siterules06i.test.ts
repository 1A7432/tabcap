// 0.6-I site-wide stop rules (owner design 10-16): config.json
// `sites.<name>.guard.stopOn` (the `tabcap fetch --stop-on` syntax) and
// `guard.consecutiveNon200: N`, checked by the guard on every recorded
// response of the site. Oracle: the owner's rule text (empty body, business
// codes, N consecutive non-200 → stop and hand over), the rule syntax of
// docs/04 §26, and the response stream each test feeds in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { parseStopRules } from "../../src/daemon/fetch/stoprules.ts";
import { Guard, bodyFacts, insertArrival, ruleSubject, waitingError, type ArrivalMark, type GuardRecorder } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { allSiteRules } from "../../src/daemon/siterules.ts";
import { parseSiteGuard, siteGuardsFrom } from "../../src/shared/config.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-06i-guard-"));
  mkdirSync(join(root, "config", "plugins"), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SITE_URL = "http://127.0.0.1:9";
let seq = 0;
function entry(o: Partial<NetEntry>): NetEntry {
  seq++;
  return { id: `r-${seq}`, tab: "tab-1", type: "xhr", method: "GET", url: `${SITE_URL}/api/list`, status: 200, mime: "application/json", size: 2, outcome: "finished", blob: null, bodyMissing: null, cmd: null, at: 0, ...o };
}

class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  private fns = new Set<(e: NetEntry, ev?: Record<string, unknown>) => void>();
  private n = 0;
  constructor(readonly session: string) {}
  onIndexed(fn: (e: NetEntry, ev?: Record<string, unknown>) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  /** `end`: the response's completion (CDP mono ms) as the recorded event's `timing.end`; default: one more than the last. */
  private clock = 0;
  emit(e: NetEntry, end?: number): NetEntry {
    this.clock = end ?? this.clock + 1;
    for (const f of this.fns) f(e, { response: { charset: "utf-8" }, timing: { start: this.clock - 0.5, responseStart: this.clock - 0.2, end: this.clock } });
    return e;
  }
  event(kind: "guard" | "handoff", fields: Record<string, unknown>): number | null {
    this.events.push({ kind, ...fields });
    return ++this.n;
  }
  cmdStart(): string | null {
    return `c-${++this.n}`;
  }
  cmdEnd(): void {}
}

/** A guard whose site `example` covers SITE_URL with the given rules; blobs are bodies by name. */
function guard(stopOn: string[], consecutiveNon200: number | null, blobs: Record<string, string> = {}, endOn: string[] = []) {
  const g = new Guard({
    configDir: join(root, "config"),
    secrets: new Secrets(),
    siteOf: () => ({ site: "example", account: "alice" }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
    siteRules: (_s, url) => (url.startsWith(SITE_URL) ? { site: "example", rules: parseStopRules(stopOn), consecutiveNon200, endRules: parseStopRules(endOn) } : null),
    readBlob: (_s, blob) => (blob in blobs ? new TextEncoder().encode(blobs[blob]) : null),
  });
  const rec = new FakeRec("ex");
  g.recorder = () => rec;
  g.watch(rec);
  return { g, rec };
}

describe("site stop rules: pure parts (0.6-I)", () => {
  test("the counter: the run of non-2xx (by arrival) that contains the new response; any 2xx breaks it", () => {
    const seq: ArrivalMark[] = [];
    expect(insertArrival(seq, { mono: 10, bad: true })).toBe(1);
    expect(insertArrival(seq, { mono: 20, bad: true })).toBe(2);
    expect(insertArrival(seq, { mono: 30, bad: false })).toBe(0); // e.g. 200 or 204
    expect(insertArrival(seq, { mono: 40, bad: true })).toBe(1);
    // written late but arrived before the 2xx: joins the run before it
    expect(insertArrival(seq, { mono: 25, bad: true })).toBe(3);
    // arrived between two non-2xx runs where a 2xx was: still split by that 2xx
    expect(insertArrival(seq, { mono: 35, bad: true })).toBe(2);
    expect(seq.map((m) => m.mono)).toEqual([10, 20, 25, 30, 35, 40]);
    // unknown time goes last
    expect(insertArrival(seq, { mono: null, bad: true })).toBe(3);
  });

  test("subjects: final document / xhr / fetch responses; not static, script, redirect hops or failed requests", () => {
    expect(ruleSubject({ type: "xhr", status: 200, bodyMissing: null })).toBe(true);
    expect(ruleSubject({ type: "fetch", status: 500, bodyMissing: null })).toBe(true);
    expect(ruleSubject({ type: "document", status: 404, bodyMissing: null })).toBe(true);
    expect(ruleSubject({ type: "script", status: 500, bodyMissing: null })).toBe(false);
    expect(ruleSubject({ type: "image", status: 404, bodyMissing: null })).toBe(false);
    expect(ruleSubject({ type: "other", status: 204, bodyMissing: null })).toBe(false); // CORS preflights are "other"
    expect(ruleSubject({ type: "document", status: 302, bodyMissing: "redirect" })).toBe(false);
    expect(ruleSubject({ type: "xhr", status: null, bodyMissing: "failed" })).toBe(false);
  });

  test("body facts: unknown when skipped by --bodies, not finished, or gone; empty for 204 / 304", () => {
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    const bytes = new TextEncoder().encode('{"code":0}');
    expect(bodyFacts({ outcome: "finished", blob: "b", bodyMissing: null }, bytes, dec)).toEqual({ bytes: 10, text: '{"code":0}' });
    expect(bodyFacts({ outcome: "finished", blob: null, bodyMissing: null, bodySkipped: "resource-type" }, null, dec)).toBeNull();
    expect(bodyFacts({ outcome: "incomplete", blob: "b", bodyMissing: null }, bytes, dec)).toBeNull();
    expect(bodyFacts({ outcome: "finished", blob: null, bodyMissing: "evicted" }, null, dec)).toBeNull();
    expect(bodyFacts({ outcome: "finished", blob: null, bodyMissing: "no-content" }, null, dec)).toEqual({ bytes: 0, text: "" });
    expect(bodyFacts({ outcome: "finished", blob: "gone", bodyMissing: null }, null, dec)).toBeNull();
  });

  test("config.json sites.<name>.guard: stopOn list and consecutiveNon200; wrong values are errors", () => {
    expect(parseSiteGuard(undefined, "example")).toEqual({ stopOn: [], consecutiveNon200: null, endOn: [] });
    expect(parseSiteGuard({ stopOn: ["empty-body"], consecutiveNon200: 3 }, "example")).toEqual({ stopOn: ["empty-body"], consecutiveNon200: 3, endOn: [] });
    expect(() => parseSiteGuard({ stopOn: "empty-body" }, "example")).toThrow(/sites\.example\.guard\.stopOn/);
    expect(() => parseSiteGuard({ consecutiveNon200: 0 }, "example")).toThrow(/consecutiveNon200/);
    expect(() => parseSiteGuard({ consecutiveNon200: 2.5 }, "example")).toThrow(/consecutiveNon200/);
    expect([...siteGuardsFrom({ sites: { a: { guard: { consecutiveNon200: 2 } }, b: { fetch: {} }, c: { guard: {} } } }).keys()]).toEqual(["a"]);
  });

  test("a bad rule in config.json is bad-input (net start refuses it); a good one parses", () => {
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ sites: { example: { guard: { stopOn: ["json:$.code!=0"], consecutiveNon200: 3 } } } }));
    const ok = allSiteRules(file).get("example");
    expect(ok?.rules.map((r) => r.src)).toEqual(["json:$.code!=0"]);
    expect(ok?.consecutiveNon200).toBe(3);
    writeFileSync(file, JSON.stringify({ sites: { example: { guard: { stopOn: ["status>400x"] } } }, pad: "changed size" }));
    let code = "";
    try {
      allSiteRules(file);
    } catch (e) {
      code = e instanceof TabcapError ? e.code : "other";
    }
    expect(code).toBe("bad-input");
  });
});

describe("site stop rules over the response stream (0.6-I)", () => {
  test("a business code trips: breaker {reason: stop-rule, rule, request}, waiting with screenshot, site fetches and page commands refused with guard.stopped", async () => {
    const { g, rec } = guard(["json:$.code!=0"], null, { ok: '{"code":0}', bad: '{"code":40301,"msg":"limited"}' });
    rec.emit(entry({ blob: "ok" }));
    expect(g.get("ex")).toBeNull();
    const bad = rec.emit(entry({ blob: "bad" }));
    expect(g.get("ex")?.state).toBe("waiting"); // synchronously
    rec.emit(entry({ blob: "bad" })); // no second trip while waiting
    await g.settle();
    expect(rec.events.map((e) => [e["kind"], e["event"] ?? e["state"]])).toEqual([
      ["guard", "breaker"],
      ["handoff", "waiting"],
    ]);
    expect(rec.events[0]).toMatchObject({ event: "breaker", site: "example", account: "alice", reason: "stop-rule", rule: "json:$.code!=0", request: bad.id, detail: { reason: "stop-rule", detail: "$.code is 40301" } });
    expect(rec.events[1]).toMatchObject({ state: "waiting", reason: "stop-rule", request: bad.id, screenshot: "/tmp/shot.png" });
    const blocked = g.blocking("ex", "click", null);
    expect(blocked?.reason).toBe("stop-rule");
    const err = blocked === null ? null : waitingError(blocked);
    expect(err?.code).toBe("guard.stopped");
    expect(err?.next).toContain("tabcap handoff continue");
    expect(err?.next).toContain("tabcap guard resume --site example");
    expect(g.blocking("ex", "fetch", null)?.request).toBe(bad.id);
    expect(g.fetchStopOf("example")).toMatchObject({ reason: "stop-rule", rule: "json:$.code!=0", request: bad.id, fetchId: null, session: "ex" });
    expect(g.stopRuleHit("ex", bad.id)).toEqual({ site: "example", rule: "json:$.code!=0", detail: "$.code is 40301" });
    expect(g.waitingNotice("ex")).toMatchObject({ reason: "stop-rule", screenshot: "/tmp/shot.png" });
    // handoff continue: the session resumes and the site's fetch stop is lifted with it
    g.resume("ex", "human");
    expect(g.fetchStopsBy("ex").map((s) => g.resumeFetch(s.site, "handoff-continue", rec).reason)).toEqual(["stop-rule"]);
    expect(g.fetchStopOf("example")).toBeNull();
    expect(g.blocking("ex", "click", null)).toBeNull();
    expect(rec.events.slice(2).map((e) => [e["kind"], e["state"] ?? e["event"], e["reason"]])).toEqual([
      ["handoff", "resumed", "stop-rule"],
      ["guard", "resume", "stop-rule"],
    ]);
  });

  test("consecutiveNon200: 3 trips on the third non-2xx in a row; a 2xx resets the counter", async () => {
    const { g, rec } = guard([], 3);
    rec.emit(entry({ status: 500 }));
    rec.emit(entry({ status: 404 }));
    rec.emit(entry({ status: 200 })); // reset
    rec.emit(entry({ status: 500 }));
    rec.emit(entry({ status: 500 }));
    expect(g.get("ex")).toBeNull();
    const third = rec.emit(entry({ status: 503 }));
    await g.settle();
    expect(g.get("ex")).toMatchObject({ state: "waiting", reason: "stop-rule", request: third.id, rule: "consecutiveNon200:3" });
    expect(rec.events[0]).toMatchObject({ reason: "stop-rule", rule: "consecutiveNon200:3", detail: { detail: "3 responses in a row (by arrival) were not 2xx (this one: status 503)" } });
  });

  test("counted by arrival, not by write order: a page response written 1 s late lands where it arrived (owner ruling 10-16)", async () => {
    // arrival: 200 @10, 500 @20 (page, unread: written last), 500 @30 (fetch, written first), 500 @40
    const { g, rec } = guard([], 3);
    rec.emit(entry({ status: 500, type: "fetch", fetchId: "c-9:f-1" }), 30);
    rec.emit(entry({ status: 200 }), 10);
    expect(g.get("ex")).toBeNull();
    const last = rec.emit(entry({ status: 500 }), 40); // write order 500, 200, 500: no run of 3 yet
    expect(g.get("ex")).toBeNull();
    const late = rec.emit(entry({ status: 500 }), 20); // arrived second: now 20, 30, 40 are three in a row
    await g.settle();
    expect(g.get("ex")).toMatchObject({ request: late.id, rule: "consecutiveNon200:3" });
    expect(g.stopRuleHit("ex", last.id)).toBeNull();
    // the reverse: in write order three 500s follow each other, by arrival a 200 (written first) sits between them
    const r2 = guard([], 3);
    r2.rec.emit(entry({ status: 200 }), 25);
    r2.rec.emit(entry({ status: 500 }), 10);
    r2.rec.emit(entry({ status: 500 }), 20);
    r2.rec.emit(entry({ status: 500 }), 30); // by arrival: 10 20 | 200 @25 | 30
    await r2.g.settle();
    expect(r2.g.get("ex")).toBeNull();
  });

  test("what does not count: other hosts, static resources, scripts, redirect hops, failed requests", async () => {
    const { g, rec } = guard(["status>=500"], 2);
    rec.emit(entry({ status: 500, url: "http://127.0.0.1:10/api/list" })); // not the site
    rec.emit(entry({ status: 500, type: "image" }));
    rec.emit(entry({ status: 500, type: "script" }));
    rec.emit(entry({ status: 302, type: "document", bodyMissing: "redirect" }));
    rec.emit(entry({ status: null, outcome: "failed", bodyMissing: "failed" }));
    await g.settle();
    expect(g.get("ex")).toBeNull();
    expect(rec.events).toEqual([]);
  });

  test("bodies the recording skipped (--bodies) or never got: body rules stay quiet, status rules still run", async () => {
    const { g, rec } = guard(["empty-body", "text:denied"], null);
    rec.emit(entry({ type: "document", bodySkipped: "resource-type" }));
    rec.emit(entry({ outcome: "incomplete", bodyMissing: "navigated" }));
    expect(g.get("ex")).toBeNull();
    const s = guard(["empty-body", "status>=500"], null);
    s.rec.emit(entry({ bodySkipped: "resource-type", status: 502 }));
    await s.g.settle();
    expect(s.g.get("ex")?.rule).toBe("status>=500");
  });

  test("empty-body trips on a 200 with an empty or blank body (a 204 counts as empty too)", async () => {
    const { g, rec } = guard(["empty-body"], null, { blank: "  \n" });
    rec.emit(entry({ blob: "blank" }));
    await g.settle();
    expect(g.get("ex")).toMatchObject({ rule: "empty-body", ruleDetail: "the body is only whitespace (3 bytes)" });
    const n = guard(["empty-body"], null);
    n.rec.emit(entry({ status: 204, bodyMissing: "no-content" }));
    expect(n.g.get("ex")?.rule).toBe("empty-body");
  });

  test("a fetch with its own --stop-on: the site's stopOn is skipped for its response, the counter still counts", async () => {
    const { g, rec } = guard(["status>=400"], 2);
    const release = g.overrideSiteRules("c-4:f-1");
    rec.emit(entry({ status: 404, type: "fetch", fetchId: "c-4:f-1" }));
    expect(g.get("ex")).toBeNull(); // stopOn overridden for this call
    release();
    const next = rec.emit(entry({ status: 404, type: "fetch", fetchId: "c-5:f-1" }));
    await g.settle();
    // the next call has no override: status>=400 fires first (the counter would have too)
    expect(g.get("ex")).toMatchObject({ request: next.id, rule: "status>=400" });
    expect(g.fetchStopOf("example")?.fetchId).toBe("c-5:f-1");
    expect(rec.events[0]).toMatchObject({ detail: { fetchId: "c-5:f-1" } });
  });
});

// 0.7.5-A (docs/04 §38): end rules. Oracle: the owner's case (10-20): stopOn
// json:$.code!=0, page 21 answered {"code":203} = "no more"; that ends the
// list, not the site.
describe("site end rules (0.7.5-A)", () => {
  test("config.json sites.<name>.guard.endOn: a list of rule strings; endOn alone is a guard setting; a bad rule is bad-input", () => {
    expect(parseSiteGuard({ endOn: ["json:$.code=203"] }, "example")).toEqual({ stopOn: [], consecutiveNon200: null, endOn: ["json:$.code=203"] });
    expect(() => parseSiteGuard({ endOn: "json:$.code=203" }, "example")).toThrow(/sites\.example\.guard\.endOn/);
    expect([...siteGuardsFrom({ sites: { a: { guard: { endOn: ["empty-body"] } } } }).keys()]).toEqual(["a"]);
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ sites: { example: { guard: { stopOn: ["json:$.code!=0"], endOn: ["json:$.code=203"] } } } }));
    expect(allSiteRules(file).get("example")?.endRules.map((r) => r.src)).toEqual(["json:$.code=203"]);
    writeFileSync(file, JSON.stringify({ sites: { example: { guard: { endOn: ["json:code=203"] } } } }));
    let msg = "";
    try {
      allSiteRules(file);
    } catch (e) {
      msg = e instanceof TabcapError ? `${e.code} ${e.message}` : "other";
    }
    expect(msg).toContain("bad-input");
    expect(msg).toContain("guard.endOn");
  });

  test("the owner's case: code 203 matches endOn first, nothing stops, one guard end event; a real error still trips", async () => {
    const { g, rec } = guard(["json:$.code!=0"], null, { ok: '{"code":0}', end: '{"code":203,"msg":"no more"}', bad: '{"code":500}' }, ["json:$.code=203"]);
    rec.emit(entry({ blob: "ok" }));
    const end = rec.emit(entry({ blob: "end", type: "fetch", fetchId: "c-3:f-1" }));
    await g.settle();
    expect(g.get("ex")).toBeNull();
    expect(g.fetchStopOf("example")).toBeNull();
    expect(g.endHit("ex", end.id)).toEqual({ site: "example", rule: "json:$.code=203", detail: "$.code is 203" });
    expect(rec.events).toEqual([
      {
        kind: "guard",
        event: "end",
        site: "example",
        account: null,
        rule: "json:$.code=203",
        request: end.id,
        detail: { rule: "json:$.code=203", detail: "$.code is 203", request: end.id, url: `${SITE_URL}/api/list`, status: 200, fetchId: "c-3:f-1" },
      },
    ]);
    // the fetch that sent it notes the same hit again: still one event
    g.noteEnd(rec, "ex", { site: "example", request: end.id, url: `${SITE_URL}/api/list`, status: 200, tab: "tab-1", fetchId: "c-3:f-1" }, { rule: "json:$.code=203", detail: "$.code is 203" });
    expect(rec.events.length).toBe(1);
    const bad = rec.emit(entry({ blob: "bad" }));
    await g.settle();
    expect(g.get("ex")).toMatchObject({ state: "waiting", reason: "stop-rule", request: bad.id });
  });

  test("an end response counts as a normal answer for consecutiveNon200 (resets the run, whatever its status)", async () => {
    const { g, rec } = guard([], 2, {}, ["status=404"]);
    rec.emit(entry({ status: 500 }));
    rec.emit(entry({ status: 404 })); // end: resets
    rec.emit(entry({ status: 500 }));
    await g.settle();
    expect(g.get("ex")).toBeNull();
    const second = rec.emit(entry({ status: 502 }));
    await g.settle();
    expect(g.get("ex")).toMatchObject({ request: second.id, rule: "consecutiveNon200:2" });
  });

  test("a fetch's own --end-on joins the site's endOn for that fetch only; body end rules wait for a known body", async () => {
    const { g, rec } = guard(["status>=400"], null, {}, []);
    const release = g.fetchEndRules("c-4:f-1", parseStopRules(["status=410"]));
    const mine = rec.emit(entry({ status: 410, type: "fetch", fetchId: "c-4:f-1" }));
    expect(g.get("ex")).toBeNull();
    expect(g.endHit("ex", mine.id)?.rule).toBe("status=410");
    release();
    const other = rec.emit(entry({ status: 410, type: "fetch", fetchId: "c-5:f-1" }));
    await g.settle();
    expect(g.get("ex")).toMatchObject({ request: other.id, rule: "status>=400" });
    const b = guard(["status>=500"], null, {}, ["empty-body"]);
    b.rec.emit(entry({ status: 503, bodySkipped: "resource-type" })); // body unknown: empty-body cannot end it
    await b.g.settle();
    expect(b.g.get("ex")?.rule).toBe("status>=500");
  });
});
