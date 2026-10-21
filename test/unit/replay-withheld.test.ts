// replay export-python, chain mode: the headers verify() withholds from a decode
// plugin (`_WITHHELD` in the generated client.py) are written at export time
// (review 10-21, owner decision): the credential headers cookie, set-cookie,
// authorization, proxy-authorization and x-api-key, plus every request or
// response header name recorded in the bundle that the one sensitive-header
// test (bundle/redact.ts isSensitiveHeaderName, which the daemon uses for the
// headers it gives a decode plugin, docs/04 §28) calls sensitive. Oracle: the
// header names the fixture planted, classified by docs/04 §8's rule text.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportPython } from "../../src/replay/python.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { pyCompile } from "./_python.ts";

const root = tmp("tabcap-withheld-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ORIGIN = "http://127.0.0.1:4310";
const C = 1760700000000;
const TOKEN = "tok-0123456789abcdef";

describe("generated _WITHHELD", () => {
  test("the credential headers plus the recording's sensitive header names; nothing else", async () => {
    const dir = await buildBundle(join(root, "b"), { name: "withheld", created: C, seed: 21 }, async (b) => {
      await b.request({
        url: `${ORIGIN}/api/token`,
        method: "POST",
        type: "fetch",
        mime: "application/json",
        body: JSON.stringify({ access_token: TOKEN }),
        postData: "client=web",
        reqHeaders: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", "X-CSRF": "c1" },
        respHeaders: { "content-type": "application/json", "x-session-id": "s-1", "x-trace": "t" },
        ts: C + 100,
      });
      await b.request({ url: `${ORIGIN}/api/me`, type: "fetch", mime: "application/json", body: JSON.stringify({ name: "demo" }), reqHeaders: { authorization: `Bearer ${TOKEN}`, apikey: "k-1", "x-sid": "s-2", accept: "application/json" }, ts: C + 200 });
    });
    const out = join(root, "py");
    exportPython({ bundle: dir, out, chain: true });
    const client = readFileSync(join(out, "client.py"), "utf8");
    const line = client.split("\n").find((l) => l.startsWith("_WITHHELD = "));
    expect(line).toBe('_WITHHELD = {"apikey", "authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "x-csrf", "x-session-id", "x-sid"}');
    expect(pyCompile([join(out, "client.py")])).toBeNull();
  });
});
