// One-off: record what the overlay adapter's page script collects (and the
// detect digest) on the overlay range pages into fixtures/dom/ — the oracle
// input for the L0 detect / describe tests. Run by hand:
//   TABCAP_CHROME=<Chrome for Testing binary> bun test/e2e/capture-dom-fixtures.ts
// Viewport is fixed by the browser window (1280x720 default of a background tab here);
// the files record the size they were taken at.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIGEST_FN, DIGEST_MAX, digestNeeds, globalNames, globalsExpression } from "../../src/daemon/adapters/detect.ts";
import { builtinAdapters } from "../../src/daemon/adapters/registry.ts";
import { DirectTransport } from "../../src/daemon/transport/direct/index.ts";
import { confirmState, startReadyWait } from "../../src/daemon/transport/direct/ready.ts";
import { isRecord } from "../../src/shared/json.ts";
import { OVERLAY_PAGES, startOverlaySite } from "./site.ts";

const exe = process.env["TABCAP_CHROME"];
if (exe === undefined) throw new Error("set TABCAP_CHROME");
const overlay = builtinAdapters().find((a) => a.name === "overlay");
if (overlay === undefined || overlay.script === null) throw new Error("overlay adapter missing");
const site = startOverlaySite();
const home = mkdtempSync(join(tmpdir(), "tabcap-dom-"));
const t = await DirectTransport.start({ executable: exe, profileDir: join(home, "profile"), logFile: join(home, "chrome.log"), proxy: { kind: "none" }, extensionDir: null, noStartupWindow: true, restoreFront: true });
try {
  const r = await t.send("Target.createTarget", { url: "about:blank", background: true });
  const targetId = String(r["targetId"]);
  const { sessionId } = await t.waitAttached(targetId, 5000);
  for (const page of [...OVERLAY_PAGES, "shell"]) {
    const url = `${site.origin}/ov/${page}`;
    const w = startReadyWait(t, sessionId, targetId, url);
    const nav = await t.send("Page.navigate", { url }, sessionId);
    w.tracker.setLoaderId(typeof nav["loaderId"] === "string" ? nav["loaderId"] : null);
    await w.done(10_000);
    await confirmState(t, sessionId, 5000);
    await Bun.sleep(300);
    const tree = await t.send("Page.getFrameTree", {}, sessionId);
    const frameId = isRecord(tree["frameTree"]) && isRecord(tree["frameTree"]["frame"]) ? String(tree["frameTree"]["frame"]["id"]) : "";
    const world = await t.send("Page.createIsolatedWorld", { frameId, worldName: "tabcap-adapters" }, sessionId);
    const contextId = world["executionContextId"];
    const value = async (expression: string, ctx: unknown) => {
      const res = await t.send("Runtime.evaluate", { expression, returnByValue: true, ...(typeof ctx === "number" ? { contextId: ctx } : {}) }, sessionId);
      if (isRecord(res["exceptionDetails"])) throw new Error(`${page}: ${JSON.stringify(res["exceptionDetails"])}`);
      return isRecord(res["result"]) ? res["result"]["value"] : null;
    };
    const collected = await value(`(() => { const A = (\n${overlay.script}\n); return A.collect().data; })()`, contextId);
    const { attrs, tags } = digestNeeds(builtinAdapters());
    const digest = await value(`(${DIGEST_FN})(${JSON.stringify(attrs)}, ${JSON.stringify(tags)}, ${DIGEST_MAX})`, contextId);
    const names = globalNames(builtinAdapters());
    const g = await value(globalsExpression(names), null);
    const globals = Object.fromEntries(names.map((n, i) => [n, Array.isArray(g) && g[i] === true]));
    const text = JSON.stringify({ capturedWith: "Chrome for Testing " + t.version.product, page: `test/e2e/site.ts /ov/${page}`, collected, digest, globals }, null, 1) + "\n";
    writeFileSync(join(import.meta.dir, "..", "..", "fixtures", "dom", `overlay-${page}.json`), text.split(site.origin).join("http://127.0.0.1:PORT"));
    console.log(`captured ${page}`);
  }
} finally {
  await t.shutdown();
  site.stop();
  rmSync(home, { recursive: true, force: true });
}
