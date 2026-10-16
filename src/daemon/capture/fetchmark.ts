// Attribution of `tabcap fetch` requests to their command (0.6-A). Pure helpers
// for the recorder:
// - same-origin fetches carry the marker header `x-tabcap-fetch: c-N:f-K`; the
//   recorder reads it at Fetch's Request stage and continues the request
//   without it, so the server never sees it (spike 10-16: the range's access
//   log and Network.requestWillBeSentExtraInfo both lack it, cookies still go);
// - cross-origin fetches carry no marker (it would force a CORS preflight); the
//   request's initiator stack names the helper's per-fetch function and its
//   scriptId (Runtime.compileScript in the isolated world).

import { isRecord } from "../../shared/json.ts";
import type { Headers } from "../../bundle/types.ts";
import { FETCH_MARKER, type FetchCredentials } from "../fetch/spec.ts";

export { FETCH_MARKER };

/** One fetch the recorder should attribute: its id, its command window, where it runs, how to recognise it. */
export type FetchReg = {
  fetchId: string;
  cmd: string | null;
  /** CDP session of the tab the helper runs in. */
  sessionId: string;
  /** The marker value the helper sends (same-origin), or null. */
  marker: string | null;
  /** The helper's unique function name (initiator fallback). */
  fnName: string;
  /** Runtime.compileScript's scriptId of the helper; set before the script runs. */
  scriptId: string | null;
  /** 0.6-P: the fetch()'s credentials mode, written on every request of the fetch (`fetchCredentials`). */
  credentials: FetchCredentials;
};

/** The marker value in a CDP headers object (any name case), or null. */
export function markerOf(headers: unknown): string | null {
  if (!isRecord(headers)) return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === FETCH_MARKER && typeof v === "string") return v;
  return null;
}

/** Headers without the marker (recorded request headers: what the server got). */
export function withoutMarker(h: Headers): Headers {
  if (!Object.keys(h).some((k) => k.toLowerCase() === FETCH_MARKER)) return h;
  return Object.fromEntries(Object.entries(h).filter(([k]) => k.toLowerCase() !== FETCH_MARKER));
}

/** Fetch.continueRequest `headers`: the paused request's headers minus the marker. */
export function continueHeaders(headers: unknown): Array<{ name: string; value: string }> {
  if (!isRecord(headers)) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(headers)) if (typeof value === "string" && name.toLowerCase() !== FETCH_MARKER) out.push({ name, value });
  return out;
}

/** Call frames of an initiator stack and its async parents (at most 8 levels). */
function frames(init: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let st: unknown = init["stack"];
  for (let depth = 0; isRecord(st) && depth < 8; depth++, st = st["parent"]) {
    if (Array.isArray(st["callFrames"])) for (const f of st["callFrames"]) if (isRecord(f)) out.push(f);
  }
  return out;
}

/** The registration whose helper function (name and scriptId) is on the initiator stack, or null. */
export function initiatorMatch(initiator: unknown, regs: Iterable<FetchReg>, sessionId: string): FetchReg | null {
  if (!isRecord(initiator)) return null;
  const fs = frames(initiator);
  if (fs.length === 0) return null;
  for (const r of regs) {
    if (r.sessionId !== sessionId || r.scriptId === null) continue;
    if (fs.some((f) => f["functionName"] === r.fnName && f["scriptId"] === r.scriptId)) return r;
  }
  return null;
}
