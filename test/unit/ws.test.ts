import { describe, expect, test } from "bun:test";
import { framePayload, inlineBytes, WsBook, WS_INLINE_MAX } from "../../src/daemon/capture/ws.ts";

describe("WebSocket frame payloads (docs/04 §4.1 ws)", () => {
  test("text frames stay inline verbatim; size is UTF-8 bytes", () => {
    const p = framePayload({ opcode: 1, mask: true, payloadData: "héllo" });
    expect(p?.opcode).toBe(1);
    expect(p?.inline).toBe("héllo");
    expect(p?.bytes.length).toBe(6);
  });
  test("binary frames: base64 decoded to real bytes, inline keeps the base64 text", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const b64 = Buffer.from(bytes).toString("base64");
    const p = framePayload({ opcode: 2, payloadData: b64 });
    expect(p?.bytes).toEqual(bytes);
    expect(p?.inline).toBe(b64);
    expect(inlineBytes(2, b64)).toEqual(bytes);
    expect(inlineBytes(1, "é")).toEqual(Uint8Array.from([0xc3, 0xa9]));
  });
  test("payloads over the inline limit go to a blob (inline null)", () => {
    const big = "x".repeat(WS_INLINE_MAX + 1);
    expect(framePayload({ opcode: 1, payloadData: big })?.inline).toBeNull();
    expect(framePayload({ opcode: 1, payloadData: "x".repeat(WS_INLINE_MAX) })?.inline).not.toBeNull();
    expect(framePayload({ opcode: 1, payloadData: "abcd" }, 3)?.inline).toBeNull();
  });
  test("control / unknown opcodes and malformed frames are skipped", () => {
    expect(framePayload({ opcode: 8, payloadData: "" })).toBeNull();
    expect(framePayload({ opcode: 1 })).toBeNull();
    expect(framePayload("junk")).toBeNull();
    expect(framePayload(null)).toBeNull();
  });
});

describe("WsBook connection bookkeeping", () => {
  test("created → willSend → handshake → frames → close", () => {
    const b = new WsBook();
    const k = "S1|9.1";
    const c = b.created(k, "9.1", { url: "ws://127.0.0.1/ws", initiator: { type: "script" } });
    expect(b.created(k, "9.1", { url: "ignored" })).toBe(c);
    b.willSend(k, "9.1", { request: { headers: { Upgrade: "websocket", ":path": "/ws" } } }, 1000, 1_700_000_000_000);
    expect(c.reqHeaders).toEqual({ upgrade: "websocket" });
    const h = b.handshakeResponse(k, "9.1", { response: { status: 101, statusText: "Switching Protocols", headers: { Upgrade: "websocket" } } }, 1005);
    expect(h.response?.["status"]).toBe(101);
    expect(WsBook.tsOf(h, 1010)).toBe(1_700_000_000_010);
    expect(WsBook.tsOf(h, null)).toBeNull();
    b.frame(k, "send");
    b.frame(k, "send");
    b.frame(k, "recv");
    expect([c.sent, c.recv]).toEqual([2, 1]);
    expect(b.frame("other", "send")).toBeUndefined();
    expect(b.open()).toHaveLength(1);
    expect(b.close(k)).toBe(c);
    expect(b.open()).toHaveLength(0);
    expect(b.close(k)).toBeUndefined();
  });
  test("untrusted params: missing fields become empty, not crashes", () => {
    const b = new WsBook();
    const c = b.handshakeResponse("k", "r", { response: "junk" }, null);
    expect(c.url).toBe("");
    expect(c.response).toEqual({ status: null, headers: {} });
    expect(WsBook.tsOf(c, 5)).toBeNull();
  });
});
