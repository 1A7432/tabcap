// Outside the default session, what tabcap tells the agent or the human to run
// names the session (review 10-21; the wave-1 rule of docs/04 §39 for
// waiting / guard.stopped / fetch.stopped `next`): `handoff continue` on a
// session that is not waiting points at `tabcap handoff status --session <s>`,
// and the take-over question recorded on the handoff event says
// `tabcap handoff continue --session <s>`. The default session stays without
// the flag. Oracle: the command lines themselves (src/cli/commands.ts SESSION).

import { describe, expect, test } from "bun:test";
import type { DaemonEventKind, NetEntry } from "../../src/daemon/capture/recorder.ts";
import type { EventFields } from "../../src/bundle/types.ts";
import { Guard, type GuardRecorder } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  constructor(readonly session: string) {}
  onIndexed(_fn: (e: NetEntry) => void): () => void {
    return () => undefined;
  }
  event<K extends DaemonEventKind>(kind: K, fields: EventFields[K]): number | null {
    this.events.push({ kind, ...fields });
    return this.events.length;
  }
  cmdStart(): string | null {
    return null;
  }
  cmdEnd(): void {}
}

const guard = () =>
  new Guard({
    configDir: "/nonexistent-tabcap-config",
    secrets: new Secrets(),
    siteOf: () => null,
    screenshot: () => Promise.resolve(null),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
  });

function nextOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof TabcapError) return `${e.code}: ${e.next}`;
    throw e;
  }
  throw new Error("expected an error");
}

describe("--session in the hints of a non-default session", () => {
  test("handoff continue with nothing to continue", () => {
    const g = guard();
    expect(nextOf(() => g.resume("work", "human"))).toBe("not-found: Nothing to continue; run `tabcap handoff status --session work`.");
    expect(nextOf(() => g.resume("default", "human"))).toBe("not-found: Nothing to continue; run `tabcap handoff status`.");
  });

  test("the take-over question on the handoff event", () => {
    for (const [session, cmd] of [
      ["work", "tabcap handoff continue --session work"],
      ["default", "tabcap handoff continue"],
    ] as const) {
      const g = guard();
      const rec = new FakeRec(session);
      g.takeover(session, { tab: "t1", url: "http://127.0.0.1:9/", event: "pointerdown", at: 1 }, rec);
      const ev = rec.events.find((e) => e["kind"] === "handoff" && e["state"] === "waiting");
      expect(ev?.["question"]).toBe(`You are using the AI's tab; when you are done, tell the AI to continue (\`${cmd}\`).`);
    }
  });
});
