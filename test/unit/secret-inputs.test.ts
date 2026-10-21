// "Secret input" headers in analyze deps and replay export-python (review
// 10-21, owner decision): a header is a secret input when the one
// sensitive-header test (bundle/redact.ts isSensitiveHeaderName, docs/04 §8)
// says so, the same test as export, live output, session export and decode
// plugins. Wider than before for headers: x-csrf* / x-xsrf* without `token` in
// the name count now. Query, form and JSON names keep the name rule only.
// Oracle: docs/04 §8's header rule text.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isCallerInput } from "../../src/analyze/deps.ts";
import { exportPython } from "../../src/replay/python.ts";
import { buildBundle, tmp } from "./_analyze.ts";

const root = tmp("tabcap-secret-inputs-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ORIGIN = "http://127.0.0.1:4310";
const C = 1760700000000;
const XSRF = "xsrf-value-0123456789";

describe("headers by the one sensitive-header test", () => {
  test("analyze deps: an x-csrf / x-xsrf header is never a caller input; the same name in a query still can be", () => {
    for (const n of ["x-csrf", "X-XSRF", "x-xsrf-check", "apikey", "x-sid"]) expect([n, isCallerInput("header", n, [], ["abc"])]).toEqual([n, false]);
    expect(isCallerInput("query", "x-csrf", [], ["abc"])).toBe(true);
    expect(isCallerInput("header", "x-requested-with", [], ["abc"])).toBe(true);
  });

  test("replay export-python: an x-xsrf header is a secret input; its recorded value is written nowhere", async () => {
    const dir = await buildBundle(join(root, "b"), { name: "xsrf", created: C, seed: 22 }, async (b) => {
      await b.request({ url: `${ORIGIN}/api/save`, method: "POST", type: "fetch", mime: "application/json", body: "{}", postData: "{}", reqHeaders: { "content-type": "application/json", "x-xsrf": XSRF }, ts: C + 100 });
    });
    const out = join(root, "py");
    const r = exportPython({ bundle: dir, out, chain: false });
    expect(r.functions.find((f) => f.name === "post_api_save")?.args).toEqual(["x_xsrf"]);
    for (const f of r.files) expect([f, readFileSync(join(out, f), "utf8").includes(XSRF)]).toEqual([f, false]);
  });
});
