// tabcap outline: page map v0 (docs/09 §2). 0.3-D covers the head of the map:
// the tab line, "overlays" (from the overlay adapter), "detected" (adapters
// detected with their confidence) and "popups" (popups of the session, opened
// by window.open; docs/04 §16 owned / handled); 0.4-I adds "frames" (the
// frame tree, as in the snapshot header). Regions, data blocks and controls
// come in later cells.

import type { Daemon } from "../state.ts";
import { inspectPage } from "../adapters/runtime.ts";
import { cutText, headerLines, LABEL } from "../adapters/view.ts";
import { optNum, optStr, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";
import { refreshTabInfo } from "./session.ts";
import { docIdentity, settle } from "./snapshot.ts";
import { frameHeaderLines, frameList, frameTree } from "../browser/frames.ts";
import { rootDoc } from "../browser/worlds.ts";

export const OUTLINE_MAX_CHARS = 6000;

export async function outline(d: Daemon, a: Args, session: string): Promise<unknown> {
  const maxChars = Math.max(500, Math.min(optNum(a, "maxChars") ?? OUTLINE_MAX_CHARS, 60_000));
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      await settle(tab, 10_000);
      const doc = await docIdentity(t, tab);
      tab.refs.setDocument(doc);
      const tree = await frameTree(t, tab).catch(() => null);
      const page = await inspectPage(t, tab, rootDoc(tab, doc), undefined, tree === null ? null : tree.root);
      await refreshTabInfo(d, session);
      const nav = d.navOf(tab);
      const popups = tabs
        .sessionTabs(session)
        .filter((x) => x.id !== tab.id && x.reason === "popup")
        .map((x) => ({ tab: x.id, url: x.url, title: x.title, opener: x.opener }));
      const frameLines = tree === null ? ["frames    ? (the frame tree could not be read)"] : frameHeaderLines(tree.root, tree.omitted);
      const frames = tree === null ? [] : frameList(tree.root);
      const lines = [`${tab.id} ${tab.title === "" ? "(no title)" : tab.title}  ${doc.url}${nav === null ? "" : `  ${nav}`}`, ...headerLines(page), ...frameLines];
      popups.forEach((p, i) => lines.push(`${i === 0 ? LABEL.popups : LABEL.more}${p.tab}${p.title === "" ? "" : ` "${p.title}"`} ${p.url}${p.opener === null ? "" : ` (opener ${p.opener})`}`));
      const full = lines.join("\n");
      const cut = cutText(full, maxChars);
      return {
        tab: tab.id,
        url: doc.url,
        title: tab.title,
        nav,
        overlays: page.overlays,
        detected: (page.detected ?? []).filter((x) => x.confidence > 0),
        ...(frames.length > 0 ? { frames } : {}),
        popups,
        chars: full.length,
        truncated: cut.truncated,
        outline: cut.text,
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
