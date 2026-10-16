// Local range for the docs/12 comparison runs (loopback only).
//
// - s22 frames: startFrameSite from test/e2e/site.ts, unchanged.
// - s21 aes-json: test/e2e/site.ts has no s21 yet, so this file serves it as
//   docs/05 §s21 describes it: GET /api/key returns the key in clear JSON,
//   GET /api/secret returns {code:0, data:"<base64 AES-GCM ciphertext>"}, the
//   page decrypts it and renders the rows; /api/secret carries signature-like
//   request headers (x-ts, x-sign). Key and IV are fixed range literals so
//   every run returns the same bytes.
//
// Run: bun docs/compare/range.ts   (prints the origins as one JSON line, serves until Ctrl-C)

import { startFrameSite } from "../../test/e2e/site.ts";

export const S21_KEY = "s21-range-key-01"; // 16 bytes, AES-128
export const S21_IV = "s21-range-iv"; // 12 bytes
// 12 rows: the ciphertext is then over 256 bytes, the shortest payload
// analyze find judges for entropy (ENTROPY_MIN_SIZE in src/analyze/find.ts).
export const S21_ROWS = Array.from({ length: 12 }, (_, i) => ({ no: `S21-${String(i + 1).padStart(4, "0")}`, amount: `${(i + 1) * 1234}.50` }));

const enc = new TextEncoder();

async function sealed(): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(S21_KEY), "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: enc.encode(S21_IV) }, key, enc.encode(JSON.stringify({ rows: S21_ROWS })));
  return Buffer.from(new Uint8Array(ct)).toString("base64");
}

const S21_PAGE = `<!doctype html><meta charset=utf-8><title>s21 aes-json</title>
<h1>订单</h1><table id=t></table>
<script>
const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
(async () => {
  const k = await (await fetch("/api/key")).json();
  const ts = String(Date.now());
  const sign = hex(await crypto.subtle.digest("SHA-256", te.encode(ts + "|" + k.key)));
  const r = await (await fetch("/api/secret", { headers: { "x-ts": ts, "x-sign": sign } })).json();
  const raw = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", te.encode(k.key), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: te.encode(k.iv) }, key, raw);
  const j = JSON.parse(new TextDecoder().decode(pt));
  document.getElementById("t").innerHTML = j.rows.map((x) => "<tr><td>" + x.no + "</td><td>" + x.amount + "</td></tr>").join("");
})();
</script>`;

export function startAesSite(): { url: string; hits: string[]; stop: () => void } {
  const hits: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env["S21_PORT"] ?? 0),
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s21") return new Response(S21_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (u.pathname === "/api/key") return json({ key: S21_KEY, iv: S21_IV });
      if (u.pathname === "/api/secret") return json({ code: 0, data: await sealed() });
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${s.port}`, hits, stop: () => s.stop(true) };
}

if (import.meta.main) {
  const s21 = startAesSite();
  const s22 = startFrameSite();
  console.log(JSON.stringify({ s21: `${s21.url}/s21`, s22: `${s22.a}/s22`, s22b: s22.b }));
  const stop = () => {
    s21.stop();
    s22.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
