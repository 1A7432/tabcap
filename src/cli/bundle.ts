// `tabcap bundle export har | import har | redact | info | decode | export
// fixtures`: offline tools over evidence bundles (docs/04), no daemon. The
// arguments come parsed by the command registry (commands.ts, parseCommand);
// the handler table (handlers.ts) runs these. `bundle list` / `bundle prune`
// read the store's bundle index and live in bundles.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exportHar, importHar } from "../bundle/har.ts";
import { computeCounts, writeFileAtomic } from "../bundle/manifest.ts";
import { BundleReader } from "../bundle/reader.ts";
import { newSalt, redactBundle, writeSalt } from "../bundle/redact.ts";
import { decodeBundle } from "../bundle/decode.ts";
import { exportFixtures } from "../bundle/fixtures.ts";
import { parseBusinessRule, parseUsageActor, usageReport, type UsageReport } from "../bundle/usage.ts";
import { DecodeHost, DecodeSession, type DecodePlugin } from "../daemon/hooks/decode.ts";
import type { FixturePlugin } from "../daemon/hooks/fixture.ts";
import { asDecodePlugin, asFixturePlugin, decodePlugins, listPlugins, pluginsDir } from "../daemon/hooks/plugins.ts";
import { Secrets, variantsOf } from "../daemon/secrets.ts";
import { Store, storePath } from "../daemon/store/db.ts";
import { readRulesFile, rulesInfo } from "../replay/rules.ts";
import { TabcapError } from "../shared/envelope.ts";
import { paths, type Paths } from "../shared/paths.ts";
import { compactStamp, nowMs } from "../shared/time.ts";
import { usageOf, type CommandSpec } from "./commands.ts";
import { bundleRules } from "./replay.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Secret values of the local store (docs/04 §8.1: redaction also removes them by value). */
function storeSecrets(): string[] {
  const p = paths();
  if (!existsSync(storePath(p.config))) return [];
  const s = Store.open(p.config);
  try {
    // raw, JSON, URI and form spellings: a login POST body carries the form-encoded one
    return [...new Set(s.knownSecrets().flatMap((k) => variantsOf(k.value)))];
  } finally {
    s.close();
  }
}

/** `tabcap bundle export har <bundle> [--out f] [--tab t] [--types a,b] [--embed-events] [--no-redact] [--rules f]`. */
export function bundleExportHar(args: Record<string, unknown>): unknown {
  const dir = str(args["bundle"]) ?? "";
  const reader = BundleReader.open(dir);
  const now = nowMs();
  const out = str(args["out"]) ?? join(dir, "exports", `har-${compactStamp(now)}.har`);
  const redact = args["noRedact"] !== true;
  const salt = redact ? newSalt() : null;
  const tab = str(args["tab"]);
  const typesFlag = str(args["types"]);
  const rulesFile = str(args["rules"]);
  // 0.6-C: --rules only drops each rule's ignoreQuery parameters (no config.json fallback here).
  const rules = rulesFile === undefined ? undefined : readRulesFile(rulesFile);
  const res = exportHar(reader, {
    ...(tab === undefined ? {} : { tab }),
    ...(typesFlag === undefined ? {} : { types: typesFlag.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    embedEvents: args["embedEvents"] === true,
    redact: salt === null ? false : { salt, knownSecrets: storeSecrets() },
    ...(rules === undefined ? {} : { rules }),
  });
  // docs/04 §17: HAR exports are 0600 like the rest of the bundle (they can carry live values with --no-redact).
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileAtomic(out, JSON.stringify(res.har, null, 2) + "\n", 0o600);
  const saltFile = salt === null ? null : writeSalt(dir, basename(out).replace(/\.har$/i, ""), salt);
  return {
    out,
    pages: res.pages,
    entries: res.entries,
    redacted: res.redacted,
    saltFile,
    dropped: res.dropped,
    skipped: res.skipped,
    ...(rules === undefined ? {} : { rules: rulesInfo(rules) }),
    complete: reader.isComplete(),
    warnings: [
      ...(reader.isComplete() ? [] : ["bundle is not finished: recording in progress or interrupted"]),
      ...(reader.truncatedLastLine ? ["events.jsonl ends with a truncated line; it was skipped"] : []),
      ...(redact ? ["redaction is rule based; free text in bodies may still hold personal data, review before sharing"] : []),
    ],
  };
}

/** `tabcap bundle import har <file> -o <bundle>`. */
export function bundleImportHar(args: Record<string, unknown>, spec: CommandSpec): unknown {
  const file = str(args["file"]) ?? "";
  const out = str(args["out"]);
  if (out === undefined) throw new TabcapError("usage", "missing -o <bundle>", `Usage: ${usageOf(spec)}`);
  if (!existsSync(file)) throw new TabcapError("not-found", `HAR file not found: ${file}`, "Check the path of the .har file.");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw new TabcapError("bad-input", `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "Export the HAR again; the file may be truncated.");
  }
  return importHar(json, out, { name: basename(file).replace(/\.har$/i, "") });
}

/** `tabcap bundle redact <in> <out>`. */
export async function bundleRedact(args: Record<string, unknown>): Promise<unknown> {
  const res = await redactBundle(str(args["in"]) ?? "", str(args["out"]) ?? "", { knownSecrets: storeSecrets() });
  return { ...res, warnings: ["redaction is rule based; free text in bodies may still hold personal data, review before sharing"] };
}

/** `tabcap bundle decode <bundle> [--plugin name]` (0.6-B, bundle/decode.ts). */
export async function bundleDecode(p: Paths, args: Record<string, unknown>): Promise<unknown> {
  const dir = str(args["bundle"]) ?? "";
  const config = p.config;
  const name = str(args["plugin"]);
  let plugins: DecodePlugin[];
  if (name !== undefined) {
    const info = listPlugins(config).find((x) => x.name === name);
    if (info === undefined) throw new TabcapError("not-found", `no plugin named "${name}" in ${pluginsDir(config)}`, "Install it in its own directory with a manifest.json, then `tabcap plugin list`.");
    if (info.manifest === null) throw new TabcapError("bad-input", `plugin "${name}" is not usable: ${info.error ?? "invalid"}`, "Fix its manifest.json; `tabcap plugin list` shows the error.");
    plugins = asDecodePlugin(info);
    if (plugins.length === 0) throw new TabcapError("usage", `plugin "${name}" is not a decode plugin`, 'Decode plugins have "kind": "decode" in manifest.json (docs/04 §28).');
  } else {
    plugins = decodePlugins(config);
    if (plugins.length === 0) throw new TabcapError("not-found", "no enabled decode plugin", "Install one under the plugins directory and `tabcap plugin enable <name>`, or pass --plugin <name>.");
  }
  const secrets = new Secrets();
  if (existsSync(storePath(config))) {
    const s = Store.open(config);
    try {
      secrets.setStored(s.knownSecrets());
    } finally {
      s.close();
    }
  }
  const host = new DecodeHost();
  const disabled: { plugin: string; reason: string }[] = [];
  const session = new DecodeSession(host, plugins, { scrub: (t) => secrets.scrub(t), onDisabled: (plugin, reason) => disabled.push({ plugin, reason }) });
  try {
    const res = await decodeBundle(dir, session);
    return { ...res, plugins: plugins.map((x) => ({ name: x.name, version: x.version })), disabled };
  } finally {
    await host.close();
  }
}

/** `tabcap bundle export fixtures <bundle> --out <dir> [--rules f] [--format json|plugin] [--no-redact]` (0.6-C, bundle/fixtures.ts). */
export async function bundleExportFixtures(p: Paths, args: Record<string, unknown>, spec: CommandSpec): Promise<unknown> {
  const dir = str(args["bundle"]) ?? "";
  const out = str(args["out"]);
  if (out === undefined) throw new TabcapError("usage", "missing --out <dir>", `Usage: ${usageOf(spec)}`);
  const reader = BundleReader.open(dir);
  const config = p.config;
  const formatName = str(args["format"]) ?? "json";
  let format: "json" | FixturePlugin = "json";
  if (formatName !== "json") {
    const info = listPlugins(config).find((x) => x.name === formatName);
    if (info === undefined) throw new TabcapError("not-found", `no plugin named "${formatName}" in ${pluginsDir(config)}`, 'Pass --format json, or install a fixture plugin (manifest.json with "kind": "fixture", docs/04 §31), then `tabcap plugin list`.');
    if (info.manifest === null) throw new TabcapError("bad-input", `plugin "${formatName}" is not usable: ${info.error ?? "invalid"}`, "Fix its manifest.json; `tabcap plugin list` shows the error.");
    const fp = asFixturePlugin(info)[0];
    if (fp === undefined) throw new TabcapError("usage", `plugin "${formatName}" is not a fixture plugin`, 'Fixture plugins have "kind": "fixture" in manifest.json (docs/04 §31).');
    format = fp;
  }
  const rules = bundleRules(dir, str(args["rules"]));
  const redact = args["noRedact"] !== true;
  const salt = redact ? newSalt() : null;
  const res = await exportFixtures(reader, { out, rules, format, redact: salt === null ? false : { salt, knownSecrets: storeSecrets() }, configDir: config, includePreflight: args["includePreflight"] === true });
  const saltFile = salt === null ? null : writeSalt(dir, `fixtures-${compactStamp(nowMs())}`, salt);
  return {
    ...res,
    saltFile,
    complete: reader.isComplete(),
    warnings: [...(reader.isComplete() ? [] : ["bundle is not finished: recording in progress or interrupted"]), ...(reader.truncatedLastLine ? ["events.jsonl ends with a truncated line; it was skipped"] : []), ...res.warnings],
  };
}

/** `tabcap bundle info <bundle>`: the summary, or with --usage the account-usage report (the only one --text renders). */
export function bundleInfo(args: Record<string, unknown>, spec: CommandSpec): { usage: UsageReport } | { info: Record<string, unknown> } {
  const dir = str(args["bundle"]) ?? "";
  const wantUsage = args["usage"] === true;
  if (!wantUsage && ["text", "businessCode", "actor", "allHosts"].some((k) => args[k] !== undefined)) {
    throw new TabcapError("usage", "--text, --business-code, --actor and --all-hosts belong to --usage", `Usage: ${usageOf(spec)}`);
  }
  const r = BundleReader.open(dir);
  if (wantUsage) {
    const rules = strs(args["businessCode"]).map(parseBusinessRule);
    const actor = str(args["actor"]);
    return { usage: usageReport(r, dir, rules, { actor: actor === undefined ? null : parseUsageActor(actor), allHosts: args["allHosts"] === true }) };
  }
  const kinds: Record<string, number> = {};
  for (const e of r.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const recount = computeCounts(r.events, r.manifest.counts.blobBytes);
  const typeInferred = { "sec-fetch": 0, "content-type": 0 };
  for (const q of r.requests()) {
    // adds bad-request issues, if any
    if (q["typeInferred"] === "sec-fetch") typeInferred["sec-fetch"]++;
    else if (q["typeInferred"] === "content-type") typeInferred["content-type"]++;
  }
  const warnings: string[] = [];
  if (!r.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted");
  if (r.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  if (recount.events !== r.manifest.counts.events) warnings.push(`manifest counts.events=${r.manifest.counts.events} but events.jsonl has ${recount.events}`);
  return {
    info: {
      dir,
      format: r.manifest.format,
      id: r.manifest.id,
      session: r.manifest.session.name,
      complete: r.isComplete(),
      created: r.manifest.created,
      finished: r.manifest.finished ?? null,
      counts: r.manifest.counts,
      events: r.events.length,
      kinds,
      imported: r.manifest.imported,
      typeInferred,
      redaction: r.manifest.redaction,
      truncatedLastLine: r.truncatedLastLine,
      decodedSidecar: r.decodedSidecar,
      issues: r.issues,
      warnings,
    },
  };
}
