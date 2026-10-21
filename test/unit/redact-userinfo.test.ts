// Export redaction default@3, URL rule (review 10-21, owner decision; docs/04
// §8): the userinfo of a URL (`scheme://user:pass@host`) is dropped, leaving
// `scheme://host`, wherever the URL rule applies (request URLs, URL-shaped
// strings and url fields of every event, the manifest's first URLs and
// switch values). An `@` after the authority (path, query, fragment) is not
// userinfo. Oracle: RFC 3986 §3.2 (authority = [userinfo "@"] host [":" port]).

import { describe, expect, test } from "bun:test";
import { Redactor, redactView } from "../../src/bundle/redact.ts";
import type { BundleView } from "../../src/bundle/reader.ts";
import { newManifest } from "../../src/bundle/manifest.ts";
import type { RawEvent } from "../../src/bundle/types.ts";

describe("URL rule: userinfo", () => {
  test("user:pass@ and user@ are dropped; host, port, path, query and fragment stay", () => {
    const r = new Redactor("salt");
    expect(r.url("https://alice:pa55word@shop.example:8443/p/q?x=1#f")).toBe("https://shop.example:8443/p/q?x=1#f");
    expect(r.url("ftp://bob@files.example/x")).toBe("ftp://files.example/x");
    expect(r.url("socks5://u:p@127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(r.url("https://shop.example/a@b?to=x@y#c@d")).toBe("https://shop.example/a@b?to=x@y#c@d");
    expect(r.url("/relative/a@b")).toBe("/relative/a@b");
  });

  test("redactView: request URL, a cmd argv URL, a guard detail url, the manifest's first URL and a --proxy-server switch", () => {
    const m = newManifest({ created: 1, session: { name: "s", tabs: [{ tab: "t1", chromeTabId: null, owned: true, firstUrl: "https://u:secretpw@a.example/" }] } });
    m.producer = { tool: "tabcap", version: "0", browser: { name: "Chrome", version: "1", args: ["--proxy-server=http://pu:ppw@proxy.example:3128"] } };
    const env = { ts: 1, mono: null, actor: "ai" as const, tab: "t1", cmd: null };
    const events: RawEvent[] = [
      { seq: 1, ...env, kind: "cmd", argv: ["navigate", "https://u:secretpw@a.example/login"], input: null },
      { seq: 2, ...env, kind: "guard", event: "breaker", detail: { url: "https://u:secretpw@a.example/x" } },
    ];
    const src: BundleView = { manifest: m, events, readBlob: () => null };
    const v = redactView(src, { salt: "s", now: () => 2 });
    const all = JSON.stringify({ m: v.manifest, e: v.events });
    expect(all).not.toContain("secretpw");
    expect(all).not.toContain("ppw");
    expect(v.manifest.session.tabs[0]?.firstUrl).toBe("https://a.example/");
    expect(v.manifest.producer.browser?.args).toEqual(["--proxy-server=http://proxy.example:3128"]);
    expect(v.events[0]?.["argv"]).toEqual(["navigate", "https://a.example/login"]);
    expect(v.events[1]?.["detail"]).toEqual({ url: "https://a.example/x" });
  });
});
