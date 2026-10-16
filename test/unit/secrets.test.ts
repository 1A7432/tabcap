import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/main.ts";
import { scrubbedBody } from "../../src/daemon/main.ts";
import { MASK, Secrets, scrubValue, variantsOf } from "../../src/daemon/secrets.ts";
import { Daemon } from "../../src/daemon/state.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { fail, ok } from "../../src/shared/envelope.ts";
import { log, setLogLevel, setLogScrubber } from "../../src/shared/log.ts";
import { paths } from "../../src/shared/paths.ts";

const PW = "Hunter 2&co/ü\"x";

describe("known-secret replacement (docs/04 §8.1)", () => {
  test("store values become <secret:site.field> in every spelling", () => {
    const s = new Secrets();
    s.setStored([{ ref: "example.password", value: PW }]);
    const json = JSON.stringify({ v: PW });
    expect(s.scrub(`raw ${PW} end`)).toBe("raw <secret:example.password> end");
    expect(s.scrub(json)).toBe('{"v":"<secret:example.password>"}');
    expect(s.scrub(`user=alice&password=${encodeURIComponent(PW)}`)).toBe("user=alice&password=<secret:example.password>");
    expect(s.scrub(new URLSearchParams({ password: PW }).toString())).toBe("password=<secret:example.password>");
    expect(variantsOf(PW).length).toBeGreaterThanOrEqual(4);
  });

  test("ad-hoc password values stay <masked>; store refs win for the same value", () => {
    const s = new Secrets();
    s.add("typed-pass-1");
    s.add("ab"); // too short to replace safely
    s.setStored([{ ref: "example.password", value: "stored-pass-2" }]);
    s.add("stored-pass-2");
    expect(s.scrub("typed-pass-1 stored-pass-2 ab")).toBe(`${MASK} <secret:example.password> ab`);
  });

  test("a short password inside a placeholder or site name is never rewritten; scrubbing twice is a no-op", () => {
    const s = new Secrets();
    s.setStored([{ ref: "range-demo.password", value: "demo" }]);
    const once = s.scrub("password demo for range-demo");
    expect(once).toBe("password <secret:range-demo.password> for range-<secret:range-demo.password>");
    expect(s.scrub(once)).toBe(once);
    expect(s.scrub("<secret:range-demo.password>")).toBe("<secret:range-demo.password>");
  });

  test("nested JSON: values, arrays and object keys", () => {
    const s = new Secrets();
    s.setStored([{ ref: "example.password", value: PW }]);
    const v = scrubValue(s, { a: [{ b: `x${PW}y` }, 1, null, true], [PW]: { deep: [PW] } });
    expect(JSON.stringify(v)).not.toContain(PW);
    expect(v).toEqual({ a: [{ b: "x<secret:example.password>y" }, 1, null, true], "<secret:example.password>": { deep: ["<secret:example.password>"] } });
  });

  test("setStored picks up removals", () => {
    const s = new Secrets();
    s.setStored([{ ref: "a.password", value: "first-secret" }]);
    expect(s.scrub("first-secret")).toBe("<secret:a.password>");
    s.setStored([]);
    expect(s.scrub("first-secret")).toBe("first-secret");
  });
});

describe("daemon outputs", () => {
  let root = "";
  afterEach(() => {
    setLogScrubber(null);
    setLogLevel("warn");
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  test("envelopes (ok and error, nested) and log lines carry no store secret", () => {
    root = mkdtempSync(join(tmpdir(), "tabcap-scrub-"));
    const p = paths({ TABCAP_HOME: root });
    const store = Store.open(p.config);
    store.addSite({ name: "example", entryUrl: "https://example.test/", domains: [], username: "alice", password: PW });
    const d = new Daemon(p);
    d.store = store;
    d.refreshSecrets();
    const body = scrubbedBody(d, ok({ value: PW, tree: [`textbox "${PW}"`], deep: { k: { v: encodeURIComponent(PW) } } }));
    expect(body).not.toContain(PW);
    expect(body).not.toContain(encodeURIComponent(PW));
    expect(body).toContain("<secret:example.password>");
    expect(scrubbedBody(d, fail("page", `bad ${PW}`, `next ${PW}`, { result: { x: PW } }))).not.toContain(PW);
    // log lines
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
      return true;
    };
    try {
      setLogLevel("debug");
      setLogScrubber((l) => d.secrets.scrub(l));
      log.info(`message ${PW}`, { field: PW, nested: { arr: [PW] } });
    } finally {
      process.stderr.write = orig;
    }
    const logged = chunks.join("");
    expect(logged).toContain("<secret:example.password>");
    expect(logged).not.toContain(PW);
    expect(logged).not.toContain(JSON.stringify(PW).slice(1, -1));
    store.close();
  });

  test("site add never takes the password as an argument, and never echoes a stray one", async () => {
    const a = await run(["site", "add", "x", "--url", "https://x.test/", "--user", "u", "--password", "hunter2-pw"]);
    expect(a.envelope.ok).toBe(false);
    expect(JSON.stringify(a.envelope)).not.toContain("hunter2-pw");
    const b = await run(["site", "add", "x", "hunter2-pw", "--url", "https://x.test/", "--user", "u"]);
    expect(b.envelope.ok).toBe(false);
    expect(JSON.stringify(b.envelope)).not.toContain("hunter2-pw");
  });
});
