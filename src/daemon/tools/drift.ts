// docs/04 §52.2 (11-12): what a command does with a tab someone else changed.
// A root navigation that neither the session nor the page made (browser/targets.ts
// isExternalStart) leaves the tab `changed`. Page-acting commands on it are refused
// with `tab-changed` until `navigate` or `tab select` on that tab acknowledges it;
// read-only commands run and carry `changed`. Recovery stays in place: the `next`
// never suggests a new tab or another browser (owner 11-12).

import { TabcapError } from "../../shared/envelope.ts";
import type { TabChange } from "../browser/targets.ts";
import { BLOCKED_WHILE_WAITING } from "../guard.ts";

/** What the daemon does before running `action` on a tab whose change is `change`. */
export type ChangeDecision = "pass" | "refuse" | "acknowledge";

/**
 * docs/04 §52.2. `onChangedTab`: the command acts on the changed tab (for `tab select`
 * its argument; for `navigate --new-tab` never: it opens another tab).
 */
export function decideChange(action: string, change: TabChange | null, onChangedTab: boolean): ChangeDecision {
  if (change === null || !onChangedTab) return "pass";
  if (action === "navigate" || action === "tab.use") return "acknowledge";
  return BLOCKED_WHILE_WAITING.has(action) ? "refuse" : "pass";
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The `changed` field of an answer and of `tab list` rows. */
export function changeField(c: TabChange): { at: string; from: string; to: string; by: "external" } {
  return { at: iso(c.at), from: c.from, to: c.to, by: c.by };
}

/** docs/04 §52.2: the refusal; nothing ran, the page did not move. */
export function tabChangedError(tab: string, c: TabChange): TabcapError {
  return new TabcapError(
    "tab-changed",
    `tab ${tab} went from ${c.from} to ${c.to} at ${iso(c.at)}, and this session did not do it (another tool or a person in the browser); the command did not run`,
    `To go on with the page as it is now: \`tabcap tab select ${tab}\` (acknowledges the change), check it with \`tabcap snapshot\`, then run the command again. To go back: \`tabcap navigate ${quoteArg(c.from)} --tab ${tab}\`.`,
    { tab, changed: changeField(c) },
  );
}

/** A URL as one shell word for a `next` hint. */
function quoteArg(s: string): string {
  return /^[A-Za-z0-9_./:%?&=#~+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
