// Action metadata (owner 10-21): one row per daemon action. The sets the
// daemon used to keep by hand in three files are derived from here:
//   blockedWhileWaiting → guard.ts BLOCKED_WHILE_WAITING (refused with
//                         `waiting` while the session waits for the human,
//                         docs/04 §4.2 / §37; also the account's hourly
//                         budget, tools/pool.ts budgetBlock)
//   cmdWindow           → state.ts ACTION_COMMANDS (an action command: it
//                         moves `net wait`'s look-back point, docs/04 §16, and
//                         its answer names its command window `cmd` while
//                         recording)
//   defersText          → TEXT_ACTIONS (daemon/main.ts: the `text` argument is
//                         typed into the page, so the `cmd` start event defers
//                         it to the end event)
// `actsOnPage` is descriptive (it drives the page: input, navigation, page
// script, requests sent from the page, what the page sees); a row that acts on
// the page and is not refused while waiting says why in `note`.
// tools/index.ts types TOOLS by the keys of TOOL_ACTIONS, so a tool without a
// row (or a row without a tool) does not compile. This file imports no tool:
// guard.ts and state.ts read it.

export type ActionMeta = {
  actsOnPage: boolean;
  blockedWhileWaiting: boolean;
  cmdWindow: boolean;
  defersText: boolean;
  note?: string;
};

const row = (o: Partial<ActionMeta> = {}): ActionMeta => ({ actsOnPage: false, blockedWhileWaiting: false, cmdWindow: false, defersText: false, ...o });
/** Drives the page and waits for the human; an action command (`cmd`, net wait look-back). */
const action = (o: Partial<ActionMeta> = {}): ActionMeta => row({ actsOnPage: true, blockedWhileWaiting: true, cmdWindow: true, ...o });
/** Drives the page and waits for the human, but is not an action command. */
const pageOnly = (o: Partial<ActionMeta> = {}): ActionMeta => row({ actsOnPage: true, blockedWhileWaiting: true, ...o });

/** The actions TOOLS runs (POST /command {action}). */
export const TOOL_ACTIONS = {
  "browser.start": row(),
  "browser.stop": row(),
  "browser.status": row(),
  "session.start": row(),
  "session.stop": row(),
  "session.list": row(),
  "session.export": row(),
  // `tab new` is navigate in the daemon
  navigate: action(),
  tabs: row(),
  "tab.close": row(),
  "tab.use": row(),
  go: action(),
  reload: action(),
  snapshot: row(),
  outline: row(),
  find: row(),
  html: row(),
  click: action(),
  // hover and upload (0.3-F) act on the page like click
  hover: action(),
  fill: action({ defersText: true }),
  type: action({ defersText: true }),
  // the CLI's press-key
  press: action(),
  upload: action(),
  evaluate: action(),
  screenshot: row(),
  // resize and emulate (0.4) change what the page sees (its size, device, network)
  resize: pageOnly(),
  emulate: pageOnly(),
  dialog: pageOnly(),
  "net.start": row(),
  "net.stop": row(),
  "net.list": row(),
  "net.body": row(),
  "net.show": row(),
  "net.grep": row(),
  "console.list": row(),
  "console.show": row(),
  wait: row(),
  "net.wait": row(),
  "handoff.status": row(),
  "handoff.continue": row(),
  "handoff.wait": row(),
  "e2e.human-input": row({
    actsOnPage: true,
    note: "0.7.1-A test-only: it stands in for the human's own input (docs/04 §37), which a waiting session must still receive",
  }),
  "guard.resume": row(),
  // fetch (0.6-A) sends requests from the session's tab
  fetch: pageOnly(),
  where: row(),
  recon: row(),
  "trace.start": row(),
  "trace.stop": row(),
  "trace.status": row(),
  "trace.list": row(),
  // fingerprint probe (0.4-G) opens and navigates a tab of the session like tab new
  "fingerprint.probe": pageOnly(),
  // wire profile / probe (0.4-W2) do the same (owner 10-21: they wait like fingerprint probe)
  "wire.profile": pageOnly(),
  "wire.probe": pageOnly(),
} satisfies Record<string, ActionMeta>;

export type ToolAction = keyof typeof TOOL_ACTIONS;

/** Actions daemon/main.ts answers before the tool path (not in TOOLS); listed so the table names every action. */
export const DAEMON_ACTIONS: Readonly<Record<string, ActionMeta & { note: string }>> = {
  status: { ...row(), note: "0.7-B: read-only and daemon-wide; main.ts answers it before the command path, so it opens no cmd window and is never refused while a session waits (docs/04 §35)" },
  "daemon.status": { ...row(), note: "the daemon's own status (also GET /status); answered before the command path" },
  "daemon.shutdown": { ...row(), note: "`tabcap daemon stop`; answered before the command path" },
};

/** The tool actions whose row has `key` set. */
export function actionsWhere(key: "actsOnPage" | "blockedWhileWaiting" | "cmdWindow" | "defersText"): ReadonlySet<string> {
  const rows: Record<string, ActionMeta> = TOOL_ACTIONS;
  return new Set(Object.keys(rows).filter((k) => rows[k]?.[key] === true));
}

/** Actions whose `text` argument is typed into the page (fill / type): the `cmd` start event defers it to the end event. */
export const TEXT_ACTIONS: ReadonlySet<string> = actionsWhere("defersText");
