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
import { fetchStoppedError, originOf, STOP_RULE_NEXT } from "../guard.ts";
import type { Daemon } from "../state.ts";
import type { Tab, Tabs } from "../browser/targets.ts";
import type { ConsoleLog } from "../capture/console.ts";
import type { Transport } from "../transport/types.ts";
import { helperResultOf, helperSource, type HelperResult } from "../fetch/helper.ts";
import { firstStop, parseStopRule, type StopRule } from "../fetch/stoprules.ts";
import { FETCH_USAGE, parseFetchSpec, targetUrl, type FetchCredentials, type FetchSpec } from "../fetch/spec.ts";
import { exportBody } from "./bodyexport.ts";
import { decodeBody } from "./netsearch.ts";
import { redactFlatHeaders } from "./liveredact.ts";
import type { Args } from "./args.ts";

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

/** Which store site a URL belongs to (session-bound site first), else its host. */
export function siteOf(
  sites: ReadonlyArray<{ name: string; entryUrl: string; domains: readonly string[] }>,
  bound: string | null,
  url: URL,
): { key: string; site: string | null } {
  const host = url.hostname.toLowerCase();
  const ordered = [...sites].sort((a, b) => (a.name === bound ? -1 : b.name === bound ? 1 : 0));
  for (const s of ordered) {
    let entryHost: string | null = null;
    try {
      entryHost = new URL(s.entryUrl).hostname.toLowerCase();
    } catch {
      entryHost = null;
    }
    const hosts = [...(entryHost === null ? [] : [entryHost]), ...s.domains.map((d) => d.trim().toLowerCase().replace(/^\.+/, "")).filter((d) => d !== "")];
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { key: s.name, site: s.name };
  }
  return { key: url.host, site: null };
}

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

/** `timing` of an envelope from the recorded event (CDP monotonic ms). */
export function envelopeTiming(event: Record<string, unknown>): { startMono: number | null; endMono: number | null; ms: number | null } {
  const t = isRecord(event["timing"]) ? event["timing"] : {};
  const start = num(t, "start");
  const end = num(t, "end");
  return { startMono: start, endMono: end, ms: start !== null && end !== null ? Math.round((end - start) * 1000) / 1000 : null };
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
  const bytes = recordedBody(rec, r);
  const charset = () => str(resp, "charset");
  const decoded = bytes === null ? null : decodeBody(bytes, r.entry.mime, charset);
  const text = decoded === null ? null : scrub(decoded);
  const data: Record<string, unknown> = {
    id: r.entry.id,
    fetchId: o.fetchId,
    status: r.entry.status,
    statusText: str(resp, "statusText") ?? "",
    mime: r.entry.mime,
    bytes: bytes?.length ?? 0,
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
      const f = exportBody({ id: r.entry.id, url: r.entry.url, bytes, mime: r.entry.mime, resourceType: r.entry.type, charset, scrub, pretty: false, where: { bundle: rec.dir } });
      data["bodyFile"] = f["file"];
      if (o.spec.rawBody) data["note"] = `rawBody: the body is over ${RAW_BODY_MAX} bytes, so it went to bodyFile`;
    }
  }
  data["timing"] = envelopeTiming(r.event);
  data["waitedMs"] = o.waitedMs;
  return { data, status: r.entry.status, bytes: bytes?.length ?? 0, text };
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

/** Run the helper in a fresh isolated world of the tab's main frame. */
async function runHelper(t: Transport, tab: Tab, reg: FetchReg, spec: FetchSpec, target: URL, budgetMs: number): Promise<HelperResult> {
  const sid = tab.sessionId;
  const w = await t.send("Page.createIsolatedWorld", { frameId: tab.targetId, worldName: "tabcap-fetch", grantUniveralAccess: false }, sid, 5000);
  const ctx = num(w, "executionContextId");
  if (ctx === null) throw new TabcapError("cdp", "Page.createIsolatedWorld returned no context", "Retry; if the tab is still loading, wait for it first.");
  const src = helperSource(reg.fnName, { url: target.href, method: spec.method, headers: spec.headers, body: spec.body, credentials: spec.credentials, marker: reg.marker, timeoutMs: Math.max(1, budgetMs) });
  const c = await t.send("Runtime.compileScript", { expression: src, sourceURL: "", persistScript: true, executionContextId: ctx }, sid, 5000);
  const scriptId = str(c, "scriptId");
  if (scriptId === null) throw new TabcapError("internal", "the fetch helper did not compile", "This is a bug; rerun with TABCAP_LOG=debug and report the output.");
  reg.scriptId = scriptId;
  const r = await t.send("Runtime.runScript", { scriptId, executionContextId: ctx, awaitPromise: true, returnByValue: true }, sid, budgetMs + 5000);
  const res = isRecord(r["result"]) ? helperResultOf(r["result"]["value"]) : null;
  if (res === null) {
    const ex = isRecord(r["exceptionDetails"]) ? str(r["exceptionDetails"], "text") : null;
    throw new TabcapError("page", `the fetch helper failed in the page${ex === null ? "" : `: ${ex.slice(0, 300)}`}`, "Check the tab (`tabcap screenshot`); a page that is still loading or crashed cannot fetch.");
  }
  return res;
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

/** One fetch; `k` numbers it inside its command (`c-N:f-K`). */
export async function fetchOne(d: Daemon, b: FetchBrowser, a: Args, session: string, cmd: string | null, k: number): Promise<Record<string, unknown>> {
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
  try {
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
    // 0.6-I: a site stop rule fired on this very response (the guard already stopped the site and the session waits).
    const site = d.guard.stopRuleHit(session, recorded.entry.id);
    if (site !== null) {
      throw new TabcapError(
        "fetch.stopped",
        `site stop rule ${site.rule} fired on ${recorded.entry.id} (${site.detail}); the session waits and fetches on ${site.site} are refused from now on`,
        STOP_RULE_NEXT({ site: site.site, request: recorded.entry.id }),
        { site: site.site, reason: "stop-rule", rule: site.rule, detail: site.detail, request: recorded.entry.id, fetchId, result: { ...env.data, stopped: { rule: site.rule, detail: site.detail } } },
      );
    }
    const hit = firstStop(rules, { status: env.status, bytes: env.bytes, text: env.text });
    if (hit === null) return env.data;
    const data = { ...env.data, stopped: hit };
    d.guard.stopFetch(
      rec,
      { site: where.key, session, rule: hit.rule, detail: hit.detail, request: recorded.entry.id, fetchId, url: target.href, status: env.status, since: Date.now(), reason: "fetch-stop" },
      { tab: tab.id, account: bound !== null && bound.site === where.site ? bound.account : null },
    );
    throw new TabcapError("fetch.stopped", `stop rule ${hit.rule} fired on ${recorded.entry.id} (${hit.detail}); fetches on ${where.key} are refused from now on`, `Look at the response (\`tabcap net body ${recorded.entry.id}\`); continue only when the human (or you, after checking) decides to: \`tabcap guard resume --site ${where.key}\`.`, {
      site: where.key,
      rule: hit.rule,
      detail: hit.detail,
      request: recorded.entry.id,
      fetchId,
      result: data,
    });
  } finally {
    releaseOverride?.();
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
  if (a["batch"] === undefined || a["batch"] === null) parseFetchSpec(a);
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
      parseFetchSpec(x);
    } catch (e) {
      throw e instanceof TabcapError ? new TabcapError(e.code, `batch line ${i + 1}: ${e.message}`, e.next) : e;
    }
  });
  const out: Envelope<unknown>[] = [];
  for (let i = 0; i < batch.length; i++) {
    const line: unknown = batch[i];
    try {
      out.push({ ok: true, data: await fetchOne(d, b, isRecord(line) ? line : {}, session, ctx.cmd, i + 1) });
    } catch (e) {
      out.push(scrubFail(d, toFail(e)));
      log.debug("fetch: batch line failed", { line: i + 1 });
    }
  }
  return { batch: out, count: out.length, failed: out.filter((x) => !x.ok).length };
}

function scrubFail(d: Daemon, env: Envelope<unknown>): Envelope<unknown> {
  return env.ok ? env : { ok: false, error: { ...env.error, message: d.secrets.scrub(env.error.message) } };
}
