// Test-only decode plugin (tabcap-decode/1) whose behaviour the request body
// picks, so one process can play every failure the runtime must survive:
//   hang      never answers            crash     exits with code 3
//   garbage   a non-JSON line          wrongid   answers another id
//   big       an answer line of 3 MB   fail      {ok:false, error}
//   headers   echoes the header names it was given (request, response)
//   anything else: ok, the body upper-cased, as text/plain
// Every answer carries `pid` in `note`, so a test sees restarts.

type Msg = { id: number; request: { headers: Record<string, unknown> }; response?: { headers: Record<string, unknown> }; body: { data: string } };

function reply(m: Msg): string | null {
  const text = Buffer.from(m.body.data, "base64").toString("utf8");
  const note = `pid ${process.pid}`;
  switch (text) {
    case "hang":
      return null;
    case "crash":
      process.exit(3);
      return null;
    case "garbage":
      return "this is not json";
    case "wrongid":
      return JSON.stringify({ id: m.id + 1000, ok: true, body: { encoding: "utf8", data: "x" } });
    case "big":
      return JSON.stringify({ id: m.id, ok: true, body: { encoding: "utf8", data: "x".repeat(3 * 1024 * 1024) } });
    case "fail":
      return JSON.stringify({ id: m.id, ok: false, error: "cannot decode this one", note });
    case "headers":
      return JSON.stringify({ id: m.id, ok: true, mime: "application/json", note, body: { encoding: "utf8", data: JSON.stringify({ request: Object.keys(m.request.headers).sort(), response: Object.keys(m.response?.headers ?? {}).sort() }) } });
    default:
      return JSON.stringify({ id: m.id, ok: true, mime: "text/plain", note, body: { encoding: "utf8", data: text.toUpperCase() } });
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    const out = reply(JSON.parse(line) as Msg);
    if (out !== null) process.stdout.write(out + "\n");
  }
}

export {};
