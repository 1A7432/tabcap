// Local site / account store (docs/03 §5 `store`, docs/04 §8.1).
// One bun:sqlite file, $TABCAP_HOME/config/state.db (~/.config/tabcap/state.db),
// mode 0600 in a 0700 directory; opening refuses a file or directory whose mode
// is wider. Plaintext, the same protection level as ~/.netrc: use test accounts.
// Entry is manual only (CLI); nothing here ever captures a password from a page.
// Secret values leave this module only through `secretValue` (daemon-side fill),
// `savedSession` (replay session file, 0600) and `knownSecrets` (output
// replacement); listings never carry them. Saved session cookies are secrets
// too: their values are replaced in every output like passwords.

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../../shared/envelope.ts";

export const STORE_FILE = "state.db";
export const SCHEMA_VERSION = 2;

/** Site names are what secret refs use (`<site>.password`), so they stay ref-safe. */
const SITE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function storePath(configDir: string): string {
  return join(configDir, STORE_FILE);
}

export function checkSiteName(name: string): string {
  if (!SITE_NAME.test(name)) throw new TabcapError("usage", `bad site name: ${JSON.stringify(name)}`, "Site names use letters, digits, '_' or '-' (max 64); no dots, they separate the site from the field in secret refs.");
  return name;
}

// Migrations: index i takes the schema from version i to i + 1.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sites (
     name TEXT PRIMARY KEY,
     entry_url TEXT NOT NULL,
     domains TEXT NOT NULL DEFAULT '[]',
     notes TEXT,
     created INTEGER NOT NULL
   );
   CREATE TABLE accounts (
     site TEXT NOT NULL REFERENCES sites(name) ON DELETE CASCADE,
     username TEXT NOT NULL,
     password TEXT NOT NULL,
     totp_seed TEXT,
     created INTEGER NOT NULL,
     PRIMARY KEY (site, username)
   );
   -- Saved cookies per site account (0.3-C: written at session stop / handoff continue).
   CREATE TABLE sessions (
     site TEXT NOT NULL,
     username TEXT NOT NULL,
     cookies TEXT NOT NULL DEFAULT '[]',
     saved_at INTEGER,
     verified_at INTEGER,
     PRIMARY KEY (site, username)
   );
   -- P2 placeholder: schema only.
   CREATE TABLE login_recipes (
     site TEXT PRIMARY KEY,
     recipe TEXT NOT NULL DEFAULT '{}',
     created INTEGER NOT NULL
   );
   CREATE TABLE guard_counters (
     site TEXT NOT NULL,
     session_name TEXT NOT NULL,
     login_attempts INTEGER NOT NULL DEFAULT 0,
     last_attempt_at INTEGER,
     PRIMARY KEY (site, session_name)
   );
   CREATE TABLE bundles (
     path TEXT PRIMARY KEY,
     site TEXT,
     session_name TEXT,
     created INTEGER NOT NULL,
     finished INTEGER
   );`,
  // 2: live request pacing for `tabcap replay check --live` (per site, per scope).
  `ALTER TABLE guard_counters ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE guard_counters ADD COLUMN last_request_at INTEGER;`,
];

export type SiteRow = { name: string; entryUrl: string; domains: string[]; notes: string | null; created: number };
export type SiteListing = SiteRow & { usernames: string[] };
export type SecretField = "password" | "username" | "totp_seed";
export type KnownSecret = { ref: string; value: string };

/**
 * Saved cookie values shorter than this are not replaced in output: short
 * values ("1", "en", "dark") would mangle ordinary text. Passwords keep the
 * replacement module's own minimum.
 */
export const COOKIE_SECRET_MIN = 8;
const REF_SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
export type GuardCounter = { site: string; sessionName: string; loginAttempts: number; lastAttemptAt: number | null };
export type RequestCounter = { site: string; scope: string; requests: number; lastRequestAt: number | null };
/** A `sessions` row: the cookies saved for a site's account (session stop / handoff continue of a site-bound session). */
export type SavedSession = { site: string; username: string; cookies: unknown; savedAt: number | null; verifiedAt: number | null };
export type BundleRow = { path: string; site: string | null; sessionName: string | null; created: number; finished: number | null };

function tooOpen(path: string, mode: number, want: number): TabcapError {
  return new TabcapError(
    "conflict",
    `${path} has mode ${(mode & 0o777).toString(8).padStart(4, "0")}; the credential store needs ${want.toString(8).padStart(4, "0")} or stricter`,
    `Run \`chmod ${want.toString(8)} ${path}\` (and check nobody else read it), then retry.`,
  );
}

/**
 * Refuse a store (or its directory) that is a symlink, not ours, or readable by
 * others. Windows has no POSIX modes or uids (Node reports 0666 / 0777 there):
 * the store lives under %LOCALAPPDATA%\tabcap and keeps that directory's
 * user-default ACL, so only the plain-file / not-a-link check applies.
 */
function checkPrivate(path: string, want: number, dir: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) throw new TabcapError("conflict", `${path} is not a plain ${dir ? "directory" : "file"}`, `Remove or fix ${path}.`);
  if (process.platform === "win32") return;
  const uid = process.getuid?.() ?? -1;
  if (uid >= 0 && st.uid !== uid) throw new TabcapError("conflict", `${path} is owned by uid ${st.uid}, not this user`, `Remove or fix ${path}.`);
  if ((st.mode & 0o077) !== 0) throw tooOpen(path, st.mode, want);
}

function siteRow(r: Record<string, unknown>): SiteRow {
  let domains: string[] = [];
  try {
    const v: unknown = JSON.parse(String(r["domains"] ?? "[]"));
    if (Array.isArray(v)) domains = v.filter((x): x is string => typeof x === "string");
  } catch {
    domains = [];
  }
  return {
    name: String(r["name"]),
    entryUrl: String(r["entry_url"]),
    domains,
    notes: typeof r["notes"] === "string" ? r["notes"] : null,
    created: Number(r["created"]),
  };
}

export class Store {
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  /**
   * Open (creating if needed) the store under `configDir`. A missing directory
   * is created 0700 and a missing file 0600; an existing one with a wider mode
   * is refused, never silently tightened.
   */
  static open(configDir: string, now: () => number = Date.now): Store {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
    checkPrivate(configDir, 0o700, true);
    const path = storePath(configDir);
    if (!existsSync(path)) {
      // Create the empty file with its final mode before SQLite touches it (umask-proof).
      closeSync(openSync(path, "wx", 0o600));
      chmodSync(path, 0o600);
    }
    checkPrivate(path, 0o600, false);
    for (const side of ["-wal", "-shm", "-journal"]) if (existsSync(path + side)) checkPrivate(path + side, 0o600, false);
    const db = new Database(path, { create: false, strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    const s = new Store(path, db);
    s.migrate(now);
    return s;
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    const r = this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as Record<string, unknown> | null;
    return r === null ? 0 : Number(r["value"]);
  }

  private migrate(now: () => number): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const from = this.schemaVersion;
    if (from > SCHEMA_VERSION) {
      throw new TabcapError("conflict", `${this.path} has schema version ${from}, newer than this tabcap (${SCHEMA_VERSION})`, "Upgrade tabcap; do not edit the store by hand.");
    }
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) throw new TabcapError("internal", `no migration from schema ${v}`, "Report this bug.");
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v + 1));
        if (v === 0) this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('created', ?1)").run(String(now()));
      })();
    }
  }

  // ---- sites / accounts -------------------------------------------------

  /** Add a site with one account. Re-adding an existing site is refused (remove it first). */
  addSite(s: { name: string; entryUrl: string; domains: string[]; notes?: string | null; username: string; password: string; totpSeed?: string | null }, now = Date.now()): void {
    checkSiteName(s.name);
    if (s.username === "") throw new TabcapError("usage", "missing username", "Pass --user <username>.");
    if (s.password === "") throw new TabcapError("usage", "empty password", "Type the password at the prompt, or pipe it with --password-stdin.");
    if (this.site(s.name) !== null) throw new TabcapError("conflict", `site "${s.name}" already exists`, `Run \`tabcap site remove ${s.name}\` first to replace it.`);
    this.db.transaction(() => {
      this.db.query("INSERT INTO sites (name, entry_url, domains, notes, created) VALUES (?1, ?2, ?3, ?4, ?5)").run(s.name, s.entryUrl, JSON.stringify(s.domains), s.notes ?? null, now);
      this.db.query("INSERT INTO accounts (site, username, password, totp_seed, created) VALUES (?1, ?2, ?3, ?4, ?5)").run(s.name, s.username, s.password, s.totpSeed ?? null, now);
    })();
  }

  /** Remove a site, its accounts and guard counters. Returns false when there was none. */
  removeSite(name: string): boolean {
    let changed = 0;
    this.db.transaction(() => {
      this.db.query("DELETE FROM accounts WHERE site = ?1").run(name);
      this.db.query("DELETE FROM guard_counters WHERE site = ?1").run(name);
      this.db.query("DELETE FROM sessions WHERE site = ?1").run(name);
      changed = this.db.query("DELETE FROM sites WHERE name = ?1").run(name).changes;
    })();
    return changed > 0;
  }

  site(name: string): SiteRow | null {
    const r = this.db.query("SELECT name, entry_url, domains, notes, created FROM sites WHERE name = ?1").get(name) as Record<string, unknown> | null;
    return r === null ? null : siteRow(r);
  }

  /** Names, entry URLs, domains and usernames; never passwords or TOTP seeds. */
  listSites(): SiteListing[] {
    const sites = (this.db.query("SELECT name, entry_url, domains, notes, created FROM sites ORDER BY name").all() as Record<string, unknown>[]).map(siteRow);
    const accounts = this.db.query("SELECT site, username FROM accounts ORDER BY site, created, username").all() as Record<string, unknown>[];
    return sites.map((s) => ({ ...s, usernames: accounts.filter((a) => a["site"] === s.name).map((a) => String(a["username"])) }));
  }

  /** The site's account username (the first one when there are several), or null. */
  accountOf(site: string): string | null {
    const r = this.db.query("SELECT username FROM accounts WHERE site = ?1 ORDER BY created, username LIMIT 1").get(site) as Record<string, unknown> | null;
    return r === null ? null : String(r["username"]);
  }

  /** Daemon-only: the plaintext value behind `<site>.<field>`, or null when absent. */
  secretValue(site: string, field: SecretField, username?: string | null): string | null {
    const user = username ?? this.accountOf(site);
    if (user === null) return null;
    const col = field === "password" ? "password" : field === "username" ? "username" : "totp_seed";
    const r = this.db.query(`SELECT ${col} AS v FROM accounts WHERE site = ?1 AND username = ?2`).get(site, user) as Record<string, unknown> | null;
    return r !== null && typeof r["v"] === "string" && r["v"] !== "" ? r["v"] : null;
  }

  /** Every secret value in the store with its reference, for output replacement. Usernames are not secrets. */
  knownSecrets(): KnownSecret[] {
    const rows = this.db.query("SELECT site, password, totp_seed FROM accounts ORDER BY site").all() as Record<string, unknown>[];
    const out: KnownSecret[] = [];
    for (const r of rows) {
      const site = String(r["site"]);
      if (typeof r["password"] === "string" && r["password"] !== "") out.push({ ref: `${site}.password`, value: r["password"] });
      if (typeof r["totp_seed"] === "string" && r["totp_seed"] !== "") out.push({ ref: `${site}.totp_seed`, value: r["totp_seed"] });
    }
    // Saved session cookies: `<secret:site.cookie.name>` (names outside the ref alphabet: `site.cookie`).
    const sessions = this.db.query("SELECT site, cookies FROM sessions ORDER BY site, username").all() as Record<string, unknown>[];
    for (const r of sessions) {
      const site = String(r["site"]);
      let cookies: unknown = [];
      try {
        cookies = JSON.parse(String(r["cookies"] ?? "[]")) as unknown;
      } catch {
        continue;
      }
      if (!Array.isArray(cookies)) continue;
      for (const c of cookies) {
        if (typeof c !== "object" || c === null || !("value" in c) || typeof c.value !== "string" || c.value.length < COOKIE_SECRET_MIN) continue;
        const name = "name" in c && typeof c.name === "string" && REF_SAFE.test(c.name) ? `.${c.name}` : "";
        out.push({ ref: `${site}.cookie${name}`, value: c.value });
      }
    }
    return out;
  }

  // ---- guard counters ---------------------------------------------------

  guardCounter(site: string, sessionName: string): GuardCounter {
    const r = this.db.query("SELECT login_attempts, last_attempt_at FROM guard_counters WHERE site = ?1 AND session_name = ?2").get(site, sessionName) as Record<string, unknown> | null;
    return { site, sessionName, loginAttempts: r === null ? 0 : Number(r["login_attempts"]), lastAttemptAt: r === null || r["last_attempt_at"] === null ? null : Number(r["last_attempt_at"]) };
  }

  /** Count one login attempt; returns the new counter. */
  noteLoginAttempt(site: string, sessionName: string, now = Date.now()): GuardCounter {
    this.db
      .query(
        `INSERT INTO guard_counters (site, session_name, login_attempts, last_attempt_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(site, session_name) DO UPDATE SET login_attempts = login_attempts + 1, last_attempt_at = excluded.last_attempt_at`,
      )
      .run(site, sessionName, now);
    return this.guardCounter(site, sessionName);
  }

  /** Live requests sent by tools (not the browser) under `scope`, e.g. `replay-check`. */
  requestCounter(site: string, scope: string): RequestCounter {
    const r = this.db.query("SELECT requests, last_request_at FROM guard_counters WHERE site = ?1 AND session_name = ?2").get(site, scope) as Record<string, unknown> | null;
    return { site, scope, requests: r === null ? 0 : Number(r["requests"]), lastRequestAt: r === null || r["last_request_at"] === null ? null : Number(r["last_request_at"]) };
  }

  /** Count one live request; returns the new counter. */
  noteRequest(site: string, scope: string, now = Date.now()): RequestCounter {
    this.db
      .query(
        `INSERT INTO guard_counters (site, session_name, requests, last_request_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(site, session_name) DO UPDATE SET requests = requests + 1, last_request_at = excluded.last_request_at`,
      )
      .run(site, scope, now);
    return this.requestCounter(site, scope);
  }

  resetGuard(site: string, sessionName: string): void {
    this.db.query("DELETE FROM guard_counters WHERE site = ?1 AND session_name = ?2").run(site, sessionName);
  }

  // ---- saved sessions ---------------------------------------------------

  /**
   * The saved session of a site's account (the site's first account unless
   * `username` is given), or null. `cookies` is parsed JSON, unchecked: the
   * caller validates it. The values are live credentials: never print them.
   */
  savedSession(site: string, username?: string | null): SavedSession | null {
    const user = username ?? this.accountOf(site);
    const r = (
      user === null
        ? this.db.query("SELECT * FROM sessions WHERE site = ?1 ORDER BY saved_at DESC LIMIT 1").get(site)
        : this.db.query("SELECT * FROM sessions WHERE site = ?1 AND username = ?2").get(site, user)
    ) as Record<string, unknown> | null;
    if (r === null) return null;
    let cookies: unknown = [];
    try {
      cookies = JSON.parse(String(r["cookies"] ?? "[]")) as unknown;
    } catch {
      cookies = null;
    }
    return {
      site,
      username: String(r["username"]),
      cookies,
      savedAt: r["saved_at"] === null ? null : Number(r["saved_at"]),
      verifiedAt: r["verified_at"] === null ? null : Number(r["verified_at"]),
    };
  }

  /** Save (replace) the cookies of a site's account; the daemon calls it at session stop / handoff continue. */
  saveSession(site: string, username: string, cookies: unknown, now = Date.now()): void {
    this.db
      .query("INSERT INTO sessions (site, username, cookies, saved_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(site, username) DO UPDATE SET cookies = excluded.cookies, saved_at = excluded.saved_at")
      .run(site, username, JSON.stringify(cookies), now);
  }

  // ---- bundle index -----------------------------------------------------

  noteBundle(b: { path: string; site: string | null; sessionName: string | null }, now = Date.now()): void {
    this.db
      .query("INSERT INTO bundles (path, site, session_name, created, finished) VALUES (?1, ?2, ?3, ?4, NULL) ON CONFLICT(path) DO UPDATE SET site = excluded.site, session_name = excluded.session_name")
      .run(b.path, b.site, b.sessionName, now);
  }

  finishBundle(path: string, now = Date.now()): void {
    this.db.query("UPDATE bundles SET finished = ?2 WHERE path = ?1").run(path, now);
  }

  bundles(site?: string): BundleRow[] {
    const rows = (site === undefined ? this.db.query("SELECT * FROM bundles ORDER BY created").all() : this.db.query("SELECT * FROM bundles WHERE site = ?1 ORDER BY created").all(site)) as Record<string, unknown>[];
    return rows.map((r) => ({
      path: String(r["path"]),
      site: typeof r["site"] === "string" ? r["site"] : null,
      sessionName: typeof r["session_name"] === "string" ? r["session_name"] : null,
      created: Number(r["created"]),
      finished: r["finished"] === null ? null : Number(r["finished"]),
    }));
  }

  /** Test / diagnostics: table names in the file. */
  tables(): string[] {
    return (this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Record<string, unknown>[]).map((r) => String(r["name"]));
  }
}
