// manifest.json (docs/04 §7): build, validate, count, write atomically.

import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, num, oneOf, rec, str } from "../shared/json.ts";
import { ulid } from "../shared/ids.ts";
import {
  FORMAT_ID,
  FORMAT_MAJOR,
  type CaptureMode,
  type Imported,
  type Manifest,
  type ManifestCounts,
  type ManifestTab,
  type Producer,
  type RawEvent,
  type Redaction,
  type SampleIndex,
  type TraceMode,
  type TraceWindow,
} from "./types.ts";
import pkg from "../../package.json" with { type: "json" };

export const TOOL_NAME = "tabcap";
/** Single source: package.json (bundled into the compiled binary). */
export const TOOL_VERSION: string = pkg.version;

export const MANIFEST_FILE = "manifest.json";
export const EVENTS_FILE = "events.jsonl";

export type NewManifestOptions = {
  id?: string;
  created: number;
  producer?: Producer;
  session?: Partial<Manifest["session"]>;
  mode?: Partial<Manifest["mode"]>;
  imported?: Imported | null;
  notes?: string;
};

export function emptyCounts(): ManifestCounts {
  return { events: 0, requests: 0, bodies: 0, blobBytes: 0, bodyMissing: {}, downloads: 0 };
}

export function newManifest(o: NewManifestOptions): Manifest {
  return {
    format: FORMAT_ID,
    id: o.id ?? ulid(Math.floor(o.created)),
    created: o.created,
    producer: o.producer ?? { tool: TOOL_NAME, version: TOOL_VERSION },
    session: {
      name: o.session?.name ?? "",
      site: o.session?.site ?? null,
      account: o.session?.account ?? null,
      ...(o.session?.proxy === undefined ? {} : { proxy: o.session.proxy }),
      tabs: o.session?.tabs ?? [],
    },
    mode: {
      capture: o.mode?.capture ?? "passive",
      trace: o.mode?.trace ?? false,
      raw: o.mode?.raw ?? true,
      humanRecorder: o.mode?.humanRecorder ?? false,
    },
    counts: emptyCounts(),
    redaction: null,
    imported: o.imported ?? null,
    notes: o.notes ?? "",
  };
}

/** Check the format id; a different major is refused (§10). */
export function checkFormat(format: unknown): void {
  if (typeof format !== "string") {
    throw new TabcapError("bad-input", "manifest.format is missing", "Point at a bundle directory written by tabcap (it has manifest.json with format evidence-bundle/<n>).");
  }
  const m = /^evidence-bundle\/(\d+)$/.exec(format);
  if (m === null || m[1] === undefined) {
    throw new TabcapError("bad-input", `unknown manifest.format: ${format}`, "This is not an evidence bundle; check the path.");
  }
  if (Number(m[1]) !== FORMAT_MAJOR) {
    throw new TabcapError("unsupported", `bundle format ${format} is not supported (this build reads ${FORMAT_ID})`, "Use a tabcap version that matches the bundle's format major.");
  }
}

const CAPTURE: readonly CaptureMode[] = ["passive", "active", "mixed"];

/** Validate an untrusted manifest object. Unknown fields are kept. */
export function parseManifest(raw: unknown): Manifest {
  const bad = (what: string) =>
    new TabcapError("bad-input", `manifest.json: ${what}`, "The manifest is damaged; re-export or re-record the bundle.");
  if (!isRecord(raw)) throw bad("not a JSON object");
  checkFormat(raw["format"]);
  const id = str(raw, "id");
  const created = num(raw, "created");
  if (id === null) throw bad("id is not a string");
  if (created === null) throw bad("created is not a number");
  const finished = raw["finished"];
  if (finished !== undefined && finished !== null && typeof finished !== "number") throw bad("finished is not a number");

  const producerRaw = rec(raw, "producer");
  const producer: Producer = {
    ...(producerRaw ?? {}),
    tool: producerRaw === null ? TOOL_NAME : (str(producerRaw, "tool") ?? TOOL_NAME),
    version: producerRaw === null ? "" : (str(producerRaw, "version") ?? ""),
  };
  // Review 10-21: the typed parts are checked, not passed on as they came (a bad one is bad-input).
  if (producerRaw !== null && producerRaw["browser"] !== undefined) producer.browser = parseBrowser(producerRaw["browser"], bad);

  const sessionRaw = rec(raw, "session") ?? {};
  const tabsRaw = Array.isArray(sessionRaw["tabs"]) ? sessionRaw["tabs"] : [];
  const tabs: ManifestTab[] = [];
  for (const t of tabsRaw) {
    if (!isRecord(t) || typeof t["tab"] !== "string") throw bad("session.tabs[] entry without tab");
    tabs.push({
      ...t,
      tab: t["tab"],
      chromeTabId: num(t, "chromeTabId"),
      owned: t["owned"] === true,
      firstUrl: str(t, "firstUrl"),
    });
  }

  const modeRaw = rec(raw, "mode") ?? {};
  const capture = str(modeRaw, "capture");
  const mode: Manifest["mode"] = {
    ...modeRaw,
    capture: oneOf(CAPTURE, capture) ? capture : "passive",
    trace: parseTraceMode(modeRaw["trace"]),
    raw: modeRaw["raw"] !== false,
    humanRecorder: modeRaw["humanRecorder"] === true,
  };
  const windows = parseTraceWindows(raw["traceWindows"]);

  const countsRaw = rec(raw, "counts");
  const counts = emptyCounts();
  if (countsRaw !== null) {
    counts.events = num(countsRaw, "events") ?? 0;
    counts.requests = num(countsRaw, "requests") ?? 0;
    counts.bodies = num(countsRaw, "bodies") ?? 0;
    counts.blobBytes = num(countsRaw, "blobBytes") ?? 0;
    const bm = rec(countsRaw, "bodyMissing") ?? {};
    for (const [k, v] of Object.entries(bm)) if (typeof v === "number") counts.bodyMissing[k] = v;
    counts.downloads = num(countsRaw, "downloads") ?? 0;
  }

  const redactionRaw = rec(raw, "redaction");
  let redaction: Redaction | null = null;
  if (redactionRaw !== null) {
    redaction = { ...redactionRaw, rules: str(redactionRaw, "rules") ?? "", applied: num(redactionRaw, "applied") ?? 0 };
  }

  const importedRaw = rec(raw, "imported");
  let imported: Imported | null = null;
  if (importedRaw !== null) {
    const creatorRaw = rec(importedRaw, "creator");
    const lossyRaw = importedRaw["lossy"];
    imported = {
      ...importedRaw,
      from: "har",
      creator: creatorRaw === null ? null : { name: str(creatorRaw, "name") ?? "", version: str(creatorRaw, "version") ?? "" },
      lossy: Array.isArray(lossyRaw) ? lossyRaw.filter((x): x is string => typeof x === "string") : [],
    };
  }

  const m: Manifest = {
    ...raw,
    format: FORMAT_ID,
    id,
    created,
    producer,
    session: {
      ...sessionRaw,
      name: str(sessionRaw, "name") ?? "",
      site: str(sessionRaw, "site"),
      account: str(sessionRaw, "account"),
      ...("proxy" in sessionRaw ? { proxy: str(sessionRaw, "proxy") } : {}),
      tabs,
    },
    mode,
    counts,
    redaction,
    imported,
    notes: str(raw, "notes") ?? "",
  };
  if (raw["record"] !== undefined) m.record = parseRecord(raw["record"], bad);
  if (raw["sample"] !== undefined) m.sample = parseSample(raw["sample"], bad);
  if (typeof finished === "number") m.finished = finished;
  else delete m.finished;
  if (windows === null) delete m.traceWindows;
  else m.traceWindows = windows;
  return m;
}

type Bad = (what: string) => TabcapError;
const WEBDRIVER = ["hidden", "visible"] as const;
const RECORD_BODIES = ["all", "api", "api+script", "none"] as const;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** `producer.browser` (docs/04 §7): null, or name / version strings with optional userAgent, webdriver and switch lists. */
function parseBrowser(v: unknown, bad: Bad): NonNullable<Producer["browser"]> | null {
  if (v === null) return null;
  if (!isRecord(v)) throw bad("producer.browser is not an object");
  const name = str(v, "name");
  const version = str(v, "version");
  if (name === null || version === null) throw bad("producer.browser needs name and version strings");
  const out: NonNullable<Producer["browser"]> = { ...v, name, version };
  const ua = v["userAgent"];
  if (ua !== undefined && ua !== null && typeof ua !== "string") throw bad("producer.browser.userAgent is not a string");
  const wd = v["webdriver"];
  if (wd !== undefined) {
    if (!oneOf(WEBDRIVER, wd)) throw bad("producer.browser.webdriver is not hidden or visible");
    out.webdriver = wd;
  }
  for (const k of ["args", "extraArgs", "dropArgs"] as const) {
    const list = v[k];
    if (list === undefined) continue;
    if (!isStringList(list)) throw bad(`producer.browser.${k} is not a list of strings`);
    out[k] = list;
  }
  return out;
}

/** `record` (0.6-I): {bodies: all | api | api+script | none}. */
function parseRecord(v: unknown, bad: Bad): NonNullable<Manifest["record"]> {
  const bodies = isRecord(v) ? v["bodies"] : undefined;
  if (!isRecord(v) || !oneOf(RECORD_BODIES, bodies)) throw bad("record.bodies is not all, api, api+script or none");
  return { ...v, bodies };
}

/** `sample` (§4.3): {challengeRequests: string[], scripts: [{request, sha256, inline}], env: string | null}. */
function parseSample(v: unknown, bad: Bad): SampleIndex {
  if (!isRecord(v)) throw bad("sample is not an object");
  const reqs = v["challengeRequests"];
  if (!isStringList(reqs)) throw bad("sample.challengeRequests is not a list of strings");
  const scriptsRaw = v["scripts"];
  if (!Array.isArray(scriptsRaw)) throw bad("sample.scripts is not a list");
  const scripts = scriptsRaw.map((s) => {
    if (!isRecord(s) || typeof s["request"] !== "string" || typeof s["sha256"] !== "string" || typeof s["inline"] !== "boolean") throw bad("sample.scripts[] needs request, sha256 and inline");
    return { ...s, request: s["request"], sha256: s["sha256"], inline: s["inline"] };
  });
  const env = v["env"];
  if (env !== null && typeof env !== "string") throw bad("sample.env is not a string or null");
  return { ...v, challengeRequests: reqs, scripts, env };
}

const TRACE_MECHANISMS = ["fn-breakpoint", "instrumentation"] as const;

/**
 * `mode.trace` (docs/04 §7, 0.4-F): false or {mechanism, apis, stack, firstN,
 * maxHits}. Anything else (an old boolean, a damaged object) reads as false;
 * unknown fields of a valid object are kept.
 */
export function parseTraceMode(v: unknown): false | TraceMode {
  if (!isRecord(v)) return false;
  const apis = str(v, "apis");
  const stack = num(v, "stack");
  const firstN = num(v, "firstN");
  const maxHits = num(v, "maxHits");
  const mech = Array.isArray(v["mechanism"]) ? v["mechanism"].filter((x): x is TraceMode["mechanism"][number] => oneOf(TRACE_MECHANISMS, x)) : [];
  if (apis === null || stack === null || firstN === null || maxHits === null) return false;
  return { ...v, mechanism: mech, apis, stack, firstN, maxHits };
}

/** `traceWindows` (docs/04 §7): null when absent; malformed entries are dropped. */
export function parseTraceWindows(v: unknown): TraceWindow[] | null {
  if (!Array.isArray(v)) return null;
  const out: TraceWindow[] = [];
  for (const w of v) {
    if (!isRecord(w)) continue;
    const fromSeq = num(w, "fromSeq");
    const toSeq = num(w, "toSeq");
    if (fromSeq === null) continue;
    out.push({ ...w, fromSeq, toSeq });
  }
  return out;
}

export function readManifest(dir: string): Manifest {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new TabcapError("not-found", `no ${MANIFEST_FILE} in ${dir}`, "Pass a bundle directory (it contains manifest.json and events.jsonl).");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new TabcapError("bad-input", `${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`, "The manifest is damaged; re-export or re-record the bundle.");
  }
  return parseManifest(raw);
}

/** Write a file atomically: temp file in the same dir, fsync, rename. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function writeManifest(dir: string, m: Manifest): void {
  writeFileAtomic(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2) + "\n", 0o600);
}

/**
 * Counts from the event stream (§7). `bodies` = request events whose response
 * carries a body blob; `blobBytes` = total size of distinct blobs on disk;
 * `downloads` = `download` events (0.9-D, §48).
 */
export function computeCounts(events: readonly RawEvent[], blobBytes: number): ManifestCounts {
  const c = emptyCounts();
  c.events = events.length;
  c.blobBytes = blobBytes;
  for (const e of events) {
    if (e.kind === "download") c.downloads++;
    if (e.kind !== "request") continue;
    c.requests++;
    const resp = isRecord(e["response"]) ? e["response"] : null;
    if (resp === null) continue;
    if (isRecord(resp["body"]) && typeof resp["body"]["blob"] === "string") c.bodies++;
    const missing = resp["bodyMissing"];
    if (isRecord(missing) && typeof missing["reason"] === "string") {
      c.bodyMissing[missing["reason"]] = (c.bodyMissing[missing["reason"]] ?? 0) + 1;
    }
  }
  return c;
}

/** Sum of blob file sizes under <dir>/blobs/sha256 (temp files excluded). */
export function blobBytesOnDisk(dir: string): number {
  const root = join(dir, "blobs", "sha256");
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const sub of readdirSync(root)) {
    const subdir = join(root, sub);
    if (!statSync(subdir).isDirectory()) continue;
    for (const f of readdirSync(subdir)) {
      if (/^[0-9a-f]{64}$/.test(f)) total += statSync(join(subdir, f)).size;
    }
  }
  return total;
}
