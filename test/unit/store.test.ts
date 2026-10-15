import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store, checkSiteName, storePath } from "../../src/daemon/store/db.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { siteAdd, siteList, siteRemove, stripNewline } from "../../src/cli/site.ts";
import { paths } from "../../src/shared/paths.ts";
import { expectMode, POSIX_MODES } from "./_platform.ts";

const PW = "s3cret-Pa55!word";
let root = "";
let config = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tabcap-store-"));
  config = join(root, "config");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : `other: ${String(e)}`;
  }
}

describe("store: file and permissions (docs/04 §8.1)", () => {
  test("creates config/ 0700 and state.db 0600 with every table", () => {
    const s = Store.open(config);
    expectMode(config, 0o700);
    expectMode(storePath(config), 0o600);
    expect(s.tables()).toEqual(["accounts", "bundles", "guard_counters", "login_recipes", "meta", "sessions", "sites"]);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    s.close();
  });

  test.skipIf(!POSIX_MODES)("refuses a store file readable by others, and does not fix it silently", () => {
    Store.open(config).close();
    chmodSync(storePath(config), 0o644);
    expect(codeOf(() => Store.open(config))).toBe("conflict");
    expect(statSync(storePath(config)).mode & 0o777).toBe(0o644);
    chmodSync(storePath(config), 0o600);
    expect(codeOf(() => Store.open(config).close())).toBeNull();
  });

  test.skipIf(!POSIX_MODES)("refuses a config directory wider than 0700", () => {
    mkdirSync(config, { mode: 0o755 });
    chmodSync(config, 0o755);
    expect(codeOf(() => Store.open(config))).toBe("conflict");
  });

  test("migrations: reopen is a no-op; a newer schema is refused", () => {
    const a = Store.open(config);
    a.addSite({ name: "shop", entryUrl: "https://shop.test/", domains: ["shop.test"], username: "alice", password: PW });
    a.close();
    const b = Store.open(config);
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    expect(b.listSites().map((x) => x.name)).toEqual(["shop"]);
    b.close();
    const raw = new Database(storePath(config));
    raw.query("UPDATE meta SET value = ?1 WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    raw.close();
    expect(codeOf(() => Store.open(config))).toBe("conflict");
  });

  test("a file without the schema_version row is migrated from 0", () => {
    mkdirSync(config, { mode: 0o700 });
    const raw = new Database(storePath(config), { create: true });
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.close();
    chmodSync(storePath(config), 0o600);
    const s = Store.open(config);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.tables()).toContain("guard_counters");
    s.close();
  });
});

describe("store: sites, accounts, secrets", () => {
  test("CRUD and secret lookup; listings carry no secret values", () => {
    const s = Store.open(config);
    s.addSite({ name: "shop", entryUrl: "https://shop.test/login", domains: ["shop.test", "api.shop.test"], notes: "test account", username: "alice", password: PW, totpSeed: "JBSWY3DPEHPK3PXP" });
    expect(codeOf(() => s.addSite({ name: "shop", entryUrl: "https://x.test/", domains: [], username: "bob", password: "other-pass" }))).toBe("conflict");
    const list = s.listSites();
    expect(list).toEqual([{ name: "shop", entryUrl: "https://shop.test/login", domains: ["shop.test", "api.shop.test"], notes: "test account", created: list[0]?.created ?? 0, usernames: ["alice"] }]);
    expect(JSON.stringify(list)).not.toContain(PW);
    expect(JSON.stringify(list)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(s.secretValue("shop", "password")).toBe(PW);
    expect(s.secretValue("shop", "username")).toBe("alice");
    expect(s.secretValue("shop", "password", "nobody")).toBeNull();
    expect(s.secretValue("nope", "password")).toBeNull();
    expect(s.knownSecrets()).toEqual([
      { ref: "shop.password", value: PW },
      { ref: "shop.totp_seed", value: "JBSWY3DPEHPK3PXP" },
    ]);
    s.noteLoginAttempt("shop", "s1");
    expect(s.removeSite("shop")).toBe(true);
    expect(s.removeSite("shop")).toBe(false);
    expect(s.knownSecrets()).toEqual([]);
    expect(s.guardCounter("shop", "s1").loginAttempts).toBe(0);
    s.close();
  });

  test("site names stay usable in <site>.password references", () => {
    expect(checkSiteName("range-demo")).toBe("range-demo");
    for (const bad of ["", "a.b", "a b", "x".repeat(65), "../x"]) expect(codeOf(() => checkSiteName(bad))).toBe("usage");
  });

  test("guard counters are per site and session; bundles are indexed", () => {
    const s = Store.open(config);
    expect(s.guardCounter("shop", "a")).toEqual({ site: "shop", sessionName: "a", loginAttempts: 0, lastAttemptAt: null });
    expect(s.noteLoginAttempt("shop", "a", 1000).loginAttempts).toBe(1);
    expect(s.noteLoginAttempt("shop", "a", 2000)).toEqual({ site: "shop", sessionName: "a", loginAttempts: 2, lastAttemptAt: 2000 });
    expect(s.guardCounter("shop", "b").loginAttempts).toBe(0);
    expect(s.guardCounter("other", "a").loginAttempts).toBe(0);
    s.resetGuard("shop", "a");
    expect(s.guardCounter("shop", "a").loginAttempts).toBe(0);
    s.noteBundle({ path: "/b/1", site: "shop", sessionName: "a" }, 10);
    s.noteBundle({ path: "/b/2", site: null, sessionName: "x" }, 20);
    s.finishBundle("/b/1", 30);
    expect(s.bundles()).toEqual([
      { path: "/b/1", site: "shop", sessionName: "a", created: 10, finished: 30 },
      { path: "/b/2", site: null, sessionName: "x", created: 20, finished: null },
    ]);
    expect(s.bundles("shop").map((b) => b.path)).toEqual(["/b/1"]);
    s.close();
  });
});

describe("tabcap site add | list | remove (CLI side)", () => {
  test("password from stdin only; output and listing never carry it", async () => {
    const p = paths({ TABCAP_HOME: root });
    const out = await siteAdd(p, { name: "shop", url: "https://shop.test/login", user: "alice", passwordStdin: true }, () => Promise.resolve(PW + "\n"));
    expect(JSON.stringify(out)).not.toContain(PW);
    expect(out).toMatchObject({ site: "shop", username: "alice", domains: ["shop.test"], secrets: ["shop.username", "shop.password"] });
    const list = siteList(p);
    expect(JSON.stringify(list)).not.toContain(PW);
    expect(list).toMatchObject({ sites: [{ name: "shop", entryUrl: "https://shop.test/login", usernames: ["alice"] }] });
    const s = Store.open(p.config);
    expect(s.secretValue("shop", "password")).toBe(PW); // one trailing newline stripped, nothing else
    s.close();
    await expect(siteAdd(p, { name: "shop", url: "https://shop.test/", user: "bob", passwordStdin: true }, () => Promise.resolve("x"))).rejects.toThrow("already exists");
    await expect(siteAdd(p, { name: "two", url: "ftp://x", user: "bob", passwordStdin: true }, () => Promise.resolve("pw-pw-pw"))).rejects.toThrow("http(s)");
    await expect(siteAdd(p, { name: "two", url: "https://x.test", user: "bob", passwordStdin: true }, () => Promise.resolve("\n"))).rejects.toThrow("empty password");
    expect(siteRemove(p, { name: "shop" })).toEqual({ site: "shop", removed: true });
    expect(() => siteRemove(p, { name: "shop" })).toThrow("no site");
  });

  test("stripNewline removes exactly one line ending", () => {
    expect(stripNewline("a\n")).toBe("a");
    expect(stripNewline("a\r\n")).toBe("a");
    expect(stripNewline("a\n\n")).toBe("a\n");
    expect(stripNewline(" a ")).toBe(" a ");
  });
});
