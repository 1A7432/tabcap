// `tabcap wire serve | version | ca-path`: run in the CLI process (no daemon).
// `wire profile` and `wire probe` need the browser and go to the daemon
// (src/daemon/tools/wire.ts); their `--text` is rendered in src/cli/handlers.ts.

import { ok, type Envelope } from "../shared/envelope.ts";
import type { Paths } from "../shared/paths.ts";
import { caPath } from "../wire/certs.ts";
import { Echo } from "../wire/echo.ts";
import { Wireprint } from "../wire/native.ts";
import { TabcapError } from "../shared/envelope.ts";

type Outcome = { code: number; envelope: Envelope<unknown>; text?: string };

export async function wireVersion(p: Paths): Promise<unknown> {
  const wp = await Wireprint.locate({ cacheDir: p.cache });
  return { component: await wp.version(), path: wp.path, sha256: wp.sha256, source: wp.source, target: wp.target };
}

export function wireCaPath(p: Paths): unknown {
  return { path: caPath(p.cache) };
}

/** Echo on 127.0.0.1 until Ctrl-C: prints one envelope at start, then one line per report on stderr. */
export async function wireServe(p: Paths, args: Record<string, unknown>): Promise<Outcome> {
  const port = typeof args["port"] === "number" ? args["port"] : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TabcapError("usage", `bad --port ${port}`, "Pass 0-65535 (0 = any free port).");
  const captureDir = typeof args["captureDir"] === "string" ? args["captureDir"] : null;
  const wp = await Wireprint.locate({ cacheDir: p.cache });
  const echo = await Echo.start({ wireprint: wp, port, captureDir, log: (line) => process.stderr.write(line + "\n") });
  const info = { url: echo.url("/"), port: echo.port, caPath: caPath(p.cache), captureDir, component: { version: await wp.version(), path: wp.path } };
  process.stdout.write(JSON.stringify(ok(info)) + "\n");
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  const stats = { ...echo.stats };
  await echo.stop();
  process.stderr.write(`stopped after ${stats.reports} report(s)\n`);
  return { code: -1, envelope: ok({ stopped: true, ...stats }) };
}
