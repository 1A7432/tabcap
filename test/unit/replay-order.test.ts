// 0.9-E `replay serve --order strict` (docs/04 §49). Expected values come
// from hand-built sequences whose longest common subsequence is unique (or,
// for the tie-break test, from the rule "the earlier expected item is matched
// first"), the builder's ids, and the §49 classification rules — never from
// the implementation's output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { alignSequences, OrderTracker, orderText, MAX_RECEIVED } from "../../src/replay/order.ts";
import { ReplayIndex } from "../../src/replay/match.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { replayableRequests } from "../../src/replay/common.ts";
import { startReplayServer, type ReplayServer } from "../../src/replay/server.ts";
import { NO_RULES, RULES_SCHEMA, parseRulesDoc, type RuleSet } from "../../src/replay/rules.ts";
import { buildBundle, idOf, tmp } from "./_analyze.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

const O = "http://127.0.0.1:4310";
const C = 1762000000000;
const J = "application/json";
const set = (rules: unknown[]): RuleSet => ({ rules: parseRulesDoc({ schema: RULES_SCHEMA, rules }, "rules", { requireSchema: true, where: "test" }), source: { kind: "file", file: "rules.json" } });

describe("alignSequences", () => {
  const run = (a: string[], b: string[], maxCells?: number) => alignSequences(a.length, b.length, (i, j) => a[i] === b[j], maxCells);

  test("identical sequences match position by position", () => {
    expect(run(["A", "B", "C"], ["A", "B", "C"]).pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  test("one item moved to the end: the unique LCS leaves it out on both sides", () => {
    // A B C D E vs A C D E B: LCS A C D E (unique)
    expect(run(["A", "B", "C", "D", "E"], ["A", "C", "D", "E", "B"]).pairs).toEqual([
      [0, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ]);
  });

  test("a swap (two equally long solutions): the earlier expected item is matched first", () => {
    // A B C vs A C B: A B or A C; B is expected #2, C #3, so B is matched
    expect(run(["A", "B", "C"], ["A", "C", "B"]).pairs).toEqual([
      [0, 0],
      [1, 2],
    ]);
  });

  test("insertions and deletions", () => {
    expect(run(["A", "B", "C"], ["X", "A", "C", "Y"]).pairs).toEqual([
      [0, 1],
      [2, 2],
    ]);
    expect(run([], ["A"]).pairs).toEqual([]);
    expect(run(["A"], []).pairs).toEqual([]);
  });

  test("above the cell limit a greedy alignment is used and says so", () => {
    const r = run(["A", "B", "C", "D"], ["B", "C", "D"], 4);
    expect(r.approximate).toBe(true);
    expect(r.pairs).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(run(["A", "B"], ["A", "B"], 4).approximate).toBe(false); // the common prefix needs no table
  });
});

// ------------------------------------------------------------ against a bundle

let root = "";
let bundle = "";
let preferBundle = "";
const ids: string[] = [];
const id = (i: number): string => ids[i] ?? "";
let denied = "";
let allowed = "";

beforeAll(async () => {
  root = tmp("tabcap-09e-");
  bundle = await buildBundle(join(root, "b"), { name: "s09e", created: C, seed: 9 }, async (b) => {
    ids.push(idOf(await b.request({ url: `${O}/s76/login`, method: "POST", postData: "user=a&password=b", mime: J, body: '{"token":"t"}', ts: C + 1, reqHeaders: { "content-type": "application/x-www-form-urlencoded" } })));
    ids.push(idOf(await b.request({ url: `${O}/s76/list?page=1`, mime: J, body: '{"page":1}', ts: C + 2 })));
    ids.push(idOf(await b.request({ url: `${O}/s76/item`, method: "POST", postData: '{"id":1}', mime: J, body: '{"id":1}', ts: C + 3, reqHeaders: { "content-type": J } })));
    ids.push(idOf(await b.request({ url: `${O}/s76/list?page=2`, mime: J, body: '{"page":2}', ts: C + 4 })));
    ids.push(idOf(await b.request({ url: `${O}/s76/static.js`, mime: "text/javascript", body: "//", ts: C + 5 })));
  });
  preferBundle = await buildBundle(join(root, "p"), { name: "s09e-prefer", created: C, seed: 10 }, async (b) => {
    denied = idOf(await b.request({ url: `${O}/api/x`, status: 403, mime: J, body: "{}", ts: C + 1 }));
    allowed = idOf(await b.request({ url: `${O}/api/x`, mime: J, body: '{"ok":1}', ts: C + 2 }));
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Req = { method?: string; path: string; body?: string; type?: string };
const LOGIN: Req = { method: "POST", path: "/s76/login", body: "user=a&password=b", type: "application/x-www-form-urlencoded" };
const L1: Req = { path: "/s76/list?page=1" };
const ITEM1: Req = { method: "POST", path: "/s76/item", body: '{"id":1}', type: J };
const L2: Req = { path: "/s76/list?page=2" };
const JS: Req = { path: "/s76/static.js" };

async function serve(reqs: Req[], o: { rules?: RuleSet; include?: string; exclude?: string; b?: string; prefer?: "2xx" } = {}) {
  const srv: ReplayServer = await startReplayServer({
    bundle: o.b ?? bundle,
    host: "127.0.0.1",
    port: 0,
    strict: [],
    matchCookies: false,
    log: null,
    ...(o.rules === undefined ? {} : { rules: o.rules }),
    ...(o.prefer === undefined ? {} : { prefer: o.prefer }),
    order: { include: o.include, exclude: o.exclude },
  });
  try {
    for (const r of reqs) {
      await fetch(`${srv.info.url}${r.path}`, { method: r.method ?? "GET", ...(r.body === undefined ? {} : { body: r.body, headers: { "content-type": r.type ?? "text/plain" } }) }).then((x) => x.arrayBuffer());
    }
    const rep = srv.orderReport();
    if (rep === null) throw new Error("no report");
    return rep;
  } finally {
    srv.stop();
  }
}

describe("replay serve --order strict", () => {
  test("the recorded order: ok, nothing listed", async () => {
    const r = await serve([LOGIN, L1, ITEM1, L2, JS]);
    expect(r).toMatchObject({ mode: "strict", ok: true, expected: 5, received: 5, matched: 5, missing: [], extra: [], changed: [], moved: [], firstDivergence: null, truncated: false });
  });

  test("moved: the second request sent last", async () => {
    const r = await serve([LOGIN, ITEM1, L2, JS, L1]);
    expect(r.ok).toBe(false);
    expect(r.moved).toEqual([{ id: id(1), position: 2, index: 5 }]);
    expect(r.matched).toBe(4);
    expect([r.missing, r.extra, r.changed]).toEqual([[], [], []]);
    expect(r.firstDivergence).toEqual({ position: 2, expected: id(1), index: 2, received: "/s76/item" });
  });

  test("missing and extra (an unrecorded request answered 404)", async () => {
    const r = await serve([LOGIN, L1, L2, JS, { path: "/s76/list?page=3" }]);
    expect(r.missing).toEqual([{ position: 3, id: id(2), method: "POST", url: "/s76/item" }]);
    expect(r.extra).toEqual([{ index: 5, method: "GET", url: "/s76/list?page=3", matched: null }]);
    expect(r.changed).toEqual([]);
  });

  test("changed: same method and path in one diff block, the query differs", async () => {
    const r = await serve([LOGIN, L1, ITEM1, { path: "/s76/list?page=9" }, JS]);
    expect(r.changed).toEqual([{ position: 4, id: id(3), index: 4, differs: { query: { missing: [], extra: [], changed: ["page"] } } }]);
    expect([r.missing, r.extra, r.moved]).toEqual([[], [], []]);
  });

  test("changed body: a JSON body that differs", async () => {
    const r = await serve([LOGIN, L1, { ...ITEM1, body: '{"id":7}' }, L2, JS]);
    expect(r.changed.length).toBe(1);
    expect(r.changed[0]?.id).toBe(id(2));
    expect(r.changed[0]?.differs.body?.recordedSha256).not.toBe(r.changed[0]?.differs.body?.gotSha256);
  });

  test("subset: --order-exclude, rules order: skip, --order-include", async () => {
    const noJs = [LOGIN, L1, ITEM1, L2];
    expect((await serve(noJs)).missing.map((m) => m.id)).toEqual([id(4)]);
    const ex = await serve(noJs, { exclude: "/s76/static.js" });
    expect(ex).toMatchObject({ ok: true, expected: 4, skipped: { expected: 1, received: 0 }, exclude: "/s76/static.js" });
    const rules = set([{ match: { path: "/s76/static.js" }, order: "skip" }]);
    expect(await serve([...noJs, JS, JS], { rules })).toMatchObject({ ok: true, expected: 4, received: 4, skipped: { expected: 1, received: 2 } });
    const inc = await serve([L1, LOGIN, L2], { include: "/s76/list" });
    expect(inc).toMatchObject({ ok: true, expected: 2, received: 2, skipped: { expected: 3, received: 1 } });
    // exclude wins over include
    expect(await serve([L2], { include: "/s76/list", exclude: "/s76/list" })).toMatchObject({ ok: true, expected: 0, received: 0 });
  });

  test("an unknown order value in a rule is refused", () => {
    expect(() => set([{ order: "maybe" }])).toThrow(/order: must be one of "check", "skip"/);
  });

  test("prefer: the recording that is not served stays in the expected sequence, marked notServed", async () => {
    // nothing sent: both recordings are missing; the 403 that --prefer 2xx never serves carries notServed
    const r = await serve([], { b: preferBundle, prefer: "2xx" });
    expect(r.expected).toBe(2);
    expect(r.missing).toEqual([
      { position: 1, id: denied, method: "GET", url: "/api/x", notServed: true },
      { position: 2, id: allowed, method: "GET", url: "/api/x" },
    ]);
    // one sent: it aligns with the earlier expected item (the tie-break), so the later one is missing
    const one = await serve([{ path: "/api/x" }], { b: preferBundle, prefer: "2xx" });
    expect(one.missing.map((m) => m.position)).toEqual([2]);
    expect(r.warnings.join(" ")).toContain("prefer");
    expect(allowed).not.toBe("");
  });

  test("more than MAX_RECEIVED checked requests: truncated, not ok", () => {
    const reader = BundleReader.open(bundle);
    const index = new ReplayIndex(replayableRequests(reader).requests, reader, { strict: [], matchCookies: false });
    const t = new OrderTracker(index, { rules: NO_RULES });
    const req = { method: "GET", url: "/s76/static.js", headers: {}, body: new Uint8Array(0) };
    for (let i = 0; i < MAX_RECEIVED + 1; i++) t.note(req, index.match(req)?.recording ?? null);
    const r = t.report();
    expect(r).toMatchObject({ ok: false, truncated: true, received: MAX_RECEIVED + 1 });
  });

  test("the text summary names each kind", async () => {
    const r = await serve([LOGIN, ITEM1, L2, JS, L1]);
    const text = orderText(r);
    expect(text).toContain("order: DIFFERENT, 4/5 expected matched, 5 received");
    expect(text).toContain(`moved ${id(1)} expected #2, received #5`);
  });
});

describe("tabcap replay serve --order strict (CLI)", () => {
  test("report file 0600, second envelope, exit code 1 on a difference; --order key prints one envelope", async () => {
    const report = join(root, "order.json");
    const proc = Bun.spawn([process.execPath, MAIN, "replay", "serve", bundle, "--order", "strict", "--order-report", report, "--port", "0", "--json", "--once", "1.5"], { stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const info = JSON.parse(first.split("\n")[0] ?? "{}") as { data: { url: string } };
    await fetch(`${info.data.url}/s76/list?page=1`).then((x) => x.arrayBuffer());
    let rest = "";
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      rest += new TextDecoder().decode(c.value);
    }
    expect(await proc.exited).toBe(1);
    const lines = (first + rest).trim().split("\n");
    expect(lines.length).toBe(2);
    const stop = JSON.parse(lines[1] ?? "{}") as { ok: boolean; data: { stopped: boolean; order: { ok: boolean; missing: { id: string }[]; extra: unknown[]; moved: unknown[] } } };
    expect(stop.ok).toBe(true);
    expect(stop.data.order.ok).toBe(false);
    expect(stop.data.order.missing.map((m) => m.id)).toEqual([id(0), id(2), id(3), id(4)]);
    if (process.platform !== "win32") expect((statSync(report).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ mode: "strict", ok: false });

    const plain = Bun.spawn([process.execPath, MAIN, "replay", "serve", bundle, "--port", "0", "--json", "--once", "0.5"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(plain.stdout).text();
    expect(await plain.exited).toBe(0);
    expect(out.trim().split("\n").length).toBe(1);
  }, 20000);

  test("--order-include without --order strict is a usage error", async () => {
    const p = Bun.spawn([process.execPath, MAIN, "replay", "serve", bundle, "--order-include", "/x", "--port", "0", "--json"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(2);
    expect(out).toContain("need --order strict");
  });
});
