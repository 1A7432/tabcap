// 0.7-D: `tabcap plugin init --kind decode` writes the decode plugin template
// from the copy embedded in the binary. The embedded texts must equal
// templates/plugins/decode-python/ (the source), the written plugin must load
// through the plugin registry (listPlugins / setEnabled / decodePlugins) as a
// valid decode plugin, config.json is never overwritten, and a non-empty
// directory needs --force. With uv and Python available, the generated plugin
// also decodes the range's s42 XOR body through DecodeSession (as
// decode-python.test.ts does for the template itself).
// Oracle: the files on disk under templates/plugins/decode-python/ and the
// s42 plaintexts written by hand in test/e2e/site.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECODE_TEMPLATE, pluginInit } from "../../src/cli/plugin-init.ts";
import { run } from "../../src/cli/main.ts";
import { DecodeHost, DecodeSession } from "../../src/daemon/hooks/decode.ts";
import { asDecodePlugin, decodePlugins, listPlugins, pluginsDir, setEnabled } from "../../src/daemon/hooks/plugins.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { S42_KEY, S42_ORDER_JSON, xorEncode } from "../e2e/site.ts";
import { tmp } from "./_analyze.ts";
import { removeTree } from "./_platform.ts";
import { need, pythonReason, skipWithout } from "./_python.ts";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "plugins", "decode-python");
const UV = Bun.which("uv");
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTree(r); // a uv-run plugin's cwd is in there (Windows, see removeTree)
});
function root(): { root: string; config: string; cwd: string } {
  const r = tmp("tabcap-pinit-");
  roots.push(r);
  mkdirSync(join(r, "work"));
  return { root: r, config: join(r, "config"), cwd: join(r, "work") };
}
function errorOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof TabcapError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a TabcapError");
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const manifestOf = (dir: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(read(dir, "manifest.json"));
  if (!isRecord(v)) throw new Error("manifest is not an object");
  return v;
};

describe("plugin init: the embedded template", () => {
  test("the five embedded files equal templates/plugins/decode-python/ byte for byte (they cannot drift)", () => {
    expect(Object.keys(DECODE_TEMPLATE).sort()).toEqual(readdirSync(TEMPLATE).sort());
    for (const [file, text] of Object.entries(DECODE_TEMPLATE)) expect(text).toBe(read(TEMPLATE, file));
  });
});

describe("plugin init --kind decode", () => {
  test("--name alone: written to <config>/plugins/<name>/, manifest name set, config.json from the example (0600), loads as a decode plugin", () => {
    const t = root();
    const r = pluginInit(t.config, { kind: "decode", name: "my-decode" }, t.cwd);
    const dir = join(pluginsDir(t.config), "my-decode");
    expect(r).toMatchObject({ name: "my-decode", kind: "decode", dir, installed: true, kept: [] });
    expect(r.files).toEqual(["config.example.json", "config.json", "manifest.json", "plugin.py", "pyproject.toml", "runner.py"]);
    expect(r.next).toContain("tabcap plugin enable my-decode");
    expect(r.next).not.toContain("move this directory");
    for (const f of ["config.example.json", "plugin.py", "pyproject.toml", "runner.py"]) expect(read(dir, f)).toBe(read(TEMPLATE, f));
    // Only the name differs from the shipped manifest.
    expect(manifestOf(dir)).toEqual({ ...manifestOf(TEMPLATE), name: "my-decode" });
    expect(read(dir, "config.json")).toBe(read(TEMPLATE, "config.example.json"));
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o077).toBe(0);
      expect(statSync(pluginsDir(t.config)).mode & 0o077).toBe(0);
    }
    // The registry sees it: valid, installed but not enabled, then enabled.
    const [info] = listPlugins(t.config);
    expect(info === undefined ? null : { name: info.name, enabled: info.enabled, error: info.error }).toEqual({ name: "my-decode", enabled: false, error: null });
    if (info === undefined) throw new Error("not listed");
    expect(asDecodePlugin(info).map((p) => [p.name, p.command, p.decode.match.host])).toEqual([["my-decode", ["uv", "run", "--project", ".", "runner.py"], ["127.0.0.1"]]]);
    expect(decodePlugins(t.config)).toEqual([]);
    setEnabled(t.config, "my-decode", true);
    expect(decodePlugins(t.config).map((p) => p.name)).toEqual(["my-decode"]);
  });

  test("a directory: the name is its basename, resolved against the caller's cwd; outside plugins/ the answer says to move it", () => {
    const t = root();
    const r = pluginInit(t.config, { kind: "decode", dir: "xor-site" }, t.cwd);
    expect(r).toMatchObject({ name: "xor-site", dir: join(t.cwd, "xor-site"), installed: false });
    expect(manifestOf(r.dir)["name"]).toBe("xor-site");
    expect(r.next).toContain(`move this directory to ${join(pluginsDir(t.config), "xor-site")}`);
    expect(listPlugins(t.config)).toEqual([]);
    // --name overrides the basename; a directory under plugins/ named after the plugin counts as installed.
    const r2 = pluginInit(t.config, { kind: "decode", dir: join(pluginsDir(t.config), "other"), name: "other" }, t.cwd);
    expect(r2.installed).toBe(true);
    const r3 = pluginInit(t.config, { kind: "decode", dir: "Some Dir", name: "renamed" }, t.cwd);
    expect(r3).toMatchObject({ name: "renamed", installed: false });
    expect(manifestOf(r3.dir)["name"]).toBe("renamed");
  });

  test("an existing empty directory is fine; a non-empty one needs --force, which rewrites the template files but never config.json or other files", () => {
    const t = root();
    const dir = join(t.cwd, "dec");
    mkdirSync(dir);
    pluginInit(t.config, { kind: "decode", dir }, t.cwd);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ key: "mine" }));
    writeFileSync(join(dir, "plugin.py"), "# edited\n");
    writeFileSync(join(dir, "notes.txt"), "keep me\n");
    expect(errorOf(() => pluginInit(t.config, { kind: "decode", dir }, t.cwd))).toEqual({ code: "conflict", message: `${dir} is not empty (7 entries)` });
    expect(read(dir, "plugin.py")).toBe("# edited\n");
    const r = pluginInit(t.config, { kind: "decode", dir, force: true }, t.cwd);
    expect(r.files).toEqual(["config.example.json", "manifest.json", "plugin.py", "pyproject.toml", "runner.py"]);
    expect(r.kept).toEqual(["config.json"]);
    expect(read(dir, "config.json")).toBe(JSON.stringify({ key: "mine" }));
    expect(read(dir, "plugin.py")).toBe(read(TEMPLATE, "plugin.py"));
    expect(read(dir, "notes.txt")).toBe("keep me\n");
  });

  test("usage and conflict errors: other kinds, no directory and no name, an invalid name, a file in the way", () => {
    const t = root();
    expect(errorOf(() => pluginInit(t.config, { kind: "challenge", name: "x" }, t.cwd)).code).toBe("usage");
    expect(errorOf(() => pluginInit(t.config, { name: "x" }, t.cwd)).code).toBe("usage");
    expect(errorOf(() => pluginInit(t.config, { kind: "decode" }, t.cwd)).code).toBe("usage");
    expect(errorOf(() => pluginInit(t.config, { kind: "decode", dir: "Bad Name" }, t.cwd)).code).toBe("usage");
    expect(errorOf(() => pluginInit(t.config, { kind: "decode", name: "UPPER" }, t.cwd)).code).toBe("usage");
    writeFileSync(join(t.cwd, "afile"), "x");
    expect(errorOf(() => pluginInit(t.config, { kind: "decode", dir: "afile" }, t.cwd)).code).toBe("conflict");
    expect(listPlugins(t.config)).toEqual([]);
  });

  test("through the CLI: `plugin init` then `plugin list` sees it; --kind is required", async () => {
    const t = root();
    const prev = process.env["TABCAP_HOME"];
    process.env["TABCAP_HOME"] = t.root;
    try {
      const r = await run(["plugin", "init", "--kind", "decode", "--name", "cli-dec"]);
      expect(r.code).toBe(0);
      expect(r.envelope.ok ? r.envelope.data : r.envelope.error).toMatchObject({ name: "cli-dec", installed: true });
      const l = await run(["plugin", "list"]);
      const data = l.envelope.ok ? l.envelope.data : null;
      const plugins = isRecord(data) && Array.isArray(data["plugins"]) ? data["plugins"] : [];
      expect(plugins.map((p) => (isRecord(p) ? [p["name"], p["kind"], p["enabled"], p["error"]] : p))).toEqual([["cli-dec", "decode", false, null]]);
      const missing = await run(["plugin", "init", "--name", "x"]);
      expect(missing.code).toBe(2);
    } finally {
      if (prev === undefined) delete process.env["TABCAP_HOME"];
      else process.env["TABCAP_HOME"] = prev;
    }
  });

  test.skipIf(skipWithout(pythonReason(), "plugin init decode runner"))(
    "the generated plugin decodes the range's s42 body through DecodeSession (uv, offline)",
    async () => {
      need(pythonReason());
      const t = root();
      const r = pluginInit(t.config, { kind: "decode", name: "gen-dec" }, t.cwd);
      writeFileSync(join(r.dir, "config.json"), JSON.stringify({ key: S42_KEY }));
      const [info] = listPlugins(t.config);
      if (info === undefined) throw new Error("not listed");
      // The manifest's command with the test's uv binary and offline (tests never download).
      const plugins = asDecodePlugin(info).map((p) => ({ ...p, timeoutMs: 60_000, command: [UV ?? "uv", "run", "--offline", "-q", "--project", ".", "runner.py"] }));
      const host = new DecodeHost();
      try {
        const out = await new DecodeSession(host, plugins).decode({
          direction: "response",
          id: "r-5",
          url: "http://127.0.0.1:4342/s42/api/order",
          method: "GET",
          requestHeaders: {},
          response: { status: 200, headers: { "content-type": "text/plain", "x-enc": "xor" } },
          body: new TextEncoder().encode(xorEncode(S42_ORDER_JSON)),
          mime: "text/plain",
        });
        expect(out?.ok === true ? [out.mime, new TextDecoder().decode(out.body)] : out).toEqual(["application/json", S42_ORDER_JSON]);
      } finally {
        await host.close();
      }
    },
    120_000,
  );
});
