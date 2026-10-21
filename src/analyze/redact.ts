// 0.7.3: offline analysis prints recorded values (docs/04 §8.3 only covered
// live daemon output before this). The same name rules as `bundle redact`
// (default@2) decide what is sensitive: cookies, authorization / set-cookie /
// other sensitive headers, and query / JSON / form names matching
// isSensitiveName. Classification itself keeps reading the original values;
// only the rendered answer changes, so `analyze diff` keeps its
// constant / session / varying table.
//
// Placeholder: <redacted:<first 8 hex of sha256(value)>>. It is derived from
// the value only, so one value maps to one placeholder across bundles, JSON
// and text, keeping comparisons readable. An existing <redacted:…>,
// <secret:…>, «r:…» or <masked> placeholder is left alone.
//
// Scope: analyze diff / deps / chain / recon, JSON and --text; --reveal turns
// it off. analyze shape emits no values except enum literals of non-sensitive
// field names (shape.ts), and analyze find searches a text the caller supplied,
// so neither is touched here.

import { isSensitiveHeaderName, isSensitiveName } from "../bundle/redact.ts";
import { sha256Hex } from "../shared/ids.ts";
import type { DiffResult } from "./diff.ts";
import type { DepsResult } from "./deps.ts";
import type { ChainResult } from "./chain.ts";
import type { Dossier } from "./recon.ts";
import type { ParamLocation } from "./diff.ts";
import type { InputLocation } from "./deps.ts";

const ALREADY_MASKED = /^(?:<redacted:[^>]*>|<secret:[^>]*>|«r:[^»]*»|<masked>)$/;

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

/** One value → one placeholder for the whole command answer. */
export class AnalyzeRedactor {
  private readonly seen = new Map<string, string>();

  mask(value: string): string {
    if (value === "" || ALREADY_MASKED.test(value) || value.startsWith("<redacted:")) return value;
    const have = this.seen.get(value);
    if (have !== undefined) return have;
    const p = `<redacted:${sha256Hex(value).slice(0, 8)}>`;
    this.seen.set(value, p);
    return p;
  }

  header(name: string, value: string): string {
    return isSensitiveHeaderName(name) ? this.mask(value) : value;
  }

  /** A diff parameter value: cookies always; header names by the header rule; the rest by name. */
  param(location: ParamLocation | InputLocation, name: string, value: string): string {
    if (location === "cookie") return this.mask(value);
    if (location === "header") return this.header(name, value);
    return isSensitiveName(name) ? this.mask(value) : value;
  }

  /** A URL: only query parameters with a sensitive name change; path and fragment stay. */
  url(u: string): string {
    const q = u.indexOf("?");
    if (q < 0) return u;
    const hash = u.indexOf("#", q);
    const query = hash < 0 ? u.slice(q + 1) : u.slice(q + 1, hash);
    const out = query
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq <= 0) return pair;
        const name = decode(pair.slice(0, eq));
        if (!isSensitiveName(name)) return pair;
        return `${pair.slice(0, eq)}=${this.mask(decode(pair.slice(eq + 1)))}`;
      })
      .join("&");
    return `${u.slice(0, q + 1)}${out}${hash < 0 ? "" : u.slice(hash)}`;
  }
}

/** `analyze diff` answer: values and any URL-shaped group key; classes and counts unchanged. */
export function redactDiff(r: DiffResult, reveal = false): DiffResult {
  if (reveal) return r;
  const red = new AnalyzeRedactor();
  return {
    ...r,
    groups: r.groups.map((g) => ({
      ...g,
      key: red.url(g.key),
      template: red.url(g.template),
      params: g.params.map((p) => ({ ...p, values: p.values.map((v) => red.param(p.location, p.name, v)) })),
    })),
    singleSampleGroups: r.singleSampleGroups.map((x) => red.url(x)),
  };
}

/** `analyze deps`: request URLs only (inputs are names / paths, never values). */
export function redactDeps(r: DepsResult, reveal = false): DepsResult {
  if (reveal) return r;
  const red = new AnalyzeRedactor();
  return { ...r, requests: r.requests.map((q) => ({ ...q, url: red.url(q.url) })) };
}

/** `analyze chain`: step URLs only (provides / needs are names and paths). */
export function redactChain(r: ChainResult, reveal = false): ChainResult {
  if (reveal) return r;
  const red = new AnalyzeRedactor();
  return { ...r, steps: r.steps.map((s) => ({ ...s, url: red.url(s.url) })) };
}

/** `recon` / `analyze recon`: page URL, stack header values and guard URLs. Cookie values are never in the dossier. */
export function redactDossier(d: Dossier, reveal = false): Dossier {
  if (reveal) return d;
  const red = new AnalyzeRedactor();
  return {
    ...d,
    page: { ...d.page, url: d.page.url === null ? null : red.url(d.page.url) },
    stack: d.stack.map((s) => (s.source === "header" ? { ...s, value: red.header(s.marker, s.value) } : s)),
    protection: d.protection.map((p) => (p.source === "guard" && p.url !== null ? { ...p, url: red.url(p.url) } : p)),
  };
}
