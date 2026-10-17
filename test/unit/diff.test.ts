// analyze diff (docs/05 s06, docs/06 A4). Three synthetic recordings of one
// flow: b1 and b2 in session "range-s06-a", b3 in "range-s06-b". Parameter
// values are computed (sha256 / HMAC / epoch from the event ts), and each one
// is built to exhibit one docs/05 s06 class or sub-hint in every position
// (query, header, cookie, JSON body, form body; A4.4).

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { diff, extractParams, looksSignature, pathTemplate, pkey, queryFlags, timestampMs, valuedQuery, type DiffResult } from "../../src/analyze/diff.ts";
import { run } from "../../src/cli/main.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const ORIGIN = "http://127.0.0.1:4310";
const T1 = 1760500100000;
const h = (s: string) => createHash("sha256").update(s).digest();
const b64url = (b: Buffer) => b.toString("base64url");
const uuidOf = (s: string) => {
  const x = h(s).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};

const SESSIONS = ["range-s06-a", "range-s06-a", "range-s06-b"];
const Q = ["周报表", "会议纪要", "日程表"];
const PAGE = ["1", "2", "1"];
const SID = [b64url(h("sid-a")).slice(0, 22), b64url(h("sid-a")).slice(0, 22), b64url(h("sid-b")).slice(0, 22)];
const SESS_ID = ["sess_8f2c41d09b7e4a6f", "sess_8f2c41d09b7e4a6f", "sess_0c5d7e9a1b3f4a2e"];
const ITEM = ["17", "42", "99"];

async function recording(i: number, dir: string): Promise<string> {
  const ts = T1 + i * 3_600_000; // one hour apart; each timestamp is relative to its own event
  return buildBundle(dir, { name: SESSIONS[i] ?? "", created: ts, seed: 20 + i }, async (b) => {
    const q = Q[i] ?? "";
    const page = PAGE[i] ?? "";
    const sid = SID[i] ?? "";
    const t = String(ts + 1000 - 30);
    const nonce = b64url(h(`nonce-${i}`)).slice(0, 16);
    const sig = createHmac("sha256", "s06-secret").update(`${q}|${page}|${t}|${nonce}`).digest("hex");
    const cookie = `sid=${sid}; theme=dark`;
    const search = new URLSearchParams({ q, page, client: "web", v: "3", sid, t, nonce, sig });
    await b.request({
      url: `${ORIGIN}/api/search?${search.toString()}`,
      ts: ts + 1000,
      mime: "application/json",
      body: "{}",
      reqHeaders: { accept: "application/json", "x-client-build": "2026.10", "x-request-id": uuidOf(`req-${i}`), connection: "keep-alive", cookie },
    });
    const logBody = JSON.stringify({ query: q, ts: Math.floor((ts + 2000) / 1000), app: { ver: "3.1" }, sessionId: SESS_ID[i] });
    await b.request({
      url: `${ORIGIN}/api/items/${ITEM[i]}/log`,
      method: "POST",
      ts: ts + 2000,
      mime: "application/json",
      body: '{"ok":true}',
      reqHeaders: { "content-type": "application/json", "content-length": String(logBody.length), cookie },
      postData: logBody,
    });
    await b.request({
      url: `${ORIGIN}/api/track`,
      method: "POST",
      ts: ts + 3000,
      mime: "text/plain",
      body: "ok",
      reqHeaders: { "content-type": "application/x-www-form-urlencoded" },
      postData: new URLSearchParams({ kw: q, lang: "zh", at: new Date(ts + 3000 - 5).toISOString(), r: b64url(h(`r-${i}`)).slice(0, 12) }).toString(),
    });
    await b.request({ url: `${ORIGIN}/api/orders/${uuidOf(`order-${i}`)}?fmt=full`, ts: ts + 4000, mime: "application/json", body: "{}", reqHeaders: { accept: "application/json" } });
    if (i === 0) await b.request({ url: `${ORIGIN}/api/once`, ts: ts + 5000, mime: "application/json", body: "{}" });
  });
}

type Row = [group: string, location: string, name: string, cls: string, hints: string[]];

function table(r: DiffResult): Row[] {
  return r.groups.flatMap((g) => g.params.map((p): Row => [g.key, p.location, p.name, p.class, p.hints]));
}

const SEARCH = "GET /api/search";
const LOG = "POST /api/items/{n}/log";
const TRACK = "POST /api/track";
const ORDERS = "GET /api/orders/{id}";

/** Expected docs/05 s06 classes for three recordings over two sessions (A4.2). */
const EXPECTED_3: Row[] = [
  [ORDERS, "query", "fmt", "constant", []],
  [ORDERS, "header", "accept", "constant", []],
  [SEARCH, "query", "client", "constant", []],
  [SEARCH, "query", "nonce", "varying", ["looks-random"]],
  [SEARCH, "query", "page", "varying", []],
  [SEARCH, "query", "q", "varying", ["input"]],
  [SEARCH, "query", "sid", "session", []],
  [SEARCH, "query", "sig", "varying", ["looks-signature"]],
  [SEARCH, "query", "t", "timestamp", []],
  [SEARCH, "query", "v", "constant", []],
  [SEARCH, "header", "accept", "constant", []],
  [SEARCH, "header", "x-client-build", "constant", []],
  [SEARCH, "header", "x-request-id", "varying", ["looks-random"]],
  [SEARCH, "cookie", "sid", "session", []],
  [SEARCH, "cookie", "theme", "constant", []],
  [LOG, "header", "content-type", "constant", []],
  [LOG, "cookie", "sid", "session", []],
  [LOG, "cookie", "theme", "constant", []],
  [LOG, "json", "$.app.ver", "constant", []],
  [LOG, "json", "$.query", "varying", ["input"]],
  [LOG, "json", "$.sessionId", "session", []],
  [LOG, "json", "$.ts", "timestamp", []],
  [TRACK, "header", "content-type", "constant", []],
  [TRACK, "form", "at", "timestamp", []],
  [TRACK, "form", "kw", "varying", ["input"]],
  [TRACK, "form", "lang", "constant", []],
  [TRACK, "form", "r", "varying", ["looks-random"]],
];

/** Same flow, one session only (A4.1): session-like constants cannot be told apart. */
const EXPECTED_2 = EXPECTED_3.map(([g, loc, name, cls, hints]): Row => {
  if (cls === "session") return [g, loc, name, "constant-or-session", hints];
  if (loc === "cookie" && cls === "constant") return [g, loc, name, "constant-or-session", hints]; // a cookie may be per session
  return [g, loc, name, cls, hints];
});

let B: string[] = [];

beforeAll(async () => {
  B = await Promise.all([0, 1, 2].map((i) => recording(i, tmp(`tabcap-s06-${i}-`))));
}, SLOW_IO_MS);

describe("diff helpers", () => {
  test("path templates and timestamp parsing", () => {
    expect(pathTemplate("/api/items/17/log")).toBe("/api/items/{n}/log");
    expect(pathTemplate(`/api/orders/${uuidOf("x")}`)).toBe("/api/orders/{id}");
    expect(timestampMs("1760500100")).toBe(1760500100000);
    expect(timestampMs("1760500100123")).toBe(1760500100123);
    expect(timestampMs(new Date(T1).toISOString())).toBe(T1);
    expect(timestampMs("17605001")).toBeNull();
  });
});

describe("s06-like classification (A4)", () => {
  test("three recordings, two sessions: every class and sub-hint in every position (A4.2, A4.4)", () => {
    const r = diff(B);
    expect(r.sessions).toBe(2);
    expect(table(r)).toEqual(EXPECTED_3);
    expect(r.singleSampleGroups).toEqual(["GET /api/once"]);
    expect(r.groups.find((g) => g.key === SEARCH)?.perBundle).toEqual([1, 1, 1]);
    const q = r.groups.find((g) => g.key === SEARCH)?.params.find((p) => p.name === "q");
    expect(q?.alsoIn).toEqual([`${LOG} json $.query`, `${TRACK} form kw`]);
    expect(r.warnings).toEqual([]);
    // 0.7-C: each bundle has a short name (its directory's basename); request rows name their bundle by it, ids stay r-N
    const shorts = B.map((d) => d.split("/").pop() ?? "");
    expect(r.bundles.map((b) => [b.short, b.dir])).toEqual(B.map((d, i) => [shorts[i] ?? "", d]));
    const reqs = r.groups.find((g) => g.key === SEARCH)?.requests ?? [];
    expect(reqs.map((q) => q.bundle)).toEqual(shorts);
    for (const q of reqs) expect(q.id).toMatch(/^r-\d+$/);
  });

  test("two recordings of one session: sid is constant-or-session (A4.1)", () => {
    const r = diff([B[0] ?? "", B[1] ?? ""]);
    expect(r.sessions).toBe(1);
    expect(table(r)).toEqual(EXPECTED_2);
    expect(r.warnings.join(" ")).toContain("one session");
  });

  test("fewer than two bundles is a usage error", () => {
    expect(() => diff([B[0] ?? ""])).toThrow(/at least two/);
  });
});

describe("CLI: tabcap analyze diff", () => {
  test("--text snapshot and --save appends a finding to the first bundle", async () => {
    const dirs = await Promise.all([0, 1, 2].map((i) => recording(i, tmp(`tabcap-s06cli-${i}-`))));
    const t = await run(["analyze", "diff", ...dirs, "--text"]);
    expect(t.code).toBe(0);
    let text = t.text ?? "";
    dirs.forEach((d, i) => (text = text.split(d).join(`<b${i + 1}>`)));
    expect(text).toMatchSnapshot();

    const s = await run(["analyze", "diff", ...dirs, "--save"]);
    if (!s.envelope.ok) throw new Error(s.envelope.error.message);
    const lines = readFileSync(join(dirs[0] ?? "", "events.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(last).toMatchObject({ kind: "finding", tool: "diff", grade: "推断", actor: "ai" });
    expect(last.claim).toContain("session sid");
    expect(last.evidence.length).toBeGreaterThan(0);
    expect((await run(["analyze", "diff", dirs[0] ?? ""])).code).toBe(2);
  });
});

// 0.7-E (onboarding acceptance): two shapes a real site sent that the heuristics misread.
describe("0.7-E: value-less query keys and prefixed numeric ids", () => {
  test("a query key without `=` is no parameter (it names the method); queryFlags keeps it as recorded", () => {
    const m = extractParams({ id: "r-1", url: "http://h/api/list?queryZqzt&id=7&flag2", request: { headers: {}, postData: null } }, () => null, () => undefined);
    expect([...m.keys()]).toEqual([pkey("query", "id")]);
    expect(queryFlags("?queryZqzt&id=7&flag2")).toEqual(["queryZqzt", "flag2"]);
    expect([...valuedQuery("?queryZqzt&id=7&e=")]).toEqual([["id", "7"], ["e", ""]]);
  });

  test("looks-signature does not fire on digits behind a short letter prefix; real signatures still do", () => {
    const id = "AB" + "1234567890".repeat(3); // 32 characters, base64 alphabet
    expect(id.length).toBe(32);
    expect(looksSignature([id])).toBe(false);
    expect(looksSignature(["AB-" + "1".repeat(29)])).toBe(false);
    expect(looksSignature(["9".repeat(32)])).toBe(false);
    expect(looksSignature([createHash("md5").update("x").digest("hex")])).toBe(true);
    expect(looksSignature([createHash("sha256").update("x").digest("base64url").slice(0, 32)])).toBe(true);
    expect(looksSignature(["ABCDE" + "1".repeat(27)])).toBe(true);
  });
});
