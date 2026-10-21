// One sensitive-header test for every path (review 2026-10-21, owner: all as
// proposed): the `bundle redact` header set and name parts, the name rule
// (isSensitiveName) and the session-export extras (x-csrf*, x-xsrf*, *-token,
// *-auth*, *api-key) decide together. Export redaction (Redactor.headerValue),
// live output (liveredact), offline analysis (AnalyzeRedactor), session export (headerClass) and the decode
// plugins' withheld headers must reach the same conclusion for a header name.
// Oracle: docs/04 §8 (header rule) as worded for default@3.

import { describe, expect, test } from "bun:test";
import { Redactor, isSensitiveHeaderName } from "../../src/bundle/redact.ts";
import { selectedHeaders } from "../../src/daemon/hooks/decode.ts";
import { redactHeaderValue } from "../../src/daemon/tools/liveredact.ts";
import { headerClass, type HeaderClass } from "../../src/daemon/tools/sessionexport.ts";
import { AnalyzeRedactor } from "../../src/analyze/redact.ts";

const VALUE = "k=v-123456";
const plain = { scrub: (s: string) => s };

/** name → [sensitive, session-export class] */
const TABLE: [string, boolean, HeaderClass][] = [
  ["cookie", true, "cookie"],
  ["set-cookie", true, "cookie"],
  ["authorization", true, "sensitive"],
  ["proxy-authorization", true, "proxy"],
  ["x-api-key", true, "sensitive"],
  ["apikey", true, "sensitive"],
  ["api_key", true, "sensitive"],
  ["x-sid", true, "sensitive"],
  ["x-password", true, "sensitive"],
  ["x-user-pwd", true, "sensitive"],
  ["x-csrf", true, "sensitive"],
  ["x-csrf-token", true, "sensitive"],
  ["x-xsrf-token", true, "sensitive"],
  ["x-auth-token", true, "sensitive"],
  ["access-token", true, "sensitive"],
  ["x-session-id", true, "sensitive"],
  ["X-Api-Key", true, "sensitive"],
  ["content-type", false, "browser"],
  ["user-agent", false, "browser"],
  ["accept", false, "browser"],
  ["referer", false, "browser"],
  ["x-trace", false, "page"],
  ["x-requested-with", false, "page"],
];

describe("sensitive header names: one test, every path", () => {
  test.each(TABLE)("%s", (name, sensitive, sessionClass) => {
    expect(isSensitiveHeaderName(name)).toBe(sensitive);
    const exported = new Redactor("salt").headerValue(name, VALUE);
    const live = redactHeaderValue(name, VALUE, plain);
    const analyzed = new AnalyzeRedactor().header(name, VALUE);
    const toPlugin = Object.keys(selectedHeaders({ [name]: VALUE }, (s) => s));
    expect({ exportMasked: !exported.includes("v-123456"), liveMasked: !live.includes("v-123456"), analyzeMasked: !analyzed.includes("v-123456"), withheldFromDecode: toPlugin.length === 0 }).toEqual({
      exportMasked: sensitive,
      liveMasked: sensitive,
      analyzeMasked: sensitive,
      withheldFromDecode: sensitive,
    });
    expect(headerClass(name)).toBe(sessionClass);
    // session export keeps a header for the script exactly when it is sensitive or the page's own
    if (sensitive && sessionClass !== "cookie" && sessionClass !== "proxy") expect(headerClass(name)).toBe("sensitive");
  });
});
