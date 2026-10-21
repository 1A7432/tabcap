// L2 for 0.4-F trace mode (Chrome for Testing, the real daemon, the range in site.ts).
// Expected values come from the range pages, never from tabcap:
//   - the (api, script, line) pairs below are literals of TRACE_PROBE_JS,
//     TRACE_FRAME_HTML, TRACE_OOPIF_HTML and TRACE_WORKER_JS (1-based lines,
//     checked against the source text first);
//   - the value of navigator.userAgent is what the page itself POSTed to the
//     site (`reports`);
//   - the loop page reads navigator.userAgent TRACE_LOOP_READS times; with the
//     default maxHits (500) exactly 500 are counted and the event is truncated;
//   - the page-visible snapshot (descriptors, toString, stack) is taken by the
//     page's own code with trace off and on and must be identical.
// The per-hit overhead (loop time with trace on minus off, over the counted
// hits) is logged, not asserted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { builtinSignalList } from "../../src/daemon/trace/signals.ts";
import { TRACE_CANVAS_JS, TRACE_FRAME_HTML, TRACE_LOOP_READS, TRACE_OOPIF_HTML, TRACE_PROBE_JS, TRACE_WORKER_JS, startTraceSite, type TraceSite } from "./site.ts";
import { cliFor, rec, recs, s, until } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const NOTICE = "Trace mode installs debugger breakpoints in the page: scripts run slower and the timing is observable.";

let home = "";
let site: TraceSite;

const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

/** 1-based line of the first source line containing `needle` (to check the literals below against the pages). */
function lineOf(src: string, needle: string): number {
  return src.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

type Row = { api: string; script: string; line: number; kind: string };

function rowsOf(list: Record<string, unknown>): Row[] {
  return recs(list["rows"]).flatMap((r) => recs(r["callers"]).map((c) => ({ api: s(r["api"]), script: s(r["script"]), line: Number(c["line"]), kind: s(c["kind"]) })));
}

const key = (r: Row) => `${r.api} ${r.script}:${r.line} ${r.kind}`;

describe.skipIf(!enabled)("tabcap 0.4-F L2 (trace mode: signal reads via debugger breakpoints)", () => {
  const S = ["--session", "tr"];
  let bundle = "";
  let overheadMs: number | null = null;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4f-"));
    site = startTraceSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  /** The page's own snapshot at load (window.__snapLoad) and one taken later through evaluate, trace off. */
  let snapLoadOff = "";
  let snapOff = "";
  let loopOff = 0;

  test("trace off: baseline snapshot and loop time; outputs carry no trace field", async () => {
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    const nav = await ok("navigate", `${site.a}/trace/visible.html`, ...S);
    expect("trace" in nav).toBe(false);
    snapLoadOff = s((await ok("evaluate", "window.__snapLoad", ...S))["value"]);
    snapOff = s((await ok("evaluate", "snap()", ...S))["value"]);
    expect(snapLoadOff).toContain("function get userAgent() { [native code] }");
    await ok("navigate", `${site.a}/trace/loop.html`, ...S);
    const loop = rec((await ok("evaluate", "window.__loop", ...S))["value"]);
    loopOff = Number(loop["ms"]);
    expect(loop["n"]).toBeGreaterThan(0);
  }, 60_000);

  test("trace start → probe page: exactly the page's (api, script, line) callers, top frame, iframe, OOPIF, worker", async () => {
    const st = await ok("trace", "start", ...S);
    expect(st["notice"]).toBe(NOTICE);
    expect(st["trace"]).toBe("on");
    const status = await ok("trace", "status", ...S);
    expect(status["notice"]).toBe(NOTICE);
    console.log(`[v04f] ${s(status["requested"])} requested, ${Array.isArray(status["active"]) ? status["active"].length : "?"} active; skipped on this browser: ${JSON.stringify(status["skipped"])}`);
    expect(recs(status["skipped"]).map((x) => x["api"])).toEqual(["Window.prototype.devicePixelRatio"]);

    const nav = await ok("navigate", `${site.a}/trace/`, ...S);
    expect(nav["trace"]).toBe("on");
    await ok("wait", "--text", "worker done", ...S);
    await until("the page report", async () => site.reports.length, (n) => n >= 1);

    // the literals, checked against the page sources
    const probe = `${site.a}/trace/probe.js`;
    expect([lineOf(TRACE_PROBE_JS, "navigator.userAgent"), lineOf(TRACE_PROBE_JS, "screen.width"), lineOf(TRACE_PROBE_JS, "resolvedOptions"), lineOf(TRACE_PROBE_JS, "getTimezoneOffset")]).toEqual([2, 3, 4, 5]);
    expect(lineOf(TRACE_FRAME_HTML, "navigator.platform")).toBe(3);
    expect(lineOf(TRACE_OOPIF_HTML, "navigator.hardwareConcurrency")).toBe(3);
    expect(lineOf(TRACE_WORKER_JS, "navigator.userAgent")).toBe(1);
    const expected = [
      { api: "Navigator.prototype.userAgent", script: probe, line: 2, kind: "page" },
      { api: "Screen.prototype.width", script: probe, line: 3, kind: "page" },
      { api: "Intl.DateTimeFormat.prototype.resolvedOptions", script: probe, line: 4, kind: "page" },
      { api: "Date.prototype.getTimezoneOffset", script: probe, line: 5, kind: "page" },
      { api: "Navigator.prototype.platform", script: `${site.a}/trace/frame.html`, line: 3, kind: "page" },
      { api: "Navigator.prototype.hardwareConcurrency", script: `${site.b}/trace/oopif.html`, line: 3, kind: "page" },
      { api: "WorkerNavigator.prototype.userAgent", script: `${site.a}/trace/worker.js`, line: 1, kind: "page" },
    ];
    const list = await until("all seven callers", () => ok("trace", "list", ...S), (l) => rowsOf(l).length >= expected.length, 10_000);
    expect(rowsOf(list).map(key).sort()).toEqual(expected.map(key).sort());
    for (const r of recs(list["rows"])) expect([r["api"], r["count"], r["documents"]]).toEqual([r["api"], 1, 1]);

    // a tabcap evaluate in flight is tagged as tabcap, not page
    await ok("evaluate", "navigator.userAgent", ...S);
    const ua = await ok("trace", "list", "--api", "Navigator.prototype.userAgent", ...S);
    expect(rowsOf(ua).map(key).sort()).toEqual([`Navigator.prototype.userAgent ${probe}:2 page`, "Navigator.prototype.userAgent :1 tabcap"].sort());
  }, 90_000);

  test("loop page: 1000 reads → maxHits 500 counted, truncated; overhead per hit logged", async () => {
    await ok("navigate", `${site.a}/trace/loop.html`, ...S);
    const loop = rec((await ok("evaluate", "window.__loop", ...S))["value"]);
    const list = await ok("trace", "list", "--script", "/trace/loop.js", ...S);
    const rows = recs(list["rows"]);
    expect(rows.map((r) => [r["api"], r["count"], r["truncated"]])).toEqual([["Navigator.prototype.userAgent", 500, true]]);
    overheadMs = (Number(loop["ms"]) - loopOff) / 500;
    console.log(`[v04f] loop of ${TRACE_LOOP_READS} navigator.userAgent reads: ${loopOff.toFixed(1)} ms trace off, ${Number(loop["ms"]).toFixed(1)} ms trace on (500 paused) → ${overheadMs.toFixed(3)} ms per hit`);
  }, 60_000);

  test("instrumentation breakpoint: a 2d canvas context is a signal with access event at the page's line", async () => {
    expect(lineOf(TRACE_CANVAS_JS, "getContext")).toBe(1);
    await ok("navigate", `${site.a}/trace/canvas.html`, ...S);
    const list = await ok("trace", "list", "--script", "/trace/canvas.js", ...S);
    expect(recs(list["rows"]).map((r) => [r["api"], r["access"], r["count"]])).toEqual([["instrumentation:canvasContextCreated", "event", 1]]);
    expect(rowsOf(list).map((r) => r.line)).toEqual([1]);
  }, 60_000);

  test("page-visible snapshot (descriptors, toString, stack) is identical with trace on", async () => {
    await ok("navigate", `${site.a}/trace/visible.html`, ...S);
    expect(s((await ok("evaluate", "window.__snapLoad", ...S))["value"])).toBe(snapLoadOff);
    expect(s((await ok("evaluate", "snap()", ...S))["value"])).toBe(snapOff);
  }, 60_000);

  test("waiting pauses the trace (reads no longer counted), handoff continue resumes it", async () => {
    await ok("navigate", `${site.a}/trace/wall.html`, ...S);
    const h = await until("the waiting state", () => ok("handoff", "status", ...S), (d) => d["state"] === "waiting");
    expect(h["trace"]).toBe("paused");
    expect(s(h["traceNote"])).toContain("handoff continue");
    const refused = await tabcap(["evaluate", "1", ...S]);
    expect(refused.error?.["code"]).toBe("waiting");
    expect(refused.error?.["trace"]).toBe("paused");
    const hitsOf = async () => {
      const st = await ok("trace", "status", ...S);
      return recs(st["documents"]).filter((x) => s(x["url"]).includes("/trace/wall.html")).reduce((n, x) => n + Number(x["hits"]), 0);
    };
    const title = async () => s(recs((await ok("tab", "list", ...S))["tabs"])[0]?.["title"]);
    await Bun.sleep(1500);
    const c1 = await hitsOf();
    const t1 = await title();
    await Bun.sleep(3000);
    const c2 = await hitsOf();
    const t2 = await title();
    console.log(`[v04f] waiting: hits ${c1} → ${c2}, page title ${t1} → ${t2}`);
    expect(t2).not.toBe(t1); // the page kept reading navigator.language
    expect(c2).toBe(c1);
    expect((await ok("trace", "status", ...S))["trace"]).toBe("paused");
    await ok("handoff", "continue", ...S);
    const c3 = await until("reads counted again", hitsOf, (n) => n > c2, 10_000);
    expect(c3).toBeGreaterThan(c2);
    expect((await ok("trace", "status", ...S))["trace"]).toBe("on");
  }, 90_000);

  test("trace stop: outputs no longer carry trace; the bundle has the signal events, mode.trace and the windows", async () => {
    const before = await ok("tab", "list", ...S);
    expect(before["trace"]).toBe("on");
    const stop = await ok("trace", "stop", ...S);
    expect("trace" in stop).toBe(false);
    const after = await ok("tab", "list", ...S);
    expect("trace" in after).toBe(false);
    expect((await ok("trace", "status", ...S))["trace"]).toBe("off");
    await ok("net", "stop", ...S);

    const r = BundleReader.open(bundle);
    const m = r.manifest;
    expect(m.mode.trace).toEqual({ mechanism: ["fn-breakpoint", "instrumentation"], apis: builtinSignalList().hash, stack: 8, firstN: 20, maxHits: 500 });
    const windows = m.traceWindows ?? [];
    expect(windows.length).toBe(1);
    const notes = r.events.filter((e) => e.kind === "note");
    expect(notes.map((e) => e.seq)).toEqual(expect.arrayContaining([windows[0]?.fromSeq, windows[0]?.toSeq]));
    const signals = r.events.filter((e) => e.kind === "signal");
    for (const e of signals) {
      expect(e.seq).toBeGreaterThan(windows[0]?.fromSeq ?? 0);
      expect(e.seq).toBeLessThan(windows[0]?.toSeq ?? 0);
    }
    // value once per document per API: the probe document's userAgent is what the page reported
    const report = site.reports[0] ?? {};
    const uaProbe = signals.filter((e) => e["api"] === "Navigator.prototype.userAgent" && rec(e["caller"])["url"] === `${site.a}/trace/probe.js`);
    expect(uaProbe.length).toBe(1);
    expect(uaProbe[0]?.["value"]).toBe(report["ua"]);
    const byDoc = new Map<string, number>();
    for (const e of signals) if ("value" in e) byDoc.set(`${s(e["tab"])}|${s(e["frame"])}|${s(e["nav"])}|${s(e["api"])}`, (byDoc.get(`${s(e["tab"])}|${s(e["frame"])}|${s(e["nav"])}|${s(e["api"])}`) ?? 0) + 1);
    const dup = [...byDoc].filter(([, n]) => n !== 1);
    if (dup.length > 0) console.log(`[v04f] DEBUG values: ${JSON.stringify(signals.filter((e) => "value" in e).map((e) => [e.seq, e["tab"], e["frame"], e["nav"], e["api"], rec(e["caller"])["url"]]))}`);
    expect(dup).toEqual([]);
    const loopEv = signals.filter((e) => rec(e["caller"])["url"] === `${site.a}/trace/loop.js`);
    expect(loopEv.map((e) => [e["count"], e["truncated"]])).toEqual([[500, true]]);
    const tz = signals.find((e) => e["api"] === "Intl.DateTimeFormat.prototype.resolvedOptions");
    expect(rec(tz?.["value"])["timeZone"]).toBe(report["tz"]);
    console.log(`[v04f] signal event: ${JSON.stringify(uaProbe[0])}`);
    console.log(`[v04f] ${signals.length} signal events; overhead ${overheadMs?.toFixed(3) ?? "?"} ms per hit`);
  }, 60_000);
});
