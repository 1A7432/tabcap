// tabcap recon: the recon dossier v0 for the session (docs/09 §1; owner
// decision 2026-10-16: four questions, exports/dossier.json + .md, no --probe
// in 0.4). The dossier itself is src/analyze/recon.ts (pure, shared with
// `analyze recon`); this tool reads the current page (visible text, title,
// adapter detect results) and finds the session's recording. It reads the
// bundle written so far (events flushed first, like `where`) and never sends
// a request: the page reads are Runtime.evaluate (body.innerText, title) and
// the adapters' read-only detect. Its only writes are the two files under the
// bundle's exports/ directory, both passed through known-secret replacement.
// 0.6-E: URLs in the answer and the dossier (the page, guard detections) show
// sensitive query parameters as <redacted:name> unless --reveal (docs/04 §8.3).

import { join } from "node:path";
import { loadFamilies } from "../../analyze/protection/registry.ts";
import { BundleReader } from "../../bundle/reader.ts";
import type { RequestEvent } from "../../bundle/types.ts";
import { buildDossier, pageOf, reconOutput, writeDossier, type AdapterDetection, type ReconPage, recordedPage } from "../../analyze/recon.ts";
import { redactDossier, type DossierMask } from "../../analyze/redact.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { builtinAdapters } from "../adapters/registry.ts";
import { runDetect } from "../adapters/runtime.ts";
import { rootDoc } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import type { Args } from "./args.ts";
import { redactHeaderValue, redactUrl, revealOf, type LiveCtx } from "./liveredact.ts";
import { timeoutOf } from "./navigate.ts";
import { callResult, docIdentity } from "../browser/doc.ts";

/** Visible text read from the page (characters). */
const MAX_PAGE_TEXT = 1_000_000;
const PAGE_EXPR = `(() => { const b = document.body; return { title: String(document.title || ""), text: b ? String(b.innerText).slice(0, ${MAX_PAGE_TEXT}) : "" }; })()`;

/** The recorded main-document response headers for a URL (adapters' header features), flattened. */
function docHeaders(reqs: readonly RequestEvent[], url: string): Record<string, string> | null {
  const doc = [...reqs].reverse().find((r) => r.type === "document" && r.url === url && r.response !== null);
  if (doc === undefined || doc.response === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.response.headers)) out[k.toLowerCase()] = typeof v === "string" ? v : v.join(", ");
  return out;
}

/** The live mask for redactDossier (analyze/redact.ts): page and guard URLs, stack header values as `<redacted:name>`. */
export function liveDossierMask(c: LiveCtx): DossierMask {
  return { url: (u) => redactUrl(u, c), header: (n, v) => redactHeaderValue(n, v, c) };
}

async function livePage(d: Daemon, session: string, a: Args, reader: BundleReader): Promise<ReconPage> {
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, null);
  return tabs.run(
    tab,
    async () => {
      const doc = await docIdentity(t, tab);
      const v = callResult(await t.send("Runtime.evaluate", { expression: PAGE_EXPR, returnByValue: true }, tab.sessionId, 10_000));
      const o = isRecord(v) ? v : {};
      let adapters: AdapterDetection[] | null = null;
      try {
        adapters = (await runDetect(t, tab, rootDoc(tab, doc), builtinAdapters(), docHeaders(reader.requests(), doc.url))).map((x) => ({ adapter: x.adapter, category: x.category, confidence: x.confidence, evidence: x.evidence }));
      } catch {
        adapters = null;
      }
      return pageOf(doc.url, o["title"], o["text"], adapters);
    },
    { timeoutMs: timeoutOf(a) },
  );
}

export async function recon(d: Daemon, a: Args, session: string): Promise<unknown> {
  const live = d.recorders.get(session);
  const rec = live ?? d.lastBundles.get(session);
  if (rec === undefined) throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start`, use the site (or load the pages you care about), then `tabcap recon`.");
  if (live !== undefined) await live.flushEvents();
  const reader = BundleReader.open(rec.dir);
  const warnings: string[] = [];
  let page: ReconPage;
  try {
    page = await livePage(d, session, a, reader);
    if (page.adapters === null) warnings.push("adapter detection failed on the current page; the stack lists header and cookie hints only");
  } catch (e) {
    warnings.push(`no current page (${e instanceof Error ? e.message : String(e)})`);
    page = recordedPage(reader);
  }
  // 0.8-A: built-in protection families plus config/protection/ (docs/04 §41.1)
  const loaded = loadFamilies(join(d.paths.config, "protection"));
  warnings.push(...loaded.warnings);
  const built = buildDossier(reader, page, { session, warnings, families: loaded.families });
  const dossier = revealOf(a) ? built : redactDossier(built, liveDossierMask({ scrub: (s) => d.secrets.scrub(s) }));
  const paths = writeDossier(rec.dir, dossier, (s) => d.secrets.scrub(s));
  return reconOutput(dossier, paths);
}
