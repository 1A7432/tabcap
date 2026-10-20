// Evidence for protection identification from a recorded bundle (docs/04
// §41.3, offline): requests with their headers and status, cookie names (and
// values, only to check a shape) from Set-Cookie, Cookie and state snapshots,
// the recorded HTML documents for page markup (L2 dom / frame / script src —
// `global` cannot be judged offline), and trace `signal` events (L3).
// Untrusted input throughout: the HTML scan is linear and bounded, malformed
// events are skipped.

import type { Digest, DigestEl } from "../../daemon/adapters/detect.ts";
import { DIGEST_MAX } from "../../daemon/adapters/detect.ts";
import type { BundleReader } from "../../bundle/reader.ts";
import type { Headers, RequestEvent } from "../../bundle/types.ts";
import { isRecord, str } from "../../shared/json.ts";
import { cookiePairs } from "../diff.ts";
import { utf8 } from "../decoders.ts";
import type { Evidence, EvidenceRequest } from "./identify.ts";

/** Challenge rules read at most this much of a document body. */
export const BODY_CAP = 64 * 1024;
/** HTML scanned for markup, per document. */
const HTML_CAP = 2 * 1024 * 1024;
const POST_CAP = 16 * 1024;

/** Lower-cased names; repeated headers joined with a newline. */
export function flatHeaders(h: Headers | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    const val = Array.isArray(v) ? v.join("\n") : v;
    out[key] = out[key] === undefined ? val : `${out[key]}\n${val}`;
  }
  return out;
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * Pure: start tags of an HTML text as a digest (tag, id, class, every
 * attribute, no parent links), plus the `src` of scripts and iframes.
 * Not a parser: comments are skipped, script / style contents are not scanned.
 */
export function scanHtml(html: string): { digest: Digest; scripts: string[]; frames: string[] } {
  const text = html.length > HTML_CAP ? html.slice(0, HTML_CAP) : html;
  const els: DigestEl[] = [];
  const scripts: string[] = [];
  const frames: string[] = [];
  let total = 0;
  let truncated = false;
  const tag = /<!--[\s\S]*?-->|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    total++;
    const t = name.toLowerCase();
    const a: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let am: RegExpExecArray | null;
    const attrs = m[2] ?? "";
    while ((am = ATTR.exec(attrs)) !== null) {
      const k = (am[1] ?? "").toLowerCase();
      if (k === "" || k in a) continue;
      a[k] = (am[2] ?? am[3] ?? am[4] ?? "").slice(0, 256);
    }
    if ((t === "script" || t === "iframe") && a["src"] !== undefined && a["src"] !== "") (t === "script" ? scripts : frames).push(a["src"]);
    if (els.length < DIGEST_MAX) els.push({ t, id: (a["id"] ?? "").slice(0, 128), c: (a["class"] ?? "").slice(0, 400), a, p: -1 });
    else truncated = true;
    if (t === "script" || t === "style") {
      const close = text.toLowerCase().indexOf(`</${t}`, tag.lastIndex);
      if (close < 0) break;
      tag.lastIndex = close;
    }
  }
  return { digest: { els, total, truncated }, scripts, frames };
}

function absolute(u: string, base: string): string {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function postText(reader: BundleReader, r: RequestEvent): string | null {
  const p = r.request.postData;
  if (p === null || p === undefined) return null;
  if ("inline" in p) return p.inline.slice(0, POST_CAP);
  const bytes = reader.readBlob(p.blob);
  const t = bytes === null || bytes.length > POST_CAP * 4 ? null : utf8(bytes);
  return t === null ? null : t.slice(0, POST_CAP);
}

function bodyText(reader: BundleReader, r: RequestEvent, cap: number): string | null {
  const b = r.response?.body;
  if (b === null || b === undefined) return null;
  const bytes = reader.readBlob(b.blob);
  if (bytes === null) return null;
  return utf8(bytes.length > cap ? bytes.subarray(0, cap) : bytes);
}

const htmlType = (r: RequestEvent, h: Record<string, string>): boolean => r.type === "document" || /text\/html|application\/xhtml/i.test(h["content-type"] ?? r.response?.mimeType ?? "");

/** Everything a bundle can tell the identifier. `globals` stays null (needs the live page). */
export function evidenceFromBundle(reader: BundleReader): Evidence {
  const requests: EvidenceRequest[] = [];
  const cookies: NonNullable<Evidence["cookies"]> = [];
  const seenCookie = new Set<string>();
  const addCookie = (name: string, value: string | null, request: string | null) => {
    const key = `${name}\u0000${value ?? ""}`;
    if (name === "" || seenCookie.has(key) || cookies.length >= 2000) return;
    seenCookie.add(key);
    cookies.push({ name, value, request });
  };
  const resources: string[] = [];
  const frames: string[] = [];
  const els: DigestEl[] = [];
  let total = 0;
  let truncated = false;
  for (const r of reader.requests()) {
    const rh = flatHeaders(r.request.headers);
    const sh = flatHeaders(r.response?.headers);
    const html = htmlType(r, sh);
    requests.push({ id: r.id, url: r.url, method: r.method, type: r.type, status: r.response?.status ?? null, requestHeaders: rh, responseHeaders: sh, body: html ? bodyText(reader, r, BODY_CAP) : null, postData: postText(reader, r) });
    for (const v of (rh["cookie"] ?? "").split("\n")) for (const [n, val] of cookiePairs(v)) addCookie(n, val, r.id);
    for (const line of (sh["set-cookie"] ?? "").split("\n")) {
      const first = line.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) addCookie(first.slice(0, eq).trim(), first.slice(eq + 1).trim(), r.id);
    }
    if (r.type === "document" && html) {
      const doc = bodyText(reader, r, HTML_CAP);
      if (doc !== null) {
        const s = scanHtml(doc);
        for (const e of s.digest.els) if (els.length < DIGEST_MAX) els.push(e);
        total += s.digest.total;
        truncated = truncated || s.digest.truncated || els.length >= DIGEST_MAX;
        for (const u of s.scripts) resources.push(absolute(u, r.url));
        for (const u of s.frames) frames.push(absolute(u, r.url));
      }
    }
  }
  const api = new Map<string, { target: string; caller: string | null; count: number }>();
  for (const e of reader.events) {
    if (e.kind === "state" && e["what"] === "cookies") {
      const blob = str(e, "blob");
      const bytes = blob === null ? null : reader.readBlob(blob);
      const text = bytes === null ? null : utf8(bytes);
      let list: unknown = null;
      try {
        list = text === null ? null : (JSON.parse(text) as unknown);
      } catch {
        list = null;
      }
      if (Array.isArray(list)) for (const c of list) if (isRecord(c)) addCookie(str(c, "name") ?? "", str(c, "value"), null);
    } else if (e.kind === "signal") {
      const target = str(e, "api");
      if (target === null) continue;
      const caller = isRecord(e["caller"]) && e["caller"]["kind"] === "page" ? str(e["caller"], "url") : null;
      const key = `${target}\u0000${caller ?? ""}`;
      const n = typeof e["count"] === "number" ? e["count"] : 1;
      const cur = api.get(key);
      if (cur === undefined) api.set(key, { target, caller, count: n });
      else cur.count += n;
    }
  }
  return {
    cookies,
    requests,
    resources,
    globals: null,
    dom: { els, total, truncated },
    frames,
    api: api.size === 0 ? null : [...api.values()],
  };
}
