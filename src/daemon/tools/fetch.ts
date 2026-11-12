// tabcap fetch (0.6-A, owner design 10-16): a script's or an agent's request
// sent by the session's logged-in tab and recorded with deterministic
// attribution, per-host pacing and stop rules.
//
// Flow of one fetch: validate (fetch/spec.ts) → which store site the URL
// belongs to (its `fetch` config, its stop state) → wait for the host's turn
// (fetch/limiter.ts) → register the fetch with the recorder (fetchId
// `c-N:f-K`, marker for same-origin, helper function name + scriptId for the
// initiator fallback) → run the helper in an isolated world (fetch/helper.ts)
// → wait for the recorder to write the request → envelope from the recorded
// event (status, selected scrubbed headers, body inline ≤ 8 KB text, else a
// file) → stop rules (fetch/stoprules.ts).

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { BlobStore } from "../../bundle/blobs.ts";
import { TabcapError, toFail, type Envelope } from "../../shared/envelope.ts";
import { readFetchConfig, type FetchConfig } from "../../shared/config.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { FetchRecord, Recorder } from "../capture/recorder.ts";
import type { FetchReg } from "../capture/fetchmark.ts";
import { fetchStoppedError, originOf, sessionFlag, STOP_RULE_NEXT, waitingError, type Handoff } from "../guard.ts";
import type { Daemon } from "../state.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import { inWorld, rootDoc } from "../browser/worlds.ts";
import type { ConsoleLog } from "../capture/console.ts";
import type { Transport } from "../transport/types.ts";
import { helperResultOf, helperSource, type HelperResult } from "../fetch/helper.ts";
import { firstStop, parseStopRule, type StopRule } from "../fetch/stoprules.ts";
import { FETCH_USAGE, parseFetchSpec, targetUrl, type FetchCredentials, type FetchSpec } from "../fetch/spec.ts";
import { allSiteRules } from "../siterules.ts";
import { siteOf } from "../../shared/sites.ts";
import { exportBody } from "./bodyexport.ts";
import { decodeBody } from "./netsearch.ts";
import { redactFlatHeaders, redactRuleDetail } from "./liveredact.ts";
import type { Args } from "./args.ts";
import { current } from "./net.ts";
import { findRequestEvent } from "./netshow.ts";
import { docIdentity } from "../browser/doc.ts";
import { fillTemplate, isAuthHeader, likeSource, parseStorageTemplate, queryPair, resendHeaders, STORAGE_FN, withHeaders, withQuery, type StorageTemplate } from "../fetch/like.ts";

/** Text bodies up to this size come back inline (`body`); larger or binary ones as a file (`bodyFile`). */
export const INLINE_BODY_MAX = 8 * 1024;
/** `rawBody` (endpoint) / `--raw`: base64 inline up to this size. */
export const RAW_BODY_MAX = 16 * 1024 * 1024;
const MAX_BATCH = 1000;
/** Response headers an envelope carries (values scrubbed, each cut at 1000 chars). */
export const ENVELOPE_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-disposition",
  "location",
  "cache-control",
  "etag",
  "last-modified",
  "retry-after",
];
/** After the helper failed, how long the recorder gets to write the request (CORS block, network error). */
const FAILED_GRACE_MS = 2000;

export type ToolCtx = { cmd: string | null };

/** The browser parts a fetch uses (the daemon's running browser; unit tests pass fakes). */
export type FetchBrowser = { t: Transport; tabs: Tabs; console: ConsoleLog | null };

/** The selected response headers of an envelope (scrubbed, cut). */
export function envelopeHeaders(h: unknown, scrub: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(h)) return out;
  for (const name of ENVELOPE_HEADERS) {
    const v = h[name];
    const s = typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : null;
    if (s !== null) out[name] = scrub(s).slice(0, 1000);
  }
  return out;
}

/** `timing` of an envelope from the recorded event (CDP monotonic ms); 0.7-E: `totalMs` (was `ms`, the 0.7-C naming table). */
export function envelopeTiming(event: Record<string, unknown>): { startMono: number | null; endMono: number | null; totalMs: number | null } {
  const t = isRecord(event["timing"]) ? event["timing"] : {};
  const start = num(t, "start");
  const end = num(t, "end");
  return { startMono: start, endMono: end, totalMs: start !== null && end !== null ? Math.round((end - start) * 1000) / 1000 : null };
}

type BodyOut = { where: "inline" | "file" | "raw" | "out"; text: string | null; bytes: Uint8Array };

/** The recorded body bytes of a request, or null (no body stored). */
function recordedBody(rec: Recorder, r: FetchRecord): Uint8Array | null {
  if (r.entry.blob === null) return null;
  const p = new BlobStore(rec.dir).pathOf(r.entry.blob);
  if (p === null) return null;
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}

function writePrivate(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The envelope of one recorded fetch. Text is decoded like `net body` and
 * scrubbed (docs/04 §8.1) before it is inlined, written or base64-encoded;
 * binary bodies go out as recorded.
 */
function buildEnvelope(
  d: Daemon,
  rec: Recorder,
  r: FetchRecord,
  o: { fetchId: string; waitedMs: number; spec: FetchSpec },
): { data: Record<string, unknown>; status: number | null; bytes: number; text: string | null } {
  const scrub = (s: string) => d.secrets.scrub(s);
  const resp = isRecord(r.event["response"]) ? r.event["response"] : {};
  // docs/04 §53.8: a decode plugin's plaintext (§28) is the default body; --raw keeps the original.
  const view = o.spec.rawBody ? null : decodedView(rec, r);
  const bytes = view?.bytes ?? recordedBody(rec, r);
  const mime = view === null ? r.entry.mime : view.mime;
  const charset = () => (view === null ? str(resp, "charset") : null);
  const decoded = bytes === null ? null : decodeBody(bytes, mime, charset);
  const text = decoded === null ? null : scrub(decoded);
  const data: Record<string, unknown> = {
    id: r.entry.id,
    fetchId: o.fetchId,
    status: r.entry.status,
    statusText: str(resp, "statusText") ?? "",
    mime,
    bytes: bytes?.length ?? 0,
    ...(view === null ? {} : { decoded: `plugin:${view.by}` }),
    // 0.6-E: sensitive header values and URL query tokens shown as <redacted:name> unless reveal (docs/04 §8.3)
    headers: o.spec.reveal ? envelopeHeaders(resp["headers"], scrub) : redactFlatHeaders(envelopeHeaders(resp["headers"], scrub), { scrub }),
  };
  if (bytes === null) {
    const m = isRecord(resp["bodyMissing"]) ? str(resp["bodyMissing"], "reason") : null;
    data["bodyMissing"] = m ?? r.entry.bodyMissing ?? "none";
  } else {
    const out = bodyOut(o.spec, bytes, text);
    if (out.where === "inline") data["body"] = out.text ?? "";
    else if (out.where === "raw") data["bodyBase64"] = Buffer.from(out.bytes).toString("base64");
    else if (out.where === "out" && o.spec.out !== null) {
      const path = resolve(o.spec.out);
      writePrivate(path, out.bytes);
      data["bodyFile"] = path;
    } else {
      const f = exportBody({ id: r.entry.id, url: r.entry.url, bytes, mime, resourceType: r.entry.type, charset, scrub, pretty: false, where: { bundle: rec.dir } });
      data["bodyFile"] = f["file"];
      if (o.spec.rawBody) data["note"] = `rawBody: the body is over ${RAW_BODY_MAX} bytes, so it went to bodyFile`;
    }
  }
  data["timing"] = envelopeTiming(r.event);
  data["waitedMs"] = o.waitedMs;
  return { data, status: r.entry.status, bytes: bytes?.length ?? 0, text };
}

/** The response's decode-plugin view stored while recording (index entry `decoded`), or null. */
function decodedView(rec: Recorder, r: FetchRecord): { bytes: Uint8Array; mime: string | null; by: string } | null {
  const dv = r.entry.decoded;
  if (dv === undefined) return null;
  const p = new BlobStore(rec.dir).pathOf(dv.blob);
  if (p === null) return null;
  try {
    return { bytes: readFileSync(p), mime: dv.mime, by: dv.by };
  } catch {
    return null;
  }
}

/** Where the body goes: --out, rawBody (base64 ≤ 16 MB), inline (text ≤ 8 KB), else a file. */
function bodyOut(spec: FetchSpec, bytes: Uint8Array, text: string | null): BodyOut {
  const payload = text === null ? bytes : new TextEncoder().encode(text);
  if (spec.out !== null) return { where: "out", text, bytes: payload };
  if (spec.rawBody) return payload.length <= RAW_BODY_MAX ? { where: "raw", text, bytes: payload } : { where: "file", text, bytes: payload };
  if (text !== null && bytes.length <= INLINE_BODY_MAX && payload.length <= INLINE_BODY_MAX) return { where: "inline", text, bytes: payload };
  return { where: "file", text, bytes: payload };
}

/** The console's CORS message for a URL (written by Chrome when the response is blocked), or null. */
async function corsReason(d: Daemon, b: FetchBrowser, tab: Tab, url: string, since: number): Promise<string | null> {
  const ring = b.console?.ring(tab.id);
  if (ring === undefined) return null;
  for (let i = 0; i < 10; i++) {
    const hit = ring
      .toArray()
      .reverse()
      .find((e) => e.ts >= since - 1000 && e.text.includes("CORS policy") && e.text.includes(url));
    if (hit !== undefined) return d.secrets.scrub(hit.text).slice(0, 1000);
    await Bun.sleep(100);
  }
  return null;
}

/**
 * Does a CORS reason fail only because the request carried credentials?
 * Chrome's messages for a credentialed cross-origin read all end in "when the
 * request's credentials mode is 'include'": `Access-Control-Allow-Origin: *`
 * ("must not be the wildcard '*'"), and an `Access-Control-Allow-Credentials`
 * that is missing or not exactly `true` (e.g. a duplicated "true, true").
 * Oracle: the console messages of the s60 range (docs/05), CfT 155.
 */
export function credentialsBlock(reason: string): "wildcard-origin" | "allow-credentials" | null {
  if (!/credentials mode is 'include'/.test(reason)) return null;
  if (/Access-Control-Allow-Origin/.test(reason) && /wildcard '\*'/.test(reason)) return "wildcard-origin";
  if (/Access-Control-Allow-Credentials/.test(reason)) return "allow-credentials";
  return null;
}

/** The `next` of fetch.blocked (0.6-P): `--credentials omit` first when only the credentials mode is in the way. */
export function blockedNext(reason: string, mode: FetchCredentials, origin: string): string {
  const navigate = `navigate the tab to a page of ${origin} first and fetch from there (the request's Origin / Referer then become ${origin}, which some backends refuse)`;
  const why = mode === "include" ? credentialsBlock(reason) : null;
  if (why === null) return `The site does not let the page read this URL; ${navigate}, or use a same-origin URL.`;
  const what = why === "wildcard-origin" ? "answers `Access-Control-Allow-Origin: *`, which a request with cookies may not read" : "sends an `Access-Control-Allow-Credentials` that is not exactly `true` (missing, or duplicated like `true, true`)";
  return `The API ${what}: retry with \`--credentials omit\` (POST /fetch: "credentials": "omit"); no cookies are sent then, which is fine when the API authenticates by a header such as Authorization. Otherwise ${navigate}.`;
}

export const FETCH_WORLD = "tabcap-fetch";

/**
 * Compile the helper in the `tabcap-fetch` isolated world of the tab's main-frame document: one world per
 * document, reused by every fetch on it (browser/worlds.ts; review 10-21, before each fetch made a new one).
 * The document is keyed by the tab's committed-navigation count, so a fetch costs no frame-tree round trip:
 * a new document always moves it (a same-document navigation does too, which only makes one more world).
 * Only the compile is retried on a vanished context, never the run (that would send the request twice).
 */
export async function compileFetchHelper(t: Transport, tab: Tab, src: string): Promise<{ ctx: number; scriptId: string }> {
  const doc = rootDoc(tab, { frameId: tab.targetId, loaderId: `nav-${tab.navEpoch}`, url: tab.url });
  return inWorld(
    t,
    tab,
    doc,
    async (ctx) => {
      const c = await t.send("Runtime.compileScript", { expression: src, sourceURL: "", persistScript: true, executionContextId: ctx }, tab.sessionId, 5000);
      const scriptId = str(c, "scriptId");
      if (scriptId === null) throw new TabcapError("internal", "the fetch helper did not compile", "This is a bug; rerun with TABCAP_LOG=debug and report the output.");
      return { ctx, scriptId };
    },
    FETCH_WORLD,
  );
}

/** Run the helper in the tabcap-fetch isolated world of the tab's main frame. */
async function runHelper(t: Transport, tab: Tab, reg: FetchReg, spec: FetchSpec, target: URL, budgetMs: number): Promise<HelperResult> {
  const sid = tab.sessionId;
  const src = helperSource(reg.fnName, { url: target.href, method: spec.method, headers: spec.headers, body: spec.body, credentials: spec.credentials, marker: reg.marker, timeoutMs: Math.max(1, budgetMs) });
  const { ctx, scriptId } = await compileFetchHelper(t, tab, src);
  reg.scriptId = scriptId;
  const r = await t.send("Runtime.runScript", { scriptId, executionContextId: ctx, awaitPromise: true, returnByValue: true }, sid, budgetMs + 5000);
  const res = isRecord(r["result"]) ? helperResultOf(r["result"]["value"]) : null;
  if (res === null) {
    const ex = isRecord(r["exceptionDetails"]) ? str(r["exceptionDetails"], "text") : null;
    throw new TabcapError("page", `the fetch helper failed in the page${ex === null ? "" : `: ${ex.slice(0, 300)}`}`, "Check the tab (`tabcap screenshot`); a page that is still loading or crashed cannot fetch.");
  }
  return res;
}

/**
 * Owner 10-21 (docs/04 §26): the session waits for the human (guard.blocking, as at the command's
 * entry), so this fetch is refused before it is sent; it takes no turn of the host's pacing.
 */
class WaitingRefusal extends TabcapError {
  constructor(readonly h: Handoff) {
    const e = waitingError(h);
    super(e.code, e.message, e.next, e.extra);
  }
}

function refuseWhileWaiting(d: Daemon, session: string, url: string | null): void {
  const h = d.guard.blocking(session, "fetch", url);
  if (h !== null) throw new WaitingRefusal(h);
}

/** A batch line not sent because the session waits: `waiting` / `guard.stopped` without the handoff view (the batch's answer carries it once). */
function notSentLine(d: Daemon, e: WaitingRefusal): Envelope<unknown> {
  return { ok: false, error: { code: e.code, message: d.secrets.scrub(`not sent: ${e.message}`), next: e.next, reason: e.h.reason } };
}

/** Parse config + command stop rules; a bad config rule is the config's fault (bad-input). */
function stopRules(cfg: FetchConfig, spec: FetchSpec, site: string | null): StopRule[] {
  const fromConfig = cfg.stopOn.map((s) => {
    try {
      return parseStopRule(s);
    } catch (e) {
      const where = site === null ? "fetch.stopOn" : `sites.${site}.fetch.stopOn (or fetch.stopOn)`;
      throw new TabcapError("bad-input", `config.json ${where}: ${e instanceof Error ? e.message : String(e)}`, "Fix the rule in config.json.");
    }
  });
  return [...fromConfig, ...spec.stopOn.map(parseStopRule)];
}

/** 0.7.5-A end rules (docs/04 §38): the site's guard.endOn, then the command's --end-on. */
function endRules(d: Daemon, spec: FetchSpec, site: string | null): { site: StopRule[]; own: StopRule[] } {
  const own = spec.endOn.map(parseStopRule);
  return { site: site === null ? [] : (allSiteRules(d.paths.configFile).get(site)?.endRules ?? []), own };
}

const LIKE_ONLY = ["like", "query", "headerFromStorage"] as const;
/** Most recorded requests of the sending tab looked at for fresh authentication headers (newest first). */
const AUTH_LOOKBACK = 200;

const pairList = (v: unknown, what: string): Array<[string, string]> => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new TabcapError("usage", `${what} must be a list of [name, value] pairs`, "e.g. [[\"page\", \"2\"]]");
  return v.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") throw new TabcapError("usage", `${what} must be a list of [name, value] pairs`, "e.g. [[\"page\", \"2\"]]");
    return [p[0], p[1]];
  });
};

/** The --like parts of a request (checked before anything is sent). */
function likeParts(a: Args): { like: string; query: Array<[string, string]>; storage: StorageTemplate[] } | null {
  const like = a["like"];
  if (like === undefined || like === null) {
    for (const k of ["query", "headerFromStorage"]) if (a[k] !== undefined && a[k] !== null) throw new TabcapError("usage", `${k === "query" ? "--query" : "--header-from-storage"} goes with --like <r-N>`, "e.g. tabcap fetch --like r-12 --query page=2");
    return null;
  }
  if (typeof like !== "string" || !/^r-\d{1,9}$/.test(like)) throw new TabcapError("usage", "--like takes a request id like r-12", "See `tabcap net list` for ids.");
  if (a["url"] !== undefined && a["url"] !== null) throw new TabcapError("usage", "give either <url> or --like <r-N>, not both", "--like takes the URL from the recorded request; --query changes its query string.");
  const q = a["query"];
  const query = Array.isArray(q) && q.every((x) => typeof x === "string") ? q.map((x) => queryPair(x as string)) : pairList(q, "query");
  const hs = a["headerFromStorage"];
  const storage = (hs === undefined || hs === null ? [] : Array.isArray(hs) ? hs : [hs]).map((x) => {
    if (typeof x !== "string") throw new TabcapError("usage", "headerFromStorage must be a list of 'Name=template' strings", "e.g. 'Authorization=Bearer {local:@session:singleId}'");
    return parseStorageTemplate(x);
  });
  return { like, query, storage };
}

/** Read the storage templates' values in the sending tab (tabcap's isolated world: storage is per origin). */
async function storageHeaders(d: Daemon, b: FetchBrowser, tab: Tab, storage: StorageTemplate[]): Promise<Array<[string, string]>> {
  if (storage.length === 0) return [];
  const doc = rootDoc(tab, await docIdentity(b.t, tab));
  const out: Array<[string, string]> = [];
  for (const tpl of storage) {
    const reads = tpl.parts.filter((p) => typeof p !== "string");
    const v = await inWorld(b.t, tab, doc, async (ctx) => {
      const r = await b.t.send("Runtime.callFunctionOn", { functionDeclaration: STORAGE_FN, executionContextId: ctx, arguments: [{ value: reads }], returnByValue: true }, tab.sessionId, 5000);
      return isRecord(r["result"]) && isRecord(r["result"]["value"]) ? r["result"]["value"] : {};
    });
    const missing = str(v, "missing");
    if (missing !== null) throw new TabcapError("not-found", `--header-from-storage ${tpl.name}: ${missing} is not set in tab ${tab.id}`, "Check the key on the page (`tabcap evaluate 'Object.keys(localStorage)'`), or log in again in that tab.", { header: tpl.name, missing });
    const values = Array.isArray(v["values"]) ? v["values"].filter((x): x is string => typeof x === "string") : [];
    for (const x of values) if (x.length >= 4) d.secrets.add(x);
    const value = fillTemplate(tpl, values);
    if (/[\r\n\0]/.test(value)) throw new TabcapError("bad-input", `--header-from-storage ${tpl.name}: the stored value has a line break`, "A header value is one line; check what the page stores.");
    out.push([tpl.name, value]);
  }
  return out;
}

/**
 * docs/04 §53.8: the request a `--like <r-N>` sends: the recorded method, URL,
 * resendable headers and body, with authentication headers taken from the
 * sending tab's newest recorded request to the same host (r-N's own when that
 * tab has none), then --query, --header, --header-from-storage and a new body.
 */
async function likeArgs(d: Daemon, b: FetchBrowser, a: Args, session: string, parts: NonNullable<ReturnType<typeof likeParts>>): Promise<{ args: Args; extra: Record<string, unknown> }> {
  const { dir, index, rec } = current(d, session);
  await rec.flushEvents();
  const store = new BlobStore(dir);
  const ev = findRequestEvent(dir, parts.like);
  const src = ev === null ? null : likeSource(ev, (blob) => {
    const x = store.tryRead(blob);
    return x === null ? null : new TextDecoder().decode(x);
  });
  if (src === null) throw new TabcapError("not-found", `no request ${parts.like} in ${dir}`, "Run `tabcap net list` for request ids.");
  const tab = b.tabs.pick(session, typeof a["tab"] === "string" ? a["tab"] : null);
  let host: string;
  try {
    host = new URL(src.url).host;
  } catch {
    throw new TabcapError("bad-input", `${src.id} has no usable URL`, "Pick another request from `tabcap net list`.");
  }
  let headers = resendHeaders(src.headers);
  const ownAuth = headers.filter(([k]) => isAuthHeader(k));
  const extra: Record<string, unknown> = { like: src.id };
  let fresh: { from: string; headers: Array<[string, string]> } | null = null;
  let looked = 0;
  for (let i = index.length - 1; i >= 0 && looked < AUTH_LOOKBACK && fresh === null; i--) {
    const e = index[i];
    if (e === undefined || e.tab !== tab.id || e.fetchId !== undefined) continue;
    let h: string;
    try {
      h = new URL(e.url).host;
    } catch {
      continue;
    }
    if (h !== host) continue;
    looked++;
    const other = findRequestEvent(dir, e.id);
    const req = other !== null && isRecord(other["request"]) ? other["request"] : {};
    const auth = resendHeaders(req["headers"]).filter(([k]) => isAuthHeader(k));
    if (auth.length > 0) fresh = { from: e.id, headers: auth };
  }
  if (fresh !== null) {
    headers = withHeaders(headers, fresh.headers);
    extra["auth"] = { from: fresh.from, tab: tab.id };
  } else if (ownAuth.length > 0) {
    extra["auth"] = { from: src.id, note: `no recorded request of tab ${tab.id} to ${host} carries authentication headers; used ${src.id}'s own` };
  }
  const given = Array.isArray(a["headers"]) || isRecord(a["headers"]) ? a["headers"] : null;
  const over: Array<[string, string]> = given === null ? [] : Array.isArray(given) ? pairList(given, "headers") : Object.entries(given).filter((x): x is [string, string] => typeof x[1] === "string");
  headers = withHeaders(headers, over);
  const fromStorage = await storageHeaders(d, b, tab, parts.storage);
  headers = withHeaders(headers, fromStorage);
  if (fromStorage.length > 0) extra["fromStorage"] = fromStorage.map(([k]) => k);
  const args: Args = { ...a, url: withQuery(src.url, parts.query), headers };
  for (const k of LIKE_ONLY) delete args[k];
  if (typeof a["method"] !== "string") args["method"] = src.method;
  const newBody = ["body", "json", "form"].some((k) => a[k] !== undefined && a[k] !== null);
  if (!newBody && src.body !== null) args["body"] = src.body;
  if (!newBody && src.body === null && src.bodyMissing) throw new TabcapError("not-found", `${src.id}'s request body was not recorded`, "Give the body with --json / --body / --form.");
  return { args, extra };
}

/** One fetch; `k` numbers it inside its command (`c-N:f-K`). */
export async function fetchOne(d: Daemon, b: FetchBrowser, given: Args, session: string, cmd: string | null, k: number): Promise<Record<string, unknown>> {
  const parts = likeParts(given);
  const resolved = parts === null ? { args: given, extra: {} } : await likeArgs(d, b, given, session, parts);
  const out = await fetchSpec(d, b, resolved.args, session, cmd, k);
  return { ...out, ...resolved.extra };
}

async function fetchSpec(d: Daemon, b: FetchBrowser, a: Args, session: string, cmd: string | null, k: number): Promise<Record<string, unknown>> {
  const spec = parseFetchSpec(a);
  const rec = d.recorders.get(session);
  if (rec === undefined) {
    throw new TabcapError("not-found", `session "${session}" is not recording; tabcap fetch records every request it sends`, "Run `tabcap net start` first (then navigate to the logged-in site).");
  }
  const tab = b.tabs.pick(session, spec.tab);
  if (tab.closed) throw new TabcapError("no-tab", `tab ${tab.id} was closed`, "Run `tabcap tab list`, or navigate first.");
  if (tab.dialog !== null) throw new TabcapError("dialog", `a JavaScript dialog is open in ${tab.id}`, "Answer it first: `tabcap dialog accept` or `tabcap dialog dismiss`.");
  const target = targetUrl(spec.url, tab.url);
  const bound = d.sites.get(session) ?? null;
  const where = siteOf(d.store?.listSites() ?? [], bound?.site ?? null, target);
  const cfg = readFetchConfig(d.paths.configFile, where.site);
  const rules = stopRules(cfg, spec, where.site);
  const ends = endRules(d, spec, where.site);
  refuseWhileWaiting(d, session, target.href);
  const stopped = d.guard.fetchStopOf(where.key);
  if (stopped !== null) throw fetchStoppedError(stopped);
  const started = Date.now();
  const deadline = started + spec.timeoutMs;
  const slot = await d.fetchLimiter.acquire(target.host, cfg, deadline);
  const fetchId = `${cmd ?? "c-0"}:f-${k}`;
  let releaseStage: (() => Promise<void>) | null = null;
  let recorded: FetchRecord | null = null;
  // 0.6-I: --stop-on is the per-call override of the site's guard.stopOn (the site's non-2xx counter still counts).
  const releaseOverride = spec.stopOn.length > 0 ? d.guard.overrideSiteRules(fetchId) : null;
  // 0.7.5-A: --end-on joins the site's endOn in the guard's check of this fetch's response.
  const releaseEnds = ends.own.length > 0 ? d.guard.fetchEndRules(fetchId, ends.own) : null;
  try {
    // The turn may have taken a while: a session that started waiting meanwhile sends nothing (and gives the turn back).
    try {
      refuseWhileWaiting(d, session, target.href);
    } catch (e) {
      slot.cancel();
      throw e;
    }
    const again = d.guard.fetchStopOf(where.key);
    if (again !== null) throw fetchStoppedError(again);
    const same = originOf(tab.url) === target.origin;
    const reg: FetchReg = { fetchId, cmd, sessionId: tab.sessionId, marker: same ? fetchId : null, fnName: `__tabcap_fetch_${randomBytes(4).toString("hex")}_${k}`, scriptId: null, credentials: spec.credentials };
    rec.expectFetch(reg);
    if (same) releaseStage = await rec.holdRequestStage(tab.sessionId);
    const consoleSince = Date.now();
    const helper = await runHelper(b.t, tab, reg, spec, target, Math.max(1, deadline - Date.now()));
    recorded = await rec.waitFetch(fetchId, helper.ok ? Math.max(500, deadline - Date.now()) : FAILED_GRACE_MS);
    if (!helper.ok) {
      if (helper.aborted) {
        throw new TabcapError("timeout", `the request did not finish within ${spec.timeoutMs} ms (aborted in the page)`, "Raise --timeout, or check that the site answers.", {
          fetchId,
          ...(recorded === null ? {} : { request: recorded.entry.id }),
        });
      }
      const reason = await corsReason(d, b, tab, target.href, consoleSince);
      if (reason !== null) {
        throw new TabcapError("fetch.blocked", `the page's CORS rules blocked the request: ${reason}`, blockedNext(reason, spec.credentials, target.origin), {
          fetchId,
          request: recorded?.entry.id ?? null,
          url: target.href,
          credentials: spec.credentials,
          reason,
        });
      }
      const err = recorded !== null && isRecord(recorded.event["error"]) ? str(recorded.event["error"], "text") : null;
      throw new TabcapError("page", `the request failed in the page: ${err ?? helper.error}`, "Check the URL and that the site answers; `tabcap console list` may say more.", {
        fetchId,
        request: recorded?.entry.id ?? null,
        url: target.href,
      });
    }
    if (recorded === null) {
      throw new TabcapError("internal", `the page got the response of ${fetchId} (HTTP ${helper.status}) but the recording has no request for it`, "Run `tabcap net list` to look for it; rerun with TABCAP_LOG=debug and report the output.", { fetchId });
    }
    const env = buildEnvelope(d, rec, recorded, { fetchId, waitedMs: slot.waitedMs, spec });
    // docs/04 §8.3: a json: rule's detail on a sensitive name is shown as <redacted:name> unless reveal (the guard events keep it)
    const shown = (detail: string): string => (spec.reveal ? detail : redactRuleDetail(detail, { scrub: (s) => d.secrets.scrub(s) }));
    // 0.7.5-A: an end rule comes before every stop rule; the list has ended, nothing stops.
    const end = d.guard.endHit(session, recorded.entry.id) ?? firstStop([...ends.site, ...ends.own], { status: env.status, bytes: env.bytes, text: env.text });
    if (end !== null) {
      d.guard.noteEnd(rec, session, { site: where.key, request: recorded.entry.id, url: target.href, status: env.status, tab: tab.id, fetchId }, end);
      return { ...env.data, end: { rule: end.rule, detail: shown(end.detail) } };
    }
    // 0.6-I: a site stop rule fired on this very response (the guard already stopped the site and the session waits).
    const site = d.guard.stopRuleHit(session, recorded.entry.id);
    if (site !== null) {
      const detail = shown(site.detail);
      throw new TabcapError(
        "fetch.stopped",
        `site stop rule ${site.rule} fired on ${recorded.entry.id} (${detail}); the session waits and fetches on ${site.site} are refused from now on`,
        STOP_RULE_NEXT({ session, site: site.site, request: recorded.entry.id }),
        { site: site.site, reason: "stop-rule", rule: site.rule, detail, request: recorded.entry.id, fetchId, result: { ...env.data, stopped: { rule: site.rule, detail } } },
      );
    }
    const hit = firstStop(rules, { status: env.status, bytes: env.bytes, text: env.text });
    if (hit === null) return env.data;
    const detail = shown(hit.detail);
    const data = { ...env.data, stopped: { rule: hit.rule, detail } };
    d.guard.stopFetch(
      rec,
      { site: where.key, session, rule: hit.rule, detail: hit.detail, request: recorded.entry.id, fetchId, url: target.href, status: env.status, since: Date.now(), reason: "fetch-stop" },
      { tab: tab.id, account: bound !== null && bound.site === where.site ? bound.account : null },
    );
    throw new TabcapError("fetch.stopped", `stop rule ${hit.rule} fired on ${recorded.entry.id} (${detail}); fetches on ${where.key} are refused from now on`, `Look at the response (\`tabcap net body ${recorded.entry.id}${sessionFlag(session)}\`); continue only when the human (or you, after checking) decides to: \`tabcap guard resume --site ${where.key}\`.`, {
      site: where.key,
      rule: hit.rule,
      detail,
      request: recorded.entry.id,
      fetchId,
      result: data,
    });
  } finally {
    releaseOverride?.();
    releaseEnds?.();
    slot.release();
    if (releaseStage !== null) await releaseStage();
    // A request that is written after the command gave up still finds its fetch for a while.
    if (recorded !== null) rec.forgetFetch(fetchId);
    else setTimeout(() => rec.forgetFetch(fetchId), 60_000).unref();
  }
}

/** `tabcap fetch` / `POST /fetch`: one request, or `batch` (a list of requests, in order, under the same limits). */
export function fetchTool(d: Daemon, a: Args, session: string, ctx: ToolCtx = { cmd: null }): Promise<unknown> {
  // Validation first: a bad request is a usage error even without a browser.
  if (a["batch"] === undefined || a["batch"] === null) {
    if (likeParts(a) === null) parseFetchSpec(a);
  }
  return fetchRun(d, d.need(), a, session, ctx);
}

/** fetchTool with the browser given (unit tests). */
export async function fetchRun(d: Daemon, b: FetchBrowser, a: Args, session: string, ctx: ToolCtx): Promise<unknown> {
  const batch = a["batch"];
  if (batch === undefined || batch === null) return fetchOne(d, b, a, session, ctx.cmd, 1);
  if (!Array.isArray(batch) || batch.length === 0) throw new TabcapError("usage", "batch must be a non-empty list of requests", `Usage: ${FETCH_USAGE}`);
  if (batch.length > MAX_BATCH) throw new TabcapError("usage", `at most ${MAX_BATCH} requests per batch`, "Split the file.");
  // Validate every line before the first request goes out.
  batch.forEach((x, i) => {
    try {
      if (!isRecord(x) || likeParts(x) === null) parseFetchSpec(x);
    } catch (e) {
      throw e instanceof TabcapError ? new TabcapError(e.code, `batch line ${i + 1}: ${e.message}`, e.next) : e;
    }
  });
  const out: Envelope<unknown>[] = [];
  // Owner 10-21: from the first line the session's waiting refuses, no line is sent (an end rule does not stop a batch).
  let refused: WaitingRefusal | null = null;
  for (let i = 0; i < batch.length; i++) {
    const line: unknown = batch[i];
    const args = isRecord(line) ? line : {};
    try {
      if (refused === null) refuseWhileWaiting(d, session, typeof args["url"] === "string" ? args["url"] : null);
      if (refused !== null) throw refused;
      out.push({ ok: true, data: await fetchOne(d, b, args, session, ctx.cmd, i + 1) });
    } catch (e) {
      if (e instanceof WaitingRefusal) {
        refused = e;
        out.push(notSentLine(d, e));
      } else out.push(scrubFail(d, toFail(e)));
      log.debug("fetch: batch line failed", { line: i + 1 });
    }
  }
  return { batch: out, count: out.length, failed: out.filter((x) => !x.ok).length };
}

function scrubFail(d: Daemon, env: Envelope<unknown>): Envelope<unknown> {
  return env.ok ? env : { ok: false, error: { ...env.error, message: d.secrets.scrub(env.error.message) } };
}
