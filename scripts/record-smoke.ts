// Release smoke for `tabcap record` in the compiled binary (docs/04 §50.4):
// a local https target (the wire test certificate), a bun child that fetches
// it through the proxy (bun honours HTTPS_PROXY and NODE_EXTRA_CA_CERTS on
// every platform), and the answer must say one request was recorded.
// Usage: bun scripts/record-smoke.ts <path to the tabcap binary>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
if (bin === undefined) throw new Error("usage: bun scripts/record-smoke.ts <tabcap binary>");
const certs = join(import.meta.dir, "../src/wire/certs");
const target = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(join(certs, "leaf.pem")), key: Bun.file(join(certs, "leaf-key.pem")) },
  fetch: (req) => new Response(`smoke ${new URL(req.url).pathname}`),
});
const work = mkdtempSync(join(tmpdir(), "tabcap-record-smoke-"));
try {
  const out = join(work, "bundle");
  const client = `const r = await fetch("https://localhost:${target.port}/smoke"); if (r.status !== 200) process.exit(5);`;
  // async spawn: the target lives in this process, a synchronous spawn would block it
  const p = Bun.spawn([bin, "record", "-o", out, "--upstream", "none", "--upstream-ca", join(certs, "ca.pem"), "--", process.execPath, "-e", client], { env: { ...process.env, TABCAP_HOME: join(work, "home") }, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(p.stdout).text();
  const code = await p.exited;
  const answer = JSON.parse(text.trim().split("\n").pop() ?? "{}") as { ok?: boolean; data?: { requests?: number; exitCode?: number } };
  if (code !== 0 || answer.ok !== true || answer.data?.requests !== 1 || answer.data.exitCode !== 0) {
    console.error(`record smoke failed (exit ${code}): ${text}`);
    process.exit(1);
  }
  console.log(`record smoke ok: ${text.trim()}`);
} finally {
  void target.stop(true);
  rmSync(work, { recursive: true, force: true });
}
