import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { BLOCKED_WHILE_WAITING, CONTINUE_NEXT, Guard, challengeOf, waitingError, type GuardRecorder } from "../../src/daemon/guard.ts";
import { ACTION_COMMANDS } from "../../src/daemon/state.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const PW = "guard-test-Pa55word";

let root = "";
let config = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-guard-"));
  config = join(root, "config");
  mkdirSync(join(config, "plugins"), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function entry(o: Partial<NetEntry>): NetEntry {
  return { id: "r-9", tab: "tab-1", type: "fetch", method: "GET", url: "http://127.0.0.1:9/api/limited", status: 200, mime: "application/json", size: 10, outcome: "finished", blob: null, bodyMissing: null, cmd: null, at: 0, ...o };
}

/** A recording stand-in: collects events and cmd pairs in order. */
class FakeRec implements GuardRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  private fns = new Set<(e: NetEntry) => void>();
  private n = 0;
  constructor(readonly session: string) {}
  onIndexed(fn: (e: NetEntry) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(e: NetEntry): void {
    for (const f of this.fns) f(e);
  }
  event(kind: "guard" | "handoff", fields: Record<string, unknown>): number | null {
    this.events.push({ kind, ...fields });
    return ++this.n;
  }
  cmdStart(c: { tab: string | null; argv: string[] | null; input: Record<string, unknown>; actor?: "ai" | "human" | "system" }): string | null {
    const id = `c-${++this.n}`;
    this.events.push({ kind: "cmd", phase: "start", id, ...c });
    return id;
  }
  cmdEnd(id: string, c: Record<string, unknown>): void {
    this.events.push({ kind: "cmd", phase: "end", ref: id, ...c });
  }
}

function guard(text = "page text"): { g: Guard; secrets: Secrets } {
  const secrets = new Secrets();
  secrets.setStored([{ ref: "shop.password", value: PW }]);
  const g = new Guard({
    configDir: config,
    secrets,
    siteOf: () => ({ site: "shop", account: "alice" }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    pageInfo: () => Promise.resolve({ url: "http://127.0.0.1:9/s15", title: "verify", text }),
    settleMs: 0,
  });
  return { g, secrets };
}

describe("challenge detection (docs/05 s15)", () => {
  test("an HTML 403 to xhr / fetch / document is a verify page; nothing else is", () => {
    expect(challengeOf(entry({ status: 403, mime: "text/html" }))).toBe("verify-page");
    expect(challengeOf(entry({ status: 403, mime: "text/html", type: "document" }))).toBe("verify-page");
    expect(challengeOf(entry({ status: 403, mime: "application/json" }))).toBeNull();
    expect(challengeOf(entry({ status: 403, mime: "text/html", type: "image" }))).toBeNull();
    expect(challengeOf(entry({ status: 200, mime: "text/html" }))).toBeNull();
    expect(challengeOf(entry({ status: 403, mime: "text/html", outcome: "failed" }))).toBeNull();
  });
});

describe("guard: waiting state", () => {
  test("trip → breaker, waiting with screenshot; page commands blocked (also navigate to that origin from other sessions); continue resumes", async () => {
    const { g } = guard();
    const rec = new FakeRec("s");
    g.recorder = () => rec;
    g.watch(rec);
    rec.emit(entry({ status: 200 }));
    expect(g.get("s")).toBeNull();
    rec.emit(entry({ id: "r-12", status: 403, mime: "text/html" }));
    expect(g.get("s")?.state).toBe("waiting"); // blocked synchronously, before the screenshot
    rec.emit(entry({ id: "r-13", status: 403, mime: "text/html" })); // no second trip while waiting
    await g.settle();
    expect(g.blocking("s", "click", null)?.request).toBe("r-12");
    expect(g.blocking("s", "snapshot", null)).toBeNull();
    expect(g.blocking("other", "navigate", "http://127.0.0.1:9/elsewhere")?.session).toBe("s");
    expect(g.blocking("other", "navigate", "http://127.0.0.1:10/")).toBeNull();
    expect(g.waitingNotice("s")).toEqual({ state: "waiting", reason: "verify-page", screenshot: "/tmp/shot.png", next: CONTINUE_NEXT });
    expect(rec.events.map((e) => [e["kind"], e["event"] ?? e["state"]])).toEqual([
      ["guard", "breaker"],
      ["handoff", "waiting"],
    ]);
    expect(rec.events[0]).toMatchObject({ site: "shop", account: "alice", detail: { reason: "verify-page", request: "r-12", status: 403 } });
    expect(rec.events[1]).toMatchObject({ reason: "verify-page", question: expect.any(String), timeoutMs: null, answerRef: null, screenshot: "/tmp/shot.png" });
    expect(CONTINUE_NEXT).toContain("tabcap handoff continue");
    expect(g.resume("s", "human").state).toBe("resumed");
    expect(g.blocking("s", "click", null)).toBeNull();
    expect(rec.events[2]).toMatchObject({ kind: "handoff", state: "resumed", by: "human" });
    let code = "";
    try {
      g.resume("s", "human");
    } catch (e) {
      code = e instanceof TabcapError ? e.code : "other";
    }
    expect(code).toBe("not-found");
    for (const a of ["navigate", "click", "fill", "type", "press", "go", "reload", "evaluate", "dialog"]) expect(BLOCKED_WHILE_WAITING.has(a)).toBe(true);
  });

  test("resize and emulate are blocked while waiting (0.4) with the same waiting error; they are not action commands", async () => {
    const { g } = guard();
    const rec = new FakeRec("s");
    g.recorder = () => rec;
    g.watch(rec);
    rec.emit(entry({ id: "r-21", status: 403, mime: "text/html" }));
    await g.settle();
    for (const action of ["resize", "emulate"]) {
      const h = g.blocking("s", action, null);
      expect(h?.request).toBe("r-21");
      if (h === null) throw new Error("not blocked");
      const e = waitingError(h);
      expect(e.code).toBe("waiting");
      expect(e.next).toBe(CONTINUE_NEXT);
      expect(e.message).toBe(waitingError(g.blocking("s", "click", null) ?? h).message);
      expect(ACTION_COMMANDS.has(action)).toBe(false);
    }
    g.resume("s", "human");
    expect(g.blocking("s", "resize", null)).toBeNull();
    expect(g.blocking("s", "emulate", null)).toBeNull();
  });
});
