// The `detect` hook, manifest half (docs/09 §9): the page side only collects a
// DOM digest (tag, id, class, the attributes manifests ask about, nearest
// collected ancestor) in the isolated world; matching runs here as pure
// functions, so the same code is unit-tested on recorded digests
// (fixtures/dom/) and run on live pages. Globals are probed with `name in
// globalThis` in the main world (no getter runs); headers are matched only
// when the caller has the main document's response headers.

import { isRecord } from "../../shared/json.ts";
import type { Adapter, ElementSpec, Feature } from "./manifest.ts";

export type DigestEl = { t: string; id: string; c: string; a: Record<string, string>; p: number };
export type Digest = { els: DigestEl[]; total: number; truncated: boolean };

export const DIGEST_MAX = 5000;

/** Page function (isolated world): (attrs, tags, max) → Digest. Read-only. */
export const DIGEST_FN = `function (attrs, tags, max) {
  const els = []; const pos = new Map(); let total = 0; let truncated = false;
  for (const el of document.querySelectorAll("*")) {
    total++;
    if (els.length >= max) { truncated = true; continue; }
    const t = el.localName;
    const c = (el.getAttribute("class") || "").slice(0, 400);
    const id = (el.getAttribute("id") || "").slice(0, 128);
    const a = {}; let has = false;
    for (const n of attrs) { const v = el.getAttribute(n); if (v !== null) { a[n] = v.slice(0, 256); has = true; } }
    if (!c && !id && !has && !tags.includes(t)) continue;
    let p = -1;
    for (let up = el.parentElement; up; up = up.parentElement) { const k = pos.get(up); if (k !== undefined) { p = k; break; } }
    pos.set(el, els.length);
    els.push({ t, id, c, a, p });
  }
  return { els, total, truncated };
}`;

/** Attribute names and tags the digest must keep for these adapters. */
export function digestNeeds(adapters: readonly Adapter[]): { attrs: string[]; tags: string[] } {
  const attrs = new Set<string>();
  const tags = new Set<string>();
  const spec = (s: ElementSpec | undefined) => {
    if (s === undefined) return;
    if (s.attr !== undefined) attrs.add(s.attr.name);
    if (s.tag !== undefined) tags.add(s.tag);
  };
  for (const a of adapters) {
    for (const f of a.detect) {
      if (f.kind === "dom") {
        spec(f.match);
        spec(f.has);
      }
    }
  }
  return { attrs: [...attrs].sort(), tags: [...tags].sort() };
}

/** Global names the adapters probe. */
export function globalNames(adapters: readonly Adapter[]): string[] {
  const out = new Set<string>();
  for (const a of adapters) for (const f of a.detect) if (f.kind === "global") out.add(f.name);
  return [...out].sort();
}

/** Expression for the main world: one boolean per name (`in` runs no page getter). Names are validated identifiers. */
export function globalsExpression(names: readonly string[]): string {
  return `[${names.map((n) => `${JSON.stringify(n)} in globalThis`).join(", ")}]`;
}

/** Digest from the page (untrusted): malformed rows are dropped, never trusted. */
export function parseDigest(v: unknown): Digest {
  const o = isRecord(v) ? v : {};
  const raw = Array.isArray(o["els"]) ? o["els"] : [];
  const els: DigestEl[] = [];
  for (const r of raw.slice(0, DIGEST_MAX)) {
    if (!isRecord(r)) continue;
    const a: Record<string, string> = {};
    if (isRecord(r["a"])) for (const [k, val] of Object.entries(r["a"])) if (typeof val === "string") a[k] = val;
    const p = typeof r["p"] === "number" && Number.isSafeInteger(r["p"]) && r["p"] >= -1 && r["p"] < els.length ? r["p"] : -1;
    els.push({ t: typeof r["t"] === "string" ? r["t"] : "", id: typeof r["id"] === "string" ? r["id"] : "", c: typeof r["c"] === "string" ? r["c"] : "", a, p });
  }
  return { els, total: typeof o["total"] === "number" ? o["total"] : els.length, truncated: o["truncated"] === true };
}

const classes = (e: DigestEl): string[] => e.c.split(/\s+/).filter((x) => x !== "");

export function matchesSpec(e: DigestEl, s: ElementSpec): boolean {
  if (s.tag !== undefined && e.t !== s.tag) return false;
  if (s.id !== undefined && e.id !== s.id) return false;
  if (s.classPrefix !== undefined) {
    const p = s.classPrefix;
    if (!classes(e).some((c) => c.startsWith(p))) return false;
  }
  if (s.attr !== undefined) {
    const v = e.a[s.attr.name];
    if (v === undefined) return false;
    if (s.attr.value !== undefined && v !== s.attr.value) return false;
  }
  return true;
}

/** Inputs of one detection run. `globals`/`headers` null: not probed (features of that kind are reported unchecked). */
export type DetectInput = { digest: Digest; globals: Record<string, boolean> | null; headers: Record<string, string> | null };

/** true / false, or null when the input for this kind of feature was not available. */
export function featureMatches(f: Feature, x: DetectInput): boolean | null {
  switch (f.kind) {
    case "class-prefix":
      return x.digest.els.some((e) => classes(e).some((c) => c.startsWith(f.prefix)));
    case "dom": {
      const els = x.digest.els;
      if (f.has === undefined) {
        const m = f.match;
        return els.some((e) => matchesSpec(e, m));
      }
      const has = f.has;
      for (const d of els) {
        if (!matchesSpec(d, has)) continue;
        for (let p = d.p, hops = 0; p >= 0 && hops < 256; hops++) {
          const anc = els[p];
          if (anc === undefined) break;
          if (matchesSpec(anc, f.match)) return true;
          p = anc.p;
        }
      }
      return false;
    }
    case "global":
      return x.globals === null ? null : x.globals[f.name] === true;
    case "header": {
      if (x.headers === null) return null;
      const v = Object.entries(x.headers).find(([k]) => k.toLowerCase() === f.name)?.[1];
      if (v === undefined) return false;
      return f.pattern === undefined ? true : new RegExp(f.pattern, "i").test(v);
    }
  }
}

export type Detection = { adapter: string; category: string; confidence: number; evidence: string[]; unchecked: string[] };

/** Noisy-OR of the matched features' confidences, two decimals. */
export function combine(confidences: readonly number[]): number {
  const miss = confidences.reduce((m, c) => m * (1 - c), 1);
  return Math.round((1 - miss) * 100) / 100;
}

export function detectAdapter(a: Adapter, x: DetectInput, extra: ReadonlyArray<{ label: string; confidence: number }> = []): Detection {
  const evidence: string[] = [];
  const unchecked: string[] = [];
  const cs: number[] = [];
  for (const f of a.detect) {
    const m = featureMatches(f, x);
    if (m === null) unchecked.push(f.label);
    else if (m) {
      evidence.push(f.label);
      cs.push(f.confidence);
    }
  }
  for (const e of extra) {
    evidence.push(e.label);
    cs.push(e.confidence);
  }
  return { adapter: a.name, category: a.category, confidence: combine(cs), evidence, unchecked };
}
