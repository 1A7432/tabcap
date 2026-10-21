// The Python fetch client (templates/python/_tabcap_fetch.py) on a session that
// waits for the human (review 10-21, low-severity item): POST /fetch answers
// `waiting` (a take-over or a verification page, docs/04 §37 / §26), which the
// client raises as `Waiting` (an Exception like ListEnd, not RuntimeError and
// not Stopped) carrying reason, next, session and url, so a scraper can catch
// it and wait (`tabcap handoff wait`, or the human's `handoff continue`).
// `guard.stopped` stays `Stopped`; other errors stay RuntimeError. The daemon
// is a Bun.serve stand-in on loopback TCP; the oracle is the envelope it sends
// (the shape of guard.ts waitingError: code, message, next, handoff view fields).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };
import { isRecord } from "../../src/shared/json.ts";
import { need, packageReason, runInPackageAsync, skipWithout, syncPackage } from "./_python.ts";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "python", "_tabcap_fetch.py");
const TOKEN = "t0k";
const NEXT = "The user is operating this session's tab themselves; ... `tabcap handoff continue --session ex` ...";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-pywait-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body: unknown = await req.json();
      const url = isRecord(body) && typeof body["url"] === "string" ? body["url"] : "";
      if (url.includes("wait")) return Response.json({ ok: false, error: { code: "waiting", message: 'session "ex" is waiting: the user took over tab t1', next: NEXT, session: "ex", state: "waiting", reason: "human-takeover", url: "http://x.test/login" } });
      if (url.includes("stop")) return Response.json({ ok: false, error: { code: "guard.stopped", message: "stopped", next: "n" } });
      return Response.json({ ok: false, error: { code: "usage", message: "bad", next: "fix it" } });
    },
  });
});

afterAll(() => {
  void server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(skipWithout(packageReason(), "python fetch client"))("waiting raises Waiting with reason / next / session / url; guard.stopped is Stopped; others RuntimeError", async () => {
  need(packageReason());
  const pkg = join(root, "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "pyproject.toml"), PYPROJECT.replace(/\{\{\w+\}\}/g, "tabcap-pywait"));
  copyFileSync(TEMPLATE, join(pkg, "_tabcap_fetch.py"));
  expect(syncPackage(pkg)).toBeNull();
  const home = join(root, "home");
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "daemon.json"), JSON.stringify({ listener: "tcp", host: "127.0.0.1", port: server?.port, token: TOKEN }));
  const script = [
    "from _tabcap_fetch import TabcapFetch, Waiting, Stopped",
    "tc = TabcapFetch(session='ex')",
    "try:",
    "    tc.fetch('http://x.test/wait')",
    "except Waiting as e:",
    "    print('waiting', e.reason, e.session, e.url, isinstance(e, RuntimeError), isinstance(e, Stopped))",
    "    print(e.next)",
    "try:",
    "    tc.fetch('http://x.test/stop')",
    "except Stopped as e:",
    "    print('stopped', isinstance(e, Waiting))",
    "try:",
    "    tc.fetch('http://x.test/other')",
    "except Waiting:",
    "    print('wrong')",
    "except RuntimeError as e:",
    "    print('runtime', e)",
  ].join("\n");
  const r = await runInPackageAsync(pkg, ["python", "-c", script], { TABCAP_HOME: home });
  expect(r.err).toBe("");
  expect(r.out.trim().split(/\r?\n/)).toEqual(["waiting human-takeover ex http://x.test/login False False", NEXT, "stopped False", "runtime usage: bad (fix it)"]);
});
