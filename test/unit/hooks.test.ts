import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NetEntry } from "../../src/daemon/capture/recorder.ts";
import { Guard, type GuardRecorder } from "../../src/daemon/guard.ts";
import { HOOK_PROTOCOL, listPlugins, parseChallengeOutput, parseManifest, pluginsFor, readEnabled, resolveCommand, runHook, setEnabled, type PluginManifest } from "../../src/daemon/hooks/plugins.ts";
import { Secrets } from "../../src/daemon/secrets.ts";
import { POSIX_MODES } from "./_platform.ts";

const FAKE = join(import.meta.dir, "..", "fixtures", "plugins", "fake-verify");
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
  secrets.setStored([{ ref: "example.password", value: PW }]);
  const g = new Guard({
    configDir: config,
    secrets,
    siteOf: () => ({ site: "example", account: "alice" }),
    screenshot: () => Promise.resolve("/tmp/shot.png"),
    pageInfo: () => Promise.resolve({ url: "http://127.0.0.1:9/s15", title: "verify", text }),
    settleMs: 0,
  });
  return { g, secrets };
}

function install(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(config, "plugins", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

describe("plugin manifests and discovery", () => {
  test("parseManifest accepts the documented shape and rejects the rest", () => {
    const m = parseManifest({ name: "x", version: "1", description: "d", hooks: ["challenge"], command: ["./run"], timeoutMs: 500 }, "x");
    expect(m).toEqual({ name: "x", version: "1", description: "d", hooks: ["challenge"], command: ["./run"], timeoutMs: 500 });
    expect(parseManifest({ name: "x", hooks: ["challenge"], command: ["bun"] }, "x").timeoutMs).toBe(10_000);
    const bad: unknown[] = [
      null,
      { name: "x", hooks: ["challenge"], command: ["a"] }, // wrong dir below
      { name: "X Y", hooks: ["challenge"], command: ["a"] },
      { name: "x", hooks: [], command: ["a"] },
      { name: "x", hooks: ["login"], command: ["a"] },
      { name: "x", hooks: ["challenge"], command: [] },
      { name: "x", hooks: ["challenge"], command: [1] },
      { name: "x", hooks: ["challenge"], command: ["a"], timeoutMs: 999_999 },
    ];
    bad.forEach((b, i) => expect(() => parseManifest(b, i === 1 ? "y" : "x")).toThrow("plugin manifest"));
  });

  test("list shows invalid ones with errors; enable needs a valid one; only enabled ones are used", () => {
    install("good", { name: "good", hooks: ["challenge"], command: ["bun", "./h.ts"] });
    install("broken", { name: "nope", hooks: ["challenge"], command: ["x"] });
    mkdirSync(join(config, "plugins", "empty"), { mode: 0o700 });
    const l = listPlugins(config);
    expect(l.map((p) => [p.name, p.manifest !== null, p.enabled])).toEqual([
      ["broken", false, false],
      ["empty", false, false],
      ["good", true, false],
    ]);
    expect(l.find((p) => p.name === "empty")?.error).toBe("no manifest.json");
    expect(pluginsFor(config, "challenge")).toEqual([]);
    expect(() => setEnabled(config, "broken", true)).toThrow("not usable");
    expect(() => setEnabled(config, "missing", true)).toThrow("no plugin");
    setEnabled(config, "good", true);
    expect(readEnabled(config)).toEqual(["good"]);
    expect(pluginsFor(config, "challenge").map((p) => p.name)).toEqual(["good"]);
    setEnabled(config, "good", false);
    expect(pluginsFor(config, "challenge")).toEqual([]);
  });

  test.skipIf(!POSIX_MODES)("a plugin directory writable by others is refused", () => {
    const dir = install("loose", { name: "loose", hooks: ["challenge"], command: ["bun"] });
    chmodSync(dir, 0o777);
    expect(listPlugins(config)[0]?.error).toContain("writable by group or others");
  });

  test("commands stay inside the plugin directory", () => {
    expect(resolveCommand("/p/x", ["./run.sh", "a"])).toEqual([resolve("/p/x/run.sh"), "a"]);
    expect(resolveCommand("/p/x", ["bun", "./h.ts"])).toEqual(["bun", "./h.ts"]);
    expect(() => resolveCommand("/p/x", ["../y/run"])).toThrow("outside");
    expect(() => resolveCommand("/p/x", ["sub/run"])).toThrow("relative");
  });
});

describe("runHook: out of process, JSON on stdin / stdout", () => {
  const m = (command: string[], timeoutMs = 5000): PluginManifest => ({ name: "t", version: "0", description: "", hooks: ["challenge"], command, timeoutMs });

  test("the test-only fake handler round-trips", async () => {
    const r = await runHook({ dir: FAKE, manifest: m(["bun", "./handler.ts"]) }, { protocol: HOOK_PROTOCOL, hook: "challenge", site: "example", page: { text: "tabcap-e2e-verify-wall 请完成验证" } });
    expect(r.ok).toBe(true);
    expect(parseChallengeOutput(r.output)).toMatchObject({ decision: "answer", answer: { code: "4217" } });
    const other = await runHook({ dir: FAKE, manifest: m(["bun", "./handler.ts"]) }, { hook: "challenge", page: { text: "a real site" } });
    expect(parseChallengeOutput(other.output).decision).toBe("handoff");
  });

  test("timeout, crash and garbage all mean hand to the human", async () => {
    const dir = install("t", {});
    writeFileSync(join(dir, "sleep.ts"), "await Bun.sleep(5000); export {};");
    writeFileSync(join(dir, "crash.ts"), "process.stderr.write('boom'); process.exit(3);");
    writeFileSync(join(dir, "garbage.ts"), "process.stdout.write('not json');");
    const slow = await runHook({ dir, manifest: m(["bun", "./sleep.ts"], 300) }, {});
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    expect(slow.durationMs).toBeLessThan(3000);
    const crash = await runHook({ dir, manifest: m(["bun", "./crash.ts"]) }, {});
    expect(crash).toMatchObject({ ok: false, exitCode: 3, stderr: "boom" });
    const garbage = await runHook({ dir, manifest: m(["bun", "./garbage.ts"]) }, {});
    expect(garbage).toMatchObject({ ok: false, error: "stdout is not one JSON value" });
    const missing = await runHook({ dir, manifest: m(["/nonexistent/handler"]) }, {});
    expect(missing.ok).toBe(false);
    expect(parseChallengeOutput({ decision: "answer" }).decision).toBe("handoff");
    expect(parseChallengeOutput("x").decision).toBe("handoff");
  });

  test("guard asks enabled handlers; the cmd pair is scrubbed both ways; an answer resumes", async () => {
    // input side: the page text holds the password; output side: the handler prints it on its own
    const dir = install("leaky", { name: "leaky", hooks: ["challenge"], command: ["bun", "./h.ts"] });
    writeFileSync(join(dir, "h.ts"), `const i = JSON.parse(await Bun.stdin.text()); process.stdout.write(JSON.stringify({ decision: "answer", answer: { code: "4217", leak: ${JSON.stringify(PW)} }, note: i.page.text })); export {};`);
    setEnabled(config, "leaky", true);
    const { g } = guard(`tabcap-e2e-verify-wall pw=${PW}`);
    const rec = new FakeRec("s");
    g.recorder = () => rec;
    g.watch(rec);
    rec.emit(entry({ id: "r-6", status: 403, mime: "text/html" }));
    await g.settle();
    const all = JSON.stringify(rec.events);
    expect(all).not.toContain(PW);
    const start = rec.events.find((e) => e["kind"] === "cmd" && e["phase"] === "start");
    const end = rec.events.find((e) => e["kind"] === "cmd" && e["phase"] === "end");
    expect(start).toMatchObject({ actor: "system", argv: ["plugin:leaky", "bun", "./h.ts"], input: { hook: "challenge", plugin: "leaky", payload: { protocol: HOOK_PROTOCOL, reason: "verify-page", site: "example" } } });
    expect(JSON.stringify(start)).toContain("<secret:example.password>");
    expect(end).toMatchObject({ ok: true, actor: "system", outputSummary: { decision: "answer", output: { answer: { code: "4217", leak: "<secret:example.password>" } } } });
    const h = g.get("s");
    expect(h?.state).toBe("resumed");
    expect(h?.resumedBy).toBe("plugin:leaky");
    expect(h?.handlers[0]).toMatchObject({ plugin: "leaky", status: "answered", answer: { code: "4217", leak: "<secret:example.password>" } });
    expect(rec.events.at(-1)).toMatchObject({ kind: "handoff", state: "resumed", answerRef: start?.["id"] });
    expect(g.takeNotice("s")).toMatchObject({ state: "resumed", resumedBy: "plugin:leaky" });
    expect(g.takeNotice("s")).toBeNull(); // shown once
  });

  test("the fake fixture can be installed like any user handler", () => {
    cpSync(FAKE, join(config, "plugins", "fake-verify"), { recursive: true });
    expect(listPlugins(config)[0]).toMatchObject({ name: "fake-verify", error: null, manifest: { hooks: ["challenge"] } });
  });
});
