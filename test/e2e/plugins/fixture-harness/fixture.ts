// Range fixture plugin (docs/04 §31), test only: protocol tabcap-fixture/1 on
// stdin / stdout. Each fixture becomes cases/<r-N>.json in a made-up harness
// format {when: {method, path, query, body}, then: {status, body}} (the
// plaintext when the fixture has a decoded response). A fixture whose path
// ends with /refuse is answered with ok:false (tests the failure path).

export {};

type Fixture = {
  key: { method: string; path: string; query: string; body: string | null };
  response: { status: number | null; body?: string | null; decoded?: { body?: string } };
  meta: { request: string; rule: string };
};
type Msg = { id: number; op: string; fixture: Fixture };

function answer(m: Msg): Record<string, unknown> {
  if (m.op !== "fixture") return { id: m.id, ok: false, error: `unknown op ${m.op}` };
  const f = m.fixture;
  if (f.key.path.endsWith("/refuse")) return { id: m.id, ok: false, error: "refused on purpose" };
  const harness = { when: f.key, then: { status: f.response.status, body: f.response.decoded?.body ?? f.response.body ?? null }, rule: f.meta.rule };
  return { id: m.id, files: [{ path: `cases/${f.meta.request}.json`, encoding: "utf8", data: JSON.stringify(harness, null, 2) + "\n" }] };
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
