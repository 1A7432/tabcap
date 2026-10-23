// tabcap download list | wait (0.9-D, docs/04 §48): the downloads of the
// session's recording. A download is kept only while the session records
// (capture/downloads.ts cancels the others); a kept one is a `download` event
// with its file in the bundle's downloads/. `download wait` looks back as
// `net wait` does (netquery.ts lookBack: since the session's last action
// command, `--since c-12|start`, `--fresh`) and returns the first matching
// download that ended, completed or canceled.

import { join } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import type { DownloadEntry, Recorder } from "../capture/recorder.ts";
import type { Daemon } from "../state.ts";
import { optBool, optStr, type Args } from "./args.ts";
import { lookBack } from "./netquery.ts";
import { lookLabel, timeoutError } from "./wait.ts";
import { listForHint, waitTimeout } from "./waitspec.ts";

/** One ended download as `download list` / `download wait` answer it (`file`: the absolute path of its copy in the bundle). */
export function downloadRow(dir: string, e: DownloadEntry): Record<string, unknown> {
  return {
    id: e.id,
    tab: e.tab,
    url: e.url,
    ...(e.urlTruncated === true ? { urlTruncated: true } : {}),
    suggestedFilename: e.suggestedFilename,
    state: e.state,
    reason: e.reason,
    bytes: e.bytes,
    totalBytes: e.totalBytes,
    file: e.file === null ? null : join(dir, ...e.file.split("/")),
    sha256: e.sha256,
  };
}

/** Ended downloads in the order they began (an event is written when one ends). */
function byStart(list: readonly DownloadEntry[]): DownloadEntry[] {
  return [...list].sort((a, b) => a.startedTs - b.startedTs || a.seq - b.seq);
}

export function downloadList(d: Daemon, _a: Args, session: string): unknown {
  const live = d.recorders.get(session);
  const r: Recorder | undefined = live ?? d.lastBundles.get(session);
  if (r === undefined) throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start`, trigger the download, then `tabcap download list` (outside a recording tabcap cancels downloads).");
  const ended = byStart(r.downloads).map((e) => downloadRow(r.dir, e));
  const running = live === undefined ? [] : (d.browser?.downloads.inProgress(live) ?? []);
  return { session, bundle: r.dir, recording: live !== undefined, total: ended.length + running.length, downloads: [...ended, ...running] };
}

export async function downloadWait(d: Daemon, a: Args, session: string): Promise<unknown> {
  const url = optStr(a, "url");
  const timeoutMs = waitTimeout(a);
  const rec = d.recorders.get(session);
  if (rec === undefined) throw new TabcapError("not-found", `session "${session}" is not recording`, "Run `tabcap net start` before the action that downloads, then `tabcap download wait`.");
  const started = Date.now();
  const look = lookBack({ sinceArg: optStr(a, "since"), fresh: optBool(a, "fresh"), now: started, recordingStart: rec.startedAt, last: d.lastAction(session), cmdStart: (id) => rec.cmdStarts.get(id) ?? null });
  const fits = (e: DownloadEntry) => e.at >= look.since && (url === null || e.url.includes(url));
  const result = (e: DownloadEntry, already: boolean) => ({
    ...downloadRow(rec.dir, e),
    alreadyFinished: already,
    lookBack: { from: look.from, cmd: look.cmd, action: look.action },
    waitedMs: Date.now() - started,
    timeoutMs,
  });
  // The first one that ended since the look-back point (a fast download must not be missed).
  const first = rec.downloads.find(fits);
  if (first !== undefined) return result(first, true);
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      off();
      clearTimeout(timer);
      clearInterval(watch);
    };
    const off = rec.onDownload((e) => {
      if (!fits(e)) return;
      cleanup();
      resolve(result(e, false));
    });
    const watch = setInterval(() => {
      if (rec.recording) return;
      cleanup();
      reject(new TabcapError("not-found", `the recording of session "${session}" stopped while waiting`, "Run `tabcap net start` again, repeat the action, then `tabcap download wait`."));
    }, 200);
    const timer = setTimeout(() => {
      cleanup();
      const what = url === null ? "any download" : `a download whose URL contains ${JSON.stringify(url)}`;
      const running = (d.browser?.downloads.inProgress(rec) ?? []).filter((x) => url === null || x.url.includes(url));
      const earlier = rec.downloads.filter((e) => e.at < look.since && (url === null || e.url.includes(url))).map((e) => `${e.id} (${e.state})`);
      const parts = [`${what} ending after ${lookLabel(look)}`, `${running.length} matching download(s) still in progress${running.length === 0 ? "" : `: ${listForHint(running.map((x) => `${x.receivedBytes} bytes of ${x.totalBytes ?? "?"}`))}`}`];
      if (earlier.length > 0) parts.push(`earlier ended matches before that point: ${listForHint(earlier.reverse())} — \`tabcap download list\`, or accept them with --since start`);
      reject(timeoutError(`download wait for ${what}`, timeoutMs, parts.join("; "), "Check `tabcap download list`; the action may not have started a download"));
    }, timeoutMs);
  });
}
