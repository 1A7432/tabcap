// 0.5-F2: `net body <id> --file` hands the decoded body out as a file, so an
// agent with a shell can search it with its own tools (rg / grep).
// The file holds exactly the text `--grep` / `--lines` search (charset-decoded,
// content-decoding undone, known secrets substituted, `--pretty` line-broken).
// Binary bodies are written raw (`scrubbed: false`). Location: the session's
// open recording's `exports/bodies/<id>[.pretty].<ext>`, else
// `<cache>/outputs/bodies/<stamp>-<id>[.pretty].<ext>`; 0600 in 0700 dirs,
// overwritten on repeat.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";
import { compactStamp } from "../../shared/time.ts";
import { optBool, type Args } from "./args.ts";
import { decodeBody, prettify } from "./netsearch.ts";
import { prettyKind } from "./pretty.ts";
import { splitLines } from "./textsearch.ts";

/** File extension for a body, from its MIME type (resource type for scripts served oddly): js / json / html / css / txt, else bin. */
export function extOfMime(mime: string | null, resourceType: string | null = null): string {
  const m = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const k = prettyKind(mime, resourceType);
  if (k !== null) return k;
  if (m === "text/html" || m === "application/xhtml+xml") return "html";
  if (m === "text/css") return "css";
  if (m.startsWith("text/") || m.endsWith("+xml") || m === "application/xml") return "txt";
  return "bin";
}

/** `--file` excludes the search flags and `--out`; a usage error otherwise. Returns whether `--file` was given. */
export function fileFlagOf(a: Args): boolean {
  if (!optBool(a, "file")) return false;
  const clash = ["grep", "lines", "at", "out"].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== false);
  if (clash.length > 0) {
    throw new TabcapError("usage", `--file cannot be combined with --${clash.join(" / --")}`, "`net body <id> --file` writes the whole decoded body to a file for your own tools (rg / grep); --grep / --lines / --at search it in place.");
  }
  return true;
}

export type BodyFileInput = {
  id: string;
  url: string;
  bytes: Uint8Array;
  mime: string | null;
  resourceType: string | null;
  charset: () => string | null;
  scrub: (text: string) => string;
  pretty: boolean;
  where: { bundle: string } | { cache: string };
  now?: number;
};

/** Write the body file and describe it. */
export function exportBody(i: BodyFileInput): Record<string, unknown> {
  const text = decodeBody(i.bytes, i.mime, i.charset);
  const ext = extOfMime(i.mime, i.resourceType);
  const notes: string[] = [];
  let data: Uint8Array;
  let pretty = false;
  let lines = 0;
  if (text === null) {
    data = i.bytes;
    if (i.pretty) notes.push("--pretty applies to JavaScript and JSON bodies; this one is binary");
    notes.push("binary body written as it was recorded: no text, so no secret substitution (scrubbed: false)");
  } else {
    const scrubbed = i.scrub(text);
    const p = i.pretty ? prettify(scrubbed, i.bytes.length, i.mime, i.resourceType) : { text: scrubbed, pretty: false, note: null };
    if (p.note !== null) notes.push(p.note);
    pretty = p.pretty;
    lines = splitLines(p.text).length;
    data = new TextEncoder().encode(p.text);
  }
  const name = `${i.id.replace(/[^A-Za-z0-9-]+/g, "-")}${pretty ? ".pretty" : ""}.${ext}`;
  let dir: string;
  let file: string;
  if ("bundle" in i.where) {
    dir = join(i.where.bundle, "exports", "bodies");
    file = join(dir, name);
  } else {
    dir = join(i.where.cache, "outputs", "bodies");
    file = join(dir, `${compactStamp(i.now ?? Date.now())}-${name}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { id: i.id, url: i.url, mime: i.mime, bytes: data.length, lines, pretty, file, scrubbed: text !== null, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
}
