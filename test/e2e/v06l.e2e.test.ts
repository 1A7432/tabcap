// L2 for 0.6-L: in-page decoding, observe mode (Chrome for Testing, the real
// daemon, docs/05 s59). `trace start --decode` keeps three sinks up on every
// realm (the design fix of 10-16: arming from the index push loses the race
// with the page's own first decrypt; a scriptFirstStatement install wins it);
// a response that looks like ciphertext arms a 5 s window, and the plaintext
// the page itself parses is filed into the bundle's decoded.jsonl sidecar as
// a view by:"page" (0.6-B's shape, docs/04 §33); find / where search it
// through the built-in step `page`.
// Oracle: the range pages (test/e2e/site.ts S59_*; the plaintext literals
// S59_PLAIN / S59_PLAIN2 and the data-base64 of S59_ENC_* are read off the
// served bodies, never off tabcap; the control /api/plain carries no view).
// The pausing-scope attribution shape (spike exp3: the walk hits the data
// local per JSON.parse pause) is asserted as the sha256 of that base64.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BundleReader } from "../../src/bundle/reader.ts";
import { parseSidecarText } from "../../src/bundle/decoded.ts";
import { isRecord } from "../../src/shared/json.ts";
import { S59_ENC_GCM, S59_ENC_GCM2, S59_ENC_XOR, S59_PLAIN, S59_PLAIN2, startInPageDecodeSite, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
/** The `data` field of a served /api/enc body, read off the literal (the oracle). */
function s59Data(body: string): string {
  const v: unknown = JSON.parse(body);
  return isRecord(v) && typeof v["data"] === "string" ? v["data"] : (() => {
    throw new Error("s59 body without a data leaf");
  })();
}
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GCM1_DATA = s59Data(S59_ENC_GCM);
const GCM2_DATA = s59Data(S59_ENC_GCM2);
const XOR_DATA = s59Data(S59_ENC_XOR);

let home = "";
let site: Site;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown>; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: {}, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: isRecord(env["data"]) ? env["data"] : {}, error: isRecord(env["error"]) ? env["error"] : {}, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

async function until<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  for (;;) {
    last = await get();
    if (done(last)) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await Bun.sleep(150);
  }
}

type SidecarRow = { seq: number; request: string | null; decoded: Record<string, unknown> };
const sidecarRows = (bundle: string): SidecarRow[] => {
  const p = join(bundle, "decoded.jsonl");
  if (!existsSync(p)) return [];
  return parseSidecarText(readFileSync(p, "utf8")).entries.map((e) => ({ seq: e.seq, request: e.request, decoded: e.decoded }));
};
/** The plaintext of a view's blob, or null. */
const viewText = (reader: BundleReader, view: Record<string, unknown> | undefined): string | null =>
  view === undefined || typeof view["blob"] !== "string" ? null : new TextDecoder().decode(reader.readBlob(view["blob"]) ?? new Uint8Array());

/** One walk of a /s59 variant in a fresh session, trace started with the given flags. */
async function runPage(session: string, path: string, flags: string[] = []): Promise<{ bundle: string; enc: Array<{ id: string; query: string }> }> {
  const S = ["--session", session];
  const started = await ok("net", "start", ...S);
  const bundle = s(started["bundle"]);
  const tr = await ok("trace", "start", ...flags, ...S);
  if (flags.includes("--decode")) expect(tr["decode"]).toBeDefined();
  await ok("navigate", `${site.origin}${path}`, ...S);
  await ok("wait", "--text", "ready s59-plain-control", ...S);
  const enc: Array<{ id: string; query: string }> = [];
  for (const query of path.includes("two=1") ? ["slot=1", "slot=2"] : ["/api/enc"]) {
    const waited = await ok("net", "wait", "--url", query, ...S);
    enc.push({ id: s(waited["id"]), query });
  }
  return { bundle, enc };
}

const stopBoth = async (session: string): Promise<{ decode: Record<string, unknown> | undefined }> => {
  const S = ["--session", session];
  const stopped = await ok("trace", "stop", ...S);
  await ok("net", "stop", ...S);
  return { decode: rec(stopped["decode"]) };
};

describe.skipIf(!enabled)("tabcap 0.6-L L2 (in-page decoding, observe mode on docs/05 s59)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e6l-"));
    site = startInPageDecodeSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("s59 xor: the plaintext the page parses is filed by \"page\"; /api/plain stays raw; find reads the view, where resolves through it", async () => {
    const S = ["--session", "s59x"];
    const { bundle, enc } = await runPage("s59x", "/s59", ["--decode"]);
    const encId = enc[0]?.id ?? "";

    // The sidecar: one attributed response row (docs/04 §33).
    const rows = await until("the page row in decoded.jsonl", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    expect(rows.length).toBe(1);
    const r = rows[0] as SidecarRow;
    expect([r.seq, r.request, r.decoded["by"], r.decoded["version"], r.decoded["direction"], r.decoded["ok"], r.decoded["mime"]]).toEqual([1, encId, "page", "observe/0", "response", true, "application/json"]);
    // The row is the whole plaintext, and the evidence says which scope string matched (spike exp3).
    const reader = BundleReader.open(bundle);
    expect(viewText(reader, r.decoded)).toBe(S59_PLAIN);
    expect(r.decoded["bytes"]).toBe(new TextEncoder().encode(S59_PLAIN).length);
    const ev = rec(r.decoded["evidence"]);
    expect(ev["sink"]).toBe("JSON.parse");
    expect(ev["match"]).toBe(sha(XOR_DATA));
    expect(ev["candidates"]).toBeUndefined();
    expect(recs(ev["frames"]).length).toBeGreaterThanOrEqual(1);
    expect(s(r.decoded["blob"])).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The control: plain JSON the page parses too — no row, no view.
    const plainList = recs((await ok("net", "list", "--filter", "/api/plain", ...S))["requests"]);
    expect(plainList.length).toBe(1);
    expect(plainList[0]?.["decoded"]).toBeUndefined();

    // live `where` resolves the visible id through the view (chain step "page").
    const w = await ok("where", "S59-0001", "--as", "text", ...S);
    expect(recs(w["candidates"])).toEqual([{ request: encId, path: "$.rows[0].id", chain: ["page"], match: "exact", score: 1 }]);

    const { decode } = await stopBoth("s59x");
    expect(decode).toMatchObject({ armed: 0, rows: { attributed: 1, unattributed: 0, unattributedKept: 0 }, sinks: { on: true } });

    // The offline reader overlays the sidecar row; `find` searches it.
    const flat = async (v: string) => recs((await ok("analyze", "find", bundle, v))["hits"]).map((h) => ({ ref: h["ref"], part: h["part"], decode: h["decode"], path: h["path"] }));
    expect(await flat("S59-0001")).toEqual([{ ref: encId, part: "response", decode: ["page"], path: "$.rows[0].id" }]);
    // The control stays its own raw response — findable, but by its own body.
    expect((await flat("s59-plain-control")).length).toBe(1);
  }, 120_000);

  test("s59 webcrypto: attributed through the byte buffer too, the two crypto sinks count as evidence", async () => {
    const S = ["--session", "s59w"];
    const { bundle, enc } = await runPage("s59w", "/s59?mode=webcrypto", ["--decode"]);
    const encId = enc[0]?.id ?? "";
    const rows = await until("the page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    expect(rows.length).toBe(1);
    const r = rows[0] as SidecarRow;
    expect(r.request).toBe(encId);
    expect(viewText(BundleReader.open(bundle), r.decoded)).toBe(S59_PLAIN);
    expect(rec(r.decoded["evidence"])["match"]).toBe(sha(GCM1_DATA));

    const { decode } = await stopBoth("s59w");
    // TextDecoder.decode and SubtleCrypto.decrypt paused and were counted, nothing read off them (D1).
    expect(Number(decode?.["evidenceHits"] ?? 0)).toBeGreaterThanOrEqual(2);
    expect(decode?.["rows"]).toMatchObject({ attributed: 1, unattributed: 0 });
  }, 120_000);

  test("s59 two=1: two armed suspects, two plaintexts, each attributed to its own response", async () => {
    const S = ["--session", "s59t"];
    const { bundle, enc } = await runPage("s59t", "/s59?mode=webcrypto&two=1", ["--decode"]);
    // The r-ids of the two encrypted responses, by their slot query.
    const bySlot = new Map(enc.map((e) => [e.query, e.id]));
    const rows = await until("both page rows", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 2);
    expect(rows.length).toBe(2);
    const reader = BundleReader.open(bundle);
    const plainByRequest = new Map<string, string | null>();
    for (const row of rows) {
      expect(row.request).not.toBeNull();
      expect(row.decoded["by"]).toBe("page");
      plainByRequest.set(s(row.request), viewText(reader, row.decoded));
    }
    // slot=1 served S59_PLAIN, slot=2 served S59_PLAIN2 (site.ts, the oracle), each row got its own.
    expect(plainByRequest.get(bySlot.get("slot=1") ?? "")).toBe(S59_PLAIN);
    expect(plainByRequest.get(bySlot.get("slot=2") ?? "")).toBe(S59_PLAIN2);
    const matches = rows.map((row) => s(rec(row.decoded["evidence"])["match"])).sort();
    expect(matches).toEqual([sha(GCM1_DATA), sha(GCM2_DATA)].sort());

    const { decode } = await stopBoth("s59t");
    expect(decode?.["rows"]).toMatchObject({ attributed: 2, unattributed: 0 });
    // The envelope parses (JSON.parse of the {"code":0,"data":…} wrapper per
    // fetch) count as plaintextMissing: no plaintext in their scopes.
    expect(decode?.["drops"]).toMatchObject({ unattributedCapped: 0 });
  }, 120_000);

  test("without --decode: the page still decrypts, nothing is armed, the plaintext stays out of reach", async () => {
    const S = ["--session", "s59o"];
    const started = await ok("net", "start", ...S);
    const bundle = s(started["bundle"]);
    const tr = await ok("trace", "start", ...S);
    expect(tr["decode"]).toBeUndefined();
    await ok("navigate", `${site.origin}/s59`, ...S);
    await ok("wait", "--text", "ready s59-plain-control", ...S);
    await ok("net", "wait", "--url", "/api/enc", ...S);
    await Bun.sleep(400);
    const stopped = await ok("trace", "stop", ...S);
    expect(stopped["decode"]).toBeUndefined();
    await ok("net", "stop", ...S);
    expect(sidecarRows(bundle)).toEqual([]);
    expect(existsSync(join(bundle, "decoded.jsonl"))).toBe(false);
    // The plaintext exists only inside the page; the bundle has the ciphertext only.
    const out = await ok("analyze", "find", bundle, "S59-0001");
    expect(recs(out["hits"])).toEqual([]);
    // The control stays findable (the page's plain JSON) — the recording itself is sound.
    expect(recs((await ok("analyze", "find", bundle, "s59-plain-control"))["hits"]).length).toBe(1);
  }, 120_000);
});