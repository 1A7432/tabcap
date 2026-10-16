// 0.6-M: import coverage for a real mitmproxy 12.2.3 HAR (`mitmdump --set hardump=...`).
// Oracle: the file itself (test/fixtures/har/mitmproxy-range.har, produced by driving
// test/e2e/site.ts through mitmdump with curl; the login password value in the request body
// is replaced with <redacted>) and HAR 1.2. The DROPPED list below is the literal answer to
// "which fields of this file does the import not keep" and feeds the table in docs/13.
// Reproduce: docs/13-interop-proxies.md section 2.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHar } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";

const har: unknown = JSON.parse(readFileSync(new URL("../fixtures/har/mitmproxy-range.har", import.meta.url), "utf8"));

/** Every leaf path in the document; array indexes collapse to [], an empty array is its own leaf. */
function leafPaths(v: unknown, at: string, out: Set<string>): void {
  if (Array.isArray(v)) {
    if (v.length === 0) out.add(`${at}[]`);
    for (const x of v) leafPaths(x, `${at}[]`, out);
  } else if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) leafPaths(x, at === "" ? k : `${at}.${k}`, out);
  } else out.add(at);
}

const E = "log.entries[]";
/** Fields the import reads into the bundle. */
const KEPT = [
  "log.creator.name",
  "log.creator.version",
  `${E}.startedDateTime`,
  `${E}.request.method`,
  `${E}.request.url`,
  `${E}.request.headers[].name`,
  `${E}.request.headers[].value`,
  `${E}.request.postData.text`,
  `${E}.response.status`,
  `${E}.response.statusText`,
  `${E}.response.httpVersion`,
  `${E}.response.headers[].name`,
  `${E}.response.headers[].value`,
  `${E}.response.content.mimeType`,
  `${E}.response.content.text`,
  `${E}.serverIPAddress`,
];
/** Fields of this file the import drops (docs/13 field-loss table). */
const DROPPED = [
  "log.version",
  "log.creator.comment",
  "log.pages[]",
  `${E}.time`,
  `${E}.timings.connect`,
  `${E}.timings.receive`,
  `${E}.timings.send`,
  `${E}.timings.ssl`,
  `${E}.timings.wait`,
  `${E}.request.httpVersion`,
  `${E}.request.cookies[]`,
  `${E}.request.cookies[].name`,
  `${E}.request.cookies[].value`,
  `${E}.request.queryString[]`,
  `${E}.request.queryString[].name`,
  `${E}.request.queryString[].value`,
  `${E}.request.headersSize`,
  `${E}.request.bodySize`,
  `${E}.request.postData.mimeType`,
  `${E}.request.postData.params[]`,
  `${E}.request.postData.params[].name`,
  `${E}.request.postData.params[].value`,
  `${E}.response.cookies[]`,
  `${E}.response.cookies[].name`,
  `${E}.response.cookies[].value`,
  `${E}.response.cookies[].path`,
  `${E}.response.cookies[].domain`,
  `${E}.response.cookies[].httpOnly`,
  `${E}.response.cookies[].secure`,
  `${E}.response.cookies[].sameSite`,
  `${E}.response.content.size`,
  `${E}.response.content.compression`,
  `${E}.response.redirectURL`,
  `${E}.response.headersSize`,
  `${E}.response.bodySize`,
];

async function importFixture() {
  const out = mkdtempSync(join(tmpdir(), "tabcap-mitm-"));
  const res = await importHar(structuredClone(har), out);
  return { res, r: BundleReader.open(out) };
}

describe("0.6-M mitmproxy HAR import", () => {
  test("every field of the fixture is in KEPT or DROPPED, none in both (a new mitmproxy shape fails here)", () => {
    const seen = new Set<string>();
    leafPaths(har, "", seen);
    const known = new Set([...KEPT, ...DROPPED]);
    expect([...seen].filter((p) => !known.has(p)).sort()).toEqual([]);
    // empty-array leaves only exist where the file has an empty array, so they are not required to be seen
    const missing = [...known].filter((p) => !seen.has(p) && !p.endsWith("[]"));
    expect(missing.sort()).toEqual([]);
    expect(KEPT.filter((p) => DROPPED.includes(p))).toEqual([]);
  });

  test("five requests, methods and paths in order, creator recorded", async () => {
    const { res, r } = await importFixture();
    expect(res).toMatchObject({ requests: 5, pages: 0, wsFrames: 0, events: 5, restoredFromEvents: false, missingBlobs: [] });
    expect(r.manifest.imported?.from).toBe("har");
    expect(r.manifest.imported?.creator).toEqual({ name: "mitmproxy", version: "12.2.3" });
    expect(r.requests().map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual(["GET /s06", "GET /api/search", "GET /s07/login", "POST /api/login", "POST /api/data"]);
    expect(r.requests().every((q) => q.response?.status === 200 && q.response.remote?.ip === "127.0.0.1")).toBe(true);
  });

  test("the POST body survives with the redacted password; response bodies and Set-Cookie are kept", async () => {
    const { r } = await importFixture();
    const login = r.requests().find((q) => q.url.endsWith("/api/login"));
    const post = login?.request.postData;
    expect(post !== null && post !== undefined && "inline" in post ? post.inline : null).toBe("user=demo-user&password=<redacted>");
    const setCookie = login?.response?.headers["set-cookie"];
    expect(typeof setCookie === "string" ? setCookie : "").toMatch(/^sid=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Lax$/);
    const data = r.requests().find((q) => q.url.endsWith("/api/data"));
    expect(data?.request.headers["cookie"]).toMatch(/^sid=[0-9a-f]{32}$/);
    expect(new TextDecoder().decode(r.readBlob(data?.response?.body?.blob ?? "") ?? new Uint8Array())).toBe('{"data":"data-ok"}');
  });

  test("dropped fields leave no trace; what that costs is reported in the manifest", async () => {
    const { res, r } = await importFixture();
    // timings were in the file but the bundle has none; mitmproxy has no resource type, so every request is "other"
    expect(r.requests().every((q) => q.timing === null && q.type === "other" && q.nav === null && q.initiator === null)).toBe(true);
    expect(res.lossy).toEqual(["actor", "tab", "cmd", "mono", "cdp", "timing", "headersSource", "redirect", "initiator"]);
    // the Cookie header (not the cookies array) is what keeps the request side whole
    expect(r.requests().filter((q) => "cookie" in q.request.headers).length).toBe(1);
  });
});
