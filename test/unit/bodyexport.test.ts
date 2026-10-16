// 0.5-F2 `net body --file`: extension mapping, flag exclusivity, scrub before write, file mode and location.
// Inputs are literals; the expected placeholder comes from the secret module's documented `<secret:ref>` form.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "../../src/daemon/secrets.ts";
import { exportBody, extOfMime, fileFlagOf } from "../../src/daemon/tools/bodyexport.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const tmp = mkdtempSync(join(tmpdir(), "tabcap-bodyexport-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const enc = (s: string) => new TextEncoder().encode(s);

describe("extOfMime", () => {
  test("js / json / html / css / txt, else bin", () => {
    expect(extOfMime("application/javascript")).toBe("js");
    expect(extOfMime("text/javascript; charset=utf-8")).toBe("js");
    expect(extOfMime("text/plain", "script")).toBe("js");
    expect(extOfMime("application/json")).toBe("json");
    expect(extOfMime("application/ld+json; charset=utf-8")).toBe("json");
    expect(extOfMime("text/html; charset=utf-8")).toBe("html");
    expect(extOfMime("TEXT/CSS")).toBe("css");
    expect(extOfMime("text/plain")).toBe("txt");
    expect(extOfMime("text/csv")).toBe("txt");
    expect(extOfMime("image/png")).toBe("bin");
    expect(extOfMime("application/octet-stream")).toBe("bin");
    expect(extOfMime(null)).toBe("bin");
  });
});

describe("fileFlagOf", () => {
  test("off without --file; on alone or with --pretty", () => {
    expect(fileFlagOf({})).toBe(false);
    expect(fileFlagOf({ pretty: true })).toBe(false);
    expect(fileFlagOf({ file: true, pretty: true })).toBe(true);
  });
  test("--file with --grep / --lines / --at / --out is a usage error", () => {
    for (const k of ["grep", "lines", "at", "out"]) {
      let err: unknown = null;
      try {
        fileFlagOf({ file: true, [k]: "x" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TabcapError);
      expect(err instanceof TabcapError ? err.code : "").toBe("usage");
    }
  });
});

describe("exportBody", () => {
  const secrets = new Secrets();
  secrets.setStored([{ ref: "example.password", value: "hunter2-Zq9" }]);
  const base = { id: "r-7", url: "http://127.0.0.1/app.js", resourceType: "script", charset: () => null, scrub: (s: string) => secrets.scrub(s) };

  test("a known secret value is replaced before the file is written; 0600; overwritten on repeat", () => {
    const src = 'var a=1;var pw="hunter2-Zq9";function f(){return pw}';
    const r = exportBody({ ...base, bytes: enc(src), mime: "application/javascript", pretty: false, where: { bundle: tmp } });
    const want = 'var a=1;var pw="<secret:example.password>";function f(){return pw}';
    expect(r).toMatchObject({ id: "r-7", mime: "application/javascript", pretty: false, scrubbed: true, lines: 1, bytes: want.length });
    expect(r["file"]).toBe(join(tmp, "exports", "bodies", "r-7.js"));
    const text = readFileSync(String(r["file"]), "utf8");
    expect(text).toBe(want);
    expect(text).not.toContain("hunter2-Zq9");
    if (process.platform !== "win32") expect(statSync(String(r["file"])).mode & 0o777).toBe(0o600);
    const again = exportBody({ ...base, bytes: enc("var z=2"), mime: "application/javascript", pretty: false, where: { bundle: tmp } });
    expect(again["file"]).toBe(r["file"]);
    expect(readFileSync(String(again["file"]), "utf8")).toBe("var z=2");
  });

  test("--pretty: the pretty text is written under <id>.pretty.<ext>; not applicable stays plain", () => {
    const r = exportBody({ ...base, bytes: enc("var a=1;var b=2;"), mime: "application/javascript", pretty: true, where: { bundle: tmp } });
    expect(r["file"]).toBe(join(tmp, "exports", "bodies", "r-7.pretty.js"));
    expect(r["pretty"]).toBe(true);
    expect(Number(r["lines"])).toBeGreaterThan(1);
    expect(readFileSync(String(r["file"]), "utf8").split("\n").length).toBe(Number(r["lines"]));
    const h = exportBody({ ...base, id: "r-8", resourceType: "document", bytes: enc("<p>x</p>"), mime: "text/html", pretty: true, where: { bundle: tmp } });
    expect(h).toMatchObject({ pretty: false, scrubbed: true });
    expect(String(h["file"]).endsWith(join("bodies", "r-8.html"))).toBe(true);
    expect(String(h["note"])).toContain("--pretty applies to JavaScript and JSON");
  });

  test("no recording: <cache>/outputs/bodies/<stamp>-<id>.<ext>", () => {
    const r = exportBody({ ...base, id: "r-9", resourceType: "xhr", bytes: enc("a\nb"), mime: "text/plain", pretty: false, where: { cache: tmp }, now: Date.UTC(2026, 9, 16, 1, 2, 3) });
    expect(String(r["file"]).startsWith(join(tmp, "outputs", "bodies"))).toBe(true);
    expect(String(r["file"])).toMatch(/\d{8}.*-r-9\.txt$/);
    expect(r["lines"]).toBe(2);
  });

  test("a binary body is written raw, scrubbed:false with a note", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe, 0x00]);
    const r = exportBody({ ...base, id: "r-10", bytes: png, mime: "image/png", resourceType: "image", pretty: false, where: { bundle: tmp } });
    expect(r).toMatchObject({ scrubbed: false, bytes: png.length, lines: 0, pretty: false });
    expect(String(r["file"]).endsWith("r-10.bin")).toBe(true);
    expect(new Uint8Array(readFileSync(String(r["file"])))).toEqual(png);
    expect(String(r["note"])).toContain("scrubbed: false");
  });

  test("a WebSocket frame id becomes a safe file name", () => {
    const r = exportBody({ ...base, id: "r-12:34", url: "ws://x/", bytes: enc("hi"), mime: "text/plain", resourceType: null, pretty: false, where: { bundle: tmp } });
    expect(String(r["file"]).endsWith("r-12-34.txt")).toBe(true);
  });
});
