// 0.5-C context budget: output budget (summary + file above
// TABCAP_OUTPUT_LIMIT, --full), the output filters (--select / --grep /
// --fields), the help index and `tabcap help <group>`. The numbers (16384,
// 30, 12000, 8 KB (6 KB until 0.6 added fetch / plugin commands), 50, 256) are the owner's decision of 2026-10-16.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BUDGET_EXEMPT, OUTPUT_LIMIT_DEFAULT, applyBudget, commandSlug, genericSummary, isBudgeted, outputLimit, summaryOf, writeOutputFile } from "../../src/shared/budget.ts";
import { applyFilters, compileGrep, filterOptions, grepLines, parseFields, parsePath, projectFields, selectPath } from "../../src/shared/filter.ts";
import { COMMAND_GROUPS, COMMANDS, COMMON_FLAGS, GROUP_SUMMARY_CHARS, SUGGEST_MAX, closestCommands, currentCommands, editDistance, groupSummary, groupedCommands, helpAll, helpFor, helpTopic, indexSummary, schema, specOf, usageOf, OUTPUT_FLAGS_NOT_ON } from "../../src/cli/commands.ts";
import { run, takeOutputFlags } from "../../src/cli/main.ts";
import { SNAPSHOT_MAX_CHARS } from "../../src/daemon/tools/snapshot.ts";
import { OUTLINE_MAX_CHARS } from "../../src/daemon/tools/outline.ts";
import { DEFAULT_PAGE_SIZE } from "../../src/shared/pagination.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { SAMPLE_FIXTURE_DIR } from "./_fixtures.ts";
import { CORE } from "../../src/mcp/tools.ts";
import { SLOW_IO_MS } from "./_platform.ts";

const tmp = mkdtempSync(join(tmpdir(), "tabcap-budget-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }), SLOW_IO_MS);

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
  return "none";
};

describe("output limit (TABCAP_OUTPUT_LIMIT)", () => {
  test("default 16384; a whole number overrides it; 0 turns the budget off; junk falls back", () => {
    expect(OUTPUT_LIMIT_DEFAULT).toBe(16384);
    expect(outputLimit({})).toBe(16384);
    expect(outputLimit({ TABCAP_OUTPUT_LIMIT: "4096" })).toBe(4096);
    expect(outputLimit({ TABCAP_OUTPUT_LIMIT: "0" })).toBe(Number.POSITIVE_INFINITY);
    for (const junk of ["", "-1", "1e3", "lots", "12.5"]) expect(outputLimit({ TABCAP_OUTPUT_LIMIT: junk })).toBe(16384);
  });
});

describe("applyBudget", () => {
  const big = { schema: "x/0", bundle: "/b", ok: true, n: 3, items: Array.from({ length: 400 }, (_, i) => ({ id: `r-${i}`, pad: "p".repeat(40) })), meta: { a: 1, b: 2 }, long: "l".repeat(500) };
  const cacheTarget = (dir: string) => () => Promise.resolve({ cache: dir });

  test("under the limit: data unchanged and nothing written", async () => {
    const dir = join(tmp, "under");
    const small = { a: 1 };
    expect(await applyBudget("analyze find", small, { limit: 100, full: false, target: cacheTarget(dir) })).toBe(small);
    expect(() => readdirSync(dir)).toThrow();
  });

  test("over the limit: {summary, file, bytes, truncated}; the file holds the whole data (0600)", async () => {
    const dir = join(tmp, "over");
    const out = await applyBudget("analyze find", big, { limit: 1000, full: false, target: cacheTarget(dir), now: Date.UTC(2026, 9, 16, 12, 0, 0) });
    if (!isBudgeted(out)) throw new Error("expected the budget form");
    expect(Object.keys(out).sort()).toEqual(["bytes", "file", "summary", "truncated"]);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(Buffer.byteLength(JSON.stringify(big)));
    expect(JSON.parse(readFileSync(out.file, "utf8"))).toEqual(big);
    // a native path (docs/04 §24): `\` on Windows, like every path in an answer
    expect(dirname(out.file)).toBe(join(dir, "outputs"));
    expect(basename(out.file)).toMatch(/^\d{8}-\d{6}-analyze-find\.json$/);
    if (process.platform !== "win32") expect(statSync(out.file).mode & 0o777).toBe(0o600);
    // generic summary: scalars kept, arrays / objects / long strings by their length; analyze find adds its own (0.7-C)
    expect(out.summary).toMatchObject({ schema: "x/0", bundle: "/b", ok: true, n: 3, items: 400, meta: 2, long: 500, hitCount: 0, hits: [] });
  });

  test("--full, exempt commands and a limit of Infinity print everything", async () => {
    const t = cacheTarget(join(tmp, "never"));
    expect(await applyBudget("analyze find", big, { limit: 10, full: true, target: t })).toBe(big);
    for (const c of ["net list", "console list", "snapshot", "schema"]) {
      expect(BUDGET_EXEMPT.has(c)).toBe(true);
      expect(await applyBudget(c, big, { limit: 10, full: false, target: t })).toBe(big);
    }
    expect(await applyBudget("recon", big, { limit: Number.POSITIVE_INFINITY, full: false, target: t })).toBe(big);
  });

  test("file naming: exports/<command>-<seq>.json in a bundle (seq counts up), <stamp>-<command>[-n].json in the cache", () => {
    const bundle = join(tmp, "bundle");
    mkdirSync(join(bundle, "exports"), { recursive: true });
    writeFileSync(join(bundle, "exports", "where-7.json"), "{}");
    expect(writeOutputFile({ bundle }, "where", "{}")).toBe(join(bundle, "exports", "where-8.json"));
    expect(writeOutputFile({ bundle }, "where", "{}")).toBe(join(bundle, "exports", "where-9.json"));
    expect(writeOutputFile({ bundle }, "analyze deps", "{}")).toBe(join(bundle, "exports", "analyze-deps-1.json"));
    const cache = join(tmp, "cache");
    const now = new Date(2026, 9, 16, 9, 5, 7).getTime();
    expect(writeOutputFile({ cache }, "trace list", "{}", now)).toBe(join(cache, "outputs", "20261016-090507-trace-list.json"));
    expect(writeOutputFile({ cache }, "trace list", "{}", now)).toBe(join(cache, "outputs", "20261016-090507-trace-list-2.json"));
    expect(commandSlug("fingerprint ref show")).toBe("fingerprint-ref-show");
  });
});

describe("summaries", () => {
  test("generic: a non-object data says its type and length", () => {
    expect(genericSummary([1, 2, 3])).toEqual({ type: "array", length: 3 });
    expect(genericSummary("abc")).toEqual({ type: "string", length: 3 });
    expect(genericSummary({ a: null, b: "s", c: [1], d: { x: 1 } })).toEqual({ a: null, b: "s", c: 1, d: 1 });
  });

  test("analyze deps: inputs per request and the unresolved count", () => {
    const data = {
      schema: "tabcap-deps/0",
      bundle: "/b",
      requests: [
        { id: "r-1", method: "GET", url: "u", inputs: [{}, {}] },
        { id: "r-2", method: "POST", url: "u", inputs: [] },
      ],
      edges: [{}],
      unresolved: [{}, {}, {}],
      warnings: [],
    };
    expect(summaryOf("analyze deps", data)).toEqual({ schema: "tabcap-deps/0", bundle: "/b", requests: 2, edges: 1, unresolved: 3, warnings: 0, inputs: { "r-1": 2, "r-2": 0 }, inputCount: 2, unresolvedFirst: [{}, {}, {}] });
  });

  test("recon: the dossier summary block; trace list: API × script counts; where: the top 5 candidates", () => {
    const recon = { dossier: "/b/exports/dossier.json", markdown: "/b/exports/dossier.md", receipt: { dossier: "exports/dossier.json" }, page: { url: "u" }, summary: { channels: 4, requests: 9 }, warnings: [] };
    expect(summaryOf("recon", recon)).toMatchObject({ dossier: "/b/exports/dossier.json", summary: { channels: 4, requests: 9 }, page: { url: "u" } });
    const trace = { session: "s", rows: [{ api: "navigator.userAgent", access: "get", script: "https://x/a.js", count: 3, documents: 1, callers: [{}], truncated: false, value: true }], totals: { rows: 1, reads: 3 } };
    expect(summaryOf("trace list", trace)).toEqual({ session: "s", rowCount: 1, rows: [{ api: "navigator.userAgent", script: "https://x/a.js", count: 3 }], totals: { rows: 1, reads: 3 } });
    const cands = Array.from({ length: 8 }, (_, i) => ({ request: `r-${i}`, chain: [], match: "exact", score: 1 - i / 10 }));
    const where = summaryOf("where", { schema: "tabcap-where/0", query: { input: "1", kind: "text", text: "1" }, normalized: [], candidates: cands });
    expect(where["candidates"]).toEqual(cands.slice(0, 5));
    expect(where["candidateCount"]).toBe(8);
    expect(where["query"]).toEqual({ input: "1", kind: "text", text: "1" });
  });
});

describe("--select", () => {
  test("paths: dotted keys, [n], [*]; bad ones are usage errors", () => {
    expect(parsePath("requests[0].headers.x-csrf")).toEqual([{ kind: "key", key: "requests" }, { kind: "index", index: 0 }, { kind: "key", key: "headers" }, { kind: "key", key: "x-csrf" }]);
    expect(parsePath("[*].id")).toEqual([{ kind: "all" }, { kind: "key", key: "id" }]);
    for (const bad of ["", "a..b", "a.", ".a", "a[", "a[x]", "a[-1]", "a]b", "a b", "a".repeat(257), Array.from({ length: 33 }, () => "k").join(".")]) expect(codeOf(() => parsePath(bad))).toBe("usage");
  });

  test("a plain path gives one value or not-found; [*] gives every match", () => {
    const data = { requests: [{ id: "r-1", url: "/a" }, { id: "r-2" }, { id: "r-3", url: "/c" }], total: 3 };
    expect(selectPath(data, "requests[2].url", parsePath("requests[2].url"))).toEqual({ value: "/c", count: null });
    expect(selectPath(data, "requests[*].url", parsePath("requests[*].url"))).toEqual({ value: ["/a", "/c"], count: 2 });
    expect(codeOf(() => selectPath(data, "requests[1].url", parsePath("requests[1].url")))).toBe("not-found");
    expect(codeOf(() => selectPath(data, "nope", parsePath("nope")))).toBe("not-found");
    expect(codeOf(() => selectPath(data, "total.x", parsePath("total.x")))).toBe("not-found");
  });
});

describe("--grep", () => {
  test("bounded: ≤ 256 characters, u flag, a bad expression is a usage error (never thrown out)", () => {
    expect(compileGrep("a.c").flags).toContain("u");
    expect(codeOf(() => compileGrep("x".repeat(257)))).toBe("usage");
    expect(codeOf(() => compileGrep("("))).toBe("usage");
    expect(codeOf(() => compileGrep("\\p{Nope}"))).toBe("usage");
    expect(codeOf(() => compileGrep(""))).toBe("usage");
  });

  test("a text field: matching lines with line numbers and --context lines around them", () => {
    const body = ["<html>", "<head>", "<title>t</title>", "</head>", "<body>", "token=abc", "<p>x</p>", "</body>", "</html>", "token=def"].join("\n");
    const b = { left: 50, matches: 0, total: 0, capped: false };
    expect(grepLines(body, compileGrep("token"), 2, b)).toEqual([
      { line: 4, text: "</head>", match: false },
      { line: 5, text: "<body>", match: false },
      { line: 6, text: "token=abc", match: true },
      { line: 7, text: "<p>x</p>", match: false },
      { line: 8, text: "</body>", match: false },
      { line: 9, text: "</html>", match: false },
      { line: 10, text: "token=def", match: true },
    ]);
    expect(b).toEqual({ left: 48, matches: 2, total: 10, capped: false });
  });

  test("an array: keep the elements whose JSON matches; --max-matches caps them, matches counts all", () => {
    const data = { total: 4, requests: [{ url: "/api/a" }, { url: "/x" }, { url: "/api/b" }, { url: "/api/c" }] };
    const r = applyFilters(data, filterOptions({ grep: "/api/", maxMatches: "2" }));
    expect(r.data).toEqual({ total: 4, requests: [{ url: "/api/a" }, { url: "/api/b" }] });
    expect(r.filter).toEqual({ select: null, grep: "/api/", fields: null, matches: 3, total: 4, capped: true });
  });

  test("in an object, long or multi-line strings are grepped by line; short scalars stay", () => {
    const data = { id: "r-1", path: "/tmp/b", textPreview: "one\ntwo token\nthree" };
    const r = applyFilters(data, filterOptions({ grep: "token", context: "1" }));
    expect(r.data).toEqual({ id: "r-1", path: "/tmp/b", textPreview: [{ line: 1, text: "one", match: false }, { line: 2, text: "two token", match: true }, { line: 3, text: "three", match: false }] });
    expect(r.filter.matches).toBe(1);
  });

  test("count options are bounded and go with --grep only", () => {
    expect(filterOptions({ grep: "x" })).toMatchObject({ context: 0, maxMatches: 50 });
    for (const raw of [{ grep: "x", context: "21" }, { grep: "x", maxMatches: "0" }, { grep: "x", maxMatches: "1001" }, { grep: "x", context: "-1" }, { grep: "x", context: "two" }, { context: "2" }]) expect(codeOf(() => filterOptions(raw))).toBe("usage");
  });
});

describe("--fields", () => {
  test("projects each array element (the array itself or the object's array fields) to the keys", () => {
    expect(parseFields(" id, url ,id")).toEqual(["id", "url"]);
    expect(codeOf(() => parseFields(" , "))).toBe("usage");
    const rows = [{ id: "r-1", method: "GET", url: "/a", size: 3 }, { id: "r-2", url: "/b" }, "x"];
    expect(projectFields(rows, ["id", "url"])).toEqual([{ id: "r-1", url: "/a" }, { id: "r-2", url: "/b" }, "x"]);
    expect(projectFields({ total: 2, requests: rows.slice(0, 2) }, ["id"])).toEqual({ total: 2, requests: [{ id: "r-1" }, { id: "r-2" }] });
    expect(projectFields({ id: "r-1", method: "GET" }, ["method"])).toEqual({ method: "GET" });
  });

  test("order: select → grep → fields", () => {
    const data = { requests: [{ id: "r-1", method: "GET", url: "/api/a" }, { id: "r-2", method: "POST", url: "/x" }] };
    const r = applyFilters(data, filterOptions({ select: "requests", grep: "/api/", fields: "id,method" }));
    expect(r.data).toEqual([{ id: "r-1", method: "GET" }]);
    expect(r.filter).toEqual({ select: "requests", grep: "/api/", fields: ["id", "method"], matches: 1, total: 2, capped: false });
  });
});

describe("output flags in the CLI", () => {
  test("taken out of argv before the command parser, up to --; --full stays on screenshot", () => {
    const t = takeOutputFlags(["net", "list", "--grep", "/api/", "--fields=id,url", "--full", "--session", "s1"]);
    expect(t.rest).toEqual(["net", "list", "--session", "s1"]);
    expect(t.out).toMatchObject({ full: true, filters: { grep: "/api/", fields: ["id", "url"], select: null } });
    expect(takeOutputFlags(["evaluate", "--", "--grep", "x"]).rest).toEqual(["evaluate", "--", "--grep", "x"]);
    expect(takeOutputFlags(["screenshot", "--full"]).rest).toEqual(["screenshot", "--full"]);
    expect(codeOf(() => takeOutputFlags(["net", "list", "--grep"]))).toBe("usage");
    expect(codeOf(() => takeOutputFlags(["net", "list", "--select", "a", "--select", "b"]))).toBe("usage");
  });

  test("schema lists them once as sharedFlags (screenshot is not on --full), not per command", () => {
    const s = schema();
    expect(s.sharedFlags.map((f) => f.flag)).toEqual(["--select", "--grep", "--context", "--max-matches", "--fields", "--full"]);
    expect(s.sharedFlags.find((f) => f.flag === "--full")?.notOn).toEqual(["screenshot"]);
    // a command may carry a shared flag name only where OUTPUT_FLAGS_NOT_ON hands that flag to the command (0.5-F in-command search)
    for (const c of s.commands) for (const f of c.flags) if (["--select", "--grep", "--fields", "--full", "--context", "--max-matches"].includes(f.flag)) expect(OUTPUT_FLAGS_NOT_ON[f.flag] ?? []).toContain(c.path.join(" "));
  });

  test("on an offline command: filters record `filter` (and `selected`); over the limit the summary + file form, --full everything", async () => {
    const home = join(tmp, "home");
    const prev = { home: process.env["TABCAP_HOME"], limit: process.env["TABCAP_OUTPUT_LIMIT"] };
    process.env["TABCAP_HOME"] = home;
    try {
      const sel = await run(["bundle", "info", SAMPLE_FIXTURE_DIR, "--select", "kinds"]);
      expect(sel.envelope).toMatchObject({ ok: true, selected: "kinds", filter: { select: "kinds", grep: null, fields: null, matches: null, total: null } });
      process.env["TABCAP_OUTPUT_LIMIT"] = "200";
      const over = await run(["bundle", "info", SAMPLE_FIXTURE_DIR]);
      if (!over.envelope.ok) throw new Error(JSON.stringify(over.envelope));
      expect(over.envelope.data).toMatchObject({ truncated: true, summary: { format: expect.any(String), complete: true } });
      const file = (over.envelope.data as { file: string }).file;
      expect(file.startsWith(join(home, "cache", "outputs"))).toBe(true);
      const whole = await run(["bundle", "info", SAMPLE_FIXTURE_DIR, "--full"]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(whole.envelope.ok ? whole.envelope.data : null)));
      const bad = await run(["bundle", "info", SAMPLE_FIXTURE_DIR, "--grep", "("]);
      expect(bad.code).toBe(2);
      expect(bad.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
      const text = await run(["schema", "--json", "--grep", "x"]);
      expect(text.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
    } finally {
      if (prev.home === undefined) delete process.env["TABCAP_HOME"];
      else process.env["TABCAP_HOME"] = prev.home;
      if (prev.limit === undefined) delete process.env["TABCAP_OUTPUT_LIMIT"];
      else process.env["TABCAP_OUTPUT_LIMIT"] = prev.limit;
    }
  });
});

describe("help index (tabcap --help) and tabcap help <command|group>", () => {
  test("at most 8 KB, one line per user command, grouped as gen:docs groups them", () => {
    const text = helpAll();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    const lines = text.split("\n").filter((l) => l.startsWith("  ") && !l.startsWith("   "));
    const names = currentCommands().map((c) => c.path.join(" "));
    for (const n of names) expect(lines.filter((l) => l.startsWith(`  ${n}  `)).length).toBe(1);
    const titles = text.split("\n").filter((l) => /^[A-Z].*\[[a-z]+\]:$/.test(l));
    expect(titles.map((t) => t.replace(/ \[[a-z]+\]:$/, ""))).toEqual(groupedCommands().map((g) => g.title));
    // regular groups in table order, then the leftover "Other", then the `last` groups (0.6-E: diagnostics at the end)
    const ids = groupedCommands().map((g) => g.id);
    const regular = COMMAND_GROUPS.filter((g) => g.last !== true).map((g) => g.id);
    expect(ids).toEqual([...regular, ...(ids.includes("other") ? ["other"] : []), ...COMMAND_GROUPS.filter((g) => g.last === true).map((g) => g.id)]);
    expect(ids[ids.length - 1]).toBe("diagnostics");
    expect(groupedCommands().find((g) => g.id === "diagnostics")?.title).toBe("Diagnostics (optional)");
    // the MCP core set and SKILL.md leave the diagnostics out (0.6-E: verified, unchanged)
    const DIAG = ["trace", "fingerprint", "wire"];
    expect(Object.keys(CORE).filter((k) => DIAG.includes(k.split(" ")[0] ?? ""))).toEqual([]);
    const skill = readFileSync(join(import.meta.dir, "..", "..", "skills", "tabcap", "SKILL.md"), "utf8");
    for (const w of DIAG) expect([w, new RegExp(`tabcap ${w}\\b|\`${w} [a-z]`).test(skill)]).toEqual([w, false]);
    expect(text).not.toContain("daemon run");
  });

  test("index summaries: first clause, at most 60 characters", () => {
    for (const c of currentCommands()) expect(indexSummary(c.summary).length).toBeLessThanOrEqual(60);
    expect(indexSummary("a short one; more")).toBe("a short one");
    expect(indexSummary("x (y) z")).toBe("x z");
  });

  test("help <command> is the per-command help; help <group> one entry per command, no option tables (0.7-C)", async () => {
    expect((await run(["help", "snapshot"])).text).toBe(helpFor(specOf("snapshot")));
    const net = (await run(["help", "network"])).text ?? "";
    // 0.7-C: 13 KB before; the target is under 4 KB
    expect(Buffer.byteLength(net)).toBeLessThan(4 * 1024);
    for (const c of groupedCommands().find((g) => g.id === "network")?.commands ?? []) expect(net).toContain(`  ${usageOf(c, COMMON_FLAGS)}\n      ${groupSummary(c.summary)}`);
    expect(net).not.toContain("Options:");
    expect(net).not.toContain("Example:");
    expect(net).not.toContain("[--session");
    expect(net).toContain("tabcap help <command>");
    expect((await run(["net", "--help"])).text).toContain("tabcap net list [--filter s]");
    expect((await run(["help", "lifecycle"])).text).toContain("tabcap daemon start");
    for (const g of groupedCommands()) expect([g.id, Buffer.byteLength(helpTopic(g.id) ?? "") < 8 * 1024]).toEqual([g.id, true]);
  });

  test("group summaries: the first clause outside parentheses, at most 160 characters", () => {
    expect(groupSummary("a (b; c) d; e")).toBe("a (b; c) d");
    expect(groupSummary("one. two")).toBe("one");
    expect(groupSummary("v1.2 stays")).toBe("v1.2 stays");
    for (const c of currentCommands()) expect(groupSummary(c.summary).length).toBeLessThanOrEqual(GROUP_SUMMARY_CHARS);
  });

  test("an unknown command names the closest commands, never the whole list (0.7-C)", async () => {
    expect(closestCommands(["trac", "status"])[0]).toBe("tabcap trace status");
    expect(closestCommands(["net", "lst"])[0]).toBe("tabcap net list");
    expect(closestCommands(["snapshoot"])).toEqual(["tabcap snapshot"]);
    expect(closestCommands(["press", "Enter"])).toEqual(["tabcap press-key"]);
    expect(closestCommands(["console"])).toEqual(["tabcap console list", "tabcap console show"]);
    expect(closestCommands(["tabs"]).every((c) => c.startsWith("tabcap tab "))).toBe(true);
    expect(closestCommands(["frobnicate"])).toEqual([]);
    expect(closestCommands(["net", "x"]).length).toBe(SUGGEST_MAX);
    expect(closestCommands(["bundle", "inf"], 3, [["bundle", "info"], ["bundle", "redact"]])[0]).toBe("tabcap bundle info");
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    for (const argv of [["frobnicate"], ["trac", "status"], ["bundle", "inf", "x"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      if (r.envelope.ok) throw new Error("expected failure");
      expect(r.envelope.error.next).toContain("tabcap --help");
      expect(Buffer.byteLength(JSON.stringify(r.envelope))).toBeLessThan(512);
    }
    const trac = await run(["trac", "status"]);
    if (trac.envelope.ok) throw new Error("expected failure");
    expect(trac.envelope.error.next).toContain("Did you mean: tabcap trace status");
  });
});

describe("defaults", () => {
  test("net list / console list page 30; snapshot --max-chars 12000; outline stays 6000", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(30);
    expect(specOf("net list").flags.find((f) => f.flag === "--page-size")?.default).toBe(30);
    expect(specOf("console list").flags.find((f) => f.flag === "--page-size")?.default).toBe(30);
    expect(SNAPSHOT_MAX_CHARS).toBe(12000);
    expect(specOf("snapshot").flags.find((f) => f.flag === "--max-chars")?.default).toBe(12000);
    expect(OUTLINE_MAX_CHARS).toBe(6000);
  });
});
