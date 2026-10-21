// 0.7.5-B `tabcap handoff wait --until-selector` with a selector the page's
// querySelector refuses (docs/04 §39): the wait answers `usage` naming the
// selector problem, and the session keeps waiting for the human. The poll runs
// against the fake browser in _fakechrome.ts, which answers the selector poll
// the way the poll expression reports a querySelector exception (waitspec.ts
// pollExpression: `{invalid: <message>}`); the message is Chrome's wording for
// a bad selector.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "../../src/daemon/main.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { isRecord } from "../../src/shared/json.ts";
import { paths } from "../../src/shared/paths.ts";
import { FAKE_CHROME, fakeChrome } from "./_fakechrome.ts";
import { SLOW_IO_MS, removeTree } from "./_platform.ts";

const BAD = "Failed to execute 'querySelector' on 'Document': '##account' is not a valid selector.";

describe.skipIf(!FAKE_CHROME)("handoff wait --until-selector: an invalid selector (fake browser, POSIX)", () => {
  let root = "";
  let d: Daemon;
  const run = (action: string, args: Record<string, unknown> = {}) => handleCommand(d, { action, args, session: "a" }, () => undefined);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "tabcap-075b-sel-"));
    const p = paths({ TABCAP_HOME: root });
    mkdirSync(p.config, { recursive: true, mode: 0o700 });
    d = new Daemon(p);
    // only the selector poll catches a querySelector exception and returns {invalid}
    const exe = fakeChrome(root, { evaluate: [{ when: "return { invalid:", value: { invalid: BAD } }] });
    const env = await run("browser.start", { executablePath: exe, proxy: "none" });
    if (!env.ok) throw new Error(`fake browser did not start: ${JSON.stringify(env.error)}`);
  }, SLOW_IO_MS);

  afterAll(async () => {
    await run("browser.stop");
    await removeTree(root);
  }, SLOW_IO_MS);

  test(
    "usage naming the selector problem; the session still waits",
    async () => {
      const b = d.browser;
      if (b === null) throw new Error("the fake browser is not running");
      const tab = await b.tabs.createTab("a");
      d.guard.takeover("a", { tab: tab.id, url: tab.url, event: "pointerdown", at: 1 }, undefined);
      const h = d.guard.get("a");
      await h?.started;
      expect(d.guard.isWaiting("a")).toBe(true);
      const env = await run("handoff.wait", { untilSelector: "##account", timeoutMs: 5000 });
      expect(env.ok).toBe(false);
      const e: Record<string, unknown> = env.ok ? {} : env.error;
      expect(e).toMatchObject({ code: "usage" });
      expect(String(e["message"])).toContain("--until-selector is not a valid CSS selector");
      expect(String(e["message"])).toContain("'##account' is not a valid selector");
      expect(d.guard.isWaiting("a")).toBe(true);
      const st = await run("handoff.status");
      expect(st.ok && isRecord(st.data) ? st.data["state"] : null).toBe("waiting");
    },
    SLOW_IO_MS,
  );
});
