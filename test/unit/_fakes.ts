// Test doubles shared by L0 tests.
//
// FakeRec stands in for a session's Recorder where the guard and the take-over
// need one (GuardRecorder: session, onIndexed, event, cmdStart, cmdEnd). It
// takes the same typed fields as Recorder.event (bundle/types.ts EventFields),
// collects what they write in `events`, and `emit()` plays a recorded request
// to the onIndexed listeners. The options cover the ways the tests differ:
// whether cmd windows have ids and leave events, what stored event a listener
// receives with each request, and whether event() keeps its tab / actor / cmd
// options. Without options it is the quietest recorder: no cmd windows, the
// request alone.

import type { DaemonEventKind, NetEntry } from "../../src/daemon/capture/recorder.ts";
import type { GuardRecorder } from "../../src/daemon/guard.ts";
import type { Actor, EventFields } from "../../src/bundle/types.ts";

export type FakeRecOptions = {
  /**
   * cmdStart(): "none" (default) answers null and records nothing; "id"
   * answers c-<seq> from the counter event() also counts with, records
   * nothing; "record" also records { kind: "cmd", phase: "start", id, ...c }
   * and cmdEnd() records { kind: "cmd", phase: "end", ref: id, ...c }.
   */
  cmd?: "none" | "id" | "record";
  /**
   * The stored event emit() hands each onIndexed listener after the request:
   * "none" (default) none at all; "empty" {}; "timing" { response: { charset:
   * "utf-8" }, timing } whose `end` is emit()'s `end` (default: one more than
   * the last), `start` end - 0.5, `responseStart` end - 0.2.
   */
  indexed?: "none" | "empty" | "timing";
  /** event() also records its options as _tab (tab ?? null), _actor (actor ?? "system") and _cmd (null when cmd: null, else "window"). */
  eventOptions?: boolean;
};

export class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  private fns = new Set<(e: NetEntry, ev?: Record<string, unknown>) => void>();
  /** One counter for event() seqs and cmd ids, as a bundle's seq. */
  private n = 0;
  private clock = 0;

  constructor(
    readonly session: string,
    private readonly o: FakeRecOptions = {},
  ) {}

  onIndexed(fn: (e: NetEntry, ev?: Record<string, unknown>) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  /** Play one recorded request to the onIndexed listeners; `end` is its completion (CDP mono ms) under indexed: "timing". */
  emit(e: NetEntry, end?: number): NetEntry {
    const mode = this.o.indexed ?? "none";
    if (mode === "timing") this.clock = end ?? this.clock + 1;
    for (const f of this.fns) {
      if (mode === "none") f(e);
      else if (mode === "empty") f(e, {});
      else f(e, { response: { charset: "utf-8" }, timing: { start: this.clock - 0.5, responseStart: this.clock - 0.2, end: this.clock } });
    }
    return e;
  }

  event<K extends DaemonEventKind>(kind: K, fields: EventFields[K], o: { tab?: string | null; actor?: Actor; cmd?: null } = {}): number | null {
    this.events.push(this.o.eventOptions === true ? { kind, ...fields, _tab: o.tab ?? null, _actor: o.actor ?? "system", _cmd: o.cmd === null ? null : "window" } : { kind, ...fields });
    return ++this.n;
  }

  cmdStart(c: { tab: string | null; argv: string[] | null; input: Record<string, unknown>; actor?: Actor }): string | null {
    const mode = this.o.cmd ?? "none";
    if (mode === "none") return null;
    const id = `c-${++this.n}`;
    if (mode === "record") this.events.push({ kind: "cmd", phase: "start", id, ...c });
    return id;
  }

  cmdEnd(id: string, c: Record<string, unknown>): void {
    if (this.o.cmd === "record") this.events.push({ kind: "cmd", phase: "end", ref: id, ...c });
  }
}
