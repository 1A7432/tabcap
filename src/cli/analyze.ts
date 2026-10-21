// `tabcap analyze …`: argument parsing and printing only; the work is in
// src/analyze/ (pure functions over bundle directories, no daemon).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadFamilies } from "../analyze/protection/registry.ts";
import { paths as currentPaths } from "../shared/paths.ts";
import { TabcapError, fail, ok, toFail, type Envelope } from "../shared/envelope.ts";
import { find, renderFindText, type FindResult } from "../analyze/find.ts";
import { appendFinding, appendFindings, type SavedFinding, type SavedFindings } from "../analyze/finding.ts";
import { diff, renderDiffText, type DiffResult } from "../analyze/diff.ts";
import { DepsGraph, depsFindings, depsOf, renderDepsText } from "../analyze/deps.ts";
import { chainOf, renderChainText } from "../analyze/chain.ts";
import { analyzeDossierMask, redactChain, redactDeps, redactDiff, redactDossier } from "../analyze/redact.ts";
import { Secrets } from "../daemon/secrets.ts";
import { Store, storePath } from "../daemon/store/db.ts";
import { buildDossier, reconOutput, recordedPage, renderDossierMd, writeDossier } from "../analyze/recon.ts";
import { parseShapeTypes, renderSchemaDiffText, renderShapeText, schemaDiff, shape, writeShape } from "../analyze/shape.ts";
import { BundleReader } from "../bundle/reader.ts";
import { flagNames, helpFor, parseCommand, specOf, usageOf } from "./commands.ts";

const FIND = specOf("analyze find");
const DIFF = specOf("analyze diff");
const DEPS = specOf("analyze deps");
const CHAIN = specOf("analyze chain");
const RECON = specOf("analyze recon");
const SHAPE = specOf("analyze shape");
const SCHEMA_DIFF = specOf("analyze schema-diff");
export const ANALYZE_USAGE = [usageOf(FIND), usageOf(DIFF), usageOf(DEPS), usageOf(CHAIN), usageOf(RECON), usageOf(SHAPE), usageOf(SCHEMA_DIFF)];

type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };

function split(argv: readonly string[], allowed: readonly string[], usage: string): { pos: string[]; flags: Set<string> } {
  const pos: string[] = [];
  const flags = new Set<string>();
  let rest = false;
  for (const a of argv) {
    if (!rest && a === "--") rest = true;
    else if (!rest && a.startsWith("--")) {
      if (!allowed.includes(a)) throw new TabcapError("usage", `unknown option ${a}`, `Usage: ${usage}`);
      flags.add(a);
    } else pos.push(a);
  }
  return { pos, flags };
}

function findEvidence(r: FindResult): Record<string, unknown>[] {
  if (r.hits.length === 0) return (r.hints?.suspectEncrypted ?? []).map((s) => ({ request: s.ref }));
  return r.hits.map((h) => {
    if (h.kind === "ws") return { ws: h.ref, frame: h.seq };
    if (h.kind === "console") return { console: h.seq };
    return h.path === null ? { request: h.ref } : { request: h.ref, path: h.innerPath === null ? h.path : `${h.path} -> ${h.innerPath}` };
  });
}

function findClaim(r: FindResult): string {
  const q = JSON.stringify(r.query.text);
  if (r.hits.length > 0) {
    const where = r.hits
      .slice(0, 10)
      .map((h) => `${h.kind === "console" ? `console@${h.seq}` : (h.ref ?? "")} [${h.decode.join(",")}]`)
      .join(", ");
    return `${q} found in ${r.hits.length} place(s): ${where}`;
  }
  return `${q} not found in ${r.searched.bodies} bodies, ${r.searched.wsFrames} ws frames, ${r.searched.console} console lines; ${r.hints?.suspectEncrypted.length ?? 0} suspected encrypted`;
}

function cmdFind(argv: readonly string[]): Outcome {
  const usage = ANALYZE_USAGE[0] ?? "";
  const { pos, flags } = split(argv, flagNames(FIND), usage);
  const [bundle, ...words] = pos;
  if (bundle === undefined || words.length === 0) throw new TabcapError("usage", "expected <bundle> <text>", `Usage: ${usage}`);
  const text = words.join(" ");
  const result = find(bundle, text, { ignoreCase: flags.has("--ignore-case") });
  let saved: SavedFinding | null = null;
  if (flags.has("--save")) {
    saved = appendFinding(bundle, {
      actor: "ai",
      tool: "find",
      grade: result.hits.length > 0 ? "实测" : "推断",
      claim: findClaim(result),
      evidence: findEvidence(result),
      input: { text, ignoreCase: result.query.ignoreCase },
      output: { hits: result.hits.length, truncated: result.truncated, searched: result.searched.bodies, suspectEncrypted: result.hints?.suspectEncrypted.map((s) => s.ref) ?? [] },
    });
  }
  const data = { ...result, saved };
  if (flags.has("--text")) {
    const t = renderFindText(result) + (saved === null ? "" : `\nsaved finding seq ${saved.seq} in ${saved.bundle}`);
    return { code: 0, envelope: ok(data), text: t };
  }
  return { code: 0, envelope: ok(data) };
}

function diffClaim(r: DiffResult): string {
  const parts = r.groups.map((g) => {
    const by = (c: string) => g.params.filter((p) => p.class === c).map((p) => (p.location === "query" || p.location === "json" ? p.name : `${p.location} ${p.name}`));
    const classes = ["constant", "constant-or-session", "session", "timestamp", "varying"]
      .map((c) => [c, by(c)] as const)
      .filter(([, names]) => names.length > 0)
      .map(([c, names]) => `${c} ${names.join(", ")}`);
    return `${g.key}: ${classes.join("; ")}`;
  });
  return `${r.bundles.length} recordings, ${r.sessions} session(s). ${parts.join(" | ")}`;
}

function cmdDiff(argv: readonly string[]): Outcome {
  const usage = ANALYZE_USAGE[1] ?? "";
  const { pos, flags } = split(argv, flagNames(DIFF), usage);
  if (pos.length < 2) throw new TabcapError("usage", `expected at least two bundles, got ${pos.length}`, `Usage: ${usage}`);
  const reveal = flags.has("--reveal");
  const result = redactDiff(diff(pos), reveal);
  let saved: SavedFinding | null = null;
  const first = pos[0];
  if (flags.has("--save") && first !== undefined) {
    saved = appendFinding(first, {
      actor: "ai",
      tool: "diff",
      grade: "推断",
      claim: diffClaim(result),
      evidence: result.groups.flatMap((g) => g.requests.filter((q) => q.bundle === result.bundles[0]?.short).map((q) => ({ request: q.id }))),
      input: { bundles: result.bundles.map((b) => ({ dir: b.dir, id: b.id, session: b.sessionKey })) },
      output: { summary: result.summary, groups: result.groups.map((g) => ({ key: g.key, params: g.params.map((p) => ({ location: p.location, name: p.name, class: p.class, hints: p.hints })) })) },
    });
  }
  const data = { ...result, saved };
  if (flags.has("--text")) {
    const t = renderDiffText(result) + (saved === null ? "" : `\nsaved finding seq ${saved.seq} in ${saved.bundle}`);
    return { code: 0, envelope: ok(data), text: t };
  }
  return { code: 0, envelope: ok(data) };
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function cmdDeps(argv: readonly string[]): Outcome {
  const parsed = parseCommand(DEPS, argv);
  if (parsed.help) {
    const text = helpFor(DEPS);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const a = parsed.args;
  const bundle = optStr(a["bundle"]) ?? "";
  const graph = DepsGraph.open(bundle);
  const raw = depsOf(graph, bundle, { session: optStr(a["bundleSession"]), request: optStr(a["request"]) });
  let saved: SavedFindings | null = null;
  if (a["writeFindings"] === true) saved = appendFindings(bundle, depsFindings(graph, raw));
  const result = redactDeps(raw, a["reveal"] === true);
  const data = { ...result, saved };
  if (a["text"] !== true) return { code: 0, envelope: ok(data) };
  const t = renderDepsText(result) + (saved === null ? "" : `\nwrote ${saved.seqs.length} finding event(s) to ${saved.bundle}`);
  return { code: 0, envelope: ok(data), text: t };
}

function cmdChain(argv: readonly string[]): Outcome {
  const parsed = parseCommand(CHAIN, argv);
  if (parsed.help) {
    const text = helpFor(CHAIN);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const a = parsed.args;
  const bundle = optStr(a["bundle"]) ?? "";
  const reveal = a["reveal"] === true;
  const result = redactChain(chainOf(DepsGraph.open(bundle), bundle, { request: optStr(a["request"]), session: optStr(a["bundleSession"]) }), reveal);
  if (a["text"] !== true) return { code: 0, envelope: ok(result) };
  return { code: 0, envelope: ok(result), text: renderChainText(result, { reveal }) };
}

/** The store's known secrets replaced as `<secret:site.field>` (docs/04 §8.1), as the daemon does in every output; identity without a store. */
function storeScrub(configDir: string): (s: string) => string {
  if (!existsSync(storePath(configDir))) return (s) => s;
  const secrets = new Secrets();
  const st = Store.open(configDir);
  try {
    secrets.setStored(st.knownSecrets());
  } finally {
    st.close();
  }
  return (s) => secrets.scrub(s);
}

function cmdRecon(argv: readonly string[]): Outcome {
  const parsed = parseCommand(RECON, argv);
  if (parsed.help) {
    const text = helpFor(RECON);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const bundle = optStr(parsed.args["bundle"]) ?? "";
  const reader = BundleReader.open(bundle);
  // 0.8-A: built-in protection families plus config/protection/ (docs/04 §41.1)
  const { families, warnings } = loadFamilies(join(currentPaths().config, "protection"));
  const built = buildDossier(reader, recordedPage(reader), { families, warnings });
  const dossier = parsed.args["reveal"] === true ? built : redactDossier(built, analyzeDossierMask());
  // docs/04 §22: known store secrets replaced in the files and the answer, also with --reveal (as `tabcap recon`)
  const scrub = storeScrub(currentPaths().config);
  const out: unknown = JSON.parse(scrub(JSON.stringify(reconOutput(dossier, writeDossier(bundle, dossier, scrub)))));
  if (parsed.args["text"] !== true) return { code: 0, envelope: ok(out) };
  return { code: 0, envelope: ok(out), text: scrub(renderDossierMd(dossier).trimEnd()) };
}

function cmdShape(argv: readonly string[]): Outcome {
  const parsed = parseCommand(SHAPE, argv);
  if (parsed.help) {
    const text = helpFor(SHAPE);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const a = parsed.args;
  const bundle = optStr(a["bundle"]) ?? "";
  const result = shape(bundle, { request: optStr(a["request"]), template: optStr(a["template"]), types: parseShapeTypes(optStr(a["types"])) });
  if (a["write"] === true) result.written = writeShape(bundle, result);
  if (a["text"] !== true) return { code: 0, envelope: ok(result) };
  return { code: 0, envelope: ok(result), text: renderShapeText(result) };
}

/** Exit 1 when an endpoint drifted (the envelope is still ok: the comparison itself worked). */
function cmdSchemaDiff(argv: readonly string[]): Outcome {
  const parsed = parseCommand(SCHEMA_DIFF, argv);
  if (parsed.help) {
    const text = helpFor(SCHEMA_DIFF);
    return { code: 0, envelope: ok({ help: text }), text };
  }
  const a = parsed.args;
  const result = schemaDiff(optStr(a["old"]) ?? "", optStr(a["new"]) ?? "", { template: optStr(a["template"]), write: a["write"] === true, types: parseShapeTypes(optStr(a["types"])) });
  const code = result.drift ? 1 : 0;
  if (a["text"] !== true) return { code, envelope: ok(result) };
  return { code, envelope: ok(result), text: renderSchemaDiffText(result) };
}

export async function runAnalyze(argv: readonly string[]): Promise<Outcome> {
  try {
    const [, sub, ...rest] = argv;
    if (sub === undefined || sub === "--help" || argv.includes("--help")) {
      const text = ["Analysis over bundles (no daemon needed):", ...ANALYZE_USAGE.map((u) => `  ${u}`)].join("\n");
      return { code: 0, envelope: ok({ help: text }), text };
    }
    if (sub === "find") return cmdFind(rest);
    if (sub === "diff") return cmdDiff(rest);
    if (sub === "deps") return cmdDeps(rest);
    if (sub === "chain") return cmdChain(rest);
    if (sub === "recon") return cmdRecon(rest);
    if (sub === "shape") return cmdShape(rest);
    if (sub === "schema-diff") return cmdSchemaDiff(rest);
    return { code: 2, envelope: fail("usage", `unknown command: analyze ${sub}`, `Available: ${ANALYZE_USAGE.join(" | ")}`) };
  } catch (e) {
    const env = toFail(e);
    return { code: env.error.code === "usage" ? 2 : 1, envelope: env };
  }
}
