// Proxy pool helpers (0.4-D): parsing `proxy add --url`, what Chrome gets
// (`host:port` only, never credentials), the origin Chrome reports in
// Fetch.authRequired, the credentialed URL for clients outside the browser
// (generated Python client, `replay check --live`), and the health check.
// Oracle: spike 10-16 (CfT 155): `Target.createBrowserContext {proxyServer:
// "127.0.0.1:<P>"}` routes the context through the proxy; the 407 challenge
// arrives as `Fetch.authRequired {authChallenge: {source: "Proxy", origin:
// "http://127.0.0.1:<P>"}}`; Chrome's SOCKS5 greeting offers no-auth only (Q7).

import { TabcapError } from "../../shared/envelope.ts";
import { hostPort, type ProxyRow, type ProxyScheme } from "../store/db.ts";
import { proxyAfterCheck, type CheckOutcome } from "./rules.ts";
import type { ProxyCheckPatch } from "../store/db.ts";

const DEFAULT_PORT: Record<ProxyScheme, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

export type ParsedProxyUrl = { scheme: ProxyScheme; host: string; port: number };

/** `scheme://host:port` → parts. Credentials in the URL are refused (they would sit in argv and shell history). */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TabcapError("usage", "--url is not a URL (value not shown)", "Pass scheme://host:port, e.g. http://127.0.0.1:8080.");
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks4" && scheme !== "socks5") {
    throw new TabcapError("usage", `unsupported proxy scheme ${scheme}`, "Use http://, https://, socks4:// or socks5://.");
  }
  if (u.username !== "" || u.password !== "") {
    throw new TabcapError("usage", "credentials do not go in --url", "Pass --user <name> and the password with --password-stdin (or at the prompt).");
  }
  if ((u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") throw new TabcapError("usage", `--url must be scheme://host:port only`, "Drop the path, query and fragment.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new TabcapError("usage", "--url has no host", "Pass scheme://host:port.");
  return { scheme, host, port: u.port === "" ? DEFAULT_PORT[scheme] : Number(u.port) };
}

/** The `proxyServer` Chrome gets: `host:port` for HTTP proxies, `scheme://host:port` otherwise; never credentials. */
export function chromeProxyServer(p: Pick<ProxyRow, "scheme" | "host" | "port">): string {
  return p.scheme === "http" ? hostPort(p) : `${p.scheme}://${hostPort(p)}`;
}

/** `authChallenge.origin` of the proxy's 407, as Chrome reports it (lowercase scheme://host:port). */
export function proxyOrigin(p: Pick<ProxyRow, "scheme" | "host" | "port">): string {
  return `${p.scheme}://${hostPort(p)}`.toLowerCase();
}

/** Proxy URL with credentials, for clients outside the browser. A secret: never print it. */
export function proxyUrlWithAuth(p: Pick<ProxyRow, "scheme" | "host" | "port" | "username" | "password">): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "%27");
  const auth = p.username === null ? "" : `${enc(p.username)}${p.password === null ? "" : `:${enc(p.password)}`}@`;
  return `${p.scheme}://${auth}${hostPort(p)}`;
}

export const CHECK_TIMEOUT_MS = 10_000;

/** The HTTP client the checks use (Bun's fetch; tests pass a fake). */
export type HttpClient = (url: string, init: RequestInit & { proxy?: string }) => Promise<Response>;

export type CheckResult = CheckOutcome & { status: number | null; error: string | null };

/**
 * One request to `url` through the proxy. Success: any HTTP answer except
 * 407 (proxy authentication) and 5xx (proxy / gateway failures); a network
 * error or the timeout is a failure. Only HTTP(S) proxies can be checked
 * (Bun's fetch speaks no SOCKS): those return null and change nothing.
 */
export async function checkThrough(p: ProxyRow, url: string, fetchImpl: HttpClient = fetch, nowMs: () => number = () => performance.now()): Promise<CheckResult | null> {
  if (p.scheme !== "http" && p.scheme !== "https") return null;
  const t0 = nowMs();
  try {
    const res = await fetchImpl(url, { proxy: proxyUrlWithAuth(p), redirect: "manual", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    const latencyMs = Math.round(nowMs() - t0);
    const ok = res.status !== 407 && res.status < 500;
    return { ok, latencyMs, status: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: null, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Store update for a check result (null: unsupported scheme, nothing changes). */
export function patchFor(p: ProxyRow, r: CheckResult | null, now: number): ProxyCheckPatch {
  return r === null ? {} : proxyAfterCheck(p, r, now);
}
