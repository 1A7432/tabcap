// 0.6-E live output redaction (src/daemon/tools/liveredact.ts). Oracle: the
// `bundle redact` rules as docs/04 §8 states them (default@3: one sensitive
// header test = header set + name parts, the name rule, x-csrf* / x-xsrf*;
// names with token / secret / passw / session / sid / auth / api key, pass /
// pwd as a segment) and the s07 shapes of docs/05 (the `sid` cookie,
// `Authorization` and, since the one header test of 2026-10-21, `x-csrf`).

import { describe, expect, test } from "bun:test";
import { Secrets } from "../../src/daemon/secrets.ts";
import { redactBodyText, redactCookieHeader, redactFlatHeaders, redactHeaders, redactSetCookie, redactUrl, redacted, redactedDetail } from "../../src/daemon/tools/liveredact.ts";
import { fetchArgs } from "../../src/cli/fetch.ts";
import { parseFetchSpec } from "../../src/daemon/fetch/spec.ts";
import { redactDossier } from "../../src/daemon/tools/recon.ts";
import { requestDetail } from "../../src/daemon/tools/netshow.ts";
import { isRecord } from "../../src/shared/json.ts";
import { AnalyzeRedactor } from "../../src/analyze/redact.ts";

const plain = { scrub: (s: string) => s };
const store = new Secrets();
store.setStored([{ ref: "example.password", value: "St0re-pa55" }]);
const withStore = { scrub: (s: string) => store.scrub(s) };

describe("headers", () => {
  test("sensitive set, name rule and x-csrf redacted whole; content-type, user-agent kept", () => {
    const h = redactHeaders(
      {
        authorization: "Bearer abc.def",
        "x-api-key": "k-123",
        "access-token": "tok-1",
        "x-session-id": "s1",
        "x-user-pwd": "p",
        "x-csrf": "c5f0",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
      },
      plain,
    );
    expect(h).toEqual({
      authorization: "<redacted:authorization>",
      "x-api-key": "<redacted:x-api-key>",
      "access-token": "<redacted:access-token>",
      "x-session-id": "<redacted:x-session-id>",
      "x-user-pwd": "<redacted:x-user-pwd>",
      "x-csrf": "<redacted:x-csrf>",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
    });
    expect(redacted("sid")).toBe("<redacted:sid>");
  });

  test("cookie / set-cookie: names and attributes kept, every value redacted; repeated values each", () => {
    expect(redactCookieHeader("sid=abc123; pref=compact;theme=dark", plain)).toBe("sid=<redacted:sid>; pref=<redacted:pref>;theme=<redacted:theme>");
    expect(redactSetCookie("sid=abc; Path=/; HttpOnly\nlang=zh; Max-Age=60", plain)).toBe("sid=<redacted:sid>; Path=/; HttpOnly\nlang=<redacted:lang>; Max-Age=60");
    expect(redactHeaders({ "set-cookie": ["a=1; Path=/", "b=2"] }, plain)).toEqual({ "set-cookie": ["a=<redacted:a>; Path=/", "b=<redacted:b>"] });
    expect(redactCookieHeader("flag; sid=", plain)).toBe("flag; sid=");
  });

  test("a URL-valued header (location, referer) by its query", () => {
    expect(redactHeaders({ location: "/next?code=1&access_token=xyz", referer: "http://h/p?q=1" }, plain)).toEqual({ location: "/next?code=1&access_token=<redacted:access_token>", referer: "http://h/p?q=1" });
  });

  test("a value that is a known store secret keeps its <secret:…> placeholder", () => {
    expect(redactHeaders({ "x-auth-pass": "St0re-pa55", authorization: "Basic other" }, withStore)).toEqual({ "x-auth-pass": "<secret:example.password>", authorization: "<redacted:authorization>" });
  });
});

describe("URLs and bodies", () => {
  test("query: sensitive names (decoded) redacted, the rest byte for byte, fragment kept", () => {
    expect(redactUrl("https://h/a?token=t1&page=2&q=a%20b&user_pass=x&bypass=y#frag", plain)).toBe("https://h/a?token=<redacted:token>&page=2&q=a%20b&user_pass=<redacted:user_pass>&bypass=y#frag");
    expect(redactUrl("https://h/a?api%5Fkey=1", plain)).toBe("https://h/a?api%5Fkey=<redacted:api_key>");
    expect(redactUrl("https://h/a", plain)).toBe("https://h/a");
    // ticket is not a sensitive name (owner 2026-10-17)
    expect(redactUrl("https://h/login/return?ticket=ST-1-abc&next=%2Fhome", plain)).toBe("https://h/login/return?ticket=ST-1-abc&next=%2Fhome");
    expect(redactUrl("https://h/a?&&=x&sid", plain)).toBe("https://h/a?&&=x&sid");
  });

  test("live and offline analysis share the query walk: an export placeholder or a live one is never masked again", () => {
    const url = "https://h/a?token=«r:secret:0123abcd»&sid=<redacted:sid>&code=1";
    expect(redactUrl(url, plain)).toBe(url);
    expect(new AnalyzeRedactor().url(url)).toBe(url);
    expect(new AnalyzeRedactor().url("https://h/a?token=t1&q=2")).toMatch(/^https:\/\/h\/a\?token=<redacted:[0-9a-f]{8}>&q=2$/);
  });

  test("form and JSON bodies: sensitive fields at any depth; untouched text stays as it was", () => {
    expect(redactBodyText("user=demo&password=hunter22&_token=abc", "application/x-www-form-urlencoded", plain)).toBe("user=demo&password=<redacted:password>&_token=<redacted:_token>");
    expect(redactBodyText('{"user":"demo","auth":{"refresh_token":"r1","n":1},"list":[{"sid":7}]}', "application/json", plain)).toBe('{"user":"demo","auth":{"refresh_token":"<redacted:refresh_token>","n":1},"list":[{"sid":"<redacted:sid>"}]}');
    const pretty = '{\n  "user": "demo"\n}';
    expect(redactBodyText(pretty, "application/json", plain)).toBe(pretty);
    expect(redactBodyText("password=x", null, plain)).toBe("password=<redacted:password>");
    expect(redactBodyText("free text with password=x inside", null, plain)).toBe("free text with password=x inside");
    expect(redactBodyText("{not json", "application/json", plain)).toBe("{not json");
  });
});

describe("net show detail", () => {
  const ev = {
    kind: "request",
    id: "r-7",
    method: "POST",
    url: "http://127.0.0.1:1/api/data?sid=abc&page=1",
    type: "fetch",
    request: { headers: { "x-csrf": "c5f0", cookie: "sid=abc", authorization: "Bearer tok", "content-type": "application/x-www-form-urlencoded" }, postData: { inline: "a=1&secret=s" } },
    response: { status: 200, headers: { "set-cookie": "sid=new; Path=/", "content-type": "application/json" }, body: null },
    timing: {},
  };

  test("redactedDetail: url, both header maps and postData (bytes as recorded); the event itself unchanged", () => {
    const copy: unknown = JSON.parse(JSON.stringify(ev));
    const d = redactedDetail(ev, plain, (e) => requestDetail(e, { pathOf: () => null, tryRead: () => null }, () => "/unused"));
    expect(d["url"]).toBe("http://127.0.0.1:1/api/data?sid=<redacted:sid>&page=1");
    const req = isRecord(d["request"]) ? d["request"] : {};
    const resp = isRecord(d["response"]) ? d["response"] : {};
    expect(req["headers"]).toEqual({ "x-csrf": "<redacted:x-csrf>", cookie: "sid=<redacted:sid>", authorization: "<redacted:authorization>", "content-type": "application/x-www-form-urlencoded" });
    expect(req["postData"]).toEqual({ inline: "a=1&secret=<redacted:secret>", bytes: 12, truncated: false });
    expect(resp["headers"]).toEqual({ "set-cookie": "sid=<redacted:sid>; Path=/", "content-type": "application/json" });
    expect(JSON.parse(JSON.stringify(ev))).toEqual(copy);
  });
});

describe("fetch", () => {
  test("envelope headers (single values) and the reveal switch from the CLI and POST /fetch", () => {
    expect(redactFlatHeaders({ "content-type": "application/json", location: "/cb?state=1&id_token=j", "x-session": "s" }, plain)).toEqual({ "content-type": "application/json", location: "/cb?state=1&id_token=<redacted:id_token>", "x-session": "<redacted:x-session>" });
    expect(fetchArgs({ url: "/x", reveal: true }, "/")).toEqual({ url: "/x", reveal: true });
    expect(fetchArgs({ url: "/x" }, "/")).toEqual({ url: "/x" });
    expect(fetchArgs({ batch: "b.jsonl", reveal: true }, "/", () => '{"url":"/a"}\n{"url":"/b","reveal":false}\n')).toEqual({ batch: [{ url: "/a", reveal: true }, { url: "/b", reveal: false }] });
    expect(parseFetchSpec({ url: "/x", reveal: true }).reveal).toBe(true);
    expect(parseFetchSpec({ url: "/x" }).reveal).toBe(false);
    expect(() => parseFetchSpec({ url: "/x", reveal: "yes" })).toThrow(/reveal must be true or false/);
  });
});

describe("recon dossier", () => {
  test("page and guard URLs by the query rule; nothing else changes", () => {
    const base = {
      schema: "tabcap-dossier/0" as const,
      bundle: "/b",
      session: "s",
      generatedAt: 1,
      page: { url: "http://h/p?access_token=x&tab=2", title: "t", source: "live" as const },
      stack: [],
      channels: [],
      coverage: { ratio: null, total: 0, found: 0, unmatched: [], capped: 0 },
      cookies: [],
      protection: [{ source: "guard" as const, kind: "challenge", request: "r-2", url: "http://h/v?ticket=1&sessionId=9", status: 403, handedToHuman: null, resumedBy: null, grade: "实测" as const }],
      grades: { stack: "推断" as const, channels: "实测" as const, coverage: "实测" as const, cookies: { origin: "实测" as const, lifetime: "实测" as const, flags: "实测" as const, role: "推断" as const, requiredBy: "analyze deps (per entry)" as const }, protection: { guard: "实测" as const, response: "推断" as const, family: "推断" as const } },
      fingerprinting: [],
      notes: [],
      warnings: [],
    };
    const r = redactDossier(base, plain);
    expect(r.page.url).toBe("http://h/p?access_token=<redacted:access_token>&tab=2");
    expect(r.protection[0]).toMatchObject({ url: "http://h/v?ticket=1&sessionId=<redacted:sessionId>" });
    expect({ ...r, page: base.page, protection: base.protection }).toEqual(base);
  });
});
