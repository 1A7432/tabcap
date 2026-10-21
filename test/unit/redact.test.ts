import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { exportHar } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { newManifest } from "../../src/bundle/manifest.ts";
import { RULES_VERSION, isSensitiveName, nameWords, redactBundle, redactView } from "../../src/bundle/redact.ts";
import type { RawEvent } from "../../src/bundle/types.ts";
import { isRecord } from "../../src/shared/json.ts";
import { JWT, SECRET_SID, buildRichBundle } from "./_fixtures.ts";
import { buildBundle } from "./_analyze.ts";

const tmp = (p = "tabcap-redact-") => mkdtempSync(join(tmpdir(), p));

/** Placeholder computed independently from the spec formula (§8). */
const placeholder = (kind: string, salt: string, value: string) =>
  `«r:${kind}:${new Bun.CryptoHasher("sha256").update(salt + value).digest("hex").slice(0, 8)}»`;

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join("/")] = new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function redactedRich() {
  const src = tmp("tabcap-rich-");
  await buildRichBundle(src);
  const before = snapshotTree(src);
  const out = join(tmp(), "copy");
  const res = await redactBundle(src, out, { now: () => 1760500999000 });
  const salt = readFileSync(join(src, "exports", "copy.salt"), "utf8").trim();
  return { src, out, res, salt, before, copy: BundleReader.open(out), orig: BundleReader.open(src) };
}

describe("sensitive names (default@2, owner 2026-10-16)", () => {
  test("pass / pwd match as a name segment only; the default@1 substrings keep matching anywhere", () => {
    for (const n of ["pass", "user_pass", "userPass", "login-pwd", "pwd", "Pwd2", "PASS", "user.pass", "USER_PWD", "loginPwd"]) expect([n, isSensitiveName(n)]).toEqual([n, true]);
    for (const n of ["bypass", "passport", "compass", "passenger", "pwds", "q", "page", "user"]) expect([n, isSensitiveName(n)]).toEqual([n, false]);
    for (const n of ["password", "passwd", "mypassword", "x-token", "csrftoken", "secretKey", "sessionid", "sid", "oauth", "api_key", "apikey"]) expect([n, isSensitiveName(n)]).toEqual([n, true]);
    expect(nameWords("XMLPass2go")).toEqual(["XML", "Pass", "2", "go"]);
  });

  test("`ticket` is not a sensitive name (owner 2026-10-17: the name list also classifies replay inputs)", () => {
    for (const n of ["ticket", "serviceTicket", "cas-ticket", "tickets"]) expect([n, isSensitiveName(n)]).toEqual([n, false]);
  });

  test("default@2: a HAR export keeps the ticket of a CAS return URL (not a sensitive name)", async () => {
    const src = tmp("tabcap-ticket-");
    await buildBundle(src, { name: "cas", created: 1760500000000, seed: 7 }, async (b) => {
      await b.request({ url: "http://127.0.0.1:4310/cas/return?ticket=ST-12345-abcdefXYZ&lang=zh", type: "document", mime: "text/html", body: "<p>ok</p>", ts: 1760500000001 });
    });
    const har = JSON.stringify(exportHar(BundleReader.open(src), { redact: { salt: "s" } }).har);
    expect(har).toContain("ticket=ST-12345-abcdefXYZ&lang=zh");
  });
});

describe("redaction (docs/04 §8)", () => {
  test("same secret -> same placeholder across cookie header, query and JSON body", async () => {
    const { copy, salt } = await redactedRich();
    const ph = placeholder("secret", salt, SECRET_SID);
    const r4 = copy.requests().find((q) => q.id === "r-4");
    if (r4 === undefined) throw new Error("r-4 missing");
    expect(r4.request.headers["cookie"]).toBe(`sid=${ph}; theme=${placeholder("secret", salt, "dark")}`);
    expect(r4.url).toContain(`sid=${ph}`);
    const body = new TextDecoder().decode(copy.readBlob(r4.response?.body?.blob ?? "") ?? new Uint8Array());
    expect(JSON.parse(body).items[0].sid).toBe(ph);
    expect(body).not.toContain(SECRET_SID);
    // set-cookie keeps attributes, masks the value
    expect(r4.response?.headers["set-cookie"]).toEqual([`sid=${ph}; Path=/; HttpOnly`, `theme=${placeholder("secret", salt, "dark")}`]);
  });

  test("authorization is masked (JWT kind); non-sensitive fields untouched", async () => {
    const { copy, salt } = await redactedRich();
    const r4 = copy.requests().find((q) => q.id === "r-4");
    expect(r4?.request.headers["authorization"]).toBe(`Bearer ${placeholder("jwt", salt, JWT)}`);
    expect(r4?.request.headers["accept"]).toBe("application/json");
    expect(r4?.url.startsWith("http://127.0.0.1:4310/api/items?page=2&")).toBe(true);
    expect(r4?.url).toContain(`q=${placeholder("mobile", salt, "13800138000")}`);
    const body = JSON.parse(new TextDecoder().decode(copy.readBlob(r4?.response?.body?.blob ?? "") ?? new Uint8Array()));
    expect(body.items[0].title).toBe("条目 A");
    expect(body.contact).toBe(placeholder("email", salt, "demo@example.com"));
    // form body: password masked by name, other params untouched
    const r5 = copy.requests().find((q) => q.id === "r-5");
    const pd = r5?.request.postData;
    expect(pd !== null && pd !== undefined && "inline" in pd ? pd.inline : null).toBe(
      `user=demo&password=${placeholder("secret", salt, "hunter2secret")}&remember=1`,
    );
    expect(r5?.request.headers["x-api-key"]).toBe(placeholder("secret", salt, "k-998877"));
  });

  test("state blob values masked; same placeholder as the cookie header", async () => {
    const { copy, salt } = await redactedRich();
    const st = copy.byKind("state")[0];
    const cookies = JSON.parse(new TextDecoder().decode(copy.readBlob(String(st?.["blob"])) ?? new Uint8Array()));
    expect(cookies.map((c: { value: string }) => c.value)).toEqual([placeholder("secret", salt, SECRET_SID), placeholder("secret", salt, "dark")]);
    expect(cookies[0].name).toBe("sid");
  });

  test("copy has manifest.redaction and recomputed counts; source unchanged; salt only in source exports/", async () => {
    const { src, out, res, salt, before, copy, orig } = await redactedRich();
    expect(copy.manifest.redaction).toEqual({ rules: "default@3", applied: 1760500999000 });
    expect(orig.manifest.redaction).toBeNull();
    expect(copy.manifest.counts.events).toBe(orig.events.length);
    expect(copy.manifest.counts.requests).toBe(orig.manifest.counts.requests);
    const onDisk = Object.entries(snapshotTree(out))
      .filter(([p]) => p.startsWith("blobs/"))
      .reduce((n, [p]) => n + statSync(join(out, p)).size, 0);
    expect(copy.manifest.counts.blobBytes).toBe(onDisk);
    expect(copy.events.map((e) => e.seq)).toEqual(orig.events.map((e) => e.seq));
    expect(res.blobsRewritten).toBeGreaterThan(0);
    expect(res.missingBlobs).toEqual([]);

    const after = snapshotTree(src);
    const withoutExports = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([p]) => !p.startsWith("exports/")));
    expect(withoutExports(after)).toEqual(before);
    expect(Object.keys(after).filter((p) => p.startsWith("exports/"))).toEqual(["exports/copy.salt"]);

    for (const p of Object.keys(snapshotTree(out))) {
      expect(readFileSync(join(out, p)).includes(salt)).toBe(false);
      expect(readFileSync(join(out, p)).includes(SECRET_SID)).toBe(false);
    }
  });

  test("HAR export with redaction leaks neither the secret nor the password", async () => {
    const src = tmp("tabcap-rich-");
    await buildRichBundle(src);
    const har = JSON.stringify(exportHar(BundleReader.open(src), { redact: { salt: "s" }, embedEvents: true }).har);
    for (const secret of [SECRET_SID, "hunter2secret", JWT, "13800138000", "demo@example.com"]) expect(har.includes(secret)).toBe(false);
    expect(har).toContain(placeholder("secret", "s", SECRET_SID));
  });

  test("refuses a non-empty output directory", async () => {
    const src = tmp("tabcap-rich-");
    await buildRichBundle(src);
    await expect(redactBundle(src, src)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("default@3: every event kind is walked (review 2026-10-21)", () => {
  const TOKEN = "SECRETTOKEN123";
  const OTHER = "OTHERSECRET99";
  const salt = "s3";
  const env = { ts: 1, mono: null, actor: "ai" as const, tab: "t1", cmd: null };
  const ph = (v: string, kind = "secret") => placeholder(kind, salt, v);
  const blob = `sha256:${"a".repeat(64)}`;

  function view() {
    const manifest = newManifest({ created: 1, notes: "shared with demo@example.com" });
    manifest.producer.browser = {
      name: "Chrome",
      version: "155.0.1.2",
      args: ["--user-data-dir=<profile>", "--remote-debugging-pipe", `--app=https://a.example/start?session=${OTHER}`],
      extraArgs: ["--lang=zh", "--note=ask demo@example.com"],
      dropArgs: ["--disable-extensions"],
    };
    const events: RawEvent[] = [
      { seq: 1, ...env, kind: "cmd", phase: "start", id: "c-1", argv: ["navigate", `https://a.example/cb?token=${TOKEN}`], input: { url: `https://a.example/cb?token=${TOKEN}`, note: "for demo@example.com" } },
      { seq: 2, ...env, kind: "request", id: "r-2", method: "GET", type: "document", url: `https://a.example/cb?token=${TOKEN}`, urlFragment: null, outcome: "failed", error: { text: `net::ERR at https://a.example/x?code=${TOKEN}` }, request: { headers: {}, headersSource: "event", postData: null }, response: null },
      { seq: 3, ...env, kind: "cmd", phase: "end", ref: "c-1", ok: false, durationMs: 3, error: { code: "page", message: `the request failed at /cb?code=${TOKEN}` }, outputSummary: { url: `https://a.example/cb?token=${TOKEN}`, text: `token was ${TOKEN}` } },
      { seq: 4, ...env, kind: "guard", event: "end", site: "a", account: null, detail: { rule: "json:$.code!=0", detail: `$.data is "${TOKEN}"`, request: "r-2", url: `https://a.example/api?access_token=${OTHER}&next=${TOKEN}`, status: 200 } },
      { seq: 5, ...env, kind: "console", level: "log", source: "console-api", text: `jwt ${JWT} mail demo@example.com`, args: ["demo@example.com", "https://a.example/x?sid=CONSOLESID77"], url: "https://a.example/", line: 1, col: 1, stack: null },
      { seq: 6, ...env, kind: "handoff", state: "resumed", reason: "human-takeover", question: "Log in as demo@example.com, then continue.", timeoutMs: null, answerRef: null, condition: { kind: "url", value: `/home?sid=${TOKEN}` } },
      { seq: 7, ...env, kind: "protection", nav: "n-1", url: `https://a.example/cb?token=${TOKEN}`, detections: [{ family: "x", name: "X", category: "waf", confidence: "high", matched: [{ rule: "r1", layer: "edge", kind: "request", where: ["r-2 https://a.example/u/demo@example.com", `cookie ${TOKEN}`] }] }] },
      { seq: 8, ...env, kind: "screenshot", blob, format: "png", width: 1, height: 1, scale: 1, reason: "handoff", nav: null },
    ];
    return { manifest, events, readBlob: () => null };
  }

  const byKind = (events: readonly RawEvent[], seq: number): Record<string, unknown> => {
    const e = events.find((x) => x.seq === seq);
    if (e === undefined) throw new Error(`event ${seq} missing`);
    return e;
  };
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

  test("cmd argv / input / outputSummary / error, guard detail, console, handoff, protection and manifest args are redacted", () => {
    const v = redactView(view(), { salt, now: () => 9 });
    expect(RULES_VERSION).toBe("default@3");
    expect(v.manifest.redaction).toEqual({ rules: "default@3", applied: 9 });
    const t = ph(TOKEN);
    const o = ph(OTHER);
    const mail = ph("demo@example.com", "email");

    const start = byKind(v.events, 1);
    expect(start["argv"]).toEqual(["navigate", `https://a.example/cb?token=${t}`]);
    expect(start["input"]).toEqual({ url: `https://a.example/cb?token=${t}`, note: `for ${mail}` });

    const req = byKind(v.events, 2);
    expect(req["url"]).toBe(`https://a.example/cb?token=${t}`);
    expect(req["error"]).toEqual({ text: `net::ERR at https://a.example/x?code=${t}` });

    const end = byKind(v.events, 3);
    expect(end["error"]).toEqual({ code: "page", message: `the request failed at /cb?code=${t}` });
    expect(end["outputSummary"]).toEqual({ url: `https://a.example/cb?token=${t}`, text: `token was ${t}` });

    const guard = byKind(v.events, 4);
    expect(guard["detail"]).toEqual({ rule: "json:$.code!=0", detail: `$.data is "${t}"`, request: "r-2", url: `https://a.example/api?access_token=${o}&next=${t}`, status: 200 });

    const con = byKind(v.events, 5);
    expect(con["text"]).toBe(`jwt ${ph(JWT, "jwt")} mail ${mail}`);
    expect(con["args"]).toEqual([mail, `https://a.example/x?sid=${ph("CONSOLESID77")}`]);

    const hand = byKind(v.events, 6);
    expect(hand["question"]).toBe(`Log in as ${mail}, then continue.`);
    expect(hand["condition"]).toEqual({ kind: "url", value: `/home?sid=${t}` });

    const prot = byKind(v.events, 7);
    const det = Array.isArray(prot["detections"]) ? rec(prot["detections"][0]) : {};
    const m0 = Array.isArray(det["matched"]) ? rec(det["matched"][0]) : {};
    expect(m0["where"]).toEqual([`r-2 https://a.example/u/${mail}`, `cookie ${t}`]);
    expect(prot["url"]).toBe(`https://a.example/cb?token=${t}`);

    const b = v.manifest.producer.browser;
    expect(b?.args).toEqual(["--user-data-dir=<profile>", "--remote-debugging-pipe", `--app=https://a.example/start?session=${o}`]);
    expect(b?.extraArgs).toEqual(["--lang=zh", `--note=ask ${mail}`]);
    expect(b?.dropArgs).toEqual(["--disable-extensions"]);
    expect(v.manifest.notes).toBe(`shared with ${mail}`);

    const all = JSON.stringify({ m: v.manifest, e: v.events });
    for (const secret of [TOKEN, OTHER, "CONSOLESID77", "demo@example.com", JWT]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });

  test("ids, refs, blob refs and envelope fields stay as recorded", () => {
    const src = view();
    const v = redactView(src, { salt });
    expect(v.events.map((e) => [e.seq, e.kind, e.tab, e.cmd, e.ts, e.actor])).toEqual(src.events.map((e) => [e.seq, e.kind, e.tab, e.cmd, e.ts, e.actor]));
    expect(byKind(v.events, 1)["id"]).toBe("c-1");
    expect(byKind(v.events, 3)["ref"]).toBe("c-1");
    expect(rec(byKind(v.events, 4)["detail"])["request"]).toBe("r-2");
    expect(byKind(v.events, 7)["nav"]).toBe("n-1");
    expect(byKind(v.events, 8)["blob"]).toBe(blob);
    expect(byKind(v.events, 4)["site"]).toBe("a");
  });

  test("HAR --embed-events carries the same redacted events", () => {
    const har = exportHar(view(), { redact: { salt }, embedEvents: true }).har;
    const text = JSON.stringify(har.log._events ?? []);
    expect(text).toContain(`token=${ph(TOKEN)}`);
    for (const secret of [TOKEN, OTHER, "CONSOLESID77", "demo@example.com"]) expect([secret, text.includes(secret)]).toEqual([secret, false]);
  });
});
