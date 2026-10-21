// tabcap fingerprint probe (0.4-G): the values this browser presents. A
// transient probe server on 127.0.0.1 (port 0), the page in a new background
// tab of the session (closed afterwards), the page's own POST /probe as the
// answer; while the session records, a `state` event {what:"env", source:
// "fingerprint-probe", fields} goes into the bundle (docs/04 §4.3). With --ref
// the user's own reference is the second column, with a verdict per field.
// Read-only: the probe page only reads, and nothing suggests changing a value.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import { fingerprintResult, mapFieldText, PROBE_SOURCE, type Field } from "../../fingerprint/fields.ts";
import { loadRef } from "../../fingerprint/refs.ts";
import { startProbeServer } from "../../fingerprint/server.ts";
import type { Tab } from "../browser/targets.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { checkSessionName, optStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";

/** Where the probe page got to, from its own marks (src/fingerprint/probe.html). */
export type ProbeStage = "loading" | "collecting" | "posting" | "answered" | "post-failed" | "done" | "unknown";
export type ProbePageState = { readyState: string | null; url: string | null; stage: ProbeStage; status: string | null; rows: number | null };

/** Read-only: the document state and the page's marks (#status text, #rows count, body[data-done]). */
const PAGE_STATE_EXPR = `(() => ({ readyState: document.readyState, href: location.href, status: document.getElementById("status")?.textContent ?? null, rows: document.getElementById("rows")?.children.length ?? null, done: document.body?.dataset.done ?? null }))()`;

const STAGE_TEXT: Readonly<Record<ProbeStage, string>> = {
  loading: "loading: the document is still loading",
  collecting: "collecting: the page script has not filled its table yet",
  posting: "posting: fields collected, POST /probe not answered",
  answered: "answered: POST /probe was answered",
  "post-failed": "post-failed: POST /probe failed in the page",
  done: "done: the page script finished",
  unknown: "unknown",
};

/** Pure: the evaluation result (untrusted page data) as a ProbePageState. */
export function probeStage(v: unknown): ProbePageState {
  const r = isRecord(v) ? v : {};
  const readyState = typeof r["readyState"] === "string" ? r["readyState"].slice(0, 40) : null;
  const url = typeof r["href"] === "string" ? r["href"].slice(0, 300) : null;
  const status = typeof r["status"] === "string" ? r["status"].slice(0, 200) : null;
  const rows = typeof r["rows"] === "number" && Number.isSafeInteger(r["rows"]) ? r["rows"] : null;
  let stage: ProbeStage = "unknown";
  if (r["done"] === "1") stage = "done";
  else if (status !== null && status.startsWith("read ")) stage = status.includes("did not answer") ? "post-failed" : "answered";
  else if (readyState === "loading") stage = "loading";
  else if (rows !== null && rows > 0) stage = "posting";
  else if (readyState !== null) stage = "collecting";
  return { readyState, url, stage, status, rows };
}

/** One read-only look at the probe tab (2 s at most); `error` when it could not be read. */
async function probePageState(t: Transport, tab: Tab): Promise<ProbePageState | { error: string }> {
  try {
    const r = await t.send("Runtime.evaluate", { expression: PAGE_STATE_EXPR, returnByValue: true }, tab.sessionId, 2000);
    return probeStage(isRecord(r["result"]) ? r["result"]["value"] : null);
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

function pageText(p: ProbePageState | { error: string }): string {
  if ("error" in p) return `the probe tab could not be read: ${p.error}`;
  return `readyState ${p.readyState ?? "?"}, stage ${STAGE_TEXT[p.stage]}; url ${p.url ?? "?"}`;
}

export async function fingerprintProbe(d: Daemon, a: Args, session: string): Promise<unknown> {
  checkSessionName(session);
  const { t, tabs } = d.need();
  const refName = optStr(a, "ref");
  // A bad or missing reference fails before anything is opened.
  const ref = refName === null ? null : loadRef(d.paths.config, refName);
  // Leave the CLI's own timeout some room to carry the answer back.
  const budget = Math.max(5000, timeoutOf(a) - 2000);
  let resolveProbe: (f: Field[]) => void = () => undefined;
  const got = new Promise<Field[]>((resolve) => {
    resolveProbe = resolve;
  });
  const server = startProbeServer({ port: 0, mode: "probe", onProbe: (fields) => resolveProbe(fields) });
  const prevCurrent = tabs.session(session)?.current ?? null;
  let tab: Tab | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    tab = await tabs.createTab(session, { background: true });
    const r = await t.send("Page.navigate", { url: server.url }, tab.sessionId);
    if (typeof r["errorText"] === "string" && r["errorText"] !== "") throw new TabcapError("page", `the probe page did not load: ${r["errorText"]}`, "Check that the browser can reach 127.0.0.1 (the session's proxy settings).");
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budget);
    });
    const raw = await Promise.race([got, timeout]);
    if (raw === null) {
      // Review 10-21 (CI windows v04g): say where the page got to before giving up, here and in the daemon log.
      const page = await probePageState(t, tab);
      log.warn("fingerprint probe: page did not report", { session, tab: tab.id, budgetMs: budget, ...page });
      throw new TabcapError("timeout", `the probe page did not report within ${budget} ms (${pageText(page)})`, "Raise --timeout; run `tabcap tab list` to look for the probe tab.", { page });
    }
    const fields = mapFieldText(raw, (s) => d.secrets.scrub(s));
    const rec = d.recorders.get(session);
    const seq = rec?.envState(tab.id, { what: "env", source: PROBE_SOURCE, origin: new URL(server.url).origin, count: fields.length, reason: "manual", fields }) ?? null;
    const info = d.browser?.info;
    const version = info === undefined ? null : info.version.replace(/^[^/]*\//, "");
    return {
      ...fingerprintResult(version, fields, ref === null ? null : { info: { name: ref.name, savedAt: ref.savedAt, userAgent: ref.userAgent }, fields: ref.fields }),
      state: rec === undefined || seq === null ? null : { bundle: rec.dir, seq },
      ...(rec === undefined ? { warning: "the session is not recording: no state event was written (run `tabcap net start` first to keep the probe in a bundle)" } : {}),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (tab !== null) await tabs.closeTab(tab);
    if (prevCurrent !== null) {
      try {
        tabs.use(session, prevCurrent);
      } catch (e) {
        log.info("fingerprint probe: previous tab is gone", { session, error: String(e) });
      }
    }
    server.stop();
  }
}
