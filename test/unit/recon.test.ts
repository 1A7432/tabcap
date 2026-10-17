// recon dossier v0 (0.4-J): path templating, body classes, page tokens,
// coverage arithmetic, cookie classification and the role table, protection
// signals, Markdown rendering and the files written into exports/.
// Expected values come from what each synthetic bundle plants (the constants
// below), never from running recon.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BundleReader } from "../../src/bundle/reader.ts";
import {
  COOKIE_ROLES,
  DOSSIER_SCHEMA,
  IDENTIFICATION_ONLY,
  PROTECTION_SIGNALS,
  STACK_MARKERS,
  bodyClass,
  buildDossier,
  channelTemplate,
  cookieRole,
  pageTokens,
  recordedPage,
  renderDossierMd,
  writeDossier,
  type Dossier,
  type ReconPage,
} from "../../src/analyze/recon.ts";
import { runAnalyze } from "../../src/cli/analyze.ts";
import { summarize } from "../../src/daemon/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { b64, buildBundle, idOf, tmp } from "./_analyze.ts";

const O = "http://127.0.0.1:4310";
const C = 1760800000000;
const JSON_MIME = "application/json";

const live = (text: string, url = `${O}/orders`): ReconPage => ({ url, title: "Orders", text, source: "live", adapters: [{ adapter: "overlay", category: "overlay", confidence: 0, evidence: [] }] });

describe("path templates and body classes", () => {
  test("numeric, uuid and long-hex segments become {id}; the query is dropped", () => {
    expect(channelTemplate(`${O}/api/items/123/detail?x=1`)).toBe("/api/items/{id}/detail");
    expect(channelTemplate(`${O}/api/u/0f8fad5b-d9cb-469f-a165-70867728950e`)).toBe("/api/u/{id}");
    expect(channelTemplate(`${O}/f/0123456789abcdef0123`)).toBe("/f/{id}");
    // short hex, and long hex-letter words without a digit, stay
    expect(channelTemplate(`${O}/f/deadbeef`)).toBe("/f/deadbeef");
    expect(channelTemplate(`${O}/f/facadebeadedfacade`)).toBe("/f/facadebeadedfacade");
    expect(channelTemplate(`${O}/s06`)).toBe("/s06");
    expect(channelTemplate(`${O}/`)).toBe("/");
  });

  test("body classes: json | html | fragment | text | binary | ws | sse", () => {
    expect(bodyClass("xhr", "application/json; charset=utf-8", "{}")).toBe("json");
    expect(bodyClass("fetch", "application/vnd.api+json", null)).toBe("json");
    expect(bodyClass("document", "text/html", "<p>x")).toBe("html");
    expect(bodyClass("xhr", "text/html", "<tr><td>1</td></tr>")).toBe("fragment");
    expect(bodyClass("fetch", "text/html", "<!doctype html><title>x</title>")).toBe("html");
    expect(bodyClass("fetch", "text/plain", '{"a":1}')).toBe("json");
    expect(bodyClass("script", "text/javascript", "var a")).toBe("text");
    expect(bodyClass("stylesheet", "text/css", "a{}")).toBe("text");
    expect(bodyClass("image", "image/png", null)).toBe("binary");
    expect(bodyClass("fetch", "application/octet-stream", null, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("binary");
    expect(bodyClass("websocket", null, null)).toBe("ws");
    expect(bodyClass("eventsource", "text/event-stream", "data: 1")).toBe("sse");
    expect(bodyClass("fetch", "text/event-stream", "data: 1")).toBe("sse");
  });

  test("page tokens: words >= 4 characters, numbers >= 4 digits, de-duplicated in page order", () => {
    expect(pageTokens("hits alpha-2-a,alpha-2-b")).toEqual(["hits", "alpha-2-a", "alpha-2-b"]);
    expect(pageTokens("abc 123 1,234 12.5 2026 data data 1.234,56")).toEqual(["1,234", "2026", "data", "1.234,56"]);
    expect(pageTokens("登录 请完成验证 用户名")).toEqual(["请完成验证"]);
    expect(pageTokens("")).toEqual([]);
  });
});

describe("tables", () => {
  test("cookie roles by name (first match wins)", () => {
    const cases: [string, string][] = [
      ["sid", "session"],
      ["JSESSIONID", "session"],
      ["PHPSESSID", "session"],
      ["ASP.NET_SessionId", "session"],
      ["laravel_session", "session"],
      ["_myapp_session", "session"],
      ["connect.sid", "session"],
      ["XSRF-TOKEN", "csrf"],
      ["csrftoken", "csrf"],
      ["x-csrf", "csrf"],
      ["_token", "csrf"],
      ["OptanonConsent", "consent"],
      ["cookieconsent_status", "consent"],
      ["_ga", "analytics"],
      ["_ga_ABC123", "analytics"],
      ["_gid", "analytics"],
      ["Hm_lvt_abc", "analytics"],
      ["AWSALB", "load-balancer"],
      ["BIGipServerpool_web", "load-balancer"],
      ["theme", "unknown"],
      ["pref", "unknown"],
    ];
    for (const [name, role] of cases) expect([name, cookieRole(name)]).toEqual([name, role]);
    expect(COOKIE_ROLES.map((r) => r.role)).toEqual(["csrf", "session", "consent", "analytics", "load-balancer"]);
  });

  test("stack markers stay within 20; protection signals are names only", () => {
    expect(STACK_MARKERS.length).toBeLessThanOrEqual(20);
    expect(new Set(STACK_MARKERS.map((m) => m.marker)).size).toBe(STACK_MARKERS.length);
    expect(PROTECTION_SIGNALS.map((s) => s.signal)).toEqual(["html-403", "status-429", "retry-after", "rate-limit", "bot-management", "bot-management", "bot-management", "bot-management"]);
  });
});

// ------------------------------------------------------------ channels and coverage

const STATIC = "Orders overview";
const ITEM = "Widget-42";
const WS_WORD = "Lattice";
const B64_WORD = "Quasar";

async function channelsBundle(dir: string): Promise<{ doc: string; item1: string; item2: string; enc: string; ws: string; img: string }> {
  const ids = { doc: "", item1: "", item2: "", enc: "", ws: "", img: "" };
  await buildBundle(dir, { name: "chan", created: C, seed: 31 }, async (b) => {
    ids.doc = idOf(await b.request({ url: `${O}/orders`, type: "document", mime: "text/html", body: `<!doctype html><title>Orders</title><h1>${STATIC}</h1><div id=list></div>`, ts: C + 100 }));
    ids.item1 = idOf(await b.request({ url: `${O}/api/items/1?lang=en`, type: "fetch", mime: JSON_MIME, body: JSON.stringify({ name: ITEM }), ts: C + 200 }));
    ids.item2 = idOf(await b.request({ url: `${O}/api/items/2`, type: "fetch", status: 404, mime: JSON_MIME, body: JSON.stringify({ error: "gone" }), ts: C + 250, extra: { unreadByPage: true, bodySource: "fetch" } }));
    ids.enc = idOf(await b.request({ url: `${O}/api/blob`, type: "xhr", mime: JSON_MIME, body: JSON.stringify({ payload: b64(JSON.stringify({ word: B64_WORD })) }), ts: C + 300 }));
    ids.ws = idOf(await b.request({ url: "ws://127.0.0.1:4310/ws", type: "websocket", status: 101, mime: null, ts: C + 400 }));
    await b.ws(ids.ws, C + 450, "recv", { text: JSON.stringify({ msg: WS_WORD }) });
    await b.ws(ids.ws, C + 460, "send", { text: "Missing-token" }); // sent frames are not responses
    ids.img = idOf(await b.request({ url: `${O}/img/logo.png`, type: "image", mime: "image/png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), ts: C + 500 }));
  });
  return ids;
}

describe("channels and coverage", () => {
  test("grouping, statuses, unreadByPage, decode steps and per-channel token counts", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = await channelsBundle(dir);
    // 7 tokens: Orders, overview, Widget-42, Lattice, Quasar, Missing-token, 9876; the last two are nowhere in a response
    const d = buildDossier(BundleReader.open(dir), live(`${STATIC}\n${ITEM}  ${WS_WORD}\n${B64_WORD} Missing-token 9876 abc 12`), { now: C });
    const ch = (t: string) => d.channels.find((c) => c.template === t);
    expect(d.channels.map((c) => [c.method, c.template, c.type, c.body, c.count, c.first])).toEqual([
      ["GET", "/orders", "document", "html", 1, ids.doc],
      ["GET", "/api/items/{id}", "fetch", "json", 2, ids.item1],
      ["GET", "/api/blob", "xhr", "json", 1, ids.enc],
      ["GET", "/ws", "websocket", "ws", 1, ids.ws],
      ["GET", "/img/logo.png", "image", "binary", 1, ids.img],
    ]);
    expect(ch("/api/items/{id}")).toMatchObject({ status: [200, 404], unreadByPage: 1, tokens: 1 });
    expect(ch("/orders")?.tokens).toBe(2);
    expect(ch("/ws")?.tokens).toBe(1);
    expect(ch("/api/blob")?.tokens).toBe(1);
    expect(ch("/api/blob")?.decode).toContain("base64");
    expect(ch("/img/logo.png")?.tokens).toBe(0);
    expect(d.coverage).toEqual({ ratio: Math.round((5 / 7) * 1000) / 1000, total: 7, found: 5, unmatched: ["Missing-token", "9876"], capped: 0 });
    expect(d.grades.coverage).toBe("实测");
  });

  test("no page text: coverage is empty with ratio null", async () => {
    const dir = tmp("tabcap-recon-");
    await channelsBundle(dir);
    const d = buildDossier(BundleReader.open(dir), { url: null, title: null, text: null, source: "live", adapters: null });
    expect(d.coverage).toEqual({ ratio: null, total: 0, found: 0, unmatched: [], capped: 0 });
  });

  test("offline page: the last root document's HTML text nodes and title", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = await channelsBundle(dir);
    const page = recordedPage(BundleReader.open(dir));
    expect(page).toMatchObject({ url: `${O}/orders`, title: "Orders", source: "recorded-document", request: ids.doc, adapters: null });
    expect(page.text).toBe(STATIC);
    const d = buildDossier(BundleReader.open(dir), page);
    expect(d.coverage).toMatchObject({ total: 2, found: 2 });
    expect(d.warnings.some((w) => w.includes("no live page"))).toBe(true);
    expect(d.stack.filter((s) => s.source === "adapter")).toEqual([]);
  });
});

// ------------------------------------------------------------ cookies and stack

const SID = "sid0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const CSRF = "csrf-9f8e7d6c5b4a39281706";
const PREF_EXPIRES = 1790000000; // epoch seconds, as CDP Network.getCookies reports it

async function cookiesBundle(dir: string): Promise<{ doc: string; login: string; data: string }> {
  const ids = { doc: "", login: "", data: "" };
  await buildBundle(dir, { name: "cookies", created: C, seed: 32 }, async (b) => {
    const start = await b.w.putBlob(JSON.stringify([{ name: "pref", value: "compact", domain: "127.0.0.1", path: "/", expires: PREF_EXPIRES, httpOnly: false, secure: false, session: false, sameSite: "Lax" }]));
    if (start.outcome !== "stored") throw new Error("blob");
    b.w.append({ actor: "system", tab: "t1", cmd: null, ts: C + 10, mono: null, kind: "state", what: "cookies", origin: O, blob: start.ref, count: 1, reason: "session-start" });
    ids.doc = idOf(
      await b.request({
        url: `${O}/login`,
        type: "document",
        mime: "text/html",
        body: "<!doctype html><title>login</title><form></form>",
        reqHeaders: { cookie: "pref=compact" },
        respHeaders: { server: "nginx/1.25", "x-powered-by": "PHP/8.3", "set-cookie": "PHPSESSID=abcdef0123456789; Path=/" },
        ts: C + 100,
      }),
    );
    ids.login = idOf(
      await b.request({
        url: `${O}/api/login`,
        method: "POST",
        type: "fetch",
        mime: JSON_MIME,
        body: JSON.stringify({ csrf: CSRF }),
        postData: "user=demo",
        reqHeaders: { "content-type": "application/x-www-form-urlencoded", cookie: "pref=compact; PHPSESSID=abcdef0123456789" },
        respHeaders: { server: "nginx/1.25", "set-cookie": `sid=${SID}; Path=/; HttpOnly; SameSite=Lax` },
        ts: C + 400,
      }),
    );
    ids.data = idOf(
      await b.request({
        url: `${O}/api/data`,
        method: "POST",
        type: "fetch",
        mime: JSON_MIME,
        body: JSON.stringify({ data: "data-ok" }),
        reqHeaders: { "x-csrf": CSRF, cookie: `sid=${SID}; pref=compact; _ga=GA1.1.123.456` },
        ts: C + 500,
      }),
    );
  });
  return ids;
}

describe("cookies", () => {
  test("origin, lifetime, flags, role and requiredBy (deps); a csrf header input is listed with its deps origin", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = await cookiesBundle(dir);
    const d = buildDossier(BundleReader.open(dir), live("data-ok"));
    const c = (n: string) => d.cookies.find((x) => x.name === n);
    expect(d.cookies.map((x) => [x.name, x.carrier, x.role])).toEqual([
      ["pref", "cookie", "unknown"],
      ["PHPSESSID", "cookie", "session"],
      ["sid", "cookie", "session"],
      ["_ga", "cookie", "analytics"],
      ["x-csrf", "header", "csrf"],
    ]);
    expect(c("sid")).toMatchObject({
      origin: { kind: "set-cookie", request: ids.login },
      setBy: [ids.login],
      lifetime: { kind: "session" },
      flags: { httpOnly: true, secure: false, sameSite: "Lax" },
    });
    expect(c("sid")?.requiredBy).toEqual([{ request: ids.data, input: "cookie:sid", via: "set-cookie", grade: "实测" }]);
    expect(c("pref")).toMatchObject({
      origin: { kind: "session-start" },
      lifetime: { kind: "persistent", expires: new Date(PREF_EXPIRES * 1000).toISOString() },
      flags: { httpOnly: false, secure: false, sameSite: "Lax" },
    });
    // analyze deps: the first send has no source (unrecorded), later sends carry it forward (request)
    expect(c("pref")?.requiredBy.map((r) => [r.request, r.via, r.grade])).toEqual([
      [ids.doc, "unrecorded", "推断"],
      [ids.login, "request", "推断"],
      [ids.data, "request", "推断"],
    ]);
    expect(c("PHPSESSID")).toMatchObject({ origin: { kind: "set-cookie", request: ids.doc }, lifetime: { kind: "session" }, flags: { httpOnly: false, secure: false, sameSite: null } });
    expect(c("_ga")).toMatchObject({ origin: { kind: "unrecorded" }, lifetime: null, flags: null });
    expect(c("x-csrf")).toMatchObject({ origin: { kind: "deps", class: "response", request: ids.login, path: "$.csrf", grade: "实测" }, lifetime: null, flags: null });
    expect(c("x-csrf")?.requiredBy).toEqual([{ request: ids.data, input: "header:x-csrf", via: "response", grade: "实测" }]);
    // never a cookie value
    const text = JSON.stringify(d) + renderDossierMd(d);
    for (const v of [SID, "compact", "abcdef0123456789", "GA1.1.123.456", CSRF]) expect([v, text.includes(v)]).toEqual([v, false]);
  });

  test("stack: adapter results, header markers with the value as seen, session-cookie markers by name", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = await cookiesBundle(dir);
    const d = buildDossier(BundleReader.open(dir), live("data-ok"));
    expect(d.stack).toEqual([
      { source: "adapter", name: "overlay", category: "overlay", confidence: 0, evidence: [], grade: "推断" },
      { source: "header", marker: "server", value: "nginx/1.25", hint: "web server (as announced)", request: ids.doc, requests: 2, grade: "推断" },
      { source: "header", marker: "x-powered-by", value: "PHP/8.3", hint: "application platform (as announced)", request: ids.doc, requests: 1, grade: "推断" },
      { source: "cookie", marker: "PHPSESSID", name: "PHPSESSID", hint: "PHP", request: ids.doc, grade: "推断" },
    ]);
  });
});

// ------------------------------------------------------------ protection

describe("protection", () => {
  test("guard detections with what was handed to the human, and response signals by name", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = { wall: "", limited: "", rl: "", cf: "" };
    await buildBundle(dir, { name: "prot", created: C, seed: 33 }, async (b) => {
      ids.wall = idOf(await b.request({ url: `${O}/api/limited?bucket=main`, type: "fetch", status: 403, mime: "text/html", body: "<h2>verify</h2>", ts: C + 100 }));
      b.w.append({ actor: "system", tab: "t1", cmd: null, ts: C + 110, mono: null, kind: "guard", event: "breaker", site: null, account: null, detail: { reason: "verify-page", request: ids.wall, url: `${O}/api/limited?bucket=main`, status: 403, mime: "text/html" } });
      b.w.append({ actor: "system", tab: "t1", cmd: null, ts: C + 120, mono: null, kind: "handoff", state: "waiting", reason: "verify-page", question: "Complete the verification in the browser, then tell the AI to continue.", timeoutMs: null, answerRef: null, request: ids.wall, screenshot: "/tmp/shot.png" });
      b.w.append({ actor: "system", tab: "t1", cmd: null, ts: C + 130, mono: null, kind: "handoff", state: "resumed", reason: "verify-page", question: null, timeoutMs: null, answerRef: null, by: "human" });
      ids.limited = idOf(await b.request({ url: `${O}/api/rate`, type: "fetch", status: 429, mime: JSON_MIME, body: "{}", respHeaders: { "retry-after": "30" }, ts: C + 200 }));
      ids.rl = idOf(await b.request({ url: `${O}/api/ok`, type: "fetch", mime: JSON_MIME, body: "{}", respHeaders: { "x-ratelimit-remaining": "9" }, ts: C + 300 }));
      ids.cf = idOf(await b.request({ url: `${O}/c`, type: "document", status: 403, mime: "text/html", body: "<!doctype html>", respHeaders: { "cf-mitigated": "challenge" }, ts: C + 400 }));
      await b.request({ url: `${O}/api/json403`, type: "fetch", status: 403, mime: JSON_MIME, body: "{}", ts: C + 500 }); // not HTML: no signal
    });
    const d = buildDossier(BundleReader.open(dir), live(""));
    expect(d.protection).toEqual([
      { source: "guard", kind: "verify-page", request: ids.wall, url: `${O}/api/limited?bucket=main`, status: 403, handedToHuman: { question: "Complete the verification in the browser, then tell the AI to continue.", screenshot: "/tmp/shot.png" }, resumedBy: "human", grade: "实测" },
      { source: "response", signal: "html-403", label: "HTML 403 (block or challenge page)", name: "403", count: 2, requests: [ids.wall, ids.cf], grade: "推断" },
      { source: "response", signal: "status-429", label: "429 Too Many Requests", name: "429", count: 1, requests: [ids.limited], grade: "推断" },
      { source: "response", signal: "retry-after", label: "retry-after header", name: "retry-after", count: 1, requests: [ids.limited], grade: "推断" },
      { source: "response", signal: "rate-limit", label: "rate-limit headers (x-ratelimit-* / ratelimit-*)", name: "x-ratelimit-remaining", count: 1, requests: [ids.rl], grade: "推断" },
      { source: "response", signal: "bot-management", label: "Cloudflare challenge marker (cf-mitigated)", name: "cf-mitigated", count: 1, requests: [ids.cf], grade: "推断" },
    ]);
    expect(d.notes).toEqual([IDENTIFICATION_ONLY]);
    // names only: no header value reaches the dossier
    expect(JSON.stringify(d).includes("challenge\"")).toBe(false);
  });

  test("a clean recording has no protection entries", async () => {
    const dir = tmp("tabcap-recon-");
    await channelsBundle(dir);
    expect(buildDossier(BundleReader.open(dir), live("")).protection).toEqual([]);
  });
});

// ------------------------------------------------------------ output

describe("output", () => {
  test("Markdown: sections, channel rows, coverage sentence, cookies, the identification-only sentence", async () => {
    const dir = tmp("tabcap-recon-");
    const ids = await cookiesBundle(dir);
    const d: Dossier = { ...buildDossier(BundleReader.open(dir), live("data-ok"), { now: C }), bundle: "/b" };
    const md = renderDossierMd(d);
    for (const h of ["# Recon dossier", "## Stack (推断)", "## Data channels (实测)", "## Cookies", "## Protection"]) expect(md).toContain(h);
    expect(md).toContain(`- page: ${O}/orders — Orders (live)`);
    expect(md).toContain(`- generated: ${new Date(C).toISOString()}`);
    expect(md).toContain(`| POST | /api/data | fetch | json | 1 | ${ids.data} | 200 | 0 |  | 1 |`);
    expect(md).toContain("Coverage (实测): 1 / 1 page text tokens found in recorded responses (100.0%).");
    expect(md).toContain(`| sid | cookie | set-cookie ${ids.login} | session | HttpOnly SameSite=Lax | session | ${ids.data} (实测) |`);
    expect(md).toContain(`| x-csrf | header | response ${ids.login} $.csrf (实测) |  |  | csrf | ${ids.data} (实测) |`);
    expect(md).toContain("## Protection (guard 实测; response signals 推断)\n\nNothing identified.");
    expect(md).toContain(`> ${IDENTIFICATION_ONLY}`);
    expect(md.endsWith("\n")).toBe(true);
  });

  test("files: exports/dossier.json + .md, 0600, overwritten on re-run; analyze recon prints the paths and the receipt", async () => {
    const dir = tmp("tabcap-recon-");
    await cookiesBundle(dir);
    const r = await runAnalyze(["analyze", "recon", dir]);
    expect(r.code).toBe(0);
    if (!r.envelope.ok) throw new Error("analyze recon failed");
    const data = r.envelope.data;
    if (!isRecord(data)) throw new Error("no data");
    const json = join(dir, "exports", "dossier.json");
    const md = join(dir, "exports", "dossier.md");
    expect(data).toMatchObject({ dossier: json, markdown: md, receipt: { dossier: "exports/dossier.json" } });
    const parsed: unknown = JSON.parse(readFileSync(json, "utf8"));
    expect(parsed).toMatchObject({ schema: DOSSIER_SCHEMA, bundle: dir, session: "cookies", page: { source: "recorded-document" } });
    for (const k of ["schema", "bundle", "session", "generatedAt", "page", "stack", "channels", "coverage", "cookies", "protection", "grades"]) expect(isRecord(parsed) && k in parsed).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(json).mode & 0o777).toBe(0o600);
      expect(statSync(md).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "exports")).mode & 0o777).toBe(0o700);
    }
    const before = statSync(json).mtimeMs;
    await Bun.sleep(5);
    const again = await runAnalyze(["analyze", "recon", dir, "--text"]);
    expect(again.text?.startsWith("# Recon dossier")).toBe(true);
    expect(statSync(json).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(existsSync(md)).toBe(true);
    // analysis only reads the bundle: events and manifest are untouched by recon
    expect(BundleReader.open(dir).events.some((e) => e.kind === "finding")).toBe(false);
  });

  test("0.7.3: analyze recon redacts page / guard URLs by default and writes the redacted dossier; --reveal restores them", async () => {
    const dir = tmp("tabcap-recon-");
    const SECRET = "ST-77-recon-secret";
    await buildBundle(dir, { name: "redact", created: C, seed: 34 }, async (b) => {
      await b.request({ url: `${O}/orders?access_token=${SECRET}&lang=zh`, type: "document", mime: "text/html", body: "<!doctype html><title>Orders</title><p>hello world</p>", ts: C + 100 });
    });
    const plain = await runAnalyze(["analyze", "recon", dir]);
    if (!plain.envelope.ok || !isRecord(plain.envelope.data)) throw new Error("analyze recon failed");
    const page = isRecord(plain.envelope.data["page"]) ? plain.envelope.data["page"] : {};
    expect(String(page["url"])).toContain("access_token=<redacted:");
    expect(String(page["url"])).toContain("lang=zh");
    expect(JSON.stringify(plain.envelope.data).includes(SECRET)).toBe(false);
    expect(readFileSync(join(dir, "exports", "dossier.json"), "utf8").includes(SECRET)).toBe(false);
    const revealed = await runAnalyze(["analyze", "recon", dir, "--reveal"]);
    if (!revealed.envelope.ok || !isRecord(revealed.envelope.data)) throw new Error("analyze recon --reveal failed");
    const rpage = isRecord(revealed.envelope.data["page"]) ? revealed.envelope.data["page"] : {};
    expect(String(rpage["url"])).toContain(SECRET);
  });

  test("the cmd end event keeps the receipt (docs/09 §13.3 draft)", () => {
    const s = summarize({ dossier: "/x/exports/dossier.json", markdown: "/x/exports/dossier.md", receipt: { dossier: "exports/dossier.json" }, summary: { channels: 3 }, warnings: [] });
    expect(s).toEqual({ dossier: "/x/exports/dossier.json", markdown: "/x/exports/dossier.md", receipt: { dossier: "exports/dossier.json" } });
  });
});
