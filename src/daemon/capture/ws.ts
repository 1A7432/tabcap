// WebSocket bookkeeping for the recorder (docs/04 §4.1 `ws`, §6 ids).
// CDP reports a socket as Network.webSocketCreated → webSocketWillSendHandshakeRequest
// → webSocketHandshakeResponseReceived → webSocketFrameSent / webSocketFrameReceived
// / webSocketFrameError → webSocketClosed, all keyed by requestId. The handshake
// becomes one `request` event (type "websocket"); every frame becomes one `ws`
// event that points at it with `ws: "r-<handshake seq>"`.
//
// Pure parts only (unit tested): connection state and frame payload decoding.
// CDP params are untrusted.

import { isRecord, num, str } from "../../shared/json.ts";
import type { Headers } from "../../bundle/types.ts";
import { normalizeHeaders } from "./cdpnet.ts";

/** Frame payloads up to this many bytes stay inline in the event (docs/04 §4.1). */
export const WS_INLINE_MAX = 64 * 1024;

export type WsConn = {
  key: string;
  requestId: string;
  url: string;
  initiator: Record<string, unknown> | null;
  reqHeaders: Headers;
  /** The CDP WebSocketResponse of the handshake (status, statusText, headers), once known. */
  response: Record<string, unknown> | null;
  startMono: number | null;
  wallTs: number | null;
  responseMono: number | null;
  /** `r-<seq>` of the handshake request event once written. */
  handshake: string | null;
  /** Bundle nav epoch when the socket was created (set by the recorder). */
  nav: string | null;
  sent: number;
  recv: number;
};

/**
 * One frame's payload. `inline` is the CDP `payloadData` verbatim (UTF-8 text
 * for opcode 1, base64 for opcode 2, the same convention as HAR
 * `_webSocketMessages`) when the decoded payload fits WS_INLINE_MAX; otherwise
 * null and `bytes` go to a blob. `bytes` are always the real payload bytes.
 */
export type FramePayload = { opcode: 1 | 2; bytes: Uint8Array; inline: string | null };

/** Decode a CDP WebSocketFrame; null for control / unknown opcodes or malformed data. */
export function framePayload(frame: unknown, inlineMax = WS_INLINE_MAX): FramePayload | null {
  if (!isRecord(frame)) return null;
  const opcode = num(frame, "opcode");
  const data = str(frame, "payloadData");
  if (data === null || (opcode !== 1 && opcode !== 2)) return null;
  const bytes = opcode === 2 ? new Uint8Array(Buffer.from(data, "base64")) : new TextEncoder().encode(data);
  return { opcode, bytes, inline: bytes.length <= inlineMax ? data : null };
}

/** Bytes of an inline payload as stored by framePayload. */
export function inlineBytes(opcode: number, inline: string): Uint8Array {
  return opcode === 2 ? new Uint8Array(Buffer.from(inline, "base64")) : new TextEncoder().encode(inline);
}

/** Open WebSocket connections of one recorder, keyed by `${sessionId}|${requestId}`. */
export class WsBook {
  private conns = new Map<string, WsConn>();

  /** Network.webSocketCreated (or the first event we see for an unknown socket). */
  created(key: string, requestId: string, p: Record<string, unknown>): WsConn {
    const have = this.conns.get(key);
    if (have !== undefined) return have;
    const conn: WsConn = {
      key,
      requestId,
      url: str(p, "url") ?? "",
      initiator: isRecord(p["initiator"]) ? p["initiator"] : null,
      reqHeaders: {},
      response: null,
      startMono: null,
      wallTs: null,
      responseMono: null,
      handshake: null,
      nav: null,
      sent: 0,
      recv: 0,
    };
    this.conns.set(key, conn);
    return conn;
  }

  /** Network.webSocketWillSendHandshakeRequest: request headers and the start clock. */
  willSend(key: string, requestId: string, p: Record<string, unknown>, mono: number | null, wallTs: number | null): WsConn {
    const conn = this.created(key, requestId, p);
    const req = isRecord(p["request"]) ? p["request"] : {};
    conn.reqHeaders = normalizeHeaders(req["headers"]);
    conn.startMono = mono;
    conn.wallTs = wallTs;
    return conn;
  }

  /** Network.webSocketHandshakeResponseReceived. Returns the connection whose handshake must now be written. */
  handshakeResponse(key: string, requestId: string, p: Record<string, unknown>, mono: number | null): WsConn {
    const conn = this.created(key, requestId, p);
    conn.response = isRecord(p["response"]) ? p["response"] : { status: null, headers: {} };
    conn.responseMono = mono;
    // Some Chrome versions also report the handshake request headers here.
    const rh = isRecord(conn.response) ? conn.response["requestHeaders"] : undefined;
    if (Object.keys(conn.reqHeaders).length === 0 && isRecord(rh)) conn.reqHeaders = normalizeHeaders(rh);
    return conn;
  }

  frame(key: string, direction: "send" | "recv"): WsConn | undefined {
    const conn = this.conns.get(key);
    if (conn === undefined) return undefined;
    if (direction === "send") conn.sent++;
    else conn.recv++;
    return conn;
  }

  get(key: string): WsConn | undefined {
    return this.conns.get(key);
  }

  /** Network.webSocketClosed: forget the connection. */
  close(key: string): WsConn | undefined {
    const conn = this.conns.get(key);
    this.conns.delete(key);
    return conn;
  }

  open(): WsConn[] {
    return [...this.conns.values()];
  }

  /** Wall clock of a CDP monotonic timestamp on this connection (handshake wallTime + elapsed). */
  static tsOf(conn: WsConn, mono: number | null): number | null {
    if (conn.wallTs === null || conn.startMono === null || mono === null) return null;
    return Math.round((conn.wallTs + (mono - conn.startMono)) * 1000) / 1000;
  }
}
