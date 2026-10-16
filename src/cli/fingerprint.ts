// `tabcap fingerprint serve | ref list|show|remove` (0.4-G): CLI-local,
// no daemon. `fingerprint probe` runs in the daemon (src/daemon/tools/fingerprint.ts).
// Read-only analysis: nothing here changes a value in any page, and no output
// suggests how to make values match.

import { TabcapError, ok } from "../shared/envelope.ts";
import type { Paths } from "../shared/paths.ts";
import { nowMs } from "../shared/time.ts";
import { listRefs, loadRef, refsDir, removeRef, saveRef } from "../fingerprint/refs.ts";
import { startProbeServer } from "../fingerprint/server.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `fingerprint serve`: prints one envelope with the URL, then serves until Ctrl-C (or the first save with --once). */
export async function fingerprintServe(p: Paths, args: Record<string, unknown>): Promise<{ code: number; envelope: ReturnType<typeof ok> }> {
  const port = typeof args["port"] === "number" ? args["port"] : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TabcapError("usage", `bad --port ${port}`, "Pass 0-65535 (0 = any free port).");
  const once = args["once"] === true;
  const force = args["force"] === true;
  let saves = 0;
  let finish: (() => void) | null = null;
  const server = startProbeServer({
    port,
    mode: "serve",
    onRef: (name, fields, dropped) => {
      const r = saveRef(p.config, name, fields, { force, now: nowMs() });
      saves++;
      process.stderr.write(`saved reference ${name} (${fields.length} fields) to ${r.path}\n`);
      if (once) setTimeout(() => finish?.(), 200);
      return { saved: r.name, savedAt: r.savedAt, replaced: r.replaced, fields: fields.length, dropped };
    },
  });
  const info = { url: server.url, port: server.port, refs: refsDir(p.config), once, force };
  process.stdout.write(JSON.stringify(ok(info)) + "\n");
  process.stderr.write(`open ${server.url} in your own browser and press "Save as reference"; ${once ? "exits after the first save" : "Ctrl-C to stop"}\n`);
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    finish = done;
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  server.stop();
  // The envelope was printed at start; nothing more on stdout.
  return { code: -1, envelope: ok({ stopped: true, saves }) };
}

export function fingerprintRefList(p: Paths): unknown {
  return listRefs(p.config);
}

export function fingerprintRefShow(p: Paths, args: Record<string, unknown>): unknown {
  const r = loadRef(p.config, str(args["name"]) ?? "");
  return { name: r.name, path: r.path, schema: r.schema, savedAt: r.savedAt, userAgent: r.userAgent, fields: r.fields, ...(r.dropped.length > 0 ? { dropped: r.dropped } : {}) };
}

export function fingerprintRefRemove(p: Paths, args: Record<string, unknown>): unknown {
  return removeRef(p.config, str(args["name"]) ?? "");
}
