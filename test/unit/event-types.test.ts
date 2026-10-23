// src/bundle/types.ts is the write-side contract of the event kinds and mirrors
// docs/04 §4 (review wave 3). Oracle: docs/04 itself. The records below are
// typed by the contract, so the compiler fails when a kind or a guard event is
// added to types.ts without them, and the tests fail when docs/04 names one
// types.ts does not have (or the other way round).
// Reproduce: bun test test/unit/event-types.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventKind, GuardFields, HandoffFields } from "../../src/bundle/types.ts";
import type { Recorder } from "../../src/daemon/capture/recorder.ts";
import { REPO_ROOT } from "./_fixtures.ts";

const DOC = readFileSync(join(REPO_ROOT, "docs", "04-evidence-bundle-spec-v0.md"), "utf8");

/** The text of one `## n.` section of docs/04. */
function section(n: number): string {
  const start = DOC.indexOf(`\n## ${n}. `);
  const end = DOC.indexOf(`\n## ${n + 1}. `);
  if (start < 0 || end < 0) throw new Error(`docs/04 has no section ${n}`);
  return DOC.slice(start, end);
}

const KINDS: Record<EventKind, true> = {
  session: true,
  tab: true,
  nav: true,
  request: true,
  ws: true,
  sse: true,
  download: true,
  cmd: true,
  console: true,
  action: true,
  screenshot: true,
  state: true,
  finding: true,
  note: true,
  signal: true,
  handoff: true,
  confirm: true,
  guard: true,
  protection: true,
};

const GUARD_EVENTS: Record<GuardFields["event"], true> = { budget: true, breaker: true, probe: true, resume: true, end: true, challenge: true };

const HANDOFF_STATES: Record<HandoffFields["state"], true> = { waiting: true, "human-active": true, resumed: true };

describe("types.ts mirrors docs/04 §4", () => {
  test("the event kinds docs/04 §4 defines (bold kind names) are the keys of EventFields", () => {
    const named = [...section(4).matchAll(/\*\*`([a-z]+)`\*\*/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(Object.keys(KINDS)));
  });

  test("the guard event names of §4.2 are the `event` values of GuardFields", () => {
    const line = section(4).split("\n").find((l) => l.startsWith("- **`guard`**")) ?? "";
    const head = /\{event:((?:"[a-z-]+"\|?)+), site, account, detail\}/.exec(line)?.[1] ?? "";
    expect(new Set(head.split("|").map((s) => s.replaceAll('"', "")))).toEqual(new Set(Object.keys(GUARD_EVENTS)));
  });

  test("the handoff states of §4.2 are the `state` values of HandoffFields", () => {
    const line = section(4).split("\n").find((l) => l.startsWith("- **`handoff`**")) ?? "";
    const head = /\{state:((?:"[a-z-]+"\|?)+), reason/.exec(line)?.[1] ?? "";
    expect(new Set(head.split("|").map((s) => s.replaceAll('"', "")))).toEqual(new Set(Object.keys(HANDOFF_STATES)));
  });
});

/**
 * Recorder.event is typed by kind: `bun run typecheck` fails as soon as one of
 * these calls compiles again (each `@ts-expect-error` must see an error).
 * Never called.
 */
export function driftedWrites(r: Pick<Recorder, "event">): void {
  // @ts-expect-error a handoff field docs/04 §4.2 does not define
  r.event("handoff", { state: "waiting", reason: "verify-page", question: "q", timeoutMs: null, answerRef: null, request: null, url: "u", screenshot: null, extra: 1 });
  // @ts-expect-error a guard end event without its detail (§38)
  r.event("guard", { event: "end", site: "s", account: null, rule: "x", request: "r-1" });
  // @ts-expect-error a `by` §4.2 / §39 do not list
  r.event("handoff", { state: "resumed", reason: "verify-page", question: null, timeoutMs: null, answerRef: null, by: "someone" });
  // @ts-expect-error the take-over input is always trusted (§37)
  r.event("action", { op: "input", event: "keydown", at: 1, target: null, value: null, phase: "done", error: null, shots: null, nav: null, trusted: false });
  // @ts-expect-error a protection category §41 does not have
  r.event("protection", { nav: null, url: "u", detections: [{ family: "f", name: "n", category: "bot", confidence: 1, matched: [] }] });
  // @ts-expect-error `request` events are the recorder's own, numbered by their seq
  r.event("request", {});
}
