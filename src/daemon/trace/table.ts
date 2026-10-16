// `tabcap trace list` (0.4-F): API × script table over `signal` events
// (docs/04 §4.1). Pure; events are untrusted bundle lines, malformed ones are
// skipped. Lines and columns are shown 1-based like `net show` (the bundle
// keeps CDP's 0-based numbers, docs/04 §17).

import { isRecord, num, str } from "../../shared/json.ts";

export type TraceFilter = { api: string | null; script: string | null };

export type TraceCaller = { line: number; col: number; kind: "page" | "tabcap"; count: number };

export type TraceRow = {
  api: string;
  access: string;
  script: string;
  count: number;
  /** Distinct (tab, frame, nav) documents the reads came from. */
  documents: number;
  callers: TraceCaller[];
  truncated: boolean;
  /** Some event of the row carries the API's value (docs/04 §4.1). */
  value: boolean;
};

/** `--api` matches the name exactly; `--script` matches when the script URL contains it. */
export function traceTable(events: readonly unknown[], f: TraceFilter): TraceRow[] {
  type Acc = TraceRow & { docs: Set<string>; byCaller: Map<string, TraceCaller> };
  const rows = new Map<string, Acc>();
  for (const e of events) {
    if (!isRecord(e) || e["kind"] !== "signal") continue;
    const api = str(e, "api");
    const access = str(e, "access");
    const caller = isRecord(e["caller"]) ? e["caller"] : null;
    const count = num(e, "count");
    if (api === null || access === null || caller === null || count === null) continue;
    const url = str(caller, "url") ?? "";
    if (f.api !== null && api !== f.api) continue;
    if (f.script !== null && !url.includes(f.script)) continue;
    const key = `${api}|${access}|${url}`;
    let r = rows.get(key);
    if (r === undefined) {
      r = { api, access, script: url, count: 0, documents: 0, callers: [], truncated: false, value: false, docs: new Set(), byCaller: new Map() };
      rows.set(key, r);
    }
    r.count += count;
    r.docs.add(`${String(e["tab"])}|${String(e["frame"])}|${String(e["nav"])}`);
    if (e["truncated"] === true) r.truncated = true;
    if ("value" in e) r.value = true;
    const line = (num(caller, "line") ?? 0) + 1;
    const col = (num(caller, "col") ?? 0) + 1;
    const kind = caller["kind"] === "tabcap" ? "tabcap" : "page";
    const ck = `${line}:${col}:${kind}`;
    const c = r.byCaller.get(ck) ?? { line, col, kind, count: 0 };
    c.count += count;
    r.byCaller.set(ck, c);
  }
  return [...rows.values()]
    .map(({ docs, byCaller, ...r }) => ({ ...r, documents: docs.size, callers: [...byCaller.values()].sort((a, b) => a.line - b.line || a.col - b.col || a.kind.localeCompare(b.kind)) }))
    .sort((a, b) => a.api.localeCompare(b.api) || a.script.localeCompare(b.script) || a.access.localeCompare(b.access));
}

/** `trace list --text`: one line per (api, script). */
export function renderTraceText(data: unknown): string {
  const d = isRecord(data) ? data : {};
  const rows = Array.isArray(d["rows"]) ? d["rows"].filter(isRecord) : [];
  const lines: string[] = [`trace list · session ${String(d["session"] ?? "?")} · ${rows.length} row(s) · lines:cols 1-based`];
  if (rows.length === 0) lines.push("(no signal reads recorded)");
  for (const r of rows) {
    const callers = Array.isArray(r["callers"])
      ? r["callers"]
          .filter(isRecord)
          .map((c) => `${String(c["line"])}:${String(c["col"])}${c["kind"] === "tabcap" ? " (tabcap)" : ""} ×${String(c["count"])}`)
          .join(", ")
      : "";
    const flags = [r["truncated"] === true ? "truncated" : null, r["value"] === true ? "value" : null].filter((x) => x !== null).join(" ");
    lines.push(`${String(r["api"])} [${String(r["access"])}] ×${String(r["count"])} in ${String(r["documents"])} doc(s)${flags === "" ? "" : ` (${flags})`}`);
    lines.push(`    ${String(r["script"]) === "" ? "(no script url: eval or tabcap evaluate)" : String(r["script"])} @ ${callers}`);
  }
  return lines.join("\n");
}
