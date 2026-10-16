// Example decode plugin for the local range scenario s21 (docs/12 §4.1,
// docs/compare/range.ts). The key and IV in config.json are literals from
// that local range, not the solution for any site. Protocol tabcap-decode/1
// (docs/04 §28): one JSON request per line on stdin, one answer per line on
// stdout. The response body is {code:0, data:"<base64 AES-GCM ciphertext>"};
// the answer is the plaintext JSON. The key is read here, never by tabcap.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Msg = {
  id: number;
  body: { encoding: string; data: string };
};

const config: unknown = JSON.parse(readFileSync(join(import.meta.dir, "config.json"), "utf8"));

function field(name: string): string {
  if (typeof config === "object" && config !== null) {
    const v: unknown = Object.entries(config).find(([k]) => k === name)?.[1];
    if (typeof v === "string") return v;
  }
  throw new Error(`config.json: missing string "${name}"`);
}

const enc = new TextEncoder();
const keyBytes = enc.encode(field("key"));
const iv = enc.encode(field("iv"));

async function answer(m: Msg): Promise<Record<string, unknown>> {
  const envelope: unknown = JSON.parse(Buffer.from(m.body.data, "base64").toString("utf8"));
  const data = typeof envelope === "object" && envelope !== null ? Object.entries(envelope).find(([k]) => k === "data")?.[1] : undefined;
  if (typeof data !== "string") return { id: m.id, ok: false, error: 'no string "data" in the response body' };
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, Buffer.from(data, "base64"));
  return { id: m.id, ok: true, mime: "application/json", body: { encoding: "utf8", data: new TextDecoder("utf-8", { fatal: true }).decode(plain) } };
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    let id = 0;
    let out: Record<string, unknown>;
    try {
      const m = JSON.parse(line) as Msg;
      id = m.id;
      out = await answer(m);
    } catch (e) {
      out = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}
