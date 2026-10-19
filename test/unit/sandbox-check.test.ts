// Chrome inside another sandbox (0.7.4): the browser.log markers, reading only
// this launch's lines, and the error's way out. The real failure was measured
// with sandbox-exec on macOS (NOTES 2026-10-19); these cover the pure parts.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logOffset, logSince, nestedSandboxError, sandboxFailed } from "../../src/daemon/transport/direct/sandbox-check.ts";
import { removeTree } from "./_platform.ts";

describe("Chrome's sandbox failure in browser.log", () => {
  test("macOS helper and Linux zygote lines", () => {
    expect(sandboxFailed("sandbox initialization failed: Operation not permitted\n")).toBe(true);
    expect(sandboxFailed("Failed to initialize sandbox.[1019/163030.97:ERROR:...]")).toBe(true);
    expect(sandboxFailed("[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ ...")).toBe(true);
  });
  test("ordinary noise is not a sandbox failure", () => {
    expect(sandboxFailed("")).toBe(false);
    expect(sandboxFailed("[ERROR:crashpad/file_io_posix.cc:208] open .../Crashpad/settings.dat: Operation not permitted (1)")).toBe(false);
    expect(sandboxFailed("--no-sandbox is not used\nDevTools listening on ws://127.0.0.1:9222")).toBe(false);
  });
});

describe("only this launch's log lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-sbx-"));
  afterAll(async () => removeTree(dir));
  test("an old failure before the offset is ignored", () => {
    const f = join(dir, "browser.log");
    writeFileSync(f, "sandbox initialization failed: Operation not permitted\n");
    const off = logOffset(f);
    expect(sandboxFailed(logSince(f, off))).toBe(false);
    appendFileSync(f, "Failed to initialize sandbox.\n");
    expect(logSince(f, off)).toBe("Failed to initialize sandbox.\n");
    expect(sandboxFailed(logSince(f, off))).toBe(true);
  });
  test("a missing log reads as empty", () => {
    const f = join(dir, "none.log");
    expect(logOffset(f)).toBe(0);
    expect(logSince(f, 0)).toBe("");
  });
});

describe("the error", () => {
  test("names the cause and the way out, never --no-sandbox as advice", () => {
    const e = nestedSandboxError("/x/browser.log", "darwin");
    expect(e.code).toBe("unsupported");
    expect(e.message).toContain("another sandbox");
    expect(e.message).toContain("/x/browser.log");
    expect(e.next).toContain("tabcap daemon stop");
    expect(e.next).toContain("tabcap mcp");
    expect(e.next).toContain("Never add --no-sandbox");
  });
  test("Linux also points at user namespaces", () => {
    expect(nestedSandboxError("/x", "linux").message).toContain("user namespaces");
    expect(nestedSandboxError("/x", "darwin").message).not.toContain("user namespaces");
  });
});
