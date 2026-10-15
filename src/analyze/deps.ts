// `tabcap analyze deps <bundle>`: a deterministic value-flow dependency graph
// (docs/03 §8: 录制 → 分析 → 回放 / 脚手架; `deps` is deterministic, a value
// that cannot be derived is marked `computed-in-page`, never guessed;
// docs/05 s06 P2 "sid 来自 set-cookie，sig 与 q/page/t/nonce 同变", s07 P2
// "deps 画出 csrf 链").
// Spec (0.4-A brief): every request input (query parameters, form / JSON body
// leaves, `x-*` / `authorization` headers, cookies by name) gets its sources,
// searched only among events before the value was first sent:
//   set-cookie   an earlier response's set-cookie (cookie inputs: name and
//                value; other inputs: value, distinctive values only)
//   response     a leaf of an earlier response body after the analyze decode
//                chain (JSON path as `analyze find` reports it), or a token in
//                text / HTML (distinctive values of >= 8 characters only)
//   action       a recorded fill / type value (action events, cmd fill / type;
//                `--secret` fills are `<secret:…>` placeholders and only ever
//                match that placeholder)
//   request      an earlier request's same-named input with the same value
//   constant     the same value in every recorded occurrence (analyze diff
//                grouping; a single occurrence counts, hint `single-sample`)
//   timestamp    analyze diff's timestamp class
// Priority set-cookie > response > action > request > constant > timestamp;
// the first source is `primary`. No source: `unrecorded` for cookies (the
// browser held them before the recording), else `computed-in-page`, with the
// diff hints and the co-varying inputs of the same request group.
// Matching is exact on the normalised string form only: trimmed; query / form
// values URL-decoded (URLSearchParams); JSON scalars stringified.
// Echo rule: a producer (set-cookie, response, action) only counts when it
// happened before the value was first sent by any request; a value the page
// sent before any response carried it was not derived from that response.
// Oracle: test/unit/deps.test.ts builds bundles with known value flows (each
// case states the flow it plants); test/e2e/v04a.e2e.test.ts records docs/05
// s06 and s07 on the range site, expected values from the site.
// Reproduce: bun test test/unit/deps.test.ts

import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { BundleReader } from "../bundle/reader.ts";
import { isSensitiveHeader, isSensitiveName } from "../bundle/redact.ts";
import type { RawEvent, RequestEvent } from "../bundle/types.ts";
import { classifyGroup, groupRequests, headerValues, singleSampleParams, splitKey, type DiffParam, type ParamLocation } from "./diff.ts";
import { Explorer, STEP_CAP, baseMime, binaryMagic, isBinaryMime, jsonPathIndex, jsonPathKey, parseJsonDoc, type DecodeHit, type Matcher, type StepName } from "./decoders.ts";

export const DEPS_SCHEMA = "tabcap-deps/0";
/** Shortest value matched by value alone (response body, action, set-cookie under another name). */
export const MIN_VALUE_LENGTH = 4;
/** Shortest value matched inside a longer text (HTML, a JSON string leaf). */
export const MIN_EMBEDDED_LENGTH = 8;
/** Pure numbers shorter than this are not matched by value (counts, pages, small ids). */
export const MIN_NUMBER_LENGTH = 6;
/** Most sources kept per kind for one input (latest first). */
export const MAX_SOURCES_PER_KIND = 10;
/** Explorer re-runs per body when text-level hits hide further values. */
const MAX_BODY_RUNS = 16;
/** daemon/main.ts writes this as `text` of a fill / type start event; the value is in the end event. */
const DEFERRED_PREFIX = "<deferred";

export type InputLocation = "query" | "body" | "header" | "cookie";
export type SourceKind = "set-cookie" | "response" | "action" | "request" | "constant" | "timestamp";
export type DepsClass = SourceKind | "computed-in-page" | "unrecorded";

export type DepsSource = {
  kind: SourceKind;
  /** set-cookie / response / request: the request that carried the value. */
  request?: string;
  /** response: JSON path of the leaf (" -> " joins nested documents), absent for text; request: `<location>:<name or JSON path>`. */
  path?: string;
  /** set-cookie: cookie name. */
  cookie?: string;
  /** action: seq of the action event (or of the fill / type command's start event). */
  action?: number;
  /** response: decode steps applied (analyze find step names). */
  decode?: StepName[];
  /** response: the leaf / text is the value (exact) or contains it as a token (embedded). */
  match?: "exact" | "embedded";
  /** action: the store reference of a `--secret` fill. */
  secret?: string;
  /** constant / timestamp: recorded occurrences compared. */
  samples?: number;
};

export type DepsInput = {
  location: InputLocation;
  name: string;
  /** JSON body leaves: the JSON path. */
  path?: string;
  class: DepsClass;
  primary: DepsSource | null;
  sources: DepsSource[];
  hints: string[];
  covaries: string[];
};

export type DepsRequest = { id: string; method: string; url: string; inputs: DepsInput[] };

export type DepsEdge = {
  kind: "set-cookie" | "response" | "request";
  from: { request: string; path?: string; cookie?: string };
  to: { request: string; location: InputLocation; name: string; path?: string };
};

export type Unresolved = { request: string; location: InputLocation; name: string; path?: string; class: "computed-in-page" | "unrecorded" };

export type DepsResult = {
  schema: typeof DEPS_SCHEMA;
  bundle: string;
  requests: DepsRequest[];
  edges: DepsEdge[];
  unresolved: Unresolved[];
  warnings: string[];
};

export type DepsOptions = { session?: string | undefined; request?: string | undefined };

/** An input with what the graph needs internally: the analyze diff key and the value. */
export type ResolvedInput = DepsInput & { key: string; value: string };

type When = { t: number; seq: number };
type RawInput = { location: InputLocation; name: string; path?: string; key: string; value: string; diffLoc: ParamLocation; diffName: string };
type SetCookieRec = { request: string; name: string; value: string; when: When };
type BodyRec = { request: string; path: string | null; decode: StepName[]; match: "exact" | "embedded"; when: When };
type ActionRec = { seq: number; value: string; when: When; secret: string | null };
type SentRec = { request: string; location: InputLocation; label: string; when: When };

const BOOLISH = /^(true|false|null|undefined|none|nan)$/i;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** Long and specific enough to be matched by value alone. */
export function distinctive(v: string): boolean {
  if (v.length < MIN_VALUE_LENGTH || BOOLISH.test(v)) return false;
  return !(NUMERIC.test(v) && v.length < MIN_NUMBER_LENGTH);
}

const before = (a: When, b: When): boolean => a.t < b.t || (a.t === b.t && a.seq < b.seq);

/** Request start (wall ms): the event `ts` is the completion time (docs/04 §13 HAR rule 2). */
export function startedAt(r: RequestEvent): number {
  const start = r.timing?.start ?? null;
  if (start === null || r.mono === null) return r.ts;
  const t = r.ts - (r.mono - start);
  return Number.isFinite(t) ? t : r.ts;
}

/** When the response headers arrived (set-cookie is usable from then on). */
function headersAt(r: RequestEvent): number {
  const rs = r.timing?.responseStart ?? null;
  if (rs === null || r.mono === null) return r.ts;
  const t = r.ts - (r.mono - rs);
  return Number.isFinite(t) ? t : r.ts;
}

/** The last name of a JSON path (`$.a.b` → `b`, `$["x y"]` → `x y`, `$.a[2]` → `a[2]`). */
export function jsonLeafName(path: string): string {
  const quoted = /\[("(?:[^"\\]|\\.)*")\]$/.exec(path);
  if (quoted?.[1] !== undefined) {
    try {
      const k: unknown = JSON.parse(quoted[1]);
      if (typeof k === "string") return k;
    } catch {
      // fall through
    }
  }
  const idx = /^(.*?)((?:\[\d+\])+)$/.exec(path);
  if (idx?.[1] !== undefined && idx[2] !== undefined) return `${idx[1] === "$" ? "" : jsonLeafName(idx[1])}${idx[2]}`;
  const dot = /\.([^.[\]]+)$/.exec(path);
  return dot?.[1] ?? path;
}

/** `<location>:<name or path>`: how an earlier request's input is referred to. */
export const inputLabel = (i: { location: InputLocation; name: string; path?: string }): string => `${i.location}:${i.path ?? i.name}`;

const stripIndex = (n: string): string => n.replace(/\[\d+\]$/, "");

function toRawInputs(params: ReadonlyMap<string, string>): RawInput[] {
  const out: RawInput[] = [];
  for (const [key, raw] of params) {
    const { location, name } = splitKey(key);
    const value = raw.trim();
    if (location === "header") {
      if (!(name.startsWith("x-") || name === "authorization")) continue;
      out.push({ location: "header", name, key, value, diffLoc: location, diffName: name });
    } else if (location === "json") out.push({ location: "body", name: jsonLeafName(name), path: name, key, value, diffLoc: location, diffName: name });
    else if (location === "form") out.push({ location: "body", name, key, value, diffLoc: location, diffName: name });
    else out.push({ location, name, key, value, diffLoc: location, diffName: name });
  }
  const rank: Record<InputLocation, number> = { query: 0, body: 1, header: 2, cookie: 3 };
  return out.sort((a, b) => rank[a.location] - rank[b.location]);
}

/** A set matcher: a whole leaf / text equal to a value, or a token of a longer text. */
function setMatcher(exact: ReadonlySet<string>, embedded: ReadonlySet<string>): Matcher {
  const WIDE = /[A-Za-z0-9._~+/=-]+/g;
  const NARROW = /[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*/g;
  return (s) => {
    const t = s.trim();
    if (exact.has(t)) return { index: s.indexOf(t), length: t.length, haystack: s };
    if (embedded.size === 0 || s.length <= MIN_EMBEDDED_LENGTH) return null;
    for (const re of [WIDE, NARROW]) {
      re.lastIndex = 0;
      for (let m = re.exec(s); m !== null; m = re.exec(s)) {
        const tok = m[0];
        if (tok.length >= MIN_EMBEDDED_LENGTH && embedded.has(tok)) return { index: m.index, length: tok.length, haystack: s };
      }
    }
    return null;
  };
}

function setCookiePairs(r: RequestEvent): { name: string; value: string }[] {
  if (r.response === null) return [];
  const out: { name: string; value: string }[] = [];
  for (const raw of headerValues(r.response.headers, "set-cookie")) {
    for (const line of raw.split("\n")) {
      const first = line.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      out.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() });
    }
  }
  return out;
}

const SECRET = /^<secret:([^<>]+)>$/;

/** The dependency graph of one bundle; inputs are resolved on demand and memoised. */
export class DepsGraph {
  readonly reader: BundleReader;
  readonly requests: RequestEvent[];
  readonly byId = new Map<string, RequestEvent>();
  readonly warnings: string[] = [];
  /** Session name each request was recorded under (session events; else the manifest's). */
  readonly sessionOf = new Map<string, string>();
  private readonly raw = new Map<string, RawInput[]>();
  private readonly groupOf = new Map<string, string>();
  private readonly classes = new Map<string, Map<string, DiffParam>>();
  private readonly groupSamples = new Map<string, number>();
  private readonly distinctValues = new Map<string, Map<string, Set<string>>>();
  private readonly groupPresence = new Map<string, Map<string, number>>();
  private readonly firstSent = new Map<string, When>();
  private readonly sent = new Map<string, SentRec[]>();
  private readonly cookiesByName = new Map<string, SetCookieRec[]>();
  private readonly cookiesByValue = new Map<string, SetCookieRec[]>();
  private readonly bodies = new Map<string, BodyRec[]>();
  private readonly actions = new Map<string, ActionRec[]>();
  private readonly resolved = new Map<string, ResolvedInput[]>();
  private readonly when = new Map<string, When>();

  private constructor(reader: BundleReader) {
    this.reader = reader;
    this.requests = reader.requests();
    for (const r of this.requests) {
      this.byId.set(r.id, r);
      this.when.set(r.id, { t: startedAt(r), seq: r.seq });
    }
    if (!reader.isComplete()) this.warnings.push("bundle is not finished (未收尾): recording in progress or interrupted");
    if (reader.truncatedLastLine) this.warnings.push("events.jsonl ends with a truncated line; it was skipped");
    this.indexSessions();
    this.indexInputs();
    this.indexSetCookies();
    this.indexActions();
    this.indexBodies();
  }

  static open(dir: string): DepsGraph {
    return new DepsGraph(BundleReader.open(dir));
  }

  static of(reader: BundleReader): DepsGraph {
    return new DepsGraph(reader);
  }

  private indexSessions(): void {
    const m = this.reader.manifest;
    let current = m.session.name !== "" ? m.session.name : m.id;
    for (const e of this.reader.events) {
      if (e.kind === "session" && e["phase"] === "start" && typeof e["name"] === "string" && e["name"] !== "") current = e["name"];
      else if (e.kind === "request" && typeof e["id"] === "string") this.sessionOf.set(e["id"], current);
    }
  }

  private indexInputs(): void {
    const m = this.reader.manifest;
    const sessionKey = m.session.name !== "" ? m.session.name : m.id;
    const { groups, cookieValues } = groupRequests([{ label: "b1", sessionKey, requests: this.requests, readBlob: (ref) => this.reader.readBlob(ref) }], (w) => this.warnings.push(w));
    for (const [key, g] of groups) {
      const params = g.samples.length >= 2 ? (classifyGroup(key, g, cookieValues, 1)?.params ?? []) : singleSampleParams(g);
      const byKey = new Map<string, DiffParam>();
      for (const p of params) byKey.set(`${p.location}\t${p.name}`, p);
      this.classes.set(key, byKey);
      this.groupSamples.set(key, g.samples.length);
      const distinct = new Map<string, Set<string>>();
      const presence = new Map<string, number>();
      for (const s of g.samples) {
        this.groupOf.set(s.ref, key);
        const inputs = toRawInputs(s.params);
        this.raw.set(s.ref, inputs);
        for (const i of inputs) {
          const d = distinct.get(i.key) ?? new Set<string>();
          d.add(i.value);
          distinct.set(i.key, d);
          presence.set(i.key, (presence.get(i.key) ?? 0) + 1);
        }
      }
      this.distinctValues.set(key, distinct);
      this.groupPresence.set(key, presence);
    }
    for (const r of this.requests) {
      const w = this.whenOf(r.id);
      for (const i of this.raw.get(r.id) ?? []) {
        const f = this.firstSent.get(i.value);
        if (f === undefined || before(w, f)) this.firstSent.set(i.value, w);
        const k = `${stripIndex(i.name)}\t${i.value}`;
        const list = this.sent.get(k) ?? [];
        list.push({ request: r.id, location: i.location, label: inputLabel(i), when: w });
        this.sent.set(k, list);
      }
    }
    for (const list of this.sent.values()) list.sort((a, b) => (before(a.when, b.when) ? -1 : before(b.when, a.when) ? 1 : 0));
  }

  private indexSetCookies(): void {
    for (const r of this.requests) {
      const when: When = { t: headersAt(r), seq: r.seq };
      for (const { name, value } of setCookiePairs(r)) {
        const rec: SetCookieRec = { request: r.id, name, value, when };
        const byName = this.cookiesByName.get(name) ?? [];
        byName.push(rec);
        this.cookiesByName.set(name, byName);
        if (distinctive(value)) {
          const byValue = this.cookiesByValue.get(value) ?? [];
          byValue.push(rec);
          this.cookiesByValue.set(value, byValue);
        }
      }
    }
  }

  private indexActions(): void {
    const add = (seq: number, t: number, rawValue: string) => {
      const value = rawValue.trim();
      if (value === "") return;
      const m = SECRET.exec(value);
      const list = this.actions.get(value) ?? [];
      list.push({ seq, value, when: { t, seq }, secret: m?.[1] ?? null });
      this.actions.set(value, list);
    };
    const starts = new Map<string, RawEvent>();
    const ends = new Map<string, RawEvent>();
    for (const e of this.reader.events) {
      if (e.kind === "action") {
        const op = e["op"];
        const v = e["value"];
        if ((op === "fill" || op === "type") && typeof v === "string" && e["phase"] !== "failed") add(e.seq, e.ts, v);
      } else if (e.kind === "cmd") {
        if (e["phase"] === "start" && typeof e["id"] === "string") starts.set(e["id"], e);
        else if (e["phase"] === "end" && typeof e["ref"] === "string") ends.set(e["ref"], e);
      }
    }
    for (const [id, s] of starts) {
      const end = ends.get(id);
      if (end !== undefined && end["ok"] === false) continue;
      const si = isRecord(s["input"]) ? s["input"] : {};
      const ei = end !== undefined && isRecord(end["input"]) ? end["input"] : null;
      const action = si["action"];
      if (action !== "fill" && action !== "type") continue;
      const text = [ei?.["text"], si["text"]].find((t): t is string => typeof t === "string" && !t.startsWith(DEFERRED_PREFIX));
      const secret = [si["secret"], ei?.["secret"]].find((x): x is string => typeof x === "string" && x !== "");
      const value = text ?? (secret === undefined ? null : `<secret:${secret}>`);
      if (value !== null) add(s.seq, s.ts, value);
    }
  }

  private indexBodies(): void {
    const exact = new Set<string>();
    for (const inputs of this.raw.values()) for (const i of inputs) if (distinctive(i.value)) exact.add(i.value);
    if (exact.size === 0) return;
    let budgetWarned = false;
    for (const r of this.requests) {
      const body = r.response?.body;
      if (body === undefined || body === null || body.size > STEP_CAP) continue;
      const mime = r.response?.mimeType ?? null;
      const binaryByType = r.type === "image" || r.type === "font" || r.type === "media";
      if (isBinaryMime(mime) || (binaryByType && baseMime(mime) !== "image/svg+xml")) continue;
      const bytes = this.reader.readBlob(body.blob);
      if (bytes === null || bytes.length > STEP_CAP || binaryMagic(bytes) !== null) continue;
      const when: When = { t: r.ts, seq: r.seq };
      const active = new Set(exact);
      for (let run = 0; run < MAX_BODY_RUNS && active.size > 0; run++) {
        const embedded = new Set([...active].filter((v) => v.length >= MIN_EMBEDDED_LENGTH));
        const ex = new Explorer(setMatcher(active, embedded), { maxHits: 5000, record: false, entropyEligible: false });
        const hits: DecodeHit[] = ex.exploreBytes(bytes, { mime });
        if (ex.budgetExceeded && !budgetWarned) {
          this.warnings.push(`${r.id}: decode budget exhausted; response sources may be incomplete`);
          budgetWarned = true;
        }
        let again = false;
        for (const h of hits) {
          const value = h.matched.trim();
          const match: "exact" | "embedded" = h.whole ? "exact" : "embedded";
          if (match === "embedded" || h.paths.length === 0) again = true;
          const list = this.bodies.get(value) ?? [];
          const path = h.paths.length === 0 ? null : h.paths.join(" -> ");
          if (!list.some((x) => x.request === r.id && x.path === path)) list.push({ request: r.id, path, decode: h.chain, match, when });
          this.bodies.set(value, list);
          active.delete(value);
        }
        if (!again) break;
      }
    }
  }

  whenOf(id: string): When {
    return this.when.get(id) ?? { t: 0, seq: 0 };
  }

  groupKeyOf(id: string): string | null {
    return this.groupOf.get(id) ?? null;
  }

  /** Inputs of one request with their sources (memoised). */
  inputs(id: string): ResolvedInput[] {
    const done = this.resolved.get(id);
    if (done !== undefined) return done;
    const r = this.byId.get(id);
    if (r === undefined) return [];
    const out = (this.raw.get(id) ?? []).map((i) => this.resolve(r, i));
    this.resolved.set(id, out);
    return out;
  }

  private resolve(r: RequestEvent, i: RawInput): ResolvedInput {
    const v = i.value;
    const self = this.whenOf(r.id);
    const fs = this.firstSent.get(v) ?? self;
    const isCookie = i.location === "cookie";
    const sources: DepsSource[] = [];
    const latestFirst = <T extends { when: When }>(xs: readonly T[]) => [...xs].sort((a, b) => (before(a.when, b.when) ? 1 : before(b.when, a.when) ? -1 : 0)).slice(0, MAX_SOURCES_PER_KIND);

    // set-cookie (a cookie matched by name only needs to precede the first send of that cookie)
    const cookieName = stripIndex(i.name);
    const fsCookie = this.sent.get(`${cookieName}\t${v}`)?.[0]?.when ?? self;
    const cookies = isCookie ? (this.cookiesByName.get(cookieName) ?? []).filter((c) => c.value === v) : distinctive(v) ? (this.cookiesByValue.get(v) ?? []) : [];
    for (const c of latestFirst(cookies.filter((c) => c.request !== r.id && before(c.when, isCookie ? fsCookie : fs)))) sources.push({ kind: "set-cookie", request: c.request, cookie: c.name });

    // response body
    if (distinctive(v)) {
      const hits = (this.bodies.get(v) ?? []).filter((b) => b.request !== r.id && before(b.when, fs));
      for (const b of latestFirst(hits)) sources.push({ kind: "response", request: b.request, ...(b.path === null ? {} : { path: b.path }), decode: b.decode, match: b.match });
    }

    // action
    const acts = (distinctive(v) || SECRET.test(v) ? (this.actions.get(v) ?? []) : []).filter((a) => before(a.when, fs));
    for (const a of latestFirst(acts)) sources.push({ kind: "action", action: a.seq, ...(a.secret === null ? {} : { secret: a.secret }) });

    // carried forward from an earlier request
    const carried = (this.sent.get(`${stripIndex(i.name)}\t${v}`) ?? []).filter((s) => s.request !== r.id && before(s.when, self));
    const last = carried[carried.length - 1];
    if (last !== undefined) sources.push({ kind: "request", request: last.request, path: last.label });

    // constant / timestamp (analyze diff classes over the request group)
    const gk = this.groupOf.get(r.id) ?? "";
    const dp = this.classes.get(gk)?.get(`${i.diffLoc}\t${i.diffName}`);
    const samples = this.groupSamples.get(gk) ?? 1;
    const hints = new Set<string>(dp?.hints ?? []);
    if (dp !== undefined && !isCookie && (dp.class === "constant" || dp.class === "constant-or-session")) {
      sources.push({ kind: "constant", samples });
      if (samples === 1) hints.add("single-sample");
    }
    if (dp?.class === "timestamp") sources.push({ kind: "timestamp", samples });

    const primary = sources[0] ?? null;
    const cls: DepsClass = primary !== null ? primary.kind : isCookie ? "unrecorded" : "computed-in-page";
    if (isSensitiveName(i.name) || (i.location === "header" && isSensitiveHeader(i.name))) hints.add("sensitive-name");
    return {
      location: i.location,
      name: i.name,
      ...(i.path === undefined ? {} : { path: i.path }),
      class: cls,
      primary,
      sources,
      hints: [...hints],
      covaries: this.covaries(r.id, i),
      key: i.key,
      value: v,
    };
  }

  /** Other inputs of the request's group whose value differs between recorded occurrences, when this one does too. */
  private covaries(id: string, i: RawInput): string[] {
    const gk = this.groupOf.get(id) ?? "";
    const samples = this.groupSamples.get(gk) ?? 1;
    if (samples < 2) return [];
    const distinct = this.distinctValues.get(gk);
    const presence = this.groupPresence.get(gk);
    const varies = (key: string) => (distinct?.get(key)?.size ?? 0) > 1 || (presence?.get(key) ?? 0) < samples;
    if (!varies(i.key)) return [];
    const names: string[] = [];
    for (const o of this.raw.get(id) ?? []) if (o.key !== i.key && varies(o.key) && !names.includes(o.name)) names.push(o.name);
    return names;
  }

  /** Follow carried-forward (`request`) sources back to the input that has another kind of source. */
  root(id: string, input: ResolvedInput): { request: string; input: ResolvedInput } {
    let cur = { request: id, input };
    const seen = new Set<string>();
    while (cur.input.primary?.kind === "request") {
      const p = cur.input.primary;
      const from = p.request ?? "";
      const k = `${from}\t${p.path ?? ""}`;
      if (seen.has(k) || from === cur.request) break;
      seen.add(k);
      const next = this.inputs(from).find((x) => inputLabel(x) === p.path);
      if (next === undefined) break;
      cur = { request: from, input: next };
    }
    return cur;
  }

  /** Requests selected by --session / --request (recording order). */
  select(opts: DepsOptions): RequestEvent[] {
    let list = this.requests;
    if (opts.session !== undefined) {
      const names = [...new Set(this.sessionOf.values())];
      list = list.filter((r) => this.sessionOf.get(r.id) === opts.session);
      if (list.length === 0) throw new TabcapError("not-found", `no request recorded under session "${opts.session}"`, `Sessions in this bundle: ${names.join(", ") || "(none)"}.`);
    }
    if (opts.request !== undefined) {
      const one = list.find((r) => r.id === opts.request);
      if (one === undefined) throw new TabcapError("not-found", `no request ${opts.request}${opts.session === undefined ? "" : ` in session "${opts.session}"`}`, "Request ids are r-<seq>; list them with `tabcap net list` or `tabcap analyze deps <bundle>`.");
      list = [one];
    }
    return list;
  }
}

/** The public form of an input (no key, no value). */
export function publicInput(i: ResolvedInput): DepsInput {
  return { location: i.location, name: i.name, ...(i.path === undefined ? {} : { path: i.path }), class: i.class, primary: i.primary, sources: i.sources, hints: i.hints, covaries: i.covaries };
}

export function depsOf(g: DepsGraph, bundle: string, opts: DepsOptions = {}): DepsResult {
  const selected = g.select(opts);
  const requests: DepsRequest[] = [];
  const edges: DepsEdge[] = [];
  const unresolved: Unresolved[] = [];
  for (const r of selected) {
    const inputs = g.inputs(r.id);
    requests.push({ id: r.id, method: r.method, url: r.url, inputs: inputs.map(publicInput) });
    for (const i of inputs) {
      const to = { request: r.id, location: i.location, name: i.name, ...(i.path === undefined ? {} : { path: i.path }) };
      const p = i.primary;
      if (p !== null && p.request !== undefined && (p.kind === "set-cookie" || p.kind === "response" || p.kind === "request")) {
        edges.push({ kind: p.kind, from: { request: p.request, ...(p.path === undefined ? {} : { path: p.path }), ...(p.cookie === undefined ? {} : { cookie: p.cookie }) }, to });
      }
      if (i.class === "computed-in-page" || i.class === "unrecorded") unresolved.push({ ...to, class: i.class });
    }
  }
  return { schema: DEPS_SCHEMA, bundle, requests, edges, unresolved, warnings: [...g.warnings] };
}

export function deps(bundleDir: string, opts: DepsOptions = {}): DepsResult {
  return depsOf(DepsGraph.open(bundleDir), bundleDir, opts);
}

// ------------------------------------------------------------ text rendering

function describeSource(s: DepsSource | null): string {
  if (s === null) return "";
  switch (s.kind) {
    case "set-cookie":
      return `${s.request ?? ""} set-cookie ${s.cookie ?? ""}`;
    case "response":
      return `${s.request ?? ""} response ${s.path ?? "(text)"}${s.decode !== undefined && s.decode.length > 0 ? ` [${s.decode.join(",")}]` : ""}${s.match === "embedded" ? " (embedded)" : ""}`;
    case "action":
      return `action @${s.action ?? ""}${s.secret === undefined ? "" : ` <secret:${s.secret}>`}`;
    case "request":
      return `${s.request ?? ""} ${s.path ?? ""}`;
    default:
      return `${s.samples ?? 0} sample(s)`;
  }
}

function oneLine(s: string, max = 100): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function renderDepsText(r: DepsResult): string {
  const lines = [`deps of ${r.bundle}: ${r.requests.length} request(s), ${r.edges.length} edge(s), ${r.unresolved.length} unresolved`];
  for (const q of r.requests) {
    if (q.inputs.length === 0) continue;
    lines.push("", `${q.id} ${q.method} ${oneLine(q.url)}`);
    for (const i of q.inputs) {
      const extra = [i.hints.length > 0 ? `[${i.hints.join(",")}]` : "", i.covaries.length > 0 ? `varies with ${i.covaries.join(", ")}` : ""].filter((x) => x !== "").join(" ");
      lines.push(`  ${i.location.padEnd(6)} ${oneLine(i.path ?? i.name, 40).padEnd(24)} ${i.class.padEnd(16)} ${describeSource(i.primary)}${extra === "" ? "" : `  ${extra}`}`.trimEnd());
    }
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

// ------------------------------------------------------------ findings (--write-findings)

/** Most finding events one `deps --write-findings` run appends. */
export const MAX_FINDINGS = 500;
const FINDING_TYPES = new Set(["xhr", "fetch", "document"]);

export type DepsFinding = {
  actor: "ai";
  tool: "deps";
  grade: "实测" | "推断";
  claim: string;
  evidence: Record<string, unknown>[];
  input: unknown;
  output: unknown;
};

/** The JSON leaf at a path as walkJson writes it (`$.a[0]["b c"]`), or undefined. */
function leafAt(doc: unknown, path: string): unknown {
  const stack: { v: unknown; p: string }[] = [{ v: doc, p: "$" }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) return undefined;
    if (Array.isArray(top.v)) top.v.forEach((x, i) => stack.push({ v: x, p: jsonPathIndex(top.p, i) }));
    else if (typeof top.v === "object" && top.v !== null) for (const [k, x] of Object.entries(top.v)) stack.push({ v: x, p: jsonPathKey(top.p, k) });
    else if (top.p === path) return top.v;
  }
  return undefined;
}

/**
 * Re-read the source from a fresh reader of the bundle and compare it with the
 * value exactly: true only for set-cookie, plain JSON leaves (no decode step)
 * and actions. Decoded or embedded matches stay 推断.
 */
function reread(reader: BundleReader, value: string, s: DepsSource): boolean {
  if (s.kind === "set-cookie") {
    const r = reader.requests().find((x) => x.id === s.request);
    return r !== undefined && setCookiePairs(r).some((c) => c.name === s.cookie && c.value === value);
  }
  if (s.kind === "response") {
    if (s.match !== "exact" || (s.decode ?? []).length > 0 || s.path === undefined || s.path.includes(" -> ")) return false;
    const r = reader.requests().find((x) => x.id === s.request);
    const body = r?.response?.body;
    const bytes = body ? reader.readBlob(body.blob) : null;
    const doc = bytes === null ? null : parseJsonDoc(new TextDecoder().decode(bytes));
    if (doc === null) return false;
    const leaf = leafAt(doc.value, s.path);
    return leaf !== undefined && (typeof leaf === "string" ? leaf : JSON.stringify(leaf)).trim() === value;
  }
  if (s.kind === "action") {
    const e = reader.events.find((x) => x.seq === s.action);
    if (e === undefined) return false;
    const inp = isRecord(e["input"]) ? e["input"] : {};
    const candidates: unknown[] = [e["value"], inp["text"], typeof inp["secret"] === "string" ? `<secret:${inp["secret"]}>` : null];
    if (e.kind === "cmd" && typeof e["id"] === "string") {
      const end = reader.events.find((x) => x.kind === "cmd" && x["phase"] === "end" && x["ref"] === e["id"]);
      const ei = end !== undefined && isRecord(end["input"]) ? end["input"] : {};
      candidates.push(ei["text"]);
    }
    return candidates.some((c) => typeof c === "string" && c.trim() === value);
  }
  return false;
}

/**
 * Finding events for `--write-findings`: one per value flow (a set-cookie /
 * response / action source and the inputs it feeds, grouped), and one per
 * unresolved input of an xhr / fetch / document request. Claims name
 * requests, inputs and paths, never values.
 */
export function depsFindings(g: DepsGraph, result: DepsResult): DepsFinding[] {
  const fresh = BundleReader.open(g.reader.dir);
  type Consumer = { request: string; label: string; location: InputLocation; name: string; value: string };
  const flows = new Map<string, { source: DepsSource; consumers: Consumer[] }>();
  const unresolved: DepsFinding[] = [];
  for (const q of result.requests) {
    const r = g.byId.get(q.id);
    for (const i of g.inputs(q.id)) {
      const p = i.primary;
      if (p !== null && (p.kind === "set-cookie" || p.kind === "response" || p.kind === "action")) {
        const k = [p.kind, p.request ?? "", p.path ?? "", p.cookie ?? "", p.action ?? "", i.location, i.name].join("\t");
        const f = flows.get(k) ?? { source: p, consumers: [] };
        f.consumers.push({ request: q.id, label: inputLabel(i), location: i.location, name: i.name, value: i.value });
        flows.set(k, f);
      } else if ((i.class === "computed-in-page" || i.class === "unrecorded") && r !== undefined && FINDING_TYPES.has(r.type)) {
        const extra = [...i.hints, ...(i.covaries.length > 0 ? [`varies with ${i.covaries.join(", ")}`] : [])].join("; ");
        unresolved.push({
          actor: "ai",
          tool: "deps",
          grade: "推断",
          claim: `${i.location} ${i.path ?? i.name} of ${q.id} ${i.class === "unrecorded" ? "was set before the recording (unrecorded)" : "is computed in the page (no source in the recording)"}${extra === "" ? "" : ` (${extra})`}`,
          evidence: [{ request: q.id, path: inputLabel(i) }],
          input: { request: q.id, location: i.location, name: i.name, ...(i.path === undefined ? {} : { path: i.path }) },
          output: { class: i.class, hints: i.hints, covaries: i.covaries },
        });
      }
    }
  }
  const out: DepsFinding[] = [];
  for (const { source: s, consumers } of flows.values()) {
    const first = consumers[0];
    if (first === undefined) continue;
    const exact = consumers.every((c) => reread(fresh, c.value, s));
    const decode = (s.decode ?? []).length > 0 ? ` [${(s.decode ?? []).join(",")}]` : "";
    const from = s.kind === "set-cookie" ? `${s.request ?? ""} set-cookie ${s.cookie ?? ""}` : s.kind === "response" ? `${s.request ?? ""} response ${s.path ?? "(text)"}${decode}` : `action @${s.action ?? ""}`;
    const ids = consumers.map((c) => c.request);
    const shown = ids.slice(0, 10).join(", ") + (ids.length > 10 ? `, … (${ids.length})` : "");
    const evidence: Record<string, unknown>[] = [s.kind === "action" ? { action: s.action } : { request: s.request, path: s.kind === "set-cookie" ? `set-cookie:${s.cookie ?? ""}` : (s.path ?? "") }];
    for (const c of consumers.slice(0, 10)) evidence.push({ request: c.request, path: c.label });
    out.push({
      actor: "ai",
      tool: "deps",
      grade: exact ? "实测" : "推断",
      claim: `${first.location} ${first.name} of ${shown} comes from ${from}`,
      evidence,
      input: { location: first.location, name: first.name, requests: ids },
      output: { source: s },
    });
  }
  return [...out, ...unresolved].slice(0, MAX_FINDINGS);
}
