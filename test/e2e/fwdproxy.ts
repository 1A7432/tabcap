// Local HTTP forward proxy for the 0.4-D e2e (same shape as the 10-16 spike's):
// absolute-form requests only, optional Basic authentication (407 +
// Proxy-Authenticate until the right Proxy-Authorization arrives), CONNECT is
// logged and refused with 405 (nothing is tunnelled anywhere), and every
// accepted request is forwarded to 127.0.0.1:<port of the URL>, so nothing
// outside the machine is ever contacted. `hits` is the oracle: each request
// line, whether it carried Proxy-Authorization and whether it was right.

export type ProxyHit = { line: string; method: string; target: string; hasAuth: boolean; authOk: boolean | null; answered: "forward" | "407" | "405-connect" | "400" };
export type FwdProxy = { port: number; url: string; hits: ProxyHit[]; stop: () => void };

type Conn = { buf: Buffer; upstream: { write: (d: Uint8Array) => unknown; end: () => unknown } | null; headDone: boolean };

export function startForwardProxy(o: { user?: string; pass?: string } = {}): FwdProxy {
  const hits: ProxyHit[] = [];
  const want = o.user !== undefined && o.pass !== undefined ? `Basic ${Buffer.from(`${o.user}:${o.pass}`).toString("base64")}` : null;
  const server = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0), upstream: null, headDone: false };
      },
      async data(s, chunk) {
        const st = s.data;
        if (st.upstream !== null) {
          st.upstream.write(chunk);
          return;
        }
        if (st.headDone) return;
        st.buf = Buffer.concat([st.buf, Buffer.from(chunk)]);
        const end = st.buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        st.headDone = true;
        const head = st.buf.subarray(0, end).toString("latin1");
        const rest = st.buf.subarray(end + 4);
        const lines = head.split("\r\n");
        const line = lines[0] ?? "";
        const headers = lines.slice(1);
        const pa = headers.find((h) => /^proxy-authorization:/i.test(h));
        const paVal = pa === undefined ? null : pa.slice(pa.indexOf(":") + 1).trim();
        const authOk = want === null ? null : paVal === want;
        const [method = "", target = "", ver = "HTTP/1.1"] = line.split(" ");
        const hit = (answered: ProxyHit["answered"]) => hits.push({ line, method, target, hasAuth: paVal !== null, authOk, answered });
        if (method === "CONNECT") {
          hit("405-connect");
          s.write("HTTP/1.1 405 Not Supported\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          s.end();
          return;
        }
        if (want !== null && authOk !== true) {
          hit("407");
          s.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="tabcap-e2e"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          s.end();
          return;
        }
        let u: URL;
        try {
          u = new URL(target);
        } catch {
          hit("400");
          s.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          s.end();
          return;
        }
        hit("forward");
        const kept = headers.filter((h) => !/^(proxy-authorization|proxy-connection|connection|keep-alive):/i.test(h));
        const out = `${method} ${u.pathname}${u.search} ${ver}\r\n${kept.join("\r\n")}\r\nConnection: close\r\n\r\n`;
        // every host name goes to the local origin: no external network
        const up = await Bun.connect({
          hostname: "127.0.0.1",
          port: Number(u.port === "" ? 80 : u.port),
          socket: {
            data(_u, d) {
              s.write(d);
            },
            close() {
              s.end();
            },
            error() {
              s.end();
            },
          },
        });
        st.upstream = up;
        up.write(Buffer.concat([Buffer.from(out, "latin1"), rest]));
      },
      close(s) {
        s.data?.upstream?.end();
      },
      error() {},
    },
  });
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}
