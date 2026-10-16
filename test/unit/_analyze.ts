// Synthetic bundle builders for the analyze tests (find / diff).
// Bundles are written through the real BundleWriter; payloads are produced by
// real encoders in the tests (gzip, brotli, base64, WebCrypto), so expected
// values come from computation, not from hand-written bytes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../../src/shared/ids.ts";
import type { BodyMissingReason, Headers, RawEvent, ResourceType } from "../../src/bundle/types.ts";
import { BundleWriter } from "../../src/bundle/writer.ts";

export const tmp = (p = "tabcap-an-"): string => mkdtempSync(join(tmpdir(), p));

export type ReqSpec = {
  url: string;
  method?: string;
  type?: ResourceType;
  status?: number;
  mime?: string | null;
  body?: Uint8Array | string | null;
  base64?: boolean;
  wireEncoding?: string | null;
  bodyMissing?: BodyMissingReason;
  reqHeaders?: Headers;
  respHeaders?: Headers;
  postData?: string | null;
  ts: number;
  /** Extra request-event fields (e.g. unreadByPage), merged last. */
  extra?: Record<string, unknown>;
};

export type Build = {
  w: BundleWriter;
  request(spec: ReqSpec): Promise<RawEvent>;
  ws(handshake: string, ts: number, direction: "send" | "recv", payload: { text: string } | { binary: Uint8Array }): Promise<RawEvent>;
  console(ts: number, text: string, level?: string): RawEvent;
};

const ENV = { actor: "human" as const, tab: "t1", cmd: null };

export async function buildBundle(
  dir: string,
  meta: { name: string; created: number; seed: number },
  fill: (b: Build) => Promise<void>,
): Promise<string> {
  const w = await BundleWriter.open(dir, {
    now: () => meta.created + 600_000,
    init: {
      id: ulid(meta.created, new Uint8Array(10).fill(meta.seed)),
      created: meta.created,
      session: { name: meta.name, tabs: [{ tab: "t1", chromeTabId: 1, owned: true, firstUrl: null }] },
      mode: { capture: "mixed", trace: false, raw: false },
    },
  });
  const nav = w.append((seq) => ({ ...ENV, ts: meta.created, mono: 1000, kind: "nav", frame: "root", nav: `n-${seq}`, url: "http://127.0.0.1:4310/", from: null, type: "navigation", loaderId: "L1", loadEvent: null }));
  const navId = typeof nav["nav"] === "string" ? nav["nav"] : null;

  const b: Build = {
    w,
    async request(s) {
      let body: Record<string, unknown> | null = null;
      if (s.body !== undefined && s.body !== null) {
        const put = await w.putBlob(s.body);
        if (put.outcome !== "stored") throw new Error("fixture body not stored");
        body = { blob: put.ref, size: put.size, base64: s.base64 ?? false, wireEncoding: s.wireEncoding ?? null, truncated: false };
      }
      const respHeaders: Headers = { ...(s.mime ? { "content-type": s.mime } : {}), ...(s.wireEncoding ? { "content-encoding": s.wireEncoding } : {}), ...(s.respHeaders ?? {}) };
      return w.append((seq) => ({
        ...ENV,
        ts: s.ts,
        mono: 1000 + (s.ts - meta.created),
        kind: "request",
        nav: navId,
        id: `r-${seq}`,
        cdp: null,
        type: s.type ?? "xhr",
        method: s.method ?? "GET",
        url: s.url,
        urlFragment: null,
        initiator: null,
        request: { headers: s.reqHeaders ?? {}, headersSource: "event", postData: s.postData === undefined || s.postData === null ? null : { inline: s.postData } },
        response: {
          status: s.status ?? 200,
          statusText: "OK",
          headers: respHeaders,
          headersSource: "event",
          mimeType: s.mime ?? null,
          charset: null,
          protocol: "http/1.1",
          remote: null,
          fromCache: false,
          fromServiceWorker: false,
          fromPrefetch: false,
          body,
          bodyMissing: s.bodyMissing === undefined ? null : { reason: s.bodyMissing, detail: null },
        },
        redirect: null,
        timing: null,
        outcome: s.bodyMissing === "navigated" ? "incomplete" : "finished",
        error: null,
        ...(s.extra ?? {}),
      }));
    },
    async ws(handshake, ts, direction, payload) {
      let p: Record<string, unknown>;
      let opcode: 1 | 2;
      if ("text" in payload) {
        p = { inline: payload.text };
        opcode = 1;
      } else {
        const put = await w.putBlob(payload.binary);
        if (put.outcome !== "stored") throw new Error("fixture frame not stored");
        p = { blob: put.ref, size: put.size };
        opcode = 2;
      }
      return w.append({ ...ENV, ts, mono: null, kind: "ws", ws: handshake, phase: "frame", direction, opcode, payload: p, reason: null });
    },
    console(ts, text, level = "error") {
      return w.append({ ...ENV, ts, mono: null, kind: "console", level, source: "console", text, args: [], url: "http://127.0.0.1:4310/app.js", line: 10, col: 5, stack: null });
    },
  };
  await fill(b);
  await w.close();
  return dir;
}

export function idOf(e: RawEvent): string {
  const id = e["id"];
  if (typeof id !== "string") throw new Error(`event ${e.seq} has no id`);
  return id;
}

export const b64 = (b: Uint8Array | string): string => Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64");
