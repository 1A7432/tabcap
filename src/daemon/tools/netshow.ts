// `tabcap net show <id>`: one request (r-12) or WebSocket frame (r-12:34) in
// full, from the bundle: request line, headers, postData, response, body path,
// timing, initiator, nav epoch, tab, outcome. Large values are summarised:
// postData over 2 KB and long header values come back as a path / head.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BlobStore } from "../../bundle/blobs.ts";
import { EVENTS_FILE } from "../../bundle/manifest.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import type { WsFrameEntry } from "../capture/recorder.ts";
import { inlineBytes } from "../capture/ws.ts";
import { parseDecoded } from "../../bundle/decoded.ts";

export const SHOW_INLINE_MAX = 2048;

/** Write a derived file under <bundle>/exports/<sub>/ (0600 in 0700 dirs, like the bundle itself). */
export function materialize(dir: string, sub: string, name: string, bytes: Uint8Array | string): string {
  const path = join(dir, "exports", sub, name.replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/** The `request` event with this id, from events.jsonl (untrusted lines: bad ones are skipped). */
export function findRequestEvent(dir: string, id: string): Record<string, unknown> | null {
  const file = join(dir, EVENTS_FILE);
  if (!existsSync(file)) return null;
  const needle = `"id":${JSON.stringify(id)}`;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      const ev: unknown = JSON.parse(line);
      if (isRecord(ev) && ev["kind"] === "request" && ev["id"] === id) return ev;
    } catch {
      // a torn last line while recording; keep looking
    }
  }
  return null;
}

const head = (s: string) => (s.length > SHOW_INLINE_MAX ? s.slice(0, SHOW_INLINE_MAX) : s);
const decoder = () => new TextDecoder("utf-8", { fatal: false });

/** Header map with long values cut to 2 KB (`…(+N chars)`); arrays (repeated headers) kept. */
export function summariseHeaders(h: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!isRecord(h)) return out;
  const cut = (v: string) => (v.length > SHOW_INLINE_MAX ? `${v.slice(0, SHOW_INLINE_MAX)}…(+${v.length - SHOW_INLINE_MAX} chars)` : v);
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k] = cut(v);
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string").map(cut);
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A side's decoded view (0.6-B) for `net show`: who decoded it, its path, or why it failed; {} when there is none. */
function decodedDetail(v: unknown, store: Pick<BlobStore, "pathOf">): Record<string, unknown> {
  const d = parseDecoded(v);
  if (d === undefined) return {};
  return {
    decoded: {
      by: d.by,
      version: d.version,
      ok: d.ok,
      mime: d.mime,
      bytes: d.bytes,
      ...(d.blob === null ? {} : { path: store.pathOf(d.blob), blob: d.blob }),
      ...(d.error === undefined ? {} : { error: d.error }),
      ...(d.note === undefined ? {} : { note: d.note }),
    },
  };
}

/** `url:line:col`, 1-based (CDP numbers are 0-based), like `console`. */
export function initiatorAt(init: Record<string, unknown>): string | null {
  const url = str(init, "url");
  if (url === null || url === "") return null;
  const line = num(init, "line");
  const col = num(init, "col");
  return `${url}${line === null ? "" : `:${line + 1}`}${line !== null && col !== null ? `:${col + 1}` : ""}`;
}

/** Pure: the detail view of a stored `request` event. `materializePost` stores a long inline body and returns its path. */
export function requestDetail(ev: Record<string, unknown>, store: Pick<BlobStore, "pathOf" | "tryRead">, materializePost: (text: string) => string): Record<string, unknown> {
  const req = isRecord(ev["request"]) ? ev["request"] : {};
  const resp = isRecord(ev["response"]) ? ev["response"] : {};
  const timing = isRecord(ev["timing"]) ? ev["timing"] : {};
  const init = isRecord(ev["initiator"]) ? ev["initiator"] : null;

  let postData: Record<string, unknown> | null = null;
  const pd = isRecord(req["postData"]) ? req["postData"] : null;
  if (pd !== null && typeof pd["inline"] === "string") {
    const text = pd["inline"];
    const size = new TextEncoder().encode(text).length;
    postData = text.length <= SHOW_INLINE_MAX ? { inline: text, size, truncated: false } : { path: materializePost(text), size, head: head(text), truncated: true };
  } else if (pd !== null && typeof pd["blob"] === "string") {
    const bytes = store.tryRead(pd["blob"]);
    postData = { path: store.pathOf(pd["blob"]), blob: pd["blob"], size: num(pd, "size") ?? bytes?.length ?? null, head: bytes === null ? null : head(decoder().decode(bytes.subarray(0, SHOW_INLINE_MAX * 4))), truncated: true };
  }

  const body = isRecord(resp["body"]) ? resp["body"] : null;
  const blob = body === null ? null : str(body, "blob");
  const start = num(timing, "start");
  const end = num(timing, "end");
  const missing = isRecord(resp["bodyMissing"]) ? resp["bodyMissing"] : null;
  return {
    id: ev["id"],
    tab: ev["tab"] ?? null,
    nav: ev["nav"] ?? null,
    cmd: ev["cmd"] ?? null,
    actor: ev["actor"] ?? null,
    type: ev["type"] ?? null,
    method: ev["method"] ?? null,
    url: ev["url"] ?? null,
    status: resp["status"] ?? null,
    statusText: resp["statusText"] ?? null,
    outcome: ev["outcome"] ?? null,
    error: ev["error"] ?? null,
    request: {
      headers: summariseHeaders(req["headers"]),
      postData,
      ...(isRecord(req["postDataMissing"]) ? { postDataMissing: req["postDataMissing"] } : {}),
      ...decodedDetail(req["decoded"], store),
    },
    response: {
      headers: summariseHeaders(resp["headers"]),
      mime: resp["mimeType"] ?? null,
      charset: resp["charset"] ?? null,
      protocol: resp["protocol"] ?? null,
      remote: resp["remote"] ?? null,
      fromCache: resp["fromCache"] ?? null,
      body: blob === null ? null : { path: store.pathOf(blob), blob, size: body === null ? null : num(body, "size"), wireEncoding: body === null ? null : (body["wireEncoding"] ?? null) },
      bodyMissing: missing,
      ...decodedDetail(resp["decoded"], store),
    },
    redirect: ev["redirect"] ?? null,
    timing: {
      start,
      responseStart: num(timing, "responseStart"),
      end,
      total: start !== null && end !== null ? round3(end - start) : null,
    },
    initiator: init === null ? null : { type: str(init, "type") ?? "other", at: initiatorAt(init) },
    ...(ev["bodySource"] !== undefined ? { bodySource: ev["bodySource"] } : {}),
    ...(ev["unreadByPage"] === true ? { unreadByPage: true } : {}),
  };
}

/** Detail of a WebSocket frame (`r-12:34`): frame meta + payload path and a 2 KB head. */
export function frameDetail(dir: string, f: WsFrameEntry): Record<string, unknown> {
  let path: string | null = null;
  let bytes: Uint8Array | null = null;
  if (f.blob !== null) {
    const store = new BlobStore(dir);
    path = store.pathOf(f.blob);
    bytes = store.tryRead(f.blob);
  } else if (f.inline !== null) {
    bytes = inlineBytes(f.opcode ?? 1, f.inline);
    path = materialize(dir, "ws", `${f.id}.bin`, bytes);
  }
  let text: string | null = null;
  if (bytes !== null && f.opcode === 1) text = head(decoder().decode(bytes.subarray(0, SHOW_INLINE_MAX * 4)));
  return {
    id: f.id,
    kind: "ws",
    ws: f.ws,
    seq: f.seq,
    tab: f.tab,
    url: f.url,
    phase: f.phase,
    direction: f.direction,
    opcode: f.opcode,
    size: f.size,
    ts: f.ts,
    reason: f.reason,
    payload: path === null ? null : { path, blob: f.blob, size: bytes?.length ?? f.size, textHead: text, truncated: text !== null && (bytes?.length ?? 0) > SHOW_INLINE_MAX },
  };
}

export function notFound(id: string, dir: string): TabcapError {
  return new TabcapError("not-found", `no request ${id} in ${dir}`, id.includes(":") ? "Run `tabcap net list --kind ws` for frame ids." : "Run `tabcap net list` for request ids (`--all` includes failed and data: requests).");
}
