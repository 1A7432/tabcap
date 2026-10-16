// Image captcha advisory on page reads and actions (0.6-D; the heuristic is
// browser/captcha.ts, the scan adapters/runtime.ts). Advisory only: nothing is
// refused, nothing waits, nothing is handed over. snapshot / outline show the
// `challenge` header line; fill / click on the captcha's form carry
// `challenge: {kind, image, input}`; the recording gets one `guard` event
// {event:"challenge", detail:{kind, advisory:true, …}} per page.

import { log } from "../../shared/log.ts";
import { scanCaptcha } from "../adapters/runtime.ts";
import { onCaptchaForm, type ChallengeView } from "../browser/captcha.ts";
import type { FrameBinding } from "../browser/refs.ts";
import type { Tab } from "../browser/targets.ts";
import { rootDoc, type FrameDoc } from "../browser/worlds.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { docIdentity } from "./snapshot.ts";

/** Record the advisory once per page (tab + document identity) in the session's recording, if it records. */
export async function adviseChallenge(d: Daemon, t: Transport, tab: Tab, c: ChallengeView | null | undefined): Promise<void> {
  if (c === null || c === undefined) return;
  const rec = d.recorders.get(tab.session);
  if (rec === undefined) return;
  const doc = await docIdentity(t, tab).catch(() => null);
  if (doc === null) return;
  if (!d.guard.firstAdvisory(tab.session, `${tab.id}|${doc.frameId}|${doc.loaderId}|${doc.url}|${c.kind}`)) return;
  const bound = d.sites.get(tab.session);
  rec.event(
    "guard",
    { event: "challenge", site: bound?.site ?? null, account: bound?.account ?? null, detail: { kind: c.kind, advisory: true, image: c.image, input: c.input, url: doc.url, ...(c.frame === undefined ? {} : { frame: c.frame }) } },
    { tab: tab.id },
  );
}

/**
 * The advisory for a fill / click target: `challenge` when the target's
 * document has an image captcha and the target is on its form. Never throws
 * (a failed scan is logged and gives nothing).
 */
export async function actionChallenge(d: Daemon, t: Transport, tab: Tab, node: { backendNodeId: number; sessionId?: string; frame?: FrameBinding | null }): Promise<Record<string, unknown>> {
  try {
    const frame = node.frame ?? null;
    const doc: FrameDoc = frame === null ? rootDoc(tab, await docIdentity(t, tab)) : { frameId: frame.frameId, loaderId: frame.loaderId, url: "", sessionId: frame.sessionId };
    const r = await scanCaptcha(t, tab, doc, frame, node.backendNodeId);
    if (r === null || !onCaptchaForm(r.scan, r.hit)) return {};
    await adviseChallenge(d, t, tab, r.view);
    return { challenge: { kind: r.view.kind, image: r.view.image, input: r.view.input } };
  } catch (e) {
    log.info("captcha check of an action target failed", { tab: tab.id, error: e instanceof Error ? e.message : String(e) });
    return {};
  }
}
