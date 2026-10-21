// 0.6-G `analyze shape` / `analyze schema-diff`: inference table, unions,
// formats, enums (with the redaction name rule), bounds, decode chain and
// decode plugin views, grouping by recon's path template, and the diff table.
// Oracle: the JSON values written in each test (their kinds and formats read
// off by hand), the s06 /api/list bodies and LIST_DRIFT of test/e2e/site.ts,
// and the s42 plaintexts (test/e2e/site.ts) behind the xor-decode plugin.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { decodeBundle } from "../../src/bundle/decode.ts";
import { DecodeHost, DecodeSession } from "../../src/daemon/hooks/decode.ts";
import { decodePlugins } from "../../src/daemon/hooks/plugins.ts";
import { MAX_ARRAY_ITEMS, MAX_FIELDS, MAX_SHAPE_DEPTH, diffEndpoint, flatOf, inferShape, parseShapeTypes, schemaDiff, shape, stringFormat, typeText, type EndpointShape, type Shape } from "../../src/analyze/shape.ts";
import { runCommand } from "../../src/cli/main.ts";
import { isRecord } from "../../src/shared/json.ts";
import { LIST_DRIFT, LIST_V1, LIST_V2, S42_ITEMS_JSON } from "../e2e/site.ts";
import { b64, buildBundle, tmp } from "./_analyze.ts";
import { installXor, s42Bundle } from "./_decode.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const dir = (p: string): string => {
  const r = tmp("tabcap-shape-");
  roots.push(r);
  return join(r, p);
};
const O = "http://127.0.0.1:4310";
const C = 1760600000000;

const field = (s: Shape | null, name: string) => s?.fields?.[name];

describe("inference table", () => {
  test("kinds, number formats, presence counts and optional", () => {
    const s = inferShape([
      { a: 1, b: "x", c: true, d: null, e: 1.5, f: [1, 2], g: { h: "y" } },
      { a: 2, c: false, d: null, e: 2, f: [], g: { h: "z" } },
    ]);
    expect(s?.kind).toBe("object");
    expect(field(s, "a")).toEqual({ type: { kind: "number", format: "int" }, optional: false, samples: 2 });
    expect(field(s, "b")).toEqual({ type: { kind: "string" }, optional: true, samples: 1 });
    expect(field(s, "c")).toEqual({ type: { kind: "boolean" }, optional: false, samples: 2 });
    expect(field(s, "d")).toEqual({ type: { kind: "null" }, optional: false, samples: 2 });
    // int and float samples of one field: float
    expect(field(s, "e")?.type).toEqual({ kind: "number", format: "float" });
    expect(field(s, "f")?.type).toEqual({ kind: "array", items: { kind: "number", format: "int" } });
    expect(field(s, "g")?.type).toEqual({ kind: "object", fields: { h: { type: { kind: "string" }, optional: false, samples: 2 } } });
    expect(inferShape([])).toBeNull();
    expect(inferShape([[]])).toEqual({ kind: "array" });
  });

  test("union: one variant per kind, in fixed order; objects inside a union keep their fields", () => {
    const s = inferShape([{ a: 1 }, { a: "x" }, { a: null }, { a: { b: true } }, { a: [true] }]);
    const a = field(s, "a")?.type;
    expect(a?.kind).toBe("union");
    expect(a?.variants?.map((v) => v.kind)).toEqual(["object", "array", "string", "number", "null"]);
    expect(a?.variants?.[0]?.fields?.["b"]).toEqual({ type: { kind: "boolean" }, optional: false, samples: 1 });
    expect(typeText(a ?? { kind: "null" })).toBe("object|array|string|number(int)|null");
    // a top-level union (object or array documents)
    expect(inferShape([{ x: 1 }, [1]])?.variants?.map((v) => v.kind)).toEqual(["object", "array"]);
  });

  test("format table", () => {
    const rows: [string, string | null][] = [
      ["2026-10-16", "date"],
      ["2026-13-01", null],
      ["2026-10-16T09:00:00Z", "datetime"],
      ["2026-10-16T09:00:00.123+08:00", "datetime"],
      ["2026-10-16 09:00", "datetime"],
      ["42", "int"],
      ["-7", "int"],
      ["12.50", "float"],
      ["2026.10", "float"],
      ["0c8f3a5e-1b2d-4c6e-8f10-123456789abc", "id"],
      ["65a1f0c2e4b0d1a2b3c4d5e6", "id"],
      ["abcdefabcdefabcdef", null],
      ["ann@example.test", "email"],
      ["https://example.test/a?b=1", "url"],
      ["ftp://example.test/", null],
      ["Blue mug", null],
      ["", null],
    ];
    for (const [v, f] of rows) expect([v, stringFormat(v)]).toEqual([v, f]);
    // a format holds only when every sample has it
    expect(inferShape(["2026-10-16", "2026-10-17"])).toEqual({ kind: "string", format: "date" });
    expect(inferShape(["2026-10-16", "soon"])).toEqual({ kind: "string" });
  });

  test("enum: ≤ 8 short literals, each seen twice on average, never for formats or sensitive names", () => {
    const of = (name: string, vals: unknown[]) => field(inferShape(vals.map((v) => ({ [name]: v }))), name)?.type;
    expect(of("status", ["active", "sold", "active", "sold"])).toEqual({ kind: "string", enum: ["active", "sold"] });
    expect(of("status", ["已发货", "已发货"])).toEqual({ kind: "string", enum: ["已发货"] });
    // two samples, two values: free values, not an enum
    expect(of("status", ["active", "sold"])).toEqual({ kind: "string" });
    // more than 8 distinct
    const nine = Array.from({ length: 18 }, (_, i) => `s${i % 9}`);
    expect(of("status", nine)).toEqual({ kind: "string" });
    // whitespace: text, not a literal
    expect(of("title", ["Blue mug", "Blue mug"])).toEqual({ kind: "string" });
    // formatted strings carry their format, no literals
    expect(of("day", ["2026-10-16", "2026-10-16"])).toEqual({ kind: "string", format: "date" });
    // the redaction name rule hides literals of sensitive names
    for (const n of ["token", "sessionId", "authKind", "pwd", "api_key"]) expect([n, of(n, ["abc", "abc"])]).toEqual([n, { kind: "string" }]);
    // items of an array take the field's name
    expect(field(inferShape([{ tokens: ["a", "a", "a"] }]), "tokens")?.type).toEqual({ kind: "array", items: { kind: "string" } });
    expect(field(inferShape([{ tags: ["a", "a", "b", "b"] }]), "tags")?.type).toEqual({ kind: "array", items: { kind: "string", enum: ["a", "b"] } });
  });
});

describe("analyze shape over a bundle", () => {
  test("endpoints by recon's path template across exchanges; query names and request body fields; values never in the output", async () => {
    const b = await buildBundle(dir("b"), { name: "s", created: C, seed: 1 }, async (x) => {
      await x.request({ url: `${O}/`, type: "document", mime: "text/html", body: "<p>x</p>", ts: C + 1 });
      await x.request({ url: `${O}/app.js`, type: "script", mime: "text/javascript", body: "1", ts: C + 2 });
      await x.request({ url: `${O}/api/item/1?lang=en`, mime: "application/json", body: JSON.stringify({ id: 1, name: "Secret-Value-One", at: "2026-10-16T09:00:00Z" }), ts: C + 3 });
      await x.request({ url: `${O}/api/item/2`, mime: "application/json", body: JSON.stringify({ id: 2, name: "Secret-Value-Two", at: "2026-10-16T09:01:00Z", extra: true }), ts: C + 4 });
      await x.request({ url: `${O}/api/login`, method: "POST", mime: "application/json", reqHeaders: { "content-type": "application/x-www-form-urlencoded" }, postData: "user=ann&password=hunter2hunter2", body: '{"ok":true}', ts: C + 5 });
      await x.request({ url: `${O}/api/save`, method: "POST", mime: "application/json", reqHeaders: { "content-type": "application/json" }, postData: JSON.stringify({ items: [{ sku: "a1", qty: 2 }] }), body: '{"ok":true}', ts: C + 6 });
      await x.request({ url: `${O}/api/item/3`, mime: "text/html", body: "<html>login</html>", ts: C + 7 });
    });
    const r = shape(b);
    expect(r.schema).toBe("tabcap-shape/0");
    expect(r.endpoints.map((e) => e.key)).toEqual(["GET /api/item/{id}", "POST /api/login", "POST /api/save"]);
    // 0.6-S: the script is not an API-like exchange (default types xhr, fetch, document + JSON responses)
    expect(r.unshaped).toEqual(["GET /"]);
    expect(r.excluded).toEqual({ types: 1, incomplete: 0 });
    expect(r.filter).toMatchObject({ types: ["xhr", "fetch", "document"], json: true });
    expect(shape(b, { types: parseShapeTypes("all") }).unshaped).toEqual(["GET /", "GET /app.js"]);
    const item = r.endpoints[0];
    expect(item?.exchanges).toBe(3);
    expect(item?.requests).toEqual(["r-4", "r-5", "r-8"]);
    expect(item?.samples).toEqual({ query: 1, body: 0, response: 2 });
    expect(item?.notJson).toBe(1);
    expect([...(flatOf(item as EndpointShape).entries)].map(([p, e]) => `${p}:${e.type}${e.optional ? "?" : ""}`)).toEqual([
      "query:lang:string",
      "$:object",
      "$.id:number(int)",
      "$.name:string",
      "$.at:string(datetime)",
      "$.extra:boolean?",
    ]);
    const login = r.endpoints[1];
    expect(Object.keys(login?.request.body?.fields ?? {})).toEqual(["user", "password"]);
    expect(r.endpoints[2]?.request.body?.fields?.["items"]?.type.items?.fields?.["qty"]?.type).toEqual({ kind: "number", format: "int" });
    const out = JSON.stringify(r);
    for (const v of ["Secret-Value-One", "hunter2", "ann", "a1"]) expect(out.includes(v)).toBe(false);

    expect(shape(b, { template: "get /api/item/{id}" }).endpoints.map((e) => e.exchanges)).toEqual([3]);
    const one = shape(b, { request: "r-5" });
    expect(one.endpoints.map((e) => [e.key, e.exchanges, e.response?.fields?.["extra"]?.optional])).toEqual([["GET /api/item/{id}", 1, false]]);
    expect(() => shape(b, { template: "GET /nope" })).toThrow(/no endpoint GET \/nope/);
    expect(() => shape(b, { request: "r-99" })).toThrow(/no request r-99/);
    expect(() => shape(b, { template: "/api/item/{id}" })).toThrow(/METHOD/);
    expect(() => shape(b, { request: "r-4", template: "GET /x" })).toThrow(/exclude/);
  });

  test("decode chain: gzip, base64, jsonp, ndjson; the steps are reported", async () => {
    const doc = JSON.stringify({ a: 1 });
    const b = await buildBundle(dir("c"), { name: "s", created: C, seed: 2 }, async (x) => {
      await x.request({ url: `${O}/gz`, mime: "application/octet-stream", body: new Uint8Array(gzipSync(doc)), ts: C + 1 });
      await x.request({ url: `${O}/b64`, mime: "text/plain", body: b64(doc), ts: C + 2 });
      await x.request({ url: `${O}/jsonp`, mime: "application/javascript", type: "script", body: `cb(${doc});`, ts: C + 3 });
      await x.request({ url: `${O}/nd`, mime: "application/x-ndjson", body: `${doc}\n{"a":2}\n`, ts: C + 4 });
    });
    // the jsonp answer is a script: shaped with --types all (0.6-S)
    expect(shape(b).endpoints.map((e) => e.key)).toEqual(["GET /gz", "GET /b64", "GET /nd"]);
    const r = shape(b, { types: parseShapeTypes("all") });
    expect(r.endpoints.map((e) => [e.key, e.decode, typeText(e.response ?? { kind: "null" })])).toEqual([
      ["GET /gz", ["gzip"], "object"],
      ["GET /b64", ["base64"], "object"],
      ["GET /jsonp", ["json", "jsonp"], "object"],
      ["GET /nd", ["ndjson"], "array"],
    ]);
    expect(r.endpoints[3]?.response?.items?.fields?.["a"]?.samples).toBe(2);
  });

  test("decode plugin views: the plaintext is shaped, with the plugin step first", async () => {
    const root = tmp("tabcap-shape-dec-");
    roots.push(root);
    const config = join(root, "config");
    installXor(config);
    const plain = await s42Bundle(join(root, "plain"));
    const decoded = await s42Bundle(join(root, "decoded"));
    const host = new DecodeHost();
    try {
      await decodeBundle(decoded, new DecodeSession(host, decodePlugins(config)));
    } finally {
      await host.close();
    }
    // without the view nothing is JSON: the endpoints are only named
    const p = shape(plain);
    expect([p.endpoints, p.unshaped]).toEqual([[], ["GET /s42", "GET /s42/api/token", "GET /s42/api/items", "POST /s42/api/order"]]);
    const items = shape(decoded).endpoints.find((e) => e.key === "GET /s42/api/items");
    expect(items?.decode).toEqual(["plugin:xor-decode"]);
    const want = inferShape([JSON.parse(S42_ITEMS_JSON)]);
    expect(items?.response).toEqual(want);
    const order = shape(decoded).endpoints.find((e) => e.key === "POST /s42/api/order");
    expect(Object.keys(order?.request.body?.fields ?? {})).toEqual(["token", "item", "qty"]);
  }, 20_000);

  test("bounds: fields per endpoint, depth, array sampling", async () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_FIELDS + 500 }, (_, i) => [`f${i}`, i]));
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < MAX_SHAPE_DEPTH + 8; i++) deep = { d: deep };
    const long = Array.from({ length: MAX_ARRAY_ITEMS + 50 }, (_, i) => (i === MAX_ARRAY_ITEMS + 10 ? { a: 1, late: true } : { a: 1 }));
    const b = await buildBundle(dir("d"), { name: "s", created: C, seed: 3 }, async (x) => {
      await x.request({ url: `${O}/wide`, mime: "application/json", body: JSON.stringify(wide), ts: C + 1 });
      await x.request({ url: `${O}/deep`, mime: "application/json", body: JSON.stringify(deep), ts: C + 2 });
      await x.request({ url: `${O}/long`, mime: "application/json", body: JSON.stringify(long), ts: C + 3 });
    });
    const r = shape(b);
    const [w, d, l] = r.endpoints;
    expect(Object.keys(w?.response?.fields ?? {}).length).toBe(MAX_FIELDS);
    expect(w?.capped).toEqual({ fields: true, depth: false, items: false });
    let depth = 0;
    let node: Shape | undefined = d?.response ?? undefined;
    while (node?.fields?.["d"] !== undefined) {
      node = node.fields["d"]?.type;
      depth++;
    }
    expect(depth).toBe(MAX_SHAPE_DEPTH);
    expect(d?.capped.depth).toBe(true);
    expect(l?.capped.items).toBe(true);
    expect(l?.response?.items?.fields?.["late"]).toBeUndefined();
    expect(l?.response?.items?.fields?.["a"]?.samples).toBe(MAX_ARRAY_ITEMS);
    expect(r.warnings.some((x) => x.includes("GET /wide") && x.includes(String(MAX_FIELDS)))).toBe(true);
  });

  test("--write stores exports/shape.json (0600)", async () => {
    const b = await buildBundle(dir("w"), { name: "s", created: C, seed: 4 }, async (x) => {
      await x.request({ url: `${O}/api/list`, mime: "application/json", body: LIST_V1, ts: C + 1 });
    });
    const out = await runCommand(["analyze", "shape", b, "--write"]);
    expect(out.code).toBe(0);
    const file = join(b, "exports", "shape.json");
    expect(out.envelope.ok && isRecord(out.envelope.data) ? out.envelope.data["written"] : null).toBe(file);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(isRecord(saved) ? [saved["schema"], Array.isArray(saved["endpoints"]) ? saved["endpoints"].length : -1] : null).toEqual(["tabcap-shape/0", 1]);
    const text = await runCommand(["analyze", "shape", b, "--text"]);
    expect(text.text?.split("\n")).toContain("  $.items[].price  string(float)");
  });
});

// ------------------------------------------------------------ diff

const ep = (response: unknown[], query: Record<string, string>[] = []): EndpointShape => ({
  key: "GET /x",
  method: "GET",
  template: "/x",
  exchanges: response.length,
  requests: [],
  status: [200],
  decode: [],
  request: { query: inferShape(query), body: null },
  response: inferShape(response),
  samples: { query: query.length, body: 0, response: response.length },
  notJson: 0,
  capped: { fields: false, depth: false, items: false },
});

describe("diff table", () => {
  test("added / removed / changed / optionality / enum; same", () => {
    const a = ep([{ id: 1, t: "a", n: "1.5", o: 1, s: "x" }, { id: 2, t: "b", n: "2.5", o: 2, s: "x" }]);
    const b = ep([{ id: 1, name: "a", n: 1.5, o: 1, s: "y" }, { id: 2, name: "b", n: 2.5, s: "y" }], [{ v: "2" }]);
    const d = diffEndpoint(a, b);
    expect(d.verdict).toBe("drift");
    expect(d.added.sort()).toEqual(["$.name:string", "query:v:string(int)"]);
    expect(d.removed).toEqual(["$.t:string"]);
    expect(d.changed).toEqual([{ path: "$.n", from: "string(float)", to: "number(float)" }]);
    expect(d.optionalityChanged).toEqual([{ path: "$.o", from: "required", to: "optional" }]);
    expect(d.enumChanged).toEqual([{ path: "$.s", from: ["x"], to: ["y"] }]);
    expect(diffEndpoint(a, ep([{ id: 9, t: "z", n: "0.1", o: 3, s: "x" }, { id: 8, t: "q", n: "7.25", o: 4, s: "x" }])).verdict).toBe("same");
  });

  test("union and nullability are type changes; children of a changed parent are listed", () => {
    const d = diffEndpoint(ep([{ a: "x", b: { c: 1 } }]), ep([{ a: null, b: "flat" }]));
    expect(d.changed).toEqual([
      { path: "$.a", from: "string", to: "null" },
      { path: "$.b", from: "object", to: "string" },
    ]);
    expect(d.removed).toEqual(["$.b.c:number(int)"]);
    const u = diffEndpoint(ep([{ a: "x" }]), ep([{ a: "x" }, { a: null }]));
    expect(u.changed).toEqual([{ path: "$.a", from: "string", to: "string|null" }]);
  });

  test("an array without items on one side: its children are not compared (no evidence), with a warning", () => {
    const warnings: string[] = [];
    const d = diffEndpoint(ep([{ items: [{ a: 1 }] }]), ep([{ items: [] }]), (w) => warnings.push(w));
    expect(d.verdict).toBe("same");
    expect(warnings).toEqual(["GET /x: 2 path(s) under an array without items on one side were not compared"]);
  });

  test("an endpoint that answers HTML instead of JSON in the new recording drifts (everything removed), it is not gone", async () => {
    const a = await buildBundle(dir("fa"), { name: "fa", created: C, seed: 7 }, async (x) => {
      await x.request({ url: `${O}/api/me`, mime: "application/json", body: '{"user":{"id":1}}', ts: C + 1 });
    });
    const b = await buildBundle(dir("fb"), { name: "fb", created: C, seed: 8 }, async (x) => {
      await x.request({ url: `${O}/api/me`, mime: "text/html", body: "<!doctype html><title>login</title>", ts: C + 1 });
    });
    const r = schemaDiff(a, b);
    expect(r.endpoints.map((e) => [e.key, e.verdict, e.removed])).toEqual([["GET /api/me", "drift", ["$:object", "$.user:object", "$.user.id:number(int)"]]]);
    // 0.7-C: the two bundles, old then new, by short name
    expect(r.bundles).toEqual([{ short: basename(a), dir: a }, { short: basename(b), dir: b }]);
    expect(schemaDiff(b, a).endpoints.map((e) => [e.verdict, e.added.length])).toEqual([["drift", 3]]);
  });

  test("schema-diff over two bundles: the s06 /api/list variants (LIST_DRIFT), new / gone, exit 1 on drift", async () => {
    const mk = (name: string, seed: number, list: string, url: string, extra: string) =>
      buildBundle(dir(name), { name, created: C, seed }, async (x) => {
        await x.request({ url: `${O}/api/search?q=x&page=1`, mime: "application/json", body: JSON.stringify({ q: "x", hits: ["x-1-a"] }), ts: C + 1 });
        await x.request({ url, type: "fetch", mime: "application/json", body: list, ts: C + 2 });
        await x.request({ url: `${O}${extra}`, mime: "application/json", body: '{"k":1}', ts: C + 3 });
      });
    const a = await mk("old", 5, LIST_V1, `${O}/api/list`, "/api/old");
    const b = await mk("new", 6, LIST_V2, `${O}/api/list?v=2`, "/api/new");
    const r = schemaDiff(a, b);
    expect(r.schema).toBe("tabcap-schema-diff/0");
    expect(r.endpoints.map((e) => [e.key, e.verdict])).toEqual([
      ["GET /api/search", "same"],
      ["GET /api/list", "drift"],
      ["GET /api/old", "gone"],
      ["GET /api/new", "new"],
    ]);
    const list = r.endpoints[1];
    expect([...(list?.added ?? [])].sort()).toEqual(LIST_DRIFT.added);
    expect(list?.removed).toEqual(LIST_DRIFT.removed);
    expect(list?.changed).toEqual(LIST_DRIFT.changed);
    expect(list?.optionalityChanged).toEqual([]);
    expect(list?.enumChanged).toEqual([]);
    expect(r.summary).toEqual({ same: 1, drift: 1, new: 1, gone: 1 });
    expect(r.drift).toBe(true);
    for (const v of ["Blue mug", "12.50", "EUR"]) expect(JSON.stringify(r).includes(v)).toBe(false);

    const cli = await runCommand(["analyze", "schema-diff", a, b, "--text"]);
    expect(cli.code).toBe(1);
    expect(cli.envelope.ok).toBe(true);
    expect(cli.text?.split("\n")).toEqual([
      "drift GET /api/list added query:v:string(int)",
      "drift GET /api/list added $.items[].name:string",
      "drift GET /api/list added $.items[].currency:string",
      "drift GET /api/list removed $.items[].title:string",
      "drift GET /api/list changed $.items[].price string(float) -> number(float)",
      "gone GET /api/old",
      "new GET /api/new",
      "schema-diff: 1 drift, 1 same, 1 new, 1 gone",
    ]);
    const same = await runCommand(["analyze", "schema-diff", a, b, "--template", "GET /api/search"]);
    expect(same.code).toBe(0);
    const gone = schemaDiff(a, b, { template: "GET /api/old" });
    expect(gone.endpoints.map((e) => e.verdict)).toEqual(["gone"]);
    expect(gone.drift).toBe(false);
    expect(() => schemaDiff(a, b, { template: "GET /nowhere" })).toThrow(/either bundle/);
    const w = schemaDiff(a, b, { write: true });
    expect(w.written).toEqual({ old: join(a, "exports", "shape.json"), new: join(b, "exports", "shape.json") });
  });
});
