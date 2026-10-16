// CLI side of `tabcap fetch` (0.6-A): flags → the request shape the daemon
// (and `POST /fetch`) takes. Files named with `@` are read here, relative to
// the caller's working directory; the daemon only ever sees text and JSON.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { FETCH_USAGE } from "../daemon/fetch/spec.ts";

const usage = (msg: string, next = `Usage: ${FETCH_USAGE}`) => new TabcapError("usage", msg, next);

export type ReadText = (path: string) => string;

const defaultRead: ReadText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    throw new TabcapError("not-found", `cannot read ${p}: ${e instanceof Error ? e.message : String(e)}`, "Check the path after @.");
  }
};

/** `@file` → the file's text (relative to cwd); anything else as is. */
function textOrFile(v: string, cwd: string, read: ReadText): string {
  return v.startsWith("@") && v.length > 1 ? read(resolve(cwd, v.slice(1))) : v;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** `--header k:v` → [k, v] (the value's leading spaces dropped). */
export function headerPair(s: string): [string, string] {
  const i = s.indexOf(":");
  if (i <= 0) throw usage(`--header ${JSON.stringify(s.slice(0, 100))}: expected name:value`);
  return [s.slice(0, i).trim(), s.slice(i + 1).replace(/^\s+/, "")];
}

/** `--form k=v` → [k, v]. */
export function formPair(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw usage(`--form ${JSON.stringify(s.slice(0, 100))}: expected field=value`);
  return [s.slice(0, i), s.slice(i + 1)];
}

/** Parse the --json text (or @file) into a JSON value; invalid JSON is a usage error. */
export function jsonArg(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw usage(`--json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "Pass a JSON document, e.g. --json '{\"page\":2}', or --json @body.json.");
  }
}

/** The JSON lines of a --batch file: one request object per non-empty line. */
export function batchLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(line) as unknown;
    } catch (e) {
      throw usage(`--batch line ${i + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`, "One JSON object per line: {\"url\": \"/api/x\", \"method\": \"POST\", \"json\": {...}}.");
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw usage(`--batch line ${i + 1} must be a JSON object {url, ...}`);
    out.push(Object.fromEntries(Object.entries(v)));
  });
  if (out.length === 0) throw usage("--batch file has no requests");
  return out;
}

const REQUEST_FLAGS: ReadonlyArray<[string, string]> = [
  ["url", "<url>"],
  ["method", "--method"],
  ["header", "--header"],
  ["body", "--body"],
  ["json", "--json"],
  ["form", "--form"],
  ["stopOn", "--stop-on"],
  ["out", "--out"],
  ["rawBody", "--raw"],
  ["tab", "--tab"],
];

/** CLI args (parseCommand + withLocalPaths) → the daemon's fetch args. */
export function fetchArgs(a: Record<string, unknown>, cwd: string, read: ReadText = defaultRead): Record<string, unknown> {
  const batchFile = typeof a["batch"] === "string" ? a["batch"] : null;
  if (batchFile !== null) {
    const clash = REQUEST_FLAGS.filter(([k]) => a[k] !== undefined).map(([, f]) => f);
    if (clash.length > 0) throw usage(`--batch takes the requests from the file; leave out ${clash.join(", ")}`);
    const timeoutMs = typeof a["timeoutMs"] === "number" ? a["timeoutMs"] : undefined;
    const lines = batchLines(read(resolve(cwd, batchFile)));
    const withTimeout = timeoutMs === undefined ? lines : lines.map((l) => ("timeoutMs" in l ? l : { ...l, timeoutMs }));
    return { batch: a["reveal"] === true ? withTimeout.map((l) => ("reveal" in l ? l : { ...l, reveal: true })) : withTimeout };
  }
  if (typeof a["url"] !== "string" || a["url"] === "") throw usage("missing <url>");
  const out: Record<string, unknown> = { url: a["url"] };
  if (typeof a["method"] === "string") out["method"] = a["method"];
  const headers = list(a["header"]).map(headerPair);
  if (headers.length > 0) out["headers"] = headers;
  const given = ["body", "json", "form"].filter((k) => a[k] !== undefined);
  if (given.length > 1) throw usage(`give one of --body / --json / --form, not ${given.map((k) => `--${k}`).join(" and ")}`);
  if (typeof a["body"] === "string") out["body"] = textOrFile(a["body"], cwd, read);
  if (typeof a["json"] === "string") out["json"] = jsonArg(textOrFile(a["json"], cwd, read));
  const form = list(a["form"]).map(formPair);
  if (form.length > 0) out["form"] = form;
  const stopOn = list(a["stopOn"]);
  if (stopOn.length > 0) out["stopOn"] = stopOn;
  for (const k of ["tab", "out", "timeoutMs"]) if (a[k] !== undefined) out[k] = a[k];
  if (a["rawBody"] === true) out["rawBody"] = true;
  if (a["reveal"] === true) out["reveal"] = true;
  return out;
}

/** The CLI's own wait for the daemon: every request's timeout (a batch runs them one after another). */
export function fetchClientTimeout(args: Record<string, unknown>, fallback: number): number {
  const b = args["batch"];
  if (!Array.isArray(b)) return typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : fallback;
  return b.reduce<number>((sum, l) => sum + (typeof l === "object" && l !== null && "timeoutMs" in l && typeof l.timeoutMs === "number" ? l.timeoutMs : fallback), 0);
}
