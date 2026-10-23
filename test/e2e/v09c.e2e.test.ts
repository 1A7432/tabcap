// L2 for 0.9-C: streaming responses pass through while recording, partial
// bodies, one `sse` event per message (docs/04 §47, docs/05 s74).
// Oracle: the range's own log (when each chunk went out, its bytes, how the
// stream ended, all bytes sent → sha256) and the messages its generator wrote
// (s74Stream), the page's own records (Date.now() per chunk / progress /
// message, the same clock as the range's), and for the EventSource request
// Chrome's Network.eventSourceMessageReceived in the bundle's raw/cdp.jsonl.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { s74Stream, startStreamSite, type S74Send, type StreamSite } from "./site.ts";
import { cliFor, rec, recs, s, until, type Env } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "v09c"];
const GAP = 200;
const N = 6;

let home = "";
let site: StreamSite;
let bundle = "";

const cli = cliFor(() => home);
const tabcap = (...args: string[]): Promise<Env> => cli.tabcap(args);
const { ok } = cli;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);
const concat = (parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));
const sentBytes = (x: S74Send): Uint8Array => concat(x.sent);
const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? Number.NaN;
};

/** The range's log of the one request with this query. */
function sendOf(path: string, query: string): S74Send {
  const hits = site.sends.filter((x) => x.path === path && x.query === query);
  if (hits.length !== 1) throw new Error(`${hits.length} sends of ${path}?${query}`);
  const hit = hits[0];
  if (hit === undefined) throw new Error("unreachable");
  return hit;
}

/** The messages the range's generator wrote into the first `bytes` bytes (whole pieces only: a cut-off piece is no message). */
function expectedMessages(n: number, crlf: boolean, bytes = Number.POSITIVE_INFINITY): Array<{ event: string; id: string; data: string }> {
  const out: Array<{ event: string; id: string; data: string }> = [];
  let at = 0;
  for (const p of s74Stream(n, crlf)) {
    at += new TextEncoder().encode(p.text).length;
    if (at > bytes) break;
    if (p.message !== null) out.push(p.message);
  }
  return out;
}

async function evalAwait(expr: string): Promise<Record<string, unknown>> {
  return rec((await ok("evaluate", expr, "--await", "--timeout", "60000", ...S))["value"]);
}

/** Events of the bundle as written so far (the writer flushes every 100 ms). */
function events(): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l): Record<string, unknown>[] => {
      try {
        const v: unknown = JSON.parse(l);
        return isRecord(v) ? [v] : [];
      } catch {
        return [];
      }
    });
}

/** The one recorded request whose URL contains `tag`, once written. */
async function requestOf(tag: string): Promise<Record<string, unknown>> {
  const rows = await until(
    `request ${tag}`,
    async () => recs((await ok("net", "list", "--all", "--filter", tag, "--page-size", "0", ...S))["requests"]),
    (r) => r.length === 1,
    20_000,
  );
  return rows[0] ?? {};
}

/** The `sse` events of request `id` in events.jsonl; `net show` of the request flushes the writer first. */
async function sseEventsOf(id: string): Promise<Record<string, unknown>[]> {
  await ok("net", "show", id, ...S);
  return events().filter((e) => e["kind"] === "sse" && e["sse"] === id);
}
const messagesOf = async (id: string) => (await sseEventsOf(id)).map((e) => ({ event: e["event"], id: e["id"], data: rec(e["data"])["inline"] }));
const bodyFile = async (id: string): Promise<{ bytes: Uint8Array; answer: Record<string, unknown> }> => {
  const answer = await ok("net", "body", id, ...S);
  return { bytes: new Uint8Array(readFileSync(s(answer["path"]))), answer };
};

describe.skipIf(!enabled)("tabcap 0.9-C L2 (s74 streaming responses and SSE)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e09c-"));
    site = startStreamSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("navigate", `${site.origin}/s74`, ...S);
    const started = await ok("net", "start", ...S);
    bundle = s(started["bundle"]);
    expect(s(started["instrumentation"])).toContain("streaming responses (text/event-stream, application/x-ndjson) are passed through at once and read as they arrive");
  }, 90_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("1-3. fetch(): chunks reach the page as the range sends them; finished body = bytes sent; one sse event per message with at", async () => {
    const q = `n=${N}&gap=${GAP}&tag=f1`;
    const page = await evalAwait(`s74Fetch('/s74/sse', '${q}')`);
    const sent = sendOf("/s74/sse", q);
    expect(page["ok"]).toBe(true);
    expect(sent.ended).toBe("done");
    const chunks = recs(page["chunks"]);
    // not buffered: every chunk (one coalesced at most), the first long before the range sent the last
    expect(chunks.length).toBeGreaterThanOrEqual(sent.chunks.length - 1);
    expect(num(chunks[0]?.["at"])).toBeLessThan(sent.chunks.at(-1)?.at ?? 0);
    expect(page["bytes"]).toBe(sentBytes(sent).length);

    const r = await requestOf("tag=f1");
    expect(r).toMatchObject({ type: "fetch", status: 200, mime: "text/event-stream", outcome: "finished" });
    expect(r["partial"]).toBeUndefined();
    const id = s(r["id"]);
    expect(sha((await bodyFile(id)).bytes)).toBe(sha(sentBytes(sent)));

    const list = await ok("net", "list", "--kind", "sse", "--filter", "tag=f1", "--page-size", "0", ...S);
    const rows = recs(list["messages"]);
    const want = expectedMessages(N, false);
    expect(want).toHaveLength(N + 1);
    expect(rows.map((m) => [m["request"], m["index"], m["event"], m["lastEventId"], m["bytes"]])).toEqual(want.map((m, i) => [id, i, m.event, m.id, new TextEncoder().encode(m.data).length]));
    for (const m of rows) expect(s(m["id"])).toMatch(new RegExp(`^${id}:\\d+$`));
    expect(await messagesOf(id)).toEqual(want);
    // at: from the chunk that completed each message, so spread like the range's sends
    const sseEvents = await sseEventsOf(id);
    const ats = sseEvents.map((e) => num(e["at"]));
    for (const a of ats) expect(Number.isFinite(a)).toBe(true);
    const gaps = ats.slice(1).map((a, i) => a - (ats[i] ?? a));
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(0);
    expect(new Set(gaps).size).toBeGreaterThan(1);
    expect(median(gaps)).toBeGreaterThan(GAP / 2);
    expect(median(gaps)).toBeLessThan(GAP * 2);
    for (const e of sseEvents) expect(e["mono"]).toBe(e["at"]);

    const shown = await ok("net", "show", id, ...S);
    expect(rec(shown["sse"])["messages"]).toBe(N + 1);
    const first = s(rows[0]?.["id"]);
    const one = await ok("net", "show", first, ...S);
    expect(one).toMatchObject({ kind: "sse", sse: id, index: 0, event: "message", lastEventId: "1" });
    const data = await bodyFile(first);
    expect(Buffer.from(data.bytes).toString()).toBe(want[0]?.data ?? "missing");
    expect(data.answer).toMatchObject({ sse: id, index: 0, event: "message" });
  }, 90_000);

  test("1-3. XHR and CRLF: progress as sent, bodies = bytes sent, the same messages", async () => {
    const qx = `n=${N}&gap=${GAP}&tag=x1`;
    const page = await evalAwait(`s74Xhr('/s74/sse', '${qx}')`);
    const sent = sendOf("/s74/sse", qx);
    const prog = recs(page["prog"]);
    expect(page["status"]).toBe(200);
    expect(prog.length).toBeGreaterThanOrEqual(sent.chunks.length - 1);
    expect(num(prog[0]?.["at"])).toBeLessThan(sent.chunks.at(-1)?.at ?? 0);
    const rx = await requestOf("tag=x1");
    expect(rx).toMatchObject({ type: "xhr", outcome: "finished" });
    expect(sha((await bodyFile(s(rx["id"]))).bytes)).toBe(sha(sentBytes(sent)));
    expect(await messagesOf(s(rx["id"]))).toEqual(expectedMessages(N, false));

    const qc = `n=${N}&gap=${GAP}&crlf=1&tag=c1`;
    const pc = await evalAwait(`s74Fetch('/s74/sse', '${qc}')`);
    const sc = sendOf("/s74/sse", qc);
    expect(pc["ok"]).toBe(true);
    expect(recs(pc["chunks"]).length).toBeGreaterThanOrEqual(sc.chunks.length - 1);
    const rc = await requestOf("tag=c1");
    expect(rc["outcome"]).toBe("finished");
    expect(sha((await bodyFile(s(rc["id"]))).bytes)).toBe(sha(sentBytes(sc)));
    expect(await messagesOf(s(rc["id"]))).toEqual(expectedMessages(N, true));
  }, 90_000);

  test("1-3. EventSource: messages arrive spread out; its sse events equal what the page dispatched", async () => {
    const q = `n=${N}&gap=${GAP}&tag=e1`;
    const page = await evalAwait(`s74Es('/s74/es', '${q}')`);
    const got = recs(page["got"]).filter((g) => g["type"] !== "error");
    expect(page["timeout"]).toBeUndefined();
    const at = got.map((g) => num(g["at"]));
    expect(new Set(at).size).toBeGreaterThan(1);
    expect(median(at.slice(1).map((a, i) => a - (at[i] ?? a)))).toBeGreaterThan(GAP / 2);
    const r = await requestOf("tag=e1");
    expect(r["type"]).toBe("eventsource");
    const id = s(r["id"]);
    expect(await messagesOf(id)).toEqual(got.map((g) => ({ event: g["type"], id: g["lastEventId"], data: g["data"] })));
    expect(await messagesOf(id)).toEqual(expectedMessages(N, false));
    // The page closes the EventSource on `done` (docs/05 s74) while the range ends the stream right after
    // sending it. Which Chrome sees first is a race: close() first is loadingFailed net::ERR_ABORTED
    // canceled (E3a), so the request is failed with every byte as a partial body; the end first is
    // finished. Measured 10-23: 1 finished, 3 failed in 4 runs. Either way the body is all the range sent.
    const sent = sendOf("/s74/es", q);
    expect(sent.ended).toBe("done");
    expect(sha((await bodyFile(id)).bytes)).toBe(sha(sentBytes(sent)));
    const ev = events().find((e) => e["kind"] === "request" && e["id"] === id);
    const outcome = [ev?.["outcome"], rec(ev?.["error"])["canceled"] ?? null, rec(rec(ev?.["response"])["body"])["partial"] ?? null];
    expect([JSON.stringify(["finished", null, null]), JSON.stringify(["failed", true, true])]).toContain(JSON.stringify(outcome));
    console.log(`[v09c] EventSource closed on done: outcome ${s(r["outcome"])}, partial ${s(r["partial"] ?? false)}, range ended ${s(sent.ended)}`);
  }, 90_000);

  test("net wait --url returns when the stream ended; its sse events are listed right away", async () => {
    const q = `n=${N}&gap=${GAP}&tag=w1`;
    await ok("evaluate", `void s74Fetch('/s74/sse', '${q}')`, ...S);
    const waited = await ok("net", "wait", "--url", "tag=w1", "--timeout", "20000", ...S);
    expect(waited["outcome"]).toBe("finished");
    const rows = recs((await ok("net", "list", "--kind", "sse", "--filter", "tag=w1", "--page-size", "0", ...S))["messages"]);
    expect(rows.map((m) => m["event"])).toEqual(expectedMessages(N, false).map((m) => m.event));
    expect(sendOf("/s74/sse", q).ended).toBe("done");
  }, 60_000);

  test("4. a reset mid-stream: failed, partial, the bytes the page got (a prefix of what was sent), complete messages only", async () => {
    const q = `n=${N}&gap=${GAP}&tag=k1`;
    const page = await evalAwait(`s74Fetch('/s74/cut', '${q}')`);
    const sent = sendOf("/s74/cut", q);
    expect(page["ok"]).toBe(false);
    expect(s(page["error"])).toContain("network error");
    expect(sent.ended).toBe("cut");
    const failed = recs((await ok("net", "list", "--failed", "--filter", "tag=k1", ...S))["requests"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outcome: "failed", partial: true });
    const id = s(failed[0]?.["id"]);
    const { bytes, answer } = await bodyFile(id);
    expect(answer["partial"]).toBe(true);
    expect(bytes.length).toBe(num(page["bytes"]));
    expect(bytes.length).toBeGreaterThan(0);
    expect(sha(bytes)).toBe(sha(sentBytes(sent).subarray(0, bytes.length)));
    expect(await messagesOf(id)).toEqual(expectedMessages(N, false, bytes.length));
    const shown = await ok("net", "show", id, ...S);
    expect(rec(rec(shown["response"])["body"])["partial"]).toBe(true);
    expect(rec(shown["response"])["bodyMissing"]).toBeNull();
  }, 60_000);

  test("5. a navigation in the middle of a stream: incomplete, partial, a non-empty prefix of what was sent", async () => {
    const q = `n=20&gap=${GAP}&tag=v1`;
    await ok("evaluate", `void s74Fetch('/s74/sse', '${q}')`, ...S);
    await Bun.sleep(900);
    await ok("navigate", `${site.origin}/s74/other`, ...S);
    const r = await requestOf("tag=v1");
    expect(r).toMatchObject({ outcome: "incomplete", partial: true });
    const { bytes } = await bodyFile(s(r["id"]));
    const sent = sendOf("/s74/sse", q);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(sentBytes(sent).length);
    expect(sha(bytes)).toBe(sha(sentBytes(sent).subarray(0, bytes.length)));
    await until("range sees the client go", () => sent.ended, (e) => e !== null, 10_000);
    expect(sent.ended).toBe("client-gone");
    await ok("navigate", `${site.origin}/s74`, ...S);
  }, 60_000);

  test("6-7. ndjson streams the same way without sse events; a plain JSON fetch keeps the Fetch interception body", async () => {
    const q = `n=${N}&gap=${GAP}&tag=j1`;
    const page = await evalAwait(`s74Fetch('/s74/ndjson', '${q}')`);
    const sent = sendOf("/s74/ndjson", q);
    expect(page["ok"]).toBe(true);
    expect(recs(page["chunks"]).length).toBeGreaterThanOrEqual(sent.chunks.length - 1);
    expect(num(recs(page["chunks"])[0]?.["at"])).toBeLessThan(sent.chunks.at(-1)?.at ?? 0);
    const r = await requestOf("tag=j1");
    expect(r).toMatchObject({ mime: "application/x-ndjson", outcome: "finished" });
    expect(sha((await bodyFile(s(r["id"]))).bytes)).toBe(sha(sentBytes(sent)));
    expect(await sseEventsOf(s(r["id"]))).toEqual([]);

    expect((await ok("evaluate", "fetch('/s74/json').then((r) => r.text())", "--await", ...S))["value"]).toBe(site.json);
    const plain = await requestOf("/s74/json");
    expect(plain["outcome"]).toBe("finished");
    expect(sha((await bodyFile(s(plain["id"]))).bytes)).toBe(sha(new TextEncoder().encode(site.json)));
    const ev = events().find((e) => e["kind"] === "request" && e["id"] === plain["id"]);
    expect(ev?.["bodySource"]).toBeUndefined();
    expect(rec(rec(ev?.["response"])["body"])["partial"]).toBeUndefined();
  }, 60_000);

  test("after net stop: the EventSource messages equal Chrome's eventSourceMessageReceived; every stream and the JSON request were paused by Fetch and continued", async () => {
    await ok("net", "stop", ...S);
    const raw = readFileSync(join(bundle, "raw", "cdp.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l): unknown => JSON.parse(l))
      .filter(isRecord);
    const reqs = events().filter((e) => e["kind"] === "request");
    const byTag = (tag: string) => reqs.find((e) => s(e["url"]).includes(tag));
    const es = byTag("tag=e1");
    const cdpId = s(rec(es?.["cdp"])["requestId"]);
    const chrome = raw.filter((l) => l["method"] === "Network.eventSourceMessageReceived" && rec(l["params"])["requestId"] === cdpId).map((l) => rec(l["params"]));
    expect(chrome.length).toBe(N + 1);
    expect(await messagesOf(s(es?.["id"]))).toEqual(chrome.map((p) => ({ event: p["eventName"], id: p["eventId"], data: p["data"] })));
    // fetch / xhr SSE get no eventSourceMessageReceived (E3a): one parser covers all three
    const f1 = s(rec(byTag("tag=f1")?.["cdp"])["requestId"]);
    expect(raw.some((l) => l["method"] === "Network.eventSourceMessageReceived" && rec(l["params"])["requestId"] === f1)).toBe(false);
    const paused = new Set(raw.filter((l) => l["method"] === "Fetch.requestPaused").map((l) => rec(l["params"])["networkId"]));
    for (const tag of ["tag=f1", "tag=x1", "tag=e1", "tag=j1", "/s74/json"]) expect({ tag, paused: paused.has(rec(byTag(tag)?.["cdp"])["requestId"]) }).toEqual({ tag, paused: true });
  }, 60_000);
});
