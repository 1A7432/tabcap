// 0.6-L observe mode (docs/04 §33): the pure decisions — the suspect test,
// arming and expiry, attribution (owner rule 10-16: scope-string, then
// single-suspect, then unattributed with candidates; never by recency),
// plaintext recovery from the pausing scope, the row decision (the
// unattributed cap, the drop reasons). Plus the sidecar's 0.6-L reading:
// `request: null` rows parse, the plugin-over-page rank (D4), inline views.
// Oracle: the decisions of docs/04 §33 pinned here as hand-built values; the
// spike-06l logs (exp2's condition, exp3's scope strings, exp4's "the
// callee argument is not reachable" conclusion); s59's literals live in
// test/e2e/site.ts and are exercised by test/e2e/v06l.e2e.test.ts.
// 0.6-L2 (owner decisions 10-16): the raw-body sha as a suspect hash, the
// `link` of a row ("strong" scope-string / "weak" single-suspect) and its
// way into find's hits, the log-point pairing by position (spike E10's
// "the log's caller frame is the pause's top frame"), the bounded raw-body set.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { find } from "../../src/analyze/find.ts";
import { BlobStore } from "../../src/bundle/blobs.ts";
import { appendSidecar } from "../../src/bundle/decoded.ts";
import { S42_ITEMS_JSON } from "../e2e/site.ts";
import { s42Bundle } from "./_decode.ts";
import {
  addBounded,
  Armed,
  attribute,
  bytesCsvToText,
  consoleSites,
  JSON_PARSE_CONDITION,
  jsonParseLogpoint,
  looksBareToken,
  LOGGED_MAX_AGE_MS,
  observeRow,
  pauseSite,
  plaintextOf,
  PLAINTEXT_CAP,
  rawBodyExcluded,
  sha256Text,
  suspectOf,
  suspectShas,
  SUSPECT_WINDOW_MS,
  takeLogged,
  UNATTRIBUTED_CAP,
  type ArmedSuspect,
  type LoggedPlain,
  type Attribution,
  type ObserveMatch,
  type PageEvidence,
} from "../../src/daemon/trace/observe.ts";
import { latestViews, overlayEvent, parseSidecarText } from "../../src/bundle/decoded.ts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
/** Deterministic pseudo-random high-entropy body (LCG top bits; entropy ~7.85
 * over 1200 bytes, over find's >7.3 from 1 KiB threshold): "looks encrypted". */
const hot = (): Uint8Array => {
  let s = 123456789;
  const out = new Uint8Array(1200);
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};
/** A base64-looking leaf of exactly this length (hand-written, not generated). */
const LEAF = "QmFzZTY0bG9va2luZy1sZWFmLW9mLWF0LWxlYXN0LTY0LWNoYXJhY3RlcnMtbG9uZw==";
const PLAIN_ROWS = '{"rows":[{"id":"S59-0001","amount":12},{"id":"S59-0002","amount":7}]}';

const suspect = (request: string, shas: string[], at = 1000): ArmedSuspect => ({ request, url: "https://t/api", at, expiresAt: at + SUSPECT_WINDOW_MS, shas });
const frames: PageEvidence["frames"] = [{ url: "https://t/s59.js", line: 10, column: 2, function: "render" }];
const match = (over: Partial<ObserveMatch>): ObserveMatch => ({
  attribution: { kind: "armed-empty" },
  scopeShas: [],
  frames,
  plaintext: { best: null, oversize: false },
  now: 1_760_000_000_000,
  sink: "JSON.parse",
  ...over,
});

describe("suspectOf (docs/04 §33 D3)", () => {
  test("plaintext JSON is not a suspect", () => {
    expect(suspectOf(new TextEncoder().encode(PLAIN_ROWS), PLAIN_ROWS)).toBeNull();
  });
  test("a high-entropy whole body is (hash of the whole text)", () => {
    const bytes = hot();
    const text = Buffer.from(bytes).toString("utf8");
    const s = suspectOf(bytes, text);
    expect(s !== null && s.candidates.whole === sha256Text(text) && s.candidates.leaves.length === 0).toBe(true);
  });
  test("a base64 JSON leaf of 60+ chars is (not the whole body)", () => {
    const body = `{"data":"${LEAF}","n":1}`;
    const s = suspectOf(new TextEncoder().encode(body), body);
    expect(s?.candidates).toEqual({ whole: null, leaves: [sha(LEAF)] });
    expect(s?.jsonLeaf).toBe(true);
  });
  test("short leaves are not", () => {
    const body = '{"data":"QmFzZTY0"}';
    expect(suspectOf(new TextEncoder().encode(body), body)).toBeNull();
  });
  test("a bare base64 / hex token body is a suspect on its trimmed token (0.6-L2 item 6)", () => {
    const s = suspectOf(new TextEncoder().encode(`  ${LEAF}  `), `  ${LEAF}  `);
    expect(s?.candidates).toEqual({ whole: sha(LEAF), leaves: [] });
    expect(s?.jsonLeaf).toBe(false);
    // A bare token under 64 chars does not arm.
    expect(suspectOf(new TextEncoder().encode("QmFzZTY0bG9va2luZw=="), "QmFzZTY0bG9va2luZw==")).toBeNull();
    // Plain prose is not a token (it has spaces).
    expect(looksBareToken("the quick brown fox jumps over the lazy dog many times over here")).toBeNull();
  });
});

describe("0.6-L2 additions", () => {
  test("the plaintext cap is 16 MiB, under the 32 MiB blob cap", () => {
    expect(PLAINTEXT_CAP).toBe(16 * 1024 * 1024);
  });
  test("jsonParseLogpoint keeps the length gate, guards the native dirxml, carries the nonce and the cap", () => {
    const lp = jsonParseLogpoint("NONCE-123", 42);
    expect(lp).toContain(JSON_PARSE_CONDITION);
    expect(lp).toContain('console.dirxml.name === "dirxml"');
    expect(lp).toContain('console.dirxml("NONCE-123", arguments[0].length <= 42 ? arguments[0] : null)');
  });
  test("looksBareToken: 64+ base64 / hex token (trimmed) or null", () => {
    expect(looksBareToken(LEAF)).toBe(sha(LEAF));
    expect(looksBareToken(`\n${"ab".repeat(40)}\n`)).toBe(sha("ab".repeat(40))); // 80 hex chars
    expect(looksBareToken('{"rows":[]}')).toBeNull();
  });
  test("rawBodyExcluded: a plaintext that is a recorded raw body (envelope, control) is dropped", () => {
    const envelope = '{"code":0,"data":"' + LEAF + '"}';
    const raw = new Set([sha256Text(envelope), sha256Text("other")]);
    expect(rawBodyExcluded(envelope, raw)).toBe(true);
    expect(rawBodyExcluded(PLAIN_ROWS, raw)).toBe(false);
  });
});

describe("Armed: window and lookup", () => {
  test("arm, live, expire, forget, clear", () => {
    const a = new Armed();
    a.arm({ request: "r-1", url: "u", at: 1000, shas: ["h1"] });
    a.arm({ request: "r-2", url: "u", at: 3000, shas: ["h2", "h3"] });
    a.expire(1000 + SUSPECT_WINDOW_MS - 1);
    expect(a.live().map((s) => s.request)).toEqual(["r-1", "r-2"]);
    a.expire(1000 + SUSPECT_WINDOW_MS);
    expect(a.live().map((s) => s.request)).toEqual(["r-2"]); // r-1 outside its window
    expect(a.bySha(["h3"])?.request).toBe("r-2");
    expect(a.bySha(["nope"])).toBeNull();
    a.forget("r-2");
    expect(a.live()).toEqual([]);
    a.arm({ request: "r-3", url: "u", at: 100, shas: ["h"] });
    expect(a.clear("why")).toBe(1);
    expect(a.live()).toEqual([]);
  });
});

describe("attribute (owner rule 10-16: never by recency)", () => {
  const A = suspect("r-1", ["ha"], 1000);
  const B = suspect("r-2", ["hb"], 2000);
  test("scope-string wins over everything", () => {
    expect(attribute([A, B], ["zz", "hb"])).toEqual({ kind: "scope-string", suspect: B });
  });
  test("exactly one armed suspect takes it without a scope hit", () => {
    expect(attribute([B], ["zz"])).toEqual({ kind: "single-suspect", suspect: B });
  });
  test("several suspects without a scope hit: unattributed, candidates in armed order", () => {
    expect(attribute([A, B], ["zz"])).toEqual({ kind: "unattributed", candidates: ["r-1", "r-2"] });
  });
  test("nothing armed", () => {
    expect(attribute([], ["zz"])).toEqual({ kind: "armed-empty" });
  });
});

describe("plaintextOf (spike exp4: recover from the scope, never executes page code)", () => {
  test("the longest JSON-parsing string wins", () => {
    const short = '{"a":"' + "x".repeat(18) + '"}';
    const long = '{"long":"' + "y".repeat(28) + '"}';
    const p = plaintextOf([short, long], []);
    expect(p).toEqual({ best: { text: long, from: "string" }, oversize: false });
  });
  test("a byte CSV decodes UTF-8 and parses", () => {
    const bytes = new TextEncoder().encode(PLAIN_ROWS);
    const p = plaintextOf([], [Array.from(bytes).join(",")]);
    expect(p).toEqual({ best: { text: PLAIN_ROWS, from: "bytes" }, oversize: false });
  });
  test("strings under 32 chars and non-JSON strings are not candidates", () => {
    expect(plaintextOf(['{"a":1}', `plain text of forty-ish characters ${"z".repeat(20)}`], [])).toEqual({ best: null, oversize: false });
  });
  test("a value over the cap marks oversize, files nothing", () => {
    const p = plaintextOf([`{"pad":"${"a".repeat(PLAINTEXT_CAP)}"}`], []);
    expect(p).toEqual({ best: null, oversize: true });
  });
  test("a bogus byte CSV is not a candidate", () => {
    expect(plaintextOf([], ["not,numbers"])).toEqual({ best: null, oversize: false });
  });
});

describe("bytesCsvToText", () => {
  test("decimal CSV to UTF-8 text", () => {
    expect(bytesCsvToText("104,105")).toBe("hi");
    expect(bytesCsvToText(Array.from(new TextEncoder().encode('{"ok":true}')).join(","))).toBe('{"ok":true}');
  });
  test("0..255 only; anything else null; empty stays empty", () => {
    expect(bytesCsvToText("256")).toBeNull();
    expect(bytesCsvToText("12x")).toBeNull();
    expect(bytesCsvToText("")).toBe("");
  });
});

describe("observeRow (docs/04 §33: the row and its drop reasons)", () => {
  const pt = { best: { text: PLAIN_ROWS, from: "string" as const }, oversize: false };
  test("no live suspect: plaintext-missing (attributions never into the void)", () => {
    expect(observeRow(match({ attribution: { kind: "armed-empty" }, plaintext: pt }), 0)).toEqual({ skip: "plaintext-missing" });
  });
  test("single-suspect files under the request, no match, no candidates", () => {
    const r = observeRow(match({ attribution: { kind: "single-suspect", suspect: suspect("r-7", ["h"]) }, plaintext: pt }), 0);
    expect(r).toEqual({
      row: { request: "r-7", direction: "response", mime: "application/json", text: PLAIN_ROWS, evidence: { sink: "JSON.parse", match: null, link: "weak", frames, at: 1_760_000_000_000 } },
    });
  });
  test("scope-string records the sha that matched, link strong (0.6-L2)", () => {
    const s = suspect("r-7", ["h1", "h2"]);
    const r = observeRow(match({ attribution: { kind: "scope-string", suspect: s }, scopeShas: ["h9", "h2"], plaintext: pt }), 0);
    expect("row" in r && r.row.evidence.match === "h2").toBe(true);
    expect("row" in r && r.row.evidence.link === "strong").toBe(true);
  });
  test("unattributed keeps the plaintext, request null, candidates listed", () => {
    const r = observeRow(match({ attribution: { kind: "unattributed", candidates: ["r-1", "r-2"] }, plaintext: pt }), 3);
    expect(r).toEqual({
      row: { request: null, direction: "response", mime: "application/json", text: PLAIN_ROWS, evidence: { sink: "JSON.parse", match: null, frames, at: 1_760_000_000_000, candidates: ["r-1", "r-2"] } },
    });
  });
  test("the unattributed cap drops at 50, keeps at 49", () => {
    expect(UNATTRIBUTED_CAP).toBe(50);
    const a: Attribution = { kind: "unattributed", candidates: ["r-1"] };
    expect("row" in observeRow(match({ attribution: a, plaintext: pt }), UNATTRIBUTED_CAP - 1)).toBe(true);
    expect(observeRow(match({ attribution: a, plaintext: pt }), UNATTRIBUTED_CAP)).toEqual({ skip: "unattributed-capped" });
  });
  test("no plaintext readable: missing; oversize: too-large", () => {
    expect(observeRow(match({ attribution: { kind: "single-suspect", suspect: suspect("r-7", ["h"]) }, plaintext: { best: null, oversize: false } }), 0)).toEqual({ skip: "plaintext-missing" });
    expect(observeRow(match({ attribution: { kind: "single-suspect", suspect: suspect("r-7", ["h"]) }, plaintext: { best: null, oversize: true } }), 0)).toEqual({ skip: "plaintext-too-large" });
  });
  test("the JSON.parse condition (exp2: pages parsing every few bytes must not pause)", () => {
    expect(JSON_PARSE_CONDITION).toContain("length >= 32");
  });
});

// ------------------------------------------------------------ sidecar (0.6-B shape + D4/D7)

const BLOB = `sha256:${"f".repeat(64)}`;
const view = (by: string, ok = true): Record<string, unknown> => ({ by, version: "v0", direction: "response", mime: "application/json", blob: ok ? BLOB : null, bytes: ok ? 3 : null, ok });
const line = (seq: number, request: string | null, decoded: Record<string, unknown>, at = 1): string =>
  JSON.stringify({ seq, request, direction: "response", decoded, at });

describe("the sidecar's 0.6-L rows", () => {
  test("request:null parses as an unattributed row", () => {
    const s = parseSidecarText([
      line(1, "r-1", view("plugin-x")),
      line(2, null, { ...view("page"), evidence: { sink: "JSON.parse", match: null, frames: [], at: 1, candidates: ["r-1"] } }),
    ].join("\n") + "\n");
    expect(s.issues).toEqual([]);
    expect(s.entries.map((e) => [e.seq, e.request])).toEqual([[1, "r-1"], [2, null]]);
    expect(s.entries[1]?.decoded["evidence"]).toEqual({ sink: "JSON.parse", match: null, frames: [], at: 1, candidates: ["r-1"] });
  });
  test("an unattributed row never overlays a request (D7)", () => {
    const s = parseSidecarText(line(1, null, view("page")) + "\n");
    expect(latestViews(s).size).toBe(0);
  });
  test("a later page row does not dislodge an ok plugin view; a later plugin view replaces a page one (D4)", () => {
    const s = parseSidecarText([line(1, "r-1", view("plugin-x")), line(2, "r-1", view("page"))].join("\n") + "\n");
    expect(latestViews(s).get("r-1\tresponse")?.["by"]).toBe("plugin-x");
    const s2 = parseSidecarText([line(1, "r-1", view("page")), line(2, "r-1", view("plugin-x"))].join("\n") + "\n");
    expect(latestViews(s2).get("r-1\tresponse")?.["by"]).toBe("plugin-x");
  });
  test("an ok:false line still loses to any ok view but keeps last-wins against nothing (0.6-B)", () => {
    const s = parseSidecarText([line(1, "r-1", view("plugin-x", false)), line(2, "r-1", view("page"))].join("\n") + "\n");
    expect(latestViews(s).get("r-1\tresponse")?.["by"]).toBe("page");
  });
});

describe("overlayEvent against a view recorded inline (D4)", () => {
  const ev = (decoded: Record<string, unknown> | undefined): Record<string, unknown> => ({
    kind: "request",
    id: "r-1",
    request: {},
    response: decoded === undefined ? {} : { status: 200, decoded },
  });
  test("a sidecar page row does not dislodge an inline ok plugin view", () => {
    const out = overlayEvent(ev(view("plugin-x")) as Record<string, unknown>, new Map([["r-1\tresponse", view("page")]]));
    const resp = out["response"] as Record<string, unknown>;
    expect((resp["decoded"] as Record<string, unknown>)["by"]).toBe("plugin-x");
  });
  test("a sidecar plugin row replaces an inline page view", () => {
    const out = overlayEvent(ev(view("page")) as Record<string, unknown>, new Map([["r-1\tresponse", view("plugin-x")]]));
    const resp = out["response"] as Record<string, unknown>;
    expect((resp["decoded"] as Record<string, unknown>)["by"]).toBe("plugin-x");
  });
  test("no inline view: the sidecar row lands as before", () => {
    const out = overlayEvent(ev(undefined) as Record<string, unknown>, new Map([["r-1\tresponse", view("page")]]));
    const resp = out["response"] as Record<string, unknown>;
    expect((resp["decoded"] as Record<string, unknown>)["by"]).toBe("page");
  });
  test("a non-request event is untouched", () => {
    const e = { kind: "note", id: "r-1" };
    expect(overlayEvent(e, new Map([["r-1\tresponse", view("page")]]))).toBe(e);
  });
});

describe("0.6-L2: the raw body text is a suspect hash too", () => {
  test("candidates first, the raw text last (evidence.match names the ciphertext when both are in scope)", () => {
    const body = '{"code":0,"data":"' + LEAF + '"}';
    const s = suspectOf(new TextEncoder().encode(body), body);
    if (s === null) throw new Error("not a suspect");
    expect(suspectShas(s, body)).toEqual([sha(LEAF), sha(body)]);
    // a whole-body candidate that is the raw text itself is listed once
    const t = new TextDecoder("latin1").decode(hot());
    const w = suspectOf(hot(), t);
    if (w === null) throw new Error("not a suspect");
    expect(suspectShas(w, t)).toEqual([sha(t)]);
  });
  test("an axios-style scope holding the raw envelope is a scope-string match", () => {
    const body = '{"code":0,"data":"' + LEAF + '"}';
    const s = suspectOf(new TextEncoder().encode(body), body);
    if (s === null) throw new Error("not a suspect");
    const a = attribute([suspect("r-3", suspectShas(s, body)), suspect("r-4", ["other"])], [sha(body)]);
    expect(a.kind === "scope-string" && a.suspect.request).toBe("r-3");
  });
});

describe("0.6-L2: addBounded keeps the newest", () => {
  test("evicts the oldest at the cap, ignores repeats", () => {
    const set = new Set<string>();
    for (const k of ["a", "b", "c"]) addBounded(set, k, 3);
    addBounded(set, "b", 3);
    expect([...set]).toEqual(["a", "b", "c"]);
    addBounded(set, "d", 3);
    expect([...set]).toEqual(["b", "c", "d"]);
  });
});

describe("0.6-L2: pairing a pause with its log-point line (spike E6 order, E10 position)", () => {
  const L = (text: string, at: number, sites: string[]): LoggedPlain => ({ text, oversize: false, at, sites });
  test("sites: the console stack's first frames, the pause's top frame", () => {
    const params = { stackTrace: { callFrames: [{ scriptId: "90", lineNumber: 0, columnNumber: 5 }, { scriptId: "12", lineNumber: 14, columnNumber: 36 }, { scriptId: "12", lineNumber: 41 }] } };
    expect(consoleSites(params)).toEqual(["90:0:5", "12:14:36"]);
    expect(consoleSites({})).toEqual([]);
    expect(pauseSite({ location: { scriptId: "12", lineNumber: 14, columnNumber: 36 } })).toBe("12:14:36");
    expect(pauseSite(undefined)).toBeNull();
  });
  test("the line of this site is taken; lines before it lost their pause (stale)", () => {
    const q = [L("old", 100, ["9:1:1"]), L("mine", 110, ["9:2:2"]), L("next", 120, ["9:3:3"])];
    const r = takeLogged(q, "9:2:2", 200);
    expect(r.hit?.text).toBe("mine");
    expect(r.stale).toBe(1);
    expect(r.rest.map((x) => x.text)).toEqual(["next"]);
  });
  test("no line for this site: null, the queue is kept (the guard failed for this parse)", () => {
    const q = [L("other", 100, ["9:1:1"])];
    const r = takeLogged(q, "9:2:2", 200);
    expect(r.hit).toBeNull();
    expect(r.rest).toEqual(q);
    expect(r.stale).toBe(0);
  });
  test("a line without stack frames pairs in order; old lines expire", () => {
    expect(takeLogged([L("bare", 100, [])], "9:2:2", 200).hit?.text).toBe("bare");
    const r = takeLogged([L("ancient", 0, ["9:2:2"])], "9:2:2", LOGGED_MAX_AGE_MS + 1);
    expect(r.hit).toBeNull();
    expect(r.stale).toBe(1);
  });
});

describe("0.6-L2: a page view's link reaches find's hits", () => {
  let root = "";
  let dir = "";
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "tabcap-obs-link-"));
    dir = await s42Bundle(join(root, "b"));
    // The s42 items response (r-4) is XOR-encoded on the wire; plant the
    // plaintext as an observe row, as the tracer files it.
    const put = await new BlobStore(dir).put(S42_ITEMS_JSON);
    if (put.outcome !== "stored") throw new Error("blob not stored");
    const decoded = (link: "strong" | "weak") => ({ by: "page", version: "observe/0", direction: "response", mime: "application/json", blob: put.ref, bytes: put.size, ok: true, evidence: { sink: "JSON.parse", match: null, link, frames: [], at: 1 } });
    appendSidecar(dir, { seq: 1, request: "r-4", direction: "response", decoded: decoded("weak"), at: 1 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("a hit in a weak page view says link: weak", () => {
    const hits = find(dir, "甲号商品").hits.filter((h) => h.ref === "r-4");
    expect(hits.length).toBe(1);
    expect(hits[0]?.decode[0]).toBe("page");
    expect(hits[0]?.link).toBe("weak");
  });
});
