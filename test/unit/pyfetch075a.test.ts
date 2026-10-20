// 0.7.5-A (docs/04 §38): the Python fetch client (templates/python/_tabcap_fetch.py)
// raises ListEnd when the daemon's answer carries `end`, sends `end_on` as
// `endOn`, and keeps returning (status, headers, bytes) otherwise. The daemon
// is a Bun.serve stand-in on loopback TCP (the Windows listener shape of
// daemon.json); the oracle is the envelope it answers with.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };
import { isRecord } from "../../src/shared/json.ts";
import { need, packageReason, runInPackageAsync, skipWithout, syncPackage } from "./_python.ts";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "python", "_tabcap_fetch.py");
const TOKEN = "t0k";

let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;
const seen: unknown[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-pyfetch-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ ok: false, error: { code: "usage", message: "token", next: "" } });
      const body: unknown = await req.json();
      seen.push(body);
      const url = isRecord(body) && typeof body["url"] === "string" ? body["url"] : "";
      const data: Record<string, unknown> = { id: "r-1", status: 200, headers: { "content-type": "application/json" }, body: url.includes("page=3") ? '{"code":203}' : '{"code":0}' };
      if (url.includes("page=3")) data["end"] = { rule: "json:$.code=203", detail: "$.code is 203" };
      return Response.json({ ok: true, data });
    },
  });
});

afterAll(() => {
  void server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(skipWithout(packageReason(), "python fetch client"))("ListEnd ends a paging loop; end_on goes out as endOn; ordinary answers are tuples", async () => {
  need(packageReason());
  const pkg = join(root, "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "pyproject.toml"), PYPROJECT.replace(/\{\{\w+\}\}/g, "tabcap-pyfetch"));
  copyFileSync(TEMPLATE, join(pkg, "_tabcap_fetch.py"));
  expect(syncPackage(pkg)).toBeNull();
  const home = join(root, "home");
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "daemon.json"), JSON.stringify({ listener: "tcp", host: "127.0.0.1", port: server?.port, token: TOKEN }));
  const script = [
    "from _tabcap_fetch import TabcapFetch, ListEnd, Stopped",
    "tc = TabcapFetch(session='ex')",
    "pages = []",
    "for page in range(1, 10):",
    "    try:",
    "        status, headers, body = tc.fetch(f'http://x.test/l?page={page}', end_on=['json:$.code=203'])",
    "        pages.append((page, status, body.decode()))",
    "    except ListEnd as e:",
    "        print('end', page, e.rule, e.detail, e.status, e.content.decode(), isinstance(e, Stopped))",
    "        break",
    "print(pages)",
  ].join("\n");
  const r = await runInPackageAsync(pkg, ["python", "-c", script], { TABCAP_HOME: home });
  expect(r.err).toBe("");
  expect(r.out.trim().split(/\r?\n/)).toEqual(["end 3 json:$.code=203 $.code is 203 200 {\"code\":203} False", "[(1, 200, '{\"code\":0}'), (2, 200, '{\"code\":0}')]"]);
  expect(seen.map((b) => (isRecord(b) ? b["endOn"] : null))).toEqual([["json:$.code=203"], ["json:$.code=203"], ["json:$.code=203"]]);
});
