// analyze deps / analyze chain (src/analyze/deps.ts, chain.ts). Oracle: the
// value flows planted in the synthetic bundles of _deps.ts (each source is
// known by construction) and fixtures/bundles/sample-v0. Matching is exact;
// what has no source must come out computed-in-page / unrecorded, not guessed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CALLER_NAMES, DepsGraph, deps, depsFindings, depsOf, distinctive, isCallerInput, jsonLeafName, plainValue, unwrapHeaderValue, type DepsInput, type DepsResult } from "../../src/analyze/deps.ts";
import { chain, chainOf, defaultTarget } from "../../src/analyze/chain.ts";
import { run } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { tmp } from "./_analyze.ts";
import { ACCESS_TOKEN, APP_VERSION, C, CSRF_HEX, HTML_TOKEN, PASSWORD, QUOTED, REPORTS, SECRET_REF, SIGNS, TYPED, buildClockSkew, buildFlows, buildReport, buildToken } from "./_deps.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "bundles", "sample-v0");

let root = "";
let flows = "";
let r: DepsResult;
/** Request ids by what the builder recorded, in recording order. */
const id = { doc: "", login: "", data: "", items1: "", items2: "", sign1: "", sign2: "", search1: "", search2: "" };

beforeAll(async () => {
  root = tmp("tabcap-deps-");
  flows = await buildFlows(join(root, "flows"));
  r = deps(flows);
  const ids = r.requests.map((q) => q.id);
  (Object.keys(id) as (keyof typeof id)[]).forEach((k, i) => {
    id[k] = ids[i] ?? "";
  });
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

function input(req: string, location: string, name: string): DepsInput {
  const q = r.requests.find((x) => x.id === req);
  const i = q?.inputs.find((x) => x.location === location && (x.path ?? x.name) === name);
  if (i === undefined) throw new Error(`no ${location} ${name} in ${req}: ${JSON.stringify(q?.inputs.map((x) => `${x.location} ${x.path ?? x.name}`))}`);
  return i;
}

describe("deps: sources", () => {
  test("shape: schema, every request with its inputs, edges and unresolved", () => {
    expect(r.schema).toBe("tabcap-deps/0");
    expect(r.bundle).toBe(flows);
    expect(r.requests.length).toBe(9);
    expect(Object.values(id).every((x) => /^r-\d+$/.test(x))).toBe(true);
    for (const q of r.requests) for (const i of q.inputs) {
      const none = i.class === "computed-in-page" || i.class === "unrecorded" || i.class === "caller-input";
      if (none) expect(i.primary).toBeNull();
      else expect(String(i.primary?.kind)).toBe(i.class);
      expect(i.sources[0] ?? null).toEqual(i.primary);
    }
  });

  test("set-cookie chain: the data call's cookie sid comes from the login response's set-cookie", () => {
    const sid = input(id["data"] ?? "", "cookie", "sid");
    expect(sid.class).toBe("set-cookie");
    expect(sid.primary).toEqual({ kind: "set-cookie", request: id["login"], cookie: "sid" });
    expect(r.edges).toContainEqual({ kind: "set-cookie", from: { request: id["login"], cookie: "sid" }, to: { request: id["data"], location: "cookie", name: "sid" } });
  });

  test("response-path chain: x-csrf comes from the login body $.csrf, exact, no decode step", () => {
    const x = input(id["data"] ?? "", "header", "x-csrf");
    expect(x.class).toBe("response");
    expect(x.primary).toEqual({ kind: "response", request: id["login"], path: "$.csrf", decode: [], match: "exact" });
    expect(r.edges).toContainEqual({ kind: "response", from: { request: id["login"], path: "$.csrf" }, to: { request: id["data"], location: "header", name: "x-csrf" } });
    // a nested JSON leaf works the same way
    expect(input(id["items1"] ?? "", "query", "owner").primary).toEqual({ kind: "response", request: id["login"], path: "$.profile.id", decode: [], match: "exact" });
  });

  test("values inside HTML and inside a base64 JSON string: embedded / decoded, with the analyze find chain", () => {
    const t = input(id["login"] ?? "", "body", "_token");
    expect(t.primary).toEqual({ kind: "response", request: id["doc"], decode: [], match: "embedded" });
    const inner = input(id["items1"] ?? "", "header", "x-inner-token");
    expect(inner.primary?.kind).toBe("response");
    expect(inner.primary?.request).toBe(id["data"]);
    expect(inner.primary?.path).toBe("$.token -> $.inner");
    expect(inner.primary?.decode).toEqual(["base64", "json"]);
  });

  test("action chain: a fill command's text and a recorded fill action; the --secret fill never matches the plaintext", () => {
    const user = input(id["login"] ?? "", "body", "user");
    expect(user.class).toBe("action");
    expect(user.primary?.kind).toBe("action");
    const reader = DepsGraph.open(flows).reader;
    const ev = reader.events.find((e) => e.seq === user.primary?.action);
    expect(ev?.kind).toBe("cmd");
    expect(ev?.["phase"]).toBe("start");
    expect(input(id["items1"] ?? "", "query", "q").primary?.kind).toBe("action");
    const typed = reader.events.find((e) => e.seq === input(id["items1"] ?? "", "query", "q").primary?.action);
    expect(typed?.kind).toBe("action");
    expect(typed?.["value"]).toBe(TYPED);
    // one recorded login: the password is a single-sample constant, flagged sensitive; no action source
    const pw = input(id["login"] ?? "", "body", "password");
    expect(pw.class).toBe("constant");
    expect(pw.sources).toEqual([{ kind: "constant", samples: 1 }]);
    expect(pw.hints).toEqual(["single-sample", "sensitive-name"]);
    // the plaintext is in the bundle (the page sent it) but never in the deps output
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(JSON.stringify(r)).not.toContain(encodeURIComponent(PASSWORD));
    expect(SECRET_REF).toBe("range-demo.password");
  });

  test("carried forward: a value an earlier request already sent; the root keeps its own source", () => {
    const lang2 = input(id["items2"] ?? "", "query", "lang");
    expect(lang2.class).toBe("request");
    expect(lang2.primary).toEqual({ kind: "request", request: id["items1"], path: "query:lang" });
    expect(lang2.sources.map((s) => s.kind)).toEqual(["request", "constant"]);
    const lang1 = input(id["items1"] ?? "", "query", "lang");
    expect(lang1.primary).toEqual({ kind: "constant", samples: 2 });
  });

  test("constant: same value in every occurrence; a single occurrence is constant with the single-sample hint", () => {
    const v = input(id["data"] ?? "", "header", "x-app-version");
    expect(v.class).toBe("constant");
    expect(v.primary).toEqual({ kind: "constant", samples: 1 });
    expect(v.hints).toContain("single-sample");
    expect(APP_VERSION.length).toBeGreaterThan(4);
  });

  test("timestamp, and a signature that varies together with q, page, t and nonce (docs/05 s06 P2)", () => {
    const t = input(id["sign1"] ?? "", "query", "t");
    expect(t.class).toBe("timestamp");
    expect(t.primary).toEqual({ kind: "timestamp", samples: 2 });
    for (const which of ["sign1", "sign2"] as const) {
      const sig = input(id[which] ?? "", "query", "sig");
      expect(sig.class).toBe("computed-in-page");
      expect(sig.primary).toBeNull();
      expect(sig.hints).toContain("looks-signature");
      expect(sig.covaries).toEqual(["q", "page", "t", "nonce"]);
      expect(r.unresolved).toContainEqual({ request: id[which], location: "query", name: "sig", class: "computed-in-page" });
    }
    expect(SIGNS[0]?.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unrecorded: a cookie the browser held before the recording; later requests carry it forward", () => {
    const pref = input(id["doc"] ?? "", "cookie", "pref");
    expect(pref.class).toBe("unrecorded");
    expect(pref.primary).toBeNull();
    expect(input(id["login"] ?? "", "cookie", "pref").primary).toEqual({ kind: "request", request: id["doc"], path: "cookie:pref" });
    expect(r.unresolved).toContainEqual({ request: id["doc"], location: "cookie", name: "pref", class: "unrecorded" });
  });

  test("echo rule: a value the page sent before any response carried it is not taken from that response", () => {
    const c2 = input(id["search2"] ?? "", "body", "$.client");
    expect(c2.name).toBe("client");
    expect(c2.sources.map((s) => s.kind)).toEqual(["request", "constant"]);
    expect(c2.primary).toEqual({ kind: "request", request: id["search1"], path: "body:$.client" });
  });

  test("order between requests is the monotonic one: a wall-clock skew of 1.6 ms does not cut the csrf chain (10-16 Windows flake)", async () => {
    const csrfOf = (res: DepsResult) => {
      const [login, data] = res.requests;
      const x = data?.inputs.find((i) => i.location === "header" && i.name === "x-csrf");
      return { login: login?.id ?? "", x };
    };
    // wall: data starts before the login body's ts; mono: 2.4 ms after the login ended
    const skew = csrfOf(deps(await buildClockSkew(join(root, "skew"), false)));
    expect(skew.x?.class).toBe("response");
    expect(skew.x?.primary).toEqual({ kind: "response", request: skew.login, path: "$.csrf", decode: [], match: "exact" });
    // mono order really reversed: the value was sent before that body existed
    const rev = csrfOf(deps(await buildClockSkew(join(root, "skew-reversed"), true)));
    expect(rev.x?.class).toBe("computed-in-page");
    expect(rev.x?.primary).toBeNull();
    expect(CSRF_HEX.length).toBe(32);
  });

  test("--request / --session subsets keep sources from the whole bundle", () => {
    const one = deps(flows, { request: id["data"] });
    expect(one.requests.map((q) => q.id)).toEqual([id["data"]]);
    expect(one.requests[0]?.inputs.find((i) => i.name === "x-csrf")?.primary?.request).toBe(id["login"]);
    expect(deps(flows, { session: "flows" }).requests.length).toBe(9);
    expect(() => deps(flows, { session: "other" })).toThrow(/no request recorded under session "other"/);
    expect(() => deps(flows, { request: "r-99999" })).toThrow(/no request r-99999/);
  });

  test("helpers: distinctive values, JSON leaf names", () => {
    expect(distinctive("web")).toBe(false);
    expect(distinctive("true")).toBe(false);
    expect(distinctive("12345")).toBe(false);
    expect(distinctive("123456")).toBe(true);
    expect(distinctive("demo")).toBe(true);
    expect(jsonLeafName("$.a.b")).toBe("b");
    expect(jsonLeafName('$["x y"]')).toBe("x y");
    expect(jsonLeafName("$.a[2]")).toBe("a[2]");
    expect(jsonLeafName("$[0]")).toBe("[0]");
  });

  test("fixtures/bundles/sample-v0 (abbreviated request lines): no crash, session from the session event", () => {
    const s = deps(FIXTURE);
    expect(s.schema).toBe("tabcap-deps/0");
    expect(() => deps(FIXTURE, { session: "range-s02" })).not.toThrow();
    for (const q of s.requests) for (const i of q.inputs) expect(typeof i.class).toBe("string");
    const before = readFileSync(join(FIXTURE, "events.jsonl"), "utf8");
    deps(FIXTURE);
    expect(readFileSync(join(FIXTURE, "events.jsonl"), "utf8")).toBe(before);
  });
});

describe("chain", () => {
  test("to the data call: the document (HTML token), the login (csrf, sid), the data call; needs and TODO", () => {
    const c = chain(flows, { request: id["data"] });
    expect(c.schema).toBe("tabcap-chain/0");
    expect(c.target).toBe(id["data"]);
    expect(c.steps.map((s) => s.request)).toEqual([id["doc"], id["login"], id["data"]]);
    const [doc, login, data] = c.steps;
    expect(doc?.provides).toEqual([{ kind: "response", to: { request: id["login"], location: "body", name: "_token" }, decode: [], match: "embedded" }]);
    expect(login?.provides).toContainEqual({ kind: "response", to: { request: id["data"], location: "header", name: "x-csrf" }, path: "$.csrf", decode: [], match: "exact" });
    expect(login?.provides).toContainEqual({ kind: "set-cookie", to: { request: id["data"], location: "cookie", name: "sid" }, cookie: "sid" });
    expect(login?.needs.map((n) => [n.location, n.name, n.class])).toEqual([
      ["body", "user", "action"],
      ["cookie", "pref", "unrecorded"],
    ]);
    expect(login?.needs.find((n) => n.name === "pref")?.via).toBe(id["doc"]);
    expect(data?.needs.map((n) => n.name)).toEqual(["pref"]);
    expect(c.todo.map((t) => [t.request, t.name, t.class])).toEqual([
      [id["doc"], "pref", "unrecorded"],
      [id["login"], "pref", "unrecorded"],
      [id["data"], "pref", "unrecorded"],
    ]);
    expect(JSON.stringify(c)).not.toContain(PASSWORD);
    expect(HTML_TOKEN).not.toBe("");
  });

  test("a value carried through an earlier request still pulls in its producer", () => {
    const c = chain(flows, { request: id["items2"] });
    // owner comes from the login body; x-inner-token from the data body (base64 + json)
    expect(c.steps.map((s) => s.request)).toEqual([id["doc"], id["login"], id["data"], id["items2"]]);
    // q = "green pears" has no source: a search term the caller chooses (`q` is a CALLER_NAMES name, 0.6-E)
    expect(c.steps.find((s) => s.request === id["items2"])?.needs.find((n) => n.name === "q")?.class).toBe("caller-input");
    expect(c.inputs.map((t) => [t.request, t.name])).toEqual([[id["items2"], "q"]]);
    expect(c.todo.some((t) => t.name === "q")).toBe(false);
  });

  test("default target: the last data-bearing xhr / fetch / document request", () => {
    const g = DepsGraph.open(flows);
    expect(defaultTarget(g).id).toBe(id["search2"]);
    expect(chainOf(g, flows).target).toBe(id["search2"]);
    expect(chainOf(g, flows).steps.map((s) => s.request)).toEqual([id["search2"]]);
  });
});

describe("CLI", () => {
  test("analyze deps / chain: one JSON envelope by default, a text report with --text; usage and not-found errors", async () => {
    const text = await run(["analyze", "deps", flows, "--text"]);
    expect(text.code).toBe(0);
    expect(text.text).toContain(`${id["data"]} POST ${"http://127.0.0.1:4310/api/data"}`);
    expect(text.text).toMatch(/x-csrf\s+response\s+r-\d+ response \$\.csrf/);
    const j = await run(["analyze", "deps", flows, "--request", id["data"] ?? ""]);
    expect(j.text).toBeUndefined();
    expect(j.code).toBe(0);
    const data = j.envelope.ok ? j.envelope.data : null;
    expect(isRecord(data) && data["schema"]).toBe("tabcap-deps/0");
    expect(isRecord(data) && data["saved"]).toBeNull();
    expect((await run(["analyze", "deps", flows, "--bogus"])).code).toBe(2);
    expect((await run(["analyze", "deps", flows, "--request", "r-424242"])).code).toBe(1);
    const c = await run(["analyze", "chain", flows, "--request", id["data"] ?? "", "--text"]);
    expect(c.text).toContain(`chain to ${id["data"]}`);
    expect(c.text).toContain("needs    body user: action");
    const cj = await run(["analyze", "chain", flows]);
    expect(cj.text).toBeUndefined();
    expect((await run(["analyze", "chain", flows, "--json"])).code).toBe(2);
    const cd = cj.envelope.ok ? cj.envelope.data : null;
    expect(isRecord(cd) && cd["schema"]).toBe("tabcap-chain/0");
  });

  test("the bundle is read-only unless --write-findings; findings: 实测 for re-read exact sources, 推断 otherwise, no values", async () => {
    const copy = join(root, "findings");
    cpSync(flows, copy, { recursive: true });
    const before = readFileSync(join(copy, "events.jsonl"), "utf8");
    await run(["analyze", "deps", copy]);
    await run(["analyze", "chain", copy, "--text"]);
    expect(readFileSync(join(copy, "events.jsonl"), "utf8")).toBe(before);

    const w = await run(["analyze", "deps", copy, "--write-findings"]);
    expect(w.code).toBe(0);
    const saved = w.envelope.ok && isRecord(w.envelope.data) ? w.envelope.data["saved"] : null;
    expect(isRecord(saved) && Array.isArray(saved["seqs"]) ? saved["seqs"].length : 0).toBeGreaterThan(5);
    const after = readFileSync(join(copy, "events.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    const findings = after
      .slice(before.length)
      .trim()
      .split("\n")
      .map((l): unknown => JSON.parse(l))
      .filter(isRecord);
    expect(findings.every((f) => f["kind"] === "finding" && f["tool"] === "deps")).toBe(true);
    const claim = (re: RegExp) => findings.find((f) => typeof f["claim"] === "string" && re.test(f["claim"]));
    expect(claim(/^header x-csrf of .* comes from r-\d+ response \$\.csrf$/)?.["grade"]).toBe("实测");
    expect(claim(/^cookie sid of .* comes from r-\d+ set-cookie sid$/)?.["grade"]).toBe("实测");
    expect(claim(/^body user of .* comes from action @\d+$/)?.["grade"]).toBe("实测");
    expect(claim(/^body _token of .* comes from r-\d+ response \(text\)$/)?.["grade"]).toBe("推断");
    expect(claim(/^header x-inner-token of .* \[base64,json\]$/)?.["grade"]).toBe("推断");
    expect(claim(/password/)).toBeUndefined();
    expect(claim(/^query sig of r-\d+ is computed in the page .*looks-signature; varies with q, page, t, nonce/)).toBeDefined();
    const x = claim(/x-csrf/);
    expect(x?.["evidence"]).toEqual([
      { request: id["login"], path: "$.csrf" },
      { request: id["data"], path: "header:x-csrf" },
    ]);
    expect(after.slice(before.length)).not.toContain(PASSWORD);
    const m: unknown = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
    const counts = isRecord(m) && isRecord(m["counts"]) ? m["counts"]["events"] : null;
    expect(counts).toBe(after.trim().split("\n").length);
    expect(C).toBeGreaterThan(0);
  });
});

// 0.6-E: header values with a scheme prefix / quotes, and caller-input. Oracle: the TOKEN and REPORT
// bundles of _deps.ts (the token leaf and the caller's parameters are planted by construction).
describe("deps: prefixed header values and caller-input (0.6-E)", () => {
  const find = (res: DepsResult, req: string, location: string, name: string): DepsInput => {
    const i = res.requests.find((q) => q.id === req)?.inputs.find((x) => x.location === location && (x.path ?? x.name) === name);
    if (i === undefined) throw new Error(`no ${location} ${name} in ${req}`);
    return i;
  };

  test("Authorization: Bearer <token> comes from the token response's $.access_token, the source carries prefix", async () => {
    const dir = await buildToken(join(root, "token"));
    const res = deps(dir);
    const [tok = "", me = ""] = res.requests.map((q) => q.id);
    const auth = find(res, me ?? "", "header", "authorization");
    expect(auth.class).toBe("response");
    expect(auth.primary).toEqual({ kind: "response", request: tok, path: "$.access_token", decode: [], match: "exact", prefix: "Bearer " });
    expect(auth.hints).toContain("sensitive-name");
    // a quoted header value: prefix and suffix are the quotes
    expect(find(res, me ?? "", "header", "x-ref").primary).toEqual({ kind: "response", request: tok, path: "$.ref", decode: [], match: "exact", prefix: '"', suffix: '"' });
    expect(res.edges).toContainEqual({ kind: "response", from: { request: tok, path: "$.access_token" }, to: { request: me, location: "header", name: "authorization" } });
    const c = chain(dir);
    expect(c.steps.map((x) => x.request)).toEqual([tok, me]);
    expect(c.steps[0]?.provides).toContainEqual({ kind: "response", to: { request: me, location: "header", name: "authorization" }, path: "$.access_token", decode: [], match: "exact", prefix: "Bearer " });
    expect(c.todo).toEqual([]);
    // findings: the leaf re-reads exactly once the prefix is taken off (实测), no value in the claim
    const g = DepsGraph.open(dir);
    const f = depsFindings(g, depsOf(g, dir)).find((x) => x.claim.startsWith("header authorization"));
    expect(f?.grade).toBe("实测");
    expect(JSON.stringify(f)).not.toContain(ACCESS_TOKEN);
    expect(QUOTED.length).toBeGreaterThan(8);
  });

  test("unwrapHeaderValue: Bearer / Basic / Token / JWT (any case) and quotes; nothing to strip is null", () => {
    expect(unwrapHeaderValue("Bearer abc.def")).toEqual({ inner: "abc.def", prefix: "Bearer ", suffix: "" });
    expect(unwrapHeaderValue("basic dXNlcjpwdw==")).toEqual({ inner: "dXNlcjpwdw==", prefix: "basic ", suffix: "" });
    expect(unwrapHeaderValue("Token t1")?.prefix).toBe("Token ");
    expect(unwrapHeaderValue("JWT eyJ")?.prefix).toBe("JWT ");
    expect(unwrapHeaderValue('Bearer "q1"')).toEqual({ inner: "q1", prefix: 'Bearer "', suffix: '"' });
    expect(unwrapHeaderValue("'x'")).toEqual({ inner: "x", prefix: "'", suffix: "'" });
    for (const v of ["plain", "Bearer", "Bearer ", '""', "Bearerabc", '"open']) expect([v, unwrapHeaderValue(v)]).toEqual([v, null]);
  });

  test("caller-input: page, period, groupBy and a plain enumeration; constants, random, sensitive and signature-like values are not", async () => {
    const dir = await buildReport(join(root, "report"));
    const res = deps(dir);
    const [r1 = "", r2 = "", s1 = "", s2 = ""] = res.requests.map((q) => q.id);
    for (const req of [r1, r2]) {
      for (const n of ["page", "period", "groupBy", "cat"]) {
        const i = find(res, req ?? "", "query", n);
        expect([req, n, i.class, i.primary]).toEqual([req, n, "caller-input", null]);
      }
      expect(find(res, req ?? "", "query", "nonce").class).toBe("computed-in-page");
      expect(find(res, req ?? "", "query", "sessionKind").class).toBe("computed-in-page");
    }
    expect(find(res, r1 ?? "", "query", "pageSize").class).toBe("constant");
    for (const req of [s1, s2]) for (const n of ["$.year", "$.groupBy"]) expect(find(res, req ?? "", "body", n).class).toBe("caller-input");
    // caller-input is not unresolved, and the chain lists it under inputs, never todo
    expect(res.unresolved.map((u) => u.name).sort()).toEqual(["nonce", "nonce", "sessionKind", "sessionKind"]);
    const c = chain(dir, { request: r2 });
    expect(c.inputs.map((x) => [x.request, x.name, x.class])).toEqual(["page", "period", "groupBy", "cat"].map((n) => [r2, n, "caller-input"]));
    expect(c.todo.map((x) => x.name)).toEqual(["nonce", "sessionKind"]);
    expect(REPORTS.length).toBe(2);
  });

  test("the rule: CALLER_NAMES (case and _ - . ignored) or plain values only; never cookies, sensitive or signature-like", () => {
    for (const n of ["page", "pageSize", "page_size", "per-page", "limit", "offset", "from", "to", "period", "year", "month", "groupBy", "group_by", "q"]) expect([n, isCallerInput("query", n, [], ["x9f3k2-77"])]).toEqual([n, true]);
    expect(CALLER_NAMES).toContain("groupby");
    for (const v of ["1", "20", "-3", "12345", "true", "2026-10", "2026-10-16", "2026/10/16", "2026-10-16T08:30", "day", "week_end", "top-rated"]) expect([v, plainValue(v)]).toEqual([v, true]);
    for (const v of ["123456", "2026-13", "a1b2", "0f1e2d3c4b5a6978", "two words", "x".repeat(25), ""]) expect([v, plainValue(v)]).toEqual([v, false]);
    expect(isCallerInput("query", "kind", [], ["day", "week"])).toBe(true);
    expect(isCallerInput("query", "kind", [], ["day", "a1b2"])).toBe(false);
    expect(isCallerInput("cookie", "page", [], ["1"])).toBe(false);
    expect(isCallerInput("query", "page", ["looks-signature"], ["1"])).toBe(false);
    expect(isCallerInput("query", "page", ["looks-random"], ["1"])).toBe(false);
    expect(isCallerInput("query", "token", [], ["1"])).toBe(false);
    expect(isCallerInput("header", "x-auth-page", [], ["1"])).toBe(false);
  });
});
