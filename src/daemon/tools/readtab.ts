// docs/04 §52.3 (11-12): the tab a read-only command reads. `--target <id>` reads
// any page target of the browser (another session's, the human's, another tool's)
// without taking it: not the session's current tab, not recorded, refs of its own.
// Only snapshot, outline, find, html and screenshot take it; acting needs `tab adopt`.

import type { Tab, Tabs } from "../browser/targets.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { optStr, type Args } from "./args.ts";

export async function readTab(tabs: Tabs, a: Args, session: string): Promise<Tab> {
  const target = optStr(a, "target");
  const tab = optStr(a, "tab");
  if (target !== null && tab !== null) throw new TabcapError("usage", "give either --tab or --target, not both", "--tab is one of this session's tabs (`tab list`); --target is any tab of the browser (`tab list --all`).");
  return target !== null ? tabs.viewTarget(target) : tabs.pick(session, tab);
}
