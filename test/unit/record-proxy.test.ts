// 0.9-F record proxy (docs/04 §50.1) and its bundle writer (§50.2 包).
// Oracles: what the local targets saw (request lines, header lines, bodies,
// arrival order) and the bytes the targets sent, compared with what the
// client got through the proxy and with the exchanges / bundle events. All
// targets are on 127.0.0.1; the https ones use the wire test certificate
// (src/wire/certs, SAN localhost / 127.0.0.1) trusted via the upstream CA.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { startRecordProxy, type Connector, type Exchange, type RecordProxy } from "../../src/record/proxy.ts";
import { createAuthority, type CertAuthority } from "../../src/record/x509.ts";
import { recordConnector, replayConnector } from "../../src/record/run.ts";
import { makeRouter } from "../../src/record/upstream.ts";
import { RecordWriter } from "../../src/record/bundle.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { tmp } from "./_analyze.ts";

const CERTS = join(import.meta.dir, "../../src/wire/certs");
const LEAF = readFileSync(join(CERTS, "leaf.pem"), "utf8");
const LEAF_KEY = readFileSync(join(CERTS, "leaf-key.pem"), "utf8");
const RANGE_CA = readFileSync(join(CERTS, "ca.pem"), "utf8");

let ca: CertAuthority;
let root = "";

beforeAll(async () => {
  ca = await createAuthority("unit");
  root = tmp("tabcap-recproxy-");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A raw target: `respond(head, body)` returns the bytes to write; `seen` keeps every request head + body. */
type Seen = { head: string; body: string };
async function rawTarget(o: { tls: boolean; respond: (head: string, body: string, sock: net.Socket) => string | null }): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const onConn = (sock: net.Socket) => {
    let buf = "";
    sock.setEncoding("latin1");
    sock.on("data", (d: string) => {
      buf += d;
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.slice(0, end);
        const cl = /\r\ncontent-length: *(\d+)/i.exec(head);
        const need = cl === null ? 0 : Number(cl[1]);
        if (/\r\nexpect: *100-continue/i.test(head) && buf.length < end + 4 + need && !head.includes("X-Continued")) {
          sock.write("HTTP/1.1 100 Continue\r\n\r\n");
          buf = buf.slice(0, end) + "\r\nX-Continued: 1" + buf.slice(end);
          continue;
        }
        if (buf.length < end + 4 + need) return;
        const body = buf.slice(end + 4, end + 4 + need);
        buf = buf.slice(end + 4 + need);
        seen.push({ head, body });
        const out = o.respond(head, body, sock);
        if (out !== null) sock.write(Buffer.from(out, "latin1"));
        // HTTP/1.1: the server closes after answering a request with Connection: close
        if (out !== null && /\r\nconnection: *close/i.test(head)) sock.end();
      }
    });
    sock.on("error", () => sock.destroy());
  };
  const server = o.tls ? tls.createServer({ cert: LEAF, key: LEAF_KEY }, onConn) : net.createServer(onConn);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { port: typeof addr === "object" && addr !== null ? addr.port : 0, seen, close: () => server.close() };
}

const ok = (body: string, extra = "") => `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body, "latin1")}\r\n${extra}\r\n${body}`;

async function startProxy(connector: Connector, maxStoredBody?: number): Promise<{ proxy: RecordProxy; xs: Exchange[] }> {
  const xs: Exchange[] = [];
  const proxy = await startRecordProxy({ port: 0, ca, connector, onExchange: (x) => xs.push(x), ...(maxStoredBody === undefined ? {} : { maxStoredBody }) });
  return { proxy, xs };
}

const direct = () => recordConnector(makeRouter({ kind: "none" }, {}), [RANGE_CA]);

/** Read from a socket until it ends; latin1 text. */
function readAll(s: net.Socket | tls.TLSSocket): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    s.setEncoding("latin1");
    s.on("data", (d: string) => {
      out += d;
    });
    s.on("end", () => resolve(out));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
  });
}

/** CONNECT through the proxy; then TLS with the run's CA (or raw when `plainTunnel`). */
async function connectTunnel(proxyPort: number, host: string, port: number, plainTunnel = false): Promise<net.Socket | tls.TLSSocket> {
  const s = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => s.once("connect", () => r()));
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  const answer = await new Promise<string>((resolve) => {
    let buf = "";
    const on = (d: Buffer) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        s.off("data", on);
        resolve(buf);
      }
    };
    s.on("data", on);
  });
  expect(answer.startsWith("HTTP/1.1 200")).toBe(true);
  if (plainTunnel) return s;
  const t = tls.connect({ socket: s, servername: host, ca: ca.certPem, ALPNProtocols: ["http/1.1"] });
  await new Promise<void>((resolve, reject) => {
    t.once("secureConnect", () => resolve());
    t.once("error", reject);
  });
  return t;
}

describe("record proxy: tunnels (CONNECT + TLS)", () => {
  test("pipelined requests: forwarded byte for byte, answered in order, exchanges in arrival order", async () => {
    const target = await rawTarget({ tls: true, respond: (head, body) => ok(`${head.split("\r\n")[0]}|${body}`) });
    const { proxy, xs } = await startProxy(direct());
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("GET /a?x=1 HTTP/1.1\r\nHost: localhost\r\nX-Case: Keep\r\n\r\nPOST /b HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
      const got = await readAll(t);
      expect(target.seen.map((s) => s.head)).toEqual(["GET /a?x=1 HTTP/1.1\r\nHost: localhost\r\nX-Case: Keep", "POST /b HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close"]);
      expect(got).toBe(ok("GET /a?x=1 HTTP/1.1|") + ok("POST /b HTTP/1.1|hello"));
      await Bun.sleep(20);
      expect(xs.map((x) => [x.ordinal, x.method, x.url, x.response?.status, x.outcome])).toEqual([
        [1, "GET", `https://localhost:${target.port}/a?x=1`, 200, "finished"],
        [2, "POST", `https://localhost:${target.port}/b`, 200, "finished"],
      ]);
      expect(new TextDecoder().decode(xs[1]?.reqBody.bytes())).toBe("hello");
      expect(new TextDecoder().decode(xs[0]?.respBody.bytes())).toBe("GET /a?x=1 HTTP/1.1|");
      expect(xs[0]?.request.headers).toEqual([
        ["Host", "localhost"],
        ["X-Case", "Keep"],
      ]);
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("chunked + gzip, close-delimited, HEAD, 100 Continue", async () => {
    const gz = gzipSync(Buffer.from("zipped body")).toString("latin1");
    const target = await rawTarget({
      tls: true,
      respond: (head, _body, sock) => {
        const line = head.split("\r\n")[0] ?? "";
        if (line.startsWith("GET /chunked")) return `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n\r\n${(gz.length - 5).toString(16)}\r\n${gz.slice(0, -5)}\r\n5\r\n${gz.slice(-5)}\r\n0\r\n\r\n`;
        if (line.startsWith("HEAD")) return "HTTP/1.1 200 OK\r\nContent-Length: 123\r\n\r\n";
        if (line.startsWith("POST /cont")) return ok("continued");
        if (line.startsWith("GET /close")) {
          sock.end(Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil the end", "latin1"));
          return null;
        }
        return ok("?");
      },
    });
    const { proxy, xs } = await startProxy(direct());
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("GET /chunked HTTP/1.1\r\nHost: localhost\r\n\r\nHEAD /h HTTP/1.1\r\nHost: localhost\r\n\r\n");
      t.write("POST /cont HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 3\r\n\r\n");
      await Bun.sleep(100);
      t.write("abcGET /close HTTP/1.1\r\nHost: localhost\r\n\r\n");
      const got = await readAll(t);
      expect(got).toContain("HTTP/1.1 100 Continue");
      expect(got.endsWith("until the end")).toBe(true);
      await Bun.sleep(20);
      expect(xs.map((x) => [x.method, new URL(x.url).pathname, x.outcome])).toEqual([
        ["GET", "/chunked", "finished"],
        ["HEAD", "/h", "finished"],
        ["POST", "/cont", "finished"],
        ["GET", "/close", "finished"],
      ]);
      expect(Buffer.from(xs[0]?.respBody.bytes() ?? []).toString("latin1")).toBe(gz);
      expect(xs[1]?.respBody.size).toBe(0);
      expect(xs[2]?.response?.status).toBe(200);
      expect(new TextDecoder().decode(xs[3]?.respBody.bytes())).toBe("until the end");
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("WebSocket: the 101 exchange is recorded, then bytes pass through", async () => {
    const target = await rawTarget({
      tls: true,
      respond: (_head, _body, sock) => {
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        sock.removeAllListeners("data");
        sock.on("data", (d: string) => sock.end(`echo:${d}`));
        return null;
      },
    });
    const { proxy, xs } = await startProxy(direct());
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      await Bun.sleep(100);
      t.write("frame-bytes");
      const got = await readAll(t);
      expect(got.endsWith("echo:frame-bytes")).toBe(true);
      expect(xs.map((x) => [x.websocket, x.response?.status])).toEqual([[true, 101]]);
      expect(proxy.stats.websockets).toBe(1);
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("upstream certificate not trusted: 502 with x-tabcap-record-error, the exchange failed", async () => {
    const target = await rawTarget({ tls: true, respond: () => ok("never") });
    const { proxy, xs } = await startProxy(recordConnector(makeRouter({ kind: "none" }, {}), []));
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("GET /x HTTP/1.1\r\nHost: localhost\r\n\r\n");
      const got = await readAll(t);
      expect(got).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
      expect(got).toContain("x-tabcap-record-error: upstream-tls");
      await Bun.sleep(20);
      expect(xs.map((x) => [x.outcome, x.error?.startsWith("upstream-tls")])).toEqual([["failed", true]]);
      expect(target.seen).toEqual([]);
      expect([...proxy.stats.upstreamFailures.keys()]).toEqual([`upstream-tls localhost:${target.port}`]);
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("a malformed request inside the tunnel: 400, the exchange failed, nothing crashes", async () => {
    const target = await rawTarget({ tls: true, respond: () => ok("x") });
    const { proxy, xs } = await startProxy(direct());
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: nope\r\n\r\n");
      const got = await readAll(t);
      expect(got).toContain("400 Bad Request");
      await Bun.sleep(20);
      expect(xs.map((x) => [x.outcome, x.error])).toEqual([["failed", "malformed request: bad Content-Length"]]);
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("a tunnel that is not TLS passes through unrecorded and is counted", async () => {
    const target = await rawTarget({ tls: false, respond: () => ok("plain inside a tunnel", "Connection: close\r\n") });
    const { proxy, xs } = await startProxy(direct());
    try {
      const s = await connectTunnel(proxy.port, "127.0.0.1", target.port, true);
      s.write("GET /p HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(await readAll(s)).toContain("plain inside a tunnel");
      expect(xs).toEqual([]);
      expect([...proxy.stats.tunnels]).toEqual([[`127.0.0.1:${target.port}`, 1]]);
    } finally {
      await proxy.stop();
      target.close();
    }
  });

  test("through an http upstream proxy: CONNECT with Proxy-Authorization, TLS end to end", async () => {
    const target = await rawTarget({ tls: true, respond: () => ok("via proxy", "Connection: close\r\n") });
    const connects: string[] = [];
    const fwd = net.createServer((c) => {
      c.once("data", (d: Buffer) => {
        const head = d.toString("latin1");
        connects.push(head.split("\r\n\r\n")[0] ?? "");
        const m = /^CONNECT ([^:]+):(\d+)/.exec(head);
        if (m === null) return c.destroy();
        const up = net.connect(Number(m[2]), "127.0.0.1", () => {
          c.write("HTTP/1.1 200 OK\r\n\r\n");
          c.pipe(up);
          up.pipe(c);
        });
        up.on("error", () => c.destroy());
      });
    });
    await new Promise<void>((r) => fwd.listen(0, "127.0.0.1", () => r()));
    const fport = (fwd.address() as net.AddressInfo).port;
    const router = makeRouter({ kind: "env" }, { https_proxy: `http://user:pa%20ss@127.0.0.1:${fport}` });
    const { proxy, xs } = await startProxy(recordConnector(router, [RANGE_CA]));
    try {
      const t = await connectTunnel(proxy.port, "localhost", target.port);
      t.write("GET /v HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      expect(await readAll(t)).toContain("via proxy");
      expect(connects.length).toBe(1);
      expect(connects[0]).toContain(`CONNECT localhost:${target.port} HTTP/1.1`);
      expect(connects[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("user:pa ss").toString("base64")}`);
      await Bun.sleep(20);
      expect(xs.map((x) => x.outcome)).toEqual(["finished"]);
      expect(xs[0]?.remote?.port).toBe(fport);
    } finally {
      await proxy.stop();
      target.close();
      fwd.close();
    }
  });
});

describe("record proxy: plain proxy requests (absolute form)", () => {
  test("origin form at the target, Proxy-* headers removed, two hosts on one client connection", async () => {
    const a = await rawTarget({ tls: false, respond: (head) => ok(`A ${head.split("\r\n")[0]}`) });
    const b = await rawTarget({ tls: false, respond: (head) => ok(`B ${head.split("\r\n")[0]}`) });
    const { proxy, xs } = await startProxy(direct());
    try {
      const s = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((r) => s.once("connect", () => r()));
      s.write(`GET http://127.0.0.1:${a.port}/one?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${a.port}\r\nProxy-Connection: keep-alive\r\nX-Order: 1\r\n\r\n`);
      s.write(`POST http://127.0.0.1:${b.port}/two HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nProxy-Authorization: Basic eDp5\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`);
      const got = await readAll(s);
      expect(a.seen.map((x) => x.head)).toEqual([`GET /one?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${a.port}\r\nX-Order: 1`]);
      expect(b.seen.map((x) => [x.head, x.body])).toEqual([[`POST /two HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nContent-Length: 2\r\nConnection: close`, "hi"]]);
      expect(got).toBe(ok("A GET /one?q=1 HTTP/1.1") + ok("B POST /two HTTP/1.1"));
      await Bun.sleep(20);
      expect(xs.map((x) => [x.ordinal, x.url])).toEqual([
        [1, `http://127.0.0.1:${a.port}/one?q=1`],
        [2, `http://127.0.0.1:${b.port}/two`],
      ]);
    } finally {
      await proxy.stop();
      a.close();
      b.close();
    }
  });

  test("a request that is neither CONNECT nor absolute-form gets 400", async () => {
    const { proxy } = await startProxy(direct());
    try {
      const s = net.connect(proxy.port, "127.0.0.1");
      s.write("GET /relative HTTP/1.1\r\nHost: x\r\n\r\n");
      const got = await readAll(s);
      expect(got).toContain("400 Bad Request");
      expect(got).toContain("x-tabcap-record-error: not-a-proxy-request");
    } finally {
      await proxy.stop();
    }
  });
});

describe("replay connector", () => {
  test("any CONNECT host lands on the serve port with its Host header; nothing else is dialled", async () => {
    const serve = await rawTarget({ tls: false, respond: (head) => ok(`served ${head.split("\r\n")[0]}`) });
    const { proxy, xs } = await startProxy(replayConnector(serve.port));
    try {
      const t = await connectTunnel(proxy.port, "api.nowhere.invalid", 443);
      t.write("GET /api/list?n=1 HTTP/1.1\r\nHost: api.nowhere.invalid\r\nConnection: close\r\n\r\n");
      expect(await readAll(t)).toBe(ok("served GET /api/list?n=1 HTTP/1.1"));
      expect(serve.seen.map((s) => s.head)).toEqual(["GET /api/list?n=1 HTTP/1.1\r\nHost: api.nowhere.invalid\r\nConnection: close"]);
      const s = net.connect(proxy.port, "127.0.0.1");
      s.write("GET http://plain.nowhere.invalid/p HTTP/1.1\r\nHost: plain.nowhere.invalid\r\nConnection: close\r\n\r\n");
      expect(await readAll(s)).toBe(ok("served GET /p HTTP/1.1"));
      expect(xs.length).toBe(2);
      // a tunnel that is not TLS has nowhere to go in replay
      const raw = await connectTunnel(proxy.port, "x.invalid", 80, true);
      raw.write("GET / HTTP/1.1\r\n\r\n");
      expect(await readAll(raw)).toBe("");
    } finally {
      await proxy.stop();
      serve.close();
    }
  });
});

describe("RecordWriter", () => {
  test("events in arrival order with wire headers, decoded bodies, inline / blob request bodies, too-large", async () => {
    const gz = gzipSync(Buffer.from('{"z":1}'));
    let slowSock: net.Socket | null = null;
    const target = await rawTarget({
      tls: true,
      respond: (head, _b, sock) => {
        const line = head.split("\r\n")[0] ?? "";
        if (line.startsWith("GET /slow")) {
          slowSock = sock;
          return null;
        }
        if (line.startsWith("GET /gz")) return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n${gz.toString("latin1")}`;
        if (line.startsWith("GET /big")) return ok("x".repeat(100), "Content-Type: text/plain\r\n");
        return ok("{}", "Content-Type: application/json\r\n");
      },
    });
    const out = join(root, "bundle-rw");
    const w = await BundleWriter.open(out, { init: { session: { name: "rw" } } });
    const rw = new RecordWriter(w);
    const proxy = await startRecordProxy({ port: 0, ca, connector: direct(), onExchange: (x) => rw.add(x), maxStoredBody: 64 });
    try {
      const t1 = await connectTunnel(proxy.port, "localhost", target.port);
      t1.write("GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await Bun.sleep(50);
      const t2 = await connectTunnel(proxy.port, "localhost", target.port);
      t2.write("GET /gz HTTP/1.1\r\nHost: localhost\r\n\r\nPOST /form HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 3\r\n\r\na=1GET /big HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      await readAll(t2);
      await Bun.sleep(50);
      (slowSock as net.Socket | null)?.write(ok("late"));
      await Bun.sleep(50);
      t1.destroy();
      await proxy.stop();
      await rw.settle(proxy.stats.requests);
      await w.close();
      const reader = BundleReader.open(out);
      const reqs = reader.events.filter((e) => e.kind === "request");
      expect(reqs.map((e) => [e.seq, e["method"], new URL(String(e["url"])).pathname])).toEqual([
        [1, "GET", "/slow"],
        [2, "GET", "/gz"],
        [3, "POST", "/form"],
        [4, "GET", "/big"],
      ]);
      const at = (i: number, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), reqs[i]);
      expect(at(0, "response", "status")).toBe(200);
      expect(at(1, "request", "headersSource")).toBe("wire");
      expect(at(1, "response", "headers", "content-encoding")).toBe("gzip");
      expect(at(1, "response", "body", "wireEncoding")).toBe("gzip");
      expect(sha256Hex(reader.readBlob(String(at(1, "response", "body", "blob"))) ?? new Uint8Array())).toBe(sha256Hex(new TextEncoder().encode('{"z":1}')));
      expect(at(1, "response", "protocol")).toBe("http/1.1");
      expect(typeof at(1, "mono")).toBe("number");
      expect(at(1, "timing", "cdp")).toBeNull();
      expect(at(2, "request", "postData")).toEqual({ inline: "a=1" });
      expect(at(3, "response", "bodyMissing", "reason")).toBe("too-large");
      expect(at(1, "type")).toBe("xhr");
      expect(at(1, "typeInferred")).toBe("content-type");
    } finally {
      await proxy.stop();
      target.close();
    }
  });
});
