// Reference captures of the signal probe (0.4-G): `$TABCAP_HOME/config/fingerprint/refs/<name>.json`,
// file 0600, directories 0700 (POSIX only; Windows keeps the profile's default ACL).
// A reference is what the user's own browser presented when they opened
// `tabcap fingerprint serve` by hand and pressed "Save as reference". It is
// never captured through CDP and never shipped in the repository.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, num, str } from "../shared/json.ts";
import { normalizeFields, REF_SCHEMA, userAgentOf, type Field, type RefInfo } from "./fields.ts";

const NAME = /^[a-z0-9-]{1,40}$/;

export function checkRefName(name: string): string {
  if (!NAME.test(name)) throw new TabcapError("usage", `bad reference name: ${JSON.stringify(name.slice(0, 60))}`, "Reference names use a-z, 0-9 and '-' (1 to 40 characters), e.g. daily.");
  return name;
}

export function refsDir(configDir: string): string {
  return join(configDir, "fingerprint", "refs");
}

const refPath = (configDir: string, name: string): string => join(refsDir(configDir), `${checkRefName(name)}.json`);

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

export type RefFile = RefInfo & { schema: string; fields: Field[] };

/** Write a reference (refused when it exists, unless `force`). */
export function saveRef(configDir: string, name: string, fields: readonly Field[], o: { force: boolean; now: number }): { name: string; path: string; savedAt: number; userAgent: string | null; replaced: boolean } {
  const path = refPath(configDir, name);
  const exists = existsSync(path);
  if (exists && !o.force) throw new TabcapError("conflict", `reference ${name} already exists`, "Pick another name, remove it with `tabcap fingerprint ref remove <name>`, or start `fingerprint serve --force`.");
  privateDir(join(configDir, "fingerprint"));
  privateDir(refsDir(configDir));
  const userAgent = userAgentOf(fields);
  const doc: RefFile = { schema: REF_SCHEMA, name, savedAt: o.now, userAgent, fields: [...fields] };
  writeFileAtomic(path, JSON.stringify(doc, null, 2) + "\n", 0o600);
  return { name, path, savedAt: o.now, userAgent, replaced: exists };
}

/** Read a reference file (untrusted: hand-edited files are expected; fields are normalized). */
export function loadRef(configDir: string, name: string): RefFile & { path: string; dropped: string[] } {
  const path = refPath(configDir, name);
  if (!existsSync(path)) throw new TabcapError("not-found", `no reference named ${name}`, "Run `tabcap fingerprint ref list`; save one with `tabcap fingerprint serve` opened in your own browser.");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new TabcapError("bad-input", `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "Fix the file or save the reference again.");
  }
  if (!isRecord(doc)) throw new TabcapError("bad-input", `${path} is not a JSON object`, "Fix the file or save the reference again.");
  const n = normalizeFields(doc["fields"]);
  return { schema: str(doc, "schema") ?? REF_SCHEMA, name, savedAt: num(doc, "savedAt"), userAgent: str(doc, "userAgent"), fields: n.fields, path, dropped: n.dropped };
}

export function listRefs(configDir: string): { dir: string; refs: { name: string; savedAt: number | null; userAgent: string | null; path: string; bytes: number; error?: string }[] } {
  const dir = refsDir(configDir);
  if (!existsSync(dir)) return { dir, refs: [] };
  const refs = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && NAME.test(f.slice(0, -5)))
    .sort()
    .map((f) => {
      const name = f.slice(0, -5);
      const path = join(dir, f);
      const bytes = statSync(path).size;
      try {
        const r = loadRef(configDir, name);
        return { name, savedAt: r.savedAt, userAgent: r.userAgent, path, bytes };
      } catch (e) {
        return { name, savedAt: null, userAgent: null, path, bytes, error: e instanceof Error ? e.message : String(e) };
      }
    });
  return { dir, refs };
}

export function removeRef(configDir: string, name: string): { removed: string; path: string } {
  const path = refPath(configDir, name);
  if (!existsSync(path)) throw new TabcapError("not-found", `no reference named ${name}`, "Run `tabcap fingerprint ref list`.");
  unlinkSync(path);
  return { removed: name, path };
}
