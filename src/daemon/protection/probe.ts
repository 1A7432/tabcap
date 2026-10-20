// Live protection probe, page side (docs/04 §41.3): what one navigation of a
// tab can tell the identifier without a recording. Read-only and once per
// navigation: no Network.enable, no page script left behind.
// - globals (main world): each path a family's `global` rule names is walked
//   through property DESCRIPTORS (Object.getOwnPropertyDescriptor up the
//   prototype chain), so no page getter ever runs; an accessor is reported as
//   "accessor" and not descended into.
// - resources and frames (isolated world): resource-timing entry names plus
//   script / iframe src, capped.
// Everything the page returns is untrusted: parse* drop what does not fit.

import { isRecord } from "../../shared/json.ts";
import type { Family } from "../../analyze/protection/rules.ts";
import type { GlobalKind } from "../../analyze/protection/identify.ts";

export const MAX_RESOURCES = 500;
export const MAX_FRAMES = 50;
const MAX_URL = 2048;
const KINDS: ReadonlySet<string> = new Set(["function", "object", "string", "number", "boolean", "accessor", "undefined"]);
const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5}$/;

/** The global paths the families' rules ask about (validated paths only), sorted. */
export function globalPaths(families: readonly Family[]): string[] {
  const out = new Set<string>();
  for (const f of families) for (const r of f.rules) if (r.kind === "global") out.add(r.path.join("."));
  return [...out].filter((p) => PATH.test(p)).sort();
}

/** Main-world function: (paths) → {path: kind}. Descriptors only; never calls a getter. */
export const GLOBALS_FN = `function (paths) {
  const out = {};
  const find = (o, k) => {
    for (let p = o, i = 0; p !== null && p !== undefined && i < 16; p = Object.getPrototypeOf(p), i++) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d !== undefined) return d;
    }
    return undefined;
  };
  for (const path of paths) {
    let cur = globalThis, kind = "undefined";
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      const d = find(cur, parts[i]);
      if (d === undefined) { kind = "undefined"; break; }
      if (!("value" in d)) { kind = "accessor"; break; }
      const v = d.value;
      if (i === parts.length - 1) { kind = v === null ? "object" : typeof v; break; }
      if (v === null || (typeof v !== "object" && typeof v !== "function")) { kind = "undefined"; break; }
      cur = v;
    }
    out[path] = kind;
  }
  return out;
}`;

/** Isolated-world function: () → {resources, frames}. */
export const RESOURCES_FN = `function (maxRes, maxFrames) {
  const res = new Set();
  try { for (const e of performance.getEntriesByType("resource")) { if (res.size >= maxRes) break; res.add(e.name); } } catch (e) {}
  for (const s of document.scripts) { if (res.size >= maxRes) break; if (s.src) res.add(s.src); }
  const frames = [];
  for (const f of document.querySelectorAll("iframe[src]")) { if (frames.length >= maxFrames) break; frames.push(f.src); }
  return { resources: [...res], frames };
}`;

/** Untrusted page answer → {path: kind}, only the asked paths and known kinds. */
export function parseGlobals(v: unknown, asked: readonly string[]): Record<string, GlobalKind> {
  const out: Record<string, GlobalKind> = {};
  if (!isRecord(v)) return out;
  for (const p of asked) {
    const k = v[p];
    if (typeof k === "string" && KINDS.has(k)) out[p] = k as GlobalKind;
  }
  return out;
}

/** Untrusted page answer → resource and frame URLs (strings, capped). */
export function parseResources(v: unknown): { resources: string[]; frames: string[] } {
  const o = isRecord(v) ? v : {};
  const urls = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.filter((u): u is string => typeof u === "string" && u.length <= MAX_URL && /^https?:\/\//i.test(u)).slice(0, max) : []);
  return { resources: urls(o["resources"], MAX_RESOURCES), frames: urls(o["frames"], MAX_FRAMES) };
}

/** CDP Network.getCookies answer (untrusted shape) → names with values (values never leave the identifier). */
export function parseCookies(v: unknown): { name: string; value: string | null; request: null }[] {
  const list = isRecord(v) && Array.isArray(v["cookies"]) ? v["cookies"] : [];
  const out: { name: string; value: string | null; request: null }[] = [];
  for (const c of list.slice(0, 1000)) {
    if (!isRecord(c) || typeof c["name"] !== "string" || c["name"] === "") continue;
    out.push({ name: c["name"], value: typeof c["value"] === "string" ? c["value"] : null, request: null });
  }
  return out;
}
