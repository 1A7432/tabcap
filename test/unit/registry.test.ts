// The action metadata table (src/daemon/tools/registry.ts, owner 10-21): every
// daemon action has one row, and the sets the daemon used to keep by hand are
// derived from it. Oracle for the derived sets: the literal sets at 1ec64b6
// (`git show 1ec64b6:src/daemon/state.ts` ACTION_COMMANDS,
// `…:src/daemon/guard.ts` BLOCKED_WHILE_WAITING, `…:src/daemon/main.ts`
// TEXT_ACTIONS), copied below; the only allowed difference is the owner's
// 10-21 ruling that `wire.profile` / `wire.probe` wait like `fingerprint.probe`
// (they open and navigate a tab of the session).

import { describe, expect, test } from "bun:test";
import { BLOCKED_WHILE_WAITING } from "../../src/daemon/guard.ts";
import { ACTION_COMMANDS } from "../../src/daemon/state.ts";
import { TOOLS } from "../../src/daemon/tools/index.ts";
import { DAEMON_ACTIONS, TEXT_ACTIONS, TOOL_ACTIONS, actionsWhere } from "../../src/daemon/tools/registry.ts";

const OLD_ACTION_COMMANDS = ["navigate", "click", "fill", "type", "press", "go", "reload", "evaluate", "hover", "upload"];
const OLD_BLOCKED = ["navigate", "click", "fill", "type", "press", "go", "reload", "evaluate", "dialog", "hover", "upload", "resize", "emulate", "fingerprint.probe", "fetch"];
const OLD_TEXT_ACTIONS = ["fill", "type"];

const sorted = (s: Iterable<string>) => [...s].sort();

describe("action metadata table", () => {
  test("every TOOLS key has a row and every tool row is in TOOLS", () => {
    expect(sorted(Object.keys(TOOLS))).toEqual(sorted(Object.keys(TOOL_ACTIONS)));
  });

  test("the actions daemon/main.ts answers before the tool path are rows of their own, not tools", () => {
    expect(sorted(Object.keys(DAEMON_ACTIONS))).toEqual(["daemon.shutdown", "daemon.status", "status"]);
    for (const [k, m] of Object.entries(DAEMON_ACTIONS)) {
      expect(TOOLS[k]).toBeUndefined();
      expect(m.note.length).toBeGreaterThan(0);
      expect([m.blockedWhileWaiting, m.cmdWindow, m.defersText]).toEqual([false, false, false]);
    }
  });

  test("derived sets equal the hand-kept ones of 1ec64b6, except wire.profile / wire.probe now wait (owner 10-21)", () => {
    expect(sorted(ACTION_COMMANDS)).toEqual(sorted(OLD_ACTION_COMMANDS));
    expect(sorted(TEXT_ACTIONS)).toEqual(sorted(OLD_TEXT_ACTIONS));
    expect(sorted(BLOCKED_WHILE_WAITING)).toEqual(sorted([...OLD_BLOCKED, "wire.profile", "wire.probe"]));
    expect(sorted(actionsWhere("cmdWindow"))).toEqual(sorted(ACTION_COMMANDS));
  });

  test("a command refused while waiting acts on the page; one that acts on the page and is not refused says why", () => {
    for (const [k, m] of Object.entries(TOOL_ACTIONS)) {
      if (m.blockedWhileWaiting || m.cmdWindow || m.defersText) expect({ k, actsOnPage: m.actsOnPage }).toEqual({ k, actsOnPage: true });
      if (m.actsOnPage && !m.blockedWhileWaiting) expect({ k, note: typeof m.note === "string" && m.note.length > 0 }).toEqual({ k, note: true });
    }
  });
});
