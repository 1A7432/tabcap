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
// 0.6-Q (docs/04 §33 0.6-Q; evidence: the owner's real-site test of 10-17,
// 76 of 91 bodies MIME-wrapped): the four hash forms of a candidate and the
// matched form, the per-suspect plaintext bound (no-fit), the settle of
// unattributed rows and the raw-body drop of settling / held entries.
// 0.6-V (owner decisions 10-17, after two real-site rounds where every weak
// row was wrong): weak rows can be turned off (`trace.weakRows: false`;
// `settleOutcome` "weak" → drops.weak), and the evidence frames' url (CDP Debugger.CallFrame: `url`
// and `location.scriptId`, no top-level scriptId — the 0.6-L reader looked
// for one, so every frame url was "").
// 0.6-W (owner decision A 10-17, after a neighbouring project's XHR replica
// went 0/40 strong with three unclaimed suspects live): a pause without a
// scope-string match is held for GRACE_MS and decided against the suspects
// live then; trace / recording stop force the pending ones (no live suspect
// then: an orphan). `heldVerdict` / `heldWaits` / `passHeld` pinned here;
// the e2e oracle is s59 `mode=xhr&linger=3`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  type SuspectHash,
  type Attribution,
  type ObserveMatch,
  type PageEvidence,
} from "../../src/daemon/trace/observe.ts";
import { latestViews, overlayEvent, parseSidecarText } from "../../src/bundle/decoded.ts";
import { dropRawBody, evidenceFrames, fits, formsOf, frameScriptId, GRACE_MS, heldVerdict, heldWaits, HOLD_MAX, HOLD_MS, passHeld, settleOutcome, tokenBound, tokenCore, utf8Bytes, type Settling } from "../../src/daemon/trace/observe.ts";
import { decodedEntry, noDecodedView } from "../../src/daemon/tools/net.ts";

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

const raws = (shas: string[]): SuspectHash[] => shas.map((h) => ({ sha: h, form: "raw" as const }));
const suspect = (request: string, shas: string[], at = 1000, bound: number | null = null): ArmedSuspect => ({ request, url: "https://t/api", at, expiresAt: at + SUSPECT_WINDOW_MS, hashes: raws(shas), bound });
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
    expect(s?.candidates.map((c) => c.kind)).toEqual(["whole"]);
    // raw last (0.6-Q: transformed forms first); the bound is the byte length.
    expect(s?.candidates[0]?.hashes.at(-1)).toEqual({ sha: sha256Text(text), form: "raw" });
    expect(s?.bound).toBe(1200);
  });
  test("a base64 JSON leaf of 60+ chars is (not the whole body)", () => {
    const body = `{"data":"${LEAF}","n":1}`;
    const s = suspectOf(new TextEncoder().encode(body), body);
    expect(s?.candidates).toEqual([{ kind: "leaf", hashes: [{ sha: sha(LEAF), form: "raw" }], bound: Math.floor((LEAF.length * 3) / 4) }]);
    expect(s?.jsonLeaf).toBe(true);
  });
  test("short leaves are not", () => {
    const body = '{"data":"QmFzZTY0"}';
    expect(suspectOf(new TextEncoder().encode(body), body)).toBeNull();
  });
  test("a bare base64 / hex token body is a suspect on its trimmed token (0.6-L2 item 6)", () => {
    const s = suspectOf(new TextEncoder().encode(`  ${LEAF}  `), `  ${LEAF}  `);
    expect(s?.candidates).toEqual([{ kind: "bare", hashes: [{ sha: sha(LEAF), form: "raw" }], bound: Math.floor((LEAF.length * 3) / 4) }]);
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
    expect(looksBareToken(LEAF)).toEqual({ token: LEAF, bound: Math.floor((LEAF.length * 3) / 4) });
    expect(looksBareToken(`\n${"ab".repeat(40)}\n`)).toEqual({ token: "ab".repeat(40), bound: 40 }); // 80 hex chars: /2
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
    a.arm({ request: "r-1", url: "u", at: 1000, hashes: raws(["h1"]), bound: null });
    a.arm({ request: "r-2", url: "u", at: 3000, hashes: raws(["h2", "h3"]), bound: null });
    a.expire(1000 + SUSPECT_WINDOW_MS - 1);
    expect(a.live().map((s) => s.request)).toEqual(["r-1", "r-2"]);
    a.expire(1000 + SUSPECT_WINDOW_MS);
    expect(a.live().map((s) => s.request)).toEqual(["r-2"]); // r-1 outside its window
    expect(a.bySha(["h3"])?.request).toBe("r-2");
    expect(a.bySha(["nope"])).toBeNull();
    a.forget("r-2");
    expect(a.live()).toEqual([]);
    a.arm({ request: "r-3", url: "u", at: 100, hashes: raws(["h"]), bound: null });
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
    expect(suspectShas(s, body)).toEqual(raws([sha(LEAF), sha(body)]));
    // a whole-body candidate that is the raw text itself is listed once
    const t = new TextDecoder("latin1").decode(hot());
    const w = suspectOf(hot(), t);
    if (w === null) throw new Error("not a suspect");
    expect(suspectShas(w, t).filter((h) => h.sha === sha(t))).toEqual(raws([sha(t)]));
    expect(suspectShas(w, t).filter((h) => h.form === "raw").length).toBe(1);
  });
  test("an axios-style scope holding the raw envelope is a scope-string match", () => {
    const body = '{"code":0,"data":"' + LEAF + '"}';
    const s = suspectOf(new TextEncoder().encode(body), body);
    if (s === null) throw new Error("not a suspect");
    const a = attribute([{ ...suspect("r-3", []), hashes: suspectShas(s, body) }, suspect("r-4", ["other"])], [sha(body)]);
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

// ------------------------------------------------------------ 0.6-Q

/** Deterministic bytes (the LCG of `hot`, another seed) as MIME base64: "\r\n" every 76 chars. */
const mimeOf = (n: number): { flat: string; mime: string } => {
  let x = 42;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  const flat = b.toString("base64");
  return { flat, mime: (flat.match(/.{1,76}/g) ?? []).join("\r\n") };
};

describe("0.6-Q A: the forms of a candidate (raw, stripped, unquoted, urldecoded)", () => {
  test("formsOf: transformed forms that differ come first, raw last, at most 4", () => {
    const { flat, mime } = mimeOf(120);
    expect(formsOf(mime)).toEqual([
      { text: flat, form: "stripped" },
      { text: mime, form: "raw" },
    ]);
    expect(formsOf(`"${LEAF}"`)).toEqual([
      { text: LEAF, form: "unquoted" },
      { text: `"${LEAF}"`, form: "raw" },
    ]);
    const enc = encodeURIComponent(flat);
    expect(formsOf(enc)).toEqual([
      { text: flat, form: "urldecoded" },
      { text: enc, form: "raw" },
    ]);
    expect(formsOf(LEAF)).toEqual([{ text: LEAF, form: "raw" }]);
    // a stray "%" is not URL encoding
    expect(formsOf("abc%zz").map((f) => f.form)).toEqual(["raw"]);
    const all = formsOf(` "a%2Bb" `);
    expect(all.map((f) => f.form)).toEqual(["stripped", "unquoted", "urldecoded", "raw"]);
  });
  test("a MIME-wrapped leaf is a suspect: hashes stripped then raw, bound from the stripped length", () => {
    const { flat, mime } = mimeOf(300);
    const body = JSON.stringify({ code: 0, data: mime });
    const s = suspectOf(new TextEncoder().encode(body), body);
    expect(s?.candidates).toEqual([
      {
        kind: "leaf",
        hashes: [
          { sha: sha(flat), form: "stripped" },
          { sha: sha(mime), form: "raw" },
        ],
        bound: Math.floor((flat.length * 3) / 4),
      },
    ]);
  });
  test("a MIME-wrapped, a quoted and a URL-encoded bare body are suspects (0.6-L2 missed all three)", () => {
    const { flat, mime } = mimeOf(300);
    const m = suspectOf(new TextEncoder().encode(mime + "\r\n"), mime + "\r\n");
    expect(m?.candidates[0]?.kind).toBe("bare");
    expect(m?.candidates[0]?.hashes.map((h) => h.form)).toEqual(["stripped", "raw"]);
    expect(m?.candidates[0]?.hashes[0]?.sha).toBe(sha(flat));
    const q = suspectOf(new TextEncoder().encode(`"${flat}"`), `"${flat}"`);
    expect(q?.candidates[0]?.hashes[0]).toEqual({ sha: sha(flat), form: "unquoted" });
    const enc = encodeURIComponent(flat);
    expect(enc).not.toBe(flat);
    const u = suspectOf(new TextEncoder().encode(enc), enc);
    expect(u?.candidates[0]?.hashes[0]).toEqual({ sha: sha(flat), form: "urldecoded" });
  });
  test("a strong row names the matched form; with stripped and raw both in scope the stripped form wins", () => {
    const { flat, mime } = mimeOf(300);
    const body = JSON.stringify({ code: 0, data: mime });
    const s = suspectOf(new TextEncoder().encode(body), body);
    if (s === null) throw new Error("not a suspect");
    const armed = { ...suspect("r-9", []), hashes: suspectShas(s, body) };
    const pt = { best: { text: PLAIN_ROWS, from: "console" as const }, oversize: false };
    const only = (scope: string[]) => {
      const r = observeRow(match({ attribution: attribute([armed], scope, utf8Bytes(PLAIN_ROWS)), scopeShas: scope, plaintext: pt }), 0);
      return "row" in r ? [r.row.evidence.match, r.row.evidence.matchForm, r.row.evidence.link] : r;
    };
    expect(only([sha(flat)])).toEqual([sha(flat), "stripped", "strong"]);
    expect(only([sha(mime)])).toEqual([sha(mime), "raw", "strong"]);
    expect(only([sha(mime), sha(flat)])).toEqual([sha(flat), "stripped", "strong"]);
    expect(only([sha(body)])).toEqual([sha(body), "raw", "strong"]); // the raw body text (axios)
    // weak rows carry no matchForm
    const w = observeRow(match({ attribution: attribute([armed], [], utf8Bytes(PLAIN_ROWS)), plaintext: pt }), 0);
    expect("row" in w && w.row.evidence.link === "weak" && w.row.evidence.matchForm === undefined).toBe(true);
  });
});

describe("0.6-Q B: the plaintext bound of a suspect", () => {
  test("tokenCore / tokenBound: hex /2, base64 floor(stripped × 3 / 4)", () => {
    const hex = "0a".repeat(40);
    expect(tokenCore(hex, 64)).toEqual({ core: hex, hex: true });
    expect(tokenBound({ core: hex, hex: true })).toBe(40);
    const { flat, mime } = mimeOf(100);
    expect(tokenCore(mime, 64)).toEqual({ core: flat, hex: false });
    expect(tokenBound({ core: flat, hex: false })).toBe(Math.floor((flat.length * 3) / 4));
    expect(Math.floor((flat.length * 3) / 4)).toBeGreaterThanOrEqual(100); // never below the true size
    expect(tokenCore("not a token at all, it has spaces and commas, many of them really", 64)).toBeNull();
  });
  test("a suspect's bound is the largest of its candidates (whole-body byte length included)", () => {
    const small = mimeOf(60).flat;
    const big = mimeOf(200).flat;
    const body = JSON.stringify({ a: small, b: big });
    const s = suspectOf(new TextEncoder().encode(body), body);
    expect(s?.bound).toBe(Math.floor((big.length * 3) / 4));
    const bytes = hot();
    const w = suspectOf(bytes, Buffer.from(bytes).toString("utf8"));
    expect(w?.bound).toBe(bytes.length);
  });
  test("a plaintext over the only suspect's bound is no-fit (real site: 64-byte ciphertext, 895-byte localStorage parse)", () => {
    const s = suspect("r-1", ["h"], 1000, 48);
    expect(fits(s, 48)).toBe(true);
    expect(fits(s, 49)).toBe(false);
    expect(fits(s, null)).toBe(true);
    expect(fits(suspect("r-2", ["h"], 1000, null), 10 ** 9)).toBe(true);
    const a = attribute([s], ["zz"], 895);
    expect(a).toEqual({ kind: "no-fit", live: ["r-1"] });
    const pt = { best: { text: "x".repeat(895), from: "console" as const }, oversize: false };
    expect(observeRow(match({ attribution: a, plaintext: pt }), 0)).toEqual({ skip: "no-fit" });
  });
  test("unfit suspects leave the weak and unattributed decisions; scope-string is not size-checked", () => {
    const A = suspect("r-1", ["ha"], 1000, 40);
    const B = suspect("r-2", ["hb"], 1000, 5000);
    const C = suspect("r-3", ["hc"], 1000, 9000);
    // two live, one fits: the fitting one is the only suspect left (weak)
    expect(attribute([A, B], ["zz"], 1000)).toEqual({ kind: "single-suspect", suspect: B });
    // three live, two fit: unattributed with the two as candidates
    expect(attribute([A, B, C], ["zz"], 1000)).toEqual({ kind: "unattributed", candidates: ["r-2", "r-3"] });
    // scope-string wins even over the bound (compressing sites keep their strong rows)
    expect(attribute([A, B], ["ha"], 1000)).toEqual({ kind: "scope-string", suspect: A });
    // unknown plaintext size: no filtering
    expect(attribute([A, B], ["zz"], null)).toEqual({ kind: "unattributed", candidates: ["r-1", "r-2"] });
  });
});

describe("0.6-Q C: settle of unattributed rows, the envelope race", () => {
  const ENV = '{"code":0,"data":"' + LEAF + '"}';
  const settling = (over: Partial<Settling>): Settling => ({ request: null, candidates: ["r-1", "r-2"], text: ENV, textSha: sha(ENV), at: 1, ...over });
  test("settleOutcome: a raw body is dropped at flush, weak rows of a filed request too, unattributed rows respect the cap", () => {
    const none = new Set<string>();
    expect(settleOutcome(settling({}), new Set([sha(ENV)]), none, 0, true)).toBe("rawBody");
    expect(settleOutcome(settling({}), none, none, 0, true)).toBe("file");
    expect(settleOutcome(settling({}), none, none, UNATTRIBUTED_CAP, true)).toBe("capped");
    expect(settleOutcome(settling({}), none, none, UNATTRIBUTED_CAP - 1, true)).toBe("file");
    const weak = settling({ request: "r-7", candidates: null, text: PLAIN_ROWS, textSha: sha(PLAIN_ROWS) });
    expect(settleOutcome(weak, none, new Set(["r-7"]), 0, true)).toBe("filed");
    expect(settleOutcome(weak, none, none, UNATTRIBUTED_CAP, true)).toBe("file"); // the cap is for unattributed rows only
  });
  test("dropRawBody: a body indexed after the parse drops the settling / held entries that are its text", () => {
    const list = [settling({}), settling({ text: PLAIN_ROWS, textSha: sha(PLAIN_ROWS) }), { ...settling({}), textSha: null }];
    const r = dropRawBody(list, sha(ENV));
    expect(r.dropped).toBe(1);
    expect(r.kept.map((x) => x.textSha)).toEqual([sha(PLAIN_ROWS), null]);
    expect(dropRawBody(list, sha("other")).dropped).toBe(0);
  });
});

describe("0.6-Q D: net body resolves the page view like analyze find (D4 rank, through the sidecar)", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tabcap-obs-netbody-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pageView = (blob: string, bytes: number, link: "strong" | "weak") => ({ by: "page", version: "observe/0", direction: "response", mime: "application/json", blob, bytes, ok: true, evidence: { sink: "JSON.parse", match: null, link, frames: [], at: 1 } });

  test("a page row is the view; an inline plugin view outranks it; a later plugin row too; none without a row", async () => {
    const dir = join(root, "b1");
    const store = new BlobStore(dir);
    const plain = await store.put(PLAIN_ROWS);
    const plug = await store.put('{"plugin":"view of the same body, longer than 32"}');
    if (plain.outcome !== "stored" || plug.outcome !== "stored") throw new Error("blob not stored");
    expect(decodedEntry({ id: "r-3" }, dir, store)).toBeNull();
    appendSidecar(dir, { seq: 1, request: "r-3", direction: "response", decoded: pageView(plain.ref, plain.size, "weak"), at: 1 });
    expect(decodedEntry({ id: "r-3" }, dir, store)).toEqual({ by: "page", version: "observe/0", mime: "application/json", blob: plain.ref, link: "weak" });
    // another request's row is not this one's view
    expect(decodedEntry({ id: "r-4" }, dir, store)).toBeNull();
    // an ok plugin view recorded inline beats the later page row (D4)
    const inline = { by: "xor-decode", version: "1", mime: "application/json", blob: plug.ref, bytes: plug.size };
    expect(decodedEntry({ id: "r-3", decoded: inline }, dir, store)?.by).toBe("xor-decode");
    // a plugin row in the sidecar (bundle decode) beats the page row whatever the order
    appendSidecar(dir, { seq: 2, request: "r-3", direction: "response", decoded: { by: "xor-decode", version: "1", direction: "response", mime: "application/json", blob: plug.ref, bytes: plug.size, ok: true }, at: 2 });
    appendSidecar(dir, { seq: 3, request: "r-3", direction: "response", decoded: pageView(plain.ref, plain.size, "strong"), at: 3 });
    expect(decodedEntry({ id: "r-3" }, dir, store)?.by).toBe("xor-decode");
  });
  test("a page row whose blob is missing is no view (decodedPayload)", () => {
    const dir = join(root, "b2");
    const store = new BlobStore(dir);
    mkdirSync(dir, { recursive: true });
    appendSidecar(dir, { seq: 1, request: "r-1", direction: "response", decoded: pageView(`sha256:${"e".repeat(64)}`, 10, "strong"), at: 1 });
    expect(decodedEntry({ id: "r-1" }, dir, store)).toBeNull();
  });
  test("no view: `next` names `trace start --decode` only for a body the observe mode would arm on", () => {
    const enc = new TextEncoder().encode('{"code":0,"data":"' + LEAF + '"}');
    const plain = new TextEncoder().encode(PLAIN_ROWS);
    for (const recording of [true, false]) {
      const e = noDecodedView("r-2", enc, recording);
      expect([e.code, e.message]).toEqual(["not-found", "request r-2 has no decoded view"]);
      expect(e.next).toContain("trace start --decode");
      expect(e.next).toContain("plugin list");
    }
    expect(noDecodedView("r-2", plain, true).next).not.toContain("--decode");
    expect(noDecodedView("r-2", null, false).next).not.toContain("--decode");
  });
});

describe("0.6-V: weak rows can be turned off; evidence frames carry the script URL", () => {
  const PLAIN = '{"rows":[{"id":"S59-0001","amount":12}],"total":1,"page":1}';
  const weak: Settling = { request: "r-7", candidates: null, text: PLAIN, textSha: sha(PLAIN), at: 1 };
  const none = new Set<string>();
  test("settleOutcome: a weak row that would be filed is `weak` (drops.weak) when weakRows is off", () => {
    expect(settleOutcome(weak, none, none, 0, false)).toBe("weak");
    expect(settleOutcome(weak, none, none, 0, true)).toBe("file");
    // only rows that would have been filed count as weak
    expect(settleOutcome(weak, new Set([sha(PLAIN)]), none, 0, false)).toBe("rawBody");
    expect(settleOutcome(weak, none, new Set(["r-7"]), 0, false)).toBe("filed");
    // unattributed rows are not weak rows: filed either way
    const un: Settling = { ...weak, request: null, candidates: ["r-1", "r-2"] };
    expect(settleOutcome(un, none, none, 0, false)).toBe("file");
  });
  test("frameScriptId reads location.scriptId (a call frame has no top-level scriptId)", () => {
    expect(frameScriptId({ location: { scriptId: "12", lineNumber: 1, columnNumber: 2 } })).toBe("12");
    expect(frameScriptId({ scriptId: "12" })).toBeNull();
    expect(frameScriptId({})).toBeNull();
  });
  test("evidenceFrames: the frame's own url first, the scriptParsed map second, else empty; at most 5", () => {
    const map = new Map([["12", "https://t/app.js"], ["13", "https://t/other.js"]]);
    const f = (url: string | undefined, id: string, line: number, fn: string) => ({ callFrameId: `cf-${line}`, functionName: fn, ...(url === undefined ? {} : { url }), location: { scriptId: id, lineNumber: line, columnNumber: 4 } });
    const out = evidenceFrames([f("https://t/own.js", "12", 1, "a"), f("", "13", 2, ""), f(undefined, "99", 3, "c"), f("", "12", 4, "d"), f("", "12", 5, "e"), f("", "12", 6, "f")], (id) => map.get(id));
    expect(out).toEqual([
      { url: "https://t/own.js", line: 1, column: 4, function: "a" },
      { url: "https://t/other.js", line: 2, column: 4, function: "(anonymous)" },
      { url: "", line: 3, column: 4, function: "c" },
      { url: "https://t/app.js", line: 4, column: 4, function: "d" },
      { url: "https://t/app.js", line: 5, column: 4, function: "e" },
    ]);
  });
});

describe("0.6-W: hold without a scope-string match, decide after the grace", () => {
  const T = 1_000_000;
  test("the constants: grace 1.5 s, hold 10 s, at most 256 held", () => {
    expect([GRACE_MS, HOLD_MS, HOLD_MAX]).toEqual([1500, 10_000, 256]);
  });
  test("heldVerdict: scope-string at once; others after the grace; no suspect waits; force decides, no suspect is an orphan", () => {
    for (const force of [false, true]) expect(heldVerdict("scope-string", T, T, force, true)).toBe("decide");
    for (const kind of ["single-suspect", "unattributed", "no-fit"] as const) {
      expect([kind, heldVerdict(kind, T, T, false, true)]).toEqual([kind, "wait"]);
      expect([kind, heldVerdict(kind, T, T + GRACE_MS - 1, false, true)]).toEqual([kind, "wait"]);
      expect([kind, heldVerdict(kind, T, T + GRACE_MS, false, true)]).toEqual([kind, "decide"]);
      expect([kind, heldVerdict(kind, T, T, true, true)]).toEqual([kind, "decide"]);
      // nothing readable to file: the suspect it meets does not matter, no wait
      expect([kind, heldVerdict(kind, T, T, false, false)]).toEqual([kind, "decide"]);
    }
    expect(heldVerdict("armed-empty", T, T + HOLD_MS, false, true)).toBe("wait");
    expect(heldVerdict("armed-empty", T, T, true, true)).toBe("orphan");
    expect(heldVerdict("armed-empty", T, T, true, false)).toBe("orphan");
  });
  test("heldWaits: each grace end still ahead, and each hold end", () => {
    expect(heldWaits([{ at: T }, { at: T - 2000 }], T + 100)).toEqual([T + GRACE_MS, T + HOLD_MS, T - 2000 + HOLD_MS]);
    expect(heldWaits([], T)).toEqual([]);
  });

  /** A held pause: the shas in its scope, its plaintext's size. */
  type H = { name: string; at: number; scope: string[]; bytes: number };
  const label = (h: H, a: Attribution): string => {
    if (a.kind === "scope-string" || a.kind === "single-suspect") return h.name + ":" + a.kind + ":" + a.suspect.request;
    if (a.kind === "unattributed") return h.name + ":" + a.kind + ":" + a.candidates.join("+");
    return h.name + ":" + a.kind;
  };
  /** passHeld over an Armed list, the way the tracer runs it; what happened, in order. */
  const run = async (held: H[], armed: Armed, now: number, force: boolean, onDecide?: (a: Attribution) => void) => {
    const list = [...held];
    const log: string[] = [];
    await passHeld({
      entries: [...list],
      still: (h) => list.includes(h),
      judge: (h) => {
        armed.expire(now);
        const a = attribute(armed.live(), h.scope, h.bytes);
        return { kind: a.kind, hasPlaintext: true, ctx: a };
      },
      take: (h) => {
        list.splice(list.indexOf(h), 1);
      },
      decide: async (h, a) => {
        log.push(label(h, a));
        onDecide?.(a);
        await Promise.resolve();
      },
      orphan: (h) => {
        log.push(h.name + ":orphan");
      },
      now: () => now,
      force,
    });
    return { log, left: list.map((h) => h.name) };
  };
  const arm = (a: Armed, request: string, shas: string[], at: number, bound: number | null = 5000) => a.arm({ request, url: "https://t/api", at, hashes: raws(shas), bound });

  test("the XHR race: three lingering suspects live, the pause waits; its own arm lands in the grace and decides it strong", async () => {
    const armed = new Armed();
    for (const n of [1, 2, 3]) arm(armed, "r-" + n, ["linger-" + n], T - 300);
    const xhr: H = { name: "xhr", at: T, scope: ["xhr-data"], bytes: 600 };
    // on the spot (before 0.6-W) this pause was unattributed r-1+r-2+r-3
    expect(attribute(armed.live(), xhr.scope, xhr.bytes)).toEqual({ kind: "unattributed", candidates: ["r-1", "r-2", "r-3"] });
    expect(await run([xhr], armed, T, false)).toEqual({ log: [], left: ["xhr"] });
    // its own body is indexed 40 ms later: the arm's pass decides it strong
    arm(armed, "r-4", ["xhr-data"], T + 40);
    expect(await run([xhr], armed, T + 40, false)).toEqual({ log: ["xhr:scope-string:r-4"], left: [] });
  });
  test("no own arm within the grace: decided against the suspects live at the grace end (weak / no-fit as before)", async () => {
    const armed = new Armed();
    arm(armed, "r-1", ["a"], T, 5000);
    arm(armed, "r-2", ["b"], T, 100);
    const p: H = { name: "p", at: T, scope: [], bytes: 600 };
    expect(await run([p], armed, T + GRACE_MS - 1, false)).toEqual({ log: [], left: ["p"] });
    expect(await run([p], armed, T + GRACE_MS, false)).toEqual({ log: ["p:single-suspect:r-1"], left: [] });
    const big: H = { name: "big", at: T, scope: [], bytes: 9000 };
    expect(await run([big], armed, T + GRACE_MS, false)).toEqual({ log: ["big:no-fit"], left: [] });
  });
  test("oldest first, each judged against the suspects of its own turn (a filed row forgot its suspect)", async () => {
    const armed = new Armed();
    arm(armed, "r-1", ["a"], T);
    arm(armed, "r-2", ["b"], T);
    const first: H = { name: "first", at: T, scope: ["a"], bytes: 100 };
    const second: H = { name: "second", at: T + 1, scope: [], bytes: 100 };
    const out = await run([first, second], armed, T + GRACE_MS + 1, false, (a) => {
      if (a.kind === "scope-string" || a.kind === "single-suspect") armed.forget(a.suspect.request);
    });
    expect(out).toEqual({ log: ["first:scope-string:r-1", "second:single-suspect:r-2"], left: [] });
  });
  test("an entry another path took meanwhile (raw-body drop, concurrent pass) is skipped", async () => {
    const armed = new Armed();
    arm(armed, "r-1", ["a"], T);
    const a: H = { name: "a", at: T, scope: ["a"], bytes: 10 };
    const b: H = { name: "b", at: T, scope: ["a"], bytes: 10 };
    const list = [a, b];
    const seen: string[] = [];
    await passHeld({
      entries: [...list],
      still: (h) => list.includes(h),
      judge: (h) => ({ kind: attribute(armed.live(), h.scope, h.bytes).kind, hasPlaintext: true, ctx: null }),
      take: (h) => {
        list.splice(list.indexOf(h), 1);
        if (h === a) list.splice(list.indexOf(b), 1); // b is dropped while a is decided
      },
      decide: async (h) => {
        seen.push(h.name);
      },
      orphan: () => undefined,
      now: () => T,
      force: false,
    });
    expect(seen).toEqual(["a"]);
  });
  test("forced (trace / recording stop): everything pending is decided; no live suspect then is an orphan (s59 noise's localStorage parse)", async () => {
    const armed = new Armed();
    arm(armed, "r-1", ["a"], T, 5000);
    const inGrace: H = { name: "inGrace", at: T, scope: [], bytes: 100 };
    expect(await run([inGrace], armed, T + 10, true)).toEqual({ log: ["inGrace:single-suspect:r-1"], left: [] });
    // both noise suspects were filed strong (forgotten) before the grace ended: nothing left to meet
    const local: H = { name: "local", at: T, scope: [], bytes: 1200 };
    const empty = new Armed();
    expect(await run([local], empty, T + GRACE_MS + 10, false)).toEqual({ log: [], left: ["local"] });
    expect(await run([local], empty, T + GRACE_MS + 10, true)).toEqual({ log: ["local:orphan"], left: [] });
  });
});
