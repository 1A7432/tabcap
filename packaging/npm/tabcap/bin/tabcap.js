#!/usr/bin/env node
// tabcap npm shim (template; not published). npm installs exactly one of the
// @tabcap/<os>-<cpu> optional dependencies (their package.json `os` / `cpu`
// fields pick it); this shim finds that package's binary and runs it with the
// same arguments, stdio and exit code. No postinstall step.
"use strict";

const { spawnSync } = require("node:child_process");

const PACKAGES = {
  "darwin-arm64": "@tabcap/darwin-arm64",
  "linux-x64": "@tabcap/linux-x64",
  "linux-arm64": "@tabcap/linux-arm64",
  "win32-x64": "@tabcap/win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PACKAGES[key];
if (pkg === undefined) {
  process.stderr.write(`tabcap: no prebuilt binary for ${key}; build from source (bun run build).\n`);
  process.exit(1);
}

let bin;
try {
  bin = require.resolve(`${pkg}/bin/${process.platform === "win32" ? "tabcap.exe" : "tabcap"}`);
} catch {
  process.stderr.write(`tabcap: ${pkg} is not installed (were optional dependencies skipped?); reinstall tabcap without --no-optional.\n`);
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
if (r.error !== undefined) {
  process.stderr.write(`tabcap: cannot run ${bin}: ${r.error.message}\n`);
  process.exit(1);
}
if (r.signal !== null) process.kill(process.pid, r.signal);
process.exit(r.status === null ? 1 : r.status);
