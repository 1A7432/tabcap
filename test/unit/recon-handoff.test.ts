// recon's guard detections pair a breaker with the handoff of the same reason
// (docs/04 §4.2 handoff / guard rows, §26 0.6-A, §37): a `fetch-stop` breaker
// never puts the session into `waiting`, and a human take-over writes a
// `handoff` with reason `human-takeover` and no breaker. A take-over later in
// the bundle is therefore not "what the fetch stop handed to the human".
// Expected values come from the events each synthetic bundle plants.

import { describe, expect, test } from "bun:test";
import { BundleReader } from "../../src/bundle/reader.ts";
import { buildDossier, type ReconPage } from "../../src/analyze/recon.ts";
import { buildBundle, idOf, tmp } from "./_analyze.ts";

const O = "http://127.0.0.1:4310";
const C = 1760800000000;
const live: ReconPage = { url: `${O}/`, title: "x", text: "", source: "live", adapters: [] };
const sys = (ts: number) => ({ actor: "system" as const, tab: "t1", cmd: null, ts, mono: null });

const guardEntries = (dir: string) => buildDossier(BundleReader.open(dir), live).protection.filter((p) => p.source === "guard");

describe("recon: breaker and handoff pairing by reason", () => {
  test("a fetch-stop breaker followed by a human take-over: the take-over is not the fetch stop's handoff", async () => {
    const dir = tmp("tabcap-recon-ho-");
    let stopped = "";
    await buildBundle(dir, { name: "ho", created: C, seed: 41 }, async (b) => {
      stopped = idOf(await b.request({ url: `${O}/api/list`, type: "fetch", status: 500, mime: "application/json", body: "{}", ts: C + 100 }));
      b.w.append({ ...sys(C + 110), kind: "guard", event: "breaker", site: "shop", account: null, reason: "fetch-stop", rule: "status>=400", request: stopped, detail: { reason: "fetch-stop", rule: "status>=400", detail: "status 500", request: stopped, fetchId: "c-1:0", url: `${O}/api/list`, status: 500 } });
      b.w.append({ ...sys(C + 200), kind: "handoff", state: "waiting", reason: "human-takeover", question: "You are using the AI's tab; when you are done, tell the AI to continue (`tabcap handoff continue`).", timeoutMs: null, answerRef: null, request: null, url: `${O}/`, screenshot: null, input: { event: "pointerdown", at: C + 199 } });
      b.w.append({ ...sys(C + 300), kind: "handoff", state: "resumed", reason: "human-takeover", question: null, timeoutMs: null, answerRef: null, by: "condition", condition: { kind: "url", value: "/home" } });
    });
    expect(guardEntries(dir)).toEqual([{ source: "guard", kind: "fetch-stop", request: stopped, url: `${O}/api/list`, status: 500, handedToHuman: null, resumedBy: null, grade: "实测" }]);
  });

  test("a verify-page breaker keeps its own handoff and resume; a later take-over does not replace them", async () => {
    const dir = tmp("tabcap-recon-ho-");
    let wall = "";
    await buildBundle(dir, { name: "ho2", created: C, seed: 42 }, async (b) => {
      wall = idOf(await b.request({ url: `${O}/api/limited`, type: "fetch", status: 403, mime: "text/html", body: "<h2>verify</h2>", ts: C + 100 }));
      b.w.append({ ...sys(C + 110), kind: "guard", event: "breaker", site: null, account: null, detail: { reason: "verify-page", request: wall, url: `${O}/api/limited`, status: 403, mime: "text/html" } });
      b.w.append({ ...sys(C + 120), kind: "handoff", state: "waiting", reason: "verify-page", question: "Complete the verification in the browser, then tell the AI to continue.", timeoutMs: null, answerRef: null, request: wall, url: `${O}/api/limited`, screenshot: "/tmp/shot.png" });
      b.w.append({ ...sys(C + 130), kind: "handoff", state: "resumed", reason: "verify-page", question: null, timeoutMs: null, answerRef: null, by: "plugin:solver-free" });
      b.w.append({ ...sys(C + 200), kind: "handoff", state: "waiting", reason: "human-takeover", question: "taken over", timeoutMs: null, answerRef: null, request: null, url: `${O}/`, screenshot: null, input: { event: "keydown", at: C + 199 } });
      b.w.append({ ...sys(C + 300), kind: "handoff", state: "resumed", reason: "human-takeover", question: null, timeoutMs: null, answerRef: null, by: "human" });
    });
    expect(guardEntries(dir)).toEqual([
      { source: "guard", kind: "verify-page", request: wall, url: `${O}/api/limited`, status: 403, handedToHuman: { question: "Complete the verification in the browser, then tell the AI to continue.", screenshot: "/tmp/shot.png" }, resumedBy: "plugin:solver-free", grade: "实测" },
    ]);
  });

  test("a stop-rule breaker pairs with its stop-rule handoff (resumed by guard resume)", async () => {
    const dir = tmp("tabcap-recon-ho-");
    let r = "";
    await buildBundle(dir, { name: "ho3", created: C, seed: 43 }, async (b) => {
      r = idOf(await b.request({ url: `${O}/api/page?n=21`, type: "fetch", status: 200, mime: "application/json", body: '{"code":203}', ts: C + 100 }));
      b.w.append({ ...sys(C + 110), kind: "guard", event: "breaker", site: "shop", account: null, reason: "stop-rule", rule: "json:$.code!=0", request: r, detail: { reason: "stop-rule", rule: "json:$.code!=0", detail: "$.code is 203", request: r, url: `${O}/api/page?n=21`, status: 200 } });
      b.w.append({ ...sys(C + 120), kind: "handoff", state: "waiting", reason: "stop-rule", question: "look at it", timeoutMs: null, answerRef: null, request: r, url: `${O}/api/page?n=21`, screenshot: "/tmp/s.png" });
      b.w.append({ ...sys(C + 130), kind: "handoff", state: "resumed", reason: "stop-rule", question: null, timeoutMs: null, answerRef: null, by: "guard-resume" });
    });
    expect(guardEntries(dir)).toEqual([{ source: "guard", kind: "stop-rule", request: r, url: `${O}/api/page?n=21`, status: 200, handedToHuman: { question: "look at it", screenshot: "/tmp/s.png" }, resumedBy: "guard-resume", grade: "实测" }]);
  });
});
