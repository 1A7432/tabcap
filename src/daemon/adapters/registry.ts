// Adapter registry (docs/09 §9). Built-in adapters live in
// src/daemon/adapters/<name>/ and are embedded into the binary as text, then
// go through the same validation as an adapter read from disk
// (`loadAdapterDir`). Scope rule (AGENTS.md): each adapter maps to a range
// scenario or a real need of the author; 0.3-D ships `overlay` only.

import OVERLAY_MANIFEST from "./overlay/adapter.json" with { type: "json" };
import OVERLAY_SCRIPT from "./overlay/page.js" with { type: "text" };
import { parseAdapter, type Adapter } from "./manifest.ts";

let cache: Adapter[] | null = null;

export function builtinAdapters(): Adapter[] {
  if (cache === null) cache = [parseAdapter(OVERLAY_MANIFEST as unknown, OVERLAY_SCRIPT, "builtin:overlay", "overlay")];
  return cache;
}

export function adapterNamed(name: string, list: readonly Adapter[] = builtinAdapters()): Adapter | undefined {
  return list.find((a) => a.name === name);
}
