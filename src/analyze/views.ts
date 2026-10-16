// Decoded views for the analysis commands (0.6-B, docs/04 §28). A request or
// response side whose `decoded` view is ok is read from the plugin's
// plaintext instead of the original bytes, with `plugin:<name>` as the first
// decode step; `find`, `where`, `deps`, `recon` and `replay check` all go
// through here. A view whose blob is missing or over the step cap is not
// used (the original is read, as before 0.6-B).
// Oracle: test/unit/decode-views.test.ts (bundles with planted views).

import type { DecodedView } from "../bundle/decoded.ts";
import { STEP_CAP, pluginStep, type StepName } from "./decoders.ts";

export type ViewPayload = { bytes: Uint8Array; mime: string | null; prefix: StepName[]; by: string };

/** The plaintext of an ok decoded view, or null (none, not ok, blob missing, too large). */
export function decodedPayload(reader: { readBlob(ref: string): Uint8Array | null }, d: DecodedView | undefined): ViewPayload | null {
  if (d === undefined || !d.ok || d.blob === null) return null;
  const bytes = reader.readBlob(d.blob);
  if (bytes === null || bytes.length > STEP_CAP) return null;
  return { bytes, mime: d.mime, prefix: [pluginStep(d.by)], by: d.by };
}

/** Why an ok view could not be read (find's `searched.skipped`), or null when it can be / there is none. */
export function viewProblem(reader: { readBlob(ref: string): Uint8Array | null }, d: DecodedView | undefined): { reason: "blob-missing" | "too-large"; detail: string } | null {
  if (d === undefined || !d.ok || d.blob === null) return null;
  const bytes = reader.readBlob(d.blob);
  if (bytes === null) return { reason: "blob-missing", detail: `decoded view ${d.blob}` };
  if (bytes.length > STEP_CAP) return { reason: "too-large", detail: `decoded view ${bytes.length} bytes` };
  return null;
}
