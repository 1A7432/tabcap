// 0.6-F session export (src/daemon/tools/sessionexport.ts): header selection,
// storage size cap, file mode, rendering of the three formats.
// Oracles: the selection rule as the owner wrote it (2026-10-16: authorization,
// *-token, *-auth*, x-csrf*, x-xsrf*, api-key, the `bundle redact` header rule,
// plus any header the page set that is not a browser default; cookie apart);
// Playwright storageState for --for playwright; for the Python side, what a
// local HTTP server (127.0.0.1) actually receives from the generated client.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import PYPROJECT from "../../templates/python/pyproject.toml" with { type: "text" };
import SESSION_HELPER from "../../templates/python/_tabcap_session.py" with { type: "text" };
import {
  EXPORT_SCHEMA,
  STORAGE_VALUE_MAX,
  exportPath,
  exportSummary,
  headerClass,
  headerSource,
  mergeCookies,
  renderHttpx,
  renderPlaywright,
  renderRequests,
  selectHeaders,
  storageOf,
  writeSecretFile,
  type SessionData,
} from "../../src/daemon/tools/sessionexport.ts";
import { tmp } from "./_analyze.ts";
import { POSIX_MODES, SLOW_IO_MS, expectMode } from "./_platform.ts";
import { need, packageReason, pyCompile, runInPackageAsync, skipWithout, syncPackage } from "./_python.ts";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl";
const CSRF = "c5f1e0a9b7d24c6f";
const SID = "0f9e8d7c6b5a49382716";
const DATA: SessionData = {
  origin: "http://127.0.0.1:4310",
  capturedAt: 1760600000000,
  cookies: [
    { name: "sid", value: SID, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
    { name: "theme", value: 'da"rk\\', domain: "127.0.0.1", path: "/app", expires: 1790000000.5, httpOnly: false, secure: false, sameSite: "Strict" },
  ],
  headers: { authorization: `Bearer ${TOKEN}`, "x-csrf": CSRF },
  storage: { localStorage: { access_token: TOKEN, "line\nbreak": "ü €" }, sessionStorage: { tab: "1" } },
  source: { headers: "r-7" },
};

let root = "";
beforeAll(() => {
  root = tmp("tabcap-sexp-");
});
afterAll(() => rmSync(root, { recursive: true, force: true }), SLOW_IO_MS);

describe("header selection", () => {
  test.each([
    ["Authorization", "sensitive"],
    ["access-token", "sensitive"],
    ["x-auth-token", "sensitive"],
    ["x-auth-user", "sensitive"],
    ["x-csrf", "sensitive"],
    ["x-csrf-token", "sensitive"],
    ["x-xsrf-token", "sensitive"],
    ["api-key", "sensitive"],
    ["x-api-key", "sensitive"],
    ["x-session-id", "sensitive"],
    ["x-client-build", "page"],
    ["x-requested-with", "page"],
    ["x-tenant", "page"],
    ["cookie", "cookie"],
    ["proxy-authorization", "proxy"],
    ["user-agent", "browser"],
    ["accept", "browser"],
    ["accept-language", "browser"],
    ["referer", "browser"],
    ["origin", "browser"],
    ["content-type", "browser"],
    ["content-length", "browser"],
    ["sec-ch-ua", "browser"],
    ["sec-fetch-mode", "browser"],
    ["priority", "browser"],
    ["cache-control", "browser"],
    ["upgrade-insecure-requests", "browser"],
    [":authority", "browser"],
  ])("%s → %s", (name, want) => {
    expect(headerClass(name) as string).toBe(want);
  });

  test("selectHeaders keeps sensitive and page headers, lowercase, repeated values joined", () => {
    const h = { Authorization: `Bearer ${TOKEN}`, "x-csrf": CSRF, "x-trace": ["a", "b"], cookie: `sid=${SID}`, "user-agent": "UA", accept: "*/*", "proxy-authorization": "Basic eDp5" };
    expect(selectHeaders(h)).toEqual({ authorization: `Bearer ${TOKEN}`, "x-csrf": CSRF, "x-trace": "a, b" });
    expect(selectHeaders(null)).toEqual({});
    expect(selectHeaders({ "x-n": 5 })).toEqual({});
  });

  test("headerSource: the latest request to the host that carries a selected header; other hosts and ports, torn lines ignored", () => {
    const ev = (id: string, url: string, headers: Record<string, string>) => JSON.stringify({ seq: Number(id.slice(2)), kind: "request", id, url, request: { headers } });
    const lines = [
      ev("r-1", "http://127.0.0.1:4310/s07/login", { accept: "text/html", "user-agent": "UA" }),
      ev("r-2", "http://127.0.0.1:4310/api/data", { authorization: "Bearer old", "x-csrf": "old" }),
      ev("r-3", "http://127.0.0.1:4310/api/data", { authorization: `Bearer ${TOKEN}`, "x-csrf": CSRF, accept: "*/*" }),
      ev("r-4", "http://127.0.0.1:9999/api/data", { authorization: "Bearer other-port" }),
      ev("r-5", "http://localhost:4310/api/data", { authorization: "Bearer other-host" }),
      ev("r-6", "http://127.0.0.1:4310/favicon.ico", { accept: "image/*" }),
      JSON.stringify({ seq: 7, kind: "cmd", id: "c-7" }),
      '{"seq":8,"kind":"request","id":"r-8","url":"http://127.0.0.1:4310/x","request":{"headers":{"authorization":"torn',
    ];
    expect(headerSource(lines, "127.0.0.1:4310")).toEqual({ id: "r-3", url: "http://127.0.0.1:4310/api/data", headers: { authorization: `Bearer ${TOKEN}`, "x-csrf": CSRF } });
    expect(headerSource(lines, "127.0.0.1:9999")?.id).toBe("r-4");
    // only requests without a selected header: the latest one, no headers
    expect(headerSource([lines[0] ?? "", lines[5] ?? ""], "127.0.0.1:4310")).toEqual({ id: "r-6", url: "http://127.0.0.1:4310/favicon.ico", headers: {} });
    expect(headerSource(lines, "example.com")).toBeNull();
    expect(headerSource([], "127.0.0.1:4310")).toBeNull();
  });
});

describe("storage", () => {
  test("values over 64 KB (UTF-8 bytes) are skipped and listed, whatever the page claims", () => {
    expect(STORAGE_VALUE_MAX).toBe(65536);
    const at = "a".repeat(65536);
    const over = "a".repeat(65537);
    const euro = "€".repeat(21846); // 21846 UTF-16 units, 65538 bytes
    const r = storageOf({
      items: [
        ["at", at, 1],
        ["over", over, 1],
        ["euro", euro, 3],
        ["big", null, 900000],
        ["__proto__", "p"],
        [5, "bad key"],
        "junk",
        ["k", 7],
      ],
    });
    expect(Object.keys(r.items)).toEqual(["at", "__proto__"]);
    expect(r.items["at"]?.length).toBe(65536);
    expect(Object.getPrototypeOf(r.items)).toBe(Object.prototype);
    expect(r.skipped).toEqual([
      { key: "over", bytes: 65537 },
      { key: "euro", bytes: 65538 },
      { key: "big", bytes: 900000 },
    ]);
    expect(r.error).toBeNull();
  });

  test("an unreadable storage (opaque origin, SecurityError) and a malformed answer are reported, not thrown", () => {
    expect(storageOf({ error: "SecurityError" })).toEqual({ items: {}, skipped: [], error: "SecurityError" });
    expect(storageOf(null).error).toBe("no answer");
    expect(storageOf({ items: "x" })).toEqual({ items: {}, skipped: [], error: null });
  });
});

describe("cookies", () => {
  test("merged across CDP answers on name + domain + path, later wins; unusable ones dropped", () => {
    const a = [{ name: "sid", value: "1", domain: "127.0.0.1", path: "/", expires: -1, session: true, sameSite: "Lax" }, { name: "", value: "x", domain: "d" }];
    const b = [{ name: "sid", value: "2", domain: "127.0.0.1", path: "/", httpOnly: true }, { name: "acct", value: "z", domain: ".example.com", path: "/", expires: 1790000000 }];
    expect(mergeCookies([a, b])).toEqual([
      { name: "sid", value: "2", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
      { name: "acct", value: "z", domain: ".example.com", path: "/", expires: 1790000000, httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
  });
});

describe("files", () => {
  test("0600 file, new directories 0700; a wider existing file becomes 0600; a directory is refused", () => {
    const f = join(root, "new", "deeper", "session.json");
    writeSecretFile(f, "{}\n");
    expectMode(f, 0o600);
    expectMode(join(root, "new"), 0o700);
    expectMode(join(root, "new", "deeper"), 0o700);
    const wide = join(root, "wide.json");
    writeFileSync(wide, "x", { mode: 0o644 });
    writeSecretFile(wide, "{}\n");
    expectMode(wide, 0o600);
    expect(readFileSync(wide, "utf8")).toBe("{}\n");
    mkdirSync(join(root, "adir"));
    expect(() => writeSecretFile(join(root, "adir"), "{}")).toThrow(/is a directory/);
    expect(POSIX_MODES || process.platform === "win32").toBe(true);
  });

  test("--for httpx adds .py when missing", () => {
    expect(exportPath(join(root, "s"), "httpx")).toBe(join(root, "s.py"));
    expect(exportPath(join(root, "s.py"), "httpx")).toBe(join(root, "s.py"));
    expect(exportPath(join(root, "s"), "requests")).toBe(join(root, "s"));
  });
});

describe("rendering", () => {
  test("--for requests: schema tabcap-session-export/0 with origin, capturedAt, cookies, headers, storage, note", () => {
    const doc: unknown = JSON.parse(renderRequests(DATA));
    expect(doc).toEqual({
      schema: EXPORT_SCHEMA,
      origin: DATA.origin,
      capturedAt: DATA.capturedAt,
      cookies: DATA.cookies,
      headers: DATA.headers,
      storage: DATA.storage,
      note: expect.stringContaining("headers from recorded request r-7"),
    });
    const none: unknown = JSON.parse(renderRequests({ ...DATA, headers: {}, source: { headers: "none" } }));
    expect(none).toMatchObject({ headers: {}, note: expect.stringContaining("tabcap net start") });
  });

  test("--for playwright: the storageState shape of `replay session` (no headers, no sessionStorage)", () => {
    expect(JSON.parse(renderPlaywright(DATA))).toEqual({
      cookies: DATA.cookies,
      origins: [
        {
          origin: DATA.origin,
          localStorage: [
            { name: "access_token", value: TOKEN },
            { name: "line\nbreak", value: "ü €" },
          ],
        },
      ],
    });
  });

  test("the envelope has the path, counts and header names, never a value", () => {
    const all = [TOKEN, CSRF, SID, "ü €"];
    const r = exportSummary("requests", "/x/session.json", DATA, [{ storage: "localStorage", key: "blob", bytes: 70000 }], []);
    expect(r).toMatchObject({ file: "/x/session.json", for: "requests", origin: DATA.origin, mode: "0600", cookies: 2, headers: ["authorization", "x-csrf"], storage: { localStorage: 2, sessionStorage: 1 }, source: { headers: "r-7" } });
    for (const v of all) expect(JSON.stringify(r)).not.toContain(v);
    const p = exportSummary("playwright", "/x/state.json", DATA, [], []);
    expect(p).toMatchObject({ headers: [], storage: { localStorage: 2, sessionStorage: 0 }, omitted: { headers: ["authorization", "x-csrf"], sessionStorage: 1 } });
    for (const v of all) expect(JSON.stringify(p)).not.toContain(v);
  });

  test("--for httpx: the module and _tabcap_session.py compile (py_compile through uv)", () => {
    const dir = join(root, "py-compile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "example_session.py"), renderHttpx(DATA));
    writeFileSync(join(dir, "_tabcap_session.py"), SESSION_HELPER);
    expect(pyCompile([join(dir, "example_session.py"), join(dir, "_tabcap_session.py")])).toBeNull();
    const src = readFileSync(join(dir, "example_session.py"), "utf8");
    expect(src).toContain("def client(base_url: str = ORIGIN");
    // values only as escaped literals, never pasted into code or comments
    expect(src).toContain(`"theme": "da\\"rk\\\\"`);
    expect(src).toContain(`"line\\nbreak": "ü €"`);
  });

  const PY = packageReason();
  test.skipIf(skipWithout(PY, "session-export httpx client run"))(
    "--for httpx module and _tabcap_session.load/client send the cookies (by domain and path) and headers to a local server",
    async () => {
      need(PY);
      const dir = join(root, "py-run");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pyproject.toml"), PYPROJECT.replace(/\{\{\w+\}\}/g, "tabcap-sexp"));
      need(syncPackage(dir));
      const seen: { path: string; cookie: string | null; authorization: string | null; csrf: string | null }[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          seen.push({ path: new URL(req.url).pathname, cookie: req.headers.get("cookie"), authorization: req.headers.get("authorization"), csrf: req.headers.get("x-csrf") });
          return new Response("ok");
        },
      });
      try {
        const origin = `http://127.0.0.1:${server.port}`;
        const data = { ...DATA, origin, cookies: DATA.cookies.map((c) => (c.name === "theme" ? { ...c, value: "dark" } : c)) };
        writeFileSync(join(dir, "example_session.py"), renderHttpx(data));
        writeFileSync(join(dir, "_tabcap_session.py"), SESSION_HELPER);
        writeFileSync(join(dir, "session.json"), renderRequests(data));
        writeFileSync(
          join(dir, "run.py"),
          [
            "import example_session, _tabcap_session",
            "with example_session.client() as c:",
            '    assert c.get("/api/data").status_code == 200',
            '    assert c.get("/app/x").status_code == 200',
            'assert example_session.storage["localStorage"]["access_token"].startswith("eyJ")',
            's = _tabcap_session.load("session.json")',
            "with _tabcap_session.client(s) as c:",
            '    assert c.get("/api/data").status_code == 200',
            'print("ok")',
          ].join("\n"),
        );
        const r = await runInPackageAsync(dir, ["python", "run.py"]);
        expect([r.code, r.err.trim(), r.out.trim()]).toEqual([0, "", "ok"]);
      } finally {
        server.stop(true);
      }
      expect(seen).toEqual([
        { path: "/api/data", cookie: `sid=${SID}`, authorization: `Bearer ${TOKEN}`, csrf: CSRF },
        { path: "/app/x", cookie: expect.stringMatching(new RegExp(`^(sid=${SID}; theme=dark|theme=dark; sid=${SID})$`)), authorization: `Bearer ${TOKEN}`, csrf: CSRF },
        { path: "/api/data", cookie: `sid=${SID}`, authorization: `Bearer ${TOKEN}`, csrf: CSRF },
      ]);
    },
    120_000,
  );
});
