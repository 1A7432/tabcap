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
// 0.6-L2 (owner decisions 10-16): the plaintext arrives through the
// JSON.parse log-point; `evidence.link` is "strong" when the parsing frame
// can reach the ciphertext (a local, a block / closure variable, or a plain
// object's property one level down — read off the range page's source) and
// "weak" when it cannot (s59 deferred: the parse runs in a timer callback that
// is its only frame); `--decode` installs no signal breakpoints.
// 0.6-Q (docs/04 §33 0.6-Q, docs/05 s59 mime / noise / race): a MIME-wrapped
// leaf matches in its whitespace-stripped form (`evidence.matchForm`), a
// ≥ 1 KB localStorage parse is not filed under two small armed suspects
// (`drops.noFit`), no row is an envelope the page parsed early; `net body`
// reads the page view (default and --decoded, during and after recording).
// 0.6-V (owner decisions 10-17): weak rows can be turned off (config.json
// `trace.weakRows`, default true): by default s59 deferred files its weak row
// as before; with `trace.weakRows: false` no row and `drops.weak: 1`. The evidence
// frames carry the script URL: every s59 parse runs in the page's inline
// script (worker mode too — the worker posts the plaintext string back and
// the main thread's onmessage parses it, test/e2e/site.ts s59Worker), whose
// URL is the document URL.
// 0.6-W (owner decision A 10-17): a pause without a scope-string match waits
// a 1.5 s grace for its own arm before it is decided against the suspects
// live then. s59 `mode=xhr` parses in an XMLHttpRequest onload (before tabcap
// indexes the body); with `&linger=3` three encrypted responses the page never
// parses are live suspects at that moment — before the fix the plaintext was
// filed unattributed with those three as candidates; now it is strong. trace
// stop's decode block is read after the stop (the forced decisions count).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BundleReader } from "../../src/bundle/reader.ts";
import { parseSidecarText } from "../../src/bundle/decoded.ts";
import { isRecord } from "../../src/shared/json.ts";
import {
  S59_BARE_XOR,
  S59_BIG_MARKER,
  S59_ENC_GCM,
  S59_ENC_GCM2,
  S59_ENC_MIME,
  S59_ENC_NOISE1,
  S59_ENC_NOISE2,
  S59_ENC_RACE1,
  S59_ENC_RACE2,
  S59_ENC_XOR,
  S59_LINGER_PLAINS,
  S59_NOISE_LOCAL,
  S59_NOISE_PLAIN1,
  S59_NOISE_PLAIN2,
  S59_PLAIN,
  S59_PLAIN2,
  S59_RACE_PLAIN1,
  S59_RACE_PLAIN2,
  s59BigPlain,
  startInPageDecodeSite,
  type Site,
} from "./site.ts";

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
/** The url of a page row's top evidence frame. */
const topFrameUrl = (decoded: Record<string, unknown> | undefined): unknown => recs(rec(decoded?.["evidence"])["frames"])[0]?.["url"];
/** config.json in the test home (read by every `trace start`). */
const writeConfig = (v: Record<string, unknown>): void => {
  mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config", "config.json"), JSON.stringify(v) + "\n");
};

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
async function runPage(session: string, path: string, flags: string[] = [], queries?: string[]): Promise<{ bundle: string; enc: Array<{ id: string; query: string }>; tr: Record<string, unknown> }> {
  const S = ["--session", session];
  const started = await ok("net", "start", ...S);
  const bundle = s(started["bundle"]);
  const tr = await ok("trace", "start", ...flags, ...S);
  if (flags.includes("--decode")) expect(tr["decode"]).toBeDefined();
  await ok("navigate", `${site.origin}${path}`, ...S);
  await ok("wait", "--text", "ready s59-plain-control", ...S);
  const enc: Array<{ id: string; query: string }> = [];
  for (const query of queries ?? (path.includes("two=1") ? ["slot=1", "slot=2"] : ["/api/enc"])) {
    const waited = await ok("net", "wait", "--url", query, ...S);
    enc.push({ id: s(waited["id"]), query });
  }
  return { bundle, enc, tr };
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
    const { bundle, enc, tr } = await runPage("s59x", "/s59", ["--decode"]);
    const encId = enc[0]?.id ?? "";
    // 0.6-L2: the observe mode traces no signals — no API list, no API
    // breakpoints, only the scriptFirstStatement install channel.
    expect([tr["requested"], tr["active"]]).toEqual([0, []]);
    const st = await ok("trace", "status", ...S);
    expect(st["instrumentation"]).toEqual([]);
    expect(recs(st["targets"]).every((t) => t["breakpoints"] === 0)).toBe(true);

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
    expect(ev["link"]).toBe("strong");
    expect(ev["candidates"]).toBeUndefined();
    expect(recs(ev["frames"]).length).toBeGreaterThanOrEqual(1);
    // 0.6-V: the parse runs in the page's inline script; its URL is the document URL.
    expect(topFrameUrl(r.decoded)).toBe(`${site.origin}/s59`);
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
    expect(rec(r.decoded["evidence"])["link"]).toBe("strong");

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
    const encId = s((await ok("net", "wait", "--url", "/api/enc", ...S))["id"]);
    await Bun.sleep(400);
    const stopped = await ok("trace", "stop", ...S);
    expect(stopped["decode"]).toBeUndefined();
    await ok("net", "stop", ...S);
    expect(sidecarRows(bundle)).toEqual([]);
    expect(existsSync(join(bundle, "decoded.jsonl"))).toBe(false);
    // 0.6-Q: `net body --decoded` without a view points an encrypted body to the observe mode.
    const nb = await tabcap(["net", "body", encId, "--decoded", ...S]);
    expect([nb.ok, nb.error["code"]]).toEqual([false, "not-found"]);
    expect(s(nb.error["next"])).toContain("trace start --decode");
    // The plaintext exists only inside the page; the bundle has the ciphertext only.
    const out = await ok("analyze", "find", bundle, "S59-0001");
    expect(recs(out["hits"])).toEqual([]);
    // The control stays findable (the page's plain JSON) — the recording itself is sound.
    expect(recs((await ok("analyze", "find", bundle, "s59-plain-control"))["hits"]).length).toBe(1);
  }, 120_000);

  test("s59 axios / inline / worker: the log-point captures a temporary plaintext; the envelope stays out of the view", async () => {
    for (const mode of ["axios", "inline", "worker"] as const) {
      const session = `s59-${mode}`;
      const S = ["--session", session];
      const { bundle, enc } = await runPage(session, `/s59?mode=${mode}`, ["--decode"]);
      const rows = await until(`${mode} page row`, () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.some((r) => viewText(BundleReader.open(bundle), r.decoded) === S59_PLAIN));
      const reader = BundleReader.open(bundle);
      const hit = rows.find((r) => viewText(reader, r.decoded) === S59_PLAIN);
      expect(hit?.request).toBe(enc[0]?.id);
      expect(hit?.decoded["by"]).toBe("page");
      // 0.6-L2: each parsing frame reaches the ciphertext leaf — axios'
      // s59Axios holds `env` (and the raw text), inline's s59Enc block holds
      // `env`, worker's onmessage arrow closes over s59Worker's `data` (its
      // executor uses it) — so the link is strong and the match is the leaf.
      expect([mode, rec(hit?.decoded["evidence"])["link"], rec(hit?.decoded["evidence"])["match"]]).toEqual([mode, "strong", sha(XOR_DATA)]);
      // 0.6-V: every mode parses in the page's inline script (worker: the main
      // thread's onmessage parses the string the worker posted), so the top
      // frame's URL is the document URL.
      expect([mode, topFrameUrl(hit?.decoded)]).toEqual([mode, `${site.origin}/s59?mode=${mode}`]);
      // No sidecar row is the raw envelope (the axios-shape bug of 0.6-L).
      for (const r of rows) expect(viewText(reader, r.decoded)).not.toBe(S59_ENC_XOR);
      const { decode } = await stopBoth(session);
      expect(Number(rec(decode?.["rows"])["attributed"] ?? 0)).toBeGreaterThanOrEqual(1);
      expect(recs((await ok("analyze", "find", bundle, "S59-0001"))["hits"]).some((h) => h["decode"] !== undefined && JSON.stringify(h["decode"]).includes("page"))).toBe(true);
    }
  }, 180_000);

  test("s59 bare: a whole-body base64 token (below the entropy rule) is a suspect and the plaintext is attributed", async () => {
    const S = ["--session", "s59b"];
    const { bundle, enc } = await runPage("s59b", "/s59?mode=bare", ["--decode"]);
    const rows = await until("the bare page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    const reader = BundleReader.open(bundle);
    const hit = rows.find((r) => viewText(reader, r.decoded) === S59_PLAIN);
    expect(hit?.request).toBe(enc[0]?.id);
    expect(rec(hit?.decoded["evidence"] ?? {})["match"]).toBe(sha(S59_BARE_XOR));
    expect(rec(hit?.decoded["evidence"] ?? {})["link"]).toBe("strong");
    await stopBoth("s59b");
    expect(recs((await ok("analyze", "find", bundle, "S59-0001"))["hits"]).length).toBe(1);
  }, 120_000);

  test("s59 big: a plaintext over the old 1 MiB cap is filed (new cap 16 MiB)", async () => {
    const S = ["--session", "s59g"];
    const { bundle, enc } = await runPage("s59g", "/s59?mode=big", ["--decode"]);
    const want = s59BigPlain();
    const rows = await until("the big page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.some((r) => viewText(BundleReader.open(bundle), r.decoded) === want), 30_000);
    const reader = BundleReader.open(bundle);
    const hit = rows.find((r) => viewText(reader, r.decoded) === want);
    expect(hit?.request).toBe(enc[0]?.id);
    expect(hit?.decoded["bytes"]).toBe(new TextEncoder().encode(want).length);
    expect(want.length).toBeGreaterThan(1024 * 1024);
    expect(want).toContain(S59_BIG_MARKER);
    await stopBoth("s59g");
    expect(recs((await ok("analyze", "find", bundle, S59_BIG_MARKER))["hits"]).some((h) => JSON.stringify(h["decode"] ?? []).includes("page"))).toBe(true);
  }, 180_000);

  test("s59 deferred: no ciphertext reachable from the parse — filed under the only armed suspect, link weak, and find says so (default trace.weakRows true)", async () => {
    const { bundle, enc, tr } = await runPage("s59d", "/s59?mode=deferred", ["--decode"]);
    expect(tr["weakRows"]).toBe(true);
    const rows = await until("the deferred page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    expect(rows.length).toBe(1);
    const r = rows[0] as SidecarRow;
    expect(r.request).toBe(enc[0]?.id ?? "");
    expect(viewText(BundleReader.open(bundle), r.decoded)).toBe(S59_PLAIN);
    const ev = rec(r.decoded["evidence"]);
    expect([ev["match"], ev["link"]]).toEqual([null, "weak"]);
    expect(topFrameUrl(r.decoded)).toBe(`${site.origin}/s59?mode=deferred`);
    const { decode } = await stopBoth("s59d");
    expect(decode?.["rows"]).toMatchObject({ attributed: 1, weak: 1, unattributed: 0 });
    expect(rec(decode?.["drops"])["weak"]).toBe(0);
    const hits = recs((await ok("analyze", "find", bundle, "S59-0001"))["hits"]);
    expect(hits.map((h) => [h["ref"], h["decode"], h["link"]])).toEqual([[enc[0]?.id ?? "", ["page"], "weak"]]);
  }, 120_000);

  test("s59 deferred, trace.weakRows false (0.6-V): the weak plaintext files no row and is counted as drops.weak", async () => {
    writeConfig({ trace: { weakRows: false } });
    try {
      const S = ["--session", "s59dd"];
      const { bundle, tr } = await runPage("s59dd", "/s59?mode=deferred", ["--decode"]);
      expect(tr["weakRows"]).toBe(false);
      expect(s(tr["decodeNotice"])).toContain("drops.weak");
      // the weak row settles (500 ms) and is then counted, not filed
      const st = await until("drops.weak in trace status", () => ok("trace", "status", ...S), (v) => Number(rec(rec(v["decode"])["drops"])["weak"] ?? 0) >= 1);
      expect(st["weakRows"]).toBe(false);
      const { decode } = await stopBoth("s59dd");
      expect(rec(decode?.["drops"])["weak"]).toBe(1);
      expect(decode?.["rows"]).toMatchObject({ attributed: 0, weak: 0, unattributed: 0 });
      expect(sidecarRows(bundle)).toEqual([]);
      expect(recs((await ok("analyze", "find", bundle, "S59-0001"))["hits"])).toEqual([]);
    } finally {
      writeConfig({});
    }
  }, 120_000);

  test("--decode with --apis is a usage error (the observe mode installs no signal breakpoints)", async () => {
    const e = await tabcap(["trace", "start", "--decode", "--apis", join(home, "signals.json"), "--session", "s59u"]);
    expect(e.ok).toBe(false);
    expect(e.error["code"]).toBe("usage");
  }, 60_000);

  test("a page loaded before trace start --decode, recording started after it: the sinks are on the loaded page", async () => {
    const S = ["--session", "s59l"];
    await ok("navigate", `${site.origin}/s59`, ...S);
    await ok("wait", "--text", "ready s59-plain-control", ...S);
    // 0.6-L2: before the fix the sinks of an already loaded page came only with its next document.
    await ok("trace", "start", "--decode", ...S);
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    // The page decrypts again from its own timer callback (s59Main is the page's function).
    await ok("evaluate", 'setTimeout(s59Main, 0, "xor"), 1', ...S);
    const encId = s((await ok("net", "wait", "--url", "/api/enc", ...S))["id"]);
    const rows = await until("the reloaded page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    expect(rows.map((r) => [r.request, viewText(BundleReader.open(bundle), r.decoded), rec(r.decoded["evidence"])["link"]])).toEqual([[encId, S59_PLAIN, "strong"]]);
    // 0.6-V: the inline script was parsed before the tracer attached; its URL still reaches the evidence.
    expect(topFrameUrl(rows[0]?.decoded)).toBe(`${site.origin}/s59`);
    await stopBoth("s59l");
  }, 120_000);

  // ------------------------------------------------------------ 0.6-Q

  /** `net body` of a request: the view it answers with and the preview text. */
  const body = async (id: string, S: string[], ...flags: string[]) => {
    const d = await ok("net", "body", id, ...flags, ...S);
    return { view: d["view"], by: rec(d["decoded"])["by"], link: rec(d["decoded"])["link"], text: d["textPreview"] };
  };

  test("s59 mime: the MIME-wrapped leaf matches stripped (matchForm); net body reads the page view during and after recording", async () => {
    const S = ["--session", "s59m"];
    const { bundle, enc } = await runPage("s59m", "/s59?mode=mime", ["--decode"], ["mode=mime"]);
    const encId = enc[0]?.id ?? "";
    // The oracle: the served envelope's data has line breaks; stripped, it is the plain XOR base64.
    const mimeData = s59Data(S59_ENC_MIME);
    expect(mimeData).toContain("\r\n");
    expect(mimeData.replace(/\s+/g, "")).toBe(XOR_DATA);
    const rows = await until("the mime page row", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 1);
    expect(rows.length).toBe(1);
    const r = rows[0] as SidecarRow;
    expect(r.request).toBe(encId);
    expect(viewText(BundleReader.open(bundle), r.decoded)).toBe(S59_PLAIN);
    const ev = rec(r.decoded["evidence"]);
    expect([ev["link"], ev["match"], ev["matchForm"]]).toEqual(["strong", sha(XOR_DATA), "stripped"]);

    // net body while recording: the page view is the default and the --decoded answer; --raw the envelope.
    const live = { by: "page", link: "strong", text: S59_PLAIN, view: "decoded" };
    expect(await body(encId, S)).toEqual(live);
    expect(await body(encId, S, "--decoded")).toEqual(live);
    expect(await body(encId, S, "--raw")).toEqual({ view: "raw", by: undefined, link: undefined, text: S59_ENC_MIME });
    // the control has no view and is no ciphertext: the hint does not point to --decode
    const ctl = recs((await ok("net", "list", "--filter", "/api/plain", ...S))["requests"])[0]?.["id"];
    const nb = await tabcap(["net", "body", s(ctl), "--decoded", ...S]);
    expect([nb.ok, nb.error["code"]]).toEqual([false, "not-found"]);
    expect(s(nb.error["next"])).not.toContain("--decode");

    await stopBoth("s59m");
    // after the recording: the same answers off the finished bundle
    expect(await body(encId, S)).toEqual(live);
    expect(await body(encId, S, "--decoded")).toEqual(live);
  }, 120_000);

  test("s59 noise: a >= 1 KB localStorage parse under two small armed suspects is no row (0.6-W: an orphan at trace stop); both plaintexts still filed", async () => {
    const S = ["--session", "s59n"];
    const { bundle, enc } = await runPage("s59n", "/s59?mode=noise", ["--decode"], ["noise&slot=1", "noise&slot=2"]);
    const bySlot = new Map(enc.map((e) => [e.query, e.id]));
    // The oracle: the localStorage text is over both suspects' plaintext bounds (base64 × 3 / 4).
    for (const env of [S59_ENC_NOISE1, S59_ENC_NOISE2]) expect(new TextEncoder().encode(S59_NOISE_LOCAL).length).toBeGreaterThan(Math.floor((s59Data(env).length * 3) / 4));
    const rows = await until("both noise rows", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.length >= 2);
    const reader = BundleReader.open(bundle);
    const got = rows.map((row) => [row.request, viewText(reader, row.decoded), rec(row.decoded["evidence"])["link"]]);
    expect(got.sort()).toEqual(
      [
        [bySlot.get("noise&slot=1") ?? "", S59_NOISE_PLAIN1, "strong"],
        [bySlot.get("noise&slot=2") ?? "", S59_NOISE_PLAIN2, "strong"],
      ].sort(),
    );
    const { decode } = await stopBoth("s59n");
    expect(sidecarRows(bundle).some((row) => viewText(BundleReader.open(bundle), row.decoded) === S59_NOISE_LOCAL)).toBe(false);
    expect(decode?.["rows"]).toMatchObject({ attributed: 2, weak: 0, unattributed: 0 });
    // 0.6-W: the localStorage parse has no scope-string match, so it is held;
    // both noise plaintexts are filed strong (their suspects forgotten) within
    // its grace, so at its decision no suspect is live: trace stop forces it
    // and counts an orphan. noFit stays for "suspects were live, none fit".
    expect(Number(rec(decode?.["drops"])["orphan"] ?? 0)).toBeGreaterThanOrEqual(1);
    expect(rec(decode?.["drops"])["noFit"]).toBe(0);
    expect(typeof decode?.["held"]).toBe("number");
  }, 120_000);

  test("s59 race: envelopes parsed as soon as they arrive are never a row; the three plaintexts are filed strong", async () => {
    const S = ["--session", "s59r"];
    const { bundle, enc } = await runPage("s59r", "/s59?mode=race", ["--decode"], ["race&slot=1", "race&slot=2", "race&slot=3"]);
    const bySlot = new Map(enc.map((e) => [e.query, e.id]));
    const rows = await until("the three race rows", () => Promise.resolve(sidecarRows(bundle)), (rs) => rs.filter((r) => r.request !== null).length >= 3);
    const { decode } = await stopBoth("s59r");
    const reader = BundleReader.open(bundle);
    const all = sidecarRows(bundle);
    const envelopes = [S59_ENC_RACE1, S59_ENC_RACE2, S59_ENC_XOR];
    for (const row of all) expect(envelopes).not.toContain(viewText(reader, row.decoded));
    expect(all.filter((row) => row.request === null)).toEqual([]);
    const got = rows.filter((r) => r.request !== null).map((row) => [row.request, viewText(reader, row.decoded), rec(row.decoded["evidence"])["link"]]);
    expect(got.sort()).toEqual(
      [
        [bySlot.get("race&slot=1") ?? "", S59_RACE_PLAIN1, "strong"],
        [bySlot.get("race&slot=2") ?? "", S59_RACE_PLAIN2, "strong"],
        [bySlot.get("race&slot=3") ?? "", S59_PLAIN, "strong"],
      ].sort(),
    );
    expect(decode?.["rows"]).toMatchObject({ attributed: 3, weak: 0, unattributed: 0 });
  }, 120_000);

  // ------------------------------------------------------------ 0.6-W

  /** The rows of a bundle as [request, plaintext, link, candidates] (readable in a timeout message). */
  const rowSummary = (bundle: string): Array<[string | null, string | null, unknown, unknown]> => {
    const reader = BundleReader.open(bundle);
    return sidecarRows(bundle).map((r) => [r.request, viewText(reader, r.decoded), rec(r.decoded["evidence"])["link"], rec(r.decoded["evidence"])["candidates"]]);
  };

  test("s59 xhr: the page parses in onload, before tabcap indexes the body; the row is strong", async () => {
    const { bundle, enc } = await runPage("s59xh", "/s59?mode=xhr", ["--decode"], ["enc?mode=xhr"]);
    const encId = enc[0]?.id ?? "";
    const rows = await until("the xhr row", () => Promise.resolve(rowSummary(bundle)), (rs) => rs.length >= 1);
    expect(rows).toEqual([[encId, S59_PLAIN, "strong", undefined]]);
    expect(rec(sidecarRows(bundle)[0]?.decoded["evidence"])["match"]).toBe(sha(XOR_DATA));
    const { decode } = await stopBoth("s59xh");
    expect(decode?.["rows"]).toMatchObject({ attributed: 1, weak: 0, unattributed: 0 });
  }, 120_000);

  test("s59 xhr&linger=3, three times in a row: three unclaimed live suspects do not take the xhr plaintext (the grace race)", async () => {
    for (const run of [1, 2, 3]) {
      const session = `s59xl${run}`;
      const { bundle, enc } = await runPage(session, "/s59?mode=xhr&linger=3", ["--decode"], ["enc?mode=xhr", "linger&slot=1", "linger&slot=2", "linger&slot=3"]);
      const encId = enc[0]?.id ?? "";
      // the oracle: every lingering plaintext is larger than the xhr one, so each lingering suspect fits it
      for (const p of S59_LINGER_PLAINS) expect(p.length).toBeGreaterThan(S59_PLAIN.length);
      expect(enc.slice(1).map((e) => e.id).every((id) => id !== "" && id !== encId)).toBe(true);
      const rows = await until(`run ${run}: the xhr row, strong`, () => Promise.resolve(rowSummary(bundle)), (rs) => rs.some((r) => r[0] === encId && r[2] === "strong"));
      const { decode } = await stopBoth(session);
      const all = rowSummary(bundle);
      expect([run, all]).toEqual([run, [[encId, S59_PLAIN, "strong", undefined]]]);
      expect(rows.length).toBe(1);
      expect(rec(sidecarRows(bundle)[0]?.decoded["evidence"])["match"]).toBe(sha(XOR_DATA));
      expect(decode?.["rows"]).toMatchObject({ attributed: 1, weak: 0, unattributed: 0 });
    }
  }, 240_000);
});
