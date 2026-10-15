// The daemon's listener (docs/08 Windows 待验项).
// - macOS / Linux: HTTP over a Unix socket, 0600 in a 0700 directory; the file
//   permissions are the access control.
// - Windows: Bun.serve has no `unix` option there, so HTTP on 127.0.0.1 with a
//   random port, and a bearer token made fresh at every start. Port and token
//   go into config/daemon.json (under %LOCALAPPDATA%\tabcap, user-default ACL);
//   the CLI reads them from there. The token is never logged, never put on a
//   command line and never returned by /status. A request without the right
//   token gets 401 and is not looked at further.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { fail } from "../shared/envelope.ts";

export type ListenSpec = { kind: "unix"; socket: string } | { kind: "tcp"; token: string };

export type Listening = {
  server: ReturnType<typeof Bun.serve>;
  /** What goes into daemon.json next to pid / startedAt (the token included, for the CLI). */
  record: { listener: "unix"; socket: string } | { listener: "tcp"; host: "127.0.0.1"; port: number; token: string };
  /** For logs and /status: never the token. */
  describe: { listener: "unix"; socket: string } | { listener: "tcp"; host: "127.0.0.1"; port: number };
};

/** 32 random bytes, lowercase hex. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function authorized(req: Request, token: string): boolean {
  const h = req.headers.get("authorization");
  if (h === null || !h.startsWith("Bearer ")) return false;
  const got = Buffer.from(h.slice("Bearer ".length), "utf8");
  const want = Buffer.from(token, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

const UNAUTHORIZED = JSON.stringify(fail("usage", "missing or wrong daemon token", "Use the tabcap CLI; it reads the token from config/daemon.json."));

type Handler = (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>;

export function listen(spec: ListenSpec, handler: Handler): Listening {
  if (spec.kind === "unix") {
    const server = Bun.serve({ unix: spec.socket, fetch: handler });
    return { server, record: { listener: "unix", socket: spec.socket }, describe: { listener: "unix", socket: spec.socket } };
  }
  const token = spec.token;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (!authorized(req, token)) return new Response(UNAUTHORIZED, { status: 401, headers: { "content-type": "application/json" } });
      return handler(req, srv);
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("the TCP listener has no port");
  }
  return { server, record: { listener: "tcp", host: "127.0.0.1", port, token }, describe: { listener: "tcp", host: "127.0.0.1", port } };
}
