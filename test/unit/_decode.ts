// Shared fixtures for the 0.6-B decode plugin tests: the range plugin
// installed into a test config directory, and the s42 flow (test/e2e/site.ts
// plaintexts, encoded the site's way) as a bundle recorded without a plugin.

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setEnabled } from "../../src/daemon/hooks/plugins.ts";
import { S42_ITEMS_JSON, S42_ORDER_JSON, S42_POST_JSON, S42_TOKEN, S42_TOKEN_JSON, xorEncode } from "../e2e/site.ts";
import { buildBundle } from "./_analyze.ts";

export const XOR_PLUGIN = join(import.meta.dir, "..", "e2e", "plugins", "xor-decode");
export const S42_ORIGIN = "http://127.0.0.1:4342";
const C = 1760600000000;

/** Copy the range plugin into `<config>/plugins/xor-decode` and enable it. */
export function installXor(config: string, enable = true): void {
  mkdirSync(join(config, "plugins"), { recursive: true, mode: 0o700 });
  cpSync(XOR_PLUGIN, join(config, "plugins", "xor-decode"), { recursive: true });
  if (enable) setEnabled(config, "xor-decode", true);
}

/** r-2 the page, r-3 token, r-4 items (x-auth), r-5 the order POST (encoded body), as recorded without a plugin. */
export async function s42Bundle(dir: string): Promise<string> {
  return buildBundle(dir, { name: "s42", created: C, seed: 42 }, async (b) => {
    const enc = { "x-enc": "xor" };
    await b.request({ url: `${S42_ORIGIN}/s42`, type: "document", mime: "text/html", body: "<p>s42</p>", ts: C + 1 });
    await b.request({ url: `${S42_ORIGIN}/s42/api/token`, type: "fetch", mime: "text/plain", respHeaders: enc, body: xorEncode(S42_TOKEN_JSON), ts: C + 10 });
    await b.request({ url: `${S42_ORIGIN}/s42/api/items`, type: "fetch", mime: "text/plain", reqHeaders: { "x-auth": S42_TOKEN }, respHeaders: enc, body: xorEncode(S42_ITEMS_JSON), ts: C + 20 });
    await b.request({
      url: `${S42_ORIGIN}/s42/api/order`,
      method: "POST",
      type: "fetch",
      mime: "text/plain",
      reqHeaders: { "content-type": "text/plain", "x-enc": "xor", "x-auth": S42_TOKEN },
      postData: xorEncode(S42_POST_JSON),
      respHeaders: enc,
      body: xorEncode(S42_ORDER_JSON),
      ts: C + 30,
    });
  });
}
