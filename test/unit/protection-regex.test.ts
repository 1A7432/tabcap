// User protection rules (docs/04 §41.1): their regexes run in the daemon on
// page-controlled text (cookie values, resource and frame URLs, challenge
// text). Besides the 512-character limit, a regex with an obvious nested
// unbounded quantifier — a group whose match can end in an unbounded repeat and
// which is itself repeated without bound, like (a+)+ or (.*)* — is refused
// (review 10-21, owner decision), so a page cannot stall the daemon by
// catastrophic backtracking; a group whose iterations end in a required atom,
// such as the subdomain pattern ([a-z0-9-]+\.)* of the built-ins, is fine. A refused user file is skipped with a warning (loadFamilies);
// every built-in family passes the same check. Not a complete ReDoS
// detector: overlapping alternatives such as (a|aa)+ are not caught.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinFamilies, loadFamilies } from "../../src/analyze/protection/registry.ts";
import { nestedQuantifier, parseFamily } from "../../src/analyze/protection/rules.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const family = (url: string) => ({ schema: "tabcap-protection/0", id: "t", name: "T", vendor: "V", category: "anti-bot", version: 1, rules: [{ id: "a", kind: "request", url, confidence: 50, note: "n" }] });

describe("nested unbounded quantifiers", () => {
  test("refused: a repeated group that repeats something unbounded", () => {
    for (const re of ["(a+)+", "(.*)*", "(a*)+$", "^(\\w+\\s?)*$", "(?:x|y+)*", "(a+){2,}", "(a+?)+", "([a-z]+)+", "(a{1,})*", "((a+))+", "(?:(b|c+)d?)+"]) expect([re, nestedQuantifier(re)]).toEqual([re, true]);
  });

  test("allowed: single quantifiers, bounded outer repeats, escaped or classed parentheses", () => {
    for (const re of ["(ab)+", "(a+)", "a+b*", "(a+)?", "(a+){2}", "(a+){1,3}", "[(a+)]+", "\\(a+\\)+", "^https://[^/]+/tags\\.js$", "(abc|def)+", "\\d{4}-\\d{2}", "(a)(b+)", "^https?://([a-z0-9-]+\\.)*captcha-delivery\\.com(?::\\d+)?/", "((ab)+c)+", "(a+b)+"]) expect([re, nestedQuantifier(re)]).toEqual([re, false]);
  });

  test("parseFamily answers bad-input naming the field; loadFamilies skips that user file with a warning; built-ins all pass", () => {
    let err: unknown = null;
    try {
      parseFamily(family("(a+)+$"), "user.json", false);
    } catch (e) {
      err = e;
    }
    expect(err instanceof TabcapError && err.code).toBe("bad-input");
    expect(err instanceof Error ? err.message : "").toContain("rules[0].url");
    expect(err instanceof Error ? err.message : "").toContain("nested");
    const dir = mkdtempSync(join(tmpdir(), "tabcap-pregex-"));
    writeFileSync(join(dir, "slow.json"), JSON.stringify({ ...family("(.*)*"), id: "slow" }));
    const loaded = loadFamilies(dir);
    expect(loaded.families.some((f) => f.id === "slow")).toBe(false);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("slow.json skipped");
    expect(loaded.warnings[0]).toContain("nested");
    expect(builtinFamilies().length).toBeGreaterThan(40);
  });
});
