// The probe page's server (0.4-G), loopback only: `fingerprint serve` (CLI,
// references) and the transient one of `fingerprint probe` (daemon, port 0).
//   GET  /             probe.html, with a per-start token
//   POST /probe        {token, fields} → normalized fields (every load posts here)
//   POST /ref/<name>   {token, fields} → saved reference (serve only)
// Posts must carry the token of this start, `content-type: application/json`
// (a cross-origin page cannot send that without a preflight this server never
// answers), a loopback Host of this port and, when present, this Origin.

import { randomBytes } from "node:crypto";
import PROBE_ASSET from "./probe.html" with { type: "text" };
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, tryParseJson } from "../shared/json.ts";
import { normalizeFields, type Field } from "./fields.ts";
import { checkRefName } from "./refs.ts";

export const BODY_MAX = 256 * 1024;

// bun-types describes *.html imports as HTML bundles; with type "text" the import is the file's text.
const PROBE_TEXT: unknown = PROBE_ASSET;
export const PROBE_HTML: string = typeof PROBE_TEXT === "string" ? PROBE_TEXT : "";

export type ProbeServerOpts = {
  port: number;
  mode: "serve" | "probe";
  /** Every accepted POST /probe. */
  onProbe?: (fields: Field[], dropped: string[]) => void;
  /** POST /ref/<name> (serve mode): save and describe the result, or throw a TabcapError. */
  onRef?: (name: string, fields: Field[], dropped: string[]) => Record<string, unknown>;
};

export type ProbeServer = { url: string; port: number; stop: () => void };

/** The page as served: token and mode filled in. */
export function probePage(token: string, mode: "serve" | "probe"): string {
  return PROBE_HTML.replace("__TABCAP_TOKEN__", token).replace("__TABCAP_MODE__", mode);
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function startProbeServer(o: ProbeServerOpts): ProbeServer {
  const token = randomBytes(16).toString("hex");
  const page = probePage(token, o.mode);
  let origin = "";
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: o.port,
      maxRequestBodySize: BODY_MAX,
      async fetch(req) {
        const url = new URL(req.url);
        const host = req.headers.get("host");
        if (host !== new URL(origin).host && host !== `localhost:${new URL(origin).port}`) return json(421, { error: "wrong host" });
        if (req.method === "GET" && url.pathname === "/") {
          return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP, "referrer-policy": "no-referrer" } });
        }
        if (req.method === "GET" && url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
        const isRef = url.pathname.startsWith("/ref/");
        if (req.method !== "POST" || (url.pathname !== "/probe" && !isRef)) return json(404, { error: "not found" });
        if (isRef && o.mode !== "serve") return json(404, { error: "references are saved through `tabcap fingerprint serve`" });
        const from = req.headers.get("origin");
        if (from !== null && from !== origin && from !== origin.replace("127.0.0.1", "localhost")) return json(403, { error: "cross-origin post refused" });
        if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
        const body = tryParseJson(await req.text());
        if (!isRecord(body) || body["token"] !== token) return json(403, { error: "unknown token: reload the page" });
        let n: { fields: Field[]; dropped: string[] };
        try {
          n = normalizeFields(body["fields"]);
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
        if (!isRef) {
          o.onProbe?.(n.fields, n.dropped);
          return json(200, { fields: n.fields, dropped: n.dropped });
        }
        let name: string;
        try {
          name = checkRefName(decodeURIComponent(url.pathname.slice("/ref/".length)));
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
        if (o.onRef === undefined) return json(404, { error: "not found" });
        try {
          return json(200, o.onRef(name, n.fields, n.dropped));
        } catch (e) {
          return json(e instanceof TabcapError && e.code === "conflict" ? 409 : 500, { error: e instanceof Error ? e.message : String(e) });
        }
      },
    });
  } catch (e) {
    throw new TabcapError("io", `cannot listen on 127.0.0.1:${o.port}: ${e instanceof Error ? e.message : String(e)}`, "Pick another --port, or 0 for any free port.");
  }
  origin = `http://127.0.0.1:${server.port}`;
  return { url: `${origin}/`, port: server.port ?? 0, stop: () => void server.stop(true) };
}
