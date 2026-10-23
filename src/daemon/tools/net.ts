// tabcap net start | stop | list | body | show — per-session recording into an evidence bundle.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../../bundle/blobs.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { compactStamp, nowMs } from "../../shared/time.ts";
import { isTextMime } from "../capture/cdpnet.ts";
import { Recorder, type NetEntry, type SseEntry, type WsFrameEntry } from "../capture/recorder.ts";
import { pageOf, parseListQuery, selectNet, type ListQuery, type Paged } from "./netquery.ts";
import { bodyPreview, listUrl } from "./formatters.ts";
import { findRequestEvent, frameDetail, materialize, notFound, requestDetail, sseDetail } from "./netshow.ts";
import { inlineBytes } from "../capture/ws.ts";
import type { Daemon } from "../state.ts";
import { noteAccountRequest } from "./pool.ts";
import { checkSessionName, optBool, optStr, reqStr, type Args } from "./args.ts";
import { bodySearchOf, charsetOf, decodeBody, netGrep, prettify, requestByUrl, searchBody } from "./netsearch.ts";
import { splitLines } from "./textsearch.ts";
import { exportBody, fileFlagOf } from "./bodyexport.ts";
import { DecodeSession } from "../hooks/decode.ts";
import { latestViews, overlayEvent, parseDecoded, readSidecar } from "../../bundle/decoded.ts";
import { decodedPayload } from "../../analyze/views.ts";
import { suspectOf } from "../trace/observe.ts";
import { isRecord } from "../../shared/json.ts";
import { liveDecodePlugins } from "../hooks/plugins.ts";
import { redactedDetail, redactUrl, revealOf, withRedactedUrl, type LiveCtx } from "./liveredact.ts";
import { parseBodiesMode, type BodiesMode } from "../../shared/bodies.ts";
import { readRecordBodies } from "../../shared/config.ts";
import { allSiteRules } from "../siterules.ts";
import { hostLaunchContext, normalizedLaunchArgs, type LaunchArgsContext } from "../../shared/launchargs.ts";
import { isEventStream } from "../../shared/sse.ts";

/** 0.6-E: how a net command prints values (docs/04 §8.3); null with --reveal. */
const liveCtx = (d: Daemon, a: Args): LiveCtx | null => (revealOf(a) ? null : { scrub: (s) => d.secrets.scrub(s) });

/** 0.6-I: `--bodies`, else config.json `record.bodies`, else all. */
export function bodiesOf(d: Daemon, a: Args): BodiesMode {
  const flag = optStr(a, "bodies");
  return flag === null ? readRecordBodies(d.paths.configFile) : parseBodiesMode(flag, "flag");
}

/**
 * 0.8.1-A: the command line for the manifest (docs/04 §42): no local profile / extension path,
 * no URL credentials, the home directory as <home> (review 10-21), known secrets replaced.
 */
export function manifestLaunch(
  info: { args: string[]; extraArgs: string[]; dropArgs: string[] },
  scrub: (s: string) => string,
  ctx: LaunchArgsContext,
): { args: string[]; extraArgs: string[]; dropArgs: string[] } {
  const clean = (list: string[]) => normalizedLaunchArgs(list, ctx).map(scrub);
  return { args: clean(info.args), extraArgs: clean(info.extraArgs), dropArgs: clean(info.dropArgs) };
}

export async function netStart(d: Daemon, a: Args, session: string): Promise<unknown> {
  checkSessionName(session);
  const bodies = bodiesOf(d, a);
  // 0.6-I: a bad site stop rule in config.json is refused here, not silently skipped later.
  allSiteRules(d.paths.configFile);
  const { t, tabs, info, console, extensionDir } = d.need();
  const have = d.recorders.get(session);
  if (have !== undefined) {
    const asked = optStr(a, "bodies");
    return {
      session,
      bundle: have.dir,
      alreadyRecording: true,
      bodies: have.bodies,
      ...(asked !== null && bodies !== have.bodies ? { note: `already recording with --bodies ${have.bodies}; run \`tabcap net stop\` first to record with --bodies ${bodies}` } : {}),
    };
  }
  tabs.ensureSession(session);
  // Bundle names have second resolution: a second recording of the same session
  // within one second gets a -2, -3 … suffix instead of a conflict (seen in e2e
  // when a test starts a recording right after the previous one stopped).
  const base = join(d.paths.bundles, `${session}-${compactStamp(nowMs())}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) {
    if (n > 99) throw new TabcapError("conflict", `bundle ${base} already exists (and 98 suffixed ones)`, "Wait a second and run `tabcap net start` again.");
    dir = `${base}-${n}`;
  }
  const bound = d.sites.get(session) ?? null;
  // 0.6-B: the enabled decode plugins; 0.7-E: read per body, so `plugin enable`
  // during the recording applies to the next body (not to bodies already written).
  let rec: Recorder | null = null;
  const decode = new DecodeSession(d.decodeHost, liveDecodePlugins(d.paths.config), {
    scrub: (s) => d.secrets.scrub(s),
    onDisabled: (name, reason) => void rec?.note(`decode plugin ${name} disabled for this session: ${reason}`, { plugin: name }),
  });
  const r = await Recorder.start({
    session,
    dir,
    t,
    tabs,
    browser: { version: info.version, userAgent: info.userAgent, webdriver: info.webdriver, launch: manifestLaunch(info, (s) => d.secrets.scrub(s), hostLaunchContext(extensionDir)) },
    console,
    scrub: (s) => d.secrets.scrub(s),
    site: bound,
    bodies,
    onFinished: (done) => d.store?.finishBundle(done),
    // 0.4-D: proxy credentials never reach raw/cdp.jsonl or events.jsonl.
    scrubOut: (line) => d.proxySecrets.scrub(line),
    // 0.4-D: a pool account's cookies go back to the store on every snapshot.
    onCookieState: () => {
      if (d.store !== null && d.pool.contexts.has(session)) d.pool.saveSoon(d.store, t, session, () => d.refreshSecrets());
    },
    decode,
    // 0.7.1-A: the human operating a waiting session's tab makes its events `actor:"human"` (docs/04 §16, §37).
    humanActive: () => d.guard.isHumanActive(session),
    humanRecorder: d.browser?.takeover !== null && d.browser?.takeover !== undefined,
  });
  rec = r;
  // 0.4-D: recorded requests count against the account's hourly budget (and the egress rotation trigger).
  r.onIndexed(() => noteAccountRequest(d, session));
  d.store?.noteBundle({ path: dir, site: bound?.site ?? null, sessionName: session });
  d.guard.watch(r);
  d.recorders.set(session, r);
  // Trace mode already on: this recording gets a trace window from now on (0.4-F).
  d.tracers.get(session)?.attachRecorder(r);
  return {
    session,
    bundle: dir,
    alreadyRecording: false,
    bodies,
    instrumentation:
      "Fetch interception (Response stage) on XHR / Fetch / Document: responses pause ~2 ms while bodies are copied; streaming responses (text/event-stream, application/x-ndjson) are passed through at once and read as they arrive; while a same-origin `tabcap fetch` runs, its tab's fetch() requests also pause at the Request stage (the x-tabcap-fetch marker is removed, nothing else changes)",
    ...(decode.empty ? {} : { decode: decode.plugins.map((p) => p.name) }),
  };
}

export async function netStop(d: Daemon, _a: Args, session: string): Promise<unknown> {
  const r = d.recorders.get(session);
  if (r === undefined) throw new TabcapError("not-found", `session "${session}" is not recording`, "Run `tabcap net start` first.");
  const res = await r.stop();
  d.recorders.delete(session);
  d.lastBundles.set(session, r);
  return { session, bundle: res.dir, requests: res.requests, counts: res.counts };
}

type Rec = { dir: string; index: NetEntry[]; frames: WsFrameEntry[]; sse: SseEntry[]; recording: boolean; rec: Recorder };

export function current(d: Daemon, session: string): Rec {
  const r = d.recorders.get(session);
  if (r !== undefined) return { dir: r.dir, index: r.index, frames: r.frames, sse: r.sse, recording: true, rec: r };
  const last = d.lastBundles.get(session);
  if (last !== undefined) return { dir: last.dir, index: last.index, frames: last.frames, sse: last.sse, recording: false, rec: last };
  throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start`, reproduce the page action, then `tabcap net list`.");
}

export function netList(d: Daemon, a: Args, session: string): unknown {
  const { dir, index, frames, sse, recording, rec } = current(d, session);
  const kind = optStr(a, "kind") ?? "http";
  if (kind !== "http" && kind !== "ws" && kind !== "sse") {
    throw new TabcapError("usage", `--kind ${kind}?`, "Use `--kind http` (requests, the default), `--kind ws` (WebSocket frames) or `--kind sse` (Server-Sent Events messages).");
  }
  const q = parseListQuery(a, (id) => rec.cmdStarts.get(id) ?? null);
  const c = liveCtx(d, a);
  const shownUrl = (u: string) => listUrl(c === null ? u : redactUrl(u, c));
  if (kind === "ws") return wsList(dir, frames, recording, session, q, shownUrl);
  if (kind === "sse") return sseList(dir, sse, recording, session, q);
  const r = selectNet(index, q);
  const notes: string[] = [];
  if (r.hidden.failed > 0) notes.push(`${r.hidden.failed} failed request(s) hidden: --failed shows only them, --all shows everything`);
  if (r.hidden.data > 0) notes.push(`${r.hidden.data} data: URL(s) hidden: --all shows them`);
  if (r.nextPageIdx !== null) notes.push(`more: --page-idx ${r.nextPageIdx}`);
  return {
    session,
    bundle: dir,
    recording,
    total: r.total,
    matched: r.matched,
    shown: r.shown,
    hidden: r.hidden,
    ...pagedFields(r),
    // 0.7-C: `bytes` in the answer (docs/04 §2.1); the index keeps the on-disk `size`.
    requests: r.rows.map(({ blob: _b, at: _at, url, ...rest }) => ({ ...withBytes(rest), ...shownUrl(url) })),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

/** A row with its `size` (a byte count, the on-disk name) answered as `bytes`, in place (0.7-C, docs/04 §2.1). */
export function withBytes(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k === "size" ? "bytes" : k, v]));
}

/** The paging part of a list answer. */
export function pagedFields(p: Paged<unknown>): Record<string, unknown> {
  return {
    pageSize: p.pageSize,
    pageIdx: p.pageIdx,
    totalPages: p.totalPages,
    nextPageIdx: p.nextPageIdx,
    ...(p.invalidPage ? { invalidPage: true } : {}),
    pagination: p.pagination,
  };
}

function wsList(dir: string, frames: WsFrameEntry[], recording: boolean, session: string, q: ListQuery, shownUrl: (u: string) => { url: string; urlTruncated?: true }): unknown {
  const all = frames
    .filter((f) => q.filter === null || f.url.includes(q.filter))
    .filter((f) => q.tab === null || f.tab === q.tab)
    .map((f) => ({ id: f.id, ws: f.ws, tab: f.tab, url: f.url, phase: f.phase, direction: f.direction, opcode: f.opcode, bytes: f.size, ts: f.ts, ...(f.reason === null ? {} : { reason: f.reason }) }));
  const page = pageOf(all, q.paging);
  return {
    session,
    bundle: dir,
    recording,
    total: frames.length,
    matched: all.length,
    shown: page.rows.length,
    ...pagedFields(page),
    frames: page.rows.map(({ url, ...rest }) => ({ ...rest, ...shownUrl(url) })),
    ...(page.nextPageIdx !== null ? { note: `more: --page-idx ${page.nextPageIdx}` } : {}),
  };
}

/**
 * 0.9-C `net list --kind sse` (docs/04 §47): the `sse` events written so far
 * (streams that ended or were cut short), oldest first; `--filter` is a
 * substring of the request URL, `--tab` and paging as for requests.
 */
function sseList(dir: string, sse: SseEntry[], recording: boolean, session: string, q: ListQuery): unknown {
  const all = sse
    .filter((m) => q.filter === null || m.url.includes(q.filter))
    .filter((m) => q.tab === null || m.tab === q.tab)
    .map((m) => ({ id: m.id, request: m.request, index: m.index, event: m.event, lastEventId: m.lastEventId, bytes: m.size, ts: m.ts }));
  const page = pageOf(all, q.paging);
  return {
    session,
    bundle: dir,
    recording,
    total: sse.length,
    matched: all.length,
    shown: page.rows.length,
    ...pagedFields(page),
    messages: page.rows,
    ...(page.nextPageIdx !== null ? { note: `more: --page-idx ${page.nextPageIdx}` } : {}),
  };
}

/** 0.9-C `net body r-12:34` of an SSE message: its data as a file (inline data is materialised under exports/sse/). */
function sseBody(dir: string, m: SseEntry, out: string | null, search: SearchCtx | null, exp: FileCtx | null): unknown {
  const path = m.blob !== null ? new BlobStore(dir).pathOf(m.blob) : materialize(dir, "sse", `${m.id}.txt`, m.inline ?? "");
  if (path === null || !existsSync(path)) throw new TabcapError("not-found", `message ${m.id} has no stored data`, "The bundle is damaged; record again.");
  if (exp !== null) return exp.write({ id: m.id, url: m.url, bytes: readFileSync(path), mime: "text/plain", resourceType: null, charset: () => null });
  return bodyResult({ id: m.id, url: m.url, path, blob: m.blob, mime: "text/plain", out, extra: { sse: m.request, index: m.index, event: m.event, lastEventId: m.lastEventId } }, search);
}

/** `net body r-12:34`: a frame payload as a file (inline payloads are materialised under exports/ws/). */
function frameBody(dir: string, frames: WsFrameEntry[], id: string, out: string | null, search: SearchCtx | null, exp: FileCtx | null = null): unknown {
  const f = frames.find((x) => x.id === id);
  if (f === undefined) throw new TabcapError("not-found", `no WebSocket frame ${id} in ${dir}`, "Run `tabcap net list --kind ws` for frame ids.");
  if (f.phase !== "frame") throw new TabcapError("not-found", `${id} is a ${f.phase} event, not a frame (reason: ${f.reason ?? "none"})`, "Pick a frame id from `tabcap net list --kind ws`.");
  let path: string | null = null;
  if (f.blob !== null) path = new BlobStore(dir).pathOf(f.blob);
  else if (f.inline !== null) path = materialize(dir, "ws", `${id}.bin`, inlineBytes(f.opcode ?? 1, f.inline));
  if (path === null || !existsSync(path)) throw new TabcapError("not-found", `frame ${id} has no stored payload (${f.reason ?? "missing"})`, "The payload was too large to store; see the ws event in the bundle.");
  if (exp !== null) return exp.write({ id, url: f.url, bytes: readFileSync(path), mime: f.opcode === 1 ? "text/plain" : null, resourceType: null, charset: () => null });
  return bodyResult({ id, url: f.url, path, blob: f.blob, mime: f.opcode === 1 ? "text/plain" : null, out, extra: { ws: f.ws, direction: f.direction, opcode: f.opcode } }, search);
}

/** 0.5-F search flags of `net body`, with what decoding needs. */
type SearchCtx = { s: NonNullable<ReturnType<typeof bodySearchOf>>; scrub: (text: string) => string; charset: () => string | null; resourceType: string | null };

/** 0.5-F2 `--file`: where and how the body file is written. */
type FileCtx = { write: (b: { id: string; url: string; bytes: Uint8Array; mime: string | null; resourceType: string | null; charset: () => string | null }) => unknown };

/** `net body`: the body answer, its `url` with sensitive query parameters redacted unless --reveal (0.6-E). */
export async function netBody(d: Daemon, a: Args, session: string): Promise<unknown> {
  const c = liveCtx(d, a);
  const res = await netBodyOf(d, a, session);
  return c === null ? res : withRedactedUrl(res, c);
}

async function netBodyOf(d: Daemon, a: Args, session: string): Promise<unknown> {
  const idArg = optStr(a, "id");
  const url = optStr(a, "url");
  const toFile = fileFlagOf(a);
  const s = toFile ? null : bodySearchOf(a);
  if ((idArg === null || idArg === "") === (url === null || url === "")) {
    throw new TabcapError("usage", url === null ? "missing id" : "give either an id or --url, not both", "Usage: tabcap net body <id> [--out path], or tabcap net body --url <script url> --at line:col");
  }
  const { dir, index, frames, sse, recording, rec } = current(d, session);
  let id = idArg ?? "";
  let byUrl: Record<string, unknown> = {};
  if (url !== null && url !== "") {
    const hit = requestByUrl(index, url);
    if (hit === null) throw new TabcapError("not-found", `no recorded request for ${url.slice(0, 300)}`, "`tabcap net list --filter <part of the url>` shows what was recorded; scripts loaded before `net start` are not in the bundle.");
    id = hit.entry.id;
    byUrl = { resolvedBy: "url", sameUrl: hit.count };
  }
  const scrub = (text: string) => d.secrets.scrub(text);
  const exp: FileCtx | null = toFile
    ? { write: (b) => exportBody({ ...b, scrub, pretty: optBool(a, "pretty"), where: rec.recording ? { bundle: dir } : { cache: d.paths.cache } }) }
    : null;
  if (id.includes(":")) {
    const search = s === null ? null : { s, scrub, charset: () => null, resourceType: null };
    const m = frames.some((f) => f.id === id) ? undefined : sse.find((x) => x.id === id);
    if (m !== undefined) return sseBody(dir, m, optStr(a, "out"), search, exp);
    return frameBody(dir, frames, id, optStr(a, "out"), search, exp);
  }
  const e = index.find((x) => x.id === id);
  if (e === undefined) throw new TabcapError("not-found", `no request ${id} in ${dir}`, "Run `tabcap net list` for request ids.");
  if (e.blob === null && e.bodySkipped !== undefined) {
    throw new TabcapError(
      "not-found",
      `request ${id} has no stored body: the recording skips ${e.type} bodies (--bodies ${rec.bodies}, ${e.bodySkipped})`,
      e.type === "script" ? "Record again with `tabcap net start --bodies api+script` (or `--bodies all`) to keep script bodies." : "Record again with `tabcap net start --bodies all` to keep it.",
      { id, type: e.type, bodies: rec.bodies, skipped: e.bodySkipped },
    );
  }
  if (e.blob === null) {
    throw new TabcapError("not-found", `request ${id} has no stored body (${e.bodyMissing ?? "none"})`, "Bodies are missing for redirects, 204/304, failures and navigated-away requests; see bodyMissing in the bundle.");
  }
  // 0.6-B: the decoded view is the default when there is one; --raw the original.
  // 0.6-Q: the observe mode's page view counts too (D4 rank, as `analyze find`).
  const wantDecoded = optBool(a, "decoded");
  const wantRaw = optBool(a, "raw");
  if (wantDecoded && wantRaw) throw new TabcapError("usage", "--decoded and --raw exclude each other", "Pick one: the decoded view (the default when there is one) or the original body.");
  const store = new BlobStore(dir);
  const dv = decodedEntry(e, dir, store);
  if (wantDecoded && dv === null) throw noDecodedView(id, store.tryRead(e.blob), recording);
  const useView = dv !== null && !wantRaw;
  const blob = useView && dv !== null ? dv.blob : e.blob;
  const mime = useView && dv !== null ? dv.mime : e.mime;
  const viewExtra = {
    ...(dv === null ? {} : useView ? { view: "decoded", decoded: { by: dv.by, version: dv.version, mime: dv.mime, ...(dv.link === undefined ? {} : { link: dv.link }) } } : { view: "raw" }),
    // 0.9-C: the body is what arrived of a stream that did not end normally (docs/04 §47).
    ...(e.partial === true ? { partial: true } : {}),
  };
  const path = store.pathOf(blob);
  if (path === null || !existsSync(path)) throw new TabcapError("not-found", `blob ${blob} is missing from ${dir}`, "The bundle is damaged; record again.");
  // A decoded view is the plugin's text: decoded as UTF-8, never with the original's charset.
  const cs = () => (useView ? null : charsetOf(dir, e.id));
  if (s !== null) await rec.flushEvents();
  if (exp !== null) {
    await rec.flushEvents();
    const written = exp.write({ id, url: e.url, bytes: readFileSync(path), mime, resourceType: e.type, charset: cs });
    return isRecord(written) ? { ...written, ...viewExtra } : written;
  }
  const search = s === null ? null : { s, scrub, charset: cs, resourceType: e.type };
  return bodyResult({ id, url: e.url, path, blob, mime, out: optStr(a, "out"), extra: { ...byUrl, ...viewExtra } }, search);
}

/**
 * The response's winning ok decoded view (0.6-Q): the inline view of the index
 * (a decode plugin while recording) overlaid with the bundle's decoded.jsonl
 * sidecar — `bundle decode` rows and the observe mode's `by:"page"` rows — by
 * the D4 rank of docs/04 §33 (an ok plugin view over an ok page view, the
 * later line within a rank), read through `decodedPayload` as `analyze find`
 * reads it (a missing or oversized blob is no view). The same while recording
 * and after.
 */
export function decodedEntry(e: Pick<NetEntry, "id" | "decoded">, dir: string, store: BlobStore): { by: string; version: string; mime: string | null; blob: string; link?: "strong" | "weak" } | null {
  const inline = e.decoded === undefined ? {} : { decoded: { ...e.decoded, direction: "response", ok: true } };
  const ev = overlayEvent({ kind: "request", id: e.id, response: inline }, latestViews(readSidecar(dir)));
  const resp = isRecord(ev["response"]) ? ev["response"] : null;
  const d = resp === null ? undefined : parseDecoded(resp["decoded"]);
  const payload = decodedPayload({ readBlob: (ref) => store.tryRead(ref) }, d);
  if (d === undefined || d.blob === null || payload === null) return null;
  return { by: d.by, version: d.version, mime: d.mime, blob: d.blob, ...(payload.link === undefined ? {} : { link: payload.link }) };
}

/** `net body --decoded` without a view (0.6-Q): where views come from, and —
 * when the body is one the observe mode would arm on (its suspect rule: the
 * entropy rule of `find`, a ≥ 64-char base64 / hex leaf or a bare token) — the
 * observe mode first. */
export function noDecodedView(id: string, raw: Uint8Array | null, recording: boolean): TabcapError {
  const encrypted = raw !== null && raw.length > 0 && suspectOf(raw, Buffer.from(raw).toString("utf8")) !== null;
  const plugins = "Decoded views come from enabled decode plugins (`tabcap plugin list`; `tabcap bundle decode <bundle>` adds them to a finished bundle)";
  const observe = recording
    ? "the body looks encrypted: `tabcap trace start --decode` files the plaintext the page itself parses as a page view (reproduce the page action, then `net body` again)"
    : "the body looks encrypted: record again with `tabcap trace start --decode` on, and the plaintext the page itself parses becomes a page view";
  return new TabcapError("not-found", `request ${id} has no decoded view`, encrypted ? `${observe}. ${plugins}.` : `${plugins}.`);
}

function bodyResult(o: { id: string; url: string; path: string; blob: string | null; mime: string | null; out: string | null; extra: Record<string, unknown> }, search: SearchCtx | null = null): unknown {
  const { id, path, out } = o;
  let outPath = path;
  if (out !== null) {
    outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(path, outPath);
  }
  const bytes = readFileSync(path);
  if (search !== null) {
    const decoded = decodeBody(bytes, o.mime, search.charset);
    if (decoded === null) throw new TabcapError("usage", `${id} is binary data (${o.mime ?? "unknown type"}, ${bytes.length} bytes); line search needs a text body`, "Use `tabcap net body <id> --out <file>` and a tool for that format.");
    const base = { id, url: o.url, ...o.extra, path: outPath, blob: o.blob };
    const text = search.scrub(decoded);
    if (search.s.search.mode === "preview") {
      // --pretty alone: the 0.3-F preview (10000 chars), of the pretty text.
      const p = prettify(text, bytes.length, o.mime, search.resourceType);
      const pv = bodyPreview(new TextEncoder().encode(p.text), true);
      return { ...base, bytes: bytes.length, mime: o.mime, pretty: p.pretty, lines: splitLines(p.text).length, textPreview: pv.text, previewTruncated: pv.truncated, ...(p.note === null ? {} : { note: p.note }) };
    }
    return searchBody(base, text, bytes.length, o.mime, search.resourceType, search.s);
  }
  // chrome-devtools-mcp body conventions (formatters.ts): up to 10000 chars of text, <binary data>, <empty response>.
  const p = bodyPreview(bytes, isTextMime(o.mime));
  return { id, url: o.url, ...o.extra, path: outPath, blob: o.blob, bytes: bytes.length, mime: o.mime, textPreview: p.binary ? null : p.text, previewTruncated: p.truncated, ...(p.binary ? { preview: p.text } : {}) };
}

export async function netShow(d: Daemon, a: Args, session: string): Promise<unknown> {
  const id = reqStr(a, "id", "tabcap net show <id>");
  const { dir, frames, sse, recording, rec } = current(d, session);
  if (id.includes(":")) {
    const f = frames.find((x) => x.id === id);
    const m = f === undefined ? sse.find((x) => x.id === id) : undefined;
    if (f === undefined && m === undefined) throw notFound(id, dir);
    const fc = liveCtx(d, a);
    const fd = f !== undefined ? frameDetail(dir, f) : m !== undefined ? sseDetail(dir, m) : {};
    return { session, bundle: dir, recording, ...(fc === null ? fd : withRedactedUrl(fd, fc)) };
  }
  if (!/^r-\d+$/.test(id)) throw new TabcapError("usage", `not a request id: ${id}`, "Ids look like r-12 (request) or r-12:34 (WebSocket frame or SSE message); see `tabcap net list`.");
  await rec.flushEvents();
  const ev = findRequestEvent(dir, id);
  if (ev === null) throw notFound(id, dir);
  const store = new BlobStore(dir);
  // 0.6-E: sensitive headers, cookie values, query / body fields shown as <redacted:name> unless --reveal
  const c = liveCtx(d, a);
  const detailOf = (e: Record<string, unknown>) => requestDetail(e, store, (text) => materialize(dir, "post", `${id}${c === null ? "" : ".redacted"}.txt`, text));
  const detail = c === null ? detailOf(ev) : redactedDetail(ev, c, detailOf);
  const ws = ev["type"] === "websocket" ? { frames: frames.filter((f) => f.ws === id && f.phase === "frame").length, framesHint: "`tabcap net list --kind ws` lists them; `net show <id>:<seq>` shows one" } : {};
  // 0.9-C (docs/04 §47): an event stream request says how many messages it had, as a handshake its frames.
  const resp = isRecord(ev["response"]) ? ev["response"] : null;
  const sseInfo =
    resp !== null && isEventStream(typeof resp["mimeType"] === "string" ? resp["mimeType"] : null)
      ? { sse: { messages: sse.filter((m) => m.request === id).length, hint: "`tabcap net list --kind sse` lists them; `net show <id>:<seq>` shows one" } }
      : {};
  return { session, bundle: dir, recording, ...detail, ...ws, ...sseInfo };
}

/** `tabcap net grep <regex>`: raw-text search over every recorded response body (netsearch.ts). */
export async function netGrepTool(d: Daemon, a: Args, session: string): Promise<unknown> {
  const { dir, index, recording, rec } = current(d, session);
  await rec.flushEvents();
  return netGrep(d, a, session, { dir, index, recording });
}
