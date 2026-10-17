// L0 for 0.4-W2 (the wire echo and probe plumbing). Oracles:
//   - recorded bytes: the Chrome for Testing 155 ClientHellos and h2 streams and the
//     hand-written HTTP/1.1 head under native/wireprint/fixtures/ (their lengths are
//     the file sizes; the h2 streams end exactly after the first HEADERS block, as
//     the spike echo cut them);
//   - RFC 8446 §5.1 (record layer), RFC 9113 §3.4 / §4.1 / §6 (preface, frame
//     layout, flags), RFC 7541 Appendix C.1 (integer encoding examples);
//   - test/fixtures/wire/*.json: the four documents one probe run stored as blobs
//     (CfT 155 navigation vs the generated httpx client, recorded with
//     TABCAP_WIRE_FIXTURES_OUT in test/e2e/v04w.e2e.test.ts).
// The echo tests run a real relay and TLS on 127.0.0.1 with a fake `report`
// runner (no native binary needed), so they are offline and deterministic.

import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import tls from "node:tls";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabcapError } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { H2_PREFACE, h1Response, h1Target, h2Response, hpackInt, hpackLiteral, roleOf, scanClientHello, scanFirstRequest } from "../../src/wire/bytes.ts";
import { CA_CERT, caPath } from "../../src/wire/certs.ts";
import { Echo, type EchoReport } from "../../src/wire/echo.ts";
import { Wireprint, extractTo, isCompiled, mapFailure, parseOutput, sha256Hex } from "../../src/wire/native.ts";
import { WIRE_NOTE, WIRE_SCHEMA, checksOf, claimOf, clientEnv, clientOf, labelsOf, layersOf, renderWireText, uvCommand, wireResultOf, type WireResult } from "../../src/wire/probe.ts";
import { cftVersion, flagsSha256, normalizedFlags, profileArgs, profileFile, reusable } from "../../src/wire/profile.ts";
import { NATIVE_TARGETS, binaryName, hostTarget, zigBuildCommand } from "../../src/wire/targets.ts";
import { buildTargets } from "../../scripts/native.ts";
import { REPO_ROOT } from "./_fixtures.ts";
import { POSIX_MODES, expectMode } from "./_platform.ts";

const NATIVE_FX = join(REPO_ROOT, "native", "wireprint", "fixtures");
const bytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(join(NATIVE_FX, rel)));
const WIRE_FX = join(REPO_ROOT, "test", "fixtures", "wire");
const doc = (name: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(join(WIRE_FX, `${name}.json`), "utf8"));
  if (!isRecord(v)) throw new Error(`${name} is not an object`);
  return v;
};

const NAV1 = bytes("clienthello/cft-155-macos-nav-1.bin");
const H2_NAV = bytes("h2/cft-155-macos-nav.bin");
const H1_GET = bytes("h1/get-basic.bin");

/** Re-cut a single-record ClientHello into records of these fragment sizes (RFC 8446 §5.1 allows any split). */
function resplit(record: Uint8Array, sizes: number[]): Uint8Array {
  const msg = record.subarray(5);
  const parts: number[] = [];
  let o = 0;
  for (const n of [...sizes, msg.length]) {
    const take = Math.min(n, msg.length - o);
    if (take <= 0) break;
    parts.push(22, 3, 1, take >> 8, take & 0xff, ...msg.subarray(o, o + take));
    o += take;
  }
  return Uint8Array.from(parts);
}

describe("ClientHello assembly (front side of the echo)", () => {
  test("a recorded single-record ClientHello is complete exactly at its end; every prefix needs more", () => {
    expect(scanClientHello(NAV1)).toEqual({ kind: "complete", end: NAV1.length });
    for (const cut of [0, 1, 4, 5, 6, 100, NAV1.length - 1]) expect(scanClientHello(NAV1.subarray(0, cut))).toEqual({ kind: "need-more" });
  });

  test("bytes after the ClientHello (the next flight) are not part of it", () => {
    const more = new Uint8Array(NAV1.length + 7);
    more.set(NAV1);
    more.set([20, 3, 3, 0, 1, 1, 22], NAV1.length);
    expect(scanClientHello(more)).toEqual({ kind: "complete", end: NAV1.length });
  });

  test("a ClientHello spread over three records is complete after the third record", () => {
    const split = resplit(NAV1, [3, 697]);
    expect(split.length).toBe(NAV1.length + 10);
    expect(scanClientHello(split)).toEqual({ kind: "complete", end: split.length });
    expect(scanClientHello(split.subarray(0, 5 + 3 + 5 + 697))).toEqual({ kind: "need-more" });
  });

  test("anything else is not TLS (and never throws)", () => {
    const enc = new TextEncoder();
    expect(scanClientHello(enc.encode("GET / HTTP/1.1\r\n\r\n")).kind).toBe("not-tls");
    expect(scanClientHello(Uint8Array.from([23, 3, 3, 0, 1, 0])).kind).toBe("not-tls"); // application data
    expect(scanClientHello(Uint8Array.from([22, 3, 3, 0x40, 0x01])).kind).toBe("not-tls"); // 16385 > 2^14
    expect(scanClientHello(Uint8Array.from([22, 3, 3, 0, 4, 2, 0, 0, 0])).kind).toBe("not-tls"); // ServerHello type
    expect(scanClientHello(Uint8Array.from([22, 3, 3, 0, 0])).kind).toBe("not-tls"); // empty fragment
    for (let i = 0; i < 200; i++) {
      const junk = Uint8Array.from({ length: 64 }, (_, k) => (i * 31 + k * 17) & 0xff);
      expect(["need-more", "complete", "not-tls"]).toContain(scanClientHello(junk).kind);
    }
  });
});

describe("first request in the decrypted stream", () => {
  test("h2: the recorded CfT stream ends exactly after the first HEADERS block (stream 1)", () => {
    expect(scanFirstRequest(H2_NAV, "h2")).toEqual({ kind: "h2", end: H2_NAV.length, stream: 1 });
    for (const cut of [0, 10, H2_PREFACE.length, H2_PREFACE.length + 9, H2_NAV.length - 1]) expect(scanFirstRequest(H2_NAV.subarray(0, cut), "h2")).toEqual({ kind: "need-more" });
    const fav = bytes("h2/cft-155-macos-favicon.bin");
    expect(scanFirstRequest(fav, "h2")).toMatchObject({ kind: "h2", end: fav.length });
  });

  test("h2 negotiated without the preface is unreadable", () => {
    expect(scanFirstRequest(H1_GET, "h2").kind).toBe("bad");
  });

  test("h1 (http/1.1 or no ALPN): the head up to the empty line, request line and target", () => {
    const want = { kind: "h1" as const, end: H1_GET.length, requestLine: "GET /client?x=1 HTTP/1.1" };
    expect(scanFirstRequest(H1_GET, "http/1.1")).toEqual(want);
    expect(scanFirstRequest(H1_GET, null)).toEqual(want);
    expect(scanFirstRequest(H1_GET.subarray(0, H1_GET.length - 1), null)).toEqual({ kind: "need-more" });
    expect(h1Target("GET /client?x=1 HTTP/1.1")).toBe("/client?x=1");
    expect(h1Target("garbage")).toBeNull();
  });

  test("roles come from the path only", () => {
    expect([roleOf("/"), roleOf("/?sample=2"), roleOf("/fetch?sample=1"), roleOf("/client"), roleOf("/favicon.ico"), roleOf(null)]).toEqual(["navigation", "navigation", "fetch", "client", "other", "other"]);
  });
});

type Frame = { type: number; flags: number; stream: number; payload: Uint8Array };
function frames(buf: Uint8Array): Frame[] {
  const out: Frame[] = [];
  let o = 0;
  while (o + 9 <= buf.length) {
    const len = ((buf[o] ?? 0) << 16) | ((buf[o + 1] ?? 0) << 8) | (buf[o + 2] ?? 0);
    out.push({ type: buf[o + 3] ?? 0, flags: buf[o + 4] ?? 0, stream: (((buf[o + 5] ?? 0) & 0x7f) << 24) | ((buf[o + 6] ?? 0) << 16) | ((buf[o + 7] ?? 0) << 8) | (buf[o + 8] ?? 0), payload: buf.subarray(o + 9, o + 9 + len) });
    o += 9 + len;
  }
  expect(o).toBe(buf.length);
  return out;
}

describe("hand-built answers", () => {
  test("HPACK integers: RFC 7541 C.1.1-C.1.3", () => {
    expect(hpackInt(10, 5, 0)).toEqual([10]);
    expect(hpackInt(1337, 5, 0)).toEqual([31, 154, 10]);
    expect(hpackInt(42, 8, 0)).toEqual([42]);
    expect(hpackLiteral(":status", "200")).toEqual([0x10, 7, ...new TextEncoder().encode(":status"), 3, ...new TextEncoder().encode("200")]);
  });

  test("h2: SETTINGS, SETTINGS ACK, HEADERS END_HEADERS, DATA END_STREAM, GOAWAY naming the stream", () => {
    const body = new TextEncoder().encode('{"a":1}');
    const f = frames(h2Response(3, 200, body));
    expect(f.map((x) => [x.type, x.flags, x.stream])).toEqual([[4, 0, 0], [4, 1, 0], [1, 4, 3], [0, 1, 3], [7, 0, 0]]);
    expect(f[3]?.payload).toEqual(body);
    expect([...(f[4]?.payload ?? [])]).toEqual([0, 0, 0, 3, 0, 0, 0, 0]);
  });

  test("h2: bodies over 16384 bytes go out in several DATA frames, END_STREAM on the last only", () => {
    const body = new Uint8Array(40_000).fill(0x61);
    const data = frames(h2Response(1, 200, body)).filter((x) => x.type === 0);
    expect(data.map((x) => [x.payload.length, x.flags])).toEqual([[16384, 0], [16384, 0], [7232, 1]]);
  });

  test("h1: status line, length, close", () => {
    const text = new TextDecoder().decode(h1Response(200, new TextEncoder().encode("{}")));
    expect(text).toBe("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{}");
  });
});

// ---------------------------------------------------------------- the echo

type Call = { args: string[]; files: Record<string, Uint8Array> };

/** A `report` runner standing in for the component: records what it was given, answers a minimal report. */
function fakeRunner(calls: Call[], path: string) {
  return {
    async json(args: readonly string[]): Promise<{ value: Record<string, unknown>; code: number }> {
      const files: Record<string, Uint8Array> = {};
      for (const flag of ["--client-hello", "--h2", "--h1"]) {
        const i = args.indexOf(flag);
        const f = args[i + 1];
        if (i >= 0 && f !== undefined) files[flag] = new Uint8Array(readFileSync(f));
      }
      calls.push({ args: [...args], files });
      return { value: { wireprint: "fake", tls: { handshake: {}, client_hello: { has_pre_shared_key: false } }, http2: null, http: { headers: [{ name: ":path", value: path }] } }, code: 0 };
    },
  };
}

// The clients below hand their result over (and close) on the next macrotask, never
// inside a TLS socket's own `end` callback: there, the test's continuation (and this
// afterEach tearing the echo down) ran nested in Bun's TLS data handler, and Bun 1.4.2
// on Windows segfaulted in it now and then (us_internal_ssl_on_data ->
// us_internal_ssl_close; CI 0.7-F: 1-10 of 20 runs of the four echo tests crashed,
// 0 of 60 with the hand-over deferred; Bun 1.4.3 crashed as well).
let echo: Echo | null = null;
afterEach(async () => {
  await echo?.stop();
  echo = null;
});

function h1Get(port: number, path: string, onSession?: () => void): Promise<{ body: string; localPort: number }> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername: "localhost", ca: CA_CERT, ALPNProtocols: ["http/1.1"] }, () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: unit\r\n\r\n`);
    });
    if (onSession !== undefined) s.on("session", onSession);
    const localPort = () => s.localPort ?? -1;
    let got = "";
    s.on("data", (d: Buffer) => (got += d.toString("utf8")));
    s.on("end", () => {
      const v = { body: got.slice(got.indexOf("\r\n\r\n") + 4), localPort: localPort() };
      setImmediate(() => resolve(v)); // out of the TLS callback (see afterEach)
    });
    s.on("error", reject);
  });
}

describe("echo: relay, correlation, answers", () => {
  test("h1: the TLS side is matched to its raw ClientHello and peer port; the report is the answer", async () => {
    const calls: Call[] = [];
    echo = await Echo.start({ wireprint: fakeRunner(calls, "ignored") });
    let sessions = 0;
    const r = await h1Get(echo.port, "/fetch?x=1", () => sessions++);
    const report: unknown = JSON.parse(r.body);
    expect(isRecord(report)).toBe(true);
    const rep = isRecord(report) ? report : {};
    expect(rep["role"]).toBe("fetch");
    const e = isRecord(rep["echo"]) ? rep["echo"] : {};
    expect([e["path"], e["alpn"], e["sni"], e["psk"], e["protocol"]]).toEqual(["/fetch?x=1", "http/1.1", "localhost", false, "http/1.1"]);
    expect(calls.length).toBe(1);
    const call = calls[0];
    // the peer the echo names is this client's own port: the relay correlation held
    expect(call?.args).toContain(`127.0.0.1:${r.localPort}`);
    expect(call?.args).toContain("--h1");
    expect((call?.files["--client-hello"] ?? new Uint8Array())[0]).toBe(22);
    expect(new TextDecoder().decode(call?.files["--h1"])).toBe("GET /fetch?x=1 HTTP/1.1\r\nHost: localhost\r\nUser-Agent: unit\r\n\r\n");
    expect(scanClientHello(call?.files["--client-hello"] ?? new Uint8Array()).kind).toBe("complete");
    // the negotiated facts come from the TLS side
    const hs = isRecord(rep["tls"]) && isRecord(rep["tls"]["handshake"]) ? rep["tls"]["handshake"] : {};
    expect(hs["version"]).toBe("TLSv1.3");
    // no session ticket was issued (SSL_OP_NO_TICKET): later connections cannot resume
    await Bun.sleep(50);
    expect(sessions).toBe(0);
    expect(echo.reports().length).toBe(1);
    expect(echo.stats).toMatchObject({ connections: 1, reports: 1, failures: 0, notTls: 0 });
  });

  test("h2 via node:http2: preface + frames reach the runner; the client receives the JSON report", async () => {
    const calls: Call[] = [];
    echo = await Echo.start({ wireprint: fakeRunner(calls, "/client") });
    const port = echo.port;
    const body = await new Promise<string>((resolve, reject) => {
      const c = http2.connect(`https://localhost:${port}`, { ca: CA_CERT });
      c.on("error", reject);
      const req = c.request({ ":path": "/client" });
      let got = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (got += d));
      // out of the TLS callback (see afterEach)
      req.on("end", () =>
        setImmediate(() => {
          c.close();
          resolve(got);
        }),
      );
      req.on("error", reject);
      req.end();
    });
    const rep: unknown = JSON.parse(body);
    expect(isRecord(rep) ? rep["role"] : null).toBe("client");
    const h2 = calls[0]?.files["--h2"] ?? new Uint8Array();
    expect([...h2.subarray(0, H2_PREFACE.length)]).toEqual([...H2_PREFACE]);
    expect(scanFirstRequest(h2, "h2")).toMatchObject({ kind: "h2", end: h2.length, stream: 1 });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--alpn", "h2", "--sni", "localhost"]));
  });

  test("--capture-dir keeps the report and both raw files; a failing runner answers 500 and is counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-wire-cap-"));
    try {
      echo = await Echo.start({ wireprint: fakeRunner([], "/"), captureDir: dir });
      await h1Get(echo.port, "/");
      expect(readdirSync(dir).sort()).toEqual(["c1-navigation.ch.bin", "c1-navigation.h1.bin", "c1-navigation.json"]);
      await echo.stop();
      echo = await Echo.start({
        wireprint: {
          json: () => Promise.reject(new TabcapError("bad-input", "wireprint report: not a complete TLS ClientHello", "x")),
        },
      });
      const r = await h1Get(echo.port, "/");
      expect(r.body).toContain("not a complete TLS ClientHello");
      expect(echo.stats.failures).toBe(1);
      expect(echo.reports().length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waitFor resolves on a later report and times out with a TabcapError", async () => {
    echo = await Echo.start({ wireprint: fakeRunner([], "/fetch") });
    const later = echo.waitFor((r: EchoReport) => r["role"] === "fetch", 5000, "fetch report");
    await h1Get(echo.port, "/fetch");
    expect((await later)["role"]).toBe("fetch");
    await expect(echo.waitFor((r) => r["role"] === "client", 50, "client report")).rejects.toThrow("no client report within 50 ms");
  });
});

// ---------------------------------------------------------------- the native component

describe("native component: extraction, sha256 check, exit codes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("extractTo writes <cache>/native/wireprint-<sha256>/ (0700 / 0755), reuses an intact copy, rewrites a changed one", () => {
    const cache = mkdtempSync(join(tmpdir(), "tabcap-native-"));
    dirs.push(cache);
    const payload = new TextEncoder().encode("#!/bin/sh\necho stand-in\n");
    const a = extractTo(cache, "x86_64-linux-gnu", payload);
    const sha = sha256Hex(payload);
    expect(a).toEqual({ path: join(cache, "native", `wireprint-${sha}`, "wireprint"), sha256: sha, source: "embedded", target: "x86_64-linux-gnu" });
    expectMode(a.path, 0o755);
    expectMode(join(cache, "native", `wireprint-${sha}`), 0o700);
    const mtime = statSync(a.path).mtimeMs;
    expect(extractTo(cache, "x86_64-linux-gnu", payload).path).toBe(a.path);
    expect(statSync(a.path).mtimeMs).toBe(mtime);
    writeFileSync(a.path, "tampered");
    extractTo(cache, "x86_64-linux-gnu", payload);
    expect(readFileSync(a.path, "utf8")).toBe("#!/bin/sh\necho stand-in\n");
    expect(extractTo(cache, "x86_64-windows-gnu", payload).path.endsWith("wireprint.exe")).toBe(true);
  });

  test("a component whose bytes changed after it was located is refused before any spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-native-"));
    dirs.push(dir);
    const f = join(dir, "wireprint");
    writeFileSync(f, "original");
    if (POSIX_MODES) chmodSync(f, 0o755);
    const wp = Wireprint.at(f, "x86_64-linux-gnu");
    expect(wp.sha256).toBe(sha256Hex(new TextEncoder().encode("original")));
    writeFileSync(f, "changed!");
    await expect(wp.run(["version"])).rejects.toThrow("changed or disappeared");
    rmSync(f);
    await expect(wp.run(["version"])).rejects.toThrow("changed or disappeared");
  });

  test("exit codes: 1 is bad input (stderr message), 3 only with inconsistentOk, others are internal; stdout must be a JSON object", () => {
    const e1 = mapFailure({ code: 1, stdout: "", stderr: "error: x.bin: not a complete TLS ClientHello\n" }, ["report"]);
    expect([e1.code, e1.message]).toEqual(["bad-input", "wireprint report: x.bin: not a complete TLS ClientHello"]);
    expect(mapFailure({ code: 134, stdout: "", stderr: "" }, ["diff"]).code).toBe("internal");
    expect(parseOutput({ code: 3, stdout: '{"verdict":"INCONSISTENT"}', stderr: "" }, ["check"], true)).toEqual({ verdict: "INCONSISTENT" });
    expect(() => parseOutput({ code: 3, stdout: "{}", stderr: "" }, ["check"], false)).toThrow(TabcapError);
    expect(() => parseOutput({ code: 0, stdout: "not json", stderr: "" }, ["report"], false)).toThrow("printed no JSON");
    expect(() => parseOutput({ code: 0, stdout: "[1]", stderr: "" }, ["report"], false)).toThrow("no JSON object");
  });

  test("compiled detection: Bun's virtual file system or a non-bun executable", () => {
    expect(isCompiled("/$bunfs/root/tabcap", "/usr/local/bin/tabcap")).toBe(true);
    expect(isCompiled("B:/~BUN/root/tabcap.exe", "C:\\tabcap.exe")).toBe(true);
    expect(isCompiled("/repo/src/wire/native.ts", "/home/u/.bun/bin/bun")).toBe(false);
    expect(isCompiled("C:\\repo\\src\\wire\\native.ts", "C:\\bun\\bun.exe")).toBe(false);
  });

  test("targets: the four release triples, host mapping, build command", () => {
    expect([...NATIVE_TARGETS]).toEqual(["aarch64-macos", "x86_64-linux-gnu", "aarch64-linux-gnu", "x86_64-windows-gnu"]);
    expect([hostTarget("darwin", "arm64"), hostTarget("linux", "x64"), hostTarget("linux", "arm64"), hostTarget("win32", "x64"), hostTarget("darwin", "x64"), hostTarget("win32", "arm64")]).toEqual(["aarch64-macos", "x86_64-linux-gnu", "aarch64-linux-gnu", "x86_64-windows-gnu", null, null]);
    expect(NATIVE_TARGETS.map(binaryName)).toEqual(["wireprint", "wireprint", "wireprint", "wireprint.exe"]);
    expect(zigBuildCommand("aarch64-linux-gnu", "/p")).toEqual(["zig", "build", "-Doptimize=ReleaseSafe", "-Dstrip=true", "-Dtarget=aarch64-linux-gnu", "--prefix", "/p"]);
    expect(buildTargets([], "aarch64-macos")).toEqual([...NATIVE_TARGETS]);
    expect(buildTargets(["--host"], "x86_64-windows-gnu")).toEqual(["x86_64-windows-gnu"]);
    expect(buildTargets(["--targets", "aarch64-macos,x86_64-linux-gnu"], null)).toEqual(["aarch64-macos", "x86_64-linux-gnu"]);
    expect(() => buildTargets(["--targets", "mips-linux"], null)).toThrow("unknown mips-linux");
    expect(() => buildTargets(["--host"], null)).toThrow();
  });
});

// ---------------------------------------------------------------- baseline profile helpers

describe("baseline profile: flags hash, file, reuse", () => {
  const ARGS = ["--user-data-dir=/home/u/.config/tabcap/profiles/default", "--remote-debugging-pipe", "--disable-field-trial-config", "--load-extension=/x/ext", "about:blank"];

  test("machine paths become markers; the hash covers the exact order", () => {
    const n = normalizedFlags(ARGS);
    expect(n).toEqual(["--user-data-dir=<profile>", "--remote-debugging-pipe", "--disable-field-trial-config", "--load-extension=<extension>", "about:blank"]);
    expect(flagsSha256(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(flagsSha256(normalizedFlags(ARGS.map((a) => a.replace("/home/u", "/Users/v"))))).toBe(flagsSha256(n));
    expect(flagsSha256([...n].reverse())).not.toBe(flagsSha256(n));
    expect(flagsSha256(n.filter((f) => f !== "--disable-field-trial-config"))).not.toBe(flagsSha256(n));
  });

  test("version, file names, profile arguments", () => {
    expect(cftVersion("Chrome/155.0.8059.79")).toBe("155.0.8059.79");
    expect(cftVersion("HeadlessChrome/1")).toBeNull();
    const f = profileFile("/c", "155.0.8059.79", "macos", "arm64");
    expect(f).toEqual({ file: join("/c", "wire", "profiles", "cft-155.0.8059.79-macos-arm64.json"), samples: join("/c", "wire", "profiles", "cft-155.0.8059.79-macos-arm64.samples"), name: "cft-155.0.8059.79-macos-arm64" });
    const args = profileArgs({ version: "155.0.8059.79", os: "linux", arch: "x64", capturedAt: "t", tabcapVersion: "0.4.0", reports: ["a.json", "b.json"] });
    expect(args.slice(0, 1)).toEqual(["profile"]);
    expect(args.slice(-2)).toEqual(["a.json", "b.json"]);
    expect(args.join(" ")).toContain("--name chrome --channel for-testing --version 155.0.8059.79 --os linux --arch x64");
    expect(args.join(" ")).toContain("--server-host-os linux");
  });

  test("a cached profile is reused only for the same CfT version and flags hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-wire-prof-"));
    try {
      const file = join(dir, "p.json");
      const section = { cftVersion: "155.0.8059.79", flagsSha256: "ab", flags: ["--x"], tabcapVersion: "0.4.0", capturedAt: "t", samples: { navigation: 3, fetch: 3 }, psk: { navigation: 0, fetch: 0 }, sessionTickets: "disabled" as const };
      writeFileSync(file, JSON.stringify({ id: "chrome/155/macos-arm64/155.0.8059.79", tabcap: section }));
      expect(reusable(file, "155.0.8059.79", "ab")).toEqual(section);
      expect(reusable(file, "155.0.8059.79", "cd")).toBeNull();
      expect(reusable(file, "156.0.0.1", "ab")).toBeNull();
      expect(reusable(join(dir, "missing.json"), "155.0.8059.79", "ab")).toBeNull();
      writeFileSync(file, "{not json");
      expect(reusable(file, "155.0.8059.79", "ab")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CA file is the embedded certificate, written once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tabcap-wire-ca-"));
    try {
      const p = caPath(dir);
      expect(p).toBe(join(dir, "wire", "tabcap-wire-ca.pem"));
      expect(readFileSync(p, "utf8")).toBe(CA_CERT);
      expect(CA_CERT).toContain("BEGIN CERTIFICATE");
      expect(CA_CERT).not.toContain("PRIVATE KEY");
      expect(caPath(dir)).toBe(p);
      expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- probe output

describe("probe: tabcap-wire/0 from the component's check and diff", () => {
  const browser = doc("browserReport");
  const client = doc("clientReport");
  const diff = doc("diff");
  const check = doc("check");

  test("layers: CfT navigation vs httpx (HTTP/2) differ in tls, h2 and headers, with the differing fields", () => {
    const layers = layersOf(diff, browser, client);
    expect(layers.map((l) => [l.layer, l.verdict])).toEqual([
      ["tls", "differs"],
      ["h2", "differs"],
      ["headers", "differs"],
    ]);
    const names = (i: number) => layers[i]?.fields.map((f) => f.field) ?? [];
    expect(names(0)).toEqual(expect.arrayContaining(["tls.client_hello.cipher_suites", "tls.client_hello.extensions", "tls.client_hello.alpn", "tls.ja4.ja4"]));
    expect(names(1)).toEqual(expect.arrayContaining(["http2.settings", "http2.window_update", "http2.akamai"]));
    expect(names(2)).toEqual(expect.arrayContaining(["http.headers_order", "http.headers.user-agent", "http.headers.sec-ch-ua"]));
    // every field sits in its layer's section; the diff's per-connection noise never shows up
    for (const l of layers) for (const f of l.fields) expect(f.field.startsWith({ tls: "tls", h2: "http2", headers: "http." }[l.layer])).toBe(true);
    const all = layers.flatMap((l) => l.fields.map((f) => f.field));
    for (const noisy of ["tls.client_hello.random", "tls.client_hello.session_id", "tls.ja3", "connection", "echo", "role"]) expect(all.some((p) => p === noisy || p.startsWith(`${noisy}.`))).toBe(false);
    const settings = layers[1]?.fields.find((f) => f.field === "http2.settings");
    expect(settings?.client).toEqual([[1, 4096], [2, 0], [4, 65535], [5, 16384], [3, 100], [6, 65536]]); // the research report's httpx SETTINGS
  });

  test("a client without HTTP/2 is `missing` in h2; no differences is `same`", () => {
    const h1client = { ...client, http2: null };
    const d = { differences: [{ path: "http2", kind: "changed", a: browser["http2"], b: null }] };
    expect(layersOf(d, browser, h1client).map((l) => l.verdict)).toEqual(["same", "missing", "same"]);
    expect(layersOf({ differences: [] }, browser, browser).map((l) => l.verdict)).toEqual(["same", "same", "same"]);
  });

  test("checks, labels, client library", () => {
    const checks = checksOf(check);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.code === "T1" && c.status === "red")).toBe(true);
    expect(checks.every((c) => ["red", "warn", "info"].includes(c.status))).toBe(true);
    expect(labelsOf({ labels: [{ label: "psk", a: false, b: true }] })).toEqual([{ label: "psk", browser: false, client: true }]);
    expect(clientOf(client)).toEqual({ library: "python-httpx", version: "0.28.1" });
    expect(clientOf({ http: { user_agent: "Mozilla/5.0 (X11) Chrome/1" } })).toEqual({ library: "Mozilla/5.0 (X11) Chrome/1", version: null });
    expect(clientOf({})).toEqual({ library: null, version: null });
  });

  test("result round trip, text table, finding claims stay diagnostic", () => {
    const r: WireResult = {
      schema: WIRE_SCHEMA,
      browser: { version: "155.0.8059.79", flagsHash: "c".repeat(64), profile: "/p.json", cached: true },
      client: clientOf(client),
      layers: layersOf(diff, browser, client),
      checks: checksOf(check),
      labels: [],
      note: WIRE_NOTE,
    };
    expect(wireResultOf(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(wireResultOf({ schema: "other" })).toBeNull();
    expect(wireResultOf({ ...r, layers: [{ layer: "tcp", verdict: "same", fields: [] }] })).toBeNull();
    const text = renderWireText(r);
    expect(text).toContain("layer    verdict  fields");
    expect(text).toMatch(/^h2\s+differs\s+\d+$/m);
    expect(text).toContain(`note: ${WIRE_NOTE}`);
    for (const l of r.layers) {
      const c = claimOf(l);
      expect(c).toContain("local echo");
      expect(c).not.toMatch(/\b(should|set|change|use|fix)\b|impersonat/i);
    }
  });

  test("the client run: argv (no shell), proxy variables keep loopback direct, the client's own proxy is dropped", () => {
    expect(uvCommand("/bin/uv", "https://localhost:1/client", "/ca.pem", "/o.json")).toEqual(["/bin/uv", "run", "client.py", "wire-report", "--url", "https://localhost:1/client", "--ca", "/ca.pem", "--out", "/o.json"]);
    const env = clientEnv({ HTTPS_PROXY: "http://127.0.0.1:6152", TABCAP_PROXY_URL: "http://u:p@proxy:1", NO_PROXY: "corp.example", VIRTUAL_ENV: "/v", PATH: "/bin" });
    expect(env["HTTPS_PROXY"]).toBe("http://127.0.0.1:6152");
    expect(env["TABCAP_PROXY_URL"]).toBeUndefined();
    expect(env["VIRTUAL_ENV"]).toBeUndefined();
    expect(env["NO_PROXY"]).toBe("corp.example,localhost,127.0.0.1,::1");
    expect(env["no_proxy"]).toBe("localhost,127.0.0.1,::1");
    expect(env["PATH"]).toBe("/bin");
  });
});
