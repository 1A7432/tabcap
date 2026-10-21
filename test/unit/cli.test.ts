import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/main.ts";
import { SAMPLE_FIXTURE_DIR, buildRichBundle, buildSampleBundle } from "./_fixtures.ts";
import { expectMode } from "./_platform.ts";

const tmp = (p = "tabcap-cli-") => mkdtempSync(join(tmpdir(), p));

describe("tabcap bundle (JSON envelope)", () => {
  test("info reports counts and completeness", async () => {
    const { code, envelope } = await run(["bundle", "info", SAMPLE_FIXTURE_DIR]);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ format: "evidence-bundle/0", complete: true, events: 8, truncatedLastLine: false, warnings: [] });
  });

  test("unknown command -> usage error with next", async () => {
    const { code, envelope } = await run(["frobnicate"]);
    expect(code).toBe(2);
    expect(envelope).toMatchObject({ ok: false, error: { code: "usage" } });
    if (envelope.ok) throw new Error("expected failure");
    // 0.7-C: nothing is close to `frobnicate`: the groups, not the 8 KB list
    expect(envelope.error.next).toContain("tabcap --help");
    expect(envelope.error.next).not.toContain("tabcap bundle info");
  });

  test("missing bundle -> not-found with next", async () => {
    const { code, envelope } = await run(["bundle", "info", join(tmpdir(), "no-such-bundle-tabcap")]);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  test("export har (redacted by default) writes the HAR and the salt in the source exports/", async () => {
    const dir = tmp("tabcap-rich-");
    await buildRichBundle(dir);
    const out = join(tmp(), "x.har");
    const { code, envelope } = await run(["bundle", "export", "har", dir, "--out", out, "--types", "xhr,fetch"]);
    expect(code).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ out, entries: 3, redacted: true, saltFile: join(dir, "exports", "x.salt") });
    expect(existsSync(join(dir, "exports", "x.salt"))).toBe(true);
    expect(readFileSync(out, "utf8")).not.toContain("hunter2secret");
    // docs/04 §17: the HAR (and its salt) are owner-only, also when replacing a wider file
    expectMode(out, 0o600);
    expectMode(join(dir, "exports", "x.salt"), 0o600);
    const wide = join(tmp(), "wide.har");
    writeFileSync(wide, "{}", { mode: 0o644 });
    expect((await run(["bundle", "export", "har", dir, "--out", wide, "--no-redact"])).code).toBe(0);
    expectMode(wide, 0o600);
  });

  test("export --no-redact, import har, redact, info: end to end on files", async () => {
    const dir = tmp("tabcap-sample-");
    await buildSampleBundle(dir);
    const har = join(tmp(), "s.har");
    expect((await run(["bundle", "export", "har", dir, "--out", har, "--no-redact", "--embed-events"])).code).toBe(0);
    const imported = join(tmp(), "imported");
    const imp = await run(["bundle", "import", "har", har, "-o", imported]);
    expect(imp.envelope).toMatchObject({ ok: true, data: { restoredFromEvents: true, events: 8 } });
    const red = join(tmp(), "red");
    expect((await run(["bundle", "redact", imported, red])).code).toBe(0);
    const info = await run(["bundle", "info", red]);
    expect(info.envelope).toMatchObject({ ok: true, data: { events: 8, redaction: { rules: "default@3" } } });
  });

  test("unfinished bundle with truncated tail: info warns", async () => {
    const dir = tmp();
    await buildSampleBundle(dir);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    delete m.finished;
    await Bun.write(join(dir, "manifest.json"), JSON.stringify(m));
    await Bun.write(join(dir, "events.jsonl"), readFileSync(join(dir, "events.jsonl"), "utf8") + '{"seq":9,');
    const { envelope } = await run(["bundle", "info", dir]);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.data).toMatchObject({ complete: false, truncatedLastLine: true });
    expect(JSON.stringify(envelope.data)).toContain("bundle is not finished");
  });
});
