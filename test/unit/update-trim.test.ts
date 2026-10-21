// `tabcap update`: the registry's version string is checked after trimming
// (parseVersion), so the npm argument and the Homebrew keg path must use the
// checked value too, not the raw string with its whitespace. Expected values:
// the version planted in the local registry and the argv the fake npm saw.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { run } from "../../src/cli/main.ts";
import { TOOL_VERSION } from "../../src/bundle/manifest.ts";
import { parseVersion } from "../../src/cli/update.ts";
import { removeTree } from "./_platform.ts";

describe.skipIf(process.platform === "win32")("tabcap update with a registry version padded by whitespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-update-trim-"));
  const npmExe = join(dir, "lib", "node_modules", "tabcap", "node_modules", "tabcap-linux-x64", "bin", "tabcap");
  const brewExe = join(dir, "Cellar", "tabcap", "0.0.1", "bin", "tabcap");
  const argvFile = join(dir, "argv.txt");
  const c = parseVersion(TOOL_VERSION);
  if (c === null) throw new Error("bad TOOL_VERSION");
  const clean = `${c[0]}.${c[1]}.${c[2] + 1}`;
  const keys = ["TABCAP_HOME", "TABCAP_NPM_REGISTRY", "TABCAP_NPM", "TABCAP_BREW", "TABCAP_UPDATE_EXECUTABLE"];
  const saved: Record<string, string | undefined> = {};
  let server: Server<undefined>;
  const setEnv = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const script = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n${body}exit 0\n`);
    chmodSync(p, 0o755);
    return p;
  };

  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    for (const p of [npmExe, brewExe]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    }
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ name: "tabcap", version: ` ${clean}\n` }) });
    setEnv("TABCAP_HOME", join(dir, "home"));
    setEnv("TABCAP_NPM_REGISTRY", `http://127.0.0.1:${server.port}/`);
  });
  afterAll(async () => {
    void server.stop(true);
    for (const k of keys) setEnv(k, saved[k]);
    await removeTree(dir);
  });

  test("npm: installs tabcap@<the checked version>, and the answer's latest is that version", async () => {
    setEnv("TABCAP_NPM", script("npm-ok", ""));
    setEnv("TABCAP_UPDATE_EXECUTABLE", npmExe);
    const { code, envelope } = await run(["update"]);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ latest: clean, action: "installed" });
    expect(readFileSync(argvFile, "utf8")).toBe(`install\n-g\ntabcap@${clean}\n`);
  });

  test("Homebrew: the keg <prefix>/Cellar/tabcap/<checked version> counts as installed", async () => {
    setEnv("TABCAP_BREW", script("brew-ok", `mkdir -p '${join(dir, "Cellar", "tabcap", clean, "bin")}'\n`));
    setEnv("TABCAP_UPDATE_EXECUTABLE", brewExe);
    const { code, envelope } = await run(["update"]);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(existsSync(join(dir, "Cellar", "tabcap", clean))).toBe(true);
    expect(envelope.data).toMatchObject({ latest: clean, channel: "homebrew", action: "installed" });
  });
});
