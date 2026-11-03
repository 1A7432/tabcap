// 0.9-F upstream choice and the child's environment (docs/04 §50.2). Expected
// values are the §50.2 rules: lowercase proxy variables before uppercase, the
// original no_proxy sends matching hosts direct, http:// upstream proxies
// only, no credentials on the command line; the child gets both cases of the
// proxy variables, no ALL_PROXY, empty NO_PROXY and the four CA variables.

import { describe, expect, test } from "bun:test";
import { makeRouter, noProxyMatch, parseProxyUrl } from "../../src/record/upstream.ts";
import { CA_VARS, PROXY_VARS, childEnv } from "../../src/record/run.ts";

describe("noProxyMatch", () => {
  test("exact names, domain suffixes with or without a dot, *, IPs, ports", () => {
    expect(noProxyMatch("localhost", "localhost", 443)).toBe(true);
    expect(noProxyMatch("example.test", "api.example.test", 443)).toBe(true);
    expect(noProxyMatch(".example.test", "api.example.test", 443)).toBe(true);
    expect(noProxyMatch(".example.test", "example.test", 443)).toBe(true);
    expect(noProxyMatch("*.example.test", "a.example.test", 443)).toBe(true);
    expect(noProxyMatch("example.test", "badexample.test", 443)).toBe(false);
    expect(noProxyMatch("127.0.0.1, ::1", "::1", 80)).toBe(true);
    expect(noProxyMatch("127.0.0.1", "127.0.0.2", 80)).toBe(false);
    expect(noProxyMatch("*", "anything", 1)).toBe(true);
    expect(noProxyMatch("api.example.test:8443", "api.example.test", 443)).toBe(false);
    expect(noProxyMatch("api.example.test:8443", "api.example.test", 8443)).toBe(true);
    expect(noProxyMatch("10.0.0.0/8", "10.1.2.3", 80)).toBe(false); // CIDR is not supported
  });
});

describe("makeRouter", () => {
  test("env: lowercase first, per scheme, then all_proxy; no_proxy goes direct; the label names the https route", () => {
    const r = makeRouter({ kind: "env" }, { https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:2", HTTP_PROXY: "http://plain:3", no_proxy: "intra.test" });
    expect(r.route("https", "site.test", 443)).toMatchObject({ kind: "http", host: "lower", port: 1 });
    expect(r.route("http", "site.test", 80)).toMatchObject({ kind: "http", host: "plain", port: 3 });
    expect(r.route("https", "a.intra.test", 443)).toEqual({ kind: "direct" });
    expect(r.label).toBe("env http://lower:1");
    expect(makeRouter({ kind: "env" }, { ALL_PROXY: "http://all:4" }).route("https", "x", 443)).toMatchObject({ host: "all", port: 4 });
    expect(makeRouter({ kind: "env" }, {}).label).toBe("env direct");
  });

  test("env credentials become Proxy-Authorization and stay out of the label", () => {
    const r = makeRouter({ kind: "env" }, { https_proxy: "http://u%40x:p%3Aw@proxy.test:8080" });
    const route = r.route("https", "site.test", 443);
    expect(route).toMatchObject({ kind: "http", auth: `Basic ${Buffer.from("u@x:p:w").toString("base64")}`, label: "http://proxy.test:8080" });
    expect(r.label).not.toContain("p%3Aw");
  });

  test("none, an http URL; credentials on the command line and other schemes are refused", () => {
    expect(makeRouter({ kind: "none" }, { https_proxy: "http://x:1" }).route("https", "a", 443)).toEqual({ kind: "direct" });
    expect(makeRouter({ kind: "url", url: "http://p.test:3128" }, {}).label).toBe("http://p.test:3128");
    expect(() => makeRouter({ kind: "url", url: "http://u:secret@p.test:3128" }, {})).toThrow(/credentials never go on the command line/);
    expect(() => makeRouter({ kind: "url", url: "socks5://p.test:1080" }, {})).toThrow(/socks5:\/\/ upstream proxies are not supported/);
    expect(() => makeRouter({ kind: "env" }, { https_proxy: "https://p.test:443" })).toThrow(/https:\/\/ upstream proxies are not supported/);
    expect(parseProxyUrl("p.test:3128", "x", false)).toMatchObject({ kind: "http", host: "p.test", port: 3128 });
  });
});

describe("childEnv", () => {
  test("both cases of the proxy variables, no ALL_PROXY, empty NO_PROXY, the CA variables, the TABCAP_* pair; the rest kept", () => {
    const env = childEnv({ PATH: "/bin", https_proxy: "http://sys:6152", no_proxy: "127.0.0.1", ALL_PROXY: "socks5://x", all_proxy: "socks5://y", SSL_CERT_FILE: "/old" }, "http://127.0.0.1:9", "/tmp/ca.pem");
    for (const k of PROXY_VARS) expect(env[k]).toBe("http://127.0.0.1:9");
    for (const k of CA_VARS) expect(env[k]).toBe("/tmp/ca.pem");
    expect(env["NO_PROXY"]).toBe("");
    expect(env["no_proxy"]).toBe("");
    expect("ALL_PROXY" in env || "all_proxy" in env).toBe(false);
    expect(env["TABCAP_RECORD_PROXY"]).toBe("http://127.0.0.1:9");
    expect(env["TABCAP_CA_FILE"]).toBe("/tmp/ca.pem");
    expect(env["PATH"]).toBe("/bin");
  });
});
