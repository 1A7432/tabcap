// The record proxy (0.9-F, docs/04 §50.1): an HTTP/1.1 forward proxy on
// 127.0.0.1 inside the tabcap process, with its own TLS interception.
// - CONNECT: answer 200, peek the first byte of the tunnel. TLS (0x16):
//   terminate it with a leaf certificate for the CONNECT host
//   (ALPN http/1.1 only), read HTTP/1.1 inside. Anything else: passed through
//   unrecorded (record mode) or closed (replay mode).
// - Absolute-form requests (GET http://host/path): forwarded per request to
//   that host, the request line turned into origin form (or kept absolute for
//   an upstream proxy), Proxy-Connection / Proxy-Authorization removed; one
//   request at a time per client connection.
// Bytes are forwarded unchanged (apart from the plain-proxy head rewrite);
// ./http1.ts parses a copy to find message boundaries for the recording.
// Inside a tunnel requests and responses pair first-in first-out (pipelining
// works). 101 Switching Protocols: the exchange is recorded, the rest of the
// connection is passed through unrecorded (WebSocket frames are not
// recorded, owner 2026-11-03). Where the proxy connects is the connector's
// business: the real hosts (record) or only the replay server (replay).
// Oracle: local targets in test/unit/record-proxy.test.ts (bytes and order
// seen by the target vs. the exchanges reported here); s76 end to end.
// Reproduce: bun test test/unit/record-proxy.test.ts

import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { Http1Parser, headerValues, parseHead, type Header, type ParseEvent, type RequestHead, type ResponseHead } from "./http1.ts";
import { UpstreamError } from "./upstream.ts";
import type { CertAuthority } from "./x509.ts";

/** Bodies above this are forwarded but not kept (docs/04 §5.2 rule 4). */
export const MAX_STORED_BODY = 32 * 1024 * 1024;

export type Target = { scheme: "http" | "https"; host: string; port: number };

export type Upstream = {
  socket: Duplex;
  remote: { ip: string | null; port: number | null } | null;
  /** Send absolute-form request lines (an http upstream proxy). */
  absoluteForm: boolean;
  proxyAuth: string | null;
};

export type Connector = {
  connect: (t: Target) => Promise<Upstream>;
  /** A raw TCP path to host:port for a tunnel that is not TLS; null: such tunnels are closed. */
  rawTunnel: ((host: string, port: number) => Promise<Duplex>) | null;
};

export class Body {
  chunks: Uint8Array[] = [];
  size = 0;
  tooLarge = false;
  constructor(private readonly cap: number) {}
  add(data: Uint8Array): void {
    if (data.length === 0) return;
    this.size += data.length;
    if (this.tooLarge) return;
    if (this.size > this.cap) {
      this.tooLarge = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(data);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let i = 0;
    for (const c of this.chunks) {
      out.set(c, i);
      i += c.length;
    }
    return out;
  }
}

export type Exchange = {
  /** Arrival order at the proxy (request head complete), from 1. */
  ordinal: number;
  ts: number;
  /** performance.now() at the request head's first byte (approximately: when the head completed). */
  start: number;
  method: string;
  url: string;
  request: RequestHead;
  reqBody: Body;
  response: ResponseHead | null;
  respBody: Body;
  responseStart: number | null;
  end: number | null;
  outcome: "finished" | "failed" | "incomplete";
  error: string | null;
  remote: { ip: string | null; port: number | null } | null;
  websocket: boolean;
  /** The response ended early (connection lost, proxy stopped). */
  partial: boolean;
  done: boolean;
};

export type ProxyStats = {
  requests: number;
  failed: number;
  websockets: number;
  /** Non-TLS tunnels passed through, by host:port. */
  tunnels: Map<string, number>;
  /** Client-side TLS handshakes that failed, by host (first error). */
  tlsRefused: Map<string, string>;
  /** Upstream failures by `<kind> <host:port>`. */
  upstreamFailures: Map<string, number>;
};

export type ProxyOptions = {
  port: number;
  ca: CertAuthority;
  connector: Connector;
  /** Called once per exchange when it ends (any outcome); its ordinal came from `nextOrdinal`. */
  onExchange?: (x: Exchange) => void;
  maxStoredBody?: number;
};

export type RecordProxy = { port: number; stats: ProxyStats; stop: () => Promise<void> };

const now = () => performance.now();
const enc = (s: string) => new TextEncoder().encode(s);

function hostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** host:port of a CONNECT target or an absolute URL's authority. */
function splitHostPort(authority: string, defPort: number): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(authority);
  if (m === null) return null;
  const port = m[2] === undefined ? defPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (m[1] ?? "").toLowerCase(), port };
}

/** Connection: close on the request or the response, or HTTP/1.0 without keep-alive. */
function wantsClose(x: Exchange): boolean {
  const tokens = (hs: readonly Header[]) => headerValues(hs, "connection").flatMap((v) => v.toLowerCase().split(",").map((t) => t.trim()));
  const req = tokens(x.request.headers);
  const resp = x.response === null ? [] : tokens(x.response.headers);
  if (req.includes("close") || resp.includes("close")) return true;
  return x.request.version === "HTTP/1.0" && !req.includes("keep-alive");
}

function errorResponse(status: number, reason: string, kind: string, message: string): Uint8Array {
  const body = `tabcap record: ${message}\n`;
  return enc(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\nx-tabcap-record-error: ${kind}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

export async function startRecordProxy(opts: ProxyOptions): Promise<RecordProxy> {
  const cap = opts.maxStoredBody ?? MAX_STORED_BODY;
  const stats: ProxyStats = { requests: 0, failed: 0, websockets: 0, tunnels: new Map(), tlsRefused: new Map(), upstreamFailures: new Map() };
  const sockets = new Set<Duplex>();
  const live = new Set<Exchange>();
  let ordinal = 0;
  let stopping = false;

  const track = <T extends Duplex>(s: T): T => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    return s;
  };

  const newExchange = (head: RequestHead, url: string): Exchange => {
    const x: Exchange = {
      ordinal: ++ordinal,
      ts: Date.now(),
      start: now(),
      method: head.method.toUpperCase(),
      url,
      request: head,
      reqBody: new Body(cap),
      response: null,
      respBody: new Body(cap),
      responseStart: null,
      end: null,
      outcome: "incomplete",
      error: null,
      remote: null,
      websocket: false,
      partial: false,
      done: false,
    };
    stats.requests++;
    live.add(x);
    return x;
  };

  const finish = (x: Exchange, outcome: Exchange["outcome"], error: string | null = null): void => {
    if (x.done) return;
    x.done = true;
    x.outcome = outcome;
    x.error = error;
    x.end ??= now();
    if (outcome === "incomplete" && x.response !== null) x.partial = true;
    if (outcome === "failed") stats.failed++;
    live.delete(x);
    opts.onExchange?.(x);
  };

  const noteUpstreamFailure = (e: UpstreamError, t: Target) => {
    const k = `${e.kind} ${hostForUrl(t.host)}:${t.port}`;
    stats.upstreamFailures.set(k, (stats.upstreamFailures.get(k) ?? 0) + 1);
  };

  const asUpstreamError = (e: unknown): UpstreamError => (e instanceof UpstreamError ? e : new UpstreamError("upstream-connect", e instanceof Error ? e.message : String(e)));

  // ---------------------------------------------------------- tunnels (FIFO)

  const tunnelSession = (client: Duplex, target: Target): void => {
    const reqP = new Http1Parser("request");
    const awaiting: Exchange[] = [];
    const methods: string[] = [];
    const respP = new Http1Parser("response", () => methods.shift() ?? null);
    let current: Exchange | null = null;
    let up: Upstream | null = null;
    let connecting = false;
    let failed = false;
    let pending: Uint8Array[] = [];
    let closed = false;

    const closeAll = () => {
      if (closed) return;
      closed = true;
      for (const x of awaiting) finish(x, x.response === null ? (failed ? "failed" : "incomplete") : "incomplete", x.response === null && !failed ? "connection closed before the response" : x.error);
      if (current !== null && !awaiting.includes(current)) finish(current, "incomplete", "connection closed during the request");
      client.destroy();
      up?.socket.destroy();
    };

    const toUpstream = (raw: Uint8Array) => {
      if (failed || raw.length === 0) return;
      if (up !== null) up.socket.write(raw);
      else pending.push(raw);
    };

    const onResp = (ev: ParseEvent) => {
      const x = awaiting[0];
      switch (ev.t) {
        case "head": {
          client.write(ev.raw);
          if (x === undefined || ev.head.kind !== "response") return;
          x.response = ev.head;
          x.responseStart = now();
          x.remote = up?.remote ?? null;
          if (ev.head.status === 101) {
            x.websocket = true;
            stats.websockets++;
            awaiting.shift();
            finish(x, "finished");
            for (const r of reqP.toRaw()) toUpstream(r.raw);
          }
          return;
        }
        case "info":
        case "raw":
          client.write(ev.raw);
          return;
        case "body":
          client.write(ev.raw);
          x?.respBody.add(ev.data);
          return;
        case "end":
          client.write(ev.raw);
          if (x !== undefined) {
            awaiting.shift();
            finish(x, "finished");
          }
          return;
        case "error":
          client.write(ev.raw);
          if (x !== undefined) {
            awaiting.shift();
            finish(x, "failed", `malformed response: ${ev.reason}`);
          }
          closeAll();
          return;
      }
    };

    const startUpstream = () => {
      connecting = true;
      opts.connector.connect(target).then(
        (u) => {
          if (closed) {
            u.socket.destroy();
            return;
          }
          up = u;
          track(u.socket);
          u.socket.on("data", (d: Uint8Array) => {
            for (const ev of respP.feed(d)) onResp(ev);
          });
          u.socket.on("end", () => {
            for (const ev of respP.finish()) onResp(ev);
            client.end();
          });
          u.socket.on("error", () => closeAll());
          u.socket.on("close", () => {
            if (awaiting.length > 0) closeAll();
          });
          for (const p of pending) u.socket.write(p);
          pending = [];
        },
        (e: unknown) => {
          const err = asUpstreamError(e);
          failed = true;
          pending = [];
          noteUpstreamFailure(err, target);
          client.write(errorResponse(502, "Bad Gateway", err.kind, err.message));
          for (const x of awaiting) {
            x.end = now();
            finish(x, "failed", `${err.kind}: ${err.message}`);
          }
          awaiting.length = 0;
          client.end();
        },
      );
    };

    const onReq = (ev: ParseEvent) => {
      switch (ev.t) {
        case "head": {
          if (ev.head.kind !== "request") return;
          const h = ev.head;
          const url = /^https?:\/\//i.test(h.target) ? h.target : `${target.scheme}://${hostForUrl(target.host)}${target.port === (target.scheme === "https" ? 443 : 80) ? "" : `:${target.port}`}${h.target}`;
          const x = newExchange(h, url);
          current = x;
          if (failed) {
            finish(x, "failed", "upstream unavailable");
            return;
          }
          awaiting.push(x);
          methods.push(x.method);
          if (up === null && !connecting) startUpstream();
          toUpstream(ev.raw);
          return;
        }
        case "body":
          current?.reqBody.add(ev.data);
          toUpstream(ev.raw);
          return;
        case "end":
          toUpstream(ev.raw);
          current = null;
          return;
        case "raw":
          toUpstream(ev.raw);
          return;
        case "error": {
          const x = current;
          if (x !== null) {
            const i = awaiting.indexOf(x);
            if (i >= 0) awaiting.splice(i, 1);
            finish(x, "failed", `malformed request: ${ev.reason}`);
          }
          if (!failed) client.write(errorResponse(400, "Bad Request", "bad-request", ev.reason));
          closeAll();
          return;
        }
        case "info":
          return;
      }
    };

    client.on("data", (d: Uint8Array) => {
      for (const ev of reqP.feed(d)) onReq(ev);
    });
    client.on("end", () => {
      for (const ev of reqP.finish()) onReq(ev);
      if (up !== null) up.socket.end();
      else if (!connecting) closeAll();
    });
    client.on("error", () => closeAll());
    client.on("close", () => {
      if (awaiting.length > 0 || current !== null) closeAll();
      else up?.socket.end();
    });
  };

  const onConnect = (client: net.Socket, authority: string): void => {
    const hp = splitHostPort(authority, 443);
    if (hp === null) {
      client.end(errorResponse(400, "Bad Request", "bad-request", `bad CONNECT target ${JSON.stringify(authority.slice(0, 80))}`));
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.once("data", (first: Buffer) => {
      client.pause();
      client.unshift(first);
      if (first[0] !== 0x16) {
        const tunnel = opts.connector.rawTunnel;
        if (tunnel === null) {
          client.destroy();
          return;
        }
        const key = `${hostForUrl(hp.host)}:${hp.port}`;
        stats.tunnels.set(key, (stats.tunnels.get(key) ?? 0) + 1);
        tunnel(hp.host, hp.port).then(
          (up) => {
            track(up);
            client.pipe(up);
            up.pipe(client);
            client.resume();
            up.on("error", () => client.destroy());
            client.on("error", () => up.destroy());
          },
          () => client.destroy(),
        );
        return;
      }
      opts.ca.leafFor(hp.host).then(
        (cert) => {
          if (stopping) {
            client.destroy();
            return;
          }
          let secured = false;
          const t = track(new tls.TLSSocket(client, { isServer: true, secureContext: tls.createSecureContext({ cert, key: opts.ca.leafKeyPem }), ALPNProtocols: ["http/1.1"] }));
          t.once("secure", () => {
            secured = true;
          });
          t.on("error", (e: Error) => {
            if (!secured && !stats.tlsRefused.has(hp.host)) stats.tlsRefused.set(hp.host, e.message);
          });
          tunnelSession(t, { scheme: "https", host: hp.host, port: hp.port });
          t.once("data", () => {
            secured = true;
          });
          client.resume();
        },
        () => client.destroy(),
      );
    });
  };

  // ---------------------------------------------------------- plain proxy requests (serial)

  const plainSession = (client: net.Socket): void => {
    const reqP = new Http1Parser("request");
    let chain: Promise<void> = Promise.resolve();
    let queued = 0;
    let up: { key: string; u: Upstream; respP: Http1Parser } | null = null;
    let cur: Exchange | null = null;
    let curSkip = false;
    let curDone: (() => void) | null = null;
    let closed = false;

    const closeAll = () => {
      if (closed) return;
      closed = true;
      if (cur !== null) finish(cur, "incomplete", cur.response === null ? "connection closed before the response" : null);
      curDone?.();
      client.destroy();
      up?.u.socket.destroy();
    };

    const onResp = (ev: ParseEvent) => {
      const x = cur;
      switch (ev.t) {
        case "head":
          client.write(ev.raw);
          if (x !== null && ev.head.kind === "response") {
            x.response = ev.head;
            x.responseStart = now();
            x.remote = up?.u.remote ?? null;
          }
          return;
        case "info":
        case "raw":
          client.write(ev.raw);
          return;
        case "body":
          client.write(ev.raw);
          x?.respBody.add(ev.data);
          return;
        case "end": {
          client.write(ev.raw);
          if (x !== null) finish(x, "finished");
          cur = null;
          curDone?.();
          curDone = null;
          // the client asked for (or the server announced) the end of the connection: pass it on
          if (x !== null && wantsClose(x)) {
            closed = true;
            client.end();
            up?.u.socket.end();
          }
          return;
        }
        case "error":
          if (x !== null) finish(x, "failed", `malformed response: ${ev.reason}`);
          closeAll();
          return;
      }
    };

    const connectFor = async (t: Target): Promise<Upstream> => {
      const key = `${t.host}:${t.port}`;
      if (up !== null && up.key === key && !up.u.socket.destroyed) return up.u;
      const old = up;
      up = null; // before destroy: the old socket's close handler must not touch the new exchange
      old?.u.socket.destroy();
      const u = await opts.connector.connect(t);
      track(u.socket);
      const respP = new Http1Parser("response", () => cur?.method ?? null);
      const mine = { key, u, respP };
      up = mine;
      u.socket.on("data", (d: Uint8Array) => {
        for (const ev of respP.feed(d)) onResp(ev);
      });
      u.socket.on("end", () => {
        for (const ev of respP.finish()) onResp(ev);
        if (up === mine) up = null;
      });
      u.socket.on("close", () => {
        if (up !== mine) return;
        up = null;
        if (cur !== null && !cur.done) closeAll();
      });
      u.socket.on("error", () => {
        if (up === mine) up = null;
      });
      return u;
    };

    const rewriteHead = (raw: Uint8Array, h: RequestHead, u: Upstream, originForm: string): Uint8Array => {
      const text = Buffer.from(raw).toString("latin1");
      const lines = text.slice(0, -4).split("\r\n");
      const out = [u.absoluteForm ? (lines[0] ?? "") : `${h.method} ${originForm} ${h.version}`];
      for (const line of lines.slice(1)) {
        const name = line.slice(0, line.indexOf(":")).toLowerCase();
        if (name === "proxy-connection" || name === "proxy-authorization") continue;
        out.push(line);
      }
      if (u.absoluteForm && u.proxyAuth !== null) out.push(`Proxy-Authorization: ${u.proxyAuth}`);
      return new Uint8Array(Buffer.from(`${out.join("\r\n")}\r\n\r\n`, "latin1"));
    };

    const handle = async (ev: ParseEvent): Promise<void> => {
      if (closed) return;
      switch (ev.t) {
        case "head": {
          if (ev.head.kind !== "request") return;
          const h = ev.head;
          let u: URL | null = null;
          try {
            u = /^http:\/\//i.test(h.target) ? new URL(h.target) : null;
          } catch {
            u = null;
          }
          if (u === null) {
            client.end(errorResponse(400, "Bad Request", "not-a-proxy-request", `expected CONNECT or an absolute http:// URL, got ${JSON.stringify(h.target.slice(0, 80))}`));
            closed = true;
            return;
          }
          const hp = splitHostPort(u.host, 80);
          if (hp === null) {
            client.end(errorResponse(400, "Bad Request", "bad-request", "bad host"));
            closed = true;
            return;
          }
          const target: Target = { scheme: "http", host: hp.host.replace(/^\[|\]$/g, ""), port: hp.port };
          const x = newExchange(h, u.href);
          cur = x;
          curSkip = false;
          let upstream: Upstream;
          try {
            upstream = await connectFor(target);
          } catch (e) {
            const err = asUpstreamError(e);
            noteUpstreamFailure(err, target);
            finish(x, "failed", `${err.kind}: ${err.message}`);
            cur = null;
            curSkip = true;
            client.end(errorResponse(502, "Bad Gateway", err.kind, err.message));
            closed = true;
            return;
          }
          upstream.socket.write(rewriteHead(ev.raw, h, upstream, `${u.pathname}${u.search}`));
          return;
        }
        case "body":
          if (curSkip) return;
          cur?.reqBody.add(ev.data);
          up?.u.socket.write(ev.raw);
          return;
        case "end": {
          if (curSkip) return;
          if (ev.raw.length > 0) up?.u.socket.write(ev.raw);
          const x = cur;
          if (x === null || x.done) return;
          // one request at a time: the next head waits for this response
          await new Promise<void>((resolve) => {
            curDone = resolve;
          });
          return;
        }
        case "raw":
          up?.u.socket.write(ev.raw);
          return;
        case "error":
          if (cur !== null) finish(cur, "failed", `malformed request: ${ev.reason}`);
          cur = null;
          client.end(errorResponse(400, "Bad Request", "bad-request", ev.reason));
          closed = true;
          return;
        case "info":
          return;
      }
    };

    const push = (events: ParseEvent[]) => {
      for (const ev of events) {
        queued++;
        if (queued > 256) client.pause();
        chain = chain.then(() => handle(ev)).then(
          () => {
            queued--;
            if (queued <= 64 && !closed) client.resume();
          },
          () => closeAll(),
        );
      }
    };
    client.on("data", (d: Uint8Array) => push(reqP.feed(d)));
    client.on("end", () => {
      push(reqP.finish());
      chain = chain.then(() => {
        up?.u.socket.end();
      });
    });
    client.on("error", () => closeAll());
    client.on("close", () => {
      if (cur !== null) closeAll();
    });
  };

  // ---------------------------------------------------------- accept

  const server = net.createServer((client) => {
    track(client);
    if (stopping) {
      client.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 65536) client.end(errorResponse(400, "Bad Request", "bad-request", "request head too large"));
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = parseHead(buf.subarray(0, end).toString("latin1"), "request");
      if (typeof head !== "string" && head.kind === "request" && head.method.toUpperCase() === "CONNECT") {
        const rest = buf.subarray(end + 4);
        if (rest.length > 0) client.unshift(rest);
        client.resume();
        onConnect(client, head.target);
        return;
      }
      client.unshift(buf);
      plainSession(client);
      client.resume();
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    port,
    stats,
    stop: async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
      for (const x of [...live]) finish(x, "incomplete", "the proxy stopped before the exchange ended");
    },
  };
}

export { headerValues, type Header };
