// tabcap fingerprint probe (0.4-G): the values this browser presents. A
// transient probe server on 127.0.0.1 (port 0), the page in a new background
// tab of the session (closed afterwards), the page's own POST /probe as the
// answer; while the session records, a `state` event {what:"env", source:
// "fingerprint-probe", fields} goes into the bundle (docs/04 §4.3). With --ref
// the user's own reference is the second column, with a verdict per field.
// Read-only: the probe page only reads, and nothing suggests changing a value.

import { TabcapError } from "../../shared/envelope.ts";
import { log } from "../../shared/log.ts";
import { fingerprintResult, mapFieldText, PROBE_SOURCE, type Field } from "../../fingerprint/fields.ts";
import { loadRef } from "../../fingerprint/refs.ts";
import { startProbeServer } from "../../fingerprint/server.ts";
import type { Tab } from "../browser/targets.ts";
import type { Daemon } from "../state.ts";
import { checkSessionName, optStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";

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
    if (raw === null) throw new TabcapError("timeout", `the probe page did not report within ${budget} ms`, "Raise --timeout; run `tabcap tab list` to look for the probe tab.");
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
