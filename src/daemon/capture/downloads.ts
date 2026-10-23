// Downloads in the direct mode (0.9-D, docs/04 §48). Oracle for Chrome's
// behaviour: spike-dp5 E4 / E4b / E4c (docs/07 §1.1) and the 0.9-D spike
// notes in NOTES (Chrome for Testing 155).
// - browser start (and every account context, pool/runtime.ts) sets
//   `Browser.setDownloadBehavior {allowAndName, downloadPath: <staging>,
//   eventsEnabled}`: Chrome saves every download as <staging>/<guid> (never the
//   page's file name), no longer into the user's ~/Downloads, and its
//   "multiple automatic downloads" limiter no longer applies;
// - `Browser.downloadWillBegin` (browser level, no sessionId) names the frame:
//   the tab's targetId for its main frame, a child frame's id otherwise (an
//   OOPIF's id is its own target's). The tab is found from that; a download no
//   tab of a tabcap session owns is canceled;
// - outside a recording a download is canceled at once (`Browser.cancelDownload`,
//   with the tab's browser context: Chrome finds no download of another context
//   without it) and a file Chrome already finished is deleted; when it began
//   while a command ran on the tab (Tabs.busy) the command's answer lists it
//   (`takeNotices`, daemon/main.ts), otherwise it is only logged;
// - while the session records: past the 200 MiB cap (Chrome's progress events
//   are coarse, so this is a soft cap) it is canceled `too-large`; a completed
//   one is moved into the bundle's downloads/ (bundle/downloads.ts) and written
//   as a `download` event; one Chrome cancels is `canceled`; one still running
//   at net stop / session stop / tab close is canceled `stopped`, when the
//   browser went away `browser-gone`. Each download gets one event, written when
//   tabcap knows how it ended; later progress events only clean up its file.
// Every field of the CDP events is untrusted: wrong types are ignored, a guid
// that is not a plain token never becomes a path.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DownloadFields } from "../../bundle/types.ts";
import { storeDownload } from "../../bundle/downloads.ts";
import { num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { nowMs } from "../../shared/time.ts";
import { framesOfTree, oopifTargets } from "../browser/frames.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import type { CdpEvent, Transport } from "../transport/types.ts";
import type { Recorder } from "./recorder.ts";

/** docs/04 §48: the size cap of one download, 200 MiB (a constant, not a setting). */
export const DOWNLOAD_CAP_BYTES = 209_715_200;
/** A `data:` URL longer than this many characters is cut (`urlTruncated`). */
export const DATA_URL_MAX = 2048;
/** `navigate` (docs/04 §48): a main-frame download beginning this long after Page.navigate answered net::ERR_ABORTED makes the URL a download. */
export const NAV_DOWNLOAD_MS = 1000;
/** Notices no command answer took are forgotten after this long. */
const NOTICE_KEEP_MS = 120_000;
/** Chrome's guids are UUIDs; only such a plain token is ever joined into a staging path. */
const SAFE_GUID = /^[A-Za-z0-9-]{1,64}$/;

/** The `next` of an answer that lists a download canceled outside a recording (docs/04 §48). */
export const NOT_RECORDING_NEXT = "The session is not recording, so tabcap canceled the download: run `tabcap net start`, then trigger it again; the file then goes into the evidence bundle (`tabcap download wait`).";

/** Why tabcap canceled a download (`unowned`: no tab of a tabcap session; only logged). */
export type CancelReason = "not-recording" | "too-large" | "stopped" | "browser-gone" | "unowned";

/** A download a command's answer lists (docs/04 §48): canceled because the session does not record. */
export type DownloadNotice = { url: string; urlTruncated?: true; suggestedFilename: string; state: "canceled"; reason: "not-recording" };

/** The `download` of a `navigate` answer: the URL was a file download. */
export type NavDownload = { url: string; urlTruncated?: true; suggestedFilename: string; state: "in-progress" | "completed" | "canceled"; reason?: CancelReason | "canceled" };

/** A recorded download still running (`download list`). */
export type InProgressRow = { guid: string; tab: string; url: string; suggestedFilename: string; state: "in-progress"; receivedBytes: number; totalBytes: number | null };

type Start = { cmd: string | null; actor: "human" | "ai" | "system"; nav: string | null };

type Live = {
  guid: string;
  frameId: string | null;
  /** Secret-replaced, a long `data:` URL cut. */
  url: string;
  urlTruncated: boolean;
  suggestedFilename: string;
  /** Epoch ms when it began. */
  startedTs: number;
  /** Daemon clock when it began (notices). */
  startedAt: number;
  /** Null while the owner is looked up, and for a download no tab owns. */
  tab: Tab | null;
  /** The recording it goes into; null when it was canceled outside one. */
  rec: Recorder | null;
  start: Start | null;
  receivedBytes: number;
  totalBytes: number | null;
  /** tabcap asked Chrome to cancel it, and why. */
  canceled: CancelReason | null;
  /** Its event is written (or it never gets one): later progress only removes its file. */
  finished: boolean;
  /** How it ended, once known (the `navigate` answer). */
  ended: { state: "completed" | "canceled"; reason: DownloadFields["reason"] } | null;
  /** Its CDP events are handled in order, one after the other. */
  chain: Promise<void>;
};

export type DownloadsDeps = {
  t: Transport;
  tabs: Tabs;
  /** This browser run's staging directory (the downloadPath Chrome was given). */
  staging: string;
  /** The session's open recording. */
  recorder: (session: string) => Recorder | undefined;
  /** Known-secret replacement for the page-given URL and file name. */
  scrub: (s: string) => string;
  /** Tests make it smaller (docs/05 s75 step 4); default DOWNLOAD_CAP_BYTES. */
  cap?: number;
  now?: () => number;
};

/**
 * A new staging directory for one browser run under `root` (0700, as `root`): `run-<random>`.
 * Directories of earlier runs are removed first: only one daemon uses a TABCAP_HOME, and a
 * browser that is not running has no download in flight (a daemon that died left them behind).
 */
export function openStaging(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) if (name.startsWith("run-")) dropStaging(join(root, name));
  const dir = mkdtempSync(join(root, "run-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** Remove a browser run's staging directory and what is left in it (browser stop, daemon stop, browser gone). */
export function dropStaging(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn("downloads: removing the staging directory failed", { error: String(e) });
  }
}

/** The `downloadPath` behaviour tabcap gives the default context and each account context. */
export function downloadBehavior(staging: string, browserContextId?: string): Record<string, unknown> {
  return { behavior: "allowAndName", downloadPath: staging, eventsEnabled: true, ...(browserContextId === undefined ? {} : { browserContextId }) };
}

/** A download URL as the bundle and the answers show it: secrets replaced, a `data:` URL over DATA_URL_MAX characters cut. */
export function shownDownloadUrl(url: string, scrub: (s: string) => string): { url: string; urlTruncated: boolean } {
  const s = scrub(url);
  if (s.startsWith("data:") && s.length > DATA_URL_MAX) return { url: s.slice(0, DATA_URL_MAX), urlTruncated: true };
  return { url: s, urlTruncated: false };
}

export class Downloads {
  private readonly live = new Map<string, Live>();
  private notices: Array<{ session: string; guid: string; at: number; notice: DownloadNotice }> = [];
  private readonly mainWatchers = new Set<(l: Live) => void>();
  private readonly hooked = new WeakSet<Recorder>();
  private offs: Array<() => void> = [];
  private gone = false;
  private readonly cap: number;
  private readonly now: () => number;

  /** This browser run's staging directory. */
  get staging(): string {
    return this.deps.staging;
  }

  constructor(private readonly deps: DownloadsDeps) {
    this.cap = deps.cap ?? DOWNLOAD_CAP_BYTES;
    this.now = deps.now ?? Date.now;
    this.offs.push(
      deps.t.onEvent((e) => this.onEvent(e)),
      deps.t.onDetach((x) => this.tabGone((tab) => tab.sessionId === x.sessionId)),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.mainWatchers.clear();
  }

  /** The browser went away: recorded downloads still running end with reason `browser-gone` when their recording stops. */
  markGone(): void {
    this.gone = true;
  }

  /** Recorded downloads of `rec` still running, in the order they began (`download list`). */
  inProgress(rec: Recorder): InProgressRow[] {
    return [...this.live.values()]
      .filter((l) => l.rec === rec && !l.finished && l.tab !== null)
      .map((l) => ({ guid: l.guid, tab: l.tab?.id ?? "", url: l.url, suggestedFilename: l.suggestedFilename, state: "in-progress" as const, receivedBytes: l.receivedBytes, totalBytes: l.totalBytes }));
  }

  /**
   * The downloads of `session` canceled outside a recording that began while a command ran on
   * their tab, at or after `since` (daemon clock): for that command's answer. Each is given once.
   */
  takeNotices(session: string, since: number): DownloadNotice[] {
    const mine = this.notices.filter((n) => n.session === session && n.at >= since);
    this.notices = this.notices.filter((n) => !mine.includes(n));
    return mine.map((n) => n.notice);
  }

  /**
   * `navigate` (docs/04 §48): from now on, the first download of `tab`'s main frame, once
   * tabcap decided about it (recorded, or canceled outside a recording). `wait(ms)` resolves
   * with it, or null when none began within `ms` after the call; the notice of a canceled one
   * is taken (the navigate answer has it in `download`).
   */
  watchMain(tab: Tab): { wait: (ms: number) => Promise<NavDownload | null>; stop: () => void } {
    let seen: Live | null = null;
    let wake: (() => void) | null = null;
    const fn = (l: Live) => {
      if (seen !== null || l.tab !== tab || l.frameId !== tab.targetId) return;
      seen = l;
      wake?.();
    };
    this.mainWatchers.add(fn);
    const stop = () => {
      this.mainWatchers.delete(fn);
    };
    const answer = (l: Live): NavDownload => {
      this.notices = this.notices.filter((n) => n.guid !== l.guid);
      const base = { url: l.url, ...(l.urlTruncated ? { urlTruncated: true as const } : {}), suggestedFilename: l.suggestedFilename };
      if (l.ended !== null) return { ...base, state: l.ended.state, ...(l.ended.reason === null ? {} : { reason: l.ended.reason }) };
      if (l.canceled !== null) return { ...base, state: "canceled", reason: l.canceled };
      return { ...base, state: "in-progress" };
    };
    const wait = (ms: number): Promise<NavDownload | null> =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wake = null;
          stop();
          resolve(seen === null ? null : answer(seen));
        };
        const timer = setTimeout(done, Math.max(0, ms));
        if (seen !== null) done();
        else wake = done;
      });
    return { wait, stop };
  }

  private onEvent(e: CdpEvent): void {
    if (e.sessionId !== null) return;
    switch (e.method) {
      case "Browser.downloadWillBegin":
        this.begin(e.params);
        return;
      case "Browser.downloadProgress":
        this.progress(e.params);
        return;
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const id = str(e.params, "targetId");
        if (id !== null) this.tabGone((tab) => tab.targetId === id);
        return;
      }
    }
  }

  private begin(p: Record<string, unknown>): void {
    const guid = str(p, "guid");
    if (guid === null || guid === "" || this.live.has(guid)) return;
    const frameId = str(p, "frameId");
    const shown = shownDownloadUrl(str(p, "url") ?? "", this.deps.scrub);
    const l: Live = {
      guid,
      frameId,
      url: shown.url,
      urlTruncated: shown.urlTruncated,
      suggestedFilename: this.deps.scrub(str(p, "suggestedFilename") ?? ""),
      startedTs: nowMs(),
      startedAt: this.now(),
      tab: null,
      rec: null,
      start: null,
      receivedBytes: 0,
      totalBytes: null,
      canceled: null,
      finished: false,
      ended: null,
      chain: Promise.resolve(),
    };
    this.live.set(guid, l);
    // A tab's main frame or an OOPIF is known at once: decide now, while the command window is the one it began in.
    const known = frameId === null ? null : this.tabOfTarget(frameId);
    l.chain = known !== undefined ? this.decide(l, known) : this.ownerByFrames(frameId ?? "").then((tab) => this.decide(l, tab));
    l.chain = l.chain.catch((e: unknown) => log.warn("downloads: handling a download that began failed", { error: String(e) }));
  }

  /** The tab whose main frame or OOPIF target is `frameId`; undefined when only the frame trees can tell. */
  private tabOfTarget(frameId: string): Tab | null | undefined {
    const tab = this.deps.tabs.byTarget(frameId);
    if (tab !== undefined) return tab;
    const oopif = this.deps.t.targets().find((x) => x.targetId === frameId && x.type === "iframe");
    if (oopif !== undefined) return this.deps.tabs.hostOf(oopif.sessionId) ?? null;
    return undefined;
  }

  /** A same-process child frame: the open tab whose frame tree (its own, its OOPIFs') holds `frameId`, or null. */
  private async ownerByFrames(frameId: string): Promise<Tab | null> {
    if (frameId === "") return null;
    const { t, tabs } = this.deps;
    for (const tab of [...tabs.tabs.values()].filter((x) => !x.closed)) {
      for (const sid of [tab.sessionId, ...oopifTargets(t.targets(), tab.sessionId).map((x) => x.sessionId)]) {
        const tree = await t.send("Page.getFrameTree", {}, sid, 2000).catch(() => null);
        if (framesOfTree(tree, sid, sid !== tab.sessionId).some((f) => f.frameId === frameId)) return tab;
      }
    }
    return null;
  }

  /** Recorded (the session records) or canceled; synchronous up to the cancel call, so the start is the command window it began in. */
  private decide(l: Live, tab: Tab | null): Promise<void> {
    l.tab = tab;
    if (tab === null) {
      l.canceled = "unowned";
      l.finished = true;
      log.info("download canceled: no tab of a tabcap session started it");
      return this.cancel(l).then(() => undefined);
    }
    const rec = this.deps.recorder(tab.session);
    const start = rec?.downloadStart(tab.id) ?? null;
    if (rec === undefined || start === null) {
      l.canceled = "not-recording";
      l.finished = true;
      if (this.deps.tabs.busy(tab)) {
        const now = this.now();
        this.notices = this.notices.filter((n) => now - n.at < NOTICE_KEEP_MS);
        this.notices.push({ session: tab.session, guid: l.guid, at: l.startedAt, notice: { url: l.url, ...(l.urlTruncated ? { urlTruncated: true as const } : {}), suggestedFilename: l.suggestedFilename, state: "canceled", reason: "not-recording" } });
      } else log.info("download canceled outside a command: the session is not recording", { session: tab.session, tab: tab.id });
      this.tellWatchers(l);
      return this.cancel(l).then(() => undefined);
    }
    l.rec = rec;
    l.start = start;
    this.hookStop(rec);
    this.tellWatchers(l);
    return Promise.resolve();
  }

  private tellWatchers(l: Live): void {
    for (const fn of [...this.mainWatchers]) fn(l);
  }

  /** Browser.cancelDownload in the tab's context first, then the default and every account context (Chrome finds a download only in its own). */
  private async cancel(l: Live): Promise<boolean> {
    const own = l.tab === null ? undefined : this.deps.tabs.contexts.get(l.tab.session);
    const order = [own, undefined, ...this.deps.tabs.contexts.values()].filter((c, i, all) => all.indexOf(c) === i);
    let last: unknown = null;
    for (const browserContextId of order) {
      try {
        await this.deps.t.send("Browser.cancelDownload", { guid: l.guid, ...(browserContextId === undefined ? {} : { browserContextId }) }, null, 5000);
        return true;
      } catch (e) {
        last = e;
      }
    }
    // Usually: it had already finished (its file is removed when Chrome reports it), or the browser is gone.
    log.debug("downloads: Browser.cancelDownload found nothing to cancel", { error: String(last) });
    return false;
  }

  private progress(p: Record<string, unknown>): void {
    const guid = str(p, "guid");
    if (guid === null) return;
    const state = str(p, "state");
    const received = num(p, "receivedBytes");
    const total = num(p, "totalBytes");
    const l = this.live.get(guid);
    if (l === undefined) {
      // A download tabcap never saw begin: its file does not stay.
      if (state === "completed") this.removeStaged(guid);
      return;
    }
    l.chain = l.chain
      .then(() => this.onProgress(l, state, received, total))
      .catch((e: unknown) => log.warn("downloads: handling a download's progress failed", { error: String(e) }));
  }

  private async onProgress(l: Live, state: string | null, received: number | null, total: number | null): Promise<void> {
    // A canceled download reports 0/0: keep what had arrived.
    if (received !== null && Number.isFinite(received) && received > l.receivedBytes) l.receivedBytes = received;
    if (total !== null && Number.isFinite(total) && total > 0) l.totalBytes = total;
    if (state === "inProgress") {
      if (!l.finished && l.rec !== null && ((l.totalBytes !== null && l.totalBytes > this.cap) || l.receivedBytes > this.cap)) await this.stopOne(l, "too-large");
      return;
    }
    if (state !== "completed" && state !== "canceled") return;
    // Kept in `live` until handled: a recording that stops meanwhile waits for this event (hookStop).
    try {
      await this.ended(l, state, received);
    } finally {
      this.live.delete(l.guid);
    }
  }

  private async ended(l: Live, state: "completed" | "canceled", received: number | null): Promise<void> {
    if (state === "canceled" || l.finished || l.rec === null) {
      this.removeStaged(l.guid);
      if (!l.finished) this.write(l, { state: "canceled", reason: "canceled", file: null, sha256: null, bytes: l.receivedBytes });
      l.finished = true;
      return;
    }
    // Completed while recording; one that finished past the cap before tabcap's cancel took effect stays out.
    if (l.totalBytes === null && received !== null && received >= 0) l.totalBytes = received;
    if (l.receivedBytes > this.cap) {
      this.removeStaged(l.guid);
      this.write(l, { state: "canceled", reason: "too-large", file: null, sha256: null, bytes: l.receivedBytes });
      return;
    }
    const staged = this.stagedPath(l.guid);
    let stored: Awaited<ReturnType<typeof storeDownload>> | null = null;
    if (staged !== null && l.rec.recording) {
      try {
        stored = await storeDownload(l.rec.dir, staged);
      } catch (e) {
        log.warn("downloads: moving a finished download into the bundle failed", { error: String(e) });
        this.removeStaged(l.guid);
      }
    }
    this.write(l, { state: "completed", reason: null, file: stored?.file ?? null, sha256: stored?.sha256 ?? null, bytes: stored?.bytes ?? l.receivedBytes });
  }

  /** tabcap ends a recorded download (too-large, stopped, browser-gone): its event now, then the cancel. */
  private async stopOne(l: Live, reason: "too-large" | "stopped" | "browser-gone"): Promise<void> {
    if (l.finished) return;
    l.canceled = reason;
    this.write(l, { state: "canceled", reason, file: null, sha256: null, bytes: l.receivedBytes });
    await this.cancel(l);
    // Chrome deletes the part it had; a file it finished meanwhile is removed when it says so.
  }

  private write(l: Live, o: { state: "completed" | "canceled"; reason: DownloadFields["reason"]; file: string | null; sha256: string | null; bytes: number }): void {
    l.finished = true;
    l.ended = { state: o.state, reason: o.reason };
    if (l.rec === null || l.start === null || l.tab === null) return;
    const written = l.rec.download(
      l.tab.id,
      {
        nav: l.start.nav,
        url: l.url,
        ...(l.urlTruncated ? { urlTruncated: true as const } : {}),
        suggestedFilename: l.suggestedFilename,
        guid: l.guid,
        state: o.state,
        reason: o.reason,
        bytes: o.bytes,
        totalBytes: l.totalBytes,
        file: o.file,
        sha256: o.sha256,
        startedTs: l.startedTs,
      },
      { cmd: l.start.cmd, actor: l.start.actor },
    );
    if (written === null) log.warn("downloads: the recording closed before a download's event could be written", { tab: l.tab.id });
  }

  /** At the start of the recording's stop: wait for what its downloads are doing, then end those still running. */
  private hookStop(rec: Recorder): void {
    if (this.hooked.has(rec)) return;
    this.hooked.add(rec);
    rec.beforeStop(async () => {
      const reason = this.gone ? "browser-gone" : "stopped";
      for (const l of [...this.live.values()].filter((x) => x.rec === rec)) {
        l.chain = l.chain.then(() => this.stopOne(l, reason)).catch((e: unknown) => log.warn("downloads: ending a download at stop failed", { error: String(e) }));
        await l.chain;
      }
    });
  }

  /** A tab closed (or crashed): its recorded downloads still running end as `stopped`. */
  private tabGone(match: (tab: Tab) => boolean): void {
    for (const l of this.live.values()) {
      if (l.tab === null || l.rec === null || l.finished || !match(l.tab)) continue;
      l.chain = l.chain.then(() => this.stopOne(l, "stopped")).catch((e: unknown) => log.warn("downloads: ending a closed tab's download failed", { error: String(e) }));
    }
  }

  private stagedPath(guid: string): string | null {
    return SAFE_GUID.test(guid) ? join(this.deps.staging, guid) : null;
  }

  private removeStaged(guid: string): void {
    const p = this.stagedPath(guid);
    if (p === null) return;
    try {
      rmSync(p, { force: true });
    } catch (e) {
      log.warn("downloads: removing a staged download failed", { error: String(e) });
    }
  }
}
