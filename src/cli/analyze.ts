// `tabcap analyze …`: the commands over parsed arguments (the command
// registry parses them; the handler table, src/cli/handlers.ts, runs these
// and prints); the work is in src/analyze/ (pure functions over bundle
// directories, no daemon).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadFamilies } from "../analyze/protection/registry.ts";
import { find, renderFindText, type FindResult } from "../analyze/find.ts";
import { appendFinding, appendFindings, type SavedFinding, type SavedFindings } from "../analyze/finding.ts";
import { diff, renderDiffText, type DiffResult } from "../analyze/diff.ts";
import { DepsGraph, depsFindings, depsOf, renderDepsText, type DepsResult } from "../analyze/deps.ts";
import { chainOf, type ChainResult } from "../analyze/chain.ts";
import { analyzeDossierMask, redactChain, redactDeps, redactDiff, redactDossier } from "../analyze/redact.ts";
import { Secrets } from "../daemon/secrets.ts";
import { Store, storePath } from "../daemon/store/db.ts";
import { buildDossier, reconOutput, recordedPage, renderDossierMd, writeDossier, type Dossier } from "../analyze/recon.ts";
import { parseShapeTypes, schemaDiff, shape, writeShape, type SchemaDiffResult, type ShapeResult } from "../analyze/shape.ts";
import { BundleReader } from "../bundle/reader.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A result and the finding event it was saved as (find / diff: --save, deps: --write-findings); the answer is both in one object. */
export type WithSaved<R, S> = { result: R; saved: S | null };
export const answerWithSaved = <R extends object, S>(r: WithSaved<R, S>): R & { saved: S | null } => ({ ...r.result, saved: r.saved });
const savedLine = (saved: SavedFinding | null): string => (saved === null ? "" : `\nsaved finding seq ${saved.seq} in ${saved.bundle}`);

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

/** `tabcap analyze find <bundle> <text…>`: the positional `text` shares its key with --text, which the handler reads from the flags given. */
export function analyzeFind(a: Record<string, unknown>): WithSaved<FindResult, SavedFinding> {
  const bundle = str(a["bundle"]) ?? "";
  const text = str(a["text"]) ?? "";
  const result = find(bundle, text, { ignoreCase: a["ignoreCase"] === true });
  let saved: SavedFinding | null = null;
  if (a["save"] === true) {
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
  return { result, saved };
}

export const findText = (r: WithSaved<FindResult, SavedFinding>): string => renderFindText(r.result) + savedLine(r.saved);

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

/** `tabcap analyze diff <bundle1> <bundle2> [<bundles>…]`. */
export function analyzeDiff(a: Record<string, unknown>): WithSaved<DiffResult, SavedFinding> {
  const pos = [str(a["bundle1"]) ?? "", str(a["bundle2"]) ?? "", ...strs(a["bundles"])];
  const reveal = a["reveal"] === true;
  const result = redactDiff(diff(pos), reveal);
  let saved: SavedFinding | null = null;
  const first = pos[0];
  if (a["save"] === true && first !== undefined) {
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
  return { result, saved };
}

export const diffText = (r: WithSaved<DiffResult, SavedFinding>): string => renderDiffText(r.result) + savedLine(r.saved);

/** `tabcap analyze deps <bundle>`. */
export function analyzeDeps(a: Record<string, unknown>): WithSaved<DepsResult, SavedFindings> {
  const bundle = str(a["bundle"]) ?? "";
  const graph = DepsGraph.open(bundle);
  const raw = depsOf(graph, bundle, { session: str(a["bundleSession"]), request: str(a["request"]) });
  let saved: SavedFindings | null = null;
  if (a["writeFindings"] === true) saved = appendFindings(bundle, depsFindings(graph, raw));
  return { result: redactDeps(raw, a["reveal"] === true), saved };
}

export const depsText = (r: WithSaved<DepsResult, SavedFindings>): string => renderDepsText(r.result) + (r.saved === null ? "" : `\nwrote ${r.saved.seqs.length} finding event(s) to ${r.saved.bundle}`);

/** `tabcap analyze chain <bundle>`. */
export function analyzeChain(a: Record<string, unknown>): ChainResult {
  const bundle = str(a["bundle"]) ?? "";
  return redactChain(chainOf(DepsGraph.open(bundle), bundle, { request: str(a["request"]), session: str(a["bundleSession"]) }), a["reveal"] === true);
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

/** The offline recon: its answer (`out`), and what --text prints (the dossier as Markdown, store secrets replaced). */
export type ReconAnswer = { out: unknown; dossier: Dossier; scrub: (s: string) => string };

/** `tabcap analyze recon <bundle>`: writes exports/dossier.json and .md. */
export function analyzeRecon(a: Record<string, unknown>, configDir: string): ReconAnswer {
  const bundle = str(a["bundle"]) ?? "";
  const reader = BundleReader.open(bundle);
  // 0.8-A: built-in protection families plus config/protection/ (docs/04 §41.1)
  const { families, warnings } = loadFamilies(join(configDir, "protection"));
  const built = buildDossier(reader, recordedPage(reader), { families, warnings });
  const dossier = a["reveal"] === true ? built : redactDossier(built, analyzeDossierMask());
  // docs/04 §22: known store secrets replaced in the files and the answer, also with --reveal (as `tabcap recon`)
  const scrub = storeScrub(configDir);
  const out: unknown = JSON.parse(scrub(JSON.stringify(reconOutput(dossier, writeDossier(bundle, dossier, scrub)))));
  return { out, dossier, scrub };
}

export const reconText = (r: ReconAnswer): string => r.scrub(renderDossierMd(r.dossier).trimEnd());

/** `tabcap analyze shape <bundle>`. */
export function analyzeShape(a: Record<string, unknown>): ShapeResult {
  const bundle = str(a["bundle"]) ?? "";
  const result = shape(bundle, { request: str(a["request"]), template: str(a["template"]), types: parseShapeTypes(str(a["types"])) });
  if (a["write"] === true) result.written = writeShape(bundle, result);
  return result;
}

/** `tabcap analyze schema-diff <old> <new>`; exit 1 when an endpoint drifted (the envelope is still ok: the comparison itself worked). */
export function analyzeSchemaDiff(a: Record<string, unknown>): SchemaDiffResult {
  return schemaDiff(str(a["old"]) ?? "", str(a["new"]) ?? "", { template: str(a["template"]), write: a["write"] === true, types: parseShapeTypes(str(a["types"])) });
}
