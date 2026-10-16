// The local wire echo (docs/07 §6). A `Bun.listen` front on 127.0.0.1
// records each connection's raw bytes up to the complete ClientHello and
// relays the whole stream unchanged to an internal `node:tls` server (ALPN h2,
// http/1.1; no session tickets). The TLS side reads the decrypted client
// stream up to the first request (h2: preface + frames through the first
// HEADERS/CONTINUATION block; h1 or no ALPN: the request head), hands the raw
// bytes to the native `wireprint report`, adds what only the echo knows
// (role from the request path, ALPN / SNI / PSK, negotiated version and
// cipher), keeps the report (ring of 64, and --capture-dir) and answers
// with it as JSON (a hand-built h2 response + GOAWAY, or HTTP/1.1 + close).
// The two sides are matched by the relay socket's local port, which is the
// TLS side's remote port. Only 127.0.0.1 is ever bound or connected to.

import tls from "node:tls";
import { constants } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, TCPSocketListener } from "bun";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { LEAF_CERT, LEAF_KEY } from "./certs.ts";
import { h1Response, h1Target, h2Response, roleOf, scanClientHello, scanFirstRequest } from "./bytes.ts";
import type { Wireprint } from "./native.ts";

/** What the echo needs from the component: `report` as JSON (a fake in unit tests). */
export type ReportRunner = Pick<Wireprint, "json">;

export type EchoReport = Record<string, unknown>;

export type EchoOptions = {
  wireprint: ReportRunner;
  /** 0 (default): any free port. */
  port?: number;
  /** Also write every report and its raw bytes here. */
  captureDir?: string | null;
  log?: ((line: string) => void) | null;
  ringSize?: number;
};

export type EchoStats = { connections: number; tlsErrors: number; reports: number; failures: number; notTls: number };

const RING = 64;
/** Raw client bytes kept per connection on the front side (the ClientHello is far smaller). */
const FRONT_CAP = 256 * 1024;

type Front = {
  id: number;
  clientPort: number;
  chunks: Uint8Array[];
  bytes: number;
  hello: Uint8Array | null;
  notTls: string | null;
};

type Pending = { buf: Uint8Array[] };

/**
 * One relayed connection. Each side is ended / written only while it is open:
 * touching a Bun socket after its close crashed Bun 1.4.2 on Windows (CI, a
 * segfault in the unit tests), so both sides track their own closed state.
 */
type Relay = { fc: Front; back: Socket<unknown> | null; toBack: Pending; toFront: Pending; frontClosed: boolean; backClosed: boolean };

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Write everything, queueing what the socket did not take; `drain` flushes the queue. */
function writeAll(s: Socket<unknown>, q: Pending, data: Uint8Array): void {
  if (q.buf.length > 0) {
    q.buf.push(data);
    return;
  }
  const n = s.write(data);
  if (n < data.length) q.buf.push(data.subarray(Math.max(0, n)));
}

function flush(s: Socket<unknown>, q: Pending): void {
  while (q.buf.length > 0) {
    const head = q.buf[0];
    if (head === undefined) break;
    const n = s.write(head);
    if (n < head.length) {
      q.buf[0] = head.subarray(Math.max(0, n));
      return;
    }
    q.buf.shift();
  }
}

function headerValue(report: EchoReport, name: string): string | null {
  const http = report["http"];
  if (!isRecord(http) || !Array.isArray(http["headers"])) return null;
  for (const h of http["headers"]) {
    if (isRecord(h) && h["name"] === name && typeof h["value"] === "string") return h["value"];
  }
  return null;
}

export class Echo {
  private readonly ring: EchoReport[] = [];
  private readonly listeners = new Set<(r: EchoReport) => void>();
  private readonly byRelayPort = new Map<number, Front>();
  private seq = 0;
  readonly stats: EchoStats = { connections: 0, tlsErrors: 0, reports: 0, failures: 0, notTls: 0 };
  private readonly open = new Set<{ terminate(): void }>();
  private readonly secure = new Set<tls.TLSSocket>();
  private stopped = false;

  private constructor(
    private readonly o: EchoOptions,
    private readonly inner: tls.Server,
    private front: TCPSocketListener<Relay> | null,
    private readonly work: string,
  ) {}

  get port(): number {
    return this.front?.port ?? 0;
  }

  /** https://<host>:<port><path>; `localhost` carries SNI (an IP literal would not). */
  url(path = "/", host = "localhost"): string {
    return `https://${host}:${this.port}${path}`;
  }

  reports(): readonly EchoReport[] {
    return this.ring;
  }

  onReport(fn: (r: EchoReport) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The first report (already kept or still to come) that `match` accepts. */
  waitFor(match: (r: EchoReport) => boolean, timeoutMs: number, what: string): Promise<EchoReport> {
    const have = this.ring.find(match);
    if (have !== undefined) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const off = this.onReport((r) => {
        if (!match(r)) return;
        clearTimeout(timer);
        off();
        resolve(r);
      });
      const timer = setTimeout(() => {
        off();
        reject(new TabcapError("timeout", `the wire echo saw no ${what} within ${timeoutMs} ms (${this.stats.connections} connection(s), ${this.stats.reports} report(s), ${this.stats.failures} failure(s))`, "Check that the client reaches https://localhost:<port>/ (loopback only) and raise --timeout."));
      }, timeoutMs);
    });
  }

  static async start(o: EchoOptions): Promise<Echo> {
    const work = mkdtempSync(join(tmpdir(), "tabcap-wire-"));
    if (o.captureDir != null) mkdirSync(o.captureDir, { recursive: true, mode: 0o700 });
    const inner = tls.createServer({
      ALPNProtocols: ["h2", "http/1.1"],
      cert: LEAF_CERT,
      key: LEAF_KEY,
      // No session tickets: every connection's ClientHello is a first one (0.4-W2 measured whether Chrome still sends PSK).
      secureOptions: constants.SSL_OP_NO_TICKET,
      sessionTimeout: 0,
    });
    await new Promise<void>((resolve, reject) => {
      inner.once("error", reject);
      inner.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = inner.address();
    const innerPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    const echo = new Echo(o, inner, null, work);
    inner.on("secureConnection", (s: tls.TLSSocket) => echo.onSecure(s));
    inner.on("tlsClientError", () => {
      echo.stats.tlsErrors++;
    });
    try {
      echo.front = echo.listenFront(innerPort, o.port ?? 0);
    } catch (e) {
      inner.close();
      rmSync(work, { recursive: true, force: true });
      throw new TabcapError("io", `cannot listen on 127.0.0.1:${o.port ?? 0}: ${e instanceof Error ? e.message : String(e)}`, "Pick another --port (0 = any free port).");
    }
    return echo;
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private listenFront(innerPort: number, port: number): TCPSocketListener<Relay> {
    const echo = this;
    return Bun.listen<Relay>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          const fc: Front = { id: ++echo.seq, clientPort: s.remotePort, chunks: [], bytes: 0, hello: null, notTls: null };
          echo.stats.connections++;
          s.data = { fc, back: null, toBack: { buf: [] }, toFront: { buf: [] }, frontClosed: false, backClosed: false };
          echo.open.add(s);
          const relay = s.data;
          const endFront = () => {
            if (!relay.frontClosed) s.end();
          };
          void Bun.connect<undefined>({
            hostname: "127.0.0.1",
            port: innerPort,
            socket: {
              data(_b, d) {
                if (!relay.frontClosed) writeAll(s, relay.toFront, new Uint8Array(d));
              },
              drain(b) {
                if (!relay.backClosed) flush(b, relay.toBack);
              },
              close(b) {
                relay.backClosed = true;
                echo.open.delete(b);
                endFront();
              },
              error() {
                endFront();
              },
            },
          }).then(
            (b) => {
              if (echo.stopped || relay.frontClosed) {
                relay.backClosed = true;
                b.end();
                return;
              }
              echo.open.add(b);
              relay.back = b;
              echo.byRelayPort.set(b.localPort, fc);
              const queued = relay.toBack.buf;
              relay.toBack = { buf: [] };
              for (const q of queued) writeAll(b, relay.toBack, q);
            },
            () => endFront(),
          );
        },
        data(s, d) {
          const { fc } = s.data;
          const bytes = new Uint8Array(d);
          if (fc.hello === null && fc.notTls === null && fc.bytes < FRONT_CAP) {
            fc.chunks.push(bytes);
            fc.bytes += bytes.length;
            const scan = scanClientHello(concat(fc.chunks));
            if (scan.kind === "complete") {
              fc.hello = concat(fc.chunks).subarray(0, scan.end);
              fc.chunks = [];
            } else if (scan.kind === "not-tls") {
              fc.notTls = scan.reason;
              fc.chunks = [];
              echo.stats.notTls++;
            }
          }
          if (s.data.back === null) s.data.toBack.buf.push(bytes);
          else if (!s.data.backClosed) writeAll(s.data.back, s.data.toBack, bytes);
        },
        drain(s) {
          if (!s.data.frontClosed) flush(s, s.data.toFront);
        },
        close(s) {
          s.data.frontClosed = true;
          echo.open.delete(s);
          const back = s.data.back;
          if (back !== null && !s.data.backClosed) back.end();
          // The TLS side may report after the front closed (a parallel connection the client dropped): keep the match a while.
          if (back !== null) {
            const port = back.localPort;
            const t = setTimeout(() => echo.byRelayPort.delete(port), 10_000);
            t.unref();
          }
        },
        error(s) {
          if (!s.data.frontClosed) s.end();
        },
      },
    });
  }

  private onSecure(s: tls.TLSSocket): void {
    this.secure.add(s);
    s.on("close", () => this.secure.delete(s));
    s.on("error", () => s.destroy());
    const alpn = typeof s.alpnProtocol === "string" ? s.alpnProtocol : null;
    let plain = new Uint8Array(0);
    let answered = false;
    s.on("data", (d: Buffer) => {
      if (answered) return;
      const next = new Uint8Array(plain.length + d.length);
      next.set(plain);
      next.set(new Uint8Array(d.buffer, d.byteOffset, d.length), plain.length);
      plain = next;
      const scan = scanFirstRequest(plain, alpn);
      if (scan.kind === "need-more") return;
      answered = true;
      if (scan.kind === "bad") {
        this.stats.failures++;
        this.log(`echo: unreadable request (${scan.reason})`);
        s.destroy();
        return;
      }
      void this.answer(s, alpn, plain.subarray(0, scan.end), scan).catch((e: unknown) => {
        this.stats.failures++;
        this.log(`echo: ${e instanceof Error ? e.message : String(e)}`);
        s.destroy();
      });
    });
  }

  private async answer(s: tls.TLSSocket, alpn: string | null, request: Uint8Array, scan: { kind: "h2"; stream: number } | { kind: "h1"; requestLine: string }): Promise<void> {
    const fc = this.byRelayPort.get(s.remotePort ?? -1);
    const respond = (status: number, value: unknown) => {
      const body = new TextEncoder().encode(JSON.stringify(value) + "\n");
      if (scan.kind === "h2") {
        s.write(h2Response(scan.stream, status, body));
        setTimeout(() => s.end(), 200);
      } else s.end(h1Response(status, body));
    };
    if (fc === undefined || fc.hello === null) {
      this.stats.failures++;
      respond(500, { error: fc === undefined ? "the echo could not match this TLS connection to its raw bytes" : `no ClientHello recorded (${fc.notTls ?? "incomplete"})` });
      return;
    }
    const base = join(this.work, `c${fc.id}`);
    const chFile = `${base}.ch.bin`;
    const reqFile = `${base}.${scan.kind}.bin`;
    writeFileSync(chFile, fc.hello);
    writeFileSync(reqFile, request);
    const sni = typeof (s as { servername?: unknown }).servername === "string" ? String((s as { servername?: unknown }).servername) : null;
    const args = ["report", "--client-hello", chFile, scan.kind === "h2" ? "--h2" : "--h1", reqFile, "--peer", `127.0.0.1:${fc.clientPort}`];
    if (alpn !== null) args.push("--alpn", alpn);
    if (sni !== null && sni !== "") args.push("--sni", sni);
    let report: EchoReport;
    try {
      report = (await this.o.wireprint.json(args)).value;
    } catch (e) {
      this.stats.failures++;
      respond(500, { error: e instanceof Error ? e.message : String(e) });
      return;
    } finally {
      if (this.o.captureDir == null) {
        rmSync(chFile, { force: true });
        rmSync(reqFile, { force: true });
      }
    }
    const path = scan.kind === "h2" ? headerValue(report, ":path") : h1Target(scan.requestLine);
    const role = roleOf(path);
    const tlsObj = isRecord(report["tls"]) ? report["tls"] : {};
    const ch = isRecord(tlsObj["client_hello"]) ? tlsObj["client_hello"] : {};
    const psk = ch["has_pre_shared_key"] === true;
    const cipher = s.getCipher();
    const hs = isRecord(tlsObj["handshake"]) ? tlsObj["handshake"] : {};
    tlsObj["handshake"] = { ...hs, version: s.getProtocol() ?? null, cipher: cipher.name ?? null, session_reused: s.isSessionReused() };
    report["role"] = role;
    report["echo"] = { conn: fc.id, path, role, alpn, sni, psk, sessionReused: s.isSessionReused(), protocol: scan.kind === "h2" ? "h2" : "http/1.1", receivedAt: new Date().toISOString() };
    if (this.o.captureDir != null) {
      const stem = join(this.o.captureDir, `c${fc.id}-${role}`);
      writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      copyFileSync(chFile, `${stem}.ch.bin`);
      copyFileSync(reqFile, `${stem}.${scan.kind}.bin`);
      rmSync(chFile, { force: true });
      rmSync(reqFile, { force: true });
    }
    this.ring.push(report);
    if (this.ring.length > (this.o.ringSize ?? RING)) this.ring.shift();
    this.stats.reports++;
    this.log(`echo #${fc.id} ${role} ${path ?? "?"} alpn=${alpn ?? "-"} sni=${sni ?? "-"} psk=${psk}`);
    respond(200, report);
    for (const fn of [...this.listeners]) fn(report);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Each live socket is closed exactly once (stop(true) as well would close the front ones a second time).
    const open = [...this.open];
    this.open.clear();
    const secure = [...this.secure];
    this.secure.clear();
    for (const s of secure) s.destroy();
    for (const s of open) s.terminate();
    this.front?.stop(false);
    await new Promise<void>((resolve) => this.inner.close(() => resolve()));
    rmSync(this.work, { recursive: true, force: true });
  }
}
