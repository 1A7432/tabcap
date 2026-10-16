// `tabcap replay session [<bundle>] [--site <name>] -o storage-state.json`:
// cookies (and localStorage) of a recording in Playwright's storageState shape,
// so a generated client or a Playwright context can reuse the session
// (docs/03 §4 会话会过期: the file is a snapshot, it expires like the session).
// Sources, in order: the latest `state` event(s) of the bundle (docs/04 §4.1:
// cookies = CDP Network.getCookies array, storage = [[key, value], …]); else,
// with --site, the store's `sessions` row (docs/04 §8.1), which the daemon
// writes when a site-bound session stops or `handoff continue` runs. With
// --site and no bundle, only the store is read.
// Shape oracle: Playwright `BrowserContext.storageState()` —
// {cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite}],
//  origins: [{origin, localStorage: [{name, value}]}]}; expires -1 = session cookie.
// The output holds live credentials: written 0600, values never printed.

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BundleReader } from "../bundle/reader.ts";
import { writeFileAtomic } from "../bundle/manifest.ts";
import type { RawEvent } from "../bundle/types.ts";
import { TabcapError } from "../shared/envelope.ts";
import { isBlobRef } from "../shared/ids.ts";
import { isRecord, tryParseJson } from "../shared/json.ts";
import { Store } from "../daemon/store/db.ts";
import { utf8 } from "../analyze/decoders.ts";

export type SameSite = "Strict" | "Lax" | "None";

export type StorageCookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: SameSite };

const SAME_SITE: Record<string, SameSite> = { strict: "Strict", lax: "Lax", none: "None" };

export type StorageState = { cookies: StorageCookie[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] };

export type SessionSource = { kind: "bundle"; seqs: number[] } | { kind: "store"; site: string; account: string; savedAt: number | null };

/**
 * One CDP / Playwright-like cookie → storageState cookie, or a reason it is unusable.
 * A missing sameSite becomes "Lax", as Playwright's Chromium backend reports it.
 */
export function toStorageCookie(v: unknown): StorageCookie | string {
  if (!isRecord(v)) return "not an object";
  const { name, value, domain } = v;
  if (typeof name !== "string" || name === "") return "name is not a non-empty string";
  if (typeof value !== "string") return "value is not a string";
  if (typeof domain !== "string" || domain === "") return "domain is not a non-empty string";
  const path = typeof v["path"] === "string" && v["path"].startsWith("/") ? v["path"] : "/";
  const session = v["session"] === true;
  const exp = v["expires"];
  const expires = !session && typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp : -1;
  const ss = v["sameSite"];
  const sameSite: SameSite = (typeof ss === "string" ? SAME_SITE[ss.toLowerCase()] : undefined) ?? "Lax";
  return { name, value, domain, path, expires, httpOnly: v["httpOnly"] === true, secure: v["secure"] === true, sameSite };
}

function stateEvents(reader: BundleReader, what: string): RawEvent[] {
  return reader.events.filter((e) => e.kind === "state" && e["what"] === what && isBlobRef(e["blob"]));
}

function blobJson(reader: BundleReader, ref: unknown): unknown {
  if (typeof ref !== "string") return undefined;
  const bytes = reader.readBlob(ref);
  if (bytes === null) return undefined;
  const text = utf8(bytes);
  return text === null ? undefined : tryParseJson(text);
}

/**
 * Cookies of the latest `state` cookies event per origin (an event without an
 * origin counts as one origin), later snapshots winning on name + domain + path;
 * localStorage of the latest event per origin.
 */
export function stateFromBundle(reader: BundleReader, warn: (w: string) => void): { state: StorageState; seqs: number[] } | null {
  const cookieEvents = stateEvents(reader, "cookies");
  if (cookieEvents.length === 0) return null;
  const latest = new Map<string, RawEvent>();
  for (const e of cookieEvents) latest.set(typeof e["origin"] === "string" ? e["origin"] : "", e);
  const chosen = [...latest.values()].sort((a, b) => a.seq - b.seq);
  const jar = new Map<string, StorageCookie>();
  for (const e of chosen) {
    const arr = blobJson(reader, e["blob"]);
    if (!Array.isArray(arr)) {
      warn(`state seq ${e.seq}: cookie snapshot is missing or not a JSON array`);
      continue;
    }
    arr.forEach((c, i) => {
      const sc = toStorageCookie(c);
      if (typeof sc === "string") warn(`state seq ${e.seq} cookie #${i}: ${sc}`);
      else jar.set(`${sc.name}\t${sc.domain}\t${sc.path}`, sc);
    });
  }
  const origins: StorageState["origins"] = [];
  const lsLatest = new Map<string, RawEvent>();
  for (const e of stateEvents(reader, "localStorage")) if (typeof e["origin"] === "string") lsLatest.set(e["origin"], e);
  for (const [origin, e] of [...lsLatest.entries()].sort((a, b) => a[1].seq - b[1].seq)) {
    const arr = blobJson(reader, e["blob"]);
    if (!Array.isArray(arr)) {
      warn(`state seq ${e.seq}: localStorage snapshot is missing or not a JSON array`);
      continue;
    }
    const items = arr.flatMap((p) => (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" ? [{ name: p[0], value: p[1] }] : []));
    origins.push({ origin, localStorage: items });
  }
  return { state: { cookies: [...jar.values()], origins }, seqs: [...chosen.map((e) => e.seq), ...[...lsLatest.values()].map((e) => e.seq)].sort((a, b) => a - b) };
}

export function stateFromStore(configDir: string, site: string, warn: (w: string) => void): { state: StorageState; account: string; savedAt: number | null } | null {
  const store = Store.open(configDir);
  try {
    if (store.site(site) === null) throw new TabcapError("not-found", `no site "${site}" in the store`, "Run `tabcap site list` to see the stored sites.");
    const saved = store.savedSession(site);
    if (saved === null) return null;
    if (!Array.isArray(saved.cookies)) {
      warn(`store session of ${site}: cookies are not a JSON array`);
      return { state: { cookies: [], origins: [] }, account: saved.username, savedAt: saved.savedAt };
    }
    const cookies: StorageCookie[] = [];
    saved.cookies.forEach((c, i) => {
      const sc = toStorageCookie(c);
      if (typeof sc === "string") warn(`store session of ${site} cookie #${i}: ${sc}`);
      else cookies.push(sc);
    });
    return { state: { cookies, origins: [] }, account: saved.username, savedAt: saved.savedAt };
  } finally {
    store.close();
  }
}

export type SessionExport = {
  out: string;
  source: SessionSource;
  cookies: number;
  domains: string[];
  origins: number;
  mode: "0600";
  sensitive: true;
  warnings: string[];
};

/** Write the storageState file (0600). Never returns cookie values. */
export function exportSession(opts: { bundle: string | null; out: string; site?: string | undefined; configDir: string }): SessionExport {
  const reader = opts.bundle === null ? null : BundleReader.open(opts.bundle);
  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);
  let state: StorageState;
  let source: SessionSource;
  if (reader === null && opts.site === undefined) throw new TabcapError("usage", "give a bundle, or --site <name> for the store's saved session", "tabcap replay session [<bundle>] [--site <name>] -o <file>");
  const fromBundle = reader === null ? null : stateFromBundle(reader, warn);
  if (fromBundle !== null) {
    state = fromBundle.state;
    source = { kind: "bundle", seqs: fromBundle.seqs };
    if (opts.site !== undefined) warn(`--site ${opts.site} ignored: the bundle has its own state snapshot`);
  } else if (opts.site !== undefined) {
    const s = stateFromStore(opts.configDir, opts.site, warn);
    if (s === null)
      throw new TabcapError(
        "not-found",
        reader === null ? `the store has no saved session for ${opts.site}` : `the bundle has no cookie snapshot (state event) and the store has no saved session for ${opts.site}`,
        `A session bound to the site saves its cookies when it stops: \`tabcap session start <name> --site ${opts.site}\`, log in, then \`tabcap session stop <name>\` (or \`tabcap handoff continue\`).`,
      );
    state = s.state;
    source = { kind: "store", site: opts.site, account: s.account, savedAt: s.savedAt };
  } else {
    throw new TabcapError("not-found", "the bundle has no cookie snapshot (no `state` event with what=cookies)", "Pass --site <name> to use the store's saved session for that site, or record again with state snapshots.");
  }
  mkdirSync(dirname(opts.out), { recursive: true, mode: 0o700 });
  writeFileAtomic(opts.out, JSON.stringify(state, null, 2) + "\n", 0o600);
  chmodSync(opts.out, 0o600);
  if (reader !== null && !reader.isComplete()) warn("bundle is not finished: the snapshot may not be the last one");
  warn("this file holds live session cookies: keep it out of the repository and do not share it; it expires with the session (docs/03 §4)");
  return {
    out: opts.out,
    source,
    cookies: state.cookies.length,
    domains: [...new Set(state.cookies.map((c) => c.domain))].sort(),
    origins: state.origins.length,
    mode: "0600",
    sensitive: true,
    warnings,
  };
}
