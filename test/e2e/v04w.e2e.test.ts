// L2 for 0.4-W2: the wire echo, the browser baseline and the probe (Chrome for
// Testing launched by tabcap, the real daemon, the local echo on 127.0.0.1).
// Expected values come from the oracles, never from tabcap's own output:
//   - SNI / ALPN: the URL the test navigates to (https://localhost:<port>/) and
//     the echo's ALPN list (h2 first; Chrome offers h2);
//   - JA4 equal across navigation samples: the definition of JA4 (sorted lists,
//     GREASE removed: FoxIO JA4 spec), so the samples of one Chrome must agree;
//   - the committed corpus profile (native/wireprint/corpus/chrome/<major>/
//     <os>-<arch>/<version>.json), a CfT capture, when this platform and CfT
//     version have one;
//   - the probe verdicts: the 0.4-W2 research report (httpx with HTTP/2 offers
//     its own cipher list without GREASE, sends SETTINGS 1:4096;2:0;4:65535;
//     5:16384;3:100;6:65536 and no client hints), asserted as verdicts and
//     field names, never hash values.
// The probe part needs the generated client to speak HTTP/2 (0.4-E: httpx[http2],
// uv): without that template it is skipped with the reason printed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import { isRecord } from "../../src/shared/json.ts";
import { profileArch, profileOs } from "../../src/wire/profile.ts";
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };
import { startSmokeSite, type Site } from "./site.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const CORPUS = join(import.meta.dir, "..", "..", "native", "wireprint", "corpus", "chrome");

let home = "";
let site: Site;

type Env = { ok: boolean; data: Record<string, unknown>; error: Record<string, unknown> | null; raw: string; exit: number };
const s = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

async function tabcap(args: string[]): Promise<Env> {
  const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, TABCAP_HOME: home, TABCAP_CHROME: CHROME }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  let env: unknown = null;
  try {
    env = JSON.parse(out);
  } catch {
    return { ok: exit === 0, data: {}, error: null, raw: out, exit };
  }
  if (!isRecord(env) || typeof env["ok"] !== "boolean") throw new Error(`not an envelope: ${out}`);
  return { ok: env["ok"], data: rec(env["data"]), error: isRecord(env["error"]) ? env["error"] : null, raw: out, exit };
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  const e = await tabcap(args);
  if (!e.ok) throw new Error(`tabcap ${args.join(" ")} failed: ${e.raw}`);
  return e.data;
}

const json = (file: string): Record<string, unknown> => rec(JSON.parse(readFileSync(file, "utf8")));

/** The generated client speaks HTTP/2 (0.4-E); before that the probe's expectations do not apply. */
const CLIENT_H2 = PYPROJECT.includes("httpx[http2]");
/** uv runs the generated client; missing uv skips locally and fails under CI. */
const UV_MISSING = Bun.which("uv") === null;
if (enabled && !CLIENT_H2) console.warn("[v04w] probe test SKIPPED: the generated client does not use HTTP/2 yet (needs 0.4-E: httpx[http2] run with uv)");
if (enabled && CLIENT_H2 && UV_MISSING) console.warn(`[v04w] uv is not on PATH: the probe test ${process.env["CI"] === undefined ? "is SKIPPED" : "FAILS under CI"}`);

describe.skipIf(!enabled)("tabcap 0.4-W2 L2 (wire echo, browser baseline, probe)", () => {
  let profileFile = "";
  let samplesDir = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e4w-"));
    site = startSmokeSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("wire version / ca-path: the component runs and the CA is a file", async () => {
    const v = await ok("wire", "version");
    expect(s(v["component"])).toMatch(/^wireprint \d+\.\d+\.\d+$/);
    expect(s(v["sha256"])).toMatch(/^[0-9a-f]{64}$/);
    const ca = await ok("wire", "ca-path");
    expect(readFileSync(s(ca["path"]), "utf8")).toContain("BEGIN CERTIFICATE");
  });

  test("wire profile: a session tab against the echo; SNI, ALPN h2, one JA4 across navigations; the profile file", async () => {
    const before = await ok("tab", "list", "--session", "w");
    const d = await ok("wire", "profile", "--samples", "3", "--session", "w");
    profileFile = s(d["file"]);
    samplesDir = s(d["samplesDir"]);
    expect(existsSync(profileFile)).toBe(true);
    const tc = rec(d["tabcap"]);
    expect(rec(tc["samples"])).toEqual({ navigation: 3, fetch: 3 });
    expect(s(tc["flagsSha256"])).toMatch(/^[0-9a-f]{64}$/);
    const flags = Array.isArray(tc["flags"]) ? tc["flags"].map(String) : [];
    expect(flags).toContain("--disable-field-trial-config");
    expect(flags).toContain("--user-data-dir=<profile>");
    console.log(`[v04w] profile ${profileFile}: psk navigation=${s(rec(tc["psk"])["navigation"])} fetch=${s(rec(tc["psk"])["fetch"])}, echo ${s(d["echo"])}`);

    const navs = readdirSync(samplesDir).filter((f) => f.startsWith("nav-")).map((f) => json(join(samplesDir, f)));
    expect(navs.length).toBe(3);
    const ja4s = new Set<string>();
    for (const r of navs) {
      const echo = rec(r["echo"]);
      expect(echo["sni"]).toBe("localhost");
      expect(echo["alpn"]).toBe("h2");
      expect(r["role"]).toBe("navigation");
      expect(rec(rec(r["tls"])["handshake"])["alpn"]).toBe("h2");
      ja4s.add(s(rec(rec(r["tls"])["ja4"])["ja4"]));
    }
    expect(ja4s.size).toBe(1);
    const fetches = readdirSync(samplesDir).filter((f) => f.startsWith("fetch-")).map((f) => json(join(samplesDir, f)));
    expect(fetches.map((r) => r["role"])).toEqual(["fetch", "fetch", "fetch"]);

    const profile = rec(d["profile"]);
    expect(rec(rec(profile["tls"])["ja4"])["ja4"]).toBe([...ja4s][0]);
    expect(Object.keys(rec(rec(profile["http"])["roles"]))).toEqual(["navigation", "fetch"]);

    // The committed corpus entry for this CfT version and platform, when there is one.
    const version = s(tc["cftVersion"]);
    const corpus = join(CORPUS, version.split(".")[0] ?? "", `${profileOs()}-${profileArch()}`, `${version}.json`);
    if (existsSync(corpus)) {
      expect([...ja4s][0]).toBe(s(rec(rec(json(corpus)["tls"])["ja4"])["ja4"]));
    } else console.warn(`[v04w] no corpus profile at ${corpus}: the JA4 comparison is skipped on this platform / version`);

    const out = process.env["TABCAP_WIRE_PROFILE_OUT"];
    if (out !== undefined && out !== "") {
      mkdirSync(out, { recursive: true });
      copyFileSync(profileFile, join(out, profileFile.split(/[\\/]/).pop() ?? "profile.json"));
    }
    // the capture tab is closed again; the session keeps no extra tab
    const after = await ok("tab", "list", "--session", "w");
    expect(recs(after["tabs"]).length).toBe(recs(before["tabs"]).length);
  }, 180_000);

  test.skipIf(!CLIENT_H2 || (UV_MISSING && process.env["CI"] === undefined))("wire probe: export-python client vs the baseline → tls, h2, headers differ; one finding per layer", async () => {
    if (UV_MISSING) throw new Error("uv is not on PATH (the generated client runs with uv)");
    const S = ["--session", "w"];
    // the recording the client is generated from: its own session (bundle names are per session and second)
    const R = ["--session", "rec"];
    const b1 = s((await ok("net", "start", ...R))["bundle"]);
    await ok("navigate", `${site.origin}/`, ...R);
    await ok("evaluate", "fetch('/api/items').then((r) => r.status)", "--await", ...R);
    await ok("net", "wait", "--url", "/api/items", ...R);
    await ok("net", "stop", ...R);
    const client = join(home, "client");
    await ok("replay", "export-python", b1, "-o", client);
    expect(readFileSync(join(client, "client.py"), "utf8")).toContain("wire-report");

    const b2 = s((await ok("net", "start", ...S))["bundle"]);
    const d = await ok("wire", "probe", "--client", client, "--timeout", "300000", ...S);
    await ok("net", "stop", ...S);
    console.log(`[v04w] probe: ${JSON.stringify({ browser: d["browser"], client: d["client"], layers: recs(d["layers"]).map((l) => [l["layer"], l["verdict"], recs(l["fields"]).map((f) => f["field"])]), checks: recs(d["checks"]).filter((c) => c["status"] !== "info").map((c) => `${s(c["code"])} ${s(c["status"])}`), labels: d["labels"] })}`);
    expect(d["schema"]).toBe("tabcap-wire/0");
    expect(rec(d["browser"])["cached"]).toBe(true); // the profile captured by the previous test is reused
    expect(rec(d["client"])["library"]).toBe("python-httpx");
    const layers = new Map(recs(d["layers"]).map((l) => [s(l["layer"]), l]));
    expect([...layers.keys()]).toEqual(["tls", "h2", "headers"]);
    for (const name of ["tls", "h2", "headers"]) expect([name, rec(layers.get(name))["verdict"]]).toEqual([name, "differs"]);
    const fields = (name: string) => recs(rec(layers.get(name))["fields"]).map((f) => s(f["field"]));
    expect(fields("tls")).toContain("tls.client_hello.cipher_suites");
    expect(fields("h2")).toContain("http2.settings");
    expect(fields("h2")).toContain("http2.akamai");
    expect(fields("headers")).toContain("http.headers_order");
    expect(recs(d["checks"]).some((c) => c["code"] === "T1" && c["status"] === "red")).toBe(true);
    expect(s(d["note"])).toContain("not why a site refused anything");

    const saved = rec(d["saved"]);
    expect(saved["bundle"]).toBe(b2);
    const findings = BundleReader.open(b2).events.filter((e) => e.kind === "finding");
    expect(findings.length).toBe(3);
    for (const f of findings) {
      const e = rec(f);
      expect([e["tool"], e["grade"]]).toEqual(["wire", "实测"]);
      expect(recs(e["evidence"]).length).toBe(4);
      for (const ev of recs(e["evidence"])) expect(s(ev["blob"])).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // TABCAP_WIRE_FIXTURES_OUT: keep the four documents (how test/fixtures/wire/ was recorded).
    const fx = process.env["TABCAP_WIRE_FIXTURES_OUT"];
    if (fx !== undefined && fx !== "") {
      mkdirSync(fx, { recursive: true });
      const reader = BundleReader.open(b2);
      for (const [name, ref] of Object.entries(rec(saved["blobs"]))) writeFileSync(join(fx, `${name}.json`), reader.readBlob(s(ref)) ?? "");
    }

    const text = await tabcap(["wire", "probe", "--client", client, "--text", "--timeout", "300000", ...S]);
    console.log(`[v04w] probe --text:\n${text.raw}`);
    expect(text.exit).toBe(0);
    expect(text.raw).toContain("layer    verdict  fields");
    expect(text.raw).toMatch(/^tls\s+differs/m);
  }, 400_000);
});
