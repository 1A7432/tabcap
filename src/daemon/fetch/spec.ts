// The request a `tabcap fetch` sends (0.6-A). One shape for the CLI and the
// daemon's `POST /fetch` endpoint: {url, method?, headers?, body?|json?|form?,
// credentials?, tab?, timeoutMs?, stopOn?, endOn?, out?, rawBody?, reveal?}. Everything here is untrusted
// JSON (a script on the machine sends it): malformed input is a usage error,
// never a crash.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, oneOf } from "../../shared/json.ts";

/** The request header the in-tab helper adds on same-origin fetches; the recorder removes it before the request leaves Chrome. */
export const FETCH_MARKER = "x-tabcap-fetch";
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_TIMEOUT_MS = 600_000;
const MAX_HEADERS = 100;
const MAX_URL = 8192;
/** Request bodies are text; 16 MB is far above what a page posts. */
export const MAX_REQUEST_BODY = 16 * 1024 * 1024;
/** 0.6-P: the page fetch()'s `credentials` option (Fetch Standard, RequestCredentials); default include. */
export const FETCH_CREDENTIALS = ["include", "same-origin", "omit"] as const;
export type FetchCredentials = (typeof FETCH_CREDENTIALS)[number];
export const DEFAULT_FETCH_CREDENTIALS: FetchCredentials = "include";

export const FETCH_USAGE =
  "tabcap fetch <url> [--method M] [--header k:v]... [--body <text>|@<file>] [--json <text>|@<file>] [--form k=v]... [--credentials include|same-origin|omit] [--stop-on rule]... [--end-on rule]... [--out file] [--tab t2] [--timeout ms] | tabcap fetch --batch <file.jsonl>";

export type FetchSpec = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | null;
  /** 0.6-P: fetch()'s credentials mode; omit sends no cookies (for APIs that answer `Access-Control-Allow-Origin: *`). */
  credentials: FetchCredentials;
  tab: string | null;
  timeoutMs: number;
  stopOn: string[];
  /** 0.7.5-A: end rules ("the list has ended", docs/04 §38), checked before every stop rule. */
  endOn: string[];
  out: string | null;
  rawBody: boolean;
  /** 0.6-E: print sensitive response header values as they are (docs/04 §8.3); default <redacted:name>. */
  reveal: boolean;
};

const usage = (msg: string) => new TabcapError("usage", msg, `Usage: ${FETCH_USAGE}`);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

function headerPairs(v: unknown, what: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (k: unknown, val: unknown) => {
    if (typeof k !== "string" || !TOKEN.test(k)) throw usage(`${what}: bad header name ${JSON.stringify(String(k).slice(0, 100))}`);
    if (typeof val !== "string" || /[\r\n\0]/.test(val) || val.length > 16_384) throw usage(`${what}: the value of ${k} must be a single-line string (at most 16384 chars)`);
    if (k.toLowerCase() === FETCH_MARKER) throw usage(`${what}: ${FETCH_MARKER} is tabcap's own marker header`);
    out.push([k, val]);
  };
  if (v === undefined || v === null) return out;
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2) throw usage(`${what} must be an object {name: value} or a list of [name, value] pairs`);
      add(p[0], p[1]);
    }
  } else if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) add(k, val);
  } else throw usage(`${what} must be an object {name: value} or a list of [name, value] pairs`);
  if (out.length > MAX_HEADERS) throw usage(`${what}: at most ${MAX_HEADERS} headers`);
  return out;
}

function formPairs(v: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (k: unknown, val: unknown) => {
    if (typeof k !== "string" || k === "") throw usage("form: field names must be non-empty strings");
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") throw usage(`form: the value of ${k.slice(0, 100)} must be a string`);
    out.push([k, String(val)]);
  };
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2) throw usage("form must be an object {field: value} or a list of [field, value] pairs");
      add(p[0], p[1]);
    }
  } else if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) add(k, val);
  } else throw usage("form must be an object {field: value} or a list of [field, value] pairs");
  return out;
}

const has = (a: Record<string, unknown>, k: string) => Object.hasOwn(a, k) && a[k] !== undefined;

/** Validate one request (CLI args or an endpoint body); throws `usage`. */
export function parseFetchSpec(a: unknown): FetchSpec {
  if (!isRecord(a)) throw usage("the request must be a JSON object");
  const url = a["url"];
  if (typeof url !== "string" || url.trim() === "") throw usage("missing url");
  if (url.length > MAX_URL) throw usage(`url is longer than ${MAX_URL} characters`);
  const m = a["method"];
  if (m !== undefined && m !== null && (typeof m !== "string" || !/^[A-Za-z]{1,16}$/.test(m))) throw usage("method must be an HTTP method name (letters only)");
  const method = typeof m === "string" ? m.toUpperCase() : "GET";
  if (["CONNECT", "TRACE", "TRACK"].includes(method)) throw usage(`fetch() does not send ${method} requests`);
  const headers = headerPairs(a["headers"], "headers");
  const kinds = ["body", "json", "form"].filter((k) => has(a, k));
  if (kinds.length > 1) throw usage(`give one of body / json / form, not ${kinds.join(" and ")}`);
  let body: string | null = null;
  const lower = new Set(headers.map(([k]) => k.toLowerCase()));
  if (has(a, "body")) {
    const b = a["body"];
    if (typeof b !== "string") throw usage("body must be a string (text); use json for a JSON value");
    body = b;
  } else if (has(a, "json")) {
    const text = JSON.stringify(a["json"]);
    if (text === undefined) throw usage("json must be a JSON value");
    body = text;
    if (!lower.has("content-type")) headers.push(["content-type", "application/json"]);
  } else if (has(a, "form")) {
    body = new URLSearchParams(formPairs(a["form"])).toString();
    if (!lower.has("content-type")) headers.push(["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]);
  }
  if (body !== null && body.length > MAX_REQUEST_BODY) throw usage(`the request body is over ${MAX_REQUEST_BODY} characters`);
  if (body !== null && (method === "GET" || method === "HEAD")) throw usage(`a ${method} request has no body; add --method POST (or PUT, PATCH …)`);
  const cr = a["credentials"];
  if (cr !== undefined && cr !== null && (typeof cr !== "string" || !oneOf(FETCH_CREDENTIALS, cr))) throw usage(`credentials must be one of ${FETCH_CREDENTIALS.join(", ")}`);
  const credentials: FetchCredentials = typeof cr === "string" && oneOf(FETCH_CREDENTIALS, cr) ? cr : DEFAULT_FETCH_CREDENTIALS;
  const tab = a["tab"];
  if (tab !== undefined && tab !== null && (typeof tab !== "string" || !/^t\d{1,6}$/.test(tab))) throw usage("tab must be a tab id like t2");
  const t = a["timeoutMs"];
  if (t !== undefined && t !== null && (typeof t !== "number" || !Number.isFinite(t) || t < 1 || t > MAX_FETCH_TIMEOUT_MS)) throw usage(`timeoutMs must be a number of ms between 1 and ${MAX_FETCH_TIMEOUT_MS}`);
  const stopOn = ruleList(a["stopOn"], "stopOn", "stop");
  const endOn = ruleList(a["endOn"], "endOn", "end");
  const out = a["out"];
  if (out !== undefined && out !== null && (typeof out !== "string" || out === "")) throw usage("out must be a file path");
  const raw = a["rawBody"];
  if (raw !== undefined && raw !== null && typeof raw !== "boolean") throw usage("rawBody must be true or false");
  if (raw === true && typeof out === "string") throw usage("rawBody and out exclude each other: the body comes back inline, or goes to the file");
  const reveal = a["reveal"];
  if (reveal !== undefined && reveal !== null && typeof reveal !== "boolean") throw usage("reveal must be true or false");
  return {
    url: url.trim(),
    method,
    headers,
    body,
    credentials,
    tab: typeof tab === "string" ? tab : null,
    timeoutMs: typeof t === "number" ? Math.round(t) : DEFAULT_FETCH_TIMEOUT_MS,
    stopOn,
    endOn,
    out: typeof out === "string" ? out : null,
    rawBody: raw === true,
    reveal: reveal === true,
  };
}

/** `stopOn` / `endOn`: a rule string or a list of them, at most 32 (the syntax is checked when the fetch runs). */
function ruleList(v: unknown, key: string, what: string): string[] {
  if (v === undefined || v === null) return [];
  let list: string[];
  if (typeof v === "string") list = [v];
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) list = v.filter((x): x is string => typeof x === "string");
  else throw usage(`${key} must be a rule string or a list of them`);
  if (list.length > 32) throw usage(`at most 32 ${what} rules`);
  return list;
}

/** The target URL, resolved against the tab's page (relative URLs allowed); http(s) only. */
export function targetUrl(url: string, base: string): URL {
  let u: URL;
  try {
    u = new URL(url, base === "" || base === "about:blank" ? undefined : base);
  } catch {
    throw usage(`not a URL: ${url.slice(0, 300)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw usage(`only http(s) URLs can be fetched, not ${u.protocol}`);
  u.hash = "";
  return u;
}
