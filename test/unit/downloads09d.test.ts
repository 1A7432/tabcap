// 0.9-D downloads (docs/04 §48, docs/05 s75). Oracle: docs/04 §48 (the
// behaviour tabcap sets, who a download belongs to, cancel outside a
// recording, the 200 MiB soft cap, the `download` event, redaction, the
// navigate window) and the measured CDP shapes of docs/07 §1.1 E4 / E4b / E4c
// and the 0.9-D spike in NOTES: Browser.downloadWillBegin {frameId, guid, url,
// suggestedFilename} and Browser.downloadProgress {guid, totalBytes,
// receivedBytes, state} arrive without a sessionId; Browser.cancelDownload
// needs the download's own browserContextId ("No download item found for the
// given GUID" otherwise); a canceled download reports 0/0. Chrome runs as a
// fake transport (same doubles as recorder09c), the cap is injected small
// (s75 step 4: 200 MiB is too big to download in a test).
// Reproduce: bun test test/unit/downloads09d.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeDownload } from "../../src/bundle/downloads.ts";
import { exportHar } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { redactBundle } from "../../src/bundle/redact.ts";
import { Tabs } from "../../src/daemon/browser/targets.ts";
import { DATA_URL_MAX, DOWNLOAD_CAP_BYTES, Downloads, NAV_DOWNLOAD_MS, NOT_RECORDING_NEXT, downloadBehavior, dropStaging, openStaging, shownDownloadUrl } from "../../src/daemon/capture/downloads.ts";
import { isAttachment, Recorder } from "../../src/daemon/capture/recorder.ts";
import { withDownloadNotices } from "../../src/daemon/main.ts";
import { Pool } from "../../src/daemon/pool/runtime.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { downloadList, downloadWait } from "../../src/daemon/tools/download.ts";
import { withNavDownload } from "../../src/daemon/tools/navigate.ts";
import { TOOL_ACTIONS } from "../../src/daemon/tools/registry.ts";
import type { AttachedTarget, CdpEvent, CdpParams, Transport } from "../../src/daemon/transport/types.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tabcap-09d-${p}-`));
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const ORIGIN = "http://127.0.0.1:9";

// ---------------------------------------------------------------- a fake browser

type Call = { method: string; params: CdpParams; sessionId: string | null };
type Handler = (method: string, params: CdpParams, sessionId: string | null) => Promise<Record<string, unknown>> | Record<string, unknown> | undefined;

function fakeBrowser(handler: Handler = () => undefined) {
  const listeners = new Set<(e: CdpEvent) => void>();
  const detach = new Set<(t: AttachedTarget) => void>();
  const page = (): AttachedTarget => ({ targetId: "T1", sessionId: "S1", type: "page", url: "about:blank", title: "", parentSessionId: null, openerId: null });
  const calls: Call[] = [];
  const extra: AttachedTarget[] = [];
  const t: Transport = {
    kind: "direct",
    closed: new Promise<string>(() => undefined),
    send: async (method: string, params: CdpParams = {}, sessionId: string | null = null) => {
      calls.push({ method, params, sessionId });
      const r = await handler(method, params, sessionId);
      if (r !== undefined) return r;
      if (method === "Target.createTarget") return { targetId: "T1" };
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAttach: () => () => undefined,
    onDetach: (fn) => {
      detach.add(fn);
      return () => detach.delete(fn);
    },
    attach: async () => page(),
    detach: async () => undefined,
    waitAttached: async () => page(),
    targets: () => [page(), ...extra],
  };
  /** A browser-level event (no sessionId), as Browser.download* arrive. */
  const browser = (method: string, params: Record<string, unknown>) => {
    for (const l of [...listeners]) l({ method, params, sessionId: null });
  };
  /** An event of the tab's own session. */
  const onPage = (method: string, params: Record<string, unknown>) => {
    for (const l of [...listeners]) l({ method, params, sessionId: "S1" });
  };
  const cancels = () => calls.filter((c) => c.method === "Browser.cancelDownload").map((c) => c.params);
  return { t, browser, onPage, calls, extra, cancels };
}

type Fake = ReturnType<typeof fakeBrowser>;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A tab t1 of session s1, the staging directory, the manager; `record` starts a recording of s1. */
async function setup(o: { handler?: Handler; cap?: number; scrub?: (s: string) => string } = {}) {
  const f = fakeBrowser(o.handler);
  const tabs = new Tabs(f.t, false);
  const tab = await tabs.createTab("s1");
  const staging = openStaging(join(tmp("staging"), "downloads"));
  const recs = new Map<string, Recorder>();
  const dl = new Downloads({ t: f.t, tabs, staging, recorder: (s) => recs.get(s), scrub: o.scrub ?? ((s) => s), ...(o.cap === undefined ? {} : { cap: o.cap }) });
  const record = async () => {
    const dir = join(tmp("bundle"), "b");
    const rec = await Recorder.start({ session: "s1", dir, t: f.t, tabs, browser: { version: "Chrome/155", userAgent: "UA", webdriver: "hidden" } });
    recs.set("s1", rec);
    return rec;
  };
  return { f, tabs, tab, staging, dl, record, recs };
}

const GUID = "d7f73467-3787-43d4-8625-6b0db86a7bf9";
const willBegin = (f: Fake, o: { guid?: unknown; frameId?: unknown; url?: unknown; name?: unknown } = {}) =>
  f.browser("Browser.downloadWillBegin", { frameId: "frameId" in o ? o.frameId : "T1", guid: o.guid ?? GUID, url: o.url ?? `${ORIGIN}/s75/file`, suggestedFilename: o.name ?? "s75-x.txt" });
const progress = (f: Fake, state: string, received: number, total: number, guid = GUID) => f.browser("Browser.downloadProgress", { guid, totalBytes: total, receivedBytes: received, state });
const downloadEvents = (dir: string) => BundleReader.open(dir).byKind("download");

// ---------------------------------------------------------------- pure parts

describe("0.9-D helpers", () => {
  test("the behaviour: allowAndName into the staging directory with events, a context's own with its browserContextId", () => {
    expect(downloadBehavior("/st")).toEqual({ behavior: "allowAndName", downloadPath: "/st", eventsEnabled: true });
    expect(downloadBehavior("/st", "CTX")).toEqual({ behavior: "allowAndName", downloadPath: "/st", eventsEnabled: true, browserContextId: "CTX" });
    expect(DOWNLOAD_CAP_BYTES).toBe(209_715_200);
    expect(NAV_DOWNLOAD_MS).toBe(1000);
  });

  test("URLs: known secrets replaced; a data: URL over 2 KB cut and flagged; blob: and long http URLs kept", () => {
    const scrub = (s: string) => s.replaceAll("TOPSECRET", "<secret:x>");
    expect(shownDownloadUrl(`${ORIGIN}/f?t=TOPSECRET`, scrub)).toEqual({ url: `${ORIGIN}/f?t=<secret:x>`, urlTruncated: false });
    const data = `data:text/plain,${"a".repeat(3000)}`;
    expect(shownDownloadUrl(data, scrub)).toEqual({ url: data.slice(0, DATA_URL_MAX), urlTruncated: true });
    const exact = `data:,${"a".repeat(DATA_URL_MAX - 6)}`;
    expect(shownDownloadUrl(exact, scrub)).toEqual({ url: exact, urlTruncated: false });
    expect(shownDownloadUrl("blob:http://127.0.0.1:9/0b6e", scrub)).toEqual({ url: "blob:http://127.0.0.1:9/0b6e", urlTruncated: false });
    const long = `${ORIGIN}/${"p".repeat(5000)}`;
    expect(shownDownloadUrl(long, scrub).urlTruncated).toBe(false);
  });

  test("Content-Disposition: only the attachment type makes a download (case, parameters, spaces)", () => {
    for (const v of ["attachment", 'Attachment; filename="a.txt"', "  ATTACHMENT ;filename*=UTF-8''a"]) expect([v, isAttachment(v)]).toEqual([v, true]);
    for (const v of [null, "", "inline", 'inline; filename="a.txt"', "attachments", "form-data; name=attachment"]) expect([v, isAttachment(v)]).toEqual([v, false]);
  });

  test("staging: one run-* directory per browser run, 0700 in a 0700 root; earlier runs' directories are removed, other entries stay; dropStaging removes it", () => {
    const root = join(tmp("root"), "downloads");
    const first = openStaging(root);
    writeFileSync(join(first, GUID), "left over");
    writeFileSync(join(root, "keep.txt"), "not a run");
    const second = openStaging(root);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["keep.txt", second.split("/").pop() ?? ""].sort());
    if (process.platform !== "win32") {
      expect(mode(root)).toBe("700");
      expect(mode(second)).toBe("700");
    }
    dropStaging(second);
    expect(existsSync(second)).toBe(false);
    dropStaging(second); // gone already: no throw
  });

  test("paths: the staging root is data/downloads", () => {
    const home = tmp("home");
    expect(paths({ TABCAP_HOME: home }).downloads).toBe(join(home, "data", "downloads"));
  });

  test("storeDownload: moved to downloads/<sha256> (0600, dir 0700); the same content twice is stored once; a symlink or a missing file is refused", async () => {
    const bundle = tmp("b");
    const st = tmp("s");
    writeFileSync(join(st, "g1"), "same bytes");
    writeFileSync(join(st, "g2"), "same bytes");
    const a = await storeDownload(bundle, join(st, "g1"));
    expect(a).toEqual({ file: `downloads/${sha("same bytes")}`, sha256: sha("same bytes"), bytes: 10, existed: false });
    expect(readFileSync(join(bundle, a.file), "utf8")).toBe("same bytes");
    expect(existsSync(join(st, "g1"))).toBe(false);
    const b = await storeDownload(bundle, join(st, "g2"));
    expect(b).toMatchObject({ file: a.file, existed: true });
    expect(existsSync(join(st, "g2"))).toBe(false);
    expect(readdirSync(join(bundle, "downloads"))).toEqual([sha("same bytes")]);
    if (process.platform !== "win32") {
      expect(mode(join(bundle, "downloads"))).toBe("700");
      expect(mode(join(bundle, a.file))).toBe("600");
      writeFileSync(join(st, "real"), "x");
      symlinkSync(join(st, "real"), join(st, "link"));
      await expect(storeDownload(bundle, join(st, "link"))).rejects.toBeInstanceOf(TabcapError);
      expect(lstatSync(join(st, "link")).isSymbolicLink()).toBe(true);
    }
    await expect(storeDownload(bundle, join(st, "missing"))).rejects.toBeInstanceOf(TabcapError);
  });

  test("command answers: notices become downloads + next (after the tool's own next); none: the answer as it was", () => {
    const notice = { url: `${ORIGIN}/f`, suggestedFilename: "f.txt", state: "canceled" as const, reason: "not-recording" as const };
    const d = (list: (typeof notice)[]) => ({ browser: { downloads: { takeNotices: () => list } } });
    expect(withDownloadNotices(d([notice]), "s1", 0, { tab: "t1" })).toEqual({ tab: "t1", downloads: [notice], next: NOT_RECORDING_NEXT });
    expect(withDownloadNotices(d([notice]), "s1", 0, { tab: "t1", next: "Own hint." })).toEqual({ tab: "t1", downloads: [notice], next: `Own hint. ${NOT_RECORDING_NEXT}` });
    expect(withDownloadNotices(d([]), "s1", 0, { tab: "t1" })).toEqual({ tab: "t1" });
    expect(withDownloadNotices({ browser: null }, "s1", 0, { tab: "t1" })).toEqual({ tab: "t1" });
    expect(NOT_RECORDING_NEXT).toContain("tabcap net start");
  });

  test("navigate's answer for a download: download + note; next only when it was canceled outside a recording", () => {
    const base = { tab: "t1", url: `${ORIGIN}/s75`, status: 200 };
    expect(withNavDownload(base, { url: `${ORIGIN}/nav`, suggestedFilename: "n.bin", state: "in-progress" })).toEqual({ ...base, download: { url: `${ORIGIN}/nav`, suggestedFilename: "n.bin", state: "in-progress" }, note: "the URL is a file download; the page did not change" });
    const off = withNavDownload(base, { url: `${ORIGIN}/nav`, suggestedFilename: "n.bin", state: "canceled", reason: "not-recording" });
    expect(isRecord(off) ? off["next"] : null).toBe(NOT_RECORDING_NEXT);
  });

  test("registry: download list and download wait are read-only rows (no cmd window, not refused while waiting)", () => {
    for (const a of ["download.list", "download.wait"] as const) expect(TOOL_ACTIONS[a]).toEqual({ actsOnPage: false, blockedWhileWaiting: false, cmdWindow: false, defersText: false });
  });
});

describe("Tabs.busy: a command is running on the tab", () => {
  test("true inside run (also when it throws), false before and after", async () => {
    const { tabs, tab } = await setup();
    expect(tabs.busy(tab)).toBe(false);
    let inside = false;
    await tabs.run(tab, async () => {
      inside = tabs.busy(tab);
    });
    expect(inside).toBe(true);
    expect(tabs.busy(tab)).toBe(false);
    await tabs
      .run(tab, async () => {
        throw new Error("boom");
      })
      .catch(() => undefined);
    expect(tabs.busy(tab)).toBe(false);
  });
});

// ---------------------------------------------------------------- outside a recording

describe("downloads outside a recording are canceled (§48)", () => {
  test("during a command on the tab: canceled at once in the default context, a notice for that command's answer (once), and the file Chrome had already finished is removed", async () => {
    const { f, tabs, tab, staging, dl } = await setup();
    const since = Date.now();
    await tabs.run(tab, async () => {
      willBegin(f);
      await until(() => f.cancels().length === 1);
    });
    expect(f.cancels()).toEqual([{ guid: GUID }]);
    expect(dl.takeNotices("s1", since)).toEqual([{ url: `${ORIGIN}/s75/file`, suggestedFilename: "s75-x.txt", state: "canceled", reason: "not-recording" }]);
    expect(dl.takeNotices("s1", since)).toEqual([]);
    // small files are done before the cancel arrives: Chrome reports completed, tabcap deletes the file
    writeFileSync(join(staging, GUID), "attachment body");
    progress(f, "completed", 15, 15);
    await until(() => !existsSync(join(staging, GUID)));
  });

  test("outside any command (the page's own): canceled, no notice (only the daemon log)", async () => {
    const { f, dl } = await setup();
    const since = Date.now();
    willBegin(f);
    await until(() => f.cancels().length === 1);
    expect(dl.takeNotices("s1", since)).toEqual([]);
  });

  test("a notice is the session's and from the command's start on", async () => {
    const { f, tabs, tab, dl } = await setup();
    await tabs.run(tab, async () => {
      willBegin(f);
      await until(() => f.cancels().length === 1);
    });
    expect(dl.takeNotices("other", 0)).toEqual([]);
    expect(dl.takeNotices("s1", Date.now() + 1000)).toEqual([]);
    expect(dl.takeNotices("s1", 0).length).toBe(1);
  });

  test("the tab's own browser context first (a pool account's), then the default and the other contexts until one has it", async () => {
    const { f, tabs } = await setup({ handler: (m, p) => (m === "Browser.cancelDownload" && p["browserContextId"] !== "CTX-B" ? Promise.reject(new Error("No download item found for the given GUID")) : undefined) });
    tabs.contexts.set("s1", "CTX-A");
    tabs.contexts.set("other", "CTX-B");
    willBegin(f);
    await until(() => f.cancels().length === 3);
    expect(f.cancels()).toEqual([
      { guid: GUID, browserContextId: "CTX-A" },
      { guid: GUID },
      { guid: GUID, browserContextId: "CTX-B" },
    ]);
  });

  test("owners: an OOPIF's frame (its target) and a same-process child frame (the tab's frame tree) are the tab's; an unknown frame is no one's, canceled", async () => {
    const { f, tabs, tab, dl } = await setup({
      handler: (m, _p, sid) => (m === "Page.getFrameTree" && sid === "S1" ? { frameTree: { frame: { id: "T1", loaderId: "L1", url: `${ORIGIN}/s75` }, childFrames: [{ frame: { id: "C1", parentId: "T1", loaderId: "L2", url: `${ORIGIN}/inner` } }] } } : undefined),
    });
    f.extra.push({ targetId: "F9", sessionId: "S9", type: "iframe", url: "http://b/", title: "", parentSessionId: "S1", openerId: null });
    await tabs.run(tab, async () => {
      willBegin(f, { guid: "g-oopif", frameId: "F9" });
      willBegin(f, { guid: "g-child", frameId: "C1" });
      willBegin(f, { guid: "g-none", frameId: "ZZ" });
      willBegin(f, { guid: "g-null", frameId: null });
      await until(() => f.cancels().length === 4);
    });
    // the tab's two are its command's notices; the frame no tab has is only canceled
    expect(dl.takeNotices("s1", 0).length).toBe(2);
    expect(f.cancels().map((c) => c["guid"]).sort()).toEqual(["g-child", "g-none", "g-null", "g-oopif"]);
  });

  test("malformed events are ignored; a guid that is not a plain token never becomes a path", async () => {
    const { f, staging } = await setup();
    willBegin(f, { guid: 7 });
    willBegin(f, { guid: "" });
    f.browser("Browser.downloadProgress", { guid: 5, state: "completed" });
    f.browser("Browser.downloadProgress", {});
    await Bun.sleep(20);
    expect(f.cancels()).toEqual([]);
    // completed for a download tabcap never saw begin: a plain guid's staging file goes, a path-like one is left alone
    const outside = join(staging, "..", "victim");
    writeFileSync(outside, "keep me");
    writeFileSync(join(staging, "abc-123"), "stray");
    progress(f, "completed", 1, 1, "../victim");
    progress(f, "completed", 1, 1, "abc-123");
    await until(() => !existsSync(join(staging, "abc-123")));
    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });
});

// ---------------------------------------------------------------- while recording

describe("downloads while recording (§48)", () => {
  test("completed: moved into the bundle, one `download` event with the command window and nav of its start; counts.downloads", async () => {
    const { f, tab, staging, dl, record } = await setup();
    const rec = await record();
    const c1 = rec.cmdStart({ tab: tab.id, argv: ["click", "e1"], input: {} });
    willBegin(f, { url: `${ORIGIN}/s75/file?t=1` });
    await Bun.sleep(5);
    rec.cmdEnd(c1 ?? "", { tab: tab.id, ok: true, error: null, durationMs: 1, outputSummary: null });
    const c2 = rec.cmdStart({ tab: tab.id, argv: ["download", "wait"], input: {} });
    expect(f.cancels()).toEqual([]);
    progress(f, "inProgress", 0, 15);
    await until(() => dl.inProgress(rec)[0]?.totalBytes === 15);
    expect(dl.inProgress(rec)).toEqual([{ guid: GUID, tab: "t1", url: `${ORIGIN}/s75/file?t=1`, suggestedFilename: "s75-x.txt", state: "in-progress", receivedBytes: 0, totalBytes: 15 }]);
    writeFileSync(join(staging, GUID), "attachment body");
    progress(f, "completed", 15, 15);
    await until(() => rec.downloads.length === 1);
    rec.cmdEnd(c2 ?? "", { tab: tab.id, ok: true, error: null, durationMs: 1, outputSummary: null });
    expect(existsSync(join(staging, GUID))).toBe(false);
    expect(dl.inProgress(rec)).toEqual([]);
    const e = rec.downloads[0];
    expect(e).toMatchObject({ tab: "t1", state: "completed", reason: null, bytes: 15, totalBytes: 15, file: `downloads/${sha("attachment body")}`, sha256: sha("attachment body"), cmd: c1, guid: GUID });
    const res = await rec.stop();
    expect(res.counts).toMatchObject({ downloads: 1 });
    const ev = downloadEvents(rec.dir)[0];
    if (ev === undefined) throw new Error("no download event");
    expect(ev).toMatchObject({ kind: "download", tab: "t1", cmd: c1, actor: "ai", id: `d-${ev.seq}`, url: `${ORIGIN}/s75/file?t=1`, suggestedFilename: "s75-x.txt", guid: GUID, state: "completed", reason: null, bytes: 15, totalBytes: 15, file: `downloads/${sha("attachment body")}`, sha256: sha("attachment body"), nav: null, mono: null });
    expect(typeof ev["startedTs"]).toBe("number");
    expect(readFileSync(join(rec.dir, "downloads", sha("attachment body")), "utf8")).toBe("attachment body");
    expect(JSON.parse(readFileSync(join(rec.dir, "manifest.json"), "utf8")).counts.downloads).toBe(1);
  });

  test("the cap (injected 100 bytes): a first progress whose totalBytes is over it cancels at once; otherwise the first receivedBytes over it; one event each, too-large, no file", async () => {
    const { f, dl, record } = await setup({ cap: 100 });
    const rec = await record();
    willBegin(f, { guid: "g-total" });
    progress(f, "inProgress", 0, 500, "g-total");
    await until(() => f.cancels().length === 1);
    expect(f.cancels()).toEqual([{ guid: "g-total" }]);
    willBegin(f, { guid: "g-recv" });
    progress(f, "inProgress", 50, 0, "g-recv");
    progress(f, "inProgress", 100, 0, "g-recv");
    await Bun.sleep(10);
    expect(f.cancels().length).toBe(1);
    progress(f, "inProgress", 150, 0, "g-recv");
    await until(() => f.cancels().length === 2);
    // Chrome then reports them canceled (0/0): no second event
    progress(f, "canceled", 0, 0, "g-total");
    progress(f, "canceled", 0, 0, "g-recv");
    await Bun.sleep(10);
    expect(rec.downloads.map((e) => [e.guid, e.state, e.reason, e.bytes, e.totalBytes, e.file, e.sha256])).toEqual([
      ["g-total", "canceled", "too-large", 0, 500, null, null],
      ["g-recv", "canceled", "too-large", 150, null, null, null],
    ]);
    expect(dl.inProgress(rec)).toEqual([]);
    await rec.stop();
  });

  test("finished past the cap before the cancel took effect: too-large, the file is not kept", async () => {
    const { f, staging, record } = await setup({ cap: 10 });
    const rec = await record();
    willBegin(f);
    writeFileSync(join(staging, GUID), "more than ten bytes");
    progress(f, "completed", 19, 19);
    await until(() => rec.downloads.length === 1);
    expect(rec.downloads[0]).toMatchObject({ state: "canceled", reason: "too-large", file: null });
    expect(existsSync(join(staging, GUID))).toBe(false);
    expect(existsSync(join(rec.dir, "downloads"))).toBe(false);
    await rec.stop();
  });

  test("canceled by Chrome or the page: reason canceled, the bytes that had arrived", async () => {
    const { f, record } = await setup();
    const rec = await record();
    willBegin(f);
    progress(f, "inProgress", 40, 100);
    progress(f, "canceled", 0, 0);
    await until(() => rec.downloads.length === 1);
    expect(rec.downloads[0]).toMatchObject({ state: "canceled", reason: "canceled", bytes: 40, totalBytes: 100, file: null });
    expect(f.cancels()).toEqual([]);
    await rec.stop();
  });

  test("still running at the recording's stop: canceled, stopped, written before the bundle closes; browser gone: browser-gone", async () => {
    const a = await setup();
    const rec = await a.record();
    willBegin(a.f);
    a.f.browser("Browser.downloadProgress", { guid: GUID, totalBytes: 64, receivedBytes: 8, state: "inProgress" });
    await Bun.sleep(5);
    await rec.stop();
    expect(a.f.cancels()).toEqual([{ guid: GUID }]);
    expect(downloadEvents(rec.dir).map((e) => [e["state"], e["reason"], e["bytes"], e["file"]])).toEqual([["canceled", "stopped", 8, null]]);
    // a later download of the session (no recording now) is canceled as not-recording, no event anywhere
    willBegin(a.f, { guid: "g-after" });
    await until(() => a.f.cancels().length === 2);

    const b = await setup();
    const rec2 = await b.record();
    willBegin(b.f);
    await Bun.sleep(5);
    b.dl.markGone();
    await rec2.stop();
    expect(downloadEvents(rec2.dir).map((e) => [e["state"], e["reason"]])).toEqual([["canceled", "browser-gone"]]);
  });

  test("the tab closes while it downloads: canceled, stopped", async () => {
    const { f, record } = await setup();
    const rec = await record();
    willBegin(f);
    await Bun.sleep(5);
    f.browser("Target.targetDestroyed", { targetId: "T1" });
    await until(() => rec.downloads.length === 1);
    expect(rec.downloads[0]).toMatchObject({ state: "canceled", reason: "stopped" });
    expect(f.cancels()).toEqual([{ guid: GUID }]);
    await rec.stop();
  });

  test("a completed download being moved when the recording stops is written before the bundle closes", async () => {
    const { f, staging, record } = await setup();
    const rec = await record();
    willBegin(f);
    writeFileSync(join(staging, GUID), "x".repeat(4 * 1024 * 1024));
    progress(f, "completed", 4 * 1024 * 1024, 4 * 1024 * 1024);
    await rec.stop();
    expect(downloadEvents(rec.dir).map((e) => [e["state"], e["reason"], e["bytes"]])).toEqual([["completed", null, 4 * 1024 * 1024]]);
  });

  test("URL and file name pass known-secret replacement; a long data: URL is cut (urlTruncated) in the event", async () => {
    const { f, staging, record } = await setup({ scrub: (s) => s.replaceAll("TOPSECRET", "<secret:site.password>") });
    const rec = await record();
    willBegin(f, { guid: "g-1", url: `${ORIGIN}/f?k=TOPSECRET`, name: "TOPSECRET.txt" });
    willBegin(f, { guid: "g-2", url: `data:text/plain,${"z".repeat(5000)}`, name: "d.txt" });
    for (const g of ["g-1", "g-2"]) {
      writeFileSync(join(staging, g), g);
      progress(f, "completed", 3, 3, g);
    }
    await until(() => rec.downloads.length === 2);
    await rec.stop();
    const evs = downloadEvents(rec.dir);
    const one = evs.find((e) => e["guid"] === "g-1");
    const two = evs.find((e) => e["guid"] === "g-2");
    expect(one).toMatchObject({ url: `${ORIGIN}/f?k=<secret:site.password>`, suggestedFilename: "<secret:site.password>.txt" });
    expect(one?.["urlTruncated"]).toBeUndefined();
    expect(two).toMatchObject({ urlTruncated: true });
    expect(String(two?.["url"]).length).toBe(DATA_URL_MAX);
    expect(JSON.stringify(evs)).not.toContain("TOPSECRET");
  });
});

describe("recorder: an attachment response is not read at the Response stage (§48)", () => {
  test("Content-Disposition attachment: continueResponse at once, no Fetch.getResponseBody (it would wait for the whole file); an inline document still has its body copied", async () => {
    const { f, record } = await setup();
    const rec = await record();
    const paused = (id: string, headers: Array<{ name: string; value: string }>) =>
      f.onPage("Fetch.requestPaused", { requestId: `I${id}`, networkId: id, resourceType: "Document", frameId: "T1", responseStatusCode: 200, responseHeaders: headers, request: { url: `${ORIGIN}/${id}`, method: "GET", headers: {} } });
    paused("A", [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Disposition", value: 'attachment; filename="big.bin"' }]);
    paused("B", [{ name: "content-disposition", value: "Attachment" }]);
    await until(() => f.calls.filter((c) => c.method === "Fetch.continueResponse").length === 2);
    expect(f.calls.filter((c) => c.method === "Fetch.getResponseBody")).toEqual([]);
    paused("C", [{ name: "Content-Type", value: "text/html" }, { name: "Content-Disposition", value: "inline" }]);
    await until(() => f.calls.filter((c) => c.method === "Fetch.continueResponse").length === 3);
    expect(f.calls.filter((c) => c.method === "Fetch.getResponseBody").map((c) => c.params["requestId"])).toEqual(["IC"]);
    await rec.stop();
  });
});

// ---------------------------------------------------------------- navigate's window

describe("navigate to an attachment: the main frame's download within the window (§48)", () => {
  test("a main-frame download after the watch began: the answer's download (recorded: in-progress); a child frame's does not count", async () => {
    const { f, tab, dl, record } = await setup({
      handler: (m, _p, sid) => (m === "Page.getFrameTree" && sid === "S1" ? { frameTree: { frame: { id: "T1" }, childFrames: [{ frame: { id: "C1", parentId: "T1" } }] } } : undefined),
    });
    await record();
    const w = dl.watchMain(tab);
    willBegin(f, { guid: "g-child", frameId: "C1" });
    await Bun.sleep(20);
    willBegin(f, { guid: "g-main", url: `${ORIGIN}/s75/nav`, name: "n.bin" });
    expect(await w.wait(NAV_DOWNLOAD_MS)).toEqual({ url: `${ORIGIN}/s75/nav`, suggestedFilename: "n.bin", state: "in-progress" });
  });

  test("not recording: canceled, not-recording, and the command's generic notice is taken by it", async () => {
    const { f, tabs, tab, dl } = await setup();
    let got: unknown = null;
    await tabs.run(tab, async () => {
      const w = dl.watchMain(tab);
      setTimeout(() => willBegin(f, { url: `${ORIGIN}/s75/nav`, name: "n.bin" }), 30);
      got = await w.wait(NAV_DOWNLOAD_MS);
    });
    expect(got).toEqual({ url: `${ORIGIN}/s75/nav`, suggestedFilename: "n.bin", state: "canceled", reason: "not-recording" });
    expect(dl.takeNotices("s1", 0)).toEqual([]);
  });

  test("none within the window: null after it (the page error stays)", async () => {
    const { tab, dl } = await setup();
    const w = dl.watchMain(tab);
    const t0 = Date.now();
    expect(await w.wait(80)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  test("one that began before the answer counts at once; a completed one says completed", async () => {
    const { f, tab, staging, dl, record } = await setup();
    const rec = await record();
    const w = dl.watchMain(tab);
    willBegin(f);
    writeFileSync(join(staging, GUID), "abc");
    progress(f, "completed", 3, 3);
    await until(() => rec.downloads.length === 1);
    const t0 = Date.now();
    expect(await w.wait(NAV_DOWNLOAD_MS)).toMatchObject({ state: "completed" });
    expect(Date.now() - t0).toBeLessThan(500);
    await rec.stop();
  });
});

// ---------------------------------------------------------------- the bundle afterwards

describe("bundle redact and HAR export with downloads (§48)", () => {
  test("the redacted copy has no downloads/; its download events have file null and redacted true, sha256 and guid kept, the URL redacted; HAR drops the kind", async () => {
    const { f, staging, record } = await setup();
    const rec = await record();
    willBegin(f, { url: `${ORIGIN}/export?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl` });
    writeFileSync(join(staging, GUID), "report");
    progress(f, "completed", 6, 6);
    await until(() => rec.downloads.length === 1);
    await rec.stop();
    expect(existsSync(join(rec.dir, "downloads", sha("report")))).toBe(true);
    const out = join(tmp("red"), "copy");
    await redactBundle(rec.dir, out, { salt: "s" });
    expect(existsSync(join(out, "downloads"))).toBe(false);
    const ev = downloadEvents(out)[0];
    expect(ev).toMatchObject({ file: null, redacted: true, sha256: sha("report"), guid: GUID, state: "completed" });
    expect(String(ev?.["url"])).not.toContain("eyJzdWIiOiIxIn0");
    const har = exportHar(BundleReader.open(rec.dir));
    expect(har.dropped["download"]).toBe(1);
  });
});

// ---------------------------------------------------------------- account contexts

describe("pool contexts take tabcap's download behaviour (§48)", () => {
  test("open with downloadPath: setDownloadBehavior for the new context before anything else in it; refused: the context is disposed and the error is cdp", async () => {
    const f = fakeBrowser((m) => (m === "Target.createBrowserContext" ? { browserContextId: "CTX1" } : undefined));
    const pool = new Pool(() => 1000);
    await pool.open(f.t, { session: "s1", site: "example", account: "alice", proxy: null, downloadPath: "/st/run-1" });
    const methods = f.calls.map((c) => c.method);
    expect(methods.slice(0, 2)).toEqual(["Target.createBrowserContext", "Browser.setDownloadBehavior"]);
    expect(f.calls[1]?.params).toEqual({ behavior: "allowAndName", downloadPath: "/st/run-1", eventsEnabled: true, browserContextId: "CTX1" });

    const g = fakeBrowser((m) => (m === "Target.createBrowserContext" ? { browserContextId: "CTX2" } : m === "Browser.setDownloadBehavior" ? Promise.reject(new Error("Browser context management is not supported.")) : undefined));
    const p2 = new Pool(() => 1000);
    const err = await p2.open(g.t, { session: "s2", site: "example", account: "bob", proxy: null, downloadPath: "/st/run-1" }).catch((e: unknown) => e);
    expect(err instanceof TabcapError ? err.code : String(err)).toBe("cdp");
    expect(g.calls.find((c) => c.method === "Target.disposeBrowserContext")?.params).toEqual({ browserContextId: "CTX2" });
    expect(p2.contexts.size).toBe(0);
  });
});

// ---------------------------------------------------------------- download list / download wait

describe("download list / download wait (§48)", () => {
  async function daemonWith() {
    const s = await setup();
    const d = new Daemon(paths({ TABCAP_HOME: tmp("home") }));
    const rec = await s.record();
    d.recorders.set("s1", rec);
    const finish = async (guid: string, url: string, body: string) => {
      willBegin(s.f, { guid, url });
      writeFileSync(join(s.staging, guid), body);
      progress(s.f, "completed", body.length, body.length, guid);
      await until(() => rec.downloads.some((e) => e.guid === guid));
    };
    return { ...s, d, rec, finish };
  }

  test("not recording: download wait is not-found (as net wait); download list without any recording too", async () => {
    const d = new Daemon(paths({ TABCAP_HOME: tmp("home") }));
    const e = await downloadWait(d, {}, "s1").catch((x: unknown) => x);
    expect(e instanceof TabcapError ? [e.code, e.next] : e).toEqual(["not-found", expect.stringContaining("tabcap net start")]);
    expect(() => downloadList(d, {}, "s1")).toThrow(TabcapError);
  });

  test("wait: the first ended download since the last action command (already finished), --url filters, --fresh waits for a new one, a stopped recording ends the wait", async () => {
    const { d, rec, finish } = await daemonWith();
    await finish("g-a", `${ORIGIN}/a.csv`, "aaa");
    // the action starts strictly after g-a was written (the look-back counts from its start on)
    await Bun.sleep(3);
    d.noteAction("s1", { action: "click", at: Date.now(), cmd: null });
    await finish("g-b", `${ORIGIN}/b.csv`, "bbbb");
    await finish("g-c", `${ORIGIN}/c.csv`, "cc");
    const first = await downloadWait(d, {}, "s1");
    expect(first).toMatchObject({ url: `${ORIGIN}/b.csv`, state: "completed", sha256: sha("bbbb"), alreadyFinished: true, lookBack: { from: "action", action: "click" } });
    expect(isRecord(first) ? first["file"] : null).toBe(join(rec.dir, "downloads", sha("bbbb")));
    expect(await downloadWait(d, { url: "/c.csv" }, "s1")).toMatchObject({ url: `${ORIGIN}/c.csv` });
    expect(await downloadWait(d, { since: "start", url: ".csv" }, "s1")).toMatchObject({ url: `${ORIGIN}/a.csv` });
    const fresh = downloadWait(d, { fresh: true, timeoutMs: 5000 }, "s1");
    await Bun.sleep(20);
    await finish("g-d", `${ORIGIN}/d.csv`, "dddd");
    expect(await fresh).toMatchObject({ url: `${ORIGIN}/d.csv`, alreadyFinished: false });
    const pending = downloadWait(d, { fresh: true, timeoutMs: 5000 }, "s1").catch((x: unknown) => x);
    await rec.stop();
    const stopped = await pending;
    expect(stopped instanceof TabcapError ? stopped.code : stopped).toBe("not-found");
  });

  test("wait times out with timeout; next says how many matching downloads are still in progress and names earlier matches", async () => {
    const { d, rec, finish } = await daemonWith();
    await finish("g-old", `${ORIGIN}/slow-old.bin`, "old");
    d.noteAction("s1", { action: "click", at: Date.now() + 5, cmd: null });
    await Bun.sleep(10);
    const e = await downloadWait(d, { url: "slow", timeoutMs: 100 }, "s1").catch((x: unknown) => x);
    expect(e instanceof TabcapError ? e.code : e).toBe("timeout");
    const next = e instanceof TabcapError ? e.next : "";
    expect(next).toContain("0 matching download(s) still in progress");
    expect(next).toContain("--since start");
    await rec.stop();
  });

  test("list: ended downloads in the order they began (absolute file paths), then the ones in progress; after net stop the last bundle's", async () => {
    const { d, f, staging, rec } = await daemonWith();
    willBegin(f, { guid: "g-1", url: `${ORIGIN}/one` });
    await Bun.sleep(5);
    willBegin(f, { guid: "g-2", url: `${ORIGIN}/two` });
    // the second ends first
    writeFileSync(join(staging, "g-2"), "two");
    progress(f, "completed", 3, 3, "g-2");
    writeFileSync(join(staging, "g-1"), "one");
    await until(() => rec.downloads.length === 1);
    progress(f, "completed", 3, 3, "g-1");
    await until(() => rec.downloads.length === 2);
    const l = downloadList(d, {}, "s1");
    const rows = isRecord(l) && Array.isArray(l["downloads"]) ? l["downloads"].filter(isRecord) : [];
    expect(rows.map((x) => x["url"])).toEqual([`${ORIGIN}/one`, `${ORIGIN}/two`]);
    expect(rows.map((x) => x["file"])).toEqual([join(rec.dir, "downloads", sha("one")), join(rec.dir, "downloads", sha("two"))]);
    expect(l).toMatchObject({ recording: true, total: 2 });
    await rec.stop();
    d.recorders.delete("s1");
    d.lastBundles.set("s1", rec);
    expect(downloadList(d, {}, "s1")).toMatchObject({ recording: false, total: 2, bundle: rec.dir });
  });
});

