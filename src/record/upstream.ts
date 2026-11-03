// How the record proxy reaches the real hosts (0.9-F, docs/04 §50.2
// `--upstream env|none|<URL>`). `env` reads the proxy variables the child
// would have used before tabcap rewrote them: https targets lowercase
// https_proxy then HTTPS_PROXY, http targets http_proxy then HTTP_PROXY, then
// all_proxy / ALL_PROXY; the original no_proxy / NO_PROXY sends matching hosts
// direct. Only http:// upstream proxies are supported; https:// and socks are
// `unsupported` before the child starts. Credentials in an env proxy URL
// become Proxy-Authorization: Basic; credentials in `--upstream <URL>` are
// refused (never in argv, AGENTS.md). Labels never carry credentials.
// Upstream TLS: Bun's root certificates plus `--upstream-ca`; never disabled.
// Oracle: docs/04 §50.2 and the curl / Python no_proxy behaviour it names;
// test/unit/record-upstream.test.ts. Reproduce: bun test test/unit/record-upstream.test.ts

import net from "node:net";
import tls from "node:tls";
import { TabcapError } from "../shared/envelope.ts";

export type ProxyRoute = { kind: "direct" } | { kind: "http"; host: string; port: number; auth: string | null; label: string };
export type UpstreamSpec = { kind: "env" } | { kind: "none" } | { kind: "url"; url: string };

export const CONNECT_TIMEOUT_MS = 30_000;

/** An upstream failure, sorted the way the 502 header and the answer name it. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: "upstream-dns" | "upstream-connect" | "upstream-tls",
    message: string,
  ) {
    super(message);
  }
}

/** Parse a proxy URL; credentials only where allowed (env values). */
export function parseProxyUrl(value: string, where: string, allowAuth: boolean): ProxyRoute {
  let u: URL;
  try {
    u = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new TabcapError("usage", `${where}: not a proxy URL`, "Give http://host:port.");
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http") {
    throw new TabcapError("unsupported", `${where}: ${scheme}:// upstream proxies are not supported (only http://)`, "Use --upstream none, or an http:// proxy (docs/04 §50.2).");
  }
  const hasAuth = u.username !== "" || u.password !== "";
  if (hasAuth && !allowAuth) {
    throw new TabcapError("usage", `${where}: the proxy URL holds a user name or password; credentials never go on the command line`, "Put the proxy URL in HTTPS_PROXY / HTTP_PROXY of the shell and use --upstream env (the default).");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port === "" ? 80 : Number(u.port);
  const auth = hasAuth ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : null;
  return { kind: "http", host, port, auth, label: `http://${u.host}` };
}

/** True when `host` (no port) matches a no_proxy list: `*`, exact names, domain suffixes (leading dot optional), exact IPs. */
export function noProxyMatch(list: string, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  for (const raw of list.split(",")) {
    let e = raw.trim().toLowerCase();
    if (e === "") continue;
    if (e === "*") return true;
    let ePort: number | null = null;
    const m = /^(.*):(\d+)$/.exec(e);
    if (m !== null && !e.startsWith("[") && (m[1] ?? "").includes(":") === false) {
      e = m[1] ?? "";
      ePort = Number(m[2]);
    } else if (e.startsWith("[")) {
      const b = /^\[(.*)\](?::(\d+))?$/.exec(e);
      if (b !== null) {
        e = b[1] ?? "";
        ePort = b[2] === undefined ? null : Number(b[2]);
      }
    }
    if (ePort !== null && ePort !== port) continue;
    e = e.replace(/^\*\./, ".").replace(/\.$/, "");
    const bare = e.startsWith(".") ? e.slice(1) : e;
    if (bare === "") continue;
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

export type Router = {
  route: (scheme: "http" | "https", host: string, port: number) => ProxyRoute;
  /** For the answer: direct, http://h:p, env direct or env http://h:p (the https route without no_proxy). */
  label: string;
};

const pick = (env: Readonly<Record<string, string | undefined>>, ...names: string[]): { name: string; value: string } | null => {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v.trim() !== "") return { name: n, value: v.trim() };
  }
  return null;
};

/** The router for an `--upstream` choice; `env` is the child's environment before tabcap rewrote it. */
export function makeRouter(spec: UpstreamSpec, env: Readonly<Record<string, string | undefined>>): Router {
  if (spec.kind === "none") return { route: () => ({ kind: "direct" }), label: "direct" };
  if (spec.kind === "url") {
    const r = parseProxyUrl(spec.url, "--upstream", false);
    return { route: () => r, label: r.kind === "http" ? r.label : "direct" };
  }
  const httpsVar = pick(env, "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY");
  const httpVar = pick(env, "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
  const httpsRoute: ProxyRoute = httpsVar === null ? { kind: "direct" } : parseProxyUrl(httpsVar.value, httpsVar.name, true);
  const httpRoute: ProxyRoute = httpVar === null ? { kind: "direct" } : parseProxyUrl(httpVar.value, httpVar.name, true);
  const noProxy = pick(env, "no_proxy", "NO_PROXY")?.value ?? "";
  return {
    route: (scheme, host, port) => {
      if (noProxy !== "" && noProxyMatch(noProxy, host, port)) return { kind: "direct" };
      return scheme === "https" ? httpsRoute : httpRoute;
    },
    label: `env ${httpsRoute.kind === "http" ? httpsRoute.label : "direct"}`,
  };
}

function classify(e: unknown, stage: "connect" | "tls"): UpstreamError {
  if (e instanceof UpstreamError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as { code?: unknown }).code;
  const c = typeof code === "string" ? code : "";
  if (c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "EAI_NONAME" || c === "EAI_FAIL") return new UpstreamError("upstream-dns", err.message);
  if (stage === "tls" || /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|HOSTNAME|ERR_TLS/i.test(c)) return new UpstreamError("upstream-tls", err.message);
  return new UpstreamError("upstream-connect", err.message);
}

/** A TCP connection, rejecting on error or after CONNECT_TIMEOUT_MS. */
export function openTcp(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new UpstreamError("upstream-connect", `connect to ${host}:${port} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      reject(classify(e, "connect"));
    });
  });
}

/** Open a CONNECT tunnel to host:port through an http proxy. */
export async function openTunnel(route: Extract<ProxyRoute, { kind: "http" }>, host: string, port: number): Promise<net.Socket> {
  const s = await openTcp(route.host, route.port);
  const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${route.auth === null ? "" : `Proxy-Authorization: ${route.auth}\r\n`}\r\n`);
  return await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new UpstreamError("upstream-connect", `upstream proxy ${route.label} did not answer CONNECT within ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 65536) fail(new UpstreamError("upstream-connect", `upstream proxy ${route.label} sent an oversized CONNECT answer`));
        return;
      }
      clearTimeout(timer);
      s.off("data", onData);
      s.off("error", fail);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"));
      const code = status === null ? 0 : Number(status[1]);
      if (code < 200 || code > 299) {
        s.destroy();
        reject(new UpstreamError("upstream-connect", `upstream proxy ${route.label} answered CONNECT ${target} with ${code === 0 ? "a malformed status line" : code}`));
        return;
      }
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) s.unshift(rest);
      resolve(s);
    };
    const fail = (e: unknown) => {
      clearTimeout(timer);
      s.destroy();
      reject(classify(e, "connect"));
    };
    s.on("data", onData);
    s.once("error", fail);
  });
}

/** TLS to the real host over `socket` (null: a new TCP connection), verified against Bun's roots plus `extraCa`. */
export function openTls(socket: net.Socket | null, host: string, port: number, extraCa: readonly string[]): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const servername = net.isIP(host) === 0 ? host : undefined;
    const opts: tls.ConnectionOptions = {
      ...(socket === null ? { host, port } : { socket }),
      ...(servername === undefined ? {} : { servername }),
      ca: [...tls.rootCertificates, ...extraCa],
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: true,
    };
    const t = tls.connect(opts);
    const timer = setTimeout(() => {
      t.destroy();
      reject(new UpstreamError("upstream-connect", `TLS to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);
    t.once("secureConnect", () => {
      clearTimeout(timer);
      t.removeAllListeners("error");
      if (!t.authorized) {
        t.destroy();
        reject(new UpstreamError("upstream-tls", `certificate of ${host} not trusted: ${String(t.authorizationError ?? "unknown")}`));
        return;
      }
      resolve(t);
    });
    t.once("error", (e) => {
      clearTimeout(timer);
      reject(classify(e, socket === null ? "connect" : "tls"));
    });
  });
}
