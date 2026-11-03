// `tabcap record -o <bundle> -- <cmd>` and the proxy half of
// `replay serve <bundle> -- <cmd>` (0.9-F, docs/04 §50.2 / §50.3).
// record: an ephemeral CA, the record proxy, the child with its proxy and CA
// variables rewritten (both cases of the proxy variables, ALL_PROXY dropped,
// NO_PROXY emptied, four CA variables); the exchanges go into the bundle in
// arrival order; the temporary directory (the CA certificate) is removed
// whatever happens. tabcap's own exit code is 0; the child's is in the answer.
// replay: the same proxy, but its only upstream is the replay server's port;
// it never resolves or dials anything else.
// Oracle: docs/04 §50; test/unit/record-run.test.ts, s76 (docs/05 §20).
// Reproduce: bun test test/unit/record-run.test.ts

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BundleWriter } from "../bundle/writer.ts";
import { TOOL_NAME, TOOL_VERSION } from "../bundle/manifest.ts";
import { TabcapError } from "../shared/envelope.ts";
import { RecordWriter } from "./bundle.ts";
import { startRecordProxy, type Connector, type ProxyStats, type RecordProxy } from "./proxy.ts";
import { makeRouter, openTcp, openTls, openTunnel, type Router, type UpstreamSpec } from "./upstream.ts";
import { createAuthority, type CertAuthority } from "./x509.ts";

export const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;
export const CA_VARS = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] as const;
const KILL_GRACE_MS = 5000;

/** The child's environment: `base` with the proxy and CA variables rewritten (docs/04 §50.2). */
export function childEnv(base: Readonly<Record<string, string | undefined>>, proxyUrl: string, caFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const k of ["ALL_PROXY", "all_proxy"]) delete env[k];
  for (const k of PROXY_VARS) env[k] = proxyUrl;
  env["NO_PROXY"] = "";
  env["no_proxy"] = "";
  for (const k of CA_VARS) env[k] = caFile;
  env["TABCAP_RECORD_PROXY"] = proxyUrl;
  env["TABCAP_CA_FILE"] = caFile;
  return env;
}

/** The record connector: the real hosts, as the router says, verified against Bun's roots plus `extraCa`. */
export function recordConnector(router: Router, extraCa: readonly string[]): Connector {
  return {
    connect: async (t) => {
      const r = router.route(t.scheme, t.host, t.port);
      if (t.scheme === "https") {
        const via = r.kind === "http" ? await openTunnel(r, t.host, t.port) : null;
        const s = await openTls(via, t.host, t.port, extraCa);
        return { socket: s, remote: { ip: s.remoteAddress ?? null, port: s.remotePort ?? null }, absoluteForm: false, proxyAuth: null };
      }
      if (r.kind === "http") {
        const s = await openTcp(r.host, r.port);
        return { socket: s, remote: { ip: s.remoteAddress ?? null, port: s.remotePort ?? null }, absoluteForm: true, proxyAuth: r.auth };
      }
      const s = await openTcp(t.host, t.port);
      return { socket: s, remote: { ip: s.remoteAddress ?? null, port: s.remotePort ?? null }, absoluteForm: false, proxyAuth: null };
    },
    rawTunnel: async (host, port) => {
      const r = router.route("https", host, port);
      return r.kind === "http" ? await openTunnel(r, host, port) : await openTcp(host, port);
    },
  };
}

/** The replay connector: every request goes to the replay server; nothing else is ever dialled (docs/04 §50.3). */
export function replayConnector(servePort: number): Connector {
  return {
    connect: async () => {
      const s = await openTcp("127.0.0.1", servePort);
      return { socket: s, remote: { ip: "127.0.0.1", port: servePort }, absoluteForm: false, proxyAuth: null };
    },
    rawTunnel: null,
  };
}

type Child = { exitCode: number; signal: string | null };

/** Run the child with `env`, forwarding SIGINT / SIGTERM; `timeoutSec`: SIGINT, then SIGKILL after 5 s. */
async function runChild(command: readonly string[], env: Record<string, string>, timeoutSec: number | undefined): Promise<Child> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...command], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    throw new TabcapError("not-found", `cannot start ${JSON.stringify(command[0] ?? "")}: ${e instanceof Error ? e.message : String(e)}`, "Check the command after `--` (is it on PATH?).");
  }
  const forward = (sig: NodeJS.Signals) => () => {
    try {
      proc.kill(sig);
    } catch {
      // already gone
    }
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer =
    timeoutSec === undefined
      ? null
      : setTimeout(() => {
          onInt();
          killTimer = setTimeout(() => forward("SIGKILL")(), KILL_GRACE_MS);
        }, timeoutSec * 1000);
  try {
    await proc.exited;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (timer !== null) clearTimeout(timer);
    if (killTimer !== null) clearTimeout(killTimer);
  }
  const sc = proc.signalCode ?? null;
  const signal = sc === null ? null : String(sc);
  const num = typeof sc === "number" ? sc : signal === null ? null : (osConstants.signals as Record<string, number | undefined>)[signal];
  return { exitCode: proc.exitCode ?? (num === undefined || num === null ? 1 : 128 + num), signal };
}

export type ProxyAnswerParts = { tunnels: number; websockets: number; tlsRefused: number; failed: number; warnings: string[] };

/** The warning lines and counts every run reports from the proxy's stats. */
export function statsReport(stats: ProxyStats): ProxyAnswerParts {
  const warnings: string[] = [];
  for (const [k, n] of stats.upstreamFailures) warnings.push(`${n} request(s) failed upstream: ${k} (the client got a 502 with x-tabcap-record-error)`);
  for (const [host, msg] of stats.tlsRefused) warnings.push(`the client refused the TLS handshake for ${host} (${msg}): it does not trust the run's CA (own CA bundle, pinning) or offers no http/1.1`);
  for (const [k, n] of stats.tunnels) warnings.push(`${n} non-TLS tunnel(s) to ${k} passed through unrecorded`);
  if (stats.websockets > 0) warnings.push(`${stats.websockets} WebSocket connection(s): the handshakes are recorded, the frames are not (docs/04 §50.1)`);
  const tunnels = [...stats.tunnels.values()].reduce((a, b) => a + b, 0);
  return { tunnels, websockets: stats.websockets, tlsRefused: stats.tlsRefused.size, failed: stats.failed, warnings };
}

export const RECORD_NOTES = [
  "the sites saw tabcap's (Bun's) TLS ClientHello, not the client's own: on protected sites the recorded traffic can differ from what the script gets when it connects directly",
  "clients that ignore the proxy variables are not recorded: aiohttp (trust_env defaults to False), code with hard-coded proxies= or its own verify= CA file; give them TABCAP_RECORD_PROXY / TABCAP_CA_FILE",
];

export type RecordOptions = {
  out: string;
  command: readonly string[];
  upstream: UpstreamSpec;
  upstreamCa: readonly string[];
  name?: string | undefined;
  site?: string | undefined;
  port?: number;
  timeoutSec?: number | undefined;
  /** The environment the child would have had (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
};

export type RecordAnswer = {
  bundle: string;
  requests: number;
  events: number;
  exitCode: number;
  proxy: string;
  upstream: string;
  failed: number;
  tunnels: number;
  websockets: number;
  tlsRefused: number;
  typeInferred: { "sec-fetch": number; "content-type": number };
  durationMs: number;
  notes: string[];
  warnings: string[];
};

function readCaFiles(files: readonly string[]): string[] {
  return files.map((f) => {
    if (!existsSync(f)) throw new TabcapError("not-found", `--upstream-ca ${f}: no such file`, "Give a PEM file with the CA certificate(s) to trust upstream.");
    const text = readFileSync(f, "utf8");
    if (!text.includes("-----BEGIN CERTIFICATE-----")) throw new TabcapError("bad-input", `--upstream-ca ${f}: no PEM certificate in it`, "Give a PEM file (-----BEGIN CERTIFICATE-----).");
    return text;
  });
}

/** A 0700 temporary directory holding the CA certificate (0600); removed by `cleanup`. */
function writeCaFile(ca: CertAuthority): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tabcap-record-"));
  const file = join(dir, "ca.pem");
  writeFileSync(file, ca.certPem, { mode: 0o600 });
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function record(opts: RecordOptions): Promise<RecordAnswer> {
  const started = performance.now();
  if (opts.command.length === 0) throw new TabcapError("usage", "missing the command to record after `--`", "Usage: tabcap record -o <bundle> -- <command> [args…]");
  const createdOut = !existsSync(opts.out);
  if (!createdOut && readdirSync(opts.out).length > 0) throw new TabcapError("conflict", `output directory is not empty: ${opts.out}`, "Pick a new directory for the recording.");
  const baseEnv = opts.env ?? process.env;
  const router = makeRouter(opts.upstream, baseEnv);
  const extraCa = readCaFiles(opts.upstreamCa);
  const runId = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
  const ca = await createAuthority(runId);
  const caFile = writeCaFile(ca);
  let proxy: RecordProxy | null = null;
  let w: BundleWriter | null = null;
  let childRan = false;
  try {
    w = await BundleWriter.open(opts.out, {
      init: {
        producer: { tool: TOOL_NAME, version: TOOL_VERSION, browser: null },
        session: { name: opts.name ?? "record", site: opts.site ?? null, tabs: [{ tab: "t1", chromeTabId: null, owned: false, firstUrl: null }] },
        mode: { capture: "passive", trace: false, raw: false, humanRecorder: false },
      },
    });
    const rw = new RecordWriter(w);
    proxy = await startRecordProxy({ port: opts.port ?? 0, ca, connector: recordConnector(router, extraCa), onExchange: (x) => rw.add(x) });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const child = await runChild(opts.command, childEnv(baseEnv, proxyUrl, caFile.file), opts.timeoutSec);
    childRan = true;
    await proxy.stop();
    const stats = proxy.stats;
    proxy = null;
    await rw.settle(stats.requests);
    const client = basename(opts.command[0] ?? "");
    w.updateManifest((m) => {
      m["capture"] = { via: "record", client, ca: "ephemeral", upstream: router.label };
    });
    const manifest = await w.close();
    w = null;
    const rep = statsReport(stats);
    const warnings = [...rep.warnings];
    if (rw.written === 0) warnings.unshift("no request was recorded: the client may ignore the proxy variables (aiohttp without trust_env, hard-coded proxies=), or speak something other than HTTP/1.1 over the proxy");
    return {
      bundle: opts.out,
      requests: rw.written,
      events: manifest.counts.events,
      exitCode: child.exitCode,
      proxy: `127.0.0.1:${new URL(proxyUrl).port}`,
      upstream: router.label,
      failed: rep.failed,
      tunnels: rep.tunnels,
      websockets: rep.websockets,
      tlsRefused: rep.tlsRefused,
      typeInferred: rw.typeInferred,
      durationMs: Math.round(performance.now() - started),
      notes: RECORD_NOTES,
      warnings,
    };
  } finally {
    if (proxy !== null) await proxy.stop().catch(() => undefined);
    if (w !== null) await w.close({ finished: null }).catch(() => undefined);
    // a run that failed before the command ran (no free port, a command that cannot start) leaves no bundle it created;
    // once the command has run, whatever was written stays (evidence), unfinished
    if (!childRan && createdOut) rmSync(opts.out, { recursive: true, force: true });
    caFile.cleanup();
  }
}

export type ReplayRun = { exitCode: number; signal: string | null; proxy: string; stats: ProxyStats };

/** `replay serve … -- <cmd>`: the child runs against the replay server through the replay proxy. */
export async function runAgainstReplay(o: { servePort: number; command: readonly string[]; env?: Readonly<Record<string, string | undefined>>; port?: number }): Promise<ReplayRun> {
  const runId = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
  const ca = await createAuthority(runId);
  const caFile = writeCaFile(ca);
  let proxy: RecordProxy | null = null;
  try {
    proxy = await startRecordProxy({ port: o.port ?? 0, ca, connector: replayConnector(o.servePort) });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const child = await runChild(o.command, childEnv(o.env ?? process.env, proxyUrl, caFile.file), undefined);
    await proxy.stop();
    const stats = proxy.stats;
    proxy = null;
    return { ...child, proxy: `127.0.0.1:${new URL(proxyUrl).port}`, stats };
  } finally {
    if (proxy !== null) await proxy.stop().catch(() => undefined);
    caFile.cleanup();
  }
}
