// Decoded views (0.6-B, docs/04 §26): plaintext a decode plugin produced from
// a request or response body, stored as a blob beside the original and
// referenced from the `request` event as `request.decoded` /
// `response.decoded`:
//   {by, version, direction, mime, blob, bytes, ok, error?, note?}
// `ok: false` records that the plugin was asked and could not decode (blob
// and bytes null, `error` says why). The original body is never changed.
// Readers treat the field as untrusted: a malformed one is ignored.

import { isBlobRef } from "../shared/ids.ts";
import { isRecord, num, str } from "../shared/json.ts";

export type DecodedView = {
  by: string;
  version: string;
  direction: "request" | "response";
  mime: string | null;
  blob: string | null;
  bytes: number | null;
  /** True only when the view has a blob to read. */
  ok: boolean;
  error?: string;
  note?: string;
};

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The `decoded` field of a request / response side, or undefined when absent or malformed. */
export function parseDecoded(v: unknown): DecodedView | undefined {
  if (!isRecord(v)) return undefined;
  const by = str(v, "by");
  const direction = v["direction"];
  if (by === null || !NAME.test(by) || (direction !== "request" && direction !== "response") || typeof v["ok"] !== "boolean") return undefined;
  const blob = isBlobRef(v["blob"]) ? v["blob"] : null;
  const ok = v["ok"] && blob !== null;
  const error = str(v, "error") ?? (ok ? null : "not decoded");
  const note = str(v, "note");
  return {
    by,
    version: str(v, "version") ?? "",
    direction,
    mime: str(v, "mime"),
    blob,
    bytes: num(v, "bytes"),
    ok,
    ...(error === null ? {} : { error }),
    ...(note === null ? {} : { note }),
  };
}

/** `{decoded}` to spread into a parsed side, or {} when there is none. */
export function decodedOf(v: unknown): { decoded?: DecodedView } {
  const d = parseDecoded(v);
  return d === undefined ? {} : { decoded: d };
}
