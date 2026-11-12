// docs/04 §53.8: the pure parts of `fetch --like` (fetch/like.ts) and the CLI's request shape.

import { describe, expect, test } from "bun:test";
import { fillTemplate, isAuthHeader, likeSource, parseStorageTemplate, queryPair, resendHeaders, withHeaders, withQuery } from "../../src/daemon/fetch/like.ts";
import { fetchArgs } from "../../src/cli/fetch.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TabcapError ? e.code : "other";
  }
};

describe("recorded headers a page fetch() sends again", () => {
  test("forbidden and connection headers, cookies, pseudo-headers and tabcap's marker drop out; repeated values join", () => {
    const h = resendHeaders({
      ":authority": "x",
      Accept: "application/json",
      Authorization: "Bearer old",
      Cookie: "sid=1",
      "Content-Type": "application/json",
      "Content-Length": "12",
      Origin: "http://x",
      Referer: "http://x/a",
      "User-Agent": "UA",
      "sec-ch-ua": "z",
      "X-Token": "t",
      "x-tabcap-fetch": "c-1:f-1",
      "X-Multi": ["a", "b"],
      "X-Bad": "a\r\nb",
    });
    expect(h).toEqual([
      ["Accept", "application/json"],
      ["Authorization", "Bearer old"],
      ["Content-Type", "application/json"],
      ["X-Token", "t"],
      ["X-Multi", "a, b"],
    ]);
    expect(resendHeaders(null)).toEqual([]);
  });
  test("authentication headers: authorization, tokens, api keys; never cookies or content-type", () => {
    for (const n of ["Authorization", "x-auth-token", "X-API-Key", "token"]) expect(isAuthHeader(n)).toBe(true);
    for (const n of ["Cookie", "content-type", "accept"]) expect(isAuthHeader(n)).toBe(false);
  });
  test("withHeaders replaces case-insensitively, keeps the recorded name, adds new ones", () => {
    expect(withHeaders([["Authorization", "old"], ["Accept", "*/*"]], [["authorization", "new"], ["X-New", "1"]])).toEqual([
      ["Authorization", "new"],
      ["Accept", "*/*"],
      ["X-New", "1"],
    ]);
  });
});

describe("--query", () => {
  test("sets, adds and removes (k=)", () => {
    expect(withQuery("http://h/api/list?page=1&size=10", [["page", "2"], ["size", ""], ["q", "a b"]])).toBe("http://h/api/list?page=2&q=a+b");
    expect(withQuery("http://h/x", [])).toBe("http://h/x");
  });
  test("a pair without = is a usage error", () => {
    expect(queryPair("page=2")).toEqual(["page", "2"]);
    expect(queryPair("k=")).toEqual(["k", ""]);
    expect(code(() => queryPair("page"))).toBe("usage");
  });
});

describe("--header-from-storage templates", () => {
  test("local, session and local-at-session reads; text around them kept", () => {
    const t = parseStorageTemplate("Authorization=Bearer {local:@session:singleId}");
    expect(t).toEqual({ name: "Authorization", parts: ["Bearer ", { store: "local", key: "singleId", via: "session" }] });
    const u = parseStorageTemplate("X-Acct={session:acct}/{local:k}");
    expect(u.parts).toEqual([{ store: "session", key: "acct", via: null }, "/", { store: "local", key: "k", via: null }]);
    expect(fillTemplate(u, ["A", "tok"])).toBe("A/tok");
  });
  test("malformed templates are usage errors", () => {
    for (const bad of ["Bearer {local:k}", "=x {local:k}", "Authorization=Bearer", "A={local:}", "A={session:@session:k}", "A={local:k}}", "Bad Name={local:k}"]) {
      expect(code(() => parseStorageTemplate(bad))).toBe("usage");
    }
  });
});

describe("likeSource", () => {
  test("inline and stored request bodies; a body that was not recorded", () => {
    const ev = { kind: "request", id: "r-3", tab: "t1", method: "POST", url: "http://h/api", request: { headers: { a: "1" }, postData: { inline: '{"acct":"A"}' } } };
    expect(likeSource(ev, () => null)).toEqual({ id: "r-3", tab: "t1", method: "POST", url: "http://h/api", headers: { a: "1" }, body: '{"acct":"A"}', bodyMissing: false });
    const blob = { ...ev, request: { postData: { blob: "sha" } } };
    expect(likeSource(blob, (b) => (b === "sha" ? "big" : null))?.body).toBe("big");
    expect(likeSource(blob, () => null)?.bodyMissing).toBe(true);
    expect(likeSource({ id: "r-1" }, () => null)).toBeNull();
  });
});

describe("CLI: fetch --like", () => {
  test("--like instead of <url>, with --query and --header-from-storage passed on as given", () => {
    expect(fetchArgs({ like: "r-31", query: ["page=2"], headerFromStorage: ["Authorization=Bearer {local:k}"], json: '{"acct":"B"}', tab: "t3" }, "/")).toEqual({
      like: "r-31",
      query: ["page=2"],
      headerFromStorage: ["Authorization=Bearer {local:k}"],
      json: { acct: "B" },
      tab: "t3",
    });
  });
  test("both <url> and --like, or neither: usage", () => {
    expect(code(() => fetchArgs({ like: "r-1", url: "/x" }, "/"))).toBe("usage");
    expect(code(() => fetchArgs({}, "/"))).toBe("usage");
    expect(code(() => fetchArgs({ batch: "f.jsonl", like: "r-1" }, "/", () => '{"url":"/x"}'))).toBe("usage");
  });
});
