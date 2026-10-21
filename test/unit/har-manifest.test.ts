// HAR `--embed-events` round trip with the manifest (review 10-21, owner
// decision; docs/04 §9.1 / §9.3): the export puts the whole manifest (the
// redacted one when the export is redacted) into `log._manifest`; the import
// restores it next to `log._events`, so mode, record, producer.browser, the
// session and trace windows survive instead of being rebuilt as defaults
// (humanRecorder:false, no record = all bodies, browser name / version only).
// What the imported bundle cannot have stays honest: no raw/ (mode.raw false,
// "raw" in lossy when the source had it), blobs HAR does not carry are listed.
// A HAR without `_manifest` imports as before. Oracle: the source manifest.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHar, importHar, type HarDocument } from "../../src/bundle/har.ts";
import { BundleReader, type BundleView } from "../../src/bundle/reader.ts";
import type { Manifest } from "../../src/bundle/types.ts";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { buildRichBundle } from "./_fixtures.ts";

const tmp = (p = "tabcap-harm-") => mkdtempSync(join(tmpdir(), p));
const viaJson = (har: HarDocument): unknown => JSON.parse(JSON.stringify(har));

/** The rich fixture with the manifest fields a recording of 0.6-I … 0.8.1 carries. */
async function source(): Promise<BundleView> {
  const dir = tmp("tabcap-harm-src-");
  await buildRichBundle(dir);
  const r = BundleReader.open(dir);
  const manifest: Manifest = {
    ...structuredClone(r.manifest),
    producer: {
      ...r.manifest.producer,
      browser: { name: "Chrome", version: "155.0.8059.41", userAgent: "UA", webdriver: "visible", args: ["--user-data-dir=<profile>", "--remote-debugging-pipe", "--lang=de"], extraArgs: ["--lang=de"], dropArgs: ["--disable-sync"] },
    },
    mode: { capture: "mixed", trace: false, raw: true, humanRecorder: true },
    record: { bodies: "api" },
    traceWindows: [{ fromSeq: 2, toSeq: null }],
    notes: "kept",
  };
  return { manifest, events: r.events, readBlob: (ref) => r.readBlob(ref) };
}

/** The manifest fields a round trip keeps (counts are recomputed, imported is the import's own). */
function kept(m: Manifest): Record<string, unknown> {
  const c: Record<string, unknown> = { ...structuredClone(m), mode: { ...m.mode, raw: "<raw>" } };
  for (const k of ["counts", "imported", "redaction"]) delete c[k];
  return c;
}

describe("bundle -> HAR (--embed-events) -> bundle keeps the manifest", () => {
  test("unredacted: every field equal but counts, imported and mode.raw; lossy names raw (and blobs), not manifest", async () => {
    const src = await source();
    const { har } = exportHar(src, { embedEvents: true });
    expect(isRecord(har.log._manifest)).toBe(true);
    const out = tmp();
    const res = await importHar(viaJson(har), out);
    const back = BundleReader.open(out).manifest;
    expect(kept(back)).toEqual(kept(src.manifest));
    expect(back.mode.raw).toBe(false); // the imported bundle has no raw/cdp.jsonl
    expect(back.mode.humanRecorder).toBe(true);
    expect(back.record).toEqual({ bodies: "api" });
    expect(back.producer.browser).toEqual(src.manifest.producer.browser);
    expect(back.finished).toBe(src.manifest.finished);
    expect(res.lossy).not.toContain("manifest");
    expect(res.lossy).toContain("raw");
    expect(back.imported).toEqual({ from: "har", creator: { name: "tabcap", version: "0.1.0" }, lossy: res.lossy });
  });

  test("redacted export: _manifest is the redacted manifest (redaction rules, masked first URL) and comes back as it is", async () => {
    const src = await source();
    const { har } = exportHar(src, { embedEvents: true, redact: { salt: "s" }, now: () => 42 });
    const m = har.log._manifest;
    if (!isRecord(m)) throw new Error("no _manifest");
    expect(m["redaction"]).toEqual({ rules: "default@3", applied: 42 });
    expect(JSON.stringify(m)).not.toContain(String(src.manifest.session.tabs[0]?.firstUrl));
    const out = tmp();
    await importHar(viaJson(har), out);
    const back = BundleReader.open(out).manifest;
    expect(back.redaction).toEqual({ rules: "default@3", applied: 42 });
    expect(back.session.tabs[0]?.firstUrl).toBe(isRecord(m["session"]) && Array.isArray(m["session"]["tabs"]) && isRecord(m["session"]["tabs"][0]) ? m["session"]["tabs"][0]["firstUrl"] : "?");
    expect(back.mode.humanRecorder).toBe(true);
  });

  test("without --embed-events there is no _manifest; a HAR with _events but no _manifest imports as before", async () => {
    const src = await source();
    expect(exportHar(src).har.log._manifest).toBeUndefined();
    const { har } = exportHar(src, { embedEvents: true });
    delete har.log._manifest;
    const out = tmp();
    const res = await importHar(viaJson(har), out);
    expect(res.lossy).toContain("manifest");
    const back = BundleReader.open(out).manifest;
    expect(back.mode.humanRecorder).toBe(false);
    expect(back.record).toBeUndefined();
  });

  test("a malformed _manifest is bad-input before anything is written", async () => {
    const src = await source();
    const { har } = exportHar(src, { embedEvents: true });
    for (const bad of ["x", { format: "evidence-bundle/0" }, { ...src.manifest, format: "evidence-bundle/9" }]) {
      const doc = viaJson(har);
      if (!isRecord(doc) || !isRecord(doc["log"])) throw new Error("bad HAR");
      doc["log"]["_manifest"] = bad;
      const out = tmp();
      let code: string | null = null;
      try {
        await importHar(doc, out);
      } catch (e) {
        code = e instanceof TabcapError ? e.code : String(e);
      }
      expect(code === "bad-input" || code === "unsupported").toBe(true);
      expect(readdirSync(out)).toEqual([]);
    }
  });
});
