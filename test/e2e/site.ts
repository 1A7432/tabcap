// Tiny local site for L2 tests and for capturing fixtures/ax. Serves fixed
// bytes and remembers them, so tests compare sha256 of what was really served.

import { createHash } from "node:crypto";
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
