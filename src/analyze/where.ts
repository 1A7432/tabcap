// `tabcap where <ref|text>`: which recorded response carries a value the page
// shows (docs/09 §3.1, docs/05 s40; 0.4-C brief, owner decisions 2026-10-16).
// Pure: a bundle reader and a query in, a `tabcap-where/0` result out; the
// daemon resolves refs to their visible text and passes the page text used
// for DD/MM vs MM/DD disambiguation. No request is ever sent.
// Spec:
// - candidates are response leaves: JSON values through `analyze find`'s
//   decode chain (JSON paths and step names as `find` reports them), the
//   whole text of other text bodies, and the text nodes of HTML responses
//   (selector paths, see htmltext.ts); an HTML document's embedded state
//   (0.4-H: script JSON, `window.X = {…}` literals, viewstate fields) gives
//   JSON-path candidates (`script[0].$.a`, `assign[X].a`, `viewstate[…]`)
//   with the step in the chain, ranked with the JSON candidates;
// - match "exact" when the raw strings are equal after trim; "normalized"
//   when an interpretation of the query equals one of the value
//   (normalize.ts); score 1 for exact, else 1 / (1 + rules used), rounded to
//   3 decimals; ties: earlier request first, then document order;
// - an a/b/YYYY query with both parts <= 12 gets candidates only when another
//   date on the page proves the order (a part > 12), else `ambiguous` lists
//   both readings; a query that normalises only to the empty-zero-null class
//   returns no candidates with reason `too-common`;
// - bodies that are not UTF-8 are decoded with their declared charset
//   (response charset, content-type, else an HTML meta) via TextDecoder; a
//   charset TextDecoder does not know yields reason `unsupported-charset`
//   when nothing else matched.
// Ranking decision (0.4-C, see NOTES): JSON / text-body candidates come
// before HTML text-node candidates, each group by score. An HTML text node
// showing the value is a rendering of it; s40 records every locale's page
// document (which shows the exact text) and still expects the /api/rows path
// first.
// Oracle: test/unit/where.test.ts (synthetic bundles with planted values),
// test/e2e/v04c.e2e.test.ts (docs/05 s40 on the range site).
// Reproduce: bun test test/unit/where.test.ts

import { BundleReader } from "../bundle/reader.ts";
import type { RequestEvent } from "../bundle/types.ts";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { Explorer, STEP_CAP, STEP_NAMES, baseMime, binaryMagic, isBinaryMime, utf8, type DecodeHit, type Matcher, type StepName } from "./decoders.ts";
import { mayEmbed } from "./embedded.ts";
import type { FindingInput } from "./finding.ts";
import { wirePrefix } from "./find.ts";
import { htmlTextNodes } from "./htmltext.ts";
import { RULES, commonInterpretation, normalize, onlyEmptyClass, pageDateOrders, type Interpretation, type RuleName } from "./normalize.ts";

export const WHERE_SCHEMA = "tabcap-where/0";
export const DEFAULT_TOP = 5;
export const MAX_TOP = 100;
/** Explorer hits kept per body (equal values are rare; this bounds pathological bodies). */
const MAX_HITS_PER_BODY = 10_000;

export type WhereKind = "ref" | "text";
export type WhereQuery = { input: string; kind: WhereKind; ref?: string; text: string };

export type WhereCandidate = {
  request: string;
  /** JSON path (" -> " joins nested documents), as analyze find reports it. */
  path?: string;
  /** HTML text node: selector into the response source. */
  selector?: string;
  chain: StepName[];
  match: "exact" | "normalized";
  rules?: RuleName[];
  score: number;
};

export type WhereAmbiguous = { value: string; rules: RuleName[]; reason: string };
export type WhereReason = "too-common" | "ambiguous-date" | "unsupported-charset" | "no-match";

export type WhereResult = {
  schema: typeof WHERE_SCHEMA;
  query: WhereQuery;
  normalized: { value: string; rules: RuleName[] }[];
  candidates: WhereCandidate[];
  ambiguous?: WhereAmbiguous[];
  reason?: WhereReason;
};

export type WhereOptions = {
  top?: number;
  /** Visible text of the page the ref lives on (ref input only): proves DD/MM vs MM/DD. */
  pageText?: string | null;
};

type Judgement = { match: "exact" } | { match: "normalized"; rules: RuleName[] };

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function headerValue(h: Record<string, string | string[]>, name: string): string | null {
  const v = h[name];
  return typeof v === "string" ? v : (v?.[0] ?? null);
}

const CHARSET = /charset\s*=\s*["']?([A-Za-z0-9._:-]+)/i;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._:-]+)/i;
/**
 * Decode with any WHATWG encoding label TextDecoder knows at runtime (Bun's
 * types list fewer labels than it supports); throws RangeError on an unknown one.
 */
function decodeAs(label: string, bytes: Uint8Array): string {
  const d: unknown = Reflect.construct(TextDecoder, [label]);
  if (!(d instanceof TextDecoder)) throw new RangeError(`no decoder for ${label}`);
  return d.decode(bytes);
}
const isUtf8Label = (l: string): boolean => /^(utf-?8|unicode-1-1-utf-8)$/i.test(l);

/** Declared charset: the recorded response charset, the content-type parameter, else an HTML meta in the first 2 KiB. */
export function declaredCharset(r: RequestEvent, bytes: Uint8Array): string | null {
  const resp = r.response;
  if (resp === null) return null;
  const fromResp = resp.charset !== null && resp.charset !== "" ? resp.charset : null;
  const ct = headerValue(resp.headers, "content-type");
  const fromCt = ct === null ? null : (CHARSET.exec(ct)?.[1] ?? null);
  if (fromResp !== null || fromCt !== null) return (fromResp ?? fromCt ?? "").toLowerCase();
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  return META_CHARSET.exec(head)?.[1]?.toLowerCase() ?? null;
}

function isHtml(mime: string, text: string): boolean {
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  return mime === "" && /^\s*<(!doctype\s+html|html|head|body)\b/i.test(text);
}

const ORDER_REASON = (pageText: string | null | undefined): string => {
  if (pageText === null || pageText === undefined) return "text input: no page to disambiguate";
  const { dm, md } = pageDateOrders(pageText);
  return dm && md ? "the page has dates in both orders" : "no date on the page has a day over 12";
};

export function whereIn(reader: BundleReader, query: WhereQuery, opts: WhereOptions = {}): WhereResult {
  const top = opts.top ?? DEFAULT_TOP;
  if (!Number.isInteger(top) || top < 1 || top > MAX_TOP) throw new TabcapError("usage", `--top must be an integer from 1 to ${MAX_TOP}`, "Pass e.g. --top 5.");
  const all = normalize(query.text);
  const plain = all.filter((i) => i.ambiguous !== true);
  const unresolved = all.filter((i) => i.ambiguous === true);
  let interps: Interpretation[] = plain;
  let ambiguous: WhereAmbiguous[] = [];
  if (unresolved.length > 0) {
    const page = opts.pageText ?? null;
    const orders = page === null ? { dm: false, md: false } : pageDateOrders(page);
    const order = orders.dm === orders.md ? null : orders.dm ? "DD/MM/YYYY" : "MM/DD/YYYY";
    const picked = order === null ? [] : unresolved.filter((i) => i.reading === order);
    if (picked.length > 0) interps = all.filter((i) => i.ambiguous !== true || picked.includes(i));
    else ambiguous = unresolved.map((i) => ({ value: i.value, rules: i.rules, reason: `${i.reading ?? ""} reading; ${ORDER_REASON(page)}` }));
  }
  const normalized = interps.map((i) => ({ value: i.value, rules: i.rules }));
  const base = { schema: WHERE_SCHEMA, query, normalized } as const;
  const withAmb = ambiguous.length > 0 ? { ambiguous } : {};
  if (interps.length === 0 && ambiguous.length > 0) return { ...base, candidates: [], ...withAmb, reason: "ambiguous-date" };
  if (onlyEmptyClass(interps)) return { ...base, candidates: [], ...withAmb, reason: "too-common" };

  const qTrim = query.text.trim();
  const valueCap = Math.max(64, qTrim.length * 2 + 16);
  const cache = new Map<string, Judgement | null>();
  const judge = (t: string): Judgement | null => {
    if (t === qTrim) return { match: "exact" };
    if (t === "" || t.length > valueCap) return null;
    const have = cache.get(t);
    if (have !== undefined) return have;
    const vi = normalize(t).filter((i) => i.ambiguous !== true);
    const c = commonInterpretation(interps, vi);
    const j: Judgement | null = c === null ? null : { match: "normalized", rules: c.rules };
    if (cache.size < 200_000) cache.set(t, j);
    return j;
  };
  const matcher: Matcher = (s) => {
    if (s.length > valueCap + 256) return null;
    const t = s.trim();
    if (judge(t) === null) return null;
    return { index: s.indexOf(t), length: t.length, haystack: s };
  };

  type Found = WhereCandidate & { group: number; seq: number; ord: number };
  const found: Found[] = [];
  let ord = 0;
  const add = (r: RequestEvent, j: Judgement, where: { path?: string; selector?: string }, chain: StepName[], group: number) => {
    const rules = j.match === "normalized" ? j.rules : undefined;
    const score = j.match === "exact" ? 1 : round3(1 / (1 + (rules?.length ?? 0)));
    found.push({ request: r.id, ...where, chain, match: j.match, ...(rules === undefined ? {} : { rules }), score, group, seq: r.seq, ord: ord++ });
  };
  let unsupportedCharset = 0;
  const imported = reader.manifest.imported !== null && reader.manifest.imported !== undefined;

  for (const r of reader.requests()) {
    const resp = r.response;
    const body = resp?.body ?? null;
    if (resp === null || body === null || body.size > STEP_CAP) continue;
    const mime = resp.mimeType ?? headerValue(resp.headers, "content-type");
    const binaryByType = r.type === "image" || r.type === "font" || r.type === "media";
    if (isBinaryMime(mime) || (binaryByType && baseMime(mime) !== "image/svg+xml")) continue;
    const bytes = reader.readBlob(body.blob);
    if (bytes === null || bytes.length > STEP_CAP || binaryMagic(bytes) !== null) continue;
    const prefix = wirePrefix(imported, body.wireEncoding, body.decodeFailed === true);
    let text = utf8(bytes);
    if (text !== null && text.startsWith("﻿")) text = text.slice(1);
    if (text === null) {
      const cs = declaredCharset(r, bytes);
      if (cs !== null && !isUtf8Label(cs)) {
        try {
          text = decodeAs(cs, bytes);
        } catch {
          unsupportedCharset++;
          continue;
        }
      }
    }
    if (text !== null && isHtml(baseMime(mime), text)) {
      if (mayEmbed(text)) {
        const ex = new Explorer(matcher, { maxHits: MAX_HITS_PER_BODY, record: false, entropyEligible: false, wholeValues: true });
        for (const h of ex.exploreText(text, { mime }, prefix)) {
          if (h.node === undefined || h.paths.length === 0) continue; // the page's own text is the text-node pass below
          const j = judge(h.matched.trim());
          if (j !== null) add(r, j, { path: h.paths.join(" -> ") }, h.chain, 0);
        }
      }
      for (const node of htmlTextNodes(text)) {
        const j = judge(node.text);
        if (j !== null) add(r, j, { selector: node.selector }, [...prefix, ...(node.entities ? (["html-entities"] as const) : [])], 1);
      }
      continue;
    }
    const ex = new Explorer(matcher, { maxHits: MAX_HITS_PER_BODY, record: false, entropyEligible: false, wholeValues: true });
    const hits: DecodeHit[] = text !== null ? ex.exploreText(text, { mime }, prefix) : ex.exploreBytes(bytes, { mime }, prefix);
    for (const h of hits) {
      const j = judge(h.matched.trim());
      if (j === null) continue;
      add(r, j, h.paths.length === 0 ? {} : { path: h.paths.join(" -> ") }, h.chain, 0);
    }
  }

  found.sort((a, b) => a.group - b.group || b.score - a.score || a.seq - b.seq || a.ord - b.ord);
  const seen = new Set<string>();
  const candidates: WhereCandidate[] = [];
  for (const f of found) {
    const key = `${f.request}\t${f.path ?? ""}\t${f.selector ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { group: _g, seq: _s, ord: _o, ...c } = f;
    candidates.push(c);
    if (candidates.length >= top) break;
  }
  if (candidates.length > 0) return { ...base, candidates, ...withAmb };
  return { ...base, candidates, ...withAmb, reason: unsupportedCharset > 0 ? "unsupported-charset" : "no-match" };
}

export function where(bundleDir: string, query: WhereQuery, opts: WhereOptions = {}): WhereResult {
  return whereIn(BundleReader.open(bundleDir), query, opts);
}

// ------------------------------------------------------------ text rendering

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strOr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const ruleList = (v: unknown): RuleName[] => strs(v).filter((x): x is RuleName => (RULES as readonly string[]).includes(x));
const stepList = (v: unknown): StepName[] => strs(v).filter((x): x is StepName => (STEP_NAMES as readonly string[]).includes(x));

/** A where result read back from JSON (the CLI renders the daemon's answer); null when it is not one. */
export function whereResultOf(v: unknown): WhereResult | null {
  if (!isRecord(v) || v["schema"] !== WHERE_SCHEMA || !isRecord(v["query"])) return null;
  const q = v["query"];
  const kind: WhereKind = q["kind"] === "ref" ? "ref" : "text";
  const reasons: readonly WhereReason[] = ["too-common", "ambiguous-date", "unsupported-charset", "no-match"];
  const reason = reasons.find((r) => r === v["reason"]);
  const ambiguous = recs(v["ambiguous"]).map((a) => ({ value: strOr(a["value"]), rules: ruleList(a["rules"]), reason: strOr(a["reason"]) }));
  return {
    schema: WHERE_SCHEMA,
    query: { input: strOr(q["input"]), kind, ...(typeof q["ref"] === "string" ? { ref: q["ref"] } : {}), text: strOr(q["text"]) },
    normalized: recs(v["normalized"]).map((n) => ({ value: strOr(n["value"]), rules: ruleList(n["rules"]) })),
    candidates: recs(v["candidates"]).map((c) => ({
      request: strOr(c["request"]),
      ...(typeof c["path"] === "string" ? { path: c["path"] } : {}),
      ...(typeof c["selector"] === "string" ? { selector: c["selector"] } : {}),
      chain: stepList(c["chain"]),
      match: c["match"] === "exact" ? "exact" : "normalized",
      ...(Array.isArray(c["rules"]) ? { rules: ruleList(c["rules"]) } : {}),
      score: typeof c["score"] === "number" ? c["score"] : 0,
    })),
    ...(ambiguous.length > 0 ? { ambiguous } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
}

const rulesText = (r: readonly string[] | undefined): string => (r === undefined || r.length === 0 ? "" : ` [${r.join(", ")}]`);

/** Compact human rendering (`--text`). */
export function renderWhereText(r: WhereResult): string {
  const q = r.query;
  const head = q.kind === "ref" ? `where ${q.ref ?? q.input} (ref) ${JSON.stringify(q.text)}` : `where ${JSON.stringify(q.text)} (text)`;
  const lines = [head, `normalized: ${r.normalized.length === 0 ? "(none)" : r.normalized.map((n) => `${n.value}${rulesText(n.rules)}`).join("; ")}`];
  r.candidates.forEach((c, i) => {
    const at = c.path ?? c.selector ?? "(whole body)";
    lines.push(`${i + 1}. ${c.request} ${at}  ${c.match}${rulesText(c.rules)}  score ${c.score}  chain [${c.chain.join(",")}]`);
  });
  if (r.candidates.length === 0) lines.push("no candidates");
  for (const a of r.ambiguous ?? []) lines.push(`ambiguous: ${a.value}${rulesText(a.rules)} (${a.reason})`);
  if (r.reason !== undefined) lines.push(`reason: ${r.reason}`);
  return lines.join("\n");
}

// ------------------------------------------------------------ findings (--write-findings)

/**
 * One finding per candidate (tool where): grade 实测 for an exact match,
 * 推断 for a normalised one. The claim names the ref, the request and the
 * path, not the value; the input carries the query.
 */
export function whereFindings(r: WhereResult): FindingInput[] {
  const who = r.query.kind === "ref" ? `the value of ref ${r.query.ref ?? r.query.input}` : "the queried text";
  return r.candidates.map((c) => {
    const at = c.path ?? c.selector ?? "(whole body)";
    const how = c.match === "exact" ? "exact match" : `normalized: ${(c.rules ?? []).join(", ")}`;
    const chain = c.chain.length > 0 ? ` [${c.chain.join(",")}]` : "";
    return {
      actor: "ai",
      tool: "where",
      grade: c.match === "exact" ? "实测" : "推断",
      claim: `${who} is carried by ${c.request} ${at}${chain} (${how}; score ${c.score})`,
      evidence: [c.path !== undefined ? { request: c.request, path: c.path } : c.selector !== undefined ? { request: c.request, path: c.selector } : { request: c.request }],
      input: r.query,
      output: c,
    };
  });
}
