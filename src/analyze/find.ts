// `tabcap analyze find <bundle> <text>`: which recorded payload carries a text
// the page showed (docs/03 §5 analyze, docs/05 s04 / s05, docs/06 A3).
// Spec: docs/05 s04 (12 channels, decode-chain names), s05 (encrypted -> zero
// hits plus `hints.suspectEncrypted`), docs/04 §4.1 (`ws`, `console`,
// `finding`), docs/03 §4 "结果为空先怀疑查询" (zero hits explain themselves).
// Oracle: test/unit/find.test.ts builds s04 / s05-like bundles with real
// encoders and WebCrypto; expected chains come from docs/05 s04.
// Reproduce: bun test test/unit/find.test.ts
//
// Searched: every `request` response body (document included) and request
// body, every `ws` frame payload, every `console` text. Matching is exact
// first; a payload with no exact hit is searched again with normalized text
// (NFC, HTML entities decoded, full-width digits / punctuation folded,
// whitespace collapsed). `--ignore-case` lowercases both sides.
// Embedded state (0.4-H): a hit inside an HTML document's script JSON,
// `window.X = {…}` literal or viewstate field carries `node` (step, address,
// script id / type); nodes that were not decoded (malformed, over a bound) are
// listed in `searched.embedded`.

import { TabcapError } from "../shared/envelope.ts";
import { num, str } from "../shared/json.ts";
import { parseInlineOrBlob, BundleReader } from "../bundle/reader.ts";
import type { RawEvent, RequestEvent } from "../bundle/types.ts";
import {
  Explorer,
  STEP_CAP,
  STEP_NAMES,
  baseMime,
  binaryMagic,
  decodeHtmlEntities,
  isBinaryMime,
  isCompressedMime,
  type DecodeHit,
  type EmbeddedSkip,
  type Matcher,
  type NodeTag,
  type OpaqueNode,
  type StepName,
} from "./decoders.ts";

export const MAX_HITS = 50;
/**
 * "Looks encrypted" thresholds in bits per byte, by decoded payload size
 * (docs/04 §15): >= 1 KiB needs > 7.3; 256 B to 1 KiB needs > 7.0 (the plug-in
 * entropy of short random data sits well below 8: about 7.2 at 256 B);
 * under 256 B nothing is judged.
 */
export const ENTROPY_THRESHOLD = 7.3; // >= ENTROPY_LARGE_SIZE
export const ENTROPY_THRESHOLD_SMALL = 7.0; // ENTROPY_MIN_SIZE .. ENTROPY_LARGE_SIZE - 1
export const ENTROPY_LARGE_SIZE = 1024; // bytes
export const ENTROPY_MIN_SIZE = 256; // bytes

/** Entropy threshold for a payload of `size` bytes, or null when it is too short to judge. */
export function entropyThreshold(size: number): number | null {
  if (size >= ENTROPY_LARGE_SIZE) return ENTROPY_THRESHOLD;
  if (size >= ENTROPY_MIN_SIZE) return ENTROPY_THRESHOLD_SMALL;
  return null;
}

export function looksEncrypted(size: number, entropy: number): boolean {
  const t = entropyThreshold(size);
  return t !== null && entropy > t;
}

export type FindOptions = { ignoreCase?: boolean; maxHits?: number };

export type FindHit = {
  kind: "request" | "ws" | "console";
  /** request: r-<seq>; ws: the handshake request id; console: null. */
  ref: string | null;
  /** Event seq of the matching event (request, ws frame or console line). */
  seq: number;
  part: "response" | "request-body" | "frame" | "console";
  url: string | null;
  method: string | null;
  status: number | null;
  mime: string | null;
  type: string | null;
  decode: StepName[];
  match: "exact" | "normalized";
  /** JSON path of the matching value in the outermost JSON document, or null for text. */
  path: string | null;
  /** Path inside the innermost decoded JSON document when the chain crossed into one. */
  innerPath: string | null;
  snippet: string;
  /** The embedded-state node the hit lies in (script-json / inline-assign / viewstate). */
  node?: NodeTag;
};

export type SkipReason = "binary" | "too-large" | "blob-missing" | "budget";

export type Skipped = { ref: string; part: string; reason: SkipReason; detail: string };

/** An embedded-state node that was not decoded: malformed (`unparsed`) or over a bound (`truncated`). */
export type EmbeddedNotDecoded = { ref: string; part: string; step: NodeTag["step"]; address: string; status: "unparsed" | "truncated"; detail: string; id?: string; type?: string; decode: StepName[] };

/** Most `searched.embedded` entries kept. */
export const MAX_EMBEDDED_NOTES = 100;

export type SuspectEncrypted = {
  ref: string;
  seq: number;
  part: "response" | "request-body" | "frame";
  url: string | null;
  method: string | null;
  status: number | null;
  mime: string | null;
  size: number;
  entropy: number;
  decode: StepName[];
  path: string | null;
};

export type FindResult = {
  bundle: string;
  complete: boolean;
  query: { text: string; ignoreCase: boolean; normalized: string };
  hits: FindHit[];
  truncated: boolean;
  searched: {
    requests: number;
    bodies: number;
    wsFrames: number;
    console: number;
    skipped: Record<SkipReason, number>;
    skippedList: Skipped[];
    missing: Record<string, number>;
    noBody: number;
    decoders: Partial<Record<StepName, number>>;
    embedded: EmbeddedNotDecoded[];
  };
  hints: {
    message: string;
    suspectEncrypted: SuspectEncrypted[];
    missingBodies: { total: number; reasons: Record<string, number>; requests: string[] };
  } | null;
  warnings: string[];
};

// ------------------------------------------------------------ normalization

/** Fold full-width digits and ASCII punctuation (U+FF01..U+FF5E minus letters) and U+3000. */
export function foldWidth(s: string): string {
  return s.replace(/[　！-～]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code === 0x3000) return " ";
    const ascii = code - 0xfee0;
    const isLetter = (ascii >= 0x41 && ascii <= 0x5a) || (ascii >= 0x61 && ascii <= 0x7a);
    return isLetter ? c : String.fromCharCode(ascii);
  });
}

/** NFC, HTML entities decoded, width folded, whitespace collapsed. */
export function normalizeText(s: string): string {
  const nfc = s.normalize("NFC");
  const ent = decodeHtmlEntities(nfc) ?? nfc;
  return foldWidth(ent).replace(/\s+/g, " ");
}

export function makeMatcher(needle: string, mode: "exact" | "normalized", ignoreCase: boolean): Matcher {
  const prep = (s: string) => {
    const n = mode === "normalized" ? normalizeText(s) : s;
    return ignoreCase ? n.toLowerCase() : n;
  };
  const target = mode === "normalized" ? prep(needle).trim() : prep(needle);
  if (target === "") return () => null;
  return (s: string) => {
    if (s.length < target.length && mode === "exact") return null;
    const h = prep(s);
    const index = h.indexOf(target);
    if (index < 0) return null;
    // Exact, case-sensitive matches show the original text; otherwise the prepared one.
    const haystack = mode === "exact" && (!ignoreCase || h.length === s.length) ? s : h;
    return { index, length: target.length, haystack };
  };
}

// ------------------------------------------------------------ helpers

const WIRE_STEPS: Record<string, StepName> = { gzip: "gzip", "x-gzip": "gzip", br: "br", deflate: "deflate" };

/**
 * docs/05 s04 b/c: our own recordings hold CDP-decoded bytes (chain []); a
 * bundle imported from HAR reports the wire decoding the import (or the HAR
 * producer) already applied, so the chain starts with that step.
 */
export function wirePrefix(imported: boolean, wireEncoding: string | null, decodeFailed: boolean): StepName[] {
  if (!imported || wireEncoding === null || decodeFailed) return [];
  const out: StepName[] = [];
  for (const token of wireEncoding.toLowerCase().split(",").map((t) => t.trim()).filter((t) => t !== "" && t !== "identity")) {
    const s = WIRE_STEPS[token];
    if (s === undefined) return [];
    out.push(s);
  }
  return out.reverse(); // content-encoding lists encodings in the order applied; decoding is the reverse
}

function headerValue(h: Record<string, string | string[]>, name: string): string | null {
  const v = h[name];
  return typeof v === "string" ? v : (v?.[0] ?? null);
}

function toHitPaths(h: DecodeHit): { path: string | null; innerPath: string | null } {
  const first = h.paths[0];
  const last = h.paths[h.paths.length - 1];
  return { path: first ?? null, innerPath: h.paths.length > 1 && last !== undefined ? last : null };
}

function mergeStats(into: Partial<Record<StepName, number>>, from: Partial<Record<StepName, number>>): void {
  for (const k of STEP_NAMES) {
    const v = from[k];
    if (v !== undefined) into[k] = (into[k] ?? 0) + v;
  }
}

type Payload = { bytes: Uint8Array } | { text: string };

type Target = {
  kind: FindHit["kind"];
  ref: string | null;
  seq: number;
  part: FindHit["part"];
  url: string | null;
  method: string | null;
  status: number | null;
  mime: string | null;
  type: string | null;
  payload: Payload;
  prefix: StepName[];
  entropyEligible: boolean;
};

// ------------------------------------------------------------ find

export function find(bundleDir: string, text: string, opts: FindOptions = {}): FindResult {
  if (text.trim() === "") throw new TabcapError("usage", "search text is empty", "Pass the text exactly as the page shows it: tabcap analyze find <bundle> <text>");
  const reader = BundleReader.open(bundleDir);
  const ignoreCase = opts.ignoreCase === true;
  const maxHits = opts.maxHits ?? MAX_HITS;
  const exact = makeMatcher(text, "exact", ignoreCase);
  const normalized = makeMatcher(text, "normalized", ignoreCase);
  const imported = reader.manifest.imported !== null && reader.manifest.imported !== undefined;

  const hits: FindHit[] = [];
  let truncated = false;
  const skipped: Record<SkipReason, number> = { binary: 0, "too-large": 0, "blob-missing": 0, budget: 0 };
  const skippedList: Skipped[] = [];
  const missing: Record<string, number> = {};
  const missingRequests: string[] = [];
  const decoders: Partial<Record<StepName, number>> = {};
  const suspects: SuspectEncrypted[] = [];
  const embedded: EmbeddedNotDecoded[] = [];
  let bodies = 0;
  let noBody = 0;
  let wsFrames = 0;
  let consoleCount = 0;

  const skip = (ref: string, part: string, reason: SkipReason, detail: string) => {
    skipped[reason]++;
    if (skippedList.length < 100) skippedList.push({ ref, part, reason, detail });
  };

  const search = (t: Target): void => {
    if (truncated) return;
    const remaining = maxHits - hits.length;
    let found: DecodeHit[] = [];
    let mode: FindHit["match"] = "exact";
    const ex = new Explorer(exact, { maxHits: remaining + 1, record: true, entropyEligible: t.entropyEligible });
    found = "bytes" in t.payload ? ex.exploreBytes(t.payload.bytes, { mime: t.mime }, t.prefix) : ex.exploreText(t.payload.text, { mime: t.mime }, t.prefix);
    mergeStats(decoders, ex.stats);
    for (const n of ex.embeddedSkips) if (embedded.length < MAX_EMBEDDED_NOTES) embedded.push(embeddedNote(t, n));
    if (ex.budgetExceeded) skip(t.ref ?? `console@${t.seq}`, t.part, "budget", "decode budget exhausted; search may be incomplete");
    if (found.length === 0) {
      const nx = new Explorer(normalized, { maxHits: remaining + 1, record: false });
      found = "bytes" in t.payload ? nx.exploreBytes(t.payload.bytes, { mime: t.mime }, t.prefix) : nx.exploreText(t.payload.text, { mime: t.mime }, t.prefix);
      mode = "normalized";
    }
    for (const op of ex.opaque) {
      if (!looksEncrypted(op.size, op.entropy) || t.kind === "console") continue;
      if (suspects.some((s) => s.seq === t.seq && s.part === t.part)) continue;
      suspects.push(suspectOf(t, op));
    }
    for (const h of found) {
      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
      hits.push({
        kind: t.kind,
        ref: t.ref,
        seq: t.seq,
        part: t.part,
        url: t.url,
        method: t.method,
        status: t.status,
        mime: t.mime,
        type: t.type,
        decode: h.chain,
        match: mode,
        ...toHitPaths(h),
        snippet: h.snippet,
        ...(h.node === undefined ? {} : { node: h.node }),
      });
    }
  };

  const requests = reader.requests();
  const byId = new Map<string, RequestEvent>();
  for (const r of requests) byId.set(r.id, r);

  for (const r of requests) {
    const resp = r.response;
    const base = {
      kind: "request" as const,
      ref: r.id,
      seq: r.seq,
      url: r.url,
      method: r.method,
      status: resp?.status ?? null,
      type: r.type,
    };
    // response body
    if (resp === null || resp.body === null) {
      const reason = resp?.bodyMissing?.reason ?? null;
      if (reason !== null) {
        missing[reason] = (missing[reason] ?? 0) + 1;
        if (missingRequests.length < 50) missingRequests.push(r.id);
      } else noBody++;
    } else {
      const body = resp.body;
      const mime = resp.mimeType ?? headerValue(resp.headers, "content-type");
      const binaryByType = r.type === "image" || r.type === "font" || r.type === "media";
      if (body.size > STEP_CAP) skip(r.id, "response", "too-large", `${body.size} bytes`);
      else if (isBinaryMime(mime) || (binaryByType && baseMime(mime) !== "image/svg+xml")) skip(r.id, "response", "binary", baseMime(mime) || r.type);
      else {
        const bytes = reader.readBlob(body.blob);
        if (bytes === null) skip(r.id, "response", "blob-missing", body.blob);
        else if (bytes.length > STEP_CAP) skip(r.id, "response", "too-large", `${bytes.length} bytes`);
        else if (binaryMagic(bytes) !== null) skip(r.id, "response", "binary", `magic:${binaryMagic(bytes) ?? ""}`);
        else {
          bodies++;
          search({
            ...base,
            part: "response",
            mime,
            payload: { bytes },
            prefix: wirePrefix(imported, body.wireEncoding, body.decodeFailed === true),
            entropyEligible: !isCompressedMime(mime),
          });
        }
      }
    }
    // request body
    const pd = r.request.postData;
    if (pd !== null) {
      const mime = headerValue(r.request.headers, "content-type");
      if ("inline" in pd) {
        bodies++;
        search({ ...base, part: "request-body", mime, payload: { text: pd.inline }, prefix: [], entropyEligible: !isCompressedMime(mime) });
      } else {
        const bytes = reader.readBlob(pd.blob);
        if (bytes === null) skip(r.id, "request-body", "blob-missing", pd.blob);
        else if (bytes.length > STEP_CAP) skip(r.id, "request-body", "too-large", `${bytes.length} bytes`);
        else if (isBinaryMime(mime) || binaryMagic(bytes) !== null) skip(r.id, "request-body", "binary", baseMime(mime) || "magic");
        else {
          bodies++;
          search({ ...base, part: "request-body", mime, payload: { bytes }, prefix: [], entropyEligible: !isCompressedMime(mime) });
        }
      }
    }
  }

  for (const e of reader.events) {
    if (e.kind === "ws" && e["phase"] === "frame") {
      wsFrames++;
      const target = wsTarget(reader, e, byId);
      if (typeof target === "string") skip(str(e, "ws") ?? `ws@${e.seq}`, "frame", "blob-missing", target);
      else if (target !== null) search(target);
    } else if (e.kind === "console") {
      const t = str(e, "text");
      if (t === null) continue;
      consoleCount++;
      search({
        kind: "console",
        ref: null,
        seq: e.seq,
        part: "console",
        url: str(e, "url"),
        method: null,
        status: null,
        mime: null,
        type: str(e, "level"),
        payload: { text: t },
        prefix: [],
        entropyEligible: false,
      });
    }
  }

  hits.sort((a, b) => a.seq - b.seq);
  const warnings: string[] = [];
  if (!reader.isComplete()) warnings.push("bundle is not finished: recording in progress or interrupted");
  if (reader.truncatedLastLine) warnings.push("events.jsonl ends with a truncated line; it was skipped");
  if (reader.issues.length > 0) warnings.push(`${reader.issues.length} damaged event line(s) skipped; run \`tabcap bundle info\` for details`);

  let hints: FindResult["hints"] = null;
  if (hits.length === 0) {
    const totalMissing = Object.values(missing).reduce((a, b) => a + b, 0);
    hints = {
      message: hintMessage(suspects, totalMissing, missing, skipped),
      suspectEncrypted: suspects,
      missingBodies: { total: totalMissing, reasons: missing, requests: missingRequests },
    };
  }

  return {
    bundle: bundleDir,
    complete: reader.isComplete(),
    query: { text, ignoreCase, normalized: normalizeText(text).trim() },
    hits,
    truncated,
    searched: { requests: requests.length, bodies, wsFrames, console: consoleCount, skipped, skippedList, missing, noBody, decoders, embedded },
    hints,
    warnings,
  };
}

function embeddedNote(t: Target, n: EmbeddedSkip): EmbeddedNotDecoded {
  return {
    ref: t.ref ?? `${t.kind}@${t.seq}`,
    part: t.part,
    step: n.step,
    address: n.address,
    status: n.status,
    detail: n.detail,
    ...(n.id === undefined ? {} : { id: n.id }),
    ...(n.type === undefined ? {} : { type: n.type }),
    decode: n.chain,
  };
}

function suspectOf(t: Target, op: OpaqueNode): SuspectEncrypted {
  return {
    ref: t.ref ?? `@${t.seq}`,
    seq: t.seq,
    part: t.part === "console" ? "frame" : t.part,
    url: t.url,
    method: t.method,
    status: t.status,
    mime: t.mime,
    size: op.size,
    entropy: Math.round(op.entropy * 1000) / 1000,
    decode: op.chain,
    path: op.paths[0] ?? null,
  };
}

/** A ws frame as a search target; a string when its blob is missing; null for empty frames. */
function wsTarget(reader: BundleReader, e: RawEvent, byId: ReadonlyMap<string, RequestEvent>): Target | string | null {
  const ref = str(e, "ws");
  const hs = ref === null ? undefined : byId.get(ref);
  const p = parseInlineOrBlob(e["payload"]);
  if (p === null) return null;
  const opcode = num(e, "opcode") === 2 ? 2 : 1;
  let payload: Payload;
  if ("inline" in p) {
    // Binary frames carried inline are base64 (DevTools / CDP payloadData convention).
    if (opcode === 2) {
      const b = Buffer.from(p.inline, "base64");
      payload = { bytes: new Uint8Array(b) };
    } else payload = { text: p.inline };
  } else {
    const bytes = reader.readBlob(p.blob);
    if (bytes === null) return p.blob;
    payload = { bytes };
  }
  return {
    kind: "ws",
    ref,
    seq: e.seq,
    part: "frame",
    url: hs?.url ?? null,
    method: null,
    status: null,
    mime: null,
    type: opcode === 2 ? "binary" : "text",
    payload,
    prefix: [],
    entropyEligible: true,
  };
}

function hintMessage(suspects: readonly SuspectEncrypted[], totalMissing: number, missing: Record<string, number>, skipped: Record<SkipReason, number>): string {
  const parts = ["0 hits. Suspect the query before concluding the text is not in the traffic."];
  if (suspects.length > 0) {
    parts.push(
      `${suspects.length} payload(s) look encrypted (entropy > ${ENTROPY_THRESHOLD} bits/byte from ${ENTROPY_LARGE_SIZE} B, > ${ENTROPY_THRESHOLD_SMALL} from ${ENTROPY_MIN_SIZE} B; not compressed or media): ${suspects
        .slice(0, 10)
        .map((s) => s.ref)
        .join(", ")}; the page probably decrypts them in JS (consider trace mode).`,
    );
  }
  if (totalMissing > 0) {
    const reasons = Object.entries(missing)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    parts.push(`${totalMissing} request(s) have no body (${reasons}); the text may have been in one of them.`);
  }
  const skippedTotal = skipped.binary + skipped["too-large"] + skipped["blob-missing"] + skipped.budget;
  if (skippedTotal > 0) parts.push(`${skippedTotal} payload(s) were skipped (see searched.skipped).`);
  if (suspects.length === 0 && totalMissing === 0 && skippedTotal === 0) parts.push("Nothing looks encrypted or missing; try a shorter or differently formatted piece of the text, or --ignore-case.");
  return parts.join(" ");
}

// ------------------------------------------------------------ text rendering

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Compact human rendering (`--text`). */
export function renderFindText(r: FindResult): string {
  const lines: string[] = [];
  lines.push(`find ${JSON.stringify(r.query.text)} in ${r.bundle}${r.complete ? "" : " (unfinished)"}${r.query.ignoreCase ? " [ignore-case]" : ""}`);
  lines.push(`${r.hits.length} hit(s)${r.truncated ? ` (truncated at ${r.hits.length})` : ""}`);
  for (const h of r.hits) {
    const where = h.kind === "console" ? `console@${h.seq}` : h.kind === "ws" ? `${h.ref ?? "ws"} frame@${h.seq}` : `${h.ref ?? ""}${h.part === "request-body" ? " (request body)" : ""}`;
    const head = h.kind === "request" ? `${h.method ?? ""} ${h.url ?? ""} ${h.status ?? ""}`.trim() : (h.url ?? "");
    lines.push(`  ${where}  ${head}`);
    const loc = h.path === null ? "" : `  ${h.path}${h.innerPath === null ? "" : ` -> ${h.innerPath}`}`;
    const node = h.node === undefined ? "" : `  (${[h.node.address, h.node.id === undefined ? "" : `#${h.node.id}`, h.node.type ?? ""].filter((x) => x !== "").join(" ")})`;
    lines.push(`    decode [${h.decode.join(",")}] ${h.match}${loc}${node}`);
    lines.push(`    ${oneLine(h.snippet)}`);
  }
  const s = r.searched;
  const dec = STEP_NAMES.filter((k) => (s.decoders[k] ?? 0) > 0)
    .map((k) => `${k}=${s.decoders[k] ?? 0}`)
    .join(" ");
  const sk = (Object.keys(s.skipped) as SkipReason[]).filter((k) => s.skipped[k] > 0).map((k) => `${k} ${s.skipped[k]}`).join(", ");
  const miss = Object.entries(s.missing).map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`searched: ${s.bodies} bodies, ${s.wsFrames} ws frames, ${s.console} console lines (${s.requests} requests)`);
  lines.push(`skipped: ${sk === "" ? "none" : sk}; no body: ${miss === "" ? "none" : miss}${s.noBody > 0 ? `, none recorded ${s.noBody}` : ""}`);
  lines.push(`decoders: ${dec === "" ? "none" : dec}`);
  for (const e of s.embedded) lines.push(`not decoded: ${e.ref} ${e.address} ${e.status}: ${oneLine(e.detail)}`);
  if (r.hints !== null) {
    lines.push(`hint: ${r.hints.message}`);
    for (const x of r.hints.suspectEncrypted) {
      lines.push(`  suspect ${x.ref} ${x.method ?? ""} ${x.url ?? ""} ${x.size} B entropy ${x.entropy} decode [${x.decode.join(",")}]${x.path === null ? "" : ` ${x.path}`}`);
    }
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
