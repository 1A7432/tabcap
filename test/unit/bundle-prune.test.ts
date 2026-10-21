// `tabcap bundle list` / `tabcap bundle prune` (review 10-21, owner decision;
// docs/04 §2, §8.1): both read the store's bundle index (`net start` notes a
// recording, its finish is noted when it ends). list: newest first, id / site /
// session / start / end / bytes / dir / state; prune: --keep N or --older-than
// <duration> picks the oldest recordings, a dry run unless --yes, a recording
// the daemon still has open is never deleted, an index row whose directory is
// gone is forgotten, and anything that is not a bundle directory is left alone.
// The bundles are fake directories (a manifest.json and a blob) in a temp home;
// the oracle is the index rows and the directories the test made.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBundles, parseDuration, planPrune, pruneBundles, renderBundleListText, type BundleListing, type OpenRecordings } from "../../src/cli/bundles.ts";
import { newManifest, writeManifest } from "../../src/bundle/manifest.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { paths, type Paths } from "../../src/shared/paths.ts";
import { POSIX_MODES } from "./_platform.ts";

let root = "";
let p: Paths;
const NONE: OpenRecordings = { dirs: new Set(), reachable: true };
const DAY = 86_400_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-bprune-"));
  p = paths({ TABCAP_HOME: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A bundle directory with a manifest (id `id`), a 1000-byte blob, indexed at `created`. */
function bundle(name: string, created: number, o: { site?: string | null; finished?: number | null; id?: string } = {}): string {
  const dir = join(p.bundles, name);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  const m = newManifest({ id: o.id ?? `ID-${name}`, created });
  writeManifest(dir, m);
  writeFileSync(join(dir, "blobs", "x"), "x".repeat(1000));
  const s = Store.open(p.config);
  try {
    s.noteBundle({ path: dir, site: o.site === undefined ? "example" : o.site, sessionName: name.split("-")[0] ?? null }, created);
    if (o.finished !== null) s.finishBundle(dir, o.finished ?? created + 1000);
  } finally {
    s.close();
  }
  return dir;
}

function indexed(): string[] {
  const s = Store.open(p.config);
  try {
    return s.bundles().map((b) => b.path);
  } finally {
    s.close();
  }
}

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
}

describe("--older-than durations", () => {
  test("s / m / h / d / w; anything else is usage", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("2w")).toBe(14 * DAY);
    for (const bad of ["", "7", "d", "0d", "-1d", "1.5d", "7days", "1y"]) expect(codeOf(() => parseDuration(bad))).toBe("usage");
  });
});

describe("bundle list", () => {
  test("newest first with id, site, session, start, end, bytes, dir and state; --site and --limit", () => {
    const a = bundle("a-1", 1000, { finished: 2000 });
    const b = bundle("b-1", 3000, { site: null, finished: null });
    const c = bundle("c-1", 5000, { site: "other", finished: null });
    const open: OpenRecordings = { dirs: new Set([c]), reachable: true };
    const all = listBundles(p, {}, open);
    expect(all.total).toBe(3);
    expect(all.bundles.map((x) => [x.id, x.dir, x.site, x.session, x.startedAt, x.finishedAt, x.state])).toEqual([
      ["ID-c-1", c, "other", "c", 5000, null, "recording"],
      ["ID-b-1", b, null, "b", 3000, null, "unfinished"],
      ["ID-a-1", a, "example", "a", 1000, 2000, "finished"],
    ]);
    for (const x of all.bundles) expect(x.bytes ?? 0).toBeGreaterThanOrEqual(1000);
    expect(listBundles(p, { site: "example" }, open).bundles.map((x) => x.dir)).toEqual([a]);
    const one = listBundles(p, { limit: 1 }, open);
    expect([one.total, one.bundles.map((x) => x.dir)]).toEqual([3, [c]]);
    expect(codeOf(() => listBundles(p, { limit: 0 }, open))).toBe("usage");
  });

  test("a directory that is gone is listed as missing; --text is one line per bundle", () => {
    const a = bundle("a-1", 1000);
    const gone = bundle("g-1", 2000);
    rmSync(gone, { recursive: true });
    const l = listBundles(p, {}, NONE);
    expect(l.bundles.map((x) => [x.dir, x.state, x.bytes, x.id])).toEqual([
      [gone, "missing", null, null],
      [a, "finished", l.bundles[1]?.bytes ?? -1, "ID-a-1"],
    ]);
    const text = renderBundleListText(l);
    const lines = text.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("missing");
    expect(lines[0]).toContain(gone);
    expect(lines[1]).toContain("1970-01-01T00:00:01Z");
    expect(lines[1]).toContain("finished");
    expect(lines[1]).toContain("example");
    expect(lines[1]).toContain(a);
  });

  test("no store yet: an empty list", () => {
    expect(listBundles(p, {}, NONE)).toMatchObject({ total: 0, bundles: [] });
  });
});

const row = (dir: string, startedAt: number, o: Partial<BundleListing> = {}): BundleListing => ({ id: `ID-${dir}`, dir, site: "example", session: "s", startedAt, finishedAt: startedAt + 1, bytes: 10, state: "finished", ...o });

describe("prune plan (pure)", () => {
  test("--keep N keeps the N newest present bundles; missing rows are forgotten and do not count", () => {
    const rows = [row("/b/1", 1), row("/b/2", 2), row("/b/3", 3), row("/b/gone", 4, { state: "missing", bytes: null, id: null })];
    const plan = planPrune(rows, { keep: 2, now: 10, reachable: true });
    expect(plan.selected.map((x) => x.dir)).toEqual(["/b/1"]);
    expect(plan.kept).toBe(2);
    expect(plan.forgotten).toEqual(["/b/gone"]);
    expect(plan.skipped).toEqual([]);
    expect(planPrune(rows, { keep: 0, now: 10, reachable: true }).selected.map((x) => x.dir)).toEqual(["/b/3", "/b/2", "/b/1"]);
  });

  test("--older-than: started before now - duration", () => {
    const rows = [row("/b/old", 1000), row("/b/new", 9000)];
    expect(planPrune(rows, { olderThanMs: 5000, now: 10_000, reachable: true }).selected.map((x) => x.dir)).toEqual(["/b/old"]);
  });

  test("never a recording still open; an unfinished one only when the daemon could answer; a problem directory is left alone", () => {
    const rows = [
      row("/b/rec", 1, { state: "recording", finishedAt: null }),
      row("/b/crashed", 2, { state: "unfinished", finishedAt: null }),
      row("/b/odd", 3, { problem: "no manifest.json" }),
      row("/b/done", 4),
    ];
    const ok = planPrune(rows, { keep: 0, now: 10, reachable: true });
    expect(ok.selected.map((x) => x.dir)).toEqual(["/b/done", "/b/crashed"]);
    expect(ok.skipped).toEqual([
      { dir: "/b/odd", reason: "no manifest.json" },
      { dir: "/b/rec", reason: "recording: the daemon still writes it (`tabcap net stop` first)" },
    ]);
    const unsure = planPrune(rows, { keep: 0, now: 10, reachable: false });
    expect(unsure.selected.map((x) => x.dir)).toEqual(["/b/done"]);
    expect(unsure.skipped.map((x) => x.dir)).toEqual(["/b/odd", "/b/crashed", "/b/rec"]);
  });
});

describe("bundle prune (disk and index)", () => {
  test("a dry run by default: nothing is deleted, the answer lists what would go and says how", () => {
    const a = bundle("a-1", 1000);
    const b = bundle("a-2", 2000);
    const r = pruneBundles(p, { keep: 1 }, NONE, 10_000);
    expect(r.dryRun).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.selected.map((x) => x.dir)).toEqual([a]);
    expect(r.bytes).toBeGreaterThanOrEqual(1000);
    expect(r.next).toContain("--yes");
    expect([existsSync(a), existsSync(b)]).toEqual([true, true]);
    expect(indexed()).toEqual([a, b]);
  });

  test("--yes deletes the oldest directories and their index rows; forgets rows whose directory is gone; keeps open recordings", () => {
    const a = bundle("a-1", 1000);
    const b = bundle("a-2", 2000, { finished: null });
    const gone = bundle("g-1", 2500);
    rmSync(gone, { recursive: true });
    const c = bundle("a-3", 3000);
    const r = pruneBundles(p, { keep: 0, yes: true }, { dirs: new Set([b]), reachable: true }, 10_000);
    expect(r.dryRun).toBe(false);
    expect(r.deleted).toBe(2);
    expect(r.selected.map((x) => x.dir)).toEqual([c, a]);
    expect(r.forgotten).toEqual([gone]);
    expect(r.skipped.map((x) => x.dir)).toEqual([b]);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([false, true, false]);
    expect(indexed()).toEqual([b]);
  });

  test("--site limits both the selection and the forgetting", () => {
    const a = bundle("a-1", 1000, { site: "example" });
    const o = bundle("o-1", 500, { site: "other" });
    const r = pruneBundles(p, { keep: 0, site: "other", yes: true }, NONE, 10_000);
    expect(r.selected.map((x) => x.dir)).toEqual([o]);
    expect([existsSync(a), existsSync(o)]).toEqual([true, false]);
    expect(indexed()).toEqual([a]);
  });

  test("a directory without manifest.json, or a symlink, is never deleted", () => {
    const a = bundle("a-1", 1000);
    rmSync(join(a, "manifest.json"));
    const target = mkdtempSync(join(tmpdir(), "tabcap-bprune-target-"));
    try {
      writeFileSync(join(target, "manifest.json"), "{}");
      const link = join(p.bundles, "l-1");
      const linked = POSIX_MODES;
      if (linked) {
        symlinkSync(target, link);
        const s = Store.open(p.config);
        s.noteBundle({ path: link, site: "example", sessionName: "l" }, 2000);
        s.finishBundle(link, 2001);
        s.close();
      }
      const r = pruneBundles(p, { keep: 0, yes: true }, NONE, 10_000);
      expect(r.deleted).toBe(0);
      expect(r.skipped.map((x) => x.dir).sort()).toEqual(linked ? [a, link].sort() : [a]);
      expect(existsSync(a)).toBe(true);
      expect(existsSync(join(target, "manifest.json"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("usage: exactly one of --keep / --older-than; --dry-run with --yes; a negative or fractional --keep", () => {
    bundle("a-1", 1000);
    expect(codeOf(() => pruneBundles(p, {}, NONE, 10_000))).toBe("usage");
    expect(codeOf(() => pruneBundles(p, { keep: 1, olderThan: "7d" }, NONE, 10_000))).toBe("usage");
    expect(codeOf(() => pruneBundles(p, { keep: 1, dryRun: true, yes: true }, NONE, 10_000))).toBe("usage");
    expect(codeOf(() => pruneBundles(p, { keep: -1 }, NONE, 10_000))).toBe("usage");
    expect(codeOf(() => pruneBundles(p, { keep: 1.5 }, NONE, 10_000))).toBe("usage");
    expect(codeOf(() => pruneBundles(p, { olderThan: "soon" }, NONE, 10_000))).toBe("usage");
  });
});

describe("the commands (CLI and MCP)", () => {
  test("bundle list --text and bundle prune run from the command line against TABCAP_HOME; prune is a dry run there too", async () => {
    const { run } = await import("../../src/cli/main.ts");
    const a = bundle("a-1", 1000);
    const b = bundle("a-2", 2000);
    const prev = process.env["TABCAP_HOME"];
    process.env["TABCAP_HOME"] = root;
    try {
      const list = await run(["bundle", "list", "--text"]);
      expect(list.code).toBe(0);
      expect(list.text?.split("\n").map((l) => l.slice(l.lastIndexOf(" ") + 1))).toEqual([b, a]);
      const json = await run(["bundle", "list", "--limit", "1"]);
      expect(json.envelope).toMatchObject({ ok: true, data: { total: 2, bundles: [{ dir: b }] } });
      const dry = await run(["bundle", "prune", "--keep", "1"]);
      expect(dry.envelope).toMatchObject({ ok: true, data: { dryRun: true, deleted: 0, selected: [{ dir: a }] } });
      expect(existsSync(a)).toBe(true);
      const real = await run(["bundle", "prune", "--older-than", "1d", "--yes"]);
      expect(real.envelope).toMatchObject({ ok: true, data: { dryRun: false, deleted: 2 } });
      expect([existsSync(a), existsSync(b)]).toEqual([false, false]);
      expect((await run(["bundle", "prune"])).code).toBe(2);
      expect((await run(["bundle", "prune", "--keep", "1", "--bogus"])).code).toBe(2);
    } finally {
      if (prev === undefined) delete process.env["TABCAP_HOME"];
      else process.env["TABCAP_HOME"] = prev;
    }
  });

  test("MCP: bundle list is a tool; bundle prune is for the human (excluded, refused by tabcap_run)", async () => {
    const { EXCLUDED, RUN, buildTools, callTool } = await import("../../src/mcp/tools.ts");
    expect(EXCLUDED["bundle prune"]).toContain("for the human");
    const names = buildTools("all").map((t) => t.def.name);
    expect(names).toContain("tabcap_bundle_list");
    expect(names).not.toContain("tabcap_bundle_prune");
    const run = buildTools("core").find((t) => t.def.name === RUN);
    if (run === undefined) throw new Error("no tabcap_run");
    const calls: string[][] = [];
    const env = await callTool(run, { argv: ["bundle", "prune", "--keep", "0", "--yes"] }, async (argv) => {
      calls.push(argv);
      return { ok: true, data: {} };
    });
    expect(env).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(calls).toEqual([]);
  });
});
