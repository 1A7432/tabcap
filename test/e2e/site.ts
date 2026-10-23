// Tiny local site for L2 tests and for capturing fixtures/ax. Serves fixed
// bytes and remembers them, so tests compare sha256 of what was really served.

import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = `<!doctype html><meta charset=utf-8><title>tabcap e2e home</title>
<h1>Counter</h1>
<main>
  <div><div><button id=add>Add item</button></div></div>
  <span id=count>0</span>
  <p><label>Name <input id=name></label></p>
  <p><label>Password <input id=pw type=password autocomplete=current-password></label></p>
  <p><label><input id=agree type=checkbox> I agree</label></p>
  <ul><li>apple</li><li>banana</li></ul>
  <div id=note contenteditable=true>editable note</div>
  <a id=next href="/two">Go to page two</a>
  <div id=items></div>
</main>
<script>
window.__clicks = 0; window.__pointerdowns = 0;
const add = document.getElementById("add");
add.addEventListener("pointerdown", () => { window.__pointerdowns++; });
add.addEventListener("click", () => { window.__clicks++; document.getElementById("count").textContent = String(window.__clicks); });
const x = new XMLHttpRequest();
x.open("GET", "/api/items");
x.onload = () => { document.getElementById("items").textContent = JSON.parse(x.responseText).items.join(", "); };
x.send();
// spike-2 race: a fetch fired in the click handler, then the link navigates at once.
document.getElementById("next").addEventListener("click", () => { fetch("/api/before-leave", { method: "POST", body: "bye=1" }); });
</script>`;

const TWO = `<!doctype html><meta charset=utf-8><title>tabcap e2e two</title><h1>Page two</h1><a href="/">Back home</a>`;

const ITEMS = JSON.stringify({ items: ["alpha", "beta", "gamma"], served: "items-v1" });
const BEFORE_LEAVE = JSON.stringify({ leave: "ok", pad: "x".repeat(4000) });

export type Site = { origin: string; served: Map<string, string>; hits: string[]; stop: () => void };

// docs/05 s01-like: the list XHR GET /api/items; s02-like: POST /api/before-leave
// fired in the click handler right before the link navigates to /two.
export function startSite(): Site {
  const served = new Map<string, string>(); // path -> sha256 of the body bytes
  const hits: string[] = [];
  const send = (path: string, body: string, type: string) => {
    const bytes = new TextEncoder().encode(body);
    served.set(path, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/") return send(p, HOME, "text/html; charset=utf-8");
      if (p === "/two") return send(p, TWO, "text/html; charset=utf-8");
      if (p === "/api/items") return send(p, ITEMS, "application/json");
      if (p === "/api/before-leave") return send(p, BEFORE_LEAVE, "application/json");
      return new Response("not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// Second site: the exact page from the first smoke run (10-15), plus
// readiness edge cases: no scripts at all, a slow subresource, and a document
// that never arrives (held until stop()).
const SMOKE = `<!doctype html><meta charset=utf-8><h1>smoke</h1><button id=b onclick="fetch('/api/items').then(r=>r.json()).then(j=>{document.getElementById('out').textContent=j.items.join(',')})">加载列表</button><input id=q placeholder="搜索"><p id=out></p>`;
const PLAIN = `<!doctype html><meta charset=utf-8><title>plain</title><p>no scripts here</p>`;
const SLOW = `<!doctype html><meta charset=utf-8><title>slow</title><p>waits for an image</p><img src="/slow.png" alt="slow image">`;
// 1x1 transparent PNG
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
export const SLOW_MS = 1500;

export function startSmokeSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const held: Array<() => void> = [];
  const send = (path: string, body: string | Uint8Array, type: string) => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    served.set(path, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/") return send(p, SMOKE, "text/html; charset=utf-8");
      if (p === "/api/items") return send(p, JSON.stringify({ items: ["苹果", "香蕉", "樱桃"], n: 3 }), "application/json");
      if (p === "/plain") return send(p, PLAIN, "text/html; charset=utf-8");
      if (p === "/slow") return send(p, SLOW, "text/html; charset=utf-8");
      if (p === "/slow.png") {
        await Bun.sleep(SLOW_MS);
        return send(p, PIXEL, "image/png");
      }
      if (p === "/hang") {
        await new Promise<void>((r) => held.push(r));
        return new Response("too late", { headers: { "content-type": "text/html" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    served,
    hits,
    stop: () => {
      for (const r of held) r();
      server.stop(true);
    },
  };
}

// 0.2 scenarios: a WebSocket echo endpoint, a page that logs to the console and
// throws, and a slow API for `wait --idle` / `net wait`. `served` holds the
// sha256 of every body and of every WebSocket payload the server saw or sent
// (key "ws:recv:<n>" / "ws:send:<n>" in server order).
// /ws-page + /ws is docs/05 s11-like: two text frames and one binary frame,
// each echoed, then one server push carrying WS_MARKER.
export const WS_MARKER = "server-push-7c1e";
export const WS_BINARY = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
export const SLOW_API_MS = 1200;

const WS_PAGE = `<!doctype html><meta charset=utf-8><title>ws</title><p id=st>connecting</p>
<script>
window.__ws = [];
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.binaryType = "arraybuffer";
ws.onmessage = (m) => { window.__ws.push(typeof m.data === "string" ? m.data : "bin:" + m.data.byteLength); if (window.__ws.length === 4) document.getElementById("st").textContent = "ws-done"; };
ws.onopen = () => { ws.send("hello-1"); ws.send("hello-2"); ws.send(new Uint8Array(${JSON.stringify([...WS_BINARY])})); };
</script>`;

const CONSOLE_PAGE = `<!doctype html><meta charset=utf-8><title>console</title><p>console page</p>
<script>
console.log("log-marker", 42, {a: 1});
console.warn("warn-marker");
console.error("error-marker");
function explode() { throw new Error("uncaught-marker"); }
setTimeout(explode, 0);
</script>`;

const SLOW_PAGE = `<!doctype html><meta charset=utf-8><title>slow api</title><p id=out>waiting</p>
<script>
fetch("/slow-api").then((r) => r.json()).then((j) => { document.getElementById("out").textContent = "slow-done " + j.n; });
</script>`;

export const SLOW_API_BODY = JSON.stringify({ n: 7, pad: "s".repeat(2000), served: "slow-api-v1" });

export function startLabSite(): Site & { ws: string[] } {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const wsLog: string[] = [];
  let recvN = 0;
  let sendN = 0;
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const send = (path: string, body: string, type: string) => {
    const bytes = new TextEncoder().encode(body);
    served.set(path, hash(bytes));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const bytesOf = (m: string | Buffer | Uint8Array): Uint8Array => (typeof m === "string" ? new TextEncoder().encode(m) : new Uint8Array(m));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      if (p === "/ws-page") return send(p, WS_PAGE, "text/html; charset=utf-8");
      if (p === "/console-page") return send(p, CONSOLE_PAGE, "text/html; charset=utf-8");
      if (p === "/slow-page") return send(p, SLOW_PAGE, "text/html; charset=utf-8");
      if (p === "/slow-api") {
        await Bun.sleep(SLOW_API_MS);
        return send(p, SLOW_API_BODY, "application/json");
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        const b = bytesOf(m);
        served.set(`ws:recv:${++recvN}`, hash(b));
        wsLog.push(`recv ${typeof m === "string" ? "text" : "binary"} ${b.length}`);
        ws.send(m); // echo, same opcode
        served.set(`ws:send:${++sendN}`, hash(b));
        if (recvN === 3) {
          const push = `${WS_MARKER} after 3 messages`;
          ws.send(push);
          served.set(`ws:send:${++sendN}`, hash(new TextEncoder().encode(push)));
        }
      },
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, ws: wsLog, stop: () => server.stop(true) };
}

// 0.2-D: pages mirroring docs/05 §5 (s17–s20) plus net show / net wait cases.
// The ports of the port-scan page are fixed by docs/05 s20; tests check with a
// TCP probe which of them are really closed before counting failures.
export const SCAN_PORTS = [...Array.from({ length: 58 }, (_, i) => 9432 + i), 9432, 9433];
export const DATA_IMAGES = 10;
export const POST_PAD = 3000;
export const SIGN_HEADER = "x-sign";
export const SIGN_VALUE = "sig-5d41402abc4b2a76";

// s17: /popup opens /popup-target in its own window (window.open with features).
const POPUP_PAGE = `<!doctype html><meta charset=utf-8><title>popup opener</title>
<button id=open onclick="window.__w = window.open('/popup-target', 'pw', 'width=520,height=420'); window.__opened = !!window.__w">打开弹窗</button>`;
const POPUP_TARGET = `<!doctype html><meta charset=utf-8><title>popup target</title>
<p>弹窗目标文字</p><button id=pb onclick="window.__pb = (window.__pb || 0) + 1; document.getElementById('st').textContent = 'popup-clicked ' + window.__pb">弹窗按钮</button><p id=st>idle</p>`;

// s18: every 2 s the table body is replaced (new nodes, not reused); the old
// bodies stay referenced so the detached nodes are still alive (as in Vue apps).
const RERENDER_PAGE = `<!doctype html><meta charset=utf-8><title>rerender</title>
<table><thead><tr><th>名称</th><th>操作</th></tr></thead><tbody id=rows></tbody></table><p id=st>clicks 0</p>
<script>
window.__old = []; window.__renders = 0; window.__clicks = 0;
function render() {
  const old = document.getElementById("rows");
  const tb = document.createElement("tbody"); tb.id = "rows";
  for (const name of ["甲", "乙", "丙"]) {
    const tr = document.createElement("tr");
    const td = document.createElement("td"); td.textContent = name;
    const td2 = document.createElement("td");
    const b = document.createElement("button"); b.textContent = "编辑" + name;
    b.addEventListener("click", () => { window.__clicks++; document.getElementById("st").textContent = "clicks " + window.__clicks; });
    td2.appendChild(b); tr.append(td, td2); tb.appendChild(tr);
  }
  old.replaceWith(tb); window.__old.push(old); window.__renders++;
}
render();
window.__timer = setInterval(render, 2000);
window.__stop = () => { clearInterval(window.__timer); return window.__renders; };
</script>`;

// s19: Element UI style checkbox — the real input is hidden, the visible span has
// cursor:pointer and a click listener; a div role=none acts as the login button.
const CHECKBOX_PAGE = `<!doctype html><meta charset=utf-8><title>custom checkbox</title>
<style>.el-checkbox__inner,.el-checkbox__label,.btn{cursor:pointer}.el-checkbox__original{position:absolute;opacity:0;width:0;height:0;margin:0;z-index:-1}</style>
<h2>登录</h2>
<form id=f onsubmit="return false">
  <p>提示：请勾选记住密码以便下次自动登录</p>
  <span class=el-checkbox><span class=el-checkbox__input><span class=el-checkbox__inner></span><input type=checkbox class=el-checkbox__original id=remember></span><span class=el-checkbox__label id=remember-label>记住密码</span></span>
  <div role=none class=btn id=login>登录</div>
</form>
<p id=st>unchecked</p>
<script>
const input = document.getElementById("remember");
document.querySelector(".el-checkbox").addEventListener("click", (e) => { if (e.target === input) return; input.checked = !input.checked; document.getElementById("st").textContent = input.checked ? "checked" : "unchecked"; });
window.__login = 0;
document.getElementById("login").addEventListener("click", () => { window.__login++; });
</script>`;

// s20: /noise, the port-scan page (SCAN_PORTS) plus DATA_IMAGES data: images.
function noisePage(): string {
  const scans = SCAN_PORTS.map((p) => `fetch("http://127.0.0.1:${p}/").catch(() => null);`).join("\n");
  const imgs = Array.from({ length: DATA_IMAGES }, (_, i) => `<img alt="d${i}" width=4 height=4 src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><text>${i}</text></svg>`)}">`).join("");
  return `<!doctype html><meta charset=utf-8><title>noise</title><p id=st>noise</p>${imgs}
<script>
fetch("/api/ok").then((r) => r.json()).then((j) => { document.getElementById("st").textContent = "ok " + j.ok; });
${scans}
</script>`;
}

const POST_PAGE = `<!doctype html><meta charset=utf-8><title>post</title><p id=st>posting</p>
<script>
fetch("/api/submit", { method: "POST", headers: { "content-type": "application/json", "${SIGN_HEADER}": "${SIGN_VALUE}" }, body: JSON.stringify({ user: "alice", pad: "p".repeat(${POST_PAD}) }) })
  .then((r) => r.json()).then((j) => { document.getElementById("st").textContent = "posted " + j.got; });
</script>`;

const FIELD_WS_PAGE = `<!doctype html><meta charset=utf-8><title>ws</title><p id=st>connecting</p>
<script>
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.onopen = () => ws.send("ping-field");
ws.onmessage = (m) => { document.getElementById("st").textContent = "ws " + m.data; };
</script>`;

// net wait look-back: the click handler's request finishes before `wait --text` returns.
const LOOKBACK_PAGE = `<!doctype html><meta charset=utf-8><title>lookback</title>
<button id=go onclick="fetch('/api/look').then((r) => r.json()).then((j) => { document.getElementById('st').textContent = 'look-done ' + j.n; })">查询</button><p id=st>idle</p>`;

export function startFieldSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  let looks = 0;
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const send = (path: string, body: string, type: string) => {
    const bytes = new TextEncoder().encode(body);
    served.set(path, hash(bytes));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const html = (path: string, body: string) => send(path, body, "text/html; charset=utf-8");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      if (p === "/popup") return html(p, POPUP_PAGE);
      if (p === "/popup-target") return html(p, POPUP_TARGET);
      if (p === "/rerender") return html(p, RERENDER_PAGE);
      if (p === "/checkbox") return html(p, CHECKBOX_PAGE);
      if (p === "/noise") return html(p, noisePage());
      if (p === "/post") return html(p, POST_PAGE);
      if (p === "/ws-page") return html(p, FIELD_WS_PAGE);
      if (p === "/lookback") return html(p, LOOKBACK_PAGE);
      if (p === "/api/ok") return send(p, JSON.stringify({ ok: 1 }), "application/json");
      if (p === "/api/look") return send(p, JSON.stringify({ n: ++looks }), "application/json");
      if (p === "/api/submit") {
        const body = await req.text();
        served.set("post:/api/submit", hash(new TextEncoder().encode(body)));
        return send(p, JSON.stringify({ got: body.length }), "application/json");
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        ws.send(typeof m === "string" ? `pong:${m}` : m);
      },
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.3-A: s07-like login, s15-like verify wall
// Equivalents of docs/05 s07 (token chain) and s15 (verify wall); there is no
// range server yet. The test password lives in the test, never in the page.

export const LOGIN_USER = "demo-user";
export const LOGIN_PASSWORD = "E2e-pa55 w&rd/ü!";
/** s15: calls 1..LIMIT_OK pass, the next one gets the 403 interstitial (docs/05 s15: the 6th). */
export const LIMIT_OK = 5;
export const WALL_MARKER = "tabcap-e2e-verify-wall";
/** The answer the test-only fake handler returns (test/fixtures/plugins/fake-verify). */
export const WALL_CODE = "4217";

const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><title>s07 login</title>
<h1>登录</h1>
<form id=f>
  <p><label>用户名 <input id=user name=user autocomplete=username></label></p>
  <p><label>密码 <input id=pw name=password type=password autocomplete=current-password></label></p>
  <p><button id=go type=submit>登录</button></p>
</form>
<p id=out>not logged in</p>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = new URLSearchParams({ user: document.getElementById("user").value, password: document.getElementById("pw").value });
  const r = await fetch("/api/login", { method: "POST", body });
  if (r.status !== 200) { document.getElementById("out").textContent = "login failed " + r.status; return; }
  const { csrf } = await r.json();
  const d = await fetch("/api/data", { method: "POST", headers: { "x-csrf": csrf } });
  document.getElementById("out").textContent = d.status === 200 ? (await d.json()).data : "data failed " + d.status;
});
</script>`;

/**
 * 0.6-F variant of s07 (`/s07/login?token=1`): the login answer also carries a
 * bearer token; the page keeps it in localStorage (`access_token`), puts a tab
 * marker in sessionStorage (`s07_tab`) and sends `authorization: Bearer <token>`
 * next to `x-csrf` on the data request, which then needs all three (cookie sid,
 * csrf, token).
 */
const LOGIN_PAGE_TOKEN = LOGIN_PAGE.replace(
  `const r = await fetch("/api/login", { method: "POST", body });`,
  `const r = await fetch("/api/login?token=1", { method: "POST", body });`,
).replace(
  `  const { csrf } = await r.json();
  const d = await fetch("/api/data", { method: "POST", headers: { "x-csrf": csrf } });`,
  `  const { csrf, token } = await r.json();
  localStorage.setItem("access_token", token);
  sessionStorage.setItem("s07_tab", "1");
  const d = await fetch("/api/data", { method: "POST", headers: { "x-csrf": csrf, authorization: "Bearer " + localStorage.getItem("access_token") } });`,
);

const WALL_PAGE = `<!doctype html><meta charset=utf-8><title>s15 verify wall</title>
<h1>列表</h1>
<button id=load>加载</button>
<p id=out>idle</p>
<div id=wall hidden>
  <div id=wallhtml></div>
  <p><label>验证码 <input id=vcode></label></p>
  <button id=human>我是人</button>
</div>
<script>
const bucket = new URLSearchParams(location.search).get("bucket") || "main";
let loaded = 0;
document.getElementById("load").addEventListener("click", async () => {
  const r = await fetch("/api/limited?bucket=" + bucket);
  if (r.status === 403) {
    document.getElementById("wallhtml").innerHTML = await r.text();
    document.getElementById("wall").hidden = false;
    document.getElementById("out").textContent = "blocked";
    return;
  }
  loaded++;
  document.getElementById("out").textContent = "loaded " + loaded;
});
document.getElementById("human").addEventListener("click", async () => {
  const r = await fetch("/api/verified?bucket=" + bucket, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("vcode").value }) });
  if (r.status === 200) { document.getElementById("wall").hidden = true; loaded = 0; document.getElementById("out").textContent = "verified"; }
  else document.getElementById("out").textContent = "verify failed " + r.status;
});
</script>`;

const WALL_HTML = `<h2>请完成验证</h2><p>访问过于频繁。${WALL_MARKER}</p>`;

/**
 * `sids`: every session cookie value the login endpoint handed out, in order (the oracle for cookie snapshots);
 * `csrfs` / `tokens`: the csrf and (token variant, else "") bearer token handed out with each sid.
 */
export type GuardSite = Site & { loginBodies: string[]; sids: string[]; csrfs: string[]; tokens: string[] };

export function startGuardSite(): GuardSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const loginBodies: string[] = [];
  const sids: string[] = [];
  const csrfs: string[] = [];
  const tokens: string[] = [];
  const sessions = new Map<string, string>(); // sid -> csrf
  const bearer = new Map<string, string>(); // sid -> token (token variant only)
  const counts = new Map<string, number>(); // bucket -> calls since the last unlock
  const json = (v: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/s07/login") return html(u.searchParams.get("token") === "1" ? LOGIN_PAGE_TOKEN : LOGIN_PAGE);
      if (p === "/api/login" && req.method === "POST") {
        const body = await req.text();
        loginBodies.push(body);
        const f = new URLSearchParams(body);
        if (f.get("user") !== LOGIN_USER || f.get("password") !== LOGIN_PASSWORD) return json({ error: "bad credentials" }, 401);
        const sid = crypto.randomUUID().replace(/-/g, "");
        const csrf = crypto.randomUUID().replace(/-/g, "");
        sessions.set(sid, csrf);
        sids.push(sid);
        csrfs.push(csrf);
        const token = u.searchParams.get("token") === "1" ? crypto.randomUUID().replace(/-/g, "") : "";
        tokens.push(token);
        if (token !== "") bearer.set(sid, token);
        return json(token === "" ? { csrf } : { csrf, token }, 200, { "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      if (p === "/api/data" && req.method === "POST") {
        const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
        if (sessions.get(sid) === undefined || sessions.get(sid) !== req.headers.get("x-csrf")) return json({ error: "no session" }, 401);
        const want = bearer.get(sid);
        if (want !== undefined && req.headers.get("authorization") !== `Bearer ${want}`) return json({ error: "no token" }, 401);
        return json({ data: "data-ok" });
      }
      if (p === "/s15/") return html(WALL_PAGE);
      const bucket = u.searchParams.get("bucket") ?? "main";
      if (p === "/api/limited") {
        const n = (counts.get(bucket) ?? 0) + 1;
        counts.set(bucket, n);
        return n > LIMIT_OK ? html(WALL_HTML, 403) : json({ n });
      }
      if (p === "/api/verified" && req.method === "POST") {
        const v: unknown = await req.json().catch(() => null);
        const code = typeof v === "object" && v !== null && "code" in v && typeof v.code === "string" ? v.code : "";
        // "我是人" with an empty code is the human; a code must be the right one
        if (code !== "" && code !== WALL_CODE) return json({ error: "wrong code" }, 400);
        counts.set(bucket, 0);
        return json({ verified: true });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, loginBodies, sids, csrfs, tokens, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-E: s53 token endpoint + bearer header (docs/05 s53)
// The page POSTs /api/s53/token (form client=web), the server answers
// {access_token, token_type: "Bearer", expires_in}; the page then GETs
// /api/s53/me with `Authorization: Bearer <access_token>`, which answers 200
// only for a token it handed out. `tokens`: every token handed out, in order;
// `meAuth`: the authorization header of every /api/s53/me call (the oracle).

export type TokenSite = Site & { tokens: string[]; meAuth: (string | null)[] };

const TOKEN_PAGE = `<!doctype html><meta charset=utf-8><title>s53 token</title><p id=out>…</p>
<script>
(async () => {
  const r = await fetch("/api/s53/token", { method: "POST", body: new URLSearchParams({ client: "web" }) });
  const { access_token } = await r.json();
  const me = await fetch("/api/s53/me", { headers: { authorization: "Bearer " + access_token } });
  document.getElementById("out").textContent = me.status === 200 ? "me " + (await me.json()).name : "me failed " + me.status;
})();
</script>`;

export function startTokenSite(): TokenSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const tokens: string[] = [];
  const meAuth: (string | null)[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s53/") return new Response(TOKEN_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (u.pathname === "/api/s53/token" && req.method === "POST") {
        if (new URLSearchParams(await req.text()).get("client") !== "web") return json({ error: "bad client" }, 400);
        const t = crypto.randomUUID().replace(/-/g, "");
        tokens.push(t);
        return json({ access_token: t, token_type: "Bearer", expires_in: 3600 });
      }
      if (u.pathname === "/api/s53/me") {
        const auth = req.headers.get("authorization");
        meAuth.push(auth);
        return tokens.some((t) => auth === `Bearer ${t}`) ? json({ name: "demo-user" }) : json({ error: "no token" }, 401);
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, tokens, meAuth, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.3-B: s06-like search for replay
// Equivalent of docs/05 s06: GET /api/search?q&page&client=web&v=3&t=<ms>&nonce&sig
// with header x-client-build; sig = sha256 hex of q|page|t|nonce computed in
// the page (signature-like: 64 hex). `served` holds the sha256 of every body
// by path + query, so replay tests compare with what this server really sent.
// 0.4-A (`startSearchSite({ sid: true })`): the full s06 query, with
// `sid=<cookie sid>`: the page document sets `sid` when the request has none
// (readable by the page, not HttpOnly) and the page copies it into the query.
// `sids` lists every sid handed out, `sidBy` the request path + query that got
// it (the oracle for "sid 来自 set-cookie").
export const SEARCH_BUILD = "2026.10";
export type SearchSite = Site & { sids: string[]; sidBy: Map<string, string> };

const searchPage = (withSid: boolean) => `<!doctype html><meta charset=utf-8><title>s06 search</title><p id=out>…</p>
<script>
const p = new URLSearchParams(location.search);
const q = p.get("q") || "x", page = p.get("page") || "1";
const t = Date.now(), nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const sid = ${withSid ? `(document.cookie.match(/(?:^|; )sid=([^;]*)/) || [])[1] || ""` : `null`};
crypto.subtle.digest("SHA-256", new TextEncoder().encode(q + "|" + page + "|" + t + "|" + nonce))
  .then((h) => [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""))
  .then((sig) => fetch("/api/search?q=" + encodeURIComponent(q) + "&page=" + page + "&client=web&v=3" + (sid === null ? "" : "&sid=" + sid) + "&t=" + t + "&nonce=" + nonce + "&sig=" + sig, { headers: { "x-client-build": "${SEARCH_BUILD}" } }))
  .then((r) => r.json())
  .then((j) => { document.getElementById("out").textContent = "hits " + j.hits.join(","); });
</script>`;
const SEARCH_PAGE = searchPage(false);
const SEARCH_PAGE_SID = searchPage(true);

// 0.6-G: `GET /api/list` on the same site, a list endpoint whose second
// variant (`?v=2`) is the "site changed a field" case of `analyze
// schema-diff`: `title` renamed to `name`, `price` from a decimal string to a
// JSON number, `currency` added; everything else (code, total, id, status,
// created) unchanged. LIST_DRIFT is the scenario's expected drift, read off
// the two bodies by hand in the notation of docs/04 §32 (`path:type`): the
// variant is selected by the query, so `query:v` is added too.
const LIST_ITEMS = [
  { id: 101, title: "Blue mug", price: "12.50", status: "active", created: "2026-10-01T09:00:00Z" },
  { id: 102, title: "Red pot", price: "8.00", status: "active", created: "2026-10-02T10:30:00Z" },
  { id: 103, title: "Tea set", price: "30.25", status: "sold", created: "2026-10-03T08:15:00Z" },
  { id: 104, title: "Oak tray", price: "5.75", status: "active", created: "2026-10-04T16:45:00Z" },
];
export const LIST_V1 = JSON.stringify({ code: 0, total: LIST_ITEMS.length, items: LIST_ITEMS });
export const LIST_V2 = JSON.stringify({
  code: 0,
  total: LIST_ITEMS.length,
  items: LIST_ITEMS.map((i) => ({ id: i.id, name: i.title, price: Number(i.price), currency: "EUR", status: i.status, created: i.created })),
});
export const LIST_DRIFT = {
  added: ["$.items[].currency:string", "$.items[].name:string", "query:v:string(int)"],
  removed: ["$.items[].title:string"],
  changed: [{ path: "$.items[].price", from: "string(float)", to: "number(float)" }],
};

export function startSearchSite(opts: { sid?: boolean } = {}): SearchSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const sids: string[] = [];
  const sidBy = new Map<string, string>();
  const send = (key: string, body: string, type: string, extra: Record<string, string> = {}) => {
    const bytes = new TextEncoder().encode(body);
    served.set(key, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store", ...extra } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s06" && opts.sid === true) {
        const has = /(?:^|;\s*)sid=/.test(req.headers.get("cookie") ?? "");
        if (has) return send(u.pathname + u.search, SEARCH_PAGE_SID, "text/html; charset=utf-8");
        const sid = crypto.randomUUID().replace(/-/g, "");
        sids.push(sid);
        sidBy.set(sid, u.pathname + u.search);
        return send(u.pathname + u.search, SEARCH_PAGE_SID, "text/html; charset=utf-8", { "set-cookie": `sid=${sid}; Path=/; SameSite=Lax` });
      }
      if (u.pathname === "/s06") return send(u.pathname + u.search, SEARCH_PAGE, "text/html; charset=utf-8");
      if (u.pathname === "/api/search") {
        const q = u.searchParams.get("q") ?? "";
        const page = Number(u.searchParams.get("page") ?? "1");
        const body = JSON.stringify({ q, page, client: u.searchParams.get("client"), hits: [`${q}-${page}-a`, `${q}-${page}-b`], total: 20, build: req.headers.get("x-client-build") });
        return send(u.pathname + u.search, body, "application/json");
      }
      if (u.pathname === "/api/list") return send(u.pathname + u.search, u.searchParams.get("v") === "2" ? LIST_V2 : LIST_V1, "application/json");
      return new Response("not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, sids, sidBy, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.3-D: overlay range pages (docs/09 §2.3, §12 s24 / s36 / s45; docs/05 s17)
// Six overlay forms plus a popup page and a negative (full-viewport app shell
// with a hidden dialog). Generic structures only: no real site's branding.
// The layer page imitates layer.js's DOM structure (class names, shade + iframe
// layer), not its code. OVERLAY_EXPECTED is the scenario definition: which
// overlay each page shows, which element ids are its close buttons / choices,
// which target it covers and which target stays clickable. Every page counts
// clicks per element id in window.__hits.

export type OverlayExpect = {
  kind: "dialog" | "iframe-layer" | "mask" | "timeout-prompt" | "consent";
  name: string;
  modal: boolean;
  close: string[];
  choices: string[];
  /** Element id that the overlay covers (click → covered). */
  covered: string;
  /** Element id that stays clickable while the overlay is open, if any. */
  free: string | null;
  /** iframe src of an iframe layer. */
  iframe?: string;
};

export const OVERLAY_PAGES = ["modal", "dialog", "mask", "layer", "timeout", "consent"] as const;
export type OverlayPage = (typeof OVERLAY_PAGES)[number];

export const OVERLAY_EXPECTED: Record<OverlayPage, OverlayExpect> = {
  modal: { kind: "dialog", name: "系统提示", modal: true, close: ["dlg1-close", "dlg1-later"], choices: ["dlg1-ok"], covered: "submit", free: null },
  dialog: { kind: "dialog", name: "操作失败", modal: false, close: ["dlg2-close"], choices: [], covered: "under", free: "submit" },
  mask: { kind: "mask", name: "加载中…", modal: true, close: [], choices: [], covered: "submit", free: null },
  layer: { kind: "iframe-layer", name: "选择条目", modal: true, close: ["layer-close"], choices: [], covered: "submit", free: null, iframe: "/ov/layer-content" },
  timeout: { kind: "timeout-prompt", name: "会话即将超时", modal: true, close: [], choices: ["keep", "quit"], covered: "submit", free: null },
  consent: { kind: "consent", name: "Cookie 提示", modal: false, close: [], choices: ["accept", "reject", "cset"], covered: "footer-btn", free: "submit" },
};

const OV_BASE = (title: string, body: string, script = "") => `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>body{margin:0;font:14px sans-serif}main{padding:24px}.layui-layer-ico{display:inline-block;width:16px;height:16px;background:#ccc}</style>
<main><h1>${title}</h1><form id=f onsubmit="return false"><label>搜索 <input id=q></label> <button id=submit type=button>提交</button></form>
<p>列表区域：示例数据一、示例数据二、示例数据三。</p></main>
${body}
<script>
window.__hits = {};
document.addEventListener("click", (e) => { const t = e.target && e.target.closest ? e.target.closest("[id]") : null; if (t) window.__hits[t.id] = (window.__hits[t.id] || 0) + 1; }, true);
const hide = (...ids) => { for (const id of ids) { const el = document.getElementById(id); if (el) el.style.display = "none"; } };
${script}
</script>`;

const OV_MODAL = OV_BASE(
  "ov modal",
  `<div class=v-modal id=mask1 style="position:fixed;left:0;top:0;width:100%;height:100%;background:#000;opacity:.5;z-index:2000"></div>
<div class=el-dialog__wrapper id=wrap1 style="position:fixed;top:0;right:0;bottom:0;left:0;overflow:auto;z-index:2001">
  <div role=dialog aria-modal=true aria-label=系统提示 class=el-dialog id=dlg1 style="position:relative;margin:15vh auto 0;width:420px;background:#fff;padding:16px">
    <div class=el-dialog__header><span class=el-dialog__title>系统提示</span><button type=button class=el-dialog__headerbtn aria-label=Close id=dlg1-close>×</button></div>
    <div class=el-dialog__body>为了账户安全，请修改初始密码。</div>
    <div class=el-dialog__footer><button id=dlg1-later type=button>稍后再说</button> <button id=dlg1-ok type=button>去修改</button></div>
  </div>
</div>`,
  `for (const id of ["dlg1-close", "dlg1-later"]) document.getElementById(id).addEventListener("click", () => hide("wrap1", "mask1"));`,
);

const OV_DIALOG = OV_BASE(
  "ov dialog",
  `<button id=under type=button style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1">下方按钮</button>
<div role=alertdialog aria-labelledby=dlg2-title id=dlg2 style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:360px;height:160px;background:#fff;border:1px solid #888;z-index:10;padding:8px;box-sizing:border-box">
  <h2 id=dlg2-title style="margin:0 0 8px">操作失败</h2><p>网络异常，请稍后重试。</p><button id=dlg2-close type=button>关闭</button>
</div>`,
  `document.getElementById("dlg2-close").addEventListener("click", () => hide("dlg2"));`,
);

const OV_MASK = OV_BASE(
  "ov mask",
  `<div id=loading style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,.7);z-index:999;display:flex;align-items:center;justify-content:center">加载中…</div>`,
);

const OV_LAYER = OV_BASE(
  "ov layer",
  `<div class=layui-layer-shade id=layui-layer-shade1 times=1 style="z-index:19891014;background-color:#000;opacity:.3;position:fixed;top:0;left:0;width:100%;height:100%"></div>
<div class="layui-layer layui-layer-iframe" id=layui-layer1 type=iframe times=1 style="z-index:19891015;width:500px;height:300px;position:fixed;top:80px;left:80px;background:#fff">
  <div class=layui-layer-title style="cursor:move;padding:8px">选择条目</div>
  <div id=layui-layer-content1 class=layui-layer-content><iframe scrolling=auto id=layui-layer-iframe1 name=layui-layer-iframe1 frameborder=0 src="/ov/layer-content" style="height:240px;width:100%"></iframe></div>
  <span class=layui-layer-setwin style="position:absolute;right:8px;top:8px"><a class="layui-layer-ico layui-layer-close layui-layer-close1" id=layer-close href="javascript:;"></a></span>
</div>`,
  `window.layer = { open() {}, close() {} };
document.getElementById("layer-close").addEventListener("click", () => hide("layui-layer1", "layui-layer-shade1"));`,
);

const OV_LAYER_CONTENT = `<!doctype html><meta charset=utf-8><title>layer content</title><p>条目列表</p><button>条目甲</button><button>条目乙</button>`;

const OV_TIMEOUT = OV_BASE(
  "ov timeout",
  `<div id=tmask style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:3000"></div>
<div role=dialog aria-labelledby=to-title id=tdlg style="position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);width:380px;background:#fff;z-index:3001;padding:12px">
  <h3 id=to-title style="margin:0">会话即将超时</h3><p>您已长时间未操作，系统将在 <span id=count>60</span> 秒后自动退出。</p>
  <button id=keep type=button>继续使用</button> <button id=quit type=button>退出登录</button>
</div>`,
  `document.getElementById("keep").addEventListener("click", () => hide("tdlg", "tmask"));`,
);

const OV_CONSENT = OV_BASE(
  "ov consent",
  `<div style="position:fixed;left:16px;bottom:30px;z-index:10"><button id=footer-btn type=button>下载报表</button></div>
<div id=cookie-banner class=cookie-consent aria-label="Cookie 提示" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#222;color:#fff;z-index:50;padding:12px;box-sizing:border-box">
  本站使用 Cookie 改善体验并统计访问。<button id=accept type=button>接受全部</button> <button id=reject type=button>拒绝</button> <a href="#settings" id=cset style="color:#9cf">设置</a>
</div>`,
  `for (const id of ["accept", "reject"]) document.getElementById(id).addEventListener("click", () => hide("cookie-banner"));`,
);

// 0.7.3: a role-less full-viewport mask wrapping its dialog (common framework
// markup). The inner block is opaque with a border and a shadow; "Buy now" sits
// under the mask and must be reported covered, never clicked through.
// docs/05 s63 overlay-wrapper: /ov/wrapped.
const OV_WRAPPED = OV_BASE(
  "ov wrapped",
  `<button id=buy type=button style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1">Buy now</button>
<div id=mask style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100">
  <div id=dialog style="margin:15vh auto 0;width:340px;background:#fff;border:1px solid #888;box-shadow:0 4px 20px rgba(0,0,0,.3);padding:16px;box-sizing:border-box">
    <p>Continue to the next page?</p><button id=accept class=close type=button>Accept</button>
  </div>
</div>`,
  `document.getElementById("accept").addEventListener("click", () => hide("mask"));`,
);

// Negative: the whole app lives in a full-viewport fixed container (common app
// shell layout) and a closed dialog sits hidden in the DOM. No overlay.
const OV_SHELL = `<!doctype html><meta charset=utf-8><title>ov shell</title>
<style>body{margin:0;font:14px sans-serif}</style>
<div id=app style="position:fixed;inset:0;background:#fff;overflow:auto">
  <main style="padding:24px"><h1>ov shell</h1><p>整个应用渲染在一个铺满视口的固定定位容器里，这是很多后台的常见布局，不是遮挡层。</p>
  <form id=f onsubmit="return false"><label>搜索 <input id=q></label> <button id=submit type=button>提交</button></form></main>
  <div class=el-dialog__wrapper style="display:none;position:fixed;inset:0;z-index:2001"><div role=dialog aria-modal=true aria-label=隐藏的对话框><button>×</button></div></div>
</div>
<script>window.__hits = {}; document.addEventListener("click", (e) => { const t = e.target.closest("[id]"); if (t) window.__hits[t.id] = (window.__hits[t.id] || 0) + 1; }, true);</script>`;

const OV_POPUP = `<!doctype html><meta charset=utf-8><title>ov popup</title>
<button id=open onclick="window.open('/ov/popup-target', 'ovp', 'width=480,height=360')">打开参照窗口</button>`;
const OV_POPUP_TARGET = `<!doctype html><meta charset=utf-8><title>参照选择</title><p>选择一条记录</p>`;

export function startOverlaySite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const pages: Record<string, string> = {
    "/ov/modal": OV_MODAL,
    "/ov/dialog": OV_DIALOG,
    "/ov/mask": OV_MASK,
    "/ov/layer": OV_LAYER,
    "/ov/layer-content": OV_LAYER_CONTENT,
    "/ov/timeout": OV_TIMEOUT,
    "/ov/consent": OV_CONSENT,
    "/ov/wrapped": OV_WRAPPED,
    "/ov/shell": OV_SHELL,
    "/ov/popup": OV_POPUP,
    "/ov/popup-target": OV_POPUP_TARGET,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      const body = pages[p];
      if (body === undefined) return new Response("nf", { status: 404 });
      const bytes = new TextEncoder().encode(body);
      served.set(p, createHash("sha256").update(bytes).digest("hex"));
      return new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.3-E: s46 input fidelity
// docs/05 s46: the owner's local click probe promoted to fixtures/probe/input-probe.html,
// served unchanged at /probe; the page POSTs its own event report to /report
// (same origin), kept here by its `run` name. The oracle exports for this page
// are fixtures/probe/oracle/ (scripts/probe-oracle.mjs, Playwright, by hand).
export const PROBE_FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "probe", "input-probe.html");

export type ProbeSite = Site & { reports: Map<string, Record<string, unknown>> };

/** 0.7.3: the trusted-click navigation page (a plain in-site link and a button). */
const PROBE_LINK = `<!doctype html><meta charset=utf-8><title>probe link</title>
<main><h1>link page</h1><p><a id=next href="/second">下一頁</a></p>
<p><button id=plain type=button onclick="window.__plain = (window.__plain || 0) + 1">普通按钮</button></p></main>`;
const PROBE_SECOND = `<!doctype html><meta charset=utf-8><title>probe second</title><main><h1>second page</h1><p>到了第二页。</p></main>`;

export function startProbeSite(): ProbeSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const reports = new Map<string, Record<string, unknown>>();
  const page = readFileSync(PROBE_FIXTURE);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/probe") {
        served.set(p, createHash("sha256").update(page).digest("hex"));
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p === "/link" || p === "/second") {
        const body = p === "/link" ? PROBE_LINK : PROBE_SECOND;
        served.set(p, createHash("sha256").update(body).digest("hex"));
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p === "/report" && req.method === "POST") {
        const v: unknown = await req.json().catch(() => null);
        if (typeof v !== "object" || v === null || !("run" in v) || typeof v.run !== "string") return new Response("bad report", { status: 400 });
        reports.set(v.run, Object.fromEntries(Object.entries(v)));
        return new Response(null, { status: 204 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, reports, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.4-C: s40 locale-numbers
// docs/05 s40: one GET /api/rows, rendered server-side per `?locale=` from
// strings written here by hand (not Intl), so every expected display string
// is visible in this source. The rows body is a literal too (amount
// -123456.00 keeps its two trailing zeros on the wire). Two rows, so every
// value (dir included) is unique within /api/rows: row 0 has the day > 12
// (2026-09-15), row 1 the day <= 12 (2026-03-04). en-US shows MM/DD/YYYY,
// fr-FR DD/MM/YYYY (U+202F narrow no-break space groups thousands), de-DE /
// en-IN / accounting the month views 2026-09 / 202609 / 09/2026. Every locale
// adds a full-width qty column padded with &nbsp;; accounting adds a second
// amount column with the trailing minus.
export const S40_LOCALES = ["en-US", "de-DE", "fr-FR", "en-IN", "accounting"] as const;
export type S40Locale = (typeof S40_LOCALES)[number];
export type S40Field = "amount" | "qty" | "date" | "code" | "dir";
/** One table column: its header, the /api/rows field it shows, the HTML of its two cells (row 0, row 1). */
export type S40Column = { head: string; field: S40Field; cells: [string, string] };

export const S40_ROWS = `[{"id":4101,"amount":1234.56,"qty":1234,"date":"2026-09-15","code":"100101","dir":1},{"id":4102,"amount":-123456.00,"qty":48,"date":"2026-03-04","code":"200202","dir":-1}]`;

const S40_COMMON: S40Column[] = [
  { head: "code", field: "code", cells: ["1001.01", "2002.02"] },
  { head: "dir", field: "dir", cells: ["DR", "CR"] },
  { head: "qty (full-width)", field: "qty", cells: ["&nbsp;&nbsp;１２３４", "&nbsp;&nbsp;４８"] },
];

export const S40_TABLES: Record<S40Locale, S40Column[]> = {
  "en-US": [
    { head: "amount", field: "amount", cells: ["1,234.56", "-123,456.00"] },
    { head: "qty", field: "qty", cells: ["1,234", "48"] },
    { head: "date", field: "date", cells: ["09/15/2026", "03/04/2026"] },
    ...S40_COMMON,
  ],
  "de-DE": [
    { head: "amount", field: "amount", cells: ["1.234,56", "-123.456,00"] },
    { head: "qty", field: "qty", cells: ["1.234", "48"] },
    { head: "date", field: "date", cells: ["2026-09", "2026-03"] },
    ...S40_COMMON,
  ],
  "fr-FR": [
    { head: "amount", field: "amount", cells: ["1 234,56", "-123 456,00"] },
    { head: "qty", field: "qty", cells: ["1 234", "48"] },
    { head: "date", field: "date", cells: ["15/09/2026", "04/03/2026"] },
    ...S40_COMMON,
  ],
  "en-IN": [
    { head: "amount", field: "amount", cells: ["1,234.56", "-1,23,456.00"] },
    { head: "qty", field: "qty", cells: ["1,234", "48"] },
    { head: "date", field: "date", cells: ["202609", "202603"] },
    ...S40_COMMON,
  ],
  accounting: [
    { head: "amount", field: "amount", cells: ["1,234.56", "(123,456.00)"] },
    { head: "amount (trailing minus)", field: "amount", cells: ["1234.56", "123456.00-"] },
    { head: "qty", field: "qty", cells: ["1,234", "48"] },
    { head: "date", field: "date", cells: ["09/2026", "03/2026"] },
    ...S40_COMMON,
  ],
};

const s40Page = (locale: S40Locale): string => {
  const cols = S40_TABLES[locale];
  const head = cols.map((c) => `<th>${c.head}</th>`).join("");
  const rows = [0, 1].map((i) => `<tr>${cols.map((c) => `<td>${c.cells[i] ?? ""}</td>`).join("")}</tr>`).join("\n");
  return `<!doctype html><meta charset=utf-8><title>s40 ${locale}</title>
<h1>s40 ${locale}</h1>
<table id=rows><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table>
<p id=status>loading</p>
<script>fetch("/api/rows").then((r) => r.json()).then((rows) => { document.getElementById("status").textContent = "rows " + rows.length; });</script>`;
};

export function startLocaleSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const send = (key: string, body: string, type: string) => {
    const bytes = new TextEncoder().encode(body);
    served.set(key, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}${u.search}`);
      if (u.pathname === "/api/rows") return send(u.pathname, S40_ROWS, "application/json");
      const locale = S40_LOCALES.find((l) => l === u.searchParams.get("locale"));
      if (u.pathname === "/s40" && locale !== undefined) return send(u.pathname + u.search, s40Page(locale), "text/html; charset=utf-8");
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.4-H: s41 embedded-state
// docs/05 s41: one server-rendered page carrying the same rows four ways:
// Next.js `__NEXT_DATA__` script JSON, a JSON-LD @graph (sku = the code), an
// inline `window.__STATE__ = {…}` literal that is not JSON (unquoted keys,
// single quotes, trailing commas), and an ASP.NET-style __VIEWSTATE whose bytes
// are written below by hand (an ASCII token and a UTF-16LE run). The table
// shows amount / code / name as plain strings (`1234.56`, not `1,234.56`), so
// `find "1234.56"` also hits the cell. The button posts `__VIEWSTATE` and the
// token the page script cuts out of the decoded blob to /api/s41/submit
// (form-urlencoded); the token itself is nowhere in the page text.
export const S41_ROWS = `[{"id":4201,"amount":1234.56,"code":"100101"},{"id":4202,"amount":56.78,"code":"200202"}]`;
export const S41_TOKEN = "VIEWSTATE-TOKEN-7f3a9c";
/** The UTF-16LE run inside the viewstate blob (>= 4 units; carries 条目甲). */
export const S41_WIDE = "user:条目甲";
/**
 * __VIEWSTATE bytes: a made-up header, the ASCII token (length-prefixed), then
 * S41_WIDE in UTF-16LE, written unit by unit: u 75 00, s 73 00, e 65 00,
 * r 72 00, : 3a 00, 条 U+6761 61 67, 目 U+76EE ee 76, 甲 U+7532 32 75.
 */
export const S41_VIEWSTATE_BYTES = Uint8Array.from([
  0xff, 0x01, 0x0f, 0x0f, 0x05, 0x16,
  ...new TextEncoder().encode(S41_TOKEN),
  0x05, 0x10,
  0x75, 0x00, 0x73, 0x00, 0x65, 0x00, 0x72, 0x00, 0x3a, 0x00, 0x61, 0x67, 0xee, 0x76, 0x32, 0x75,
  0x00, 0x00, 0x64, 0x64,
]);
export const S41_VIEWSTATE = Buffer.from(S41_VIEWSTATE_BYTES).toString("base64");
export const S41_GENERATOR = "CA0B0334";
export const S41_EVENTVALIDATION = Buffer.from(Uint8Array.from([0xff, 0x01, 0x14, 0x02, ...new TextEncoder().encode("s41-event-validation"), 0x00])).toString("base64");

const S41_PAGE = `<!doctype html><meta charset=utf-8><title>s41 embedded-state</title>
<h1>s41 embedded-state</h1>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"rows":${S41_ROWS}}},"page":"/s41","buildId":"s41-build"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"s41 product","sku":"100101","offers":{"@type":"Offer","price":"19.99","priceCurrency":"USD"}}]}</script>
<script>
window.__STATE__ = {user:{id:4201,name:'条目甲'},rows:[{id:4201,amount:1234.56,code:'100101'},{id:4202,amount:56.78,code:'200202'},],};
</script>
<form id=f method=post action="/s41">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${S41_VIEWSTATE}">
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="${S41_GENERATOR}">
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="${S41_EVENTVALIDATION}">
<table id=rows><thead><tr><th>amount</th><th>code</th><th>name</th></tr></thead><tbody>
<tr><td>1234.56</td><td>100101</td><td>条目甲</td></tr>
<tr><td>56.78</td><td>200202</td><td>条目乙</td></tr>
</tbody></table>
<button type=button id=submit>submit</button>
</form>
<p id=status>ready</p>
<script>
document.getElementById("submit").addEventListener("click", () => {
  const vs = document.getElementById("__VIEWSTATE").value;
  const token = (atob(vs).match(/VIEWSTATE-TOKEN-[0-9a-f]+/) || [""])[0];
  fetch("/api/s41/submit", { method: "POST", body: new URLSearchParams({ __VIEWSTATE: vs, token }) })
    .then((r) => r.json())
    .then((j) => { document.getElementById("status").textContent = "submitted " + j.ok; });
});
</script>`;

export type EmbeddedSite = Site & { submits: URLSearchParams[] };

export function startEmbeddedSite(): EmbeddedSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const submits: URLSearchParams[] = [];
  const send = (key: string, body: string, type: string) => {
    const bytes = new TextEncoder().encode(body);
    served.set(key, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s41") return send(u.pathname, S41_PAGE, "text/html; charset=utf-8");
      if (u.pathname === "/api/s41/submit" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        submits.push(form);
        const ok = form.get("__VIEWSTATE") === S41_VIEWSTATE && form.get("token") === S41_TOKEN;
        return send(u.pathname, JSON.stringify({ ok }), "application/json");
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, submits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.4-B: emulate network throttling
// A page and one ~300 KB response (deterministic bytes, never cached), to time a
// transfer with and without `emulate --network-conditions`.
export const BIG_BYTES = 300_000;
const BIG = Uint8Array.from({ length: BIG_BYTES }, (_, i) => (i * 31 + (i >> 8)) & 0xff);
const THROTTLE_HOME = `<!doctype html><meta charset=utf-8><title>throttle</title><h1>throttle</h1>`;

export function startThrottleSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  served.set("/big", createHash("sha256").update(BIG).digest("hex"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`${req.method} ${p}`);
      if (p === "/") return new Response(THROTTLE_HOME, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (p === "/big") return new Response(BIG, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.4-D: account pool site
// GET /pool/set?v=<value> sets the cookie pool_sid=<value>; GET /pool/me shows
// the Cookie header it received. `hits` (path + query and the Cookie header of
// every request) is the oracle for "the account's own cookies, and only them".
// docs/05 s51 (0.6-D, one browser context per account) runs on this site too.
export type PoolHit = { path: string; cookie: string | null };
export type PoolSite = { origin: string; hits: PoolHit[]; stop: () => void };

export function startPoolSite(): PoolSite {
  const hits: PoolHit[] = [];
  const html = (body: string, extra: Record<string, string> = {}) =>
    new Response(`<!doctype html><meta charset=utf-8><title>pool</title>${body}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const cookie = req.headers.get("cookie");
      hits.push({ path: `${u.pathname}${u.search}`, cookie });
      if (u.pathname === "/pool/set") {
        const v = (u.searchParams.get("v") ?? "").replace(/[^A-Za-z0-9-]/g, "");
        return html(`<p id=set>set ${v}</p>`, { "set-cookie": `pool_sid=${v}; Path=/; Max-Age=3600; SameSite=Lax` });
      }
      if (u.pathname === "/pool/me") return html(`<p id=me>cookie: ${(cookie ?? "").replace(/[<>&]/g, "")}</p>`);
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.4-F: trace mode range
// Two origins (127.0.0.1 and localhost are different sites, so the second
// one's iframe is out of process). Each page reads a fixed set of signal APIs
// at known lines; the test's expected (api, script, line) pairs are literals
// of these sources. Line numbers in comments are 1-based.

export const TRACE_PROBE_JS = [
  "window.__probe = {", // 1
  "  ua: navigator.userAgent,", // 2
  "  width: screen.width,", // 3
  "  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,", // 4
  "  offset: new Date().getTimezoneOffset(),", // 5
  "};", // 6
  'fetch("/trace/report", { method: "POST", body: JSON.stringify(window.__probe) });', // 7
].join("\n");

export const TRACE_WORKER_JS = [
  "const ua = navigator.userAgent;", // 1
  "postMessage(ua.length);", // 2
].join("\n");

/** Same-origin iframe: an inline script; its line numbers count from the top of the HTML. */
export const TRACE_FRAME_HTML = [
  "<!doctype html><meta charset=utf-8><title>trace frame</title>", // 1
  "<script>", // 2
  "window.__platform = navigator.platform;", // 3
  "</script>", // 4
].join("\n");

/** Cross-origin (OOPIF) iframe on the second origin. */
export const TRACE_OOPIF_HTML = [
  "<!doctype html><meta charset=utf-8><title>trace oopif</title>", // 1
  "<script>", // 2
  "window.__cores = navigator.hardwareConcurrency;", // 3
  "</script>", // 4
].join("\n");

export const TRACE_LOOP_READS = 1000;
export const TRACE_LOOP_JS = [
  "let n = 0;", // 1
  "const t0 = performance.now();", // 2
  `for (let i = 0; i < ${TRACE_LOOP_READS}; i++) n += navigator.userAgent.length;`, // 3
  "window.__loop = { ms: performance.now() - t0, n };", // 4
  'document.title = "loop done";', // 5
].join("\n");

/** Reads navigator.language on a timer; 300 ms after load it fetches the 403 wall (guard → waiting). */
export const TRACE_TICK_JS = [
  "let ticks = 0;", // 1
  'setInterval(() => { ticks += navigator.language.length > 0 ? 1 : 0; document.title = "tick " + ticks; }, 200);', // 2
  'setTimeout(() => { fetch("/trace/wall"); }, 300);', // 3
].join("\n");

/** Creates a 2d canvas context (instrumentation breakpoint canvasContextCreated). */
export const TRACE_CANVAS_JS = [
  'const ctx = document.createElement("canvas").getContext("2d");', // 1
  'document.title = ctx ? "canvas done" : "no canvas";', // 2
].join("\n");

/** What the page itself can see of the instrumented APIs (descriptors, toString, stacks). */
export const TRACE_VISIBLE_JS = [
  "function snap() {",
  '  const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");',
  "  return JSON.stringify({",
  "    getter: d.get.toString(),",
  "    getterViaProto: Function.prototype.toString.call(d.get),",
  "    name: d.get.name, length: d.get.length, keys: Object.keys(d), enumerable: d.enumerable, configurable: d.configurable, set: d.set === undefined,",
  "    names: Object.getOwnPropertyNames(Navigator.prototype), symbols: Object.getOwnPropertySymbols(Navigator.prototype).map(String),",
  "    own: Object.getOwnPropertyNames(navigator),",
  "    toDataURL: Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL),",
  "    query: Function.prototype.toString.call(Permissions.prototype.query),",
  '    screenWidth: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Screen.prototype, "width").get),',
  '    stack: (function probeStack() { return new Error("probe").stack; })(),',
  "    globals: Object.keys(window).length,",
  "  });",
  "}",
  "window.__snapLoad = snap();",
].join("\n");

const tracePage = (title: string, body: string) => `<!doctype html><meta charset=utf-8><title>${title}</title>\n${body}`;

// 0.5-F search range: a document with an inline minified script on its line 2
// (reads navigator.platform) and an external one-line minified script (reads
// navigator.userAgent, fetches a JSON body). Every text the e2e expects is a
// literal here; `trace list` points at both, `net body --at` reads around it.
export const SEARCH_MIN_JS =
  'var k="s05f-key";function sign(t){var u=navigator.userAgent;return t+":"+u.length}window.__sig=sign(k);fetch("/trace/min-api").then(function(r){return r.json()}).then(function(j){document.getElementById("out").textContent=j.token});';
export const SEARCH_MIN_HTML = [
  "<!doctype html><meta charset=utf-8><title>s05f min</title><p id=out>waiting</p>", // 1
  '<script>var p=navigator.platform;window.__p=p.length;</script><script src="/trace/min.js"></script>', // 2
].join("\n");
export const SEARCH_MIN_TOKEN = "s05f-token-42";
export const SEARCH_MIN_API = JSON.stringify({ token: SEARCH_MIN_TOKEN, rows: [{ id: 1, sku: "S05F-1" }, { id: 2, sku: "S05F-2" }] });

export type TraceSite = { a: string; b: string; reports: Record<string, unknown>[]; hits: string[]; stop: () => void };

export function startTraceSite(): TraceSite {
  const reports: Record<string, unknown>[] = [];
  const hits: string[] = [];
  const js = (body: string) => new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`B ${req.method} ${p}`);
      if (p === "/trace/oopif.html") return html(TRACE_OOPIF_HTML);
      return new Response("nf", { status: 404 });
    },
  });
  const bOrigin = `http://localhost:${b.port}`;
  const a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(`A ${req.method} ${p}`);
      if (p === "/trace/")
        return html(
          tracePage(
            "trace probe",
            [
              '<script src="/trace/probe.js"></script>',
              '<iframe id=same src="/trace/frame.html"></iframe>',
              `<iframe id=cross src="${bOrigin}/trace/oopif.html"></iframe>`,
              "<p id=out>loading</p>",
              '<script>const w = new Worker("/trace/worker.js"); w.onmessage = (e) => { document.getElementById("out").textContent = "worker done " + e.data; };</script>',
            ].join("\n"),
          ),
        );
      if (p === "/trace/probe.js") return js(TRACE_PROBE_JS);
      if (p === "/trace/worker.js") return js(TRACE_WORKER_JS);
      if (p === "/trace/frame.html") return html(TRACE_FRAME_HTML);
      if (p === "/trace/loop.html") return html(tracePage("loop", '<script src="/trace/loop.js"></script>'));
      if (p === "/trace/loop.js") return js(TRACE_LOOP_JS);
      if (p === "/trace/wall.html") return html(tracePage("tick 0", '<script src="/trace/tick.js"></script>'));
      if (p === "/trace/tick.js") return js(TRACE_TICK_JS);
      if (p === "/trace/wall") return html("<h2>请完成验证</h2>", 403);
      if (p === "/trace/canvas.html") return html(tracePage("canvas", '<script src="/trace/canvas.js"></script>'));
      if (p === "/trace/canvas.js") return js(TRACE_CANVAS_JS);
      if (p === "/trace/visible.html") return html(tracePage("visible", '<script src="/trace/visible.js"></script>'));
      if (p === "/trace/visible.js") return js(TRACE_VISIBLE_JS);
      if (p === "/trace/min.html") return html(SEARCH_MIN_HTML);
      if (p === "/trace/min.js") return js(SEARCH_MIN_JS);
      if (p === "/trace/min-api") return new Response(SEARCH_MIN_API, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      if (p === "/trace/report" && req.method === "POST") {
        const v: unknown = await req.json().catch(() => null);
        if (typeof v === "object" && v !== null) reports.push(Object.fromEntries(Object.entries(v)));
        return new Response("ok");
      }
      return new Response("nf", { status: 404 });
    },
  });
  return {
    a: `http://127.0.0.1:${a.port}`,
    b: bOrigin,
    reports,
    hits,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}

// ---------------------------------------------------------------- 0.4-I: frames range (docs/05 s22)
// Origin A (127.0.0.1) serves a frameset with two same-origin frames (menu,
// main); main embeds two iframes on origin B (localhost, a different site, so
// both are out of process): a search form whose own same-origin iframe holds
// a two-row table, and an iframe layer (layer.js-like fixed div, as /ov/layer)
// whose close button lives inside the cross-origin iframe and asks main to
// remove the layer by postMessage. Every text a test expects is a literal here.

export const S22_MENU_LINKS = ["栏目一", "栏目二", "栏目三"] as const;
export const S22_TABLE_CELLS = [
  ["S22-0001", "甲方案"],
  ["S22-0002", "乙方案"],
] as const;
export const S22_TITLES = { top: "s22 frames", menu: "s22 menu", main: "s22 main", form: "s22 search", table: "s22 table", modal: "s22 modal" } as const;
export const S22_LAYER_TITLE = "消息提示";
export const S22_CLOSE_LABEL = "关闭";
export const S22_SEARCH_PREFIX = "找到 1 条：";

const s22Doc = (title: string, body: string) => `<!doctype html><meta charset=utf-8><title>${title}</title>\n${body}`;

export type FrameSite = { a: string; b: string; hits: string[]; stop: () => void };

export function startFrameSite(): FrameSite {
  const hits: string[] = [];
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      hits.push(`B ${req.method} ${p}${u.search}`);
      if (p === "/s22/form")
        return html(
          s22Doc(
            S22_TITLES.form,
            `<form id=f onsubmit="return false"><label>关键词 <input id=q name=q></label> <button id=go type=button>查询</button></form>
<p id=result></p>
<iframe id=table src="/s22/table" style="width:400px;height:120px"></iframe>
<script>
document.getElementById("go").addEventListener("click", () => {
  const q = document.getElementById("q").value;
  fetch("/s22/search?q=" + encodeURIComponent(q)).then((r) => r.json()).then((j) => { document.getElementById("result").textContent = j.result; });
});
</script>`,
          ),
        );
      if (p === "/s22/table") return html(s22Doc(S22_TITLES.table, `<table id=t>${S22_TABLE_CELLS.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`));
      if (p === "/s22/search") {
        const q = u.searchParams.get("q") ?? "";
        return new Response(JSON.stringify({ q, result: `${S22_SEARCH_PREFIX}${q}` }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (p === "/s22/modal")
        return html(
          s22Doc(
            S22_TITLES.modal,
            `<p>新消息：系统维护通知</p><button id=modal-close type=button aria-label=${S22_CLOSE_LABEL}>×</button>
<script>document.getElementById("modal-close").addEventListener("click", () => parent.postMessage("s22-close", "*"));</script>`,
          ),
        );
      return new Response("nf", { status: 404 });
    },
  });
  const bOrigin = `http://localhost:${b.port}`;
  const a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      hits.push(`A ${req.method} ${p}${u.search}`);
      if (p === "/s22") return html(`<!doctype html><meta charset=utf-8><title>${S22_TITLES.top}</title>\n<frameset cols="25%,75%"><frame name=menu src="/s22/menu"><frame name=main src="/s22/main"></frameset>`);
      if (p === "/s22/menu") return html(s22Doc(S22_TITLES.menu, `<ul>${S22_MENU_LINKS.map((l, i) => `<li><a href="/s22/main?p=${i + 1}" target=main>${l}</a></li>`).join("")}</ul>`));
      if (p === "/s22/main")
        return html(
          s22Doc(
            S22_TITLES.main,
            `<style>body{margin:8px;font:14px sans-serif}</style>
<h1>主区域</h1>
<iframe id=search src="${bOrigin}/s22/form" style="width:480px;height:260px"></iframe>
<div class="layui-layer layui-layer-iframe" id=s22-layer type=iframe style="z-index:19891015;width:300px;height:180px;position:fixed;right:12px;bottom:12px;background:#fff;border:1px solid #888">
  <div class=layui-layer-title style="padding:6px">${S22_LAYER_TITLE}</div>
  <div class=layui-layer-content><iframe id=s22-layer-iframe name=s22-layer-iframe frameborder=0 src="${bOrigin}/s22/modal" style="width:100%;height:130px"></iframe></div>
</div>
<script>
window.addEventListener("message", (e) => { if (e.data === "s22-close") { const l = document.getElementById("s22-layer"); if (l) l.remove(); } });
</script>`,
          ),
        );
      return new Response("nf", { status: 404 });
    },
  });
  return {
    a: `http://127.0.0.1:${a.port}`,
    b: bOrigin,
    hits,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}

// ---------------------------------------------------------------- 0.6-A: tabcap fetch range
// Origin A: the s07 login (LOGIN_PAGE above, same endpoints) plus data
// endpoints a scraper calls; origin B: a second port on 127.0.0.1 (a different
// origin, same site), one endpoint that allows A by CORS and one that does
// not. The access log keeps every request's headers and arrival time: the
// oracle for "the server never saw the marker header" and for the interval.
// `served` maps path + query → the exact body text sent.

/** /api/item?n=K answers this body for the logged-in session (literal oracle). */
export const FETCH_ITEM = (n: string, user: string): string => JSON.stringify({ code: 0, n, user, item: `item-${n}` });
/** /api/biz: a business error a stop rule `json:$.code!=0` catches. */
export const FETCH_BIZ_ERROR = JSON.stringify({ code: 1, msg: "busy, try later" });
export const FETCH_OK = JSON.stringify({ code: 0, ok: true });
/** /api/big: a JSON body over the 8 KB inline limit. */
export const FETCH_BIG = JSON.stringify({ code: 0, pad: "b".repeat(12_000) });
export const FETCH_CORS_BODY = JSON.stringify({ code: 0, from: "origin-b" });

export type FetchHit = { origin: "a" | "b"; method: string; path: string; query: string; headers: Record<string, string>; at: number };
export type FetchSite = { a: string; b: string; log: FetchHit[]; served: Map<string, string>; stop: () => void };

export function startFetchSite(): FetchSite {
  const log: FetchHit[] = [];
  const served = new Map<string, string>();
  const sessions = new Map<string, string>(); // sid -> user
  const json = (key: string, body: string, status = 200, extra: Record<string, string> = {}) => {
    served.set(key, body);
    return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  };
  const note = (origin: "a" | "b", req: Request): URL => {
    const u = new URL(req.url);
    log.push({ origin, method: req.method, path: u.pathname, query: u.search, headers: Object.fromEntries(req.headers), at: Date.now() });
    return u;
  };
  const a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = note("a", req);
      const p = u.pathname;
      const key = p + u.search;
      if (p === "/s07/login") return new Response(LOGIN_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (p === "/api/login" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        if (f.get("user") !== LOGIN_USER || f.get("password") !== LOGIN_PASSWORD) return json(key, JSON.stringify({ error: "bad credentials" }), 401);
        const sid = crypto.randomUUID().replace(/-/g, "");
        sessions.set(sid, LOGIN_USER);
        return json(key, JSON.stringify({ csrf: "c" }), 200, { "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
      const user = sessions.get(sid);
      if (p === "/api/data" && req.method === "POST") return user === undefined ? json(key, JSON.stringify({ error: "no session" }), 401) : json(key, JSON.stringify({ data: "data-ok" }));
      if (user === undefined) return json(key, JSON.stringify({ code: 401, error: "no session" }), 401);
      if (p === "/api/item") return json(key, FETCH_ITEM(u.searchParams.get("n") ?? "", user));
      if (p === "/api/biz") return json(key, FETCH_BIZ_ERROR);
      if (p === "/api/ok") return json(key, FETCH_OK);
      if (p === "/api/big") return json(key, FETCH_BIG);
      return new Response("nf", { status: 404 });
    },
  });
  const aOrigin = `http://127.0.0.1:${a.port}`;
  const b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = note("b", req);
      if (u.pathname === "/api/cors") return json(`b${u.pathname}`, FETCH_CORS_BODY, 200, { "access-control-allow-origin": aOrigin, "access-control-allow-credentials": "true" });
      if (u.pathname === "/api/nocors") return json(`b${u.pathname}`, FETCH_CORS_BODY);
      return new Response("nf", { status: 404 });
    },
  });
  return {
    a: aOrigin,
    b: `http://127.0.0.1:${b.port}`,
    log,
    served,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}

// ---------------------------------------------------------------- 0.6-D: daemon fixes range (docs/05 s47–s52)
// One origin, six small pages; every text and value a test expects is a
// literal here, and the server's own log (`hits`, `posts`) is the oracle for
// what the browser sent.
//   /s47            s47 hidden-controls: inputs, a button, a file input and a
//                   hover box inside aria-hidden (no accessibility node); the
//                   page writes what it received into #s47-out (outside the
//                   hidden part) and records hover / upload itself.
//   /s48            s48 click-effects: a sub-menu title and a table cell whose
//                   handlers ignore untrusted clicks, a counter button (DOM
//                   change), a link (navigation), a ping button (request only).
//   /s49            s49 post-redirect: a form POST → 302 → GET page, and a
//                   fetch POST → 302 → GET JSON; `posts` keeps each body the
//                   server received.
//   /s50            s50 image-captcha: a login form with a captcha image and
//                   its code input; /s50/plain is the same form without it.
//   /s52            s52 frame-dates: an ambiguous date in the root document,
//                   a date with a day over 12 inside an iframe.

export const S47_USER = "s47-user-7f";
export const S47_PASS = "S23-pass-e2e-91";
export const S47_UPLOAD_NAME = "s47-upload.txt";
export const S48_ITEM = "子项一";
export const S49_FORM = { user: "s49-user", note: "备注 a&b=c" } as const;
export const S49_FETCH_BODY = JSON.stringify({ q: "s49-fetch", n: 25 });
export const S50_IMG_ALT = "验证码";
export const S52_ROOT_DATE = "03/04/2026";
export const S52_FRAME_DATE = "25/04/2026";

export type DaemonFixSite = { origin: string; hits: string[]; posts: Map<string, string>; stop: () => void };

export function startDaemonFixSite(): DaemonFixSite {
  const hits: string[] = [];
  const posts = new Map<string, string>();
  const page = (title: string, body: string) =>
    new Response(`<!doctype html><meta charset=utf-8><title>${title}</title>\n${body}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      hits.push(`${req.method} ${p}${u.search}`);
      if (p === "/s47")
        return page(
          "s47 hidden controls",
          `<div class=el-form aria-hidden=true>
  <div class=el-input><input class=el-input__inner id=s47-user type=text></div>
  <div class=el-input><input class=el-input__inner id=s47-pass type=password></div>
  <button type=button class=el-button id=s47-go><span class=el-icon></span></button>
  <input type=file class=el-upload__input id=s47-file>
  <div class=s47-hover id=s47-hover style="width:120px;height:30px;background:#ddd"></div>
</div>
<p id=s47-out></p>
<script>
window.__s23 = { hover: null, file: null };
const $ = (id) => document.getElementById(id);
$("s47-go").addEventListener("click", () => { $("s47-out").textContent = "user=" + $("s47-user").value + ";pass=" + $("s47-pass").value.length; });
$("s47-hover").addEventListener("mouseover", (e) => { window.__s23.hover = e.isTrusted; });
$("s47-file").addEventListener("change", () => { const f = $("s47-file").files[0]; window.__s23.file = f ? f.name : null; });
</script>`,
        );
      if (p === "/s48")
        return page(
          "s48 click effects",
          `<ul class=el-menu><li class=el-submenu><div class=el-submenu__title id=s48-sub>子菜单</div><ul id=s48-items style="display:none"><li>${S48_ITEM}</li></ul></li></ul>
<table><tr><td id=s48-cell>单元格</td></tr></table>
<button type=button id=s48-count>加一</button> <span id=s48-n>0</span>
<a id=s48-link href="/s48/next">下一页</a>
<button type=button id=s48-ping>只发请求</button>
<script>
const $ = (id) => document.getElementById(id);
$("s48-sub").addEventListener("click", (e) => { if (e.isTrusted) $("s48-items").style.display = "block"; });
$("s48-cell").addEventListener("click", (e) => { if (e.isTrusted) $("s48-cell").textContent = "已选"; });
$("s48-count").addEventListener("click", () => { $("s48-n").textContent = String(Number($("s48-n").textContent) + 1); });
$("s48-ping").addEventListener("click", () => { fetch("/s48/ping", { cache: "no-store" }); });
</script>`,
        );
      if (p === "/s48/next") return page("s48 next", "<p>第二页</p>");
      if (p === "/s48/ping") return json({ pong: 1 });
      if (p === "/s49")
        return page(
          "s49 post redirect",
          `<form id=s49-form method=post action="/s49/submit"><input name=user value="${S49_FORM.user}"><input name=note value="${S49_FORM.note.replace(/&/g, "&amp;")}"><button id=s49-go>提交</button></form>
<button type=button id=s49-fetch>接口提交</button> <span id=s49-out></span>
<script>
document.getElementById("s49-fetch").addEventListener("click", () => {
  fetch("/s49/api", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(S49_FETCH_BODY)} })
    .then((r) => r.json()).then((j) => { document.getElementById("s49-out").textContent = j.done; });
});
</script>`,
        );
      if (p === "/s49/submit" && req.method === "POST") {
        posts.set(p, await req.text());
        return new Response(null, { status: 302, headers: { location: "/s49/done", "cache-control": "no-store" } });
      }
      if (p === "/s49/done") return page("s49 done", "<p id=s49-done>已提交</p>");
      if (p === "/s49/api" && req.method === "POST") {
        posts.set(p, await req.text());
        return new Response(null, { status: 302, headers: { location: "/s49/api/done", "cache-control": "no-store" } });
      }
      if (p === "/s49/api/done") return json({ done: "s49-api-done" });
      if (p === "/s50" || p === "/s50/plain") {
        const captcha =
          p === "/s50"
            ? `<p><label>验证码 <input name=verifyCode id=s50-code></label> <img id=s50-img class=captcha-img src="/s50/captcha.png" alt="${S50_IMG_ALT}" style="width:100px;height:40px;border:1px solid #888"></p>`
            : "";
        return page(
          p === "/s50" ? "s50 captcha login" : "s50 plain login",
          `<form id=s50-form onsubmit="return false">
<p><label>用户名 <input name=username id=s50-user></label></p>
<p><label>密码 <input type=password name=password id=s50-pass></label></p>
${captcha}
<button type=button id=s50-go>登录</button>
</form>`,
        );
      }
      if (p === "/s50/captcha.png") return new Response(PIXEL, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
      if (p === "/s52") return page("s52 frame dates", `<p id=s52-date>${S52_ROOT_DATE}</p>\n<iframe id=s52-frame src="/s52/frame" style="width:300px;height:80px"></iframe>`);
      if (p === "/s52/frame") return page("s52 frame", `<p>截止 ${S52_FRAME_DATE}</p>`);
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, hits, posts, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-B: s42 decode plugins
// An API whose bodies are encoded: every /s42/api/* response and the one POST
// body are the UTF-8 JSON XORed with S42_KEY, then base64, sent as text/plain
// with `x-enc: xor`. The page decodes in JS and renders the items table; the
// order button posts the token and the first item, encoded the same way. The
// range decode plugin (test/e2e/plugins/xor-decode, key in its config.json)
// undoes the encoding. Every plaintext below is written by hand; none of its
// values appears in any raw body.
export const S42_KEY = "tabcap-s42-key";
export const S42_TOKEN = "S42-TOKEN-5e1f9a3c7b2d4e60";
export const S42_TOKEN_JSON = JSON.stringify({ token: S42_TOKEN, ttl: 600 });
export const S42_ITEMS_JSON = JSON.stringify({
  items: [
    { id: "S42-ITEM-0001", name: "甲号商品", price: "1288.50" },
    { id: "S42-ITEM-0002", name: "乙号商品", price: "66.00" },
  ],
});
export const S42_ORDER = "S42-ORDER-0077";
export const S42_ORDER_JSON = JSON.stringify({ ok: true, order: S42_ORDER });
/** The POST body the page sends, before encoding (the page builds the same string). */
export const S42_POST_JSON = JSON.stringify({ token: S42_TOKEN, item: "S42-ITEM-0001", qty: 2 });

export function xorEncode(plain: string, key: string = S42_KEY): string {
  const k = new TextEncoder().encode(key);
  const b = new TextEncoder().encode(plain);
  return Buffer.from(b.map((x, i) => x ^ (k[i % k.length] ?? 0))).toString("base64");
}

export function xorDecode(b64: string, key: string = S42_KEY): string {
  const k = new TextEncoder().encode(key);
  const b = new Uint8Array(Buffer.from(b64, "base64"));
  return new TextDecoder().decode(b.map((x, i) => x ^ (k[i % k.length] ?? 0)));
}

const S42_PAGE = `<!doctype html><meta charset=utf-8><title>s42 decode</title>
<h1>s42 decode</h1>
<table id=items><thead><tr><th>id</th><th>name</th><th>price</th></tr></thead><tbody></tbody></table>
<button type=button id=order>order</button>
<p id=status>loading</p>
<script>
const KEY = new TextEncoder().encode(${JSON.stringify(S42_KEY)});
const dec = (b64) => { const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return JSON.parse(new TextDecoder().decode(b.map((x, i) => x ^ KEY[i % KEY.length]))); };
const enc = (s) => { const b = new TextEncoder().encode(s).map((x, i) => x ^ KEY[i % KEY.length]); let t = ""; for (const x of b) t += String.fromCharCode(x); return btoa(t); };
let token = "";
(async () => {
  token = dec(await (await fetch("/s42/api/token")).text()).token;
  const items = dec(await (await fetch("/s42/api/items", { headers: { "x-auth": token } })).text()).items;
  const tb = document.querySelector("#items tbody");
  for (const it of items) { const tr = document.createElement("tr"); for (const k of ["id", "name", "price"]) { const td = document.createElement("td"); td.textContent = it[k]; tr.appendChild(td); } tb.appendChild(tr); }
  document.getElementById("status").textContent = "ready";
})();
document.getElementById("order").addEventListener("click", async () => {
  const body = enc(JSON.stringify({ token, item: "S42-ITEM-0001", qty: 2 }));
  const r = await fetch("/s42/api/order", { method: "POST", headers: { "content-type": "text/plain", "x-enc": "xor", "x-auth": token }, body });
  document.getElementById("status").textContent = "ordered " + dec(await r.text()).order;
});
</script>`;

export type DecodeSite = Site & { orders: string[] };

export function startDecodeSite(): DecodeSite {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const orders: string[] = [];
  const send = (key: string, body: string, type: string, extra: Record<string, string> = {}) => {
    const bytes = new TextEncoder().encode(body);
    served.set(key, createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store", ...extra } });
  };
  const encoded = (key: string, plain: string) => send(key, xorEncode(plain), "text/plain; charset=utf-8", { "x-enc": "xor" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s42") return send(u.pathname, S42_PAGE, "text/html; charset=utf-8");
      if (u.pathname === "/s42/api/token") return encoded(u.pathname, S42_TOKEN_JSON);
      if (u.pathname === "/s42/api/items") {
        if (req.headers.get("x-auth") !== S42_TOKEN) return new Response("forbidden", { status: 403 });
        return encoded(u.pathname, S42_ITEMS_JSON);
      }
      if (u.pathname === "/s42/api/order" && req.method === "POST") {
        const plain = xorDecode(await req.text());
        orders.push(plain);
        if (req.headers.get("x-auth") !== S42_TOKEN || plain !== S42_POST_JSON) return new Response("bad order", { status: 400 });
        return encoded(u.pathname, S42_ORDER_JSON);
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, orders, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-J: click landing range (docs/05 s56)
// One page, three widgets after the three UI-library patterns of the owner's
// real-project test (10-16). Every text and id a test expects is a literal
// here; what each handler received is what the page itself wrote down
// (window.__s56: one "<widget>:<isTrusted>" entry per handler run).
//   #s56-lay    layui: the accessible element (role=button, 300 px wide) has
//               no listener; the handler is hooked by attribute onto the inner
//               span[lay-event] (60 px, at the left edge).
//   #s56-menu   antd / Element UI: the handler is delegated at a root four
//               levels up (#s56-app) and only reacts when the event target is
//               inside the cursor:pointer child .s56-title (80 px, at the left).
//   #s56-trust  a handler on the element itself that ignores untrusted clicks.

export const S56_LAY_TEXT = "编辑";
export const S56_MENU_TEXT = "菜单项";
export const S56_TRUST_TEXT = "只认真点";

export function startClickTargetSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const html = `<!doctype html><meta charset=utf-8><title>s56 click landing</title>
<style>.s56-box{display:block;width:300px;height:32px;margin:8px 0;border:1px solid #888}.s56-box span{display:inline-block;height:30px;line-height:30px}</style>
<div class=s56-box role=button id=s56-lay tabindex=0><span lay-event=s56-edit id=s56-lay-span style="width:60px">${S56_LAY_TEXT}</span></div>
<div id=s56-app><div class=ant-wrap><div class=ant-row><div class=ant-col>
  <div class=s56-box role=menuitem id=s56-menu tabindex=0><span class=s56-title id=s56-menu-title style="width:80px;cursor:pointer">${S56_MENU_TEXT}</span></div>
</div></div></div></div>
<div class=s56-box role=button id=s56-trust tabindex=0 style="width:120px">${S56_TRUST_TEXT}</div>
<p id=s56-out></p>
<script>
window.__s56 = [];
const out = (w, e) => { window.__s56.push(w + ":" + e.isTrusted); document.getElementById("s56-out").textContent = window.__s56.join(" "); };
document.querySelectorAll("[lay-event]").forEach((el) => el.addEventListener("click", (e) => out("lay", e)));
document.getElementById("s56-app").addEventListener("click", (e) => { if (e.target instanceof Element && e.target.closest(".s56-title")) out("menu", e); });
document.getElementById("s56-trust").addEventListener("click", (e) => { if (e.isTrusted) out("trust", e); });
</script>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s56") {
        served.set("/s56", html);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}


// 0.6-N: a tiny HTTP forward proxy for `browser start --proxy <url>` (loopback goes through it).
// It accepts absolute-URI GET requests (no CONNECT, no auth), records every target URL it was
// asked for in `seen` (the oracle: what the proxy itself saw) and forwards 127.0.0.1 / localhost ones with
// fetch to 127.0.0.1, so nothing leaves the machine.
export type ProxySite = { url: string; port: number; seen: string[]; stop: () => void };

export function startProxySite(): ProxySite {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const target = new URL(req.url);
      if (req.method !== "GET") return new Response("proxy: only GET", { status: 405 });
      seen.push(target.href);
      // localhost goes to the range's 127.0.0.1; any other name (e.g. [::1]) is only logged
      if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") return new Response("proxy: not forwarded", { status: 502 });
      target.hostname = "127.0.0.1";
      const up = await fetch(target.href, { redirect: "manual" });
      const headers = new Headers(up.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(await up.arrayBuffer(), { status: up.status, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port ?? 0, seen, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-I: bodies and site stop rules (docs/05 s54–s55)
// One origin; every size and status a test expects is a literal here or in
// `served` / `api` (what the range really sent), never tabcap's output.
//   /s54            s54 big-script: a page with a 1.5 MiB script, a
//                   stylesheet, an image and one fetch() of JSON; `served`
//                   keeps the byte length of each body sent.
//   /s55            s55 site-stop: a button whose click fetches /s55/api
//                   and reads the body; /s55/api answers by arrival order
//                   with S55_STATUSES (then 200); `api` logs each answer.

export const S54_ROWS = ["s54-a", "s54-b"] as const;
export const S54_SCRIPT = `/* s54 big script */\nwindow.__s54 = "loaded";\nvar s54_pad = "${"0123456789abcdef".repeat(96 * 1024)}";\n`;
export const S54_CSS = "body { font-family: sans-serif; } h1 { color: #333; }\n";
export const S55_STATUSES = [200, 500, 500, 500] as const;

export type BodiesSite = { origin: string; served: Map<string, number>; api: Array<{ n: number; status: number }>; stop: () => void };

export function startBodiesSite(): BodiesSite {
  const served = new Map<string, number>();
  const api: Array<{ n: number; status: number }> = [];
  const send = (path: string, body: string | Uint8Array, type: string, status = 200) => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    served.set(path, bytes.length);
    return new Response(bytes, { status, headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/favicon.ico") return new Response(null, { status: 204 });
      if (p === "/s54")
        return send(
          p,
          `<!doctype html><meta charset=utf-8><title>s54 big script</title><link rel=stylesheet href="/s54/site.css">
<h1>s54</h1><img src="/s54/logo.png" alt="logo" width=1 height=1><p id=s54-out></p>
<script src="/s54/big.js"></script>
<script>fetch("/s54/api", { cache: "no-store" }).then((r) => r.json()).then((j) => { document.getElementById("s54-out").textContent = j.rows.join(","); });</script>`,
          "text/html; charset=utf-8",
        );
      if (p === "/s54/big.js") return send(p, S54_SCRIPT, "application/javascript");
      if (p === "/s54/site.css") return send(p, S54_CSS, "text/css");
      if (p === "/s54/logo.png") return send(p, PIXEL, "image/png");
      if (p === "/s54/api") return send(p, JSON.stringify({ rows: S54_ROWS }), "application/json");
      if (p === "/s55")
        return send(
          p,
          `<!doctype html><meta charset=utf-8><title>s55 site stop</title>
<button type=button id=s55-load>加载</button> <span id=s55-out></span>
<script>
document.getElementById("s55-load").addEventListener("click", () => {
  fetch("/s55/api", { cache: "no-store" }).then((r) => r.json().then((j) => { document.getElementById("s55-out").textContent = "n" + String(j.n) + "=" + String(r.status); }));
});
</script>`,
          "text/html; charset=utf-8",
        );
      if (p === "/s55/api") {
        const n = api.length + 1;
        const status = S55_STATUSES[n - 1] ?? 200;
        api.push({ n, status });
        return send(p, JSON.stringify({ n, status }), "application/json", status);
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, api, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-L / L2: s59 in-page decoding (docs/05 s59)
// /api/enc answers {"code":0,"data":"<base64>"}: the 12-row JSON below either
// XORed with S59_XOR_KEY (default) or, with ?mode=webcrypto, AES-128-GCM
// encrypted with S59_AES_KEY_HEX / S59_AES_IV_HEX (data = base64(iv ||
// ciphertext || tag)). Variants: worker (XOR in a dedicated worker, main
// thread JSON.parse of the posted string), axios (transformResponse parses
// the envelope then the plaintext), inline (JSON.parse(decrypt(data))),
// bare (whole body is one base64 token), big (~1.2 MiB plaintext, not
// rendered), deferred (the plaintext is parked in a script-level array and
// parsed by a timer callback that is its only frame: no ciphertext is
// reachable from the parse — the weak-link case of docs/04 §33). 0.6-Q:
// mime (the envelope's data is MIME base64, "\r\n" every 76 chars; the page
// strips whitespace before XOR-decrypting), noise (two small encrypted
// responses armed while the page parses a ≥ 1 KB JSON string from its own
// localStorage, in a frame that reaches no ciphertext), race (three encrypted
// responses, each envelope JSON.parsed in the fetch chain as soon as its text
// arrives — possibly before tabcap indexed it — then all decrypted). 0.6-W:
// xhr (XMLHttpRequest; the envelope and the plaintext are parsed in onload,
// which fires before tabcap indexes the body) with &linger=N (first N ≤ 3
// encrypted responses fetched and never parsed: live suspects nobody
// claims). The page
// fetches, decrypts in its own JS, JSON.parses, renders (except big), then
// fetches /api/plain as the control. Rows and keys are literals here; no
// plaintext value appears in any raw /api/enc body.
export const S59_XOR_KEY = "s59-page-key-31";
export const S59_AES_KEY_HEX = "5a59a1c3d2e1f00f1e2d3c4b5a697887";
export const S59_AES_IV_HEX = "0f1e2d3c4b5a69788796a5b4";
export const S59_AES_IV2_HEX = "a1b2c3d4e5f60718293a4b5c";
export const S59_ROWS = Array.from({ length: 12 }, (_, i) => ({ id: `S59-${String(i + 1).padStart(4, "0")}`, qty: ((i * 7) % 13) + 1, amount: `${(i + 1) * 101}.50` }));
export const S59_ROWS2 = Array.from({ length: 12 }, (_, i) => ({ id: `S59-${String(101 + i).padStart(4, "0")}`, qty: ((i * 5) % 11) + 2, amount: `${(i + 2) * 202}.25` }));
export const S59_PLAIN = JSON.stringify({ rows: S59_ROWS });
export const S59_PLAIN2 = JSON.stringify({ rows: S59_ROWS2 });
export const S59_CONTROL = JSON.stringify({ code: 0, control: "s59-plain-control", note: "plain JSON the page parses too" });

export function s59Xor(plain: string): string {
  const k = Buffer.from(S59_XOR_KEY, "latin1");
  const b = Buffer.from(plain, "latin1");
  return Buffer.from(b.map((x, i) => x ^ (k[i % k.length] ?? 0))).toString("base64");
}

export function s59Gcm(plain: string, ivHex: string = S59_AES_IV_HEX): string {
  const c = createCipheriv("aes-128-gcm", Buffer.from(S59_AES_KEY_HEX, "hex"), Buffer.from(ivHex, "hex"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from(ivHex, "hex"), ct, c.getAuthTag()]).toString("base64");
}

export const S59_ENC_XOR = JSON.stringify({ code: 0, data: s59Xor(S59_PLAIN) });
export const S59_ENC_GCM = JSON.stringify({ code: 0, data: s59Gcm(S59_PLAIN) });
export const S59_ENC_GCM2 = JSON.stringify({ code: 0, data: s59Gcm(S59_PLAIN2, S59_AES_IV2_HEX) });
/** Bare ciphertext: the body is one base64 token, no JSON envelope (0.6-L2 item 6). */
export const S59_BARE_XOR = s59Xor(S59_PLAIN);

// 0.6-Q: ?mode=mime / noise / race (docs/05 s59).
/** base64 wrapped the MIME way: "\r\n" after every 76 characters. */
export function s59Mime(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}
export const S59_ENC_MIME = JSON.stringify({ code: 0, data: s59Mime(s59Xor(S59_PLAIN)) });
/** Two small plaintexts (≈ 70 bytes; their base64 leaves are just over 64 chars). */
export const S59_NOISE_PLAIN1 = JSON.stringify({ rows: [{ id: "S59-N001", qty: 3, amount: "7.25", note: "noise-1" }] });
export const S59_NOISE_PLAIN2 = JSON.stringify({ rows: [{ id: "S59-N002", qty: 5, amount: "9.75", note: "noise-2" }] });
export const S59_ENC_NOISE1 = JSON.stringify({ code: 0, data: s59Xor(S59_NOISE_PLAIN1) });
export const S59_ENC_NOISE2 = JSON.stringify({ code: 0, data: s59Xor(S59_NOISE_PLAIN2) });
/** The page's own localStorage JSON (≥ 1 KB), parsed while both noise suspects are armed. */
export const S59_NOISE_LOCAL = JSON.stringify({ user: { name: "s59-noise-user", prefs: Array.from({ length: 40 }, (_, i) => ({ key: `pref-${String(i).padStart(2, "0")}`, value: i * 3 })) } });
/** Race: two large plaintexts (40 rows) and the regular S59_PLAIN as slot 3. */
export const S59_RACE_PLAIN1 = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: `S59-R${String(i + 1).padStart(3, "0")}`, qty: (i % 9) + 1, amount: `${(i + 3) * 11}.10` })) });
export const S59_RACE_PLAIN2 = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: `S59-R${String(i + 101).padStart(3, "0")}`, qty: (i % 7) + 2, amount: `${(i + 5) * 13}.40` })) });
export const S59_ENC_RACE1 = JSON.stringify({ code: 0, data: s59Xor(S59_RACE_PLAIN1) });
export const S59_ENC_RACE2 = JSON.stringify({ code: 0, data: s59Xor(S59_RACE_PLAIN2) });
/** 0.6-W linger: three 20-row plaintexts (larger than S59_PLAIN, so every
 * lingering suspect fits the xhr plaintext and stays a candidate). */
export const S59_LINGER_PLAINS = [1, 2, 3].map((n) => JSON.stringify({ rows: Array.from({ length: 20 }, (_, i) => ({ id: `S59-L${n}${String(i + 1).padStart(2, "0")}`, qty: ((i + n) % 9) + 1, amount: `${(i + n) * 17}.30` })) }));
export const S59_ENC_LINGER = S59_LINGER_PLAINS.map((p) => JSON.stringify({ code: 0, data: s59Xor(p) }));
/** Plaintext just over the old 1 MiB cap (0.6-L2 item 3). Built lazily so
 * importing this module does not allocate it on every other range. */
export const S59_BIG_MARKER = "S59-BIG-0001";
let s59BigPlainMemo: string | null = null;
export function s59BigPlain(): string {
  if (s59BigPlainMemo === null) s59BigPlainMemo = JSON.stringify({ marker: S59_BIG_MARKER, pad: "a".repeat(1_200_000) });
  return s59BigPlainMemo;
}

const S59_PAGE = `<!doctype html><meta charset=utf-8><title>s59 in-page decode</title>
<h1>s59 in-page decode</h1>
<table id=rows><thead><tr><th>id</th><th>qty</th><th>amount</th></tr></thead><tbody></tbody></table>
<p id=status>loading</p>
<script>
const S59_KEY = ${JSON.stringify(S59_XOR_KEY)};
const S59_AES = ${JSON.stringify(S59_AES_KEY_HEX)};
function s59Bytes(b64) { const raw = atob(b64); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }
function s59XorPlain(data) {
  const raw = atob(data);
  let plain = "";
  for (let i = 0; i < raw.length; i++) plain += String.fromCharCode(raw.charCodeAt(i) ^ S59_KEY.charCodeAt(i % S59_KEY.length));
  return plain;
}
function s59Xor(data) { return JSON.parse(s59XorPlain(data)); }
function s59Axios(text) {
  const env = JSON.parse(text);
  return JSON.parse(s59XorPlain(env.data));
}
const s59Later = [];
let s59LaterDone = null;
function s59ParseLater() {
  const t = s59Later.shift();
  s59Render(JSON.parse(t).rows);
  s59LaterDone();
}
async function s59Gcm(data) {
  const buf = s59Bytes(data);
  const keyBytes = new Uint8Array(S59_AES.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
function s59Render(rows) {
  const tb = document.querySelector("#rows tbody");
  for (const r of rows) { const tr = document.createElement("tr"); for (const k of ["id", "qty", "amount"]) { const td = document.createElement("td"); td.textContent = String(r[k]); tr.appendChild(td); } tb.appendChild(tr); }
}
function s59Worker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker("/s59/worker.js");
    w.onmessage = (e) => { w.terminate(); resolve(JSON.parse(e.data)); };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage({ key: S59_KEY, data });
  });
}
function s59XhrGet(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.onload = () => {
      // parsed in onload, as soon as the body is there
      const env = JSON.parse(x.responseText);
      s59Render(s59Xor(env.data).rows);
      resolve();
    };
    x.onerror = reject;
    x.send();
  });
}
function s59NoiseUser() {
  return JSON.parse(localStorage.getItem("s59-noise-user"));
}
async function s59Enc(mode) {
  if (mode === "mime") {
    const env = JSON.parse(await (await fetch("/api/enc?mode=mime", { cache: "no-store" })).text());
    s59Render(s59Xor(env.data.replace(/\\s+/g, "")).rows);
    return;
  }
  if (mode === "noise") {
    localStorage.setItem("s59-noise-user", ${JSON.stringify(S59_NOISE_LOCAL)});
    const texts = await Promise.all([1, 2].map((n) => fetch("/api/enc?mode=noise&slot=" + n, { cache: "no-store" }).then((r) => r.text())));
    // both responses are recorded (armed) by now; the page reads its own user info
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById("status").dataset.user = s59NoiseUser().user.name;
    for (const t of texts) s59Render(s59Xor(JSON.parse(t).data).rows);
    return;
  }
  if (mode === "xhr") {
    const linger = Math.min(Number(new URLSearchParams(location.search).get("linger") || 0), 3);
    // fetched, never parsed: armed suspects nobody claims
    for (let n = 1; n <= linger; n++) await (await fetch("/api/enc?mode=linger&slot=" + n, { cache: "no-store" })).text();
    // all of them recorded (armed) by now
    if (linger > 0) await new Promise((r) => setTimeout(r, 300));
    await s59XhrGet("/api/enc?mode=xhr");
    return;
  }
  if (mode === "race") {
    const envs = await Promise.all([1, 2, 3].map((n) => fetch("/api/enc?mode=race&slot=" + n, { cache: "no-store" }).then((r) => r.text().then((t) => JSON.parse(t)))));
    for (const env of envs) s59Render(s59Xor(env.data).rows);
    return;
  }
  if (mode === "bare") {
    const data = (await (await fetch("/api/enc?mode=bare", { cache: "no-store" })).text()).trim();
    s59Render(s59Xor(data).rows);
    return;
  }
  if (mode === "big") {
    const env = JSON.parse(await (await fetch("/api/enc?mode=big", { cache: "no-store" })).text());
    const obj = s59Xor(env.data);
    document.getElementById("status").dataset.marker = obj.marker;
    return;
  }
  if (mode === "axios") {
    s59Render(s59Axios(await (await fetch("/api/enc", { cache: "no-store" })).text()).rows);
    return;
  }
  if (mode === "inline") {
    const env = JSON.parse(await (await fetch("/api/enc", { cache: "no-store" })).text());
    s59Render(JSON.parse(s59XorPlain(env.data)).rows);
    return;
  }
  if (mode === "deferred") {
    const env = JSON.parse(await (await fetch("/api/enc", { cache: "no-store" })).text());
    s59Later.push(s59XorPlain(env.data));
    await new Promise((r) => { s59LaterDone = r; setTimeout(s59ParseLater, 0); });
    return;
  }
  const two = mode === "webcrypto" && new URLSearchParams(location.search).get("two") === "1";
  if (!two) {
    const res = await fetch(mode === "webcrypto" ? "/api/enc?mode=webcrypto" : "/api/enc", { cache: "no-store" });
    const text = await res.text();
    const env = JSON.parse(text);
    const plain = mode === "webcrypto" ? await s59Gcm(env.data) : mode === "worker" ? await s59Worker(env.data) : s59Xor(env.data);
    s59Render(plain.rows);
    return;
  }
  // ?mode=webcrypto&two=1: two concurrent encrypted responses, both suspects of
  // the observe mode at once; each decrypted, each JSON.parsed, both rendered.
  const pair = await Promise.all([fetch("/api/enc?mode=webcrypto&slot=1", { cache: "no-store" }), fetch("/api/enc?mode=webcrypto&slot=2", { cache: "no-store" })]);
  for (const res of pair) {
    const env = JSON.parse(await res.text());
    s59Render((await s59Gcm(env.data)).rows);
  }
}
async function s59Plain() {
  const res = await fetch("/api/plain", { cache: "no-store" });
  return JSON.parse(await res.text());
}
async function s59Main(mode) {
  await s59Enc(mode);
  const c = await s59Plain();
  document.getElementById("status").textContent = "ready " + c.control;
}
const s59Mode = new URLSearchParams(location.search).get("mode");
s59Main(["webcrypto", "worker", "axios", "inline", "bare", "big", "deferred", "mime", "noise", "race", "xhr"].includes(s59Mode) ? s59Mode : "xor");
</script>`;

// ?mode=worker: the XOR runs in a dedicated worker, which posts the plaintext
// string back; the main thread JSON.parses it.
const S59_WORKER_JS = `onmessage = (e) => {
  const raw = atob(e.data.data);
  const key = e.data.key;
  let plain = "";
  for (let i = 0; i < raw.length; i++) plain += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  postMessage(plain);
};`;

export function startInPageDecodeSite(): Site {
  const served = new Map<string, string>();
  const hits: string[] = [];
  const send = (key: string, body: string, type: string) => {
    served.set(key, body);
    return new Response(body, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const key = u.pathname + u.search;
      hits.push(`${req.method} ${key}`);
      if (u.pathname === "/s59") return send(key, S59_PAGE, "text/html; charset=utf-8");
      if (u.pathname === "/s59/worker.js") return send(key, S59_WORKER_JS, "text/javascript");
      if (u.pathname === "/api/enc") {
        const mode = u.searchParams.get("mode");
        if (mode === "bare") return send(key, S59_BARE_XOR, "text/plain; charset=utf-8");
        if (mode === "big") return send(key, JSON.stringify({ code: 0, data: s59Xor(s59BigPlain()) }), "application/json");
        const slot = u.searchParams.get("slot");
        if (mode === "mime") return send(key, S59_ENC_MIME, "application/json");
        if (mode === "noise") return send(key, slot === "2" ? S59_ENC_NOISE2 : S59_ENC_NOISE1, "application/json");
        if (mode === "linger") return send(key, S59_ENC_LINGER[slot === "3" ? 2 : slot === "2" ? 1 : 0] ?? S59_ENC_XOR, "application/json");
        if (mode === "race") return send(key, slot === "1" ? S59_ENC_RACE1 : slot === "2" ? S59_ENC_RACE2 : S59_ENC_XOR, "application/json");
        const body = mode === "webcrypto" ? (u.searchParams.get("slot") === "2" ? S59_ENC_GCM2 : S59_ENC_GCM) : S59_ENC_XOR;
        return send(key, body, "application/json");
      }
      if (u.pathname === "/api/plain") return send(key, S59_CONTROL, "application/json");
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.6-P: s60 fetch credentials (docs/05 s60)
// Origin A (the page) and origin B (its API) are two ports on 127.0.0.1:
// different origins, one site, so B's cookies ride on A's credentialed
// fetches. B's endpoints:
//   /s60/api/wild     Access-Control-Allow-Origin: * and no -Allow-Credentials
//                     (a credentialed read is blocked; omit reads it);
//   /s60/api/double   ACAO: <A> and Access-Control-Allow-Credentials sent twice
//                     ("true, true": blocked for a credentialed read);
//   /s60/api/private  ACAO: <A> + ACAC true; 200 only with the s60b cookie,
//                     401 without it;
//   /s60/api/login    sets the s60b cookie (ACAO <A> + ACAC true);
//   /s60/api/me       ACAO: *, the page's own call with Authorization.
// The page on A logs in on B (credentials include), then calls /s60/api/me
// with `Authorization: Bearer <S60_TOKEN>` and credentials omit, like the
// real site's withCredentials: false. The access log (every request's
// headers) is the oracle for which requests carried the cookie.
export const S60_TOKEN = "s60-bearer-4c1d9e7a";
export const S60_COOKIE = "s60b-session-91f2";
export const S60_WILD = JSON.stringify({ code: 0, endpoint: "wild", from: "s60-b" });
export const S60_DOUBLE = JSON.stringify({ code: 0, endpoint: "double" });
export const S60_PRIVATE = JSON.stringify({ code: 0, endpoint: "private", user: "s60-user" });
export const S60_NEED_COOKIE = JSON.stringify({ code: 401, error: "no s60b cookie" });
export const S60_ME = JSON.stringify({ code: 0, me: "s60-me-ok" });
export const S60_LOGIN = JSON.stringify({ code: 0, login: "s60-ok" });

const s60Page = (b: string) => `<!doctype html><meta charset=utf-8><title>s60 fetch credentials</title>
<h1>s60</h1><p id=s60-out>loading</p>
<script>
(async () => {
  const out = document.getElementById("s60-out");
  try {
    await fetch(${JSON.stringify(b)} + "/s60/api/login", { method: "POST", credentials: "include" });
    const r = await fetch(${JSON.stringify(b)} + "/s60/api/me", { headers: { Authorization: "Bearer " + ${JSON.stringify(S60_TOKEN)} }, credentials: "omit" });
    out.textContent = (await r.json()).me;
  } catch (e) {
    out.textContent = "s60 failed: " + e;
  }
})();
</script>`;

export type S60Hit = { origin: "a" | "b"; method: string; path: string; headers: Record<string, string> };
export type CredSite = { a: string; b: string; log: S60Hit[]; served: Map<string, string>; stop: () => void };

export function startCredSite(): CredSite {
  const log: S60Hit[] = [];
  const served = new Map<string, string>();
  const note = (origin: "a" | "b", req: Request): URL => {
    const u = new URL(req.url);
    log.push({ origin, method: req.method, path: u.pathname, headers: Object.fromEntries(req.headers) });
    return u;
  };
  let aOrigin = "";
  const b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = note("b", req);
      const p = u.pathname;
      const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      const send = (body: string, status = 200) => {
        served.set(`b${p}`, body);
        return new Response(body, { status, headers: h });
      };
      const exact = () => {
        h.set("access-control-allow-origin", aOrigin);
        h.set("access-control-allow-credentials", "true");
        h.set("vary", "origin");
      };
      if (p === "/s60/api/me") {
        h.set("access-control-allow-origin", "*");
        if (req.method === "OPTIONS") {
          h.set("access-control-allow-headers", "authorization");
          h.set("access-control-allow-methods", "GET");
          return new Response(null, { status: 204, headers: h });
        }
        return send(S60_ME);
      }
      if (p === "/s60/api/wild") {
        h.set("access-control-allow-origin", "*");
        return send(S60_WILD);
      }
      if (p === "/s60/api/double") {
        h.set("access-control-allow-origin", aOrigin);
        h.append("access-control-allow-credentials", "true");
        h.append("access-control-allow-credentials", "true");
        return send(S60_DOUBLE);
      }
      if (p === "/s60/api/login") {
        exact();
        h.append("set-cookie", `s60b=${S60_COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
        return send(S60_LOGIN);
      }
      if (p === "/s60/api/private") {
        exact();
        const has = /(?:^|;\s*)s60b=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] === S60_COOKIE;
        return has ? send(S60_PRIVATE) : send(S60_NEED_COOKIE, 401);
      }
      return new Response("nf", { status: 404 });
    },
  });
  const bOrigin = `http://127.0.0.1:${b.port}`;
  const a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = note("a", req);
      if (u.pathname === "/s60") return new Response(s60Page(bOrigin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      return new Response("nf", { status: 404 });
    },
  });
  aOrigin = `http://127.0.0.1:${a.port}`;
  return {
    a: aOrigin,
    b: bOrigin,
    log,
    served,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}

// ---------------------------------------------------------------- 0.7.1-A: s62 human take-over (docs/05 s62)
// A button, a text box, a "ping" button (its click fetches /s62/ping, which the
// server counts) and a 300-row list (the page scrolls). The page logs what
// reaches its own handlers in window.__s62 ("btn:<isTrusted>", "key:<isTrusted>")
// and, from load on, fires a round of untrusted events every 200 ms on the
// button: dispatchEvent pointerdown / keydown / wheel / touchstart and
// el.click() (rounds in window.__s62synth). The top-left corner (4, 4) is
// empty page margin. Oracle: the page's own log and the server's ping count.
export const S62_BTN = "S62 button";
export const S62_PING = "S62 ping";

const S62_PAGE = `<!doctype html><meta charset=utf-8><title>s62 take-over</title>
<style>body{margin:0;padding:60px 20px 20px}#s62-list{margin-top:24px}</style>
<h1>s62</h1>
<button id=s62-btn type=button>${S62_BTN}</button>
<input id=s62-in aria-label="s62 text" autocomplete=off>
<button id=s62-ping type=button>${S62_PING}</button>
<ul id=s62-list>${Array.from({ length: 300 }, (_, i) => `<li>s62 row ${i + 1}</li>`).join("")}</ul>
<script>
window.__s62 = [];
window.__s62synth = 0;
const btn = document.getElementById("s62-btn");
btn.addEventListener("click", (e) => { if (window.__s62synthRunning !== true) window.__s62.push("btn:" + e.isTrusted); });
document.getElementById("s62-in").addEventListener("keydown", (e) => window.__s62.push("key:" + e.isTrusted));
document.getElementById("s62-ping").addEventListener("click", () => { fetch("/s62/ping", { cache: "no-store" }).then((r) => r.text()); });
setInterval(() => {
  window.__s62synthRunning = true;
  btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  btn.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
  btn.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 }));
  btn.dispatchEvent(new Event("touchstart", { bubbles: true }));
  btn.click();
  window.__s62synthRunning = false;
  window.__s62synth++;
}, 200);
</script>`;

export type TakeoverSite = Site & { pings: () => number };

export function startTakeoverSite(): TakeoverSite {
  let pings = 0;
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/s62") return new Response(S62_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (u.pathname === "/s62/ping") {
        pings++;
        return new Response(JSON.stringify({ ping: pings }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, served: new Map(), hits, stop: () => server.stop(true), pings: () => pings };
}

// ---------------------------------------------------------------- 0.7.5: list end and handoff conditions (docs/05 s64–s65)
// One origin. Every code, cookie and path a test expects is a literal here or
// in `api` / `done` (what the range really answered), never tabcap's output.
//   /s64              s64 list-end: a "下一页" button whose click fetches
//                     /s64/api?page=<n> (n = 1, 2, …) and reads the body.
//   /s64/api?page=N   N 1–3: {"code":0,"items":[…]}; N ≥ 4: {"code":203,
//                     "msg":"no more"}; page=bad: {"code":500,"msg":"boom"};
//                     all HTTP 200; `api` logs each (page, code) by arrival.
//   /s65/login?k=K    s65 login-done: text S65_LOGIN_PAGE and a button
//                     S65_GO fixed at the viewport's top-left (0,0, 240 × 80
//                     px: e2e.human-input presses (4, 4)); its click goes to
//                     /s65/done?k=K 1500 ms later, unless &stay=1.
//   /s65/done?k=K     302 to /s65/home?k=K with Set-Cookie s65_K=1; logged in `done`.
//   /s65/home?k=K     text S65_WELCOME.

export const S64_END_CODE = 203;

export type HandoffSite = { origin: string; api: Array<{ page: string; code: number }>; done: string[]; stop: () => void };

export function startHandoffSite(): HandoffSite {
  const api: Array<{ page: string; code: number }> = [];
  const done: string[] = [];
  const html = (body: string) => new Response(`<!doctype html><meta charset=utf-8>${body}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const k = (u.searchParams.get("k") ?? "x").replace(/[^a-z0-9]/g, "");
      if (p === "/favicon.ico") return new Response(null, { status: 204 });
      if (p === "/s64")
        return html(`<title>s64 list end</title>
<button type=button id=s64-next>下一页</button> <span id=s64-out></span>
<script>
let n = 0;
document.getElementById("s64-next").addEventListener("click", () => {
  n += 1;
  const page = n;
  fetch("/s64/api?page=" + page, { cache: "no-store" }).then((r) => r.json()).then((j) => { document.getElementById("s64-out").textContent = "p" + page + "=" + j.code; });
});
</script>`);
      if (p === "/s64/api") {
        const page = u.searchParams.get("page") ?? "";
        const n = Number(page);
        const body = page === "bad" ? { code: 500, msg: "boom" } : Number.isInteger(n) && n >= 4 ? { code: S64_END_CODE, msg: "no more" } : { code: 0, items: [`item-${page}-a`, `item-${page}-b`] };
        api.push({ page, code: body.code });
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      }
      if (p === "/s65/login") {
        const stay = u.searchParams.get("stay") === "1";
        return html(`<title>s65 login</title>
<style>body { margin: 0; } #s65-go { position: fixed; left: 0; top: 0; width: 240px; height: 80px; margin: 0; }</style>
<button type=button id=s65-go>S65_GO</button>
<p style="margin-top: 120px">S65_LOGIN_PAGE</p>
<script>
document.getElementById("s65-go").addEventListener("click", () => {
  ${stay ? "" : `setTimeout(() => { location.href = "/s65/done?k=${k}"; }, 1500);`}
});
</script>`);
      }
      if (p === "/s65/done") {
        done.push(k);
        return new Response(null, { status: 302, headers: { location: `/s65/home?k=${k}`, "set-cookie": `s65_${k}=1; Path=/`, "cache-control": "no-store" } });
      }
      if (p === "/s65/home") return html(`<title>s65 home</title><p>S65_WELCOME</p>`);
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, api, done, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.7.6-A: s66 webdriver (docs/05 s66)
// The page and its iframe each report navigator.webdriver and whether
// Navigator.prototype's webdriver getter is still native, by fetching
// /s66/report. Oracle: the server's log of reports, in arrival order.
export type S66Report = { where: string; webdriver: string; native: string };
export type WebdriverSite = { origin: string; reports: S66Report[]; stop: () => void };

const S66_REPORT = (where: string) => `<script>
const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver");
const native = d !== undefined && typeof d.get === "function" && Function.prototype.toString.call(d.get).includes("[native code]");
fetch("/s66/report?where=${where}&webdriver=" + String(navigator.webdriver) + "&native=" + String(native));
</script>`;
const S66_PAGE = `<!doctype html><meta charset=utf-8><title>s66 webdriver</title><h1>s66</h1><iframe src="/s66/frame"></iframe>${S66_REPORT("main")}`;
const S66_FRAME = `<!doctype html><meta charset=utf-8>${S66_REPORT("frame")}`;

export function startWebdriverSite(): WebdriverSite {
  const reports: S66Report[] = [];
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/s66") return html(S66_PAGE);
      if (u.pathname === "/s66/frame") return html(S66_FRAME);
      if (u.pathname === "/s66/report") {
        const q = u.searchParams;
        reports.push({ where: q.get("where") ?? "", webdriver: q.get("webdriver") ?? "", native: q.get("native") ?? "" });
        return new Response("ok", { headers: { "cache-control": "no-store" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, reports, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.8.1-A: s71 custom Chrome args (docs/05 s71)
// The page reports navigator.userAgent and navigator.webdriver by fetching
// /s71/report; the server adds that request's User-Agent header. Oracle: the
// server's log of reports, in arrival order.
export type S71Report = { header: string; ua: string; webdriver: string };
export type ChromeArgsSite = { origin: string; reports: S71Report[]; stop: () => void };

const S71_PAGE = `<!doctype html><meta charset=utf-8><title>s71 chrome args</title><h1>s71</h1><script>
fetch("/s71/report?ua=" + encodeURIComponent(navigator.userAgent) + "&webdriver=" + String(navigator.webdriver));
</script>`;

export function startChromeArgsSite(): ChromeArgsSite {
  const reports: S71Report[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/s71") return new Response(S71_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (u.pathname === "/s71/report") {
        reports.push({ header: req.headers.get("user-agent") ?? "", ua: u.searchParams.get("ua") ?? "", webdriver: u.searchParams.get("webdriver") ?? "" });
        return new Response("ok", { headers: { "cache-control": "no-store" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, reports, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.8-A: s67–s70 protection families (docs/05 §17)
// One server for all four scenarios. Pages and stubs are our own; only NAMES
// (cookie names, host names, globals, class names) match the families of
// docs/14 — no vendor code. Vendor hosts are written as http://<host>:<port>/…
// and reach this server through test/e2e/fwdproxy.ts (the browser runs with
// --proxy <fwdproxy>); every scenario page also lives on its own made-up host
// so cookies of one page never show up on another. Oracle: `hits` (path and
// Host header of each request, in order).
export type ProtectionSite = { port: number; at: (host: string, path: string) => string; hits: { path: string; host: string }[]; stop: () => void };

export function startProtectionSite(): ProtectionSite {
  const hits: { path: string; host: string }[] = [];
  let port = 0;
  const html = (body: string, init: { status?: number; cookies?: string[] } = {}) => {
    const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    for (const c of init.cookies ?? []) h.append("set-cookie", `${c}; Path=/`);
    return new Response(`<!doctype html><meta charset=utf-8>${body}`, { status: init.status ?? 200, headers: h });
  };
  const js = (body: string) => new Response(body, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
  const vendor = (host: string, path: string) => `http://${host}:${port}${path}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ path: u.pathname, host: (req.headers.get("host") ?? "").replace(/:\d+$/, "") });
      switch (u.pathname) {
        // s67: passive (L1)
        case "/s67/datadome":
          return html(`<h1>s67 datadome</h1><script src="${vendor("js.datadome.co", "/tags.js")}"></script>`, { cookies: ["datadome=AbCdEf0123456789AbCdEf0123456789"] });
        case "/s67/akamai":
          return html(`<h1>s67 akamai</h1>`, { cookies: ["_abck=0123456789ABCDEF0123456789ABCDEF~0~stub", "bm_sz=0123456789ABCDEF0123456789ABCDEF~stub"] });
        case "/s67/recaptcha":
          return html(`<h1>s67 recaptcha</h1><div class="g-recaptcha" data-sitekey="x"></div><script src="${vendor("www.google.com", "/recaptcha/api.js")}"></script>`);
        case "/s67/none":
          return html(`<h1>s67 none</h1><script>fetch("/cdn-cgi/trace")</script>`, { cookies: ["TS01ab12cd=1"] });
        case "/tags.js":
          return js("window.ddjskey = 'k';");
        case "/recaptcha/api.js":
          return js("window.grecaptcha = { render: function () {} };");
        case "/cdn-cgi/trace":
          return new Response("ok", { headers: { "cache-control": "no-store" } });
        // s68: page (L2); the ddjskey getter would report itself if anything called it
        case "/s68":
          return html(`<h1>s68</h1><div class="cf-turnstile" data-sitekey="y"></div><iframe src="${vendor("geo.captcha-delivery.com", "/x")}"></iframe><script src="/s68/stub.js"></script>`);
        case "/s68/stub.js":
          return js(`window.initGeetest4 = function () {}; window._dx = { Captcha: function () {} };
Object.defineProperty(window, "ddjskey", { configurable: true, get: function () { fetch("/s68/getter-ran"); return "k"; } });`);
        case "/x":
          return html("<p>frame</p>");
        case "/s68/getter-ran":
          return new Response("ran", { headers: { "cache-control": "no-store" } });
        // s69: trace (L3); the stub reads canvas, WebGL and hardware signals
        case "/s69":
          return html(`<h1>s69</h1><script src="${vendor("h.online-metrix.net", "/fp/tags.js")}"></script>`);
        case "/fp/tags.js":
          return js(`(function () {
  var c = document.createElement("canvas"); c.width = 16; c.height = 16;
  var x = c.getContext("2d"); x.fillText("s69", 1, 10); c.toDataURL(); x.getImageData(0, 0, 4, 4);
  var g = document.createElement("canvas").getContext("webgl"); if (g) g.getParameter(g.VERSION);
  window.__s69webgl = !!g;
  void navigator.hardwareConcurrency;
  window.__s69 = "done";
})();`);
        // s70: challenge pages (guard + family)
        case "/s70/cf":
          return html(`<h1>Just a moment</h1>`, { status: 403, cookies: ["__cf_bm=stubvalue"] });
        case "/s70/jsl":
          if ((req.headers.get("cookie") ?? "").includes("__jsl_clearance=")) return html(`<h1>s70 jsl ok</h1>`);
          return html(`<script>document.cookie = "__jsl_clearance=1; path=/"; location.reload();</script>`, { status: 521, cookies: ["__jsluid_h=0123456789abcdef"] });
        default:
          return new Response("nf", { status: 404 });
      }
    },
  });
  port = server.port ?? 0;
  return { port, at: (host, path) => `http://${host}:${port}${path}`, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- 0.9-A: s72 navigation status (docs/05 s72)
// Two origins A and B serve the same /s72/* routes. The server logs, in arrival
// order, each request's path and the status it answered (oracle). Chrome's own
// requests (/favicon.ico) are logged too: the test looks at /s72/ paths.
//   /s72/ok 200, /s72/missing 404, /s72/boom 500, /s72/partial 203,
//   /s72/moved 302 → /s72/missing, /s72/away 302 → B's /s72/ok,
//   /s72/js 200 whose script location.replace()s to /s72/missing; it also
//   holds an image (/hold, answered after 2 s, outside /s72/ so it is not in
//   the oracle) so this document is still loading when the replacement
//   commits: the document the tab shows is then the 404 one, not a race
//   between the first document reaching "complete" and the replacement,
//   /s72/empty 204 (no new document), /s72/forge 200 whose script makes the
//   MAIN world's performance.getEntriesByType("navigation") say 299,
//   any other /s72/ path 404 (including the pushState URL /s72/pushed).
export type S72Hit = { origin: "a" | "b"; path: string; status: number };
export type NavStatusSite = { a: string; b: string; log: S72Hit[]; stop: () => void };

const S72_PAGE = (title: string, extra = "") => `<!doctype html><meta charset=utf-8><title>${title}</title><h1>${title}</h1>${extra}`;
const S72_FORGE = `<script>
const real = performance.getEntriesByType.bind(performance);
performance.getEntriesByType = (type) => (type === "navigation" ? [{ name: location.href, entryType: "navigation", responseStatus: 299 }] : real(type));
</script>`;

export function startNavStatusSite(): NavStatusSite {
  const log: S72Hit[] = [];
  let bOrigin = "";
  const handler = (which: "a" | "b") => async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (p === "/hold") {
      await Bun.sleep(2000);
      return new Response(null, { status: 204 });
    }
    const reply = (status: number, body: string | null, headers: Record<string, string> = {}): Response => {
      log.push({ origin: which, path: p, status });
      return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
    };
    switch (p) {
      case "/s72/ok":
        return reply(200, S72_PAGE("s72 ok"));
      case "/s72/missing":
        return reply(404, S72_PAGE("s72 missing"));
      case "/s72/boom":
        return reply(500, S72_PAGE("s72 boom"));
      case "/s72/partial":
        return reply(203, S72_PAGE("s72 partial"));
      case "/s72/moved":
        return reply(302, null, { location: "/s72/missing" });
      case "/s72/away":
        return reply(302, null, { location: `${bOrigin}/s72/ok` });
      case "/s72/js":
        return reply(200, S72_PAGE("s72 js", `<img src="/hold" alt=""><script>location.replace("/s72/missing");</script>`));
      case "/s72/empty":
        return reply(204, null);
      case "/s72/forge":
        return reply(200, S72_PAGE("s72 forge", S72_FORGE));
      default:
        return reply(404, S72_PAGE("s72 nothing here"));
    }
  };
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler("b") });
  bOrigin = `http://127.0.0.1:${b.port}`;
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler("a") });
  return {
    a: `http://127.0.0.1:${a.port}`,
    b: bOrigin,
    log,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}

// ---------------------------------------------------------------- 0.9-B: s73 permissions (docs/05 s73)
// Two origins A and B serve the same pages. /s73: window.s73State() asks the
// page's own world for navigator.permissions.query of five names and answers
// the table (oracle: what the page itself sees). /s73/geo: window.s73Geo() is
// getCurrentPosition's outcome with an outer 4 s timeout ({hung:true} when
// Chrome never answered), and a button #go that writes that outcome into #out.
export const S73_NAMES = ["geolocation", "notifications", "clipboard-read", "camera", "midi"] as const;
export type PermissionSite = { a: string; b: string; stop: () => void };

const S73_PAGE = `<!doctype html><meta charset=utf-8><title>s73 permissions</title><h1>s73</h1><script>
window.s73State = async () => {
  const out = {};
  for (const name of ${JSON.stringify(S73_NAMES)}) {
    try { out[name] = (await navigator.permissions.query({ name })).state; } catch (e) { out[name] = "error: " + e.message; }
  }
  return out;
};
</script>`;

const S73_GEO = `<!doctype html><meta charset=utf-8><title>s73 geolocation</title><h1>s73 geo</h1>
<button id=go>locate</button><pre id=out></pre><script>
window.s73Geo = () => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ hung: true }), 4000);
  navigator.geolocation.getCurrentPosition(
    (p) => { clearTimeout(timer); resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
    (e) => { clearTimeout(timer); resolve({ error: e.code, message: e.message }); },
  );
});
document.getElementById("go").addEventListener("click", async () => { document.getElementById("out").textContent = JSON.stringify(await window.s73Geo()); });
</script>`;

export function startPermissionSite(): PermissionSite {
  const fetchPage = (req: Request): Response => {
    const p = new URL(req.url).pathname;
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (p === "/s73") return html(S73_PAGE);
    if (p === "/s73/geo") return html(S73_GEO);
    return new Response("nf", { status: 404 });
  };
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchPage });
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchPage });
  return {
    a: `http://127.0.0.1:${a.port}`,
    b: `http://127.0.0.1:${b.port}`,
    stop: () => {
      a.stop(true);
      b.stop(true);
    },
  };
}
