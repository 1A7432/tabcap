// Range decode plugin (docs/05 s79, docs/04 §53.8), test only: protocol
// tabcap-decode/1 on stdin / stdout. A response body that is base64 text of a
// JSON document is answered with that JSON.

export {};

type Msg = { id: number; body: { encoding: string; data: string } };

function answer(m: Msg): Record<string, unknown> {
  const text = Buffer.from(m.body.data, "base64").toString("utf8").trim();
  const plain = Buffer.from(text, "base64").toString("utf8");
  JSON.parse(plain);
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
