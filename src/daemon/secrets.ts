// Known-secret output replacement (docs/04 §8.1). Two sources:
//   - the store (`store/db.ts`): every password / TOTP seed is replaced with
//     `<secret:<site>.<field>>` in every envelope, daemon log line and `cmd` event;
//   - values typed into password-like fields with plain `fill` / `type` during
//     this daemon's lifetime: replaced with `<masked>`.
// Replacement is one left-to-right pass over a single alternation, so a
// placeholder already in the text is never rewritten (a password "demo" must
// not mangle `<secret:range-demo.password>`), and scrubbing twice is a no-op.
// Each value is matched raw, JSON-escaped, URI-encoded and form-encoded.

import type { KnownSecret } from "./store/db.ts";

export const MASK = "<masked>";
const MIN_LEN = 3;
const PLACEHOLDER = String.raw`<secret:[A-Za-z0-9_.-]+>|<masked>`;

export function secretPlaceholder(ref: string): string {
  return `<secret:${ref}>`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The spellings a value can take in JSON, URLs and form bodies. */
export function variantsOf(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(JSON.stringify(value).slice(1, -1));
  try {
    const uri = encodeURIComponent(value);
    out.add(uri);
    out.add(uri.replace(/%20/g, "+"));
    // URLSearchParams / application/x-www-form-urlencoded spelling
    out.add(new URLSearchParams({ v: value }).toString().slice(2));
  } catch {
    // lone surrogates: the raw and JSON forms still apply
  }
  return [...out].filter((v) => v.length >= MIN_LEN);
}

export class Secrets {
  private adhoc = new Set<string>();
  private stored: KnownSecret[] = [];
  private re: RegExp | null = null;
  private byVariant = new Map<string, string>();

  add(value: string): void {
    if (value.length < MIN_LEN || this.adhoc.has(value)) return;
    this.adhoc.add(value);
    this.re = null;
  }

  /** Replace the store-backed set (called whenever the store may have changed). */
  setStored(list: readonly KnownSecret[]): void {
    const same = list.length === this.stored.length && list.every((s, i) => s.ref === this.stored[i]?.ref && s.value === this.stored[i]?.value);
    if (same) return;
    this.stored = list.filter((s) => s.value.length >= MIN_LEN).map((s) => ({ ...s }));
    this.re = null;
  }

  get size(): number {
    return this.adhoc.size + this.stored.length;
  }

  private build(): RegExp | null {
    this.byVariant = new Map();
    // Store refs win over ad-hoc masks for the same value.
    for (const s of this.stored) for (const v of variantsOf(s.value)) if (!this.byVariant.has(v)) this.byVariant.set(v, secretPlaceholder(s.ref));
    for (const a of this.adhoc) for (const v of variantsOf(a)) if (!this.byVariant.has(v)) this.byVariant.set(v, MASK);
    if (this.byVariant.size === 0) return null;
    const alts = [...this.byVariant.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    return new RegExp(`${PLACEHOLDER}|${alts.join("|")}`, "g");
  }

  /** Replace every known value in `text`; existing placeholders stay as they are. */
  scrub(text: string): string {
    if (this.size === 0) return text;
    if (this.re === null) this.re = this.build();
    const re = this.re;
    if (re === null) return text;
    re.lastIndex = 0;
    return text.replace(re, (m) => this.byVariant.get(m) ?? m);
  }
}

/** Deep copy of a JSON-like value with every string (and object key) scrubbed. */
export function scrubValue(s: Secrets, v: unknown): unknown {
  if (typeof v === "string") return s.scrub(v);
  if (Array.isArray(v)) return v.map((x) => scrubValue(s, x));
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [s.scrub(k), scrubValue(s, x)]));
  return v;
}

/** Fields whose value must never be logged (docs/04 §4.1 action.value rule). */
export function isSensitiveField(type: string | null, autocomplete: string | null): boolean {
  if (type !== null && type.toLowerCase() === "password") return true;
  const ac = (autocomplete ?? "").toLowerCase();
  return /\bcc-|one-time-code/.test(ac);
}
