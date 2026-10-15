// Synthetic bundles for the deps / chain / export-python chain tests. Each
// bundle plants value flows whose source is known by construction (the
// constants below); the tests assert that deps finds exactly these sources.
// Written through the real BundleWriter (via _analyze.ts).
//
// FLOWS (origin http://127.0.0.1:4310), in recording order:
//   r(doc)    GET  /login            HTML with <meta name=csrf-token content=HTML_TOKEN>; request cookie pref=compact (set before the recording)
//   cmd fill  e3 USER                (start event text deferred, end event carries USER)
//   cmd fill  e4 --secret range-demo.password
//   action    fill "red apples"      (a human-recorded action event)
//   r(login)  POST /api/login        form user=USER, password=PASSWORD, _token=HTML_TOKEN;
//                                    answers {csrf: CSRF, profile: {id: OWNER}} + set-cookie sid=SID
//   r(data)   POST /api/data         x-csrf: CSRF, cookie sid + pref, x-app-version; answers {data, token: base64(JSON {inner: INNER})}
//   r(items1) GET  /api/items?q=red apples&lang=zh-CN&owner=OWNER   x-inner-token: INNER, x-app-version
//   r(items2) GET  /api/items?q=green pears&lang=zh-CN&owner=OWNER  x-inner-token: INNER, x-app-version
//   r(sign1/2) GET /api/sign?q&page&t&nonce&sig   sig = sha256(q|page|t|nonce), t = the request time (ms)
//   r(search1/2) POST /api/search    JSON {client: "webapp-2", q}; the answer echoes client
//
// LOGIN: the s07 shape only (document, fills, login with set-cookie + csrf, data).
// SIGN: one GET /api/sign?q&t&sig with sig = sha256(q|t) (verify + todo_inputs hook).

import { createHash } from "node:crypto";
import { buildBundle, type Build } from "./_analyze.ts";

export const ORIGIN = "http://127.0.0.1:4310";
export const C = 1760700000000;
export const USER = "demo-user";
export const PASSWORD = "Pa55 w&rd/ü!x";
export const SID = "sid0a1b2c3d4e5f60718293a4b5c6d7e8f9";
export const CSRF = "csrf-9f8e7d6c5b4a39281706";
export const OWNER = "u-77f3e2a1";
export const HTML_TOKEN = "htmltok-5d41402abc4b2a76";
export const INNER = "inner-b9c8d7e6f5a4b3c2";
export const APP_VERSION = "3.1.4-build7";
export const TYPED = "red apples";
export const SECRET_REF = "range-demo.password";
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const SIGNS = [
  { q: "a1", page: "1", t: C + 800, nonce: "0f1e2d3c4b5a6978" },
  { q: "b2", page: "2", t: C + 900, nonce: "8796a5b4c3d2e1f0" },
].map((s) => ({ ...s, sig: sha256(`${s.q}|${s.page}|${s.t}|${s.nonce}`) }));
export const SIGN_ONE = { q: "zeta", t: C + 300 };
export const SIGN_ONE_SIG = sha256(`${SIGN_ONE.q}|${SIGN_ONE.t}`);

const JSON_MIME = "application/json";
const FORM = "application/x-www-form-urlencoded";

function cmdFill(b: Build, ts: number, ref: string, value: { text: string } | { secret: string }): void {
  const start = b.w.append((seq) => ({
    actor: "ai",
    tab: "t1",
    cmd: `c-${seq}`,
    ts,
    mono: null,
    kind: "cmd",
    id: `c-${seq}`,
    phase: "start",
    argv: null,
    input: "text" in value ? { action: "fill", ref, text: "<deferred to the end event>" } : { action: "fill", ref, secret: value.secret },
  }));
  const id = String(start["id"]);
  b.w.append({
    actor: "ai",
    tab: "t1",
    cmd: id,
    ts: ts + 10,
    mono: null,
    kind: "cmd",
    phase: "end",
    ref: id,
    ok: true,
    error: null,
    durationMs: 10,
    outputSummary: null,
    ...("text" in value ? { argv: null, input: { action: "fill", ref, text: value.text } } : {}),
  });
}

export function loginForm(withToken: boolean): string {
  const p = new URLSearchParams({ user: USER, password: PASSWORD });
  if (withToken) p.set("_token", HTML_TOKEN);
  return p.toString();
}

export async function buildFlows(dir: string): Promise<string> {
  return buildBundle(dir, { name: "flows", created: C, seed: 11 }, async (b) => {
    await b.request({
      url: `${ORIGIN}/login`,
      type: "document",
      mime: "text/html",
      body: `<!doctype html><meta charset=utf-8><meta name="csrf-token" content="${HTML_TOKEN}"><title>login</title><form>…</form>`,
      reqHeaders: { cookie: "pref=compact" },
      ts: C + 100,
    });
    cmdFill(b, C + 200, "e3", { text: USER });
    cmdFill(b, C + 300, "e4", { secret: SECRET_REF });
    b.w.append({ actor: "human", tab: "t1", cmd: null, ts: C + 350, mono: null, kind: "action", op: "fill", target: { ref: "e9" }, value: TYPED, phase: "done", nav: null, trusted: true });
    await b.request({
      url: `${ORIGIN}/api/login`,
      method: "POST",
      type: "fetch",
      mime: JSON_MIME,
      body: JSON.stringify({ csrf: CSRF, profile: { id: OWNER } }),
      postData: loginForm(true),
      reqHeaders: { "content-type": FORM, cookie: "pref=compact" },
      respHeaders: { "set-cookie": `sid=${SID}; Path=/; HttpOnly` },
      ts: C + 400,
    });
    const token = Buffer.from(JSON.stringify({ inner: INNER, kind: "nested" })).toString("base64");
    await b.request({
      url: `${ORIGIN}/api/data`,
      method: "POST",
      type: "fetch",
      mime: JSON_MIME,
      body: JSON.stringify({ data: "data-ok", token }),
      reqHeaders: { "x-csrf": CSRF, cookie: `sid=${SID}; pref=compact`, "x-app-version": APP_VERSION },
      ts: C + 500,
    });
    for (const [i, q] of [TYPED, "green pears"].entries()) {
      await b.request({
        url: `${ORIGIN}/api/items?${new URLSearchParams({ q, lang: "zh-CN", owner: OWNER }).toString()}`,
        mime: JSON_MIME,
        body: JSON.stringify({ items: [i], n: 1 }),
        reqHeaders: { "x-inner-token": INNER, "x-app-version": APP_VERSION, cookie: `sid=${SID}; pref=compact` },
        ts: C + 600 + i * 100,
      });
    }
    for (const s of SIGNS) {
      await b.request({ url: `${ORIGIN}/api/sign?q=${s.q}&page=${s.page}&t=${s.t}&nonce=${s.nonce}&sig=${s.sig}`, mime: JSON_MIME, body: JSON.stringify({ ok: true, q: s.q }), ts: s.t + 5 });
    }
    for (const [i, q] of ["first", "second"].entries()) {
      await b.request({
        url: `${ORIGIN}/api/search`,
        method: "POST",
        type: "fetch",
        mime: JSON_MIME,
        body: JSON.stringify({ client: "webapp-2", hits: [q] }),
        postData: JSON.stringify({ client: "webapp-2", q }),
        reqHeaders: { "content-type": JSON_MIME },
        ts: C + 1000 + i * 100,
      });
    }
  });
}

export async function buildLogin(dir: string): Promise<string> {
  return buildBundle(dir, { name: "login", created: C, seed: 12 }, async (b) => {
    await b.request({ url: `${ORIGIN}/login`, type: "document", mime: "text/html", body: "<!doctype html><title>login</title><form>…</form>", ts: C + 100 });
    cmdFill(b, C + 200, "e3", { text: USER });
    cmdFill(b, C + 300, "e4", { secret: SECRET_REF });
    await b.request({
      url: `${ORIGIN}/api/login`,
      method: "POST",
      type: "fetch",
      mime: JSON_MIME,
      body: JSON.stringify({ csrf: CSRF }),
      postData: loginForm(false),
      reqHeaders: { "content-type": FORM },
      respHeaders: { "set-cookie": `sid=${SID}; Path=/; HttpOnly` },
      ts: C + 400,
    });
    await b.request({ url: `${ORIGIN}/api/data`, method: "POST", type: "fetch", mime: JSON_MIME, body: JSON.stringify({ data: "data-ok" }), reqHeaders: { "x-csrf": CSRF, cookie: `sid=${SID}` }, ts: C + 500 });
  });
}

export async function buildSign(dir: string): Promise<string> {
  return buildBundle(dir, { name: "sign", created: C, seed: 13 }, async (b) => {
    await b.request({ url: `${ORIGIN}/api/sign?q=${SIGN_ONE.q}&t=${SIGN_ONE.t}&sig=${SIGN_ONE_SIG}`, mime: JSON_MIME, body: JSON.stringify({ ok: true }), ts: SIGN_ONE.t + 5 });
  });
}
