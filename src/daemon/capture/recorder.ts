// Per-session network recorder → evidence bundle (docs/04 §3–§5).
// Body rules (§5.2): Network.enable with large buffers; on loadingFinished fetch
// the body immediately; Fetch interception (Response stage) for XHR / Fetch /
// Document rescues bodies of requests cut by a navigation (spike 2); a root
// navigation commit closes the old document's unfinished requests as
// `incomplete` / `navigated` (§5.4); session stop closes the rest as `stopped`.
// Cookie snapshots (§4.1 `state`, P1): every session tab at recording start, at
// each root-frame `navigation` commit, and at stop (cookies.ts).
// A response the page never reads gets no loadingFinished from Chrome; when
// Fetch already holds its full body 1 s after responseReceived it is written
// as `finished` with `end: null`, `bodySource: "fetch"`, `unreadByPage: true`
// (docs/04 §5.2 rule 9, owner decision 10-15), so `net list` / `net wait` /
// the guard see it during the recording; the rest still closes at stop.
// The recorder is active instrumentation (Fetch pauses responses ~2 ms), so
// `net start` says so in its output (AGENTS.md: 默认最少打扰).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { BundleWriter } from "../../bundle/writer.ts";
import { TOOL_VERSION } from "../../bundle/manifest.ts";
import type { Actor, BodyMissingReason, Headers, InlineOrBlob, ManifestTab, NavType, ResourceType, UnsequencedEvent } from "../../bundle/types.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { monotonicToMono, nowMs, wallTimeToTs } from "../../shared/time.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import type { AttachedTarget, CdpEvent, Transport } from "../transport/types.ts";
import type { ConsoleEntry, ConsoleLog } from "./console.ts";
import {
  bodyBytes,
  bodyErrorReason,
  charsetOf,
  headerValue,
  mergeHeaders,
  noBodyReason,
  normalizeHeaders,
  requestTiming,
  resourceType,
} from "./cdpnet.ts";
import { framePayload, WsBook, type WsConn } from "./ws.ts";
import { cookieArray, cookieStateFields, navWantsCookies, stateOrigin, type StateReason } from "./cookies.ts";

const NETWORK_ENABLE = { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024, maxPostDataSize: 1024 * 1024 };
const FETCH_ENABLE = {
  patterns: [
    { resourceType: "XHR", requestStage: "Response" },
    { resourceType: "Fetch", requestStage: "Response" },
    { resourceType: "Document", requestStage: "Response" },
  ],
};
const INLINE_POST_MAX = 64 * 1024;
const NAV_GRACE_MS = 500;
/** docs/04 §5.2 rule 9: how long after responseReceived a body the page never reads is written from Fetch. */
export const UNREAD_AFTER_MS = 1000;
/**
 * A main-frame document response is held at most this long while XHR / fetch
 * requests of the old document still wait for their bodies: once the new
 * document commits, Chrome cancels them and their bodies are gone (measured
 * 10-15 on a link whose click handler fires a fetch, 4 of 6 lost without it).
 */
const DOC_HOLD_MS = 50;

export type NetEntry = {
  id: string;
  tab: string;
  type: ResourceType;
  method: string;
  url: string;
  status: number | null;
  mime: string | null;
  size: number | null;
  outcome: "finished" | "failed" | "incomplete";
  blob: string | null;
  bodyMissing: string | null;
  /** The command window the event was written in (`c-<seq>`), or null. */
  cmd: string | null;
  /** Written from the Fetch body because the page never read it (docs/04 §5.2 rule 9). */
  unreadByPage?: boolean;
  /** Daemon clock when the event was written. */
  at: number;
};

/** One `ws` event of the recording, for `net list --kind ws` / `net body <frame>`. */
export type WsFrameEntry = {
  /** `<handshake id>:<event seq>`, e.g. `r-12:34`. */
  id: string;
  ws: string;
  seq: number;
  tab: string;
  url: string;
  phase: "frame" | "close" | "error";
  direction: "send" | "recv" | null;
  opcode: 1 | 2 | null;
  size: number | null;
  ts: number;
  blob: string | null;
  /** Inline payload as stored in the event (text, or base64 for opcode 2). */
  inline: string | null;
  reason: string | null;
};

type Pending = {
  key: string;
  sessionId: string;
  tab: Tab;
  requestId: string;
  loaderId: string | null;
  frameId: string | null;
  type: ResourceType;
  method: string;
  url: string;
  urlFragment: string | null;
  initiator: Record<string, unknown> | null;
  headers: Headers;
  postData: string | null;
  hasPostData: boolean;
  startMono: number | null;
  wallTs: number | null;
  startedLocal: number;
  nav: string | null;
  redirectFrom: string | null;
  response: Record<string, unknown> | null;
  responseMono: number | null;
};

/** Body (and response line) captured at the Fetch Response stage. */
type FetchedBody = { bytes: Uint8Array; response: Record<string, unknown> };

export type RecorderOptions = {
  session: string;
  dir: string;
  t: Transport;
  tabs: Tabs;
  browser: { version: string; userAgent: string };
  /** Console collector; its entries for this session's tabs become `console` events. */
  console?: ConsoleLog | null;
  /** Known-secret replacement for page-provided text (console). */
  scrub?: (s: string) => string;
  /** Store site and account bound to the session (`session start --site`), for the manifest. */
  site?: { site: string; account: string | null } | null;
  /** Called once when the bundle is finished (store bundle index). */
  onFinished?: (dir: string) => void;
  /** docs/04 §5.2 rule 9 delay (tests shorten it); default UNREAD_AFTER_MS. */
  unreadAfterMs?: number;
};

export class Recorder {
  readonly dir: string;
  readonly session: string;
  /** Daemon clock when the recording started. */
  readonly startedAt = Date.now();
  /** Daemon clock at each command's start event, by `c-<seq>` (net list / net wait --since). */
  readonly cmdStarts = new Map<string, number>();
  readonly index: NetEntry[] = [];
  readonly frames: WsFrameEntry[] = [];
  private ws = new WsBook();
  /** Keeps `ws` events in CDP order even when a large payload goes to a blob first. */
  private wsChain: Promise<void> = Promise.resolve();
  private writer: BundleWriter;
  private raw: WriteStream;
  private sessions = new Map<string, Tab>(); // CDP sessionId -> host tab
  private bundleTab = new Map<string, string>(); // daemon tab id -> bundle tab id
  private navOf = new Map<string, string>(); // daemon tab id -> bundle nav id
  private urlOf = new Map<string, string>();
  private lastCommit = new Map<string, number>(); // daemon tab id -> performance.now()
  private pending = new Map<string, Pending>();
  private extraReq = new Map<string, Headers>();
  private extraResp = new Map<string, Headers>();
  private fetched = new Map<string, FetchedBody>();
  private unreadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Set<Promise<void>>();
  private offs: Array<() => void> = [];
  private stopping = false;
  private readonly t: Transport;
  private readonly opts: RecorderOptions;

  private constructor(writer: BundleWriter, raw: WriteStream, o: RecorderOptions) {
    this.writer = writer;
    this.raw = raw;
    this.dir = o.dir;
    this.session = o.session;
    this.t = o.t;
    this.opts = o;
  }

  static async start(o: RecorderOptions): Promise<Recorder> {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(o.dir, "raw"), { recursive: true, mode: 0o700 });
    const writer = await BundleWriter.open(o.dir, {
      init: {
        producer: {
          tool: "tabcap",
          version: TOOL_VERSION,
          daemon: TOOL_VERSION,
          extension: null,
          browser: { name: "Chrome for Testing", version: o.browser.version.replace(/^[^/]*\//, ""), userAgent: o.browser.userAgent },
          platform: `${process.platform}-${process.arch}`,
        },
        session: { name: o.session, site: o.site?.site ?? null, account: o.site?.account ?? null },
        mode: { capture: "mixed", trace: false, raw: true, humanRecorder: false },
      },
    });
    const raw = createWriteStream(join(o.dir, "raw", "cdp.jsonl"), { flags: "a", mode: 0o600 });
    const r = new Recorder(writer, raw, o);
    r.writer.append({ ts: nowMs(), mono: null, kind: "session", actor: "system", tab: null, cmd: null, phase: "start", name: o.session, mode: { capture: "mixed", trace: false, raw: true } });
    r.offs.push(
      o.t.onEvent((e) => r.onEvent(e)),
      o.t.onAttach((x) => r.onChildAttach(x)),
      o.t.onDetach((x) => r.onDetach(x)),
      o.tabs.onTabAdded((tab) => (tab.session === o.session ? r.addTab(tab, "open") : Promise.resolve())),
      o.tabs.onNav((tab, e) => r.onNav(tab, e)),
    );
    if (o.console !== undefined && o.console !== null) r.offs.push(o.console.onEntry((tabId, en) => r.onConsole(tabId, en)));
    for (const tab of o.tabs.sessionTabs(o.session)) {
      await r.addTab(tab, "attach");
      // Children (OOPIFs, workers) that attached before recording started.
      for (const child of o.t.targets()) if (child.parentSessionId === tab.sessionId) await r.enableOn(child);
    }
    for (const tab of o.tabs.sessionTabs(o.session)) await r.cookieState(tab, "session-start");
    return r;
  }

  /** `state` snapshots written so far (docs/04 §4.1), for `daemon status`. */
  stateCount = 0;

  /**
   * One `state` cookies event for a tab (docs/04 §4.1): Network.getCookies on
   * the tab's session as CDP returns it, stored as a blob. A tab that is gone,
   * or a CDP error, writes nothing (logged): a snapshot is evidence, never a
   * reason to fail the recording.
   */
  private async cookieState(tab: Tab, reason: StateReason): Promise<void> {
    const bt = this.bundleTab.get(tab.id);
    if (bt === undefined || tab.closed || this.writerClosed) return;
    const url = tab.url;
    let cookies: Record<string, unknown>[];
    try {
      cookies = cookieArray(await this.t.send("Network.getCookies", {}, tab.sessionId, 5000));
    } catch (e) {
      log.warn("recorder: cookie snapshot failed", { tab: tab.id, reason, error: String(e) });
      return;
    }
    const put = await this.writer.putBlob(JSON.stringify(cookies));
    if (put.outcome !== "stored" || this.writerClosed) return;
    this.writer.append({ ts: nowMs(), mono: null, kind: "state", actor: "system", tab: bt, cmd: this.cmdRef(), ...cookieStateFields(stateOrigin(url), put.ref, cookies.length, reason) });
    this.stateCount++;
  }

  /**
   * docs/04 §16: in `direct` mode the human only steps in at a handoff, so every
   * event is the AI's unless a handoff is in its human-active state (there is no
   * handoff yet). The old "outside a command window = human" rule mislabelled
   * the requests a navigate leaves running. The `cmd` field still says which
   * command window an event fell into.
   */
  private actor(): Actor {
    return "ai";
  }

  private async enableOn(x: { sessionId: string; type: string }): Promise<void> {
    const sid = x.sessionId;
    const host = this.sessions.get(sid) ?? this.opts.tabs.bySession(sid);
    if (host === undefined) return;
    this.sessions.set(sid, host);
    await this.t.send("Network.enable", NETWORK_ENABLE, sid, 10_000);
    if (x.type === "page" || x.type === "iframe") await this.t.send("Fetch.enable", FETCH_ENABLE, sid, 10_000);
  }

  private async addTab(tab: Tab, phase: "open" | "attach"): Promise<void> {
    if (this.stopping || this.bundleTab.has(tab.id)) return;
    const bt = `t${this.bundleTab.size + 1}`;
    this.bundleTab.set(tab.id, bt);
    this.sessions.set(tab.sessionId, tab);
    this.writer.append({
      ts: nowMs(),
      mono: null,
      kind: "tab",
      actor: "system",
      tab: bt,
      cmd: this.cmdRef(),
      phase,
      chromeTabId: null,
      targetId: tab.targetId,
      owned: tab.owned,
      url: tab.url,
      title: tab.title,
      reason: tab.reason,
    });
    const entry: ManifestTab = { tab: bt, chromeTabId: null, owned: tab.owned, firstUrl: tab.url };
    this.writer.updateManifest((m) => m.session.tabs.push(entry));
    if (tab.url !== "" && tab.url !== "about:blank") this.writeNav(tab, tab.url, "navigation", null, true);
    await this.t.send("Network.enable", NETWORK_ENABLE, tab.sessionId, 10_000);
    await this.t.send("Fetch.enable", FETCH_ENABLE, tab.sessionId, 10_000);
  }

  private async onChildAttach(x: AttachedTarget): Promise<void> {
    if (this.stopping || x.parentSessionId === null) return;
    const host = this.sessions.get(x.parentSessionId);
    if (host === undefined) return;
    this.sessions.set(x.sessionId, host);
    const type = x.type === "iframe" || x.type === "service_worker" || x.type === "worker" ? x.type : "worker";
    this.writer.append({
      ts: nowMs(),
      mono: null,
      kind: "tab",
      actor: "system",
      tab: this.bundleTab.get(host.id) ?? null,
      cmd: this.cmdRef(),
      phase: "attach",
      target: { id: x.targetId, type, url: x.url, sessionId: x.sessionId },
    });
    await this.enableOn(x);
  }

  private onDetach(x: AttachedTarget): void {
    const host = this.sessions.get(x.sessionId);
    if (host === undefined || this.stopping) return;
    this.flush((p) => p.sessionId === x.sessionId, "detached");
    this.sessions.delete(x.sessionId);
    if (x.sessionId === host.sessionId) {
      this.writer.append({ ts: nowMs(), mono: null, kind: "tab", actor: "system", tab: this.bundleTab.get(host.id) ?? null, cmd: this.cmdRef(), phase: "close", reason: "closed", url: host.url });
    }
  }

  private writeNav(tab: Tab, url: string, type: NavType, loaderId: string | null, initial = false): void {
    const bt = this.bundleTab.get(tab.id) ?? null;
    const from = this.urlOf.get(tab.id) ?? null;
    const ev = this.writer.append((seq) => ({
      ts: nowMs(),
      mono: null,
      kind: "nav",
      actor: this.actor(),
      tab: bt,
      cmd: this.cmdRef(),
      frame: "root",
      nav: `n-${seq}`,
      url,
      from,
      type,
      loaderId,
      loadEvent: null,
      ...(initial ? { initial: true } : {}),
    }));
    this.navOf.set(tab.id, typeof ev["nav"] === "string" ? ev["nav"] : `n-${ev.seq}`);
    this.urlOf.set(tab.id, url);
  }

  private onNav(tab: Tab, e: CdpEvent): void {
    if (this.stopping || !this.bundleTab.has(tab.id)) return;
    if (e.method === "Page.frameNavigated") {
      const f = isRecord(e.params["frame"]) ? e.params["frame"] : {};
      const loaderId = str(f, "loaderId");
      this.lastCommit.set(tab.id, performance.now());
      // Requests of the old document will get no further events (spike 2).
      this.flush((p) => p.sessionId === tab.sessionId && p.loaderId !== loaderId, "navigated", NAV_GRACE_MS);
      const type = tab.navType ?? "navigation";
      this.writeNav(tab, str(f, "url") ?? tab.url, type, loaderId);
      // The new document's own request started before the commit; it belongs to the new epoch.
      const nav = this.navOf.get(tab.id) ?? null;
      for (const q of this.pending.values()) if (q.sessionId === tab.sessionId && loaderId !== null && q.loaderId === loaderId) q.nav = nav;
      // Set-Cookie of the new document is stored by the time it commits.
      if (navWantsCookies(type, false)) this.track(this.cookieState(tab, "nav"));
    } else {
      this.writeNav(tab, str(e.params, "url") ?? tab.url, "history", null);
    }
  }

  private raw_(e: CdpEvent): void {
    if (!/^(Network|Fetch)\.|^Page\.(frameNavigated|navigatedWithinDocument)$/.test(e.method)) return;
    this.raw.write(JSON.stringify({ t: nowMs(), sessionId: e.sessionId, method: e.method, params: e.params }) + "\n");
  }

  private onEvent(e: CdpEvent): void {
    if (this.stopping || e.sessionId === null) return;
    const tab = this.sessions.get(e.sessionId);
    if (tab === undefined) return;
    this.raw_(e);
    const p = e.params;
    const rid = str(p, "requestId");
    const key = rid === null ? "" : `${e.sessionId}|${rid}`;
    switch (e.method) {
      case "Network.requestWillBeSent":
        if (rid !== null) this.onRequest(e.sessionId, tab, rid, p);
        return;
      case "Network.requestWillBeSentExtraInfo":
        if (rid !== null) this.extraReq.set(key, normalizeHeaders(p["headers"]));
        return;
      case "Network.responseReceivedExtraInfo":
        if (rid !== null) this.extraResp.set(key, normalizeHeaders(p["headers"]));
        return;
      case "Network.responseReceived": {
        const q = this.pending.get(key);
        if (q === undefined) return;
        q.response = isRecord(p["response"]) ? p["response"] : null;
        q.responseMono = msOf(num(p, "timestamp"));
        q.type = resourceType(p["type"]);
        this.armUnread(key, q);
        return;
      }
      case "Network.loadingFinished": {
        const q = this.pending.get(key);
        if (q === undefined) return;
        this.pending.delete(key);
        this.disarmUnread(key);
        this.track(this.finishOk(q, msOf(num(p, "timestamp"))));
        return;
      }
      case "Network.loadingFailed": {
        const q = this.pending.get(key);
        if (q === undefined) return;
        this.pending.delete(key);
        this.disarmUnread(key);
        const error = {
          text: str(p, "errorText") ?? "failed",
          canceled: p["canceled"] === true,
          blockedReason: str(p, "blockedReason"),
        };
        this.track(this.write(q, { outcome: "failed", endMono: msOf(num(p, "timestamp")), body: null, missing: { reason: "failed", detail: error.text }, error }));
        return;
      }
      case "Fetch.requestPaused":
        this.track(this.onPaused(e.sessionId, p));
        return;
      case "Network.webSocketCreated":
        if (rid !== null) this.wsConn(key, rid, tab, p);
        return;
      case "Network.webSocketWillSendHandshakeRequest": {
        if (rid === null) return;
        this.wsConn(key, rid, tab, p);
        const wall = num(p, "wallTime");
        this.ws.willSend(key, rid, p, msOf(num(p, "timestamp")), wall === null ? null : wallTimeToTs(wall));
        return;
      }
      case "Network.webSocketHandshakeResponseReceived":
        if (rid === null) return;
        this.wsConn(key, rid, tab, p);
        this.writeHandshake(this.ws.handshakeResponse(key, rid, p, msOf(num(p, "timestamp"))), e.sessionId, tab, "finished", null);
        return;
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived":
        if (rid !== null) this.wsFrame(key, rid, e.sessionId, tab, e.method === "Network.webSocketFrameSent" ? "send" : "recv", p);
        return;
      case "Network.webSocketFrameError":
        if (rid !== null) this.wsEnd(key, e.sessionId, tab, "error", str(p, "errorMessage") ?? "websocket error", msOf(num(p, "timestamp")));
        return;
      case "Network.webSocketClosed":
        if (rid !== null) this.wsEnd(key, e.sessionId, tab, "close", null, msOf(num(p, "timestamp")));
        return;
    }
  }

  private wsConn(key: string, rid: string, tab: Tab, p: Record<string, unknown>): WsConn {
    const conn = this.ws.created(key, rid, p);
    if (conn.nav === null) conn.nav = this.navOf.get(tab.id) ?? null;
    return conn;
  }

  /** The handshake as a `request` event (type websocket); written once, before the first frame. */
  private writeHandshake(
    c: WsConn,
    sid: string,
    tab: Tab,
    outcome: "finished" | "failed" | "incomplete",
    error: { text: string; canceled: boolean; blockedReason: string | null } | null,
    missingReason: BodyMissingReason | null = null,
  ): string {
    if (c.handshake !== null) return c.handshake;
    const q: Pending = {
      key: c.key,
      sessionId: sid,
      tab,
      requestId: c.requestId,
      loaderId: null,
      frameId: null,
      type: "websocket",
      method: "GET",
      url: c.url,
      urlFragment: null,
      initiator: c.initiator,
      headers: c.reqHeaders,
      postData: null,
      hasPostData: false,
      startMono: c.startMono,
      wallTs: c.wallTs,
      startedLocal: performance.now(),
      nav: c.nav,
      redirectFrom: null,
      response: c.response,
      responseMono: c.responseMono,
    };
    const missing: { reason: BodyMissingReason; detail: string | null } =
      missingReason !== null
        ? { reason: missingReason, detail: null }
        : c.response === null
          ? { reason: "failed", detail: error?.text ?? "no handshake response" }
          : { reason: "unsupported", detail: "websocket handshake has no body" };
    const ev = this.buildEvent(q, {
      outcome,
      endMono: c.responseMono,
      body: null,
      missing,
      error,
      extraReq: this.extraReq.get(c.key) ?? null,
      extraResp: this.extraResp.get(c.key) ?? null,
    });
    this.extraReq.delete(c.key);
    this.extraResp.delete(c.key);
    c.handshake = this.appendRequest(q, ev, missing.reason);
    return c.handshake;
  }

  private wsFrame(key: string, rid: string, sid: string, tab: Tab, direction: "send" | "recv", p: Record<string, unknown>): void {
    // A socket opened before recording started: its frames still get a (response-less) handshake.
    const conn = this.ws.get(key) ?? this.wsConn(key, rid, tab, {});
    const ws = this.writeHandshake(conn, sid, tab, conn.response === null ? "incomplete" : "finished", null, conn.response === null ? "unsupported" : null);
    this.ws.frame(key, direction);
    const payload = framePayload(p["response"]);
    if (payload === null) return; // control frame or malformed: raw/cdp.jsonl keeps it
    const mono = msOf(num(p, "timestamp"));
    const ts = WsBook.tsOf(conn, mono) ?? nowMs();
    this.appendWs(tab, ws, conn.url, { ts, mono, phase: "frame", direction, opcode: payload.opcode, bytes: payload.bytes, inline: payload.inline, reason: null });
  }

  private wsEnd(key: string, sid: string, tab: Tab, phase: "close" | "error", reason: string | null, mono: number | null): void {
    const conn = phase === "close" ? this.ws.close(key) : this.ws.get(key);
    if (conn === undefined) return;
    const ws = this.writeHandshake(conn, sid, tab, "failed", { text: reason ?? "closed before the handshake completed", canceled: false, blockedReason: null });
    const ts = WsBook.tsOf(conn, mono) ?? nowMs();
    this.appendWs(tab, ws, conn.url, { ts, mono, phase, direction: null, opcode: null, bytes: null, inline: null, reason });
  }

  private appendWs(
    tab: Tab,
    ws: string,
    url: string,
    f: { ts: number; mono: number | null; phase: "frame" | "close" | "error"; direction: "send" | "recv" | null; opcode: 1 | 2 | null; bytes: Uint8Array | null; inline: string | null; reason: string | null },
  ): void {
    const actor = this.actor();
    const cmd = this.cmdRef();
    const bt = this.bundleTab.get(tab.id) ?? null;
    this.wsChain = this.wsChain
      .then(async () => {
        let payload: InlineOrBlob | null = null;
        let reason = f.reason;
        if (f.inline !== null) payload = { inline: f.inline };
        else if (f.bytes !== null) {
          const put = await this.writer.putBlob(f.bytes);
          if (put.outcome === "stored") payload = { blob: put.ref, size: put.size };
          else reason = `payload too large: ${put.size} bytes > ${put.cap}`;
        }
        if (this.writerClosed) return;
        const stored = this.writer.append({
          ts: f.ts,
          mono: f.mono,
          kind: "ws",
          actor,
          tab: bt,
          cmd,
          ws,
          phase: f.phase,
          ...(f.phase === "frame" ? { direction: f.direction, opcode: f.opcode, payload } : {}),
          reason,
        });
        this.frames.push({
          id: `${ws}:${stored.seq}`,
          ws,
          seq: stored.seq,
          tab: tab.id,
          url,
          phase: f.phase,
          direction: f.direction,
          opcode: f.opcode,
          size: f.bytes === null ? null : f.bytes.length,
          ts: f.ts,
          blob: payload !== null && "blob" in payload ? payload.blob : null,
          inline: payload !== null && "inline" in payload ? payload.inline : null,
          reason,
        });
      })
      .catch((e: unknown) => log.error("recorder: ws write failed", { error: String(e) }));
    this.track(this.wsChain);
  }

  private onRequest(sid: string, tab: Tab, rid: string, p: Record<string, unknown>): void {
    const key = `${sid}|${rid}`;
    const req = isRecord(p["request"]) ? p["request"] : {};
    let redirectFrom: string | null = null;
    const prev = this.pending.get(key);
    if (prev !== undefined && isRecord(p["redirectResponse"])) {
      this.pending.delete(key);
      this.disarmUnread(key);
      prev.response = p["redirectResponse"];
      const reqHeadersExtra = this.extraReq.get(key);
      const respExtra = this.extraResp.get(key);
      this.extraReq.delete(key);
      this.extraResp.delete(key);
      const ev = this.buildEvent(prev, {
        outcome: "finished",
        endMono: msOf(num(p, "timestamp")),
        body: null,
        missing: { reason: "redirect", detail: null },
        error: null,
        extraReq: reqHeadersExtra ?? null,
        extraResp: respExtra ?? null,
      });
      const written = this.appendRequest(prev, ev);
      redirectFrom = written;
    }
    const url = str(req, "url") ?? "";
    const frag = str(req, "urlFragment");
    let postData = str(req, "postData");
    if (postData === null && Array.isArray(req["postDataEntries"])) {
      const parts = req["postDataEntries"].map((x) => (isRecord(x) && typeof x["bytes"] === "string" ? Buffer.from(x["bytes"], "base64") : Buffer.alloc(0)));
      if (parts.length > 0) postData = Buffer.concat(parts).toString("utf8");
    }
    this.pending.set(key, {
      key,
      sessionId: sid,
      tab,
      requestId: rid,
      loaderId: str(p, "loaderId"),
      frameId: str(p, "frameId"),
      type: resourceType(p["type"]),
      method: str(req, "method") ?? "GET",
      url,
      urlFragment: frag,
      initiator: isRecord(p["initiator"]) ? p["initiator"] : null,
      headers: normalizeHeaders(req["headers"]),
      postData,
      hasPostData: req["hasPostData"] === true,
      startMono: msOf(num(p, "timestamp")),
      wallTs: num(p, "wallTime") === null ? null : wallTimeToTs(num(p, "wallTime") ?? 0),
      startedLocal: performance.now(),
      nav: this.navOf.get(tab.id) ?? null,
      redirectFrom,
      response: null,
      responseMono: null,
    });
  }

  /** True while an XHR / fetch of this session (other than `except`) has neither body nor response yet. */
  private oldDocBusy(sid: string, except: string | null): boolean {
    for (const q of this.pending.values()) {
      if (q.sessionId !== sid || q.requestId === except || (q.type !== "xhr" && q.type !== "fetch")) continue;
      if (q.response === null && !this.fetched.has(q.key)) return true;
    }
    return false;
  }

  private async onPaused(sid: string, p: Record<string, unknown>): Promise<void> {
    const interceptionId = str(p, "requestId");
    if (interceptionId === null) return;
    const networkId = str(p, "networkId");
    const tab = this.sessions.get(sid);
    try {
      if (p["resourceType"] === "Document" && tab !== undefined && str(p, "frameId") === tab.targetId) {
        const until = performance.now() + DOC_HOLD_MS;
        while (this.oldDocBusy(sid, networkId) && performance.now() < until) await Bun.sleep(2);
      }
      const status = num(p, "responseStatusCode");
      if (networkId !== null && status !== null && str(p, "responseErrorReason") === null && noBodyReason("GET", status) === null) {
        const r = await this.t.send("Fetch.getResponseBody", { requestId: interceptionId }, sid, 10_000);
        const body = str(r, "body");
        if (body !== null) {
          // Keep Fetch's own response line: Network may never deliver one for a request cut by navigation.
          const headers: Record<string, string> = {};
          for (const h of Array.isArray(p["responseHeaders"]) ? p["responseHeaders"] : []) {
            if (!isRecord(h)) continue;
            const name = str(h, "name");
            const value = str(h, "value");
            if (name === null || value === null) continue;
            const k = name.toLowerCase();
            headers[k] = headers[k] === undefined ? value : `${headers[k]}\n${value}`;
          }
          const ct = headers["content-type"] ?? null;
          const response = { status, statusText: str(p, "responseStatusText") ?? "", headers, mimeType: ct === null ? null : (ct.split(";")[0]?.trim() ?? null), fromFetch: true };
          this.fetched.set(`${sid}|${networkId}`, { bytes: bodyBytes(body, r["base64Encoded"] === true), response });
        }
      }
    } catch (e) {
      log.debug("Fetch.getResponseBody failed", { error: String(e) });
    } finally {
      // The request may have been cancelled meanwhile: "Invalid InterceptionId." is expected (spike 2).
      await this.t.send("Fetch.continueResponse", { requestId: interceptionId }, sid, 10_000).catch((e: unknown) => {
        log.debug("Fetch.continueResponse failed (tolerated)", { error: String(e) });
      });
    }
  }

  private async finishOk(q: Pending, endMono: number | null): Promise<void> {
    const status = q.response === null ? null : num(q.response, "status");
    let body: Uint8Array | null = null;
    let missing: { reason: BodyMissingReason; detail: string | null } | null = null;
    const pre = status === null ? null : noBodyReason(q.method, status);
    const viaFetch = this.fetched.get(q.key);
    this.fetched.delete(q.key);
    if (pre !== null) missing = { reason: pre, detail: null };
    else if (q.type === "websocket") missing = { reason: "unsupported", detail: "websocket handshake has no body" };
    else if (viaFetch !== undefined) body = viaFetch.bytes;
    else {
      try {
        const r = await this.t.send("Network.getResponseBody", { requestId: q.requestId }, q.sessionId, 20_000);
        body = bodyBytes(str(r, "body") ?? "", r["base64Encoded"] === true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const commit = this.lastCommit.get(q.tab.id);
        missing = { reason: bodyErrorReason(msg, commit !== undefined && commit > q.startedLocal, q.tab.closed), detail: msg };
      }
    }
    await this.write(q, { outcome: "finished", endMono, body, missing, error: null });
  }

  private async write(
    q: Pending,
    o: {
      outcome: "finished" | "failed" | "incomplete";
      endMono: number | null;
      body: Uint8Array | null;
      missing: { reason: BodyMissingReason; detail: string | null } | null;
      error: { text: string; canceled: boolean; blockedReason: string | null } | null;
      unreadByPage?: boolean;
    },
  ): Promise<void> {
    let bodyRef: { blob: string; size: number } | null = null;
    let missing = o.missing;
    if (o.body !== null) {
      const put = await this.writer.putBlob(o.body);
      if (put.outcome === "stored") bodyRef = { blob: put.ref, size: put.size };
      else missing = { reason: "too-large", detail: `${put.size} bytes > ${put.cap}` };
    }
    let postData: InlineOrBlob | null = null;
    let postDataMissing: { reason: string; detail: string | null } | null = null;
    let post = q.postData;
    if (post === null && q.hasPostData) {
      try {
        post = str(await this.t.send("Network.getRequestPostData", { requestId: q.requestId }, q.sessionId, 5000), "postData");
      } catch (e) {
        postDataMissing = { reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
    }
    if (post !== null) {
      if (post.length <= INLINE_POST_MAX) postData = { inline: post };
      else {
        const put = await this.writer.putBlob(post);
        if (put.outcome === "stored") postData = { blob: put.ref, size: put.size };
        else postDataMissing = { reason: "too-large", detail: null };
      }
    }
    if (this.writerClosed) return;
    const ev = this.buildEvent(q, {
      outcome: o.outcome,
      endMono: o.endMono,
      body: bodyRef,
      missing,
      error: o.error,
      extraReq: this.extraReq.get(q.key) ?? null,
      extraResp: this.extraResp.get(q.key) ?? null,
      postData,
      postDataMissing,
      unreadByPage: o.unreadByPage === true && bodyRef !== null,
    });
    this.extraReq.delete(q.key);
    this.extraResp.delete(q.key);
    this.appendRequest(q, ev, missing?.reason ?? null);
  }

  private writerClosed = false;
  private indexListeners = new Set<(e: NetEntry) => void>();

  /** Called for every request written to the bundle (after its body is stored). */
  onIndexed(fn: (e: NetEntry) => void): () => void {
    this.indexListeners.add(fn);
    return () => this.indexListeners.delete(fn);
  }

  /** Requests of a tab (null: any tab) still waiting for loadingFinished / loadingFailed. */
  inflightOf(tabId: string | null): Array<{ key: string; method: string; url: string; loaderId: string | null }> {
    return [...this.pending.values()].filter((q) => tabId === null || q.tab.id === tabId).map((q) => ({ key: q.key, method: q.method, url: q.url, loaderId: q.loaderId }));
  }

  get recording(): boolean {
    return !this.writerClosed;
  }

  /** For `daemon status`: where the bundle is and how much is in it. */
  status(): Record<string, unknown> {
    const m = this.writer.snapshot();
    return {
      session: this.session,
      bundle: this.dir,
      recording: !this.writerClosed,
      since: m.created,
      tabs: m.session.tabs.map((t) => t.tab),
      counts: { ...m.counts, wsFrames: this.frames.filter((f) => f.phase === "frame").length, console: this.consoleCount, state: this.stateCount },
      inflight: this.pending.size,
    };
  }

  private buildEvent(
    q: Pending,
    o: {
      outcome: "finished" | "failed" | "incomplete";
      endMono: number | null;
      body: { blob: string; size: number } | null;
      missing: { reason: BodyMissingReason; detail: string | null } | null;
      error: { text: string; canceled: boolean; blockedReason: string | null } | null;
      extraReq: Headers | null;
      extraResp: Headers | null;
      postData?: InlineOrBlob | null;
      postDataMissing?: { reason: string; detail: string | null } | null;
      unreadByPage?: boolean;
    },
  ): UnsequencedEvent {
    const reqH = mergeHeaders(q.headers, o.extraReq);
    const r = q.response;
    // docs/04 §14: never `response: null`. No response at all (cut by a navigation,
    // failed before headers, still open at stop) → status null, empty headers, why.
    let response: Record<string, unknown> = { status: null, headers: {}, body: null, bodyMissing: o.missing ?? { reason: "unsupported", detail: "no response" } };
    if (r !== null) {
      const respH = mergeHeaders(normalizeHeaders(r["headers"]), o.extraResp);
      const ct = headerValue(respH.headers, "content-type");
      const port = num(r, "remotePort");
      const ip = str(r, "remoteIPAddress");
      response = {
        status: num(r, "status") ?? 0,
        statusText: str(r, "statusText") ?? "",
        headers: respH.headers,
        headersSource: respH.source,
        mimeType: str(r, "mimeType"),
        charset: str(r, "charset") ?? charsetOf(ct),
        protocol: str(r, "protocol"),
        remote: ip === null ? null : { ip, port },
        fromCache: r["fromDiskCache"] === true || r["fromPrefetchCache"] === true,
        fromServiceWorker: r["fromServiceWorker"] === true,
        fromPrefetch: r["fromPrefetchCache"] === true,
        body:
          o.body === null
            ? null
            : { blob: o.body.blob, size: o.body.size, base64: false, wireEncoding: headerValue(respH.headers, "content-encoding"), truncated: false },
        bodyMissing: o.body === null ? (o.missing ?? { reason: "unsupported", detail: null }) : null,
      };
    }
    const end = o.endMono;
    const ts = q.wallTs !== null && q.startMono !== null && end !== null ? Math.round((q.wallTs + (end - q.startMono)) * 1000) / 1000 : nowMs();
    const init = q.initiator;
    return {
      ts,
      mono: end,
      kind: "request",
      actor: this.actor(),
      tab: this.bundleTab.get(q.tab.id) ?? null,
      cmd: this.cmdRef(),
      nav: q.nav,
      cdp: { requestId: q.requestId, loaderId: q.loaderId, frameId: q.frameId, sessionId: q.sessionId },
      type: q.type,
      method: q.method,
      url: q.url,
      urlFragment: q.urlFragment,
      initiator: initiatorOf(init),
      request: {
        headers: reqH.headers,
        headersSource: reqH.source,
        postData: o.postData ?? null,
        ...(o.postDataMissing === undefined || o.postDataMissing === null ? {} : { postDataMissing: o.postDataMissing }),
      },
      response,
      redirect: q.redirectFrom === null ? null : { from: q.redirectFrom },
      timing: { ...requestTiming(q.startMono, q.responseMono, end, r === null ? null : r["timing"]), cdp: r !== null && isRecord(r["timing"]) ? r["timing"] : null },
      outcome: o.outcome,
      error: o.error,
      // Incomplete requests whose body was still rescued by Fetch keep it; mark where it came from.
      ...(o.outcome === "incomplete" && o.body !== null ? { bodySource: "fetch" } : {}),
      // docs/04 §5.2 rule 9: finished from the Fetch body, the page never read it (no loadingFinished).
      ...(o.unreadByPage === true ? { bodySource: "fetch", unreadByPage: true } : {}),
    };
  }

  private appendRequest(q: Pending, ev: UnsequencedEvent, reason: string | null = null): string {
    const stored = this.writer.append((seq) => ({ ...ev, id: `r-${seq}` }));
    const id = `r-${stored.seq}`;
    const resp = isRecord(stored["response"]) ? stored["response"] : null;
    const body = resp !== null && isRecord(resp["body"]) ? resp["body"] : null;
    const missing = resp !== null && isRecord(resp["bodyMissing"]) ? str(resp["bodyMissing"], "reason") : null;
    this.index.push({
      id,
      tab: q.tab.id,
      type: q.type,
      method: q.method,
      url: q.url,
      status: resp === null ? null : num(resp, "status"),
      mime: resp === null ? null : str(resp, "mimeType"),
      size: body === null ? null : num(body, "size"),
      outcome: stored["outcome"] === "failed" ? "failed" : stored["outcome"] === "incomplete" ? "incomplete" : "finished",
      blob: body === null ? null : str(body, "blob"),
      bodyMissing: missing ?? (body === null ? reason : null),
      cmd: typeof stored["cmd"] === "string" ? stored["cmd"] : null,
      at: Date.now(),
      ...(stored["unreadByPage"] === true ? { unreadByPage: true } : {}),
    });
    const entry = this.index[this.index.length - 1];
    if (entry !== undefined) {
      for (const fn of [...this.indexListeners]) {
        try {
          fn(entry);
        } catch (e) {
          log.warn("recorder: index listener failed", { error: String(e) });
        }
      }
    }
    return id;
  }

  /**
   * Close matching unfinished requests as `incomplete` (docs/04 §5.4), written
   * in the order they started. After a navigation, a Fetch-paused response of
   * the old document can still arrive a moment later (spike 2 "before-leave"),
   * so those are written after `graceMs` and pick up a rescued body if there
   * is one. The writes are chained, not parallel: each awaits blob storage (and
   * maybe Network.getRequestPostData), and in parallel a slower one landed
   * after a later request — measured 10-15 in the s15 e2e, where requests whose
   * body the page never read are closed at `net stop` and the last
   * /api/limited came out before /api/verified.
   */
  private flush(match: (p: Pending) => boolean, reason: BodyMissingReason, graceMs = 0): void {
    const batch = [...this.pending].filter(([, q]) => match(q));
    if (batch.length === 0) return;
    for (const [key] of batch) {
      this.pending.delete(key);
      this.disarmUnread(key);
    }
    const writeAll = async () => {
      if (graceMs > 0) await Bun.sleep(graceMs);
      for (const [key, q] of batch) {
        const viaFetch = this.fetched.get(key);
        this.fetched.delete(key);
        if (q.response === null && viaFetch !== undefined) q.response = viaFetch.response;
        // One failed write must not drop the rest of the batch.
        await this.write(q, {
          outcome: "incomplete",
          endMono: null,
          body: viaFetch?.bytes ?? null,
          missing: viaFetch === undefined ? { reason, detail: null } : null,
          error: null,
        }).catch((e: unknown) => log.error("recorder: write failed", { request: q.url, error: String(e) }));
      }
    };
    this.track(writeAll());
  }

  /** docs/04 §5.2 rule 9: check this request again `unreadAfterMs` after its response. */
  private armUnread(key: string, q: Pending): void {
    this.disarmUnread(key);
    const ms = this.opts.unreadAfterMs ?? UNREAD_AFTER_MS;
    this.unreadTimers.set(
      key,
      setTimeout(() => this.unread(key, q), ms),
    );
  }

  private disarmUnread(key: string): void {
    const timer = this.unreadTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.unreadTimers.delete(key);
  }

  /**
   * Still no loadingFinished / loadingFailed: if Fetch holds the full body, the
   * page has not read it — write it now as `finished` (end null, unreadByPage).
   * Without a Fetch body nothing happens; stop or a navigation closes it (§5.4).
   */
  private unread(key: string, q: Pending): void {
    this.unreadTimers.delete(key);
    if (this.stopping || this.writerClosed || this.pending.get(key) !== q) return;
    const viaFetch = this.fetched.get(key);
    if (viaFetch === undefined) return;
    this.pending.delete(key);
    this.fetched.delete(key);
    this.track(this.write(q, { outcome: "finished", endMono: null, body: viaFetch.bytes, missing: null, error: null, unreadByPage: true }));
  }

  private track(p: Promise<void>): void {
    const tracked = p.catch((e: unknown) => log.error("recorder: write failed", { error: String(e) }));
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  private onConsole(tabId: string, en: ConsoleEntry): void {
    const bt = this.bundleTab.get(tabId);
    if (bt === undefined || this.stopping || this.writerClosed) return;
    const scrub = this.opts.scrub ?? ((s: string) => s);
    this.writer.append({
      ts: en.ts,
      mono: null,
      kind: "console",
      actor: this.actor(),
      tab: bt,
      cmd: this.cmdRef(),
      level: en.level,
      source: en.source,
      text: scrub(en.text),
      ...(en.truncated ? { truncated: true } : {}),
      args: en.args.map(scrub),
      url: en.url,
      line: en.line,
      col: en.col,
      stack: en.stack === null ? null : scrub(en.stack),
    });
    this.consoleCount++;
  }

  consoleCount = 0;

  /** Open AI command windows, oldest first (docs/04 §4.1 cmd, §14). */
  private activeCmds: Array<{ id: string; started: number }> = [];

  /** The `cmd` envelope field: the innermost open command window, or null. */
  private cmdRef(): string | null {
    return this.activeCmds[this.activeCmds.length - 1]?.id ?? null;
  }

  /** The bundle's current nav epoch (`n-<seq>`) of a daemon tab, or null. */
  navId(tabId: string): string | null {
    return this.navOf.get(tabId) ?? null;
  }

  /** Record the store site / account of the session in the manifest (docs/04 §7, §8.1). */
  setSite(site: string | null, account: string | null): void {
    if (this.writerClosed) return;
    this.writer.updateManifest((m) => {
      m.session.site = site;
      m.session.account = account;
    });
  }

  /**
   * Append a daemon-side event (`guard`, `handoff`, docs/04 §4.2) inside the
   * current command window. Returns its seq, or null when the bundle is closed.
   */
  event(kind: "guard" | "handoff", fields: Record<string, unknown>, o: { tab?: string | null; actor?: Actor } = {}): number | null {
    if (this.writerClosed || this.stopping) return null;
    const ev = this.writer.append({
      ts: nowMs(),
      mono: null,
      kind,
      actor: o.actor ?? "system",
      tab: o.tab === undefined || o.tab === null ? null : (this.bundleTab.get(o.tab) ?? null),
      cmd: this.cmdRef(),
      ...fields,
    });
    return ev.seq;
  }

  /** `cmd` start event; its id `c-<seq>` tags every event until the matching end. */
  cmdStart(c: { tab: string | null; argv: string[] | null; input: Record<string, unknown>; actor?: Actor }): string | null {
    if (this.writerClosed || this.stopping) return null;
    const ev = this.writer.append((seq) => ({
      ts: nowMs(),
      mono: null,
      kind: "cmd",
      actor: c.actor ?? "ai",
      tab: c.tab === null ? null : (this.bundleTab.get(c.tab) ?? null),
      cmd: `c-${seq}`,
      id: `c-${seq}`,
      phase: "start",
      argv: c.argv,
      input: c.input,
    }));
    const id = `c-${ev.seq}`;
    this.activeCmds.push({ id, started: Date.now() });
    this.cmdStarts.set(id, Date.now());
    return id;
  }

  /** `cmd` end event for an open window (ignored when the window is unknown or already closed). */
  cmdEnd(
    id: string,
    c: { tab: string | null; ok: boolean; error: unknown; durationMs: number; outputSummary: unknown; argv?: string[] | null; input?: Record<string, unknown>; actor?: Actor },
  ): void {
    const i = this.activeCmds.findIndex((x) => x.id === id);
    if (i < 0 || this.writerClosed) return;
    this.activeCmds.splice(i, 1);
    this.writer.append({
      ts: nowMs(),
      mono: null,
      kind: "cmd",
      actor: c.actor ?? "ai",
      tab: c.tab === null ? null : (this.bundleTab.get(c.tab) ?? null),
      cmd: id,
      phase: "end",
      ref: id,
      ok: c.ok,
      error: c.error,
      durationMs: c.durationMs,
      outputSummary: c.outputSummary,
      // fill / type: argv and input withheld from the start event (secret check happens in the tool)
      ...(c.input === undefined ? {} : { argv: c.argv ?? null, input: c.input }),
    });
  }

  /** Write buffered event lines now (net show reads events.jsonl while recording). */
  async flushEvents(): Promise<void> {
    if (!this.writerClosed) await this.writer.flush();
  }

  /** Stop: wait for in-flight bodies, close the rest as `stopped`, finish the bundle. */
  async stop(): Promise<{ dir: string; requests: number; counts: unknown }> {
    if (this.writerClosed) return { dir: this.dir, requests: this.index.length, counts: this.writer.snapshot().counts };
    const deadline = Date.now() + 10_000;
    while (this.inflight.size > 0 && Date.now() < deadline) await Promise.race([...this.inflight, Bun.sleep(200)]);
    this.flush(() => true, "stopped");
    for (const c of this.ws.open()) {
      const tab = this.sessions.get(c.key.split("|")[0] ?? "");
      if (c.handshake === null && tab !== undefined) this.writeHandshake(c, c.key.split("|")[0] ?? "", tab, "incomplete", null, "stopped");
    }
    while (this.inflight.size > 0 && Date.now() < deadline) await Promise.race([...this.inflight, Bun.sleep(200)]);
    // docs/04 §4.1: the last cookie snapshot, while the tabs' sessions still answer.
    for (const tab of this.opts.tabs.sessionTabs(this.session)) await this.cookieState(tab, "session-stop");
    this.stopping = true;
    for (const off of this.offs) off();
    for (const sid of this.sessions.keys()) {
      await this.t.send("Fetch.disable", {}, sid, 5000).catch(() => undefined);
      await this.t.send("Network.disable", {}, sid, 5000).catch(() => undefined);
    }
    // The command that stops the recording (net stop, session stop …) ends inside it.
    for (const c of [...this.activeCmds]) {
      this.cmdEnd(c.id, { tab: null, ok: true, error: null, durationMs: Date.now() - c.started, outputSummary: { recordingStopped: true } });
    }
    this.writer.append({ ts: nowMs(), mono: null, kind: "session", actor: "system", tab: null, cmd: null, phase: "stop", name: this.session, mode: { capture: "mixed", trace: false, raw: true } });
    this.writerClosed = true;
    const m = await this.writer.close();
    await new Promise<void>((r) => this.raw.end(() => r()));
    try {
      this.opts.onFinished?.(this.dir);
    } catch (e) {
      log.warn("recorder: onFinished failed", { error: String(e) });
    }
    return { dir: this.dir, requests: this.index.length, counts: m.counts };
  }
}

/**
 * docs/04 §5.1 initiator. Script initiators usually carry only a stack; its top
 * frame (or the first async parent's) gives url / line / col. CDP numbers as is (0-based).
 */
export function initiatorOf(init: Record<string, unknown> | null): Record<string, unknown> | null {
  if (init === null) return null;
  let url = str(init, "url");
  let line = num(init, "lineNumber");
  let col = num(init, "columnNumber");
  if (url === null || url === "") {
    let st: unknown = init["stack"];
    for (let depth = 0; isRecord(st) && depth < 8; depth++, st = st["parent"]) {
      const top = Array.isArray(st["callFrames"]) ? st["callFrames"].find(isRecord) : undefined;
      if (top !== undefined && (str(top, "url") ?? "") !== "") {
        url = str(top, "url");
        line = num(top, "lineNumber");
        col = num(top, "columnNumber");
        break;
      }
    }
  }
  return { type: str(init, "type") ?? "other", url: url === "" ? null : url, line, col, stack: null };
}

function msOf(seconds: number | null): number | null {
  return seconds === null ? null : monotonicToMono(seconds);
}
