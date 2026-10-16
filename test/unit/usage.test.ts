// `bundle info --usage` (docs/04 §28). Expected values are computed by hand from the
// timestamps below (request start = mono = 1000 + ts - created), not from the implementation.

import { describe, expect, test } from "bun:test";
import { BundleReader } from "../../src/bundle/reader.ts";
import { parseBusinessRule, renderUsageText, usageReport } from "../../src/bundle/usage.ts";
import { run } from "../../src/cli/main.ts";
import { buildBundle, tmp } from "./_analyze.ts";

const T0 = 1_760_500_000_000;
const A = "http://a.example:4310";
const B = "http://b.example:4310";
const json = (o: unknown): string => JSON.stringify(o);

async function fixture(): Promise<string> {
  const dir = tmp("tabcap-usage-");
  await buildBundle(dir, { name: "u1", created: T0, seed: 7 }, async (b) => {
    // host A starts at +0, +400, +500, +3500 ms: min 100, mean 3500/3, three starts within 1 s
    await b.request({ url: `${A}/api/1`, ts: T0 + 0, mime: "application/json", body: json({ code: 0, data: [1] }) });
    await b.request({ url: `${A}/api/2`, ts: T0 + 400, mime: "application/json", body: json({ code: 1001, msg: "x" }) });
    await b.request({ url: `${A}/api/3`, method: "POST", ts: T0 + 500, mime: "application/json", body: json({ data: 1 }) }); // no code
    await b.request({ url: `${A}/api/4`, ts: T0 + 3500, status: 200, mime: "application/json", body: "  \n" }); // whitespace only
    // host B at +1000, +1200, +1300, +700000
    await b.request({ url: `${B}/e`, ts: T0 + 1000, status: 200 }); // no body, nothing said why: empty
    await b.request({ url: `${B}/n`, ts: T0 + 1200, status: 204, bodyMissing: "no-content" }); // empty
    await b.request({ url: `${B}/r`, ts: T0 + 1300, status: 302, bodyMissing: "redirect" }); // not empty
    await b.request({ url: `${B}/t`, ts: T0 + 700_000, status: 403, mime: "text/html", body: "<html>no</html>" });
    const g = { actor: "ai" as const, mono: null, tab: null, cmd: null, kind: "guard" };
    b.w.append({ ...g, ts: T0 + 10, event: "budget", site: "example", account: "alice", detail: { rule: "login-limit", attempts: 0, limit: 1, decision: "allowed" } });
    b.w.append({ ...g, ts: T0 + 20, event: "budget", site: "example", account: "alice", detail: { rule: "login-limit", attempts: 1, limit: 1, decision: "refused" } });
    b.w.append({ ...g, ts: T0 + 30, event: "budget", site: "example", account: "bob", detail: { rule: "login-limit", attempts: 1, limit: 1, decision: "confirmed" } });
    b.w.append({ ...g, ts: T0 + 40, event: "budget", site: "example", account: "bob", detail: { rule: "failed-logins", failures: 2, limit: 2, decision: "needs-human" } });
    b.w.append({ ...g, ts: T0 + 50, event: "breaker", site: "example", account: "bob", reason: "fetch-stop", rule: "empty-body", request: "r-9", detail: { reason: "fetch-stop" } });
  });
  return dir;
}

describe("usageReport", () => {
  test("hosts: counts, intervals, burst, statuses, empty bodies, bytes", async () => {
    const dir = await fixture();
    const u = usageReport(BundleReader.open(dir), dir, []);
    expect(u.schema).toBe("tabcap-usage/0");
    expect(u.hosts.map((h) => h.host).sort()).toEqual(["a.example:4310", "b.example:4310"]);
    const a = u.hosts.find((h) => h.host === "a.example:4310");
    expect(a?.requests).toBe(4);
    expect(a?.byMethod).toEqual({ GET: 3, POST: 1 });
    expect(a?.minIntervalMs).toBe(100);
    expect(a?.meanIntervalMs).toBe(1166.667);
    expect(a?.maxBurst1s).toBe(3);
    expect(a?.statuses).toEqual({ "200": 4 });
    expect(a?.emptyBodies).toBe(1);
    expect(a?.bytesIn).toBe(json({ code: 0, data: [1] }).length + json({ code: 1001, msg: "x" }).length + json({ data: 1 }).length + 3);
    expect(a?.firstMono).toBe(1000);
    expect(a?.lastMono).toBe(4500);
    const b = u.hosts.find((h) => h.host === "b.example:4310");
    expect(b?.requests).toBe(4);
    expect(b?.minIntervalMs).toBe(100);
    expect(b?.maxBurst1s).toBe(3);
    expect(b?.statuses).toEqual({ "200": 1, "204": 1, "302": 1, "403": 1 });
    expect(b?.emptyBodies).toBe(2);
  });

  test("business codes: anything but the ok value counts (a missing path too), JSON bodies only", async () => {
    const dir = await fixture();
    const one = usageReport(BundleReader.open(dir), dir, [parseBusinessRule("$.code=0")]);
    const a = one.hosts.find((h) => h.host === "a.example:4310");
    expect(a?.businessErrors).toBe(2); // code 1001; no code at all. The whitespace body is not JSON.
    expect(one.hosts.find((h) => h.host === "b.example:4310")?.businessErrors).toBe(0);
    expect(one.businessRules).toEqual(["$.code=0"]);
    const two = usageReport(BundleReader.open(dir), dir, [parseBusinessRule("$.code=0"), parseBusinessRule("$.data=1")]);
    expect(two.hosts.find((h) => h.host === "a.example:4310")?.businessErrors).toBe(3); // r1 fails $.data=1, r2 and r3 fail one rule each
  });

  test("logins per account, guard events, stops, windows", async () => {
    const dir = await fixture();
    const u = usageReport(BundleReader.open(dir), dir, []);
    expect(u.logins.attempts).toBe(2); // alice allowed, bob confirmed; the refused one is no attempt
    expect(u.logins.byAccount).toEqual({ alice: 1, bob: 1 });
    expect(u.logins.guardEvents.length).toBe(5);
    expect(u.logins.guardEvents[1]).toMatchObject({ event: "budget", rule: "login-limit", decision: "refused", account: "alice" });
    expect(u.stops).toEqual([{ kind: "fetch-stop", request: "r-9", rule: "empty-body" }]);
    // 7 requests within 3.5 s share a bucket (or straddle one boundary), the one at +700 s is in a later bucket
    expect(u.windows.reduce((n, w) => n + w.requests, 0)).toBe(8);
    expect(u.windows.length).toBeGreaterThanOrEqual(2);
    for (const w of u.windows) {
      expect(w.to).toBe(w.from + 600_000);
      expect(w.from % 600_000).toBe(0);
    }
  });

  test("counts and names only: no path, status text or body value in the report", async () => {
    const dir = await fixture();
    const text = JSON.stringify(usageReport(BundleReader.open(dir), dir, [parseBusinessRule("$.code=0")]));
    expect(text).not.toContain("/api/");
    expect(text).not.toContain("1001");
    expect(text).not.toContain("</html>");
  });

  test("an empty bundle gives an empty report", async () => {
    const dir = tmp("tabcap-usage-");
    await buildBundle(dir, { name: "empty", created: T0, seed: 8 }, async () => {});
    const u = usageReport(BundleReader.open(dir), dir, []);
    expect(u.hosts).toEqual([]);
    expect(u.logins.attempts).toBe(0);
    expect(u.windows).toEqual([]);
  });
});

describe("bundle info --usage (CLI)", () => {
  test("JSON, --text, repeatable --business-code; plain info unchanged", async () => {
    const dir = await fixture();
    const r = await run(["bundle", "info", dir, "--usage", "--business-code", "$.code=0", "--business-code=$.data=1"]);
    expect(r.code).toBe(0);
    const data = (r.envelope as unknown as { data: { schema: string; businessRules: string[] } }).data;
    expect(data.schema).toBe("tabcap-usage/0");
    expect(data.businessRules).toEqual(["$.code=0", "$.data=1"]);
    const t = await run(["bundle", "info", dir, "--usage", "--text"]);
    expect(t.text).toContain("a.example:4310");
    expect(t.text).toContain("logins 2");
    expect(renderUsageText(usageReport(BundleReader.open(dir), dir, [])).split("\n").length).toBeLessThan(30);
    const plain = (await run(["bundle", "info", dir])).envelope as unknown as { data: Record<string, unknown> };
    expect(plain.data["kinds"]).toBeDefined();
    expect(plain.data["schema"]).toBeUndefined();
  });

  test("bad rules and stray flags are usage errors", async () => {
    const dir = await fixture();
    expect((await run(["bundle", "info", dir, "--usage", "--business-code", "code"])).code).toBe(2);
    expect((await run(["bundle", "info", dir, "--usage", "--business-code", "code.x=1"])).code).toBe(2);
    expect((await run(["bundle", "info", dir, "--text"])).code).toBe(2);
  });
});
