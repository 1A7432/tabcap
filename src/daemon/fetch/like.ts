// docs/04 §53.8 (11-12): `tabcap fetch --like r-N` — send a recorded request
// again from a tab, with its authentication taken fresh. Pure parts: which
// recorded headers a page fetch() can resend, which ones are authentication
// (bundle/redact.ts isSensitiveHeaderName, cookies aside: the browser sends
// those), the query edits, and the `--header-from-storage` templates
// (`{local:k}`, `{session:k}`, `{local:@session:k}` = localStorage[sessionStorage[k]]).
// The recorded event is untrusted JSON.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, str } from "../../shared/json.ts";
import { isSensitiveHeaderName } from "../../bundle/redact.ts";
import { FETCH_MARKER } from "./spec.ts";

const USAGE = "tabcap fetch --like <r-N> [--json …|--body …|--form …] [--query k=v]… [--header k:v]… [--header-from-storage 'Name=… {local:key} …']… [--tab t2]";
const usage = (msg: string) => new TabcapError("usage", msg, `Usage: ${USAGE}`);

/** Headers fetch() may not set (Fetch Standard forbidden request headers) or that only describe the old request. */
const NOT_RESENT = /^(:.*|accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|user-agent|via|proxy-.*|sec-.*)$/i;

/** An authentication header taken fresh from the sending tab (cookies stay with the browser). */
export const isAuthHeader = (name: string): boolean => name.toLowerCase() !== "cookie" && name.toLowerCase() !== "cookie2" && isSensitiveHeaderName(name);

/** The request headers of a recorded event a page fetch() can send again, in recorded order (repeated values joined). */
export function resendHeaders(raw: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (NOT_RESENT.test(k) || k.toLowerCase() === FETCH_MARKER) continue;
    const val = typeof v === "string" ? v : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(", ") : null;
    if (val === null || /[\r\n\0]/.test(val)) continue;
    out.push([k, val]);
  }
  return out;
}

/** Replace (case-insensitively) or add headers. */
export function withHeaders(base: Array<[string, string]>, over: Array<[string, string]>): Array<[string, string]> {
  const out = [...base];
  for (const [k, v] of over) {
    const i = out.findIndex(([n]) => n.toLowerCase() === k.toLowerCase());
    if (i >= 0) out[i] = [out[i]?.[0] ?? k, v];
    else out.push([k, v]);
  }
  return out;
}

/** `--query k=v` (set; `k=` removes) applied to a URL. */
export function withQuery(url: string, pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of pairs) {
    if (v === "") u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.href;
}

/** `k=v` → [k, v]. */
export function queryPair(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw usage(`--query ${JSON.stringify(s.slice(0, 100))}: expected key=value (key= removes it)`);
  return [s.slice(0, i), s.slice(i + 1)];
}

/** A storage read of a template: a key, read from localStorage or sessionStorage, or localStorage at the key sessionStorage holds. */
export type StorageRead = { store: "local" | "session"; key: string; via: "session" | null };
export type StorageTemplate = { name: string; parts: Array<string | StorageRead> };

const KEY = /^[^{}]{1,256}$/;

/** `Name=text {local:k} {session:k} {local:@session:k} …` → its parts; a usage error otherwise. */
export function parseStorageTemplate(s: string): StorageTemplate {
  const eq = s.indexOf("=");
  const name = eq > 0 ? s.slice(0, eq).trim() : "";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name)) throw usage(`--header-from-storage ${JSON.stringify(s.slice(0, 100))}: expected Name=template, e.g. 'Authorization=Bearer {local:@session:singleId}'`);
  const body = s.slice(eq + 1);
  const parts: StorageTemplate["parts"] = [];
  const re = /\{(local|session):(@session:)?([^{}]*)\}/g;
  let at = 0;
  let reads = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (m.index > at) parts.push(body.slice(at, m.index));
    const key = m[3] ?? "";
    if (!KEY.test(key)) throw usage(`--header-from-storage ${name}: empty or too long key in ${JSON.stringify(m[0].slice(0, 100))}`);
    if (m[1] === "session" && m[2] !== undefined) throw usage(`--header-from-storage ${name}: {session:@session:…} is not a read; use {local:@session:key}`);
    parts.push({ store: m[1] === "session" ? "session" : "local", key, via: m[2] === undefined ? null : "session" });
    reads++;
    at = m.index + m[0].length;
  }
  if (at < body.length) parts.push(body.slice(at));
  if (reads === 0) throw usage(`--header-from-storage ${name}: the template reads nothing; use {local:key}, {session:key} or {local:@session:key}`);
  if (parts.some((p) => typeof p === "string" && /[{}\r\n\0]/.test(p))) throw usage(`--header-from-storage ${name}: stray brace or line break in the template`);
  return { name, parts };
}

/** Isolated-world function: the values of `reads` from the page's storage, or the first missing key. */
export const STORAGE_FN = `function (reads) {
  const out = [];
  for (const r of reads) {
    let key = r.key;
    if (r.via === "session") {
      const k = sessionStorage.getItem(key);
      if (k === null) return { missing: "sessionStorage[" + JSON.stringify(key) + "]" };
      key = k;
    }
    const v = (r.store === "session" ? sessionStorage : localStorage).getItem(key);
    if (v === null) return { missing: (r.store === "session" ? "sessionStorage" : "localStorage") + "[" + JSON.stringify(key) + "]" };
    out.push(v);
  }
  return { values: out };
}`;

/** Fill a template with the values STORAGE_FN read (in order). */
export function fillTemplate(t: StorageTemplate, values: readonly string[]): string {
  let i = 0;
  return t.parts.map((p) => (typeof p === "string" ? p : (values[i++] ?? ""))).join("");
}

/** The recorded request a --like reads: method, URL, headers, body text (null: none or not stored). */
export type LikeSource = { id: string; tab: string | null; method: string; url: string; headers: unknown; body: string | null; bodyMissing: boolean };

/** Pure: a recorded `request` event → its LikeSource; `readBlob` gives a stored postData blob's text. */
export function likeSource(ev: Record<string, unknown>, readBlob: (blob: string) => string | null): LikeSource | null {
  const id = str(ev, "id");
  const url = str(ev, "url");
  const method = str(ev, "method");
  if (id === null || url === null || method === null) return null;
  const req = isRecord(ev["request"]) ? ev["request"] : {};
  const pd = isRecord(req["postData"]) ? req["postData"] : null;
  let body: string | null = null;
  let missing = isRecord(req["postDataMissing"]);
  if (pd !== null && typeof pd["inline"] === "string") body = pd["inline"];
  else if (pd !== null && typeof pd["blob"] === "string") {
    body = readBlob(pd["blob"]);
    if (body === null) missing = true;
  }
  return { id, tab: str(ev, "tab"), method, url, headers: req["headers"], body, bodyMissing: missing && body === null };
}
