// One-off: capture real Accessibility.getFullAXTree results from the e2e site
// into fixtures/ax/ (oracle for the L0 AX filter tests). Run by hand:
//   TABCAP_CHROME=<Chrome for Testing binary> bun test/e2e/capture-ax-fixtures.ts
// Also records which backend ids DOM.describeNode reports as type=password.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectTransport } from "../../src/daemon/transport/direct/index.ts";
import { confirmState, startReadyWait } from "../../src/daemon/transport/direct/ready.ts";
import { isRecord } from "../../src/shared/json.ts";
import { startSite } from "./site.ts";

const exe = process.env["TABCAP_CHROME"];
if (exe === undefined) throw new Error("set TABCAP_CHROME");
const site = startSite();
const home = mkdtempSync(join(tmpdir(), "tabcap-ax-"));
const t = await DirectTransport.start({ executable: exe, profileDir: join(home, "profile"), logFile: join(home, "chrome.log"), proxy: { kind: "none" }, webdriver: "hidden", custom: { add: [], drop: [] }, extensionDir: null, noStartupWindow: true, restoreFront: true });
try {
  const r = await t.send("Target.createTarget", { url: "about:blank", background: true });
  const targetId = String(r["targetId"]);
  const { sessionId } = await t.waitAttached(targetId, 5000);
  const w = startReadyWait(t, sessionId, targetId, site.origin + "/");
  const nav = await t.send("Page.navigate", { url: site.origin + "/" }, sessionId);
  w.tracker.setLoaderId(typeof nav["loaderId"] === "string" ? nav["loaderId"] : null);
  await w.done(10_000);
  await confirmState(t, sessionId, 5000);
  await Bun.sleep(300); // let the XHR fill #items
  const capture = async (name: string) => {
    const ax = await t.send("Accessibility.getFullAXTree", {}, sessionId);
    const pw: number[] = [];
    for (const n of Array.isArray(ax["nodes"]) ? ax["nodes"] : []) {
      if (!isRecord(n) || typeof n["backendDOMNodeId"] !== "number") continue;
      const d = await t.send("DOM.describeNode", { backendNodeId: n["backendDOMNodeId"] }, sessionId).catch(() => null);
      const node = d !== null && isRecord(d["node"]) ? d["node"] : null;
      const attrs = node !== null && Array.isArray(node["attributes"]) ? node["attributes"] : [];
      for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === "type" && attrs[i + 1] === "password") pw.push(n["backendDOMNodeId"]);
    }
    const text = JSON.stringify({ capturedWith: "Chrome for Testing " + t.version.product, page: "test/e2e/site.ts /", passwordBackendIds: pw, ax }, null, 1) + "\n";
    writeFileSync(join(import.meta.dir, "..", "..", "fixtures", "ax", `${name}.json`), text.split(site.origin).join("http://127.0.0.1:PORT"));
  };
  await capture("home");
  await t.send("Runtime.evaluate", { expression: `document.getElementById("name").value = "bob"; document.getElementById("pw").value = "fixture-pass-1"; document.getElementById("agree").checked = true;` }, sessionId);
  await capture("home-filled");
} finally {
  await t.shutdown();
  site.stop();
  rmSync(home, { recursive: true, force: true });
}
