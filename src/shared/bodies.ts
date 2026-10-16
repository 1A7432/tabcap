// Which response bodies a recording stores (0.6-I, owner design 10-16):
// `net start --bodies all|api|api+script|none`, default config.json
// `record.bodies`, else `all` (docs/04 keeps "bodies are evidence"). Skipped
// bodies are never asked from Chrome; their request events carry
// `response.body: {skipped: "resource-type"}` and the manifest records the
// mode as `record.bodies` (docs/04 §5.2, §7).
//
//   type                                                    all  api+script  api  none
//   document xhr fetch websocket eventsource manifest other  yes  yes         yes  no
//   script                                                  yes  yes         no   no
//   image font stylesheet media (static)                    yes  no          no   no

import type { ResourceType } from "../bundle/types.ts";
import { TabcapError } from "./envelope.ts";

export type BodiesMode = "all" | "api" | "api+script" | "none";

export const BODIES_MODES: readonly BodiesMode[] = ["all", "api", "api+script", "none"];
export const BODIES_DEFAULT: BodiesMode = "all";

/** Static resources: metadata only under `api` and `api+script`. */
export const STATIC_TYPES: ReadonlySet<string> = new Set(["image", "font", "stylesheet", "media"]);

/** Why a body was skipped (the only reason so far). */
export const SKIPPED_REASON = "resource-type";

/** Pure: does a recording in `mode` store the response body of a `type` request? */
export function keepsBody(mode: BodiesMode, type: ResourceType | string): boolean {
  if (mode === "all") return true;
  if (mode === "none") return false;
  if (STATIC_TYPES.has(type)) return false;
  if (type === "script") return mode === "api+script";
  return true;
}

export function isBodiesMode(v: unknown): v is BodiesMode {
  return typeof v === "string" && (BODIES_MODES as readonly string[]).includes(v);
}

/** Parse a mode from the command line or config.json; anything else is an error naming where it came from. */
export function parseBodiesMode(v: unknown, where: "flag" | "config"): BodiesMode {
  if (isBodiesMode(v)) return v;
  const shown = typeof v === "string" ? JSON.stringify(v.slice(0, 100)) : String(JSON.stringify(v));
  if (where === "flag") throw new TabcapError("usage", `--bodies ${shown}?`, "Use --bodies all | api | api+script | none.");
  throw new TabcapError("bad-input", "config.json record.bodies is invalid", 'Set record.bodies to "all", "api", "api+script" or "none", or remove it for the default (all).');
}
