// tabcap where <ref|text>: which recorded response carries a value the page
// shows (docs/09 §3.1). The search itself is src/analyze/where.ts (pure);
// this tool resolves the input and finds the session's recording. It reads
// the bundle written so far (events flushed first, like `net show`) and
// never sends a request. --write-findings is its only write: finding events
// through the live recorder, or appended to a finished bundle.

import { appendFindings, type FindingInput, type SavedFindings } from "../../analyze/finding.ts";
import { DEFAULT_TOP, whereFindings, whereIn, type WhereQuery } from "../../analyze/where.ts";
import { BundleReader } from "../../bundle/reader.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { descendants, docOf, frameTree } from "../browser/frames.ts";
import { isRef, sameDoc } from "../browser/refs.ts";
import type { Tab } from "../browser/targets.ts";
import { inWorld, rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Transport } from "../transport/types.ts";
import { scrubValue } from "../secrets.ts";
import type { Daemon } from "../state.ts";
import { optBool, optNum, optStr, reqStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { callResult, docIdentity, resolveRef } from "../browser/doc.ts";

const USAGE = "tabcap where <ref|text> [--as ref|text] [--top n] [--text] [--write-findings]";
/** Visible text of the ref's element, and of the page for date disambiguation (characters). */
const MAX_REF_TEXT = 10_000;
const MAX_PAGE_TEXT = 1_000_000;
const REF_TEXT_FN = `function () { const s = this.nodeType === 1 ? this.innerText : this.textContent; return String(s == null ? "" : s).slice(0, ${MAX_REF_TEXT}); }`;
// The page text of one document of the tab, read in tabcap's isolated world.
const DOC_TEXT_EXPR = `(() => { const b = document.body; return b ? String(b.innerText).slice(0, ${MAX_PAGE_TEXT}) : ""; })()`;

/**
 * The page text `where` disambiguates dates with (0.6-D): the root document
 * and every child frame of the frame tree (0.4-I), in tree order, at most
 * MAX_PAGE_TEXT characters in all. A document that cannot be read is skipped.
 */
async function tabText(t: Transport, tab: Tab): Promise<string> {
  const docs: FrameDoc[] = [rootDoc(tab, await docIdentity(t, tab))];
  const tree = await frameTree(t, tab).catch(() => null);
  if (tree !== null) docs.push(...descendants(tree.root).map(docOf));
  const parts: string[] = [];
  let left = MAX_PAGE_TEXT;
  for (const doc of docs) {
    if (left <= 0) break;
    const v = await inWorld(t, tab, doc, async (ctx) => callResult(await t.send("Runtime.evaluate", { expression: DOC_TEXT_EXPR, contextId: ctx, returnByValue: true }, doc.sessionId, 10_000))).catch(() => null);
    if (typeof v !== "string" || v === "") continue;
    const part = v.slice(0, left);
    parts.push(part);
    left -= part.length + 1;
  }
  return parts.join("\n");
}

/** The session's current tab has refs minted for the document it shows now. */
async function hasCurrentSnapshot(d: Daemon, session: string): Promise<boolean> {
  const b = d.browser;
  if (b === null) return false;
  const s = b.tabs.session(session);
  if (s === undefined || s.current === null) return false;
  let tab;
  try {
    tab = b.tabs.currentTab(session);
  } catch {
    return false;
  }
  if (tab.refs.size === 0 || tab.refs.document === null) return false;
  const doc = await docIdentity(b.t, tab).catch(() => null);
  return doc !== null && sameDoc(tab.refs.document, doc);
}

async function refText(d: Daemon, session: string, ref: string, a: Args): Promise<{ text: string; page: string }> {
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, null);
  return tabs.run(
    tab,
    async () => {
      const { objectId, sessionId } = await resolveRef(t, tab, ref);
      const v = callResult(await t.send("Runtime.callFunctionOn", { objectId, functionDeclaration: REF_TEXT_FN, returnByValue: true }, sessionId, 10_000));
      return { text: typeof v === "string" ? v : "", page: await tabText(t, tab) };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

function scrubFinding(d: Daemon, f: FindingInput): FindingInput {
  return {
    ...f,
    claim: d.secrets.scrub(f.claim),
    evidence: f.evidence.map((e) => scrubValue(d.secrets, e)).filter(isRecord),
    input: scrubValue(d.secrets, f.input),
    output: scrubValue(d.secrets, f.output),
  };
}

export async function where(d: Daemon, a: Args, session: string): Promise<unknown> {
  const input = reqStr(a, "query", USAGE);
  const asRef = input.trim();
  const as = optStr(a, "as");
  if (as !== null && as !== "ref" && as !== "text") throw new TabcapError("usage", `--as ${as}?`, "Use `--as ref` (a snapshot ref such as e12) or `--as text` (the value as typed).");
  const top = optNum(a, "top") ?? DEFAULT_TOP;
  const live = d.recorders.get(session);
  const rec = live ?? d.lastBundles.get(session);
  if (rec === undefined) throw new TabcapError("not-found", `session "${session}" has no recording`, "Run `tabcap net start`, load the page that shows the value, then `tabcap where <ref|text>`.");
  const kind = as ?? (isRef(asRef) && (await hasCurrentSnapshot(d, session)) ? "ref" : "text");
  let query: WhereQuery;
  let pageText: string | null = null;
  if (kind === "ref") {
    if (!isRef(asRef)) throw new TabcapError("usage", `not a ref: ${input}`, "Refs look like e12 (f2/e7 in a frame); get them from `tabcap snapshot`, or pass the value itself with --as text.");
    const got = await refText(d, session, asRef, a);
    query = { input, kind: "ref", ref: asRef, text: got.text };
    pageText = got.page;
  } else query = { input, kind: "text", text: input };
  if (live !== undefined) await live.flushEvents();
  const result = whereIn(BundleReader.open(rec.dir), query, { top, pageText });
  if (!optBool(a, "writeFindings")) return result;
  const findings = whereFindings(result).map((f) => scrubFinding(d, f));
  let saved: SavedFindings;
  if (live !== undefined) {
    const seqs: number[] = [];
    for (const f of findings) {
      const seq = live.event("finding", { tool: f.tool, grade: f.grade, claim: f.claim, evidence: f.evidence, input: f.input, output: f.output }, { actor: f.actor });
      if (seq !== null) seqs.push(seq);
    }
    await live.flushEvents();
    saved = { bundle: rec.dir, seqs };
  } else saved = appendFindings(rec.dir, findings);
  return { ...result, saved };
}
