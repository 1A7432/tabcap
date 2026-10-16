// `tabcap wire probe`: the generated Python client against the browser
// baseline, on the local echo. This file holds the pure parts (the
// `tabcap-wire/0` result from the component's `check` and `diff` JSON, the
// text table, finding claims) and the `uv run client.py wire-report` call.
// The probe is diagnostic only: it says which layer differs on a local echo,
// never why a site refused anything and never how to change a value.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";

export const WIRE_SCHEMA = "tabcap-wire/0";
export const WIRE_NOTE = "differences are measured on a local echo; they say which layer differs, not why a site refused anything";

export type Layer = "tls" | "h2" | "headers";
export type Verdict = "same" | "differs" | "missing";
export type LayerResult = { layer: Layer; verdict: Verdict; fields: { field: string; browser: unknown; client: unknown }[] };
export type CheckItem = { code: string; status: string; message: string };

export type WireResult = {
  schema: typeof WIRE_SCHEMA;
  browser: { version: string; flagsHash: string; profile: string; cached: boolean };
  client: { library: string | null; version: string | null };
  layers: LayerResult[];
  checks: CheckItem[];
  labels: { label: string; browser: unknown; client: unknown }[];
  note: string;
};

const SECTION: Record<Layer, string> = { tls: "tls", h2: "http2", headers: "http" };

function sectionOf(path: string): string {
  const m = /^[^.[]+/.exec(path);
  return m === null ? path : m[0];
}

/**
 * Layers from the component's `diff --json <browser nav report> <client report>`
 * (pure). A layer the client report lacks entirely (no HTTP/2: `http2` null)
 * is `missing`; otherwise any difference makes it `differs`.
 */
export function layersOf(diff: Record<string, unknown>, browserReport: Record<string, unknown>, clientReport: Record<string, unknown>): LayerResult[] {
  const diffs = Array.isArray(diff["differences"]) ? diff["differences"].filter(isRecord) : [];
  return (["tls", "h2", "headers"] as const).map((layer) => {
    const sec = SECTION[layer];
    const b = browserReport[sec];
    const c = clientReport[sec];
    const fields = diffs
      .filter((d) => typeof d["path"] === "string" && sectionOf(d["path"]) === sec)
      .map((d) => ({ field: String(d["path"]), browser: d["a"] ?? null, client: d["b"] ?? null }));
    const missing = !isRecord(c) && isRecord(b);
    const verdict: Verdict = missing ? "missing" : fields.length > 0 ? "differs" : "same";
    return { layer, verdict, fields };
  });
}

/** `check` JSON findings as {code, status, message} (status = the component's severity: red | warn | info). */
export function checksOf(check: Record<string, unknown>): CheckItem[] {
  const f = Array.isArray(check["findings"]) ? check["findings"].filter(isRecord) : [];
  return f.map((x) => ({ code: String(x["rule"] ?? ""), status: String(x["severity"] ?? ""), message: String(x["message"] ?? "") }));
}

export function labelsOf(diff: Record<string, unknown>): WireResult["labels"] {
  const l = Array.isArray(diff["labels"]) ? diff["labels"].filter(isRecord) : [];
  return l.map((x) => ({ label: String(x["label"] ?? ""), browser: x["a"] ?? null, client: x["b"] ?? null }));
}

/** "python-httpx/0.28.1" → {library, version}; anything else → the raw UA (or null) and null. */
export function clientOf(report: Record<string, unknown>): WireResult["client"] {
  const http = report["http"];
  const ua = isRecord(http) && typeof http["user_agent"] === "string" ? http["user_agent"] : null;
  if (ua === null) return { library: null, version: null };
  const m = /^([A-Za-z0-9_.-]+)\/([^\s]+)$/.exec(ua.trim());
  return m === null ? { library: ua, version: null } : { library: m[1] ?? null, version: m[2] ?? null };
}

/** One sentence per differing layer for the finding event (diagnostic wording only). */
export function claimOf(l: LayerResult): string {
  const name = l.layer === "tls" ? "TLS ClientHello" : l.layer === "h2" ? "HTTP/2 connection settings" : "request headers";
  if (l.verdict === "missing") return `wire probe: the client sent no ${name} layer where the browser baseline has one (measured on the local echo)`;
  const fields = l.fields.slice(0, 6).map((f) => f.field).join(", ");
  return `wire probe: ${name} differ between the generated client and the browser baseline on the local echo (${l.fields.length} field(s): ${fields}${l.fields.length > 6 ? ", …" : ""})`;
}

function short(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "null";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A daemon answer as a WireResult, or null when it is not one (the CLI then prints the JSON). */
export function wireResultOf(v: unknown): WireResult | null {
  if (!isRecord(v) || v["schema"] !== WIRE_SCHEMA || !isRecord(v["browser"]) || !isRecord(v["client"]) || !Array.isArray(v["layers"])) return null;
  const b = v["browser"];
  const c = v["client"];
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
  const layers: LayerResult[] = [];
  for (const l of v["layers"]) {
    if (!isRecord(l) || (l["layer"] !== "tls" && l["layer"] !== "h2" && l["layer"] !== "headers")) return null;
    const verdict = l["verdict"];
    if (verdict !== "same" && verdict !== "differs" && verdict !== "missing") return null;
    const fields = Array.isArray(l["fields"]) ? l["fields"].filter(isRecord).map((f) => ({ field: String(f["field"] ?? ""), browser: f["browser"] ?? null, client: f["client"] ?? null })) : [];
    layers.push({ layer: l["layer"], verdict, fields });
  }
  const checks = Array.isArray(v["checks"]) ? v["checks"].filter(isRecord).map((x) => ({ code: String(x["code"] ?? ""), status: String(x["status"] ?? ""), message: String(x["message"] ?? "") })) : [];
  const labels = Array.isArray(v["labels"]) ? v["labels"].filter(isRecord).map((x) => ({ label: String(x["label"] ?? ""), browser: x["browser"] ?? null, client: x["client"] ?? null })) : [];
  return {
    schema: WIRE_SCHEMA,
    browser: { version: str(b["version"]) ?? "?", flagsHash: str(b["flagsHash"]) ?? "", profile: str(b["profile"]) ?? "", cached: b["cached"] === true },
    client: { library: str(c["library"]), version: str(c["version"]) },
    layers,
    checks,
    labels,
    note: str(v["note"]) ?? WIRE_NOTE,
  };
}

/** `--text`: the result as a table. */
export function renderWireText(r: WireResult): string {
  const lines = [
    `wire probe: browser Chrome for Testing ${r.browser.version} (flags ${r.browser.flagsHash.slice(0, 12)}, ${r.browser.cached ? "cached" : "captured now"}) vs client ${r.client.library ?? "?"} ${r.client.version ?? ""}`.trimEnd(),
    "",
    `${"layer".padEnd(8)} ${"verdict".padEnd(8)} fields`,
  ];
  for (const l of r.layers) {
    lines.push(`${l.layer.padEnd(8)} ${l.verdict.padEnd(8)} ${l.fields.length === 0 ? "-" : `${l.fields.length}`}`);
    for (const f of l.fields.slice(0, 12)) lines.push(`  ${f.field.padEnd(44)} browser ${short(f.browser)}  client ${short(f.client)}`);
    if (l.fields.length > 12) lines.push(`  … ${l.fields.length - 12} more (JSON output has all)`);
  }
  for (const lb of r.labels) lines.push(`label ${lb.label}: browser ${short(lb.browser)}  client ${short(lb.client)}`);
  const red = r.checks.filter((c) => c.status === "red").map((c) => c.code);
  lines.push("", `checks against the profile: ${red.length === 0 ? "no red" : `red ${[...new Set(red)].join(", ")}`}`, `note: ${r.note}`);
  return lines.join("\n");
}

/**
 * The environment of the client run: the caller's, minus the generated
 * client's own proxy (TABCAP_PROXY_URL), with loopback excluded from any
 * proxy uv or httpx would pick up from the environment — the GET goes to
 * 127.0.0.1 only; uv may still use a proxy to install packages.
 */
export function clientEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "TABCAP_PROXY_URL" && k !== "VIRTUAL_ENV") env[k] = v;
  const loop = ["localhost", "127.0.0.1", "::1"];
  for (const k of ["NO_PROXY", "no_proxy"]) {
    const have = (env[k] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    env[k] = [...new Set([...have, ...loop])].join(",");
  }
  return env;
}

export function uvCommand(uv: string, url: string, ca: string, out: string): string[] {
  return [uv, "run", "client.py", "wire-report", "--url", url, "--ca", ca, "--out", out];
}

/** `uv run client.py wire-report …` in the generated package; resolves when it exits 0. */
export async function runClientReport(o: { client: string; url: string; ca: string; out: string; timeoutMs: number; env?: Record<string, string | undefined> }): Promise<void> {
  if (!existsSync(join(o.client, "client.py")) || !existsSync(join(o.client, "pyproject.toml"))) {
    throw new TabcapError("not-found", `${o.client} is not a generated client (no client.py / pyproject.toml)`, "Pass the directory written by `tabcap replay export-python <bundle> -o <dir>`.");
  }
  const uv = Bun.which("uv");
  if (uv === null) throw new TabcapError("not-found", "uv is not on PATH; the generated client runs with uv", "Install uv (https://docs.astral.sh/uv/), then run the probe again.");
  const p = Bun.spawn(uvCommand(uv, o.url, o.ca, o.out), { cwd: o.client, env: clientEnv(o.env ?? process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeoutMs });
  const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    const tail = err.trim().split("\n").slice(-6).join(" | ");
    throw new TabcapError("page", `the generated client's wire-report failed (exit ${code}): ${tail.slice(0, 800)}`, "Run `uv run client.py wire-report --help` in the client directory; regenerate it with `tabcap replay export-python` if it has no wire-report.");
  }
}
