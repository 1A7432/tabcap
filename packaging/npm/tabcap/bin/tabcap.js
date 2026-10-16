#!/usr/bin/env node
// tabcap npm shim. npm installs exactly one of the per-platform optional
// dependencies (their package.json `os` / `cpu` fields pick it); this shim
// finds that package's binary and runs it with the same arguments and stdio,
// then exits with its exit code, or re-raises the signal that killed it.
// No postinstall step. This file is a template: scripts/npm-pack.ts fills the
// PACKAGES block from NPM_SCOPE (unscoped tabcap-<os>-<cpu> or @<scope>/<os>-<cpu>).
"use strict";

const { spawnSync } = require("node:child_process");

// BEGIN GENERATED: packages (scripts/npm-pack.ts)
const PACKAGES = {};
// END GENERATED: packages

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
  process.stderr.write(`tabcap: ${pkg} is not installed (were optional dependencies skipped?); reinstall tabcap without --omit=optional / --no-optional.\n`);
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
if (r.error !== undefined) {
  process.stderr.write(`tabcap: cannot run ${bin}: ${r.error.message}\n`);
  process.exit(1);
}
if (r.signal !== null) process.kill(process.pid, r.signal);
process.exit(r.status === null ? 1 : r.status);
