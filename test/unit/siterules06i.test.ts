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
import { Guard, bodyFacts, nextNon200, ruleSubject, waitingError, type GuardRecorder } from "../../src/daemon/guard.ts";
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
  emit(e: NetEntry): NetEntry {
    for (const f of this.fns) f(e, { response: { charset: "utf-8" } });
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
function guard(stopOn: string[], consecutiveNon200: number | null, blobs: Record<string, string> = {}) {
  const g = new Guard({
    configDir: join(root, "config"),
    secrets: new Secrets(),
    siteOf: () => ({ site: "example", account: "alice" }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
    siteRules: (_s, url) => (url.startsWith(SITE_URL) ? { site: "example", rules: parseStopRules(stopOn), consecutiveNon200 } : null),
    readBlob: (_s, blob) => (blob in blobs ? new TextEncoder().encode(blobs[blob]) : null),
  });
  const rec = new FakeRec("ex");
  g.recorder = () => rec;
  g.watch(rec);
  return { g, rec };
}

describe("site stop rules: pure parts (0.6-I)", () => {
  test("the counter: +1 on anything but 2xx, back to 0 on any 2xx", () => {
    expect(nextNon200(0, 500)).toBe(1);
    expect(nextNon200(1, 404)).toBe(2);
    expect(nextNon200(2, 302)).toBe(3);
    expect(nextNon200(2, 200)).toBe(0);
    expect(nextNon200(2, 204)).toBe(0);
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
    expect(parseSiteGuard(undefined, "example")).toEqual({ stopOn: [], consecutiveNon200: null });
    expect(parseSiteGuard({ stopOn: ["empty-body"], consecutiveNon200: 3 }, "example")).toEqual({ stopOn: ["empty-body"], consecutiveNon200: 3 });
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
    expect(rec.events[0]).toMatchObject({ reason: "stop-rule", rule: "consecutiveNon200:3", detail: { detail: "3 responses in a row were not 2xx (last: status 503)" } });
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
