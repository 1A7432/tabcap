// tabcap net start | stop | list | body | show — per-session recording into an evidence bundle.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../../bundle/blobs.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { compactStamp, nowMs } from "../../shared/time.ts";
import { isTextMime } from "../capture/cdpnet.ts";
import { Recorder, type NetEntry, type WsFrameEntry } from "../capture/recorder.ts";
import { pageOf, parseListQuery, selectNet, type ListQuery, type Paged } from "./netquery.ts";
import { bodyPreview, listUrl } from "./formatters.ts";
import { findRequestEvent, frameDetail, materialize, notFound, requestDetail } from "./netshow.ts";
import { inlineBytes } from "../capture/ws.ts";
import type { Daemon } from "../state.ts";
import { noteAccountRequest } from "./pool.ts";
import { checkSessionName, optBool, optStr, reqStr, type Args } from "./args.ts";
import { bodySearchOf, charsetOf, decodeBody, netGrep, prettify, requestByUrl, searchBody } from "./netsearch.ts";
import { splitLines } from "./textsearch.ts";
import { exportBody, fileFlagOf } from "./bodyexport.ts";
import { DecodeSession } from "../hooks/decode.ts";
import { parseDecoded } from "../../bundle/decoded.ts";
import { isRecord } from "../../shared/json.ts";
import { decodePlugins } from "../hooks/plugins.ts";
import { redactedDetail, redactUrl, revealOf, withRedactedUrl, type LiveCtx } from "./liveredact.ts";
import { parseBodiesMode, type BodiesMode } from "../../shared/bodies.ts";
import { readRecordBodies } from "../../shared/config.ts";
import { allSiteRules } from "../siterules.ts";

/** 0.6-E: how a net command prints values (docs/04 §8.3); null with --reveal. */
const liveCtx = (d: Daemon, a: Args): LiveCtx | null => (revealOf(a) ? null : { scrub: (s) => d.secrets.scrub(s) });

/** 0.6-I: `--bodies`, else config.json `record.bodies`, else all. */
export function bodiesOf(d: Daemon, a: Args): BodiesMode {
  const flag = optStr(a, "bodies");
  return flag === null ? readRecordBodies(d.paths.configFile) : parseBodiesMode(flag, "flag");
}

export async function netStart(d: Daemon, a: Args, session: string): Promise<unknown> {
  checkSessionName(session);
  const bodies = bodiesOf(d, a);
  // 0.6-I: a bad site stop rule in config.json is refused here, not silently skipped later.
  allSiteRules(d.paths.configFile);
  const { t, tabs, info, console } = d.need();
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
  const dir = join(d.paths.bundles, `${session}-${compactStamp(nowMs())}`);
  if (existsSync(dir)) throw new TabcapError("conflict", `bundle ${dir} already exists`, "Wait a second and run `tabcap net start` again.");
  const bound = d.sites.get(session) ?? null;
  // 0.6-B: the enabled decode plugins, as installed when the recording starts.
  let rec: Recorder | null = null;
  const decode = new DecodeSession(d.decodeHost, decodePlugins(d.paths.config), {
    scrub: (s) => d.secrets.scrub(s),
    onDisabled: (name, reason) => void rec?.note(`decode plugin ${name} disabled for this session: ${reason}`, { plugin: name }),
  });
  const r = await Recorder.start({
    session,
    dir,
    t,
    tabs,
    browser: { version: info.version, userAgent: info.userAgent },
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
      "Fetch interception (Response stage) on XHR / Fetch / Document: responses pause ~2 ms while bodies are copied; while a same-origin `tabcap fetch` runs, its tab's fetch() requests also pause at the Request stage (the x-tabcap-fetch marker is removed, nothing else changes)",
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

type Rec = { dir: string; index: NetEntry[]; frames: WsFrameEntry[]; recording: boolean; rec: Recorder };

export function current(d: Daemon, session: string): Rec {
  const r = d.recorders.get(session);
  if (r !== undefined) return { dir: r.dir, index: r.index, frames: r.frames, recording: true, rec: r };
  const last = d.lastBundles.get(session);
  if (last !== undefined) return { dir: last.dir, index: last.index, frames: last.frames, recording: false, rec: last };
  throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start`, reproduce the page action, then `tabcap net list`.");
}

export function netList(d: Daemon, a: Args, session: string): unknown {
  const { dir, index, frames, recording, rec } = current(d, session);
  const kind = optStr(a, "kind") ?? "http";
  if (kind !== "http" && kind !== "ws") throw new TabcapError("usage", `--kind ${kind}?`, "Use `--kind http` (requests, the default) or `--kind ws` (WebSocket frames).");
  const q = parseListQuery(a, (id) => rec.cmdStarts.get(id) ?? null);
  const c = liveCtx(d, a);
  const shownUrl = (u: string) => listUrl(c === null ? u : redactUrl(u, c));
  if (kind === "ws") return wsList(dir, frames, recording, session, q, shownUrl);
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
    requests: r.rows.map(({ blob: _b, at: _at, url, ...rest }) => ({ ...rest, ...shownUrl(url) })),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
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
    .map((f) => ({ id: f.id, ws: f.ws, tab: f.tab, url: f.url, phase: f.phase, direction: f.direction, opcode: f.opcode, size: f.size, ts: f.ts, ...(f.reason === null ? {} : { reason: f.reason }) }));
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
  const { dir, index, frames, recording, rec } = current(d, session);
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
  if (id.includes(":")) return frameBody(dir, frames, id, optStr(a, "out"), s === null ? null : { s, scrub, charset: () => null, resourceType: null }, exp);
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
  // 0.6-B: the decode plugin's view is the default when there is one; --raw the original.
  const wantDecoded = optBool(a, "decoded");
  const wantRaw = optBool(a, "raw");
  if (wantDecoded && wantRaw) throw new TabcapError("usage", "--decoded and --raw exclude each other", "Pick one: the decode plugin's view (the default when there is one) or the original body.");
  const dv = decodedEntry(e, dir, recording);
  if (wantDecoded && dv === null) throw new TabcapError("not-found", `request ${id} has no decoded view`, "Decoded views come from enabled decode plugins (`tabcap plugin list`); `tabcap bundle decode <bundle>` adds them to a finished bundle.");
  const useView = dv !== null && !wantRaw;
  const blob = useView && dv !== null ? dv.blob : e.blob;
  const mime = useView && dv !== null ? dv.mime : e.mime;
  const viewExtra = dv === null ? {} : useView ? { view: "decoded", decoded: { by: dv.by, version: dv.version, mime: dv.mime } } : { view: "raw" };
  const store = new BlobStore(dir);
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

/** The response's ok decoded view: from the index while recording, else from the event on disk (bundle decode may have added one). */
function decodedEntry(e: NetEntry, dir: string, recording: boolean): { by: string; version: string; mime: string | null; blob: string } | null {
  if (e.decoded !== undefined) return e.decoded;
  if (recording) return null;
  const ev = findRequestEvent(dir, e.id);
  const resp = ev !== null && isRecord(ev["response"]) ? ev["response"] : null;
  const d = resp === null ? undefined : parseDecoded(resp["decoded"]);
  return d === undefined || !d.ok || d.blob === null ? null : { by: d.by, version: d.version, mime: d.mime, blob: d.blob };
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
      return { ...base, size: bytes.length, mime: o.mime, pretty: p.pretty, lines: splitLines(p.text).length, textPreview: pv.text, previewTruncated: pv.truncated, ...(p.note === null ? {} : { note: p.note }) };
    }
    return searchBody(base, text, bytes.length, o.mime, search.resourceType, search.s);
  }
  // chrome-devtools-mcp body conventions (formatters.ts): up to 10000 chars of text, <binary data>, <empty response>.
  const p = bodyPreview(bytes, isTextMime(o.mime));
  return { id, url: o.url, ...o.extra, path: outPath, blob: o.blob, size: bytes.length, mime: o.mime, textPreview: p.binary ? null : p.text, previewTruncated: p.truncated, ...(p.binary ? { preview: p.text } : {}) };
}

export async function netShow(d: Daemon, a: Args, session: string): Promise<unknown> {
  const id = reqStr(a, "id", "tabcap net show <id>");
  const { dir, frames, recording, rec } = current(d, session);
  if (id.includes(":")) {
    const f = frames.find((x) => x.id === id);
    if (f === undefined) throw notFound(id, dir);
    const fc = liveCtx(d, a);
    const fd = frameDetail(dir, f);
    return { session, bundle: dir, recording, ...(fc === null ? fd : withRedactedUrl(fd, fc)) };
  }
  if (!/^r-\d+$/.test(id)) throw new TabcapError("usage", `not a request id: ${id}`, "Ids look like r-12 (request) or r-12:34 (WebSocket frame); see `tabcap net list`.");
  await rec.flushEvents();
  const ev = findRequestEvent(dir, id);
  if (ev === null) throw notFound(id, dir);
  const store = new BlobStore(dir);
  // 0.6-E: sensitive headers, cookie values, query / body fields shown as <redacted:name> unless --reveal
  const c = liveCtx(d, a);
  const detailOf = (e: Record<string, unknown>) => requestDetail(e, store, (text) => materialize(dir, "post", `${id}${c === null ? "" : ".redacted"}.txt`, text));
  const detail = c === null ? detailOf(ev) : redactedDetail(ev, c, detailOf);
  const ws = ev["type"] === "websocket" ? { frames: frames.filter((f) => f.ws === id && f.phase === "frame").length, framesHint: "`tabcap net list --kind ws` lists them; `net show <id>:<seq>` shows one" } : {};
  return { session, bundle: dir, recording, ...detail, ...ws };
}

/** `tabcap net grep <regex>`: raw-text search over every recorded response body (netsearch.ts). */
export async function netGrepTool(d: Daemon, a: Args, session: string): Promise<unknown> {
  const { dir, index, recording, rec } = current(d, session);
  await rec.flushEvents();
  return netGrep(d, a, session, { dir, index, recording });
}
