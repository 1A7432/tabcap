// Protection family identification (docs/04 §41.2): evidence in, detections
// out, pure. Evidence comes from a bundle (recon) or from a live tab (the probe
// after a navigation); any part may be missing and the rules of that kind are
// then simply not evaluated. Output carries pointers only — request ids, cookie
// and header NAMES, URLs without their query, global paths, API names — never a
// cookie value, header value or body (values are read to check a shape, nothing
// more).

import { matchesSpec, type Digest } from "../../daemon/adapters/detect.ts";
import type { ElementSpec } from "../../daemon/adapters/manifest.ts";
import { layerOf, type Category, type Family, type Layer, type Rule, type RuleKind, type When, type WhenItem } from "./rules.ts";

export type GlobalKind = "function" | "object" | "string" | "number" | "boolean" | "accessor" | "undefined";

export type EvidenceRequest = {
  id: string;
  url: string;
  method: string;
  type: string | null;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Response text of a document / HTML response, capped (challenge rules); null otherwise. */
  body: string | null;
  postData: string | null;
};

export type Evidence = {
  cookies?: { name: string; value: string | null; request: string | null }[] | null;
  requests?: EvidenceRequest[] | null;
  /** URLs the page loaded, without request ids (the live probe: resource timing, script src). */
  resources?: string[] | null;
  globals?: Record<string, GlobalKind> | null;
  dom?: Digest | null;
  frames?: string[] | null;
  api?: { target: string; caller: string | null; count: number }[] | null;
};

export type Match = { rule: string; layer: Layer; kind: RuleKind; where: string[] };

export type Detection = {
  family: string;
  name: string;
  vendor: string;
  category: Category;
  confidence: number;
  layers: Layer[];
  matched: Match[];
  /** The combination that set the score, when one did. */
  combination: string | null;
  grade: "推断";
};

export type Fingerprinting = { technique: string; family: string; apis: string[]; callers: { url: string; count: number }[]; attributedTo: string | null };

export type Identification = { detections: Detection[]; fingerprinting: Fingerprinting[] };

/** Detections below this are not reported (docs/04 §41.2). */
export const MIN_REPORT = 30;
/** At most this many pointers per matched rule. */
const MAX_WHERE = 5;

/** scheme://host/path, no query or fragment: a URL as a pointer, without what it may carry. */
export function urlPointer(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}`;
  } catch {
    return u.replace(/[?#].*$/, "").slice(0, 300);
  }
}

const lowerKeys = (h: Record<string, string>): Map<string, string> => new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

function domMatches(digest: Digest, match: ElementSpec, has: ElementSpec | null): boolean {
  const els = digest.els;
  if (has === null) return els.some((e) => matchesSpec(e, match));
  for (const d of els) {
    if (!matchesSpec(d, has)) continue;
    for (let p = d.p, hops = 0; p >= 0 && hops < 256; hops++) {
      const anc = els[p];
      if (anc === undefined) break;
      if (matchesSpec(anc, match)) return true;
      p = anc.p;
    }
  }
  return false;
}

const isHtml = (r: EvidenceRequest): boolean => r.type === "document" || /text\/html|application\/xhtml/i.test(lowerKeys(r.responseHeaders).get("content-type") ?? "");

/** Where one rule matched; empty when it did not (or its evidence is missing). */
export function ruleMatches(rule: Rule, x: Evidence): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (out.length < MAX_WHERE && !out.includes(s)) out.push(s);
  };
  switch (rule.kind) {
    case "cookie":
      for (const c of x.cookies ?? []) {
        if (!rule.nameRe.test(c.name)) continue;
        if (rule.valueShape !== null && (c.value === null || !rule.valueShape.test(c.value))) continue;
        push(c.request === null ? `cookie ${c.name}` : `cookie ${c.name} (${c.request})`);
      }
      break;
    case "request":
      for (const r of x.requests ?? []) {
        if (rule.method !== null && r.method.toUpperCase() !== rule.method) continue;
        if (rule.type !== null && r.type !== rule.type) continue;
        if (rule.url.test(r.url)) push(`${r.id} ${urlPointer(r.url)}`);
      }
      if (rule.method === null) for (const u of x.resources ?? []) if (rule.url.test(u)) push(urlPointer(u));
      break;
    case "responseHeader":
      for (const r of x.requests ?? []) {
        const v = lowerKeys(r.responseHeaders).get(rule.name);
        if (v !== undefined && (rule.value === null || rule.value.test(v))) push(`${r.id} header ${rule.name}`);
      }
      break;
    case "requestHeader":
      for (const r of x.requests ?? []) if (lowerKeys(r.requestHeaders).has(rule.name)) push(`${r.id} header ${rule.name}`);
      break;
    case "challenge":
      for (const r of x.requests ?? []) {
        if (!isHtml(r)) continue;
        if (rule.status !== null && (r.status === null || !rule.status.includes(r.status))) continue;
        if (rule.text !== null && (r.body === null || !rule.text.test(r.body))) continue;
        push(`${r.id} ${r.status ?? "?"} ${urlPointer(r.url)}`);
      }
      break;
    case "requestBody":
      for (const r of x.requests ?? []) {
        if (r.postData === null || (rule.url !== null && !rule.url.test(r.url))) continue;
        if (rule.text.test(r.postData)) push(`${r.id} body ${urlPointer(r.url)}`);
      }
      break;
    case "global": {
      const path = rule.path.join(".");
      const k = x.globals?.[path];
      if (k === undefined || k === "undefined") break;
      if (rule.condition === "exists" || k === rule.condition) push(`global ${path}`);
      break;
    }
    case "dom":
      if (x.dom != null && domMatches(x.dom, rule.match, rule.has)) push(`dom ${JSON.stringify(rule.match)}`);
      break;
    case "frame":
      for (const f of x.frames ?? []) if (rule.url.test(f)) push(`frame ${urlPointer(f)}`);
      break;
    case "api":
      for (const a of x.api ?? []) {
        if (a.target !== rule.target) continue;
        if (rule.caller !== null && (a.caller === null || !rule.caller.test(a.caller))) continue;
        push(a.caller === null ? `api ${a.target}` : `api ${a.target} by ${urlPointer(a.caller)}`);
      }
      break;
  }
  return out;
}

function holds(w: When, hit: ReadonlySet<string>): boolean {
  const ok = (it: WhenItem): boolean => ("rule" in it ? hit.has(it.rule) : holds(it, hit));
  return "all" in w ? w.all.every(ok) : w.any.some(ok);
}

export function identifyFamily(f: Family, x: Evidence): Detection | null {
  const matched: Match[] = [];
  const hit = new Set<string>();
  let score = 0;
  for (const r of f.rules) {
    const where = ruleMatches(r, x);
    if (where.length === 0) continue;
    hit.add(r.id);
    matched.push({ rule: r.id, layer: layerOf(r.kind), kind: r.kind, where });
    if (r.standalone) score = Math.max(score, r.confidence);
  }
  if (matched.length === 0) return null;
  let combination: string | null = null;
  for (const c of f.combinations) {
    if (c.confidence > score && holds(c.when, hit)) {
      score = c.confidence;
      combination = c.id;
    }
  }
  if (score < MIN_REPORT) return null;
  const layers = [...new Set(matched.map((m) => m.layer))].sort();
  return { family: f.id, name: f.name, vendor: f.vendor, category: f.category, confidence: score, layers, matched, combination, grade: "推断" };
}

/** Run every family; detections by confidence, then name. Fingerprinting techniques are also summarised with their callers. */
export function identify(families: readonly Family[], x: Evidence): Identification {
  const detections: Detection[] = [];
  for (const f of families) {
    const d = identifyFamily(f, x);
    if (d !== null) detections.push(d);
  }
  detections.sort((a, b) => b.confidence - a.confidence || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const vendors = families.filter((f) => f.category !== "fingerprint");
  const attribute = (url: string): string | null => {
    for (const f of vendors) for (const r of f.rules) if (r.kind === "request" && r.url.test(url)) return f.id;
    return null;
  };
  const fingerprinting: Fingerprinting[] = [];
  for (const d of detections) {
    if (d.category !== "fingerprint") continue;
    const fam = families.find((f) => f.id === d.family);
    const targets = new Set((fam?.rules ?? []).filter((r) => r.kind === "api" && d.matched.some((m) => m.rule === r.id)).map((r) => (r.kind === "api" ? r.target : "")));
    const callers = new Map<string, number>();
    for (const a of x.api ?? []) if (targets.has(a.target) && a.caller !== null) callers.set(urlPointer(a.caller), (callers.get(urlPointer(a.caller)) ?? 0) + a.count);
    const list = [...callers].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count);
    const attributedTo = list.map((c) => attribute(c.url)).find((v) => v !== null) ?? null;
    fingerprinting.push({ technique: d.name, family: d.family, apis: [...targets].sort(), callers: list.slice(0, 10), attributedTo });
  }
  return { detections, fingerprinting };
}
