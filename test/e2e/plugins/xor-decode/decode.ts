// Range decode plugin (docs/05 s42, docs/04 §28), test only: protocol
// tabcap-decode/1 on stdin / stdout. A body sent with `x-enc: xor` (request
// headers for a request body, response headers for a response body) is
// base64 of the plaintext XORed with the key in config.json beside this file.
// The key is read here, never by tabcap.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Msg = {
  id: number;
  direction: "request" | "response";
  request: { headers: Record<string, string | string[]> };
  response?: { headers: Record<string, string | string[]> };
  body: { encoding: string; data: string };
};

const config: unknown = JSON.parse(readFileSync(join(import.meta.dir, "config.json"), "utf8"));
const keyText = typeof config === "object" && config !== null && "key" in config && typeof config.key === "string" ? config.key : "";
const key = new TextEncoder().encode(keyText);

function answer(m: Msg): Record<string, unknown> {
  const headers = m.direction === "response" ? (m.response?.headers ?? {}) : m.request.headers;
  if (headers["x-enc"] !== "xor") return { id: m.id, ok: false, error: "no x-enc: xor" };
  const text = Buffer.from(m.body.data, "base64").toString("utf8").trim();
  const raw = new Uint8Array(Buffer.from(text, "base64"));
  const plain = new TextDecoder("utf-8", { fatal: true }).decode(raw.map((x, i) => x ^ (key[i % key.length] ?? 0)));
  return { id: m.id, ok: true, mime: "application/json", body: { encoding: "utf8", data: plain } };
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    const m = JSON.parse(line) as Msg;
    let out: Record<string, unknown>;
    try {
      out = answer(m);
    } catch (e) {
      out = { id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}
