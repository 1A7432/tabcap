// Message wires for the CDP client.
// - pipe: `--remote-debugging-pipe`, Chrome reads fd 3 and writes fd 4, each
//   message is JSON terminated by a NUL byte (docs/07 §1.1, measured in Bun
//   with node:child_process and 5-entry stdio).
// - ws: `--remote-debugging-port=0` fallback, browser endpoint from DevToolsActivePort.

import type { Readable, Writable } from "node:stream";
import type { Wire } from "./cdp.ts";

export function pipeWire(toChrome: Writable, fromChrome: Readable): Wire {
  const onMsg: Array<(t: string) => void> = [];
  const onClose: Array<(r: string) => void> = [];
  let closed = false;
  const fire = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const f of onClose) f(reason);
  };
  let chunks: Buffer[] = [];
  fromChrome.on("data", (d: Buffer) => {
    let start = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] !== 0) continue;
      chunks.push(d.subarray(start, i));
      const text = Buffer.concat(chunks).toString("utf8");
      chunks = [];
      start = i + 1;
      for (const f of onMsg) f(text);
    }
    if (start < d.length) chunks.push(d.subarray(start));
  });
  fromChrome.on("end", () => fire("pipe ended"));
  fromChrome.on("error", (e: Error) => fire(`pipe error: ${e.message}`));
  toChrome.on("error", (e: Error) => fire(`pipe error: ${e.message}`));
  return {
    send(text) {
      if (closed) throw new Error("pipe is closed");
      toChrome.write(text + "\0");
    },
    onMessage: (f) => void onMsg.push(f),
    onClose: (f) => void onClose.push(f),
    close() {
      toChrome.end();
      fire("closed by client");
    },
  };
}

export async function wsWire(url: string, timeoutMs = 10_000): Promise<Wire> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`WebSocket ${url} did not open in ${timeoutMs} ms`)), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error(`WebSocket ${url} failed to open`));
    };
  });
  const onMsg: Array<(t: string) => void> = [];
  const onClose: Array<(r: string) => void> = [];
  ws.onmessage = (m) => {
    const text = typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString("utf8");
    for (const f of onMsg) f(text);
  };
  ws.onclose = (e) => {
    for (const f of onClose) f(`websocket closed (${e.code})`);
  };
  return {
    send: (text) => ws.send(text),
    onMessage: (f) => void onMsg.push(f),
    onClose: (f) => void onClose.push(f),
    close: () => ws.close(),
  };
}
