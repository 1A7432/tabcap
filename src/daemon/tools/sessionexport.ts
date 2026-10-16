// 0.6-F `tabcap session export --for requests|httpx|playwright --out <file>
// [--origin <url>] [--tab t2]`: hand the logged-in tab's session to a script.
// The file holds live credentials by design (like `replay session`): it is
// written 0600 (new directories 0700) and no value is ever printed; the
// answer carries the path, counts and header names only.
// What goes in:
//   - cookies: Network.getCookies for the export origin (its root URL and the
//     tab's URL when it is on that origin), plus Storage.getCookies of the
//     session's own browser context when it has one (a pool account, 0.4-D);
//   - headers: from the most recent recorded request (open or last finished
//     recording of this session) to the origin's host that carries a selected
//     header (else the most recent one, which then gives none): every header
//     that is sensitive (the `bundle redact` header rule, x-csrf* / x-xsrf*,
//     *-token, *-auth*, api-key) or that the page set itself, i.e. not a
//     header the browser adds (BROWSER_HEADERS); cookie goes in `cookies`,
//     proxy-* (the pool proxy's credentials) and pseudo-headers never;
//   - storage: localStorage and sessionStorage, read in tabcap's isolated
//     world of the tab's frame on that origin; values over 64 KB are skipped
//     and listed (key, size).
// Formats: `requests` = JSON schema tabcap-session-export/0; `httpx` = a
// Python module <file>.py (cookies / headers / storage dicts, client());
// `playwright` = the `replay session` storageState (cookies, localStorage),
// which has no place for headers or sessionStorage (reported as omitted).
// Oracle: CDP Network.getCookies / Storage.getCookies (Cookie objects), the
// recorded `request` events (docs/04 §5.1), Playwright storageState; the e2e
// test/e2e/v06f.e2e.test.ts checks the file against the range's journal.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { EVENTS_FILE, writeFileAtomic } from "../../bundle/manifest.ts";
import { isSensitiveHeader } from "../../bundle/redact.ts";
import type { Headers } from "../../bundle/types.ts";
import { BROWSER_HEADERS, BROWSER_PREFIXES, headerJoined } from "../../replay/common.ts";
import { pyStr } from "../../replay/python.ts";
import { toStorageCookie, type StorageCookie, type StorageState } from "../../replay/session.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, oneOf, str } from "../../shared/json.ts";
import { cookieArray, stateOrigin } from "../capture/cookies.ts";
import { rawFrames, type RawFrame } from "../browser/frames.ts";
import type { Tab } from "../browser/targets.ts";
import { inWorld } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import { timeoutOf } from "./navigate.ts";
import { callResult, settle } from "./snapshot.ts";
import { optStr, type Args } from "./args.ts";

export const EXPORT_SCHEMA = "tabcap-session-export/0";
export const EXPORT_FORMATS = ["requests", "httpx", "playwright"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Storage values (UTF-8 bytes) above this are skipped and listed. */
export const STORAGE_VALUE_MAX = 64 * 1024;
const USAGE = "tabcap session export --for requests|httpx|playwright --out <file> [--origin <url>] [--tab t2]";
const LIVE_NOTE = "live session credentials: keep this file out of the repository and do not share it; it expires with the session";

// ------------------------------------------------------------ headers

const SENSITIVE_EXTRA = /^(x-csrf|x-xsrf)|-token$|-auth|(^|-)api-key$/;

export type HeaderClass = "cookie" | "proxy" | "browser" | "sensitive" | "page";

/** Why a recorded request header is (sensitive, page) or is not (cookie, proxy, browser) exported. */
export function headerClass(raw: string): HeaderClass {
  const n = raw.toLowerCase();
  if (n === "cookie" || n === "set-cookie") return "cookie";
  // The pool proxy's credentials (0.4-D) are the daemon's, not the page's.
  if (n.startsWith("proxy-")) return "proxy";
  if (BROWSER_PREFIXES.some((p) => n.startsWith(p))) return "browser";
  if (isSensitiveHeader(n) || SENSITIVE_EXTRA.test(n)) return "sensitive";
  if (BROWSER_HEADERS.has(n)) return "browser";
  return "page";
}

/** The exported headers of one recorded request: lowercase names, repeated values joined with ", ". */
export function selectHeaders(h: unknown): Record<string, string> {
  if (!isRecord(h)) return {};
  const out = new Map<string, string>();
  const hs: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") hs[k.toLowerCase()] = v;
    else if (Array.isArray(v)) hs[k.toLowerCase()] = v.filter((x): x is string => typeof x === "string");
  }
  for (const name of Object.keys(hs).sort()) {
    const c = headerClass(name);
    if (c !== "sensitive" && c !== "page") continue;
    const v = headerJoined(hs, name);
    if (v !== null) out.set(name, v);
  }
  return Object.fromEntries(out);
}

export type HeaderSource = { id: string; url: string; headers: Record<string, string> };

/**
 * The request the headers come from: the most recent `request` event to
 * `host` (URL host, port included) that carries a selected header, else the
 * most recent one to that host (no headers); null when none was recorded.
 * `lines`: events.jsonl, untrusted (bad lines are skipped).
 */
export function headerSource(lines: Iterable<string>, host: string): HeaderSource | null {
  let lastAny: HeaderSource | null = null;
  let lastWith: HeaderSource | null = null;
  for (const line of lines) {
    if (!line.includes('"kind":"request"')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a torn last line while recording
    }
    if (!isRecord(ev) || ev["kind"] !== "request") continue;
    const id = str(ev, "id");
    const url = str(ev, "url");
    if (id === null || url === null || hostOf(url) !== host) continue;
    const req = isRecord(ev["request"]) ? ev["request"] : {};
    const s = { id, url, headers: selectHeaders(req["headers"]) };
    lastAny = s;
    if (Object.keys(s.headers).length > 0) lastWith = s;
  }
  return lastWith ?? (lastAny === null ? null : { ...lastAny, headers: {} });
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ storage

export type StorageRead = { items: Record<string, string>; skipped: { key: string; bytes: number }[]; error: string | null };

const enc = new TextEncoder();
const cut = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One storage area from the page function's answer (untrusted):
 * {items: [[key, value|null, bytes]], error?}. Values over `max` UTF-8 bytes
 * are skipped whatever the page said; so are keys over `max`.
 */
export function storageOf(v: unknown, max = STORAGE_VALUE_MAX): StorageRead {
  if (!isRecord(v)) return { items: {}, skipped: [], error: "no answer" };
  const err = str(v, "error");
  if (err !== null) return { items: {}, skipped: [], error: cut(err) };
  const items = new Map<string, string>();
  const skipped: StorageRead["skipped"] = [];
  const list = Array.isArray(v["items"]) ? v["items"] : [];
  for (const it of list) {
    if (!Array.isArray(it) || typeof it[0] !== "string") continue;
    const key = it[0];
    const value: unknown = it[1];
    const claimed = typeof it[2] === "number" && Number.isFinite(it[2]) ? it[2] : 0;
    const keyBytes = enc.encode(key).length;
    if (typeof value === "string") {
      const bytes = enc.encode(value).length;
      if (bytes > max || keyBytes > max) skipped.push({ key: cut(key), bytes: Math.max(bytes, keyBytes) });
      else items.set(key, value);
    } else if (value === null && claimed > max) {
      skipped.push({ key: cut(key), bytes: claimed });
    }
  }
  return { items: Object.fromEntries(items), skipped, error: null };
}

/**
 * Runs in tabcap's isolated world (same origin, DOM storage shared with the
 * page, none of the page's JavaScript). Values longer than `max` UTF-16 units
 * are over `max` bytes too and are not sent.
 */
const STORAGE_FN = `function (max) {
  const enc = new TextEncoder();
  const read = (name) => {
    let s;
    try { s = name === "localStorage" ? window.localStorage : window.sessionStorage; } catch (e) { return { error: String((e && e.name) || e) }; }
    if (s === null || s === undefined) return { error: "unavailable" };
    const items = [];
    try {
      const n = s.length;
      for (let i = 0; i < n; i++) {
        const k = s.key(i);
        if (k === null) continue;
        const v = s.getItem(k);
        if (v === null) continue;
        if (v.length > max) { items.push([k, null, v.length]); continue; }
        const bytes = enc.encode(v).length;
        items.push(bytes > max ? [k, null, bytes] : [k, v, bytes]);
      }
    } catch (e) { return { error: String((e && e.name) || e) }; }
    return { items };
  };
  return { localStorage: read("localStorage"), sessionStorage: read("sessionStorage") };
}`;

// ------------------------------------------------------------ cookies

/** Cookies of several CDP answers, later ones winning on name + domain + path; unusable ones dropped. */
export function mergeCookies(lists: readonly unknown[][]): StorageCookie[] {
  const jar = new Map<string, StorageCookie>();
  for (const list of lists) {
    for (const c of list) {
      const sc = toStorageCookie(c);
      if (typeof sc !== "string") jar.set(`${sc.name}\t${sc.domain}\t${sc.path}`, sc);
    }
  }
  return [...jar.values()];
}

// ------------------------------------------------------------ rendering

export type SessionData = {
  origin: string;
  capturedAt: number;
  cookies: StorageCookie[];
  headers: Record<string, string>;
  storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
  source: { headers: string };
};

export function noteOf(s: SessionData): string {
  const h = s.source.headers === "none" ? "no recorded request to this origin's host: headers are empty (run `tabcap net start` first and let the page make its requests)" : `headers from recorded request ${s.source.headers}`;
  return `${LIVE_NOTE}; ${h}`;
}

/** `--for requests`: the JSON document (schema tabcap-session-export/0). */
export function renderRequests(s: SessionData): string {
  return (
    JSON.stringify(
      {
        schema: EXPORT_SCHEMA,
        origin: s.origin,
        capturedAt: s.capturedAt,
        cookies: s.cookies,
        headers: s.headers,
        storage: s.storage,
        note: noteOf(s),
      },
      null,
      2,
    ) + "\n"
  );
}

/** `--for playwright`: Playwright storageState (as `replay session` writes it). */
export function renderPlaywright(s: SessionData): string {
  const ls = Object.entries(s.storage.localStorage).map(([name, value]) => ({ name, value }));
  const state: StorageState = { cookies: s.cookies, origins: ls.length === 0 ? [] : [{ origin: s.origin, localStorage: ls }] };
  return JSON.stringify(state, null, 2) + "\n";
}

const pyDict = (o: Record<string, string>, indent = "    "): string => {
  const e = Object.entries(o);
  return e.length === 0 ? "{}" : `{\n${e.map(([k, v]) => `${indent}${pyStr(k)}: ${pyStr(v)},`).join("\n")}\n${indent.slice(4)}}`;
};
const pyBool = (b: boolean) => (b ? "True" : "False");
/** Comment-safe text (origins come from the page): printable ASCII without quotes or backslashes. */
const commentSafe = (s: string) => s.replace(/[^\x20-\x7e]|["'\\]/g, "_").slice(0, 200);

/** `--for httpx`: a standalone Python module (httpx only, no tabcap at runtime). */
export function renderHttpx(s: SessionData): string {
  const records = s.cookies.map(
    (c) =>
      `    {"name": ${pyStr(c.name)}, "value": ${pyStr(c.value)}, "domain": ${pyStr(c.domain)}, "path": ${pyStr(c.path)}, "expires": ${String(c.expires)}, "httpOnly": ${pyBool(c.httpOnly)}, "secure": ${pyBool(c.secure)}, "sameSite": ${pyStr(c.sameSite)}},`,
  );
  const byName = new Map<string, string>();
  for (const c of s.cookies) byName.set(c.name, c.value);
  return [
    `# Generated by tabcap session export --for httpx (${EXPORT_SCHEMA}) for ${commentSafe(s.origin)}.`,
    "# LIVE session credentials (cookies, authentication headers, web storage): keep this file",
    "# out of the repository and do not share it; it expires with the session. Mode 0600.",
    `"""Session of ${commentSafe(s.origin)} exported by tabcap: \`client()\` returns an httpx.Client that sends it."""`,
    "",
    "from __future__ import annotations",
    "",
    "from typing import Any",
    "",
    "import httpx",
    "",
    `ORIGIN = ${pyStr(s.origin)}`,
    `CAPTURED_AT = ${String(s.capturedAt)}  # ms since the epoch`,
    `HEADERS_FROM = ${pyStr(s.source.headers)}  # recorded request id, or "none"`,
    "",
    "# name -> value (a name set on several domains / paths: the last one; COOKIE_RECORDS has them all)",
    `cookies: dict[str, str] = ${pyDict(Object.fromEntries(byName))}`,
    "",
    `COOKIE_RECORDS: list[dict[str, Any]] = ${records.length === 0 ? "[]" : `[\n${records.join("\n")}\n]`}`,
    "",
    `headers: dict[str, str] = ${pyDict(s.headers)}`,
    "",
    "storage: dict[str, dict[str, str]] = {",
    `    "localStorage": ${pyDict(s.storage.localStorage, "        ")},`,
    `    "sessionStorage": ${pyDict(s.storage.sessionStorage, "        ")},`,
    "}",
    "",
    "",
    "def cookie_jar() -> httpx.Cookies:",
    '    """The cookies with their domains and paths, so they only go where the browser would send them."""',
    "    jar = httpx.Cookies()",
    "    for c in COOKIE_RECORDS:",
    '        domain = c["domain"]',
    '        # http.cookiejar matches a dotless host (localhost) as "<host>.local"',
    '        if "." not in domain.lstrip("."):',
    '            domain += ".local"',
    '        jar.set(c["name"], c["value"], domain=domain, path=c["path"] or "/")',
    "    return jar",
    "",
    "",
    "def client(base_url: str = ORIGIN, **kwargs: Any) -> httpx.Client:",
    '    """An httpx.Client with the session\'s cookies and headers; kwargs go to httpx.Client."""',
    "    return httpx.Client(base_url=base_url, cookies=cookie_jar(), headers=dict(headers), **kwargs)",
    "",
  ].join("\n");
}

/** Where the file goes: `--out` as given; `--for httpx` adds `.py` when it is missing. */
export function exportPath(out: string, fmt: ExportFormat): string {
  const p = resolve(out);
  return fmt === "httpx" && !p.endsWith(".py") ? `${p}.py` : p;
}

/** Write a credentials file: 0600, new parent directories 0700; an existing directory at the path is refused. */
export function writeSecretFile(path: string, text: string): void {
  if (existsSync(path) && statSync(path).isDirectory()) throw new TabcapError("usage", `--out ${path} is a directory`, "Give a file path, e.g. --out ./session.json.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, text, 0o600);
  chmodSync(path, 0o600);
}

/** Envelope of a written export: the path, counts and header names, never a value. */
export function exportSummary(fmt: ExportFormat, file: string, s: SessionData, skipped: { storage: string; key: string; bytes: number }[], notes: string[]): Record<string, unknown> {
  const ls = Object.keys(s.storage.localStorage).length;
  const ss = Object.keys(s.storage.sessionStorage).length;
  const names = Object.keys(s.headers);
  const playwright = fmt === "playwright";
  const out: Record<string, unknown> = {
    file,
    for: fmt,
    origin: s.origin,
    mode: "0600",
    cookies: s.cookies.length,
    headers: playwright ? [] : names,
    storage: { localStorage: ls, sessionStorage: playwright ? 0 : ss },
    source: s.source,
  };
  if (playwright && (names.length > 0 || ss > 0)) out["omitted"] = { headers: names, sessionStorage: ss };
  if (skipped.length > 0) out["skipped"] = skipped;
  const all = [...notes];
  if (playwright && (names.length > 0 || ss > 0)) all.push("storageState has no place for headers or sessionStorage (see omitted); --for requests or httpx carries them");
  all.push(s.source.headers === "none" ? "no recorded request to this origin's host: headers are empty; run `tabcap net start` first and let the page make its requests" : `headers from recorded request ${s.source.headers}`);
  all.push(`the file holds ${LIVE_NOTE}`);
  out["note"] = all.join("; ");
  return out;
}

// ------------------------------------------------------------ the tool

function originArg(raw: string): string {
  const o = stateOrigin(raw);
  if (o === null) throw new TabcapError("usage", `--origin ${cut(raw)} is not an http(s) URL`, "Give an origin such as --origin https://api.example.com (a frame of the tab must be on it).");
  return o;
}

/** The tab's frame on `origin` (the root document first). */
function frameOn(frames: readonly RawFrame[], origin: string): RawFrame | null {
  const on = frames.filter((f) => f.securityOrigin === origin || stateOrigin(f.url) === origin);
  return on.find((f) => f.parentId === null) ?? on[0] ?? null;
}

function recordedLines(dir: string): string[] {
  const file = join(dir, EVENTS_FILE);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
}

export async function sessionExport(d: Daemon, a: Args, session: string): Promise<unknown> {
  const fmtArg = optStr(a, "for");
  if (fmtArg === null || fmtArg === "") throw new TabcapError("usage", "missing --for", `Usage: ${USAGE}`);
  if (!oneOf(EXPORT_FORMATS, fmtArg)) throw new TabcapError("usage", `--for ${cut(fmtArg, 40)}?`, `--for is requests (JSON), httpx (a Python module) or playwright (storageState). Usage: ${USAGE}`);
  const fmt: ExportFormat = fmtArg;
  const outArg = optStr(a, "out");
  if (outArg === null || outArg === "") throw new TabcapError("usage", "missing --out", `Usage: ${USAGE}`);
  const file = exportPath(outArg, fmt);
  const originOpt = optStr(a, "origin");
  const { t, tabs } = d.need();
  const tab: Tab = tabs.pick(session, optStr(a, "tab"));
  const rec = d.recorders.get(session) ?? d.lastBundles.get(session) ?? null;
  const ctx = d.pool.contexts.get(session);
  return tabs.run(
    tab,
    async () => {
      await settle(tab, 10_000);
      const tabOrigin = stateOrigin(tab.url);
      const origin = originOpt !== null && originOpt !== "" ? originArg(originOpt) : tabOrigin;
      if (origin === null) throw new TabcapError("usage", `tab ${tab.id} is not on an http(s) page (${cut(tab.url)})`, "Navigate the tab to the logged-in site first, or pass --origin.");
      const frames = await rawFrames(t, tab);
      const frame = frameOn(frames, origin);
      if (frame === null) throw new TabcapError("not-found", `no frame of tab ${tab.id} is on ${origin}`, "--origin selects an origin the tab shows (its page or one of its frames); navigate there first.");

      const urls = [`${origin}/`, ...(stateOrigin(tab.url) === origin ? [tab.url] : []), ...(frame.url !== "" && stateOrigin(frame.url) === origin ? [frame.url] : [])];
      const lists: unknown[][] = [cookieArray(await t.send("Network.getCookies", { urls: [...new Set(urls)] }, tab.sessionId, 5000))];
      // 0.4-D: a pool account's own browser context holds the account's whole jar.
      if (ctx !== undefined) lists.push(cookieArray(await t.send("Storage.getCookies", { browserContextId: ctx.browserContextId }, null, 5000)));
      const cookies = mergeCookies(lists);

      const doc = { frameId: frame.frameId, loaderId: frame.loaderId, url: frame.url, sessionId: frame.sessionId };
      const r = await inWorld(t, tab, doc, (c) =>
        t.send("Runtime.callFunctionOn", { functionDeclaration: STORAGE_FN, executionContextId: c, arguments: [{ value: STORAGE_VALUE_MAX }], returnByValue: true }, frame.sessionId, 10_000),
      );
      const v = callResult(r);
      const ls = storageOf(isRecord(v) ? v["localStorage"] : null);
      const ss = storageOf(isRecord(v) ? v["sessionStorage"] : null);
      const notes: string[] = [];
      if (ls.error !== null) notes.push(`localStorage not readable: ${ls.error}`);
      if (ss.error !== null) notes.push(`sessionStorage not readable: ${ss.error}`);
      const skipped = [...ls.skipped.map((x) => ({ storage: "localStorage", ...x })), ...ss.skipped.map((x) => ({ storage: "sessionStorage", ...x }))];
      if (skipped.length > 0) notes.push(`${skipped.length} storage value(s) over ${STORAGE_VALUE_MAX / 1024} KB skipped (see skipped)`);

      let src: HeaderSource | null = null;
      if (rec !== null) {
        await rec.flushEvents();
        src = headerSource(recordedLines(rec.dir), new URL(origin).host);
      }
      const data: SessionData = {
        origin,
        capturedAt: Date.now(),
        cookies,
        headers: src?.headers ?? {},
        storage: { localStorage: ls.items, sessionStorage: ss.items },
        source: { headers: src === null ? "none" : src.id },
      };
      const text = fmt === "requests" ? renderRequests(data) : fmt === "httpx" ? renderHttpx(data) : renderPlaywright(data);
      writeSecretFile(file, text);
      if (fmt === "httpx" && !/^[A-Za-z_][A-Za-z0-9_]*\.py$/.test(basename(file))) notes.push(`${basename(file)} is not an importable module name; rename it (letters, digits, _) or load it with importlib`);
      return { tab: tab.id, ...exportSummary(fmt, file, data, skipped, notes) };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
