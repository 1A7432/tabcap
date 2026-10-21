// `analyze chain --text` honours --reveal like the JSON answer (docs/04 §8.3,
// 0.7.3: the offline analysis outputs are redacted by name, `--reveal` prints
// the recorded values). Expected values: the URL planted in the bundle and the
// JSON answer of the same command.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderChainText } from "../../src/analyze/chain.ts";
import { run } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { buildBundle, tmp } from "./_analyze.ts";

const URL_ = "https://sso.example.test/app/return?access_token=ST-77-secret&lang=zh";

const stepUrl = (data: unknown): string => {
  const steps = isRecord(data) && Array.isArray(data["steps"]) ? data["steps"] : [];
  const s = steps[0];
  return isRecord(s) && typeof s["url"] === "string" ? s["url"] : "";
};

describe("analyze chain --text and --reveal", () => {
  test("--text --reveal prints the recorded URL, as the JSON answer does; without --reveal text and JSON show the same placeholder", async () => {
    const b = await buildBundle(join(tmp("tabcap-chain-rv-"), "b"), { name: "chain-rv", created: 1760600000000, seed: 32 }, async (bb) => {
      await bb.request({ url: URL_, ts: 1760600000100, mime: "application/json", body: "{}" });
    });

    const revealed = await run(["analyze", "chain", b, "--text", "--reveal"]);
    expect(revealed.code).toBe(0);
    if (!revealed.envelope.ok) throw new Error(revealed.envelope.error.message);
    expect(stepUrl(revealed.envelope.data)).toBe(URL_);
    expect(revealed.text).toContain(URL_);
    expect(revealed.text).not.toContain("<redacted:");

    const plain = await run(["analyze", "chain", b, "--text"]);
    if (!plain.envelope.ok) throw new Error(plain.envelope.error.message);
    const masked = stepUrl(plain.envelope.data);
    expect(masked).toMatch(/access_token=<redacted:[0-9a-f]{8}>&lang=zh$/);
    expect(plain.text).toContain(masked);
    expect(plain.text).not.toContain("ST-77-secret");
  });

  test("renderChainText with reveal leaves a recorded URL as it is", () => {
    const res = { schema: "tabcap-chain/0" as const, bundle: "./b", target: "r-2", steps: [{ id: "r-2", method: "GET", url: URL_, provides: [], needs: [] }], todo: [], inputs: [], warnings: [] };
    expect(renderChainText(res, { reveal: true })).toContain(`r-2 GET ${URL_}`);
  });
});
