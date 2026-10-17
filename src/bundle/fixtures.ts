// `tabcap bundle export fixtures <bundle> --out <dir> [--rules f] [--format json|<plugin>]`
// (0.6-C, owner design 2026-10-16; docs/04 §31): one fixture per recorded
// exchange, keyed the way the replay rules read the request, so a project's
// offline tests can drop their hand-written replay scripts.
//
// Fixture (format json: fixtures/<n>-<METHOD>-<path slug>.json, plus index.json):
//   {schema: "tabcap-fixture/0",
//    key: {method, path, query, body},            canonical per the rule (rules.ts)
//    request: {url, headers, body, bodyEncoding?, bodyMissing?},
//    response: {status, headers, body + bodyEncoding | bodyFile | null, bodyMissing?, decoded?},
//    meta: {request: "r-N", rule, recordedAt, keyBody, keyFallback?}}
// Text bodies up to 64 KiB are inline (bodyEncoding "utf8"; a request body
// that is not UTF-8 is "base64"); larger or binary response bodies go to
// bodies/<sha256>.bin under --out (bodyFile is that relative path).
// `--format <plugin>`: each fixture goes to a fixture plugin
// (daemon/hooks/fixture.ts, tabcap-fixture/1), which answers with the files
// to write under --out; index.json and fixtures/ are then not written.
// Redaction: the bundle is redacted like HAR export (docs/04 §8) before
// anything is read, keys included; `--no-redact` keeps the recorded values
// (the login body with its password, as HAR export does). Files are 0600,
// directories 0700.
// Preflights and preference (0.6-S): CORS preflights (OPTIONS, common.ts
// isPreflight) are left out (skipped, reason "preflight") unless
// --include-preflight; a key whose rule prefers "2xx" / "latest" exports only
// the recordings `replay serve` answers it with, in recorded order, and lists
// the others in `notPreferred`. Fixture numbers count the fixtures written.
// Skipped summary (0.6-U): the answer's `skipped` counts the left-out
// exchanges per reason ({websocket: 113, preflight: 26, …}) and
// `skippedExamples` names at most 3 request ids per reason (the first in
// recorded order); index.json keeps the full per-exchange list.
// Oracle: the bundle (test/unit/fixtures-export.test.ts compares with the
// builder's bytes), docs/04 §31. Reproduce: bun test test/unit/fixtures-export.test.ts

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { sha256Hex } from "../shared/ids.ts";
import { tsToIso } from "../shared/time.ts";
import { isBinaryMime, utf8 } from "../analyze/decoders.ts";
import { decodedPayload } from "../analyze/views.ts";
import { headerJoined, isPreflight, requestBodyBytes, unreplayable, type Skipped } from "../replay/common.ts";
import { ReplayIndex, recordedViewPlain, type Plain } from "../replay/match.ts";
import { Plaintexts } from "../replay/plaintext.ts";
import { bodyKeyText, canonicalBody, canonicalQuery, pickRule, queryString, rulesInfo, type PreferMode, type RuleSet } from "../replay/rules.ts";
import { FixtureRunner, type FixturePlugin } from "../daemon/hooks/fixture.ts";
import { writeFileAtomic } from "./manifest.ts";
import { parseRequest, type BundleView } from "./reader.ts";
import { redactView } from "./redact.ts";
import type { Headers, RequestEvent } from "./types.ts";

export const FIXTURE_SCHEMA = "tabcap-fixture/0";
export const FIXTURES_INDEX_SCHEMA = "tabcap-fixtures/0";
/** Text bodies up to this size are inline in the fixture. */
export const MAX_INLINE_BODY = 64 * 1024;
const MAX_LISTED = 500;
/** Request ids named per skip reason in the answer (0.6-U). */
export const SKIPPED_EXAMPLES = 3;
const MAX_SLUG = 80;

export type Fixture = {
  schema: typeof FIXTURE_SCHEMA;
  key: { method: string; path: string; query: string; body: string | null };
  request: { url: string; headers: Headers; body: string | null; bodyEncoding?: "utf8" | "base64"; bodyMissing?: string };
  response: {
    status: number | null;
    headers: Headers;
    body?: string | null;
    bodyEncoding?: "utf8";
    bodyFile?: string;
    bodyMissing?: string;
    decoded?: { by: string; version: string; mime: string | null; body?: string; bodyFile?: string };
  };
  meta: { request: string; rule: string; recordedAt: string; keyBody: "form" | "json" | "raw" | "none"; keyFallback?: string };
};

export type FixturesOptions = {
  out: string;
  rules: RuleSet;
  /** "json", or a fixture plugin. */
  format: "json" | FixturePlugin;
  redact: { salt: string; knownSecrets: readonly string[] } | false;
  /** Where decode plugins are installed (body "decoded" rules with decodeWith). */
  configDir: string;
  /** Keep CORS preflights (default: skipped, reason "preflight"; 0.6-S). */
  includePreflight?: boolean;
  now?: () => number;
};

/** A recording left out because its key prefers others (0.6-S); `servedBy` became the key's fixtures. */
export type NotPreferred = { request: string; prefer: PreferMode; servedBy: string[] };

export type FixturesResult = {
  out: string;
  format: string;
  fixtures: number;
  files: string[];
  filesCount: number;
  index: string | null;
  rules: ReturnType<typeof rulesInfo>;
  redacted: boolean;
  /** Left-out exchanges per reason (0.6-U; index.json lists them one by one). */
  skipped: Record<string, number>;
  /** At most SKIPPED_EXAMPLES request ids per reason, in recorded order. */
  skippedExamples: Record<string, string[]>;
  notPreferred: NotPreferred[];
  failed: { request: string; error: string }[];
  plugin?: { name: string; version: string };
  warnings: string[];
};

/** `fixtures/<n>-<METHOD>-<path slug>.json`: the slug keeps letters, digits, `.`, `_`, `-`; anything else becomes `-`. */
export function fixtureFileName(n: number, method: string, path: string): string {
  const slug =
    path
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, MAX_SLUG)
      .replace(/[-.]+$/g, "") || "root";
  const m = method.toUpperCase().replace(/[^A-Z0-9]/g, "") || "X";
  return `fixtures/${n}-${m}-${slug}.json`;
}

function ensureEmptyDir(dir: string): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new TabcapError("usage", `--out is not a directory: ${dir}`, "Pass a new or empty directory.");
    if (readdirSync(dir).length > 0) throw new TabcapError("conflict", `--out directory is not empty: ${dir}`, "Pass a new or empty directory; fixtures are never written over earlier files.");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const noPseudo = (h: Headers): Headers => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(":")));

class Writer {
  readonly written: string[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly out: string) {}

  has(rel: string): boolean {
    return this.seen.has(rel);
  }

  write(rel: string, data: string | Uint8Array): void {
    const abs = join(this.out, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileAtomic(abs, data, 0o600);
    this.seen.add(rel);
    this.written.push(rel);
  }

  /** A body file under bodies/, written once per content. */
  body(bytes: Uint8Array): string {
    const rel = `bodies/${sha256Hex(bytes)}.bin`;
    if (!this.seen.has(rel)) this.write(rel, bytes);
    return rel;
  }
}

async function requestPlain(r: RequestEvent, view: BundleView, bytes: Uint8Array, decodeWith: string | null, plain: Plaintexts | null): Promise<Plain | null> {
  const v = recordedViewPlain(r, view, decodeWith);
  if (v !== null || decodeWith === null || plain === null || bytes.length === 0) return v;
  return plain.decode(decodeWith, { direction: "request", id: r.id, url: r.url, method: r.method, requestHeaders: r.request.headers, response: null, body: bytes, mime: headerJoined(r.request.headers, "content-type") });
}

async function buildFixture(r: RequestEvent, view: BundleView, rules: RuleSet, w: Writer, plain: Plaintexts | null, decoded: ReadonlyMap<string, Plain | null>): Promise<Fixture> {
  const rule = pickRule(rules, r);
  const u = new URL(r.url);
  const cq = canonicalQuery(u.search, rule);
  const body = requestBodyBytes(r, view);
  let keyBody: string | null = null;
  let as: Fixture["meta"]["keyBody"] = rule.key.body === "none" ? "none" : "raw";
  let fallback: string | null = null;
  const request: Fixture["request"] = { url: r.url, headers: noPseudo(r.request.headers), body: null };
  if ("bytes" in body) {
    const p = rule.key.body === "decoded" ? (decoded.has(r.id) ? (decoded.get(r.id) ?? null) : await requestPlain(r, view, body.bytes, rule.key.decodeWith, plain)) : null;
    const cb = canonicalBody(body.bytes, rule, p);
    keyBody = bodyKeyText(cb);
    as = cb.as;
    fallback = cb.fallback;
    if (body.bytes.length > 0) {
      const t = utf8(body.bytes);
      request.body = t ?? Buffer.from(body.bytes).toString("base64");
      request.bodyEncoding = t === null ? "base64" : "utf8";
    }
  } else request.bodyMissing = body.missing;

  const resp = r.response;
  const response: Fixture["response"] = { status: resp?.status ?? null, headers: resp === null ? {} : noPseudo(resp.headers) };
  if (resp?.body) {
    const bytes = view.readBlob(resp.body.blob);
    if (bytes === null) {
      response.body = null;
      response.bodyMissing = "blob-missing";
    } else {
      const mime = resp.mimeType ?? headerJoined(resp.headers, "content-type");
      const t = isBinaryMime(mime) || bytes.length > MAX_INLINE_BODY ? null : utf8(bytes);
      if (t !== null) {
        response.body = t;
        response.bodyEncoding = "utf8";
      } else response.bodyFile = w.body(bytes);
    }
  } else {
    response.body = null;
    if (resp?.bodyMissing) response.bodyMissing = resp.bodyMissing.reason;
  }
  const d = resp?.decoded;
  if (d !== undefined && d.ok) {
    const p = decodedPayload(view, d);
    if (p !== null) {
      const t = p.bytes.length > MAX_INLINE_BODY ? null : utf8(p.bytes);
      response.decoded = { by: d.by, version: d.version, mime: d.mime, ...(t !== null ? { body: t } : { bodyFile: w.body(p.bytes) }) };
    }
  }
  return {
    schema: FIXTURE_SCHEMA,
    key: { method: r.method.toUpperCase(), path: u.pathname, query: queryString(cq.pairs), body: keyBody },
    request,
    response,
    meta: { request: r.id, rule: rule.id, recordedAt: tsToIso(r.ts), keyBody: as, ...(fallback === null ? {} : { keyFallback: fallback }) },
  };
}

/** Pure: skipped exchanges counted per reason, with the first few ids of each as examples. */
export function summariseSkipped(list: readonly Skipped[], examples = SKIPPED_EXAMPLES): { skipped: Record<string, number>; skippedExamples: Record<string, string[]> } {
  const skipped: Record<string, number> = {};
  const skippedExamples: Record<string, string[]> = {};
  for (const x of list) {
    skipped[x.reason] = (skipped[x.reason] ?? 0) + 1;
    const ids = (skippedExamples[x.reason] ??= []);
    if (ids.length < examples) ids.push(x.id);
  }
  return { skipped, skippedExamples };
}

export async function exportFixtures(source: BundleView, opts: FixturesOptions): Promise<FixturesResult> {
  ensureEmptyDir(opts.out);
  const view: BundleView = opts.redact
    ? redactView(source, { salt: opts.redact.salt, knownSecrets: opts.redact.knownSecrets, ...(opts.now === undefined ? {} : { now: opts.now }) })
    : source;
  const requests: RequestEvent[] = [];
  const skipped: Skipped[] = [];
  for (const e of view.events) {
    if (e.kind !== "request") continue;
    const r = parseRequest(e);
    if (typeof r === "string") continue;
    const why = unreplayable(r) ?? (opts.includePreflight !== true && isPreflight(r) ? "preflight" : null);
    if (why === null) requests.push(r);
    else skipped.push({ id: r.id, reason: why });
  }
  const w = new Writer(opts.out);
  const needsPlain = opts.rules.rules.some((x) => x.key.body === "decoded" && x.key.decodeWith !== null);
  const plain = needsPlain ? new Plaintexts(opts.configDir) : null;
  // Keys with a preference other than "recorded": decode the bodies first (the key needs them), then keep the served recordings.
  const decoded = new Map<string, Plain | null>();
  const notPreferred: NotPreferred[] = [];
  let exported = requests;
  if (opts.rules.rules.some((x) => x.prefer !== "recorded")) {
    for (const r of requests) {
      const rule = pickRule(opts.rules, r);
      const body = requestBodyBytes(r, view);
      if (rule.key.body === "decoded" && "bytes" in body) decoded.set(r.id, await requestPlain(r, view, body.bytes, rule.key.decodeWith, plain));
    }
    const plainOf = new Map([...decoded].flatMap(([id, p]): [string, Plain][] => (p === null ? [] : [[id, p]])));
    const index = new ReplayIndex(requests, view, { strict: [], matchCookies: false, rules: opts.rules }, plainOf);
    const out = new Set<string>();
    for (const rec of index.recordings) {
      const served = index.servedFor(rec);
      if (served.includes(rec)) continue;
      out.add(rec.id);
      notPreferred.push({ request: rec.id, prefer: index.preferOf(rec), servedBy: served.map((x) => x.id) });
    }
    exported = requests.filter((r) => !out.has(r.id));
  }
  const runner = opts.format === "json" ? null : new FixtureRunner(opts.format);
  const failed: { request: string; error: string }[] = [];
  const listed: { file: string; request: string; method: string; path: string; query: string; status: number | null; rule: string }[] = [];
  const warnings: string[] = [];
  let count = 0;
  try {
    for (const r of exported) {
      const fx = await buildFixture(r, view, opts.rules, w, plain, decoded);
      if (runner === null) {
        const file = fixtureFileName(count + 1, r.method, fx.key.path);
        w.write(file, JSON.stringify(fx, null, 2) + "\n");
        listed.push({ file, request: r.id, method: fx.key.method, path: fx.key.path, query: fx.key.query, status: fx.response.status, rule: fx.meta.rule });
        count++;
        continue;
      }
      const res = await runner.convert(fx);
      if (!res.ok) {
        failed.push({ request: r.id, error: res.error });
        continue;
      }
      const clash = res.files.find((f) => w.has(f.path));
      if (clash !== undefined) {
        failed.push({ request: r.id, error: `the plugin wrote ${clash.path} twice in this run` });
        continue;
      }
      for (const f of res.files) w.write(f.path, f.data);
      count++;
    }
    let index: string | null = null;
    if (runner === null) {
      const doc = {
        schema: FIXTURES_INDEX_SCHEMA,
        bundle: source.manifest.id,
        exported: tsToIso((opts.now ?? Date.now)()),
        redacted: Boolean(opts.redact),
        rules: rulesInfo(opts.rules),
        count,
        fixtures: listed,
        skipped,
        notPreferred,
      };
      w.write("index.json", JSON.stringify(doc, null, 2) + "\n");
      index = join(opts.out, "index.json");
    }
    if (runner?.disabled) warnings.push(`fixture plugin ${runner.plugin.name} stopped: ${runner.disabled}`);
    if (opts.redact) warnings.push("redaction is rule based; free text in bodies may still hold personal data, review before sharing");
    return {
      out: opts.out,
      format: runner === null ? "json" : runner.plugin.name,
      fixtures: count,
      files: w.written.slice(0, MAX_LISTED),
      filesCount: w.written.length,
      index,
      rules: rulesInfo(opts.rules),
      redacted: Boolean(opts.redact),
      ...summariseSkipped(skipped),
      notPreferred: notPreferred.slice(0, MAX_LISTED),
      failed: failed.slice(0, MAX_LISTED),
      ...(runner === null ? {} : { plugin: { name: runner.plugin.name, version: runner.plugin.version } }),
      warnings,
    };
  } finally {
    runner?.close();
    await plain?.close();
  }
}
