// replay session (src/replay/session.ts): storageState export.
// Shape oracle: Playwright BrowserContext.storageState() — cookies[] with
// name/value/domain/path/expires/httpOnly/secure/sameSite (expires -1 for a
// session cookie), origins[] with localStorage [{name, value}].

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/daemon/store/db.ts";
import { exportSession, toStorageCookie } from "../../src/replay/session.ts";
import { run } from "../../src/cli/main.ts";
import { tmp, buildBundle } from "./_analyze.ts";
import { COOKIES, LOCAL_STORAGE, SID, buildReplayBundle } from "./_replay.ts";
import { SLOW_IO_MS, expectMode } from "./_platform.ts";

let root = "";
let bundle = "";
let bare = "";

beforeAll(async () => {
  root = tmp("tabcap-replay-s-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
  bare = await buildBundle(join(root, "bare"), { name: "bare", created: 1760600000000, seed: 3 }, async (b) => {
    await b.request({ url: "http://127.0.0.1:4310/x", body: "{}", mime: "application/json", ts: 1760600000100 });
  });
}, SLOW_IO_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

describe("storageState export", () => {
  test("cookies of the latest snapshot in Playwright shape; localStorage per origin; file 0600", () => {
    const out = join(root, "out", "state.json");
    const r = exportSession({ bundle, out, configDir: join(root, "cfg-unused") });
    expectMode(out, 0o600);
    const state: unknown = JSON.parse(readFileSync(out, "utf8"));
    expect(state).toEqual({
      cookies: [
        { name: "sid", value: SID, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" },
        { name: "theme", value: "dark", domain: "127.0.0.1", path: "/", expires: 1790000000.5, httpOnly: false, secure: false, sameSite: "Lax" },
      ],
      origins: [{ origin: "http://127.0.0.1:4310", localStorage: LOCAL_STORAGE.map(([name, value]) => ({ name, value })) }],
    });
    expect(r).toMatchObject({ cookies: 2, domains: ["127.0.0.1"], origins: 1, mode: "0600", sensitive: true, source: { kind: "bundle" } });
    // the malformed third cookie is reported, not thrown on
    expect(r.warnings.some((w) => w.includes("cookie #2"))).toBe(true);
    // values never in the command output
    expect(JSON.stringify(r)).not.toContain(SID);
    expect(COOKIES.length).toBe(3);
  });

  test("an existing wider file is replaced by a 0600 one", () => {
    const out = join(root, "wide.json");
    writeFileSync(out, "{}", { mode: 0o644 });
    exportSession({ bundle, out, configDir: join(root, "cfg-unused") });
    expectMode(out, 0o600);
  });

  test("no snapshot in the bundle: --site falls back to the store's saved session; none at all is an error", () => {
    const cfg = join(root, "cfg");
    const s = Store.open(cfg);
    s.addSite({ name: "demo", entryUrl: "http://127.0.0.1:4310/login", domains: ["127.0.0.1"], username: "alice", password: "Secret-pass-1" });
    s.saveSession("demo", "alice", [{ name: "sid", value: "stored-sid-value", domain: ".127.0.0.1", path: "/", expires: 1800000000, httpOnly: true, secure: true, sameSite: "None" }]);
    s.close();
    const out = join(root, "from-store.json");
    const r = exportSession({ bundle: bare, out, site: "demo", configDir: cfg });
    expect(r.source).toMatchObject({ kind: "store", site: "demo", account: "alice" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      cookies: [{ name: "sid", value: "stored-sid-value", domain: ".127.0.0.1", path: "/", expires: 1800000000, httpOnly: true, secure: true, sameSite: "None" }],
      origins: [],
    });
    expect(JSON.stringify(r)).not.toContain("stored-sid-value");
    expect(JSON.stringify(r)).not.toContain("Secret-pass-1");
    expect(() => exportSession({ bundle: bare, out: join(root, "none.json"), configDir: cfg })).toThrow(/no cookie snapshot/);
    expect(() => exportSession({ bundle: bare, out: join(root, "none.json"), site: "nope", configDir: cfg })).toThrow(/no site "nope"/);
  });

  test("CLI: -o is required; the envelope says the file is sensitive", async () => {
    const miss = await run(["replay", "session", bundle]);
    expect(miss.code).toBe(2);
    const out = join(root, "cli.json");
    const r = await run(["replay", "session", bundle, "-o", out]);
    expect(r.code).toBe(0);
    expect(r.envelope).toMatchObject({ ok: true, data: { out, sensitive: true, mode: "0600" } });
    expect(JSON.stringify(r.envelope)).not.toContain(SID);
  });
});

describe("cookie conversion", () => {
  test("CDP fields map to storageState; bad input is a reason, not a throw", () => {
    expect(toStorageCookie({ name: "a", value: "1", domain: "x.test", sameSite: "lax", expires: 0 })).toEqual({ name: "a", value: "1", domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" });
    expect(toStorageCookie({ name: "a", value: "1", domain: "x.test", expires: 99, session: true }).valueOf()).toMatchObject({ expires: -1 });
    expect(toStorageCookie({ name: "a", value: 1, domain: "x" })).toBe("value is not a string");
    expect(toStorageCookie(null)).toBe("not an object");
    expect(toStorageCookie({ name: "a", value: "", domain: "" })).toBe("domain is not a non-empty string");
  });
});
