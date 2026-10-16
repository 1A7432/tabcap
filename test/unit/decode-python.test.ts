// 0.6-B: the Python decode runner template (templates/plugins/decode-python,
// owner addition 2026-10-16) speaks tabcap-decode/1 when started with
// `uv run --project . runner.py`, as its manifest says. The example plugin.py
// undoes the range's XOR with the key from its own config.json, and a
// mitmproxy-style plugin that assigns flow.response.content (the body of a
// `response(flow)` addon moved over unchanged) works too.
// Python only through uv, offline (like the replay-python tests): no uv or
// no Python skips with the reason, except under CI, where it fails.
// Oracle: the s42 plaintexts written by hand in test/e2e/site.ts.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isRecord } from "../../src/shared/json.ts";
import { join } from "node:path";
import { DecodeHost, DecodeSession, type DecodeJob } from "../../src/daemon/hooks/decode.ts";
import { asDecodePlugin, listPlugins } from "../../src/daemon/hooks/plugins.ts";
import { S42_KEY, S42_ORDER_JSON, S42_POST_JSON, xorEncode } from "../e2e/site.ts";
import { tmp } from "./_analyze.ts";
import { need, pythonReason, skipWithout } from "./_python.ts";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "plugins", "decode-python");
const UV = Bun.which("uv");

const MITM_STYLE = `import base64, json, pathlib
KEY = json.loads(pathlib.Path(__file__).with_name("config.json").read_text())["key"].encode()

def decode(flow):
    # the body of a mitmproxy addon's response(flow), unchanged
    raw = base64.b64decode(flow.response.content.strip())
    flow.response.content = bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(raw))
`;

function job(direction: "request" | "response", body: string): DecodeJob {
  return {
    direction,
    id: "r-5",
    url: "http://127.0.0.1:4342/s42/api/order",
    method: "POST",
    requestHeaders: { "content-type": "text/plain", "x-enc": "xor" },
    response: direction === "response" ? { status: 200, headers: { "content-type": "text/plain", "x-enc": "xor" } } : null,
    body: new TextEncoder().encode(body),
    mime: "text/plain",
  };
}

describe("Python decode runner template", () => {
  test.skipIf(skipWithout(pythonReason(), "decode-python runner"))(
    "uv run --project . runner.py: the example plugin decodes both directions; a mitmproxy-style plugin works unchanged",
    async () => {
      need(pythonReason());
      const root = tmp("tabcap-decpy-");
      const config = join(root, "config");
      const install = (name: string, pluginPy: string | null) => {
        const dir = join(config, "plugins", name);
        mkdirSync(join(config, "plugins"), { recursive: true, mode: 0o700 });
        cpSync(TEMPLATE, dir, { recursive: true });
        const m: unknown = JSON.parse(readFileSync(join(TEMPLATE, "manifest.json"), "utf8"));
        if (!isRecord(m)) throw new Error("template manifest is not an object");
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, name }));
        writeFileSync(join(dir, "config.json"), JSON.stringify({ key: S42_KEY }));
        if (pluginPy !== null) writeFileSync(join(dir, "plugin.py"), pluginPy);
      };
      install("decode-python", null);
      install("mitm-style", MITM_STYLE);
      const host = new DecodeHost();
      try {
        const plugins = listPlugins(config).flatMap((p) => asDecodePlugin(p));
        expect(plugins.map((p) => [p.name, p.command])).toEqual([
          ["decode-python", ["uv", "run", "--project", ".", "runner.py"]],
          ["mitm-style", ["uv", "run", "--project", ".", "runner.py"]],
        ]);
        // The template's command, with the test's uv binary and offline (tests never download).
        const offline = plugins.map((p) => ({ ...p, timeoutMs: 60_000, command: [UV ?? "uv", "run", "--offline", "-q", "--project", ".", "runner.py"] }));
        const [example, mitm] = offline;
        if (example === undefined || mitm === undefined) throw new Error("plugins missing");
        const s = new DecodeSession(host, [example]);
        const resp = await s.decode(job("response", xorEncode(S42_ORDER_JSON)));
        expect(resp?.ok === true ? [resp.mime, new TextDecoder().decode(resp.body)] : resp).toEqual(["application/json", S42_ORDER_JSON]);
        const req = await s.decode(job("request", xorEncode(S42_POST_JSON)));
        expect(req?.ok === true ? new TextDecoder().decode(req.body) : req).toBe(S42_POST_JSON);
        const none = await s.decode({ ...job("response", "plain"), response: { status: 200, headers: { "content-type": "text/plain" } } });
        expect(none).toBeNull(); // None = declined: no view, not a failure
        const seen: string[] = [];
        await s.decode({ ...job("response", "plain"), response: { status: 200, headers: { "content-type": "text/plain" } } }, (n) => seen.push(n));
        expect(seen).toEqual(["decode-python"]);
        const bad = await s.decode(job("response", "%%% not base64"));
        expect(bad?.ok).toBe(false);
        expect(host.starts("decode-python")).toBe(1); // errors are answers: one process throughout
        const m = await new DecodeSession(host, [mitm]).decode(job("response", xorEncode(S42_ORDER_JSON)));
        expect(m?.ok === true ? [m.mime, new TextDecoder().decode(m.body)] : m).toEqual(["application/json", S42_ORDER_JSON]);
      } finally {
        host.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
