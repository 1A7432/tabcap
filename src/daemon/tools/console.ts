// tabcap console list | console show <msgid> — the current tab's console ring
// buffer (last 500 messages, kept whether or not the session records).
// Names and paging follow chrome-devtools-mcp's list_console_messages /
// get_console_message (docs/08 §5): `--types`, `--page-size` / `--page-idx`
// (30 per page by default, `--page-size 0`: every buffered message), `--include-stack-traces`.

import { TabcapError } from "../../shared/envelope.ts";
import { atLeast, CONSOLE_TYPES, isLevel, whereOf, type StoredConsole } from "../capture/console.ts";
import type { Daemon } from "../state.ts";
import { optBool, optNum, optStr, type Args } from "./args.ts";
import { pagedFields } from "./net.ts";
import { pageOf, parsePaging } from "./netquery.ts";

function levelArg(a: Args): string | null {
  const level = optStr(a, "level");
  if (level !== null && !isLevel(level)) throw new TabcapError("usage", `--level ${level}?`, "Use --level debug|log|info|warn|error (that level and more severe).");
  return level;
}

function limitArg(a: Args, cmd: string): number | null {
  const limit = optNum(a, "limit");
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new TabcapError("usage", "--limit must be a positive integer", `e.g. \`tabcap ${cmd} --limit 20\`.`);
  return limit;
}

/** `--types error,warn` → the list, validated against the known message types. */
export function parseTypes(v: string | null): string[] | null {
  if (v === null) return null;
  const types = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const bad = types.filter((t) => !CONSOLE_TYPES.includes(t));
  if (bad.length > 0) throw new TabcapError("usage", `unknown console message type: ${bad.join(", ")}`, `Use --types with any of: ${CONSOLE_TYPES.join(", ")}.`);
  return types.length === 0 ? null : types;
}

const brief = (e: StoredConsole, stack: boolean) => ({
  msgid: e.id,
  type: e.type,
  ts: e.ts,
  level: e.level,
  source: e.source,
  text: e.text,
  ...(e.truncated ? { truncated: true } : {}),
  argsCount: e.args.length,
  at: whereOf(e),
  ...(stack && e.stack !== null ? { stack: e.stack } : {}),
});

export function consoleList(d: Daemon, a: Args, session: string): unknown {
  const level = levelArg(a);
  const types = parseTypes(optStr(a, "types"));
  const limit = limitArg(a, "console list");
  const paging = parsePaging({ pageSize: a["pageSize"], pageIdx: a["pageIdx"] }, "console list");
  if (limit !== null && (a["pageSize"] !== undefined || a["pageIdx"] !== undefined)) throw new TabcapError("usage", "--limit and --page-size / --page-idx exclude each other", "Use --limit N for the last N messages, or --page-size / --page-idx to page from the oldest.");
  const stacks = optBool(a, "includeStackTraces");
  const { tabs, console } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const ring = console.ring(tab.id);
  const all = ring.toArray();
  const matching = all.filter((e) => (level === null || (isLevel(level) && atLeast(e.level, level))) && (types === null || types.includes(e.type)));
  const page = limit !== null ? pageOf(matching.slice(-limit), { mode: "all" }) : pageOf(matching, paging);
  const dropped = ring.dropped;
  const clear = optBool(a, "clear");
  if (clear) ring.clear();
  const notes: string[] = [];
  if (limit !== null && matching.length > limit) notes.push(`showing the last ${limit} of ${matching.length}`);
  if (page.nextPageIdx !== null) notes.push(`more: --page-idx ${page.nextPageIdx}`);
  if (dropped > 0) notes.push(`${dropped} older message(s) fell out of the 500-message buffer`);
  return {
    tab: tab.id,
    url: tab.url,
    buffered: all.length,
    dropped,
    matching: matching.length,
    returned: page.rows.length,
    cleared: clear,
    ...pagedFields(page),
    entries: page.rows.map((e) => brief(e, stacks)),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

export function consoleShow(d: Daemon, a: Args, session: string): unknown {
  const raw = optStr(a, "msgid") ?? (typeof a["msgid"] === "number" ? String(a["msgid"]) : null);
  if (raw === null || !/^\d+$/.test(raw)) throw new TabcapError("usage", `not a console message id: ${raw ?? "(none)"}`, "Pass a msgid from `tabcap console list`, e.g. `tabcap console show 3`.");
  const id = Number(raw);
  const { tabs, console } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  const ring = console.ring(tab.id);
  const all = ring.toArray();
  const e = all.find((x) => x.id === id);
  if (e === undefined) {
    const oldest = all[0]?.id ?? null;
    const gone = oldest !== null && id < oldest;
    throw new TabcapError(
      "not-found",
      gone ? `console message ${id} is no longer buffered on tab ${tab.id} (the buffer keeps the last 500; oldest now ${oldest})` : `no console message ${id} on tab ${tab.id}`,
      "Run `tabcap console list` for the current msgids.",
    );
  }
  return { tab: tab.id, url: tab.url, ...brief(e, true), args: e.args, stack: e.stack };
}
