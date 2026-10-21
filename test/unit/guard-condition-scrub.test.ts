// `handoff wait --until-text <value>`: the value is the AI's own argument. The
// `cmd` event records it through the known-secret replacement (daemon main.ts,
// docs/04 §8.1 "cmd.input … only references"); the `handoff` {state:"resumed",
// by:"condition", condition} event the guard writes when the condition held
// must carry the same replacement, not the raw value. Expected values: the
// stored secret's placeholder `<secret:example.password>` (secrets.ts).

import { describe, expect, test } from "bun:test";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { Guard, handoffView, type GuardRecorder } from "../../src/daemon/guard.ts";
import { Secrets } from "../../src/daemon/secrets.ts";

const PW = "guard-cond-Pa55word";

class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  constructor(readonly session: string) {}
  onIndexed(_fn: (e: NetEntry) => void): () => void {
    return () => undefined;
  }
  event(kind: "guard" | "handoff", fields: Record<string, unknown>): number | null {
    this.events.push({ kind, ...fields });
    return this.events.length;
  }
  cmdStart(): string | null {
    return null;
  }
  cmdEnd(): void {}
}

function setup(): { g: Guard; rec: FakeRec } {
  const secrets = new Secrets();
  secrets.setStored([{ ref: "example.password", value: PW }]);
  const g = new Guard({
    configDir: "/nonexistent-tabcap-config",
    secrets,
    siteOf: () => ({ site: "example", account: "alice" }),
    screenshot: () => Promise.resolve(null),
    pageInfo: () => Promise.resolve({ url: null, title: null, text: null }),
    settleMs: 0,
  });
  const rec = new FakeRec("w");
  g.recorder = (s) => (s === "w" ? rec : undefined);
  g.takeover("w", { tab: "t1", url: "http://127.0.0.1:9/login", event: "pointerdown", at: 1 }, rec);
  return { g, rec };
}

const resumed = (rec: FakeRec) => rec.events.find((e) => e["kind"] === "handoff" && e["state"] === "resumed");

describe("handoff resumed by a condition: the known-secret replacement", () => {
  test("a --until-text value that is a stored secret is recorded as its placeholder, in the event and in the handoff view", () => {
    const { g, rec } = setup();
    const h = g.resume("w", "condition", null, { kind: "text", value: `Welcome ${PW}` });
    expect(resumed(rec)).toMatchObject({ by: "condition", condition: { kind: "text", value: "Welcome <secret:example.password>" } });
    expect(JSON.stringify(rec.events).includes(PW)).toBe(false);
    expect(handoffView(h)["condition"]).toEqual({ kind: "text", value: "Welcome <secret:example.password>" });
  });

  test("a value with no known secret is recorded as given", () => {
    const { g, rec } = setup();
    g.resume("w", "condition", null, { kind: "url", value: "/home" });
    expect(resumed(rec)).toMatchObject({ condition: { kind: "url", value: "/home" } });
  });
});
