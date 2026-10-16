// The in-tab helper of `tabcap fetch` (0.6-A): one script per request,
// compiled into a tabcap isolated world (Page.createIsolatedWorld) of the
// tab's main frame, so the page's scripts cannot see or change it, while the
// request itself is the page's: same origin, same cookies (credentials:
// "include"), same CORS rules. Its function has a unique name per fetch: the
// recorder recognises cross-origin requests by that name (and the scriptId)
// on the initiator stack. Same-origin requests also carry the marker header,
// which the recorder removes at the Request stage.

import { isRecord } from "../../shared/json.ts";
import { FETCH_MARKER } from "./spec.ts";

export type HelperPayload = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | null;
  /** The fetchId to send as the marker header on a same-origin request, or null. */
  marker: string | null;
  timeoutMs: number;
};

/** What the helper resolves to (returned by value; untrusted like everything from the page). */
export type HelperResult =
  | { ok: true; status: number; type: string; redirected: boolean; url: string; bytes: number; marked: boolean }
  | { ok: false; aborted: boolean; error: string; marked: boolean };

/** The helper's source: an IIFE named `fnName` that calls fetch() synchronously (so the name is on the initiator stack). */
export function helperSource(fnName: string, p: HelperPayload): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(fnName)) throw new Error("bad helper function name");
  return [
    `(function ${fnName}() {`,
    `  const spec = ${JSON.stringify(p)};`,
    "  const headers = new Headers();",
    "  for (const [k, v] of spec.headers) headers.append(k, v);",
    "  let marked = false;",
    `  if (spec.marker !== null && new URL(spec.url, location.href).origin === location.origin) { headers.set(${JSON.stringify(FETCH_MARKER)}, spec.marker); marked = true; }`,
    "  const ac = new AbortController();",
    "  const timer = setTimeout(() => ac.abort(), spec.timeoutMs);",
    '  const init = { method: spec.method, headers, credentials: "include", redirect: "follow", signal: ac.signal };',
    "  if (spec.body !== null) init.body = spec.body;",
    "  const failed = (e) => { clearTimeout(timer); return { ok: false, aborted: ac.signal.aborted, error: String((e && e.message) || e).slice(0, 500), marked }; };",
    "  return fetch(spec.url, init)",
    "    .then((r) => r.arrayBuffer().then((b) => { clearTimeout(timer); return { ok: true, status: r.status, type: r.type, redirected: r.redirected, url: r.url, bytes: b.byteLength, marked }; }))",
    "    .catch(failed);",
    "})()",
  ].join("\n");
}

/** Validate what Runtime.runScript returned (by value). */
export function helperResultOf(v: unknown): HelperResult | null {
  if (!isRecord(v)) return null;
  const o = v;
  const marked = o["marked"] === true;
  if (o["ok"] === true && typeof o["status"] === "number") {
    return {
      ok: true,
      status: o["status"],
      type: typeof o["type"] === "string" ? o["type"] : "",
      redirected: o["redirected"] === true,
      url: typeof o["url"] === "string" ? o["url"] : "",
      bytes: typeof o["bytes"] === "number" ? o["bytes"] : 0,
      marked,
    };
  }
  if (o["ok"] === false) return { ok: false, aborted: o["aborted"] === true, error: typeof o["error"] === "string" ? o["error"].slice(0, 500) : "fetch failed", marked };
  return null;
}
