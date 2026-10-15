// replay export-python (src/replay/python.ts). The snapshot pins the generated
// client.py for the synthetic bundle of _replay.ts; every output must pass
// `python3 -m py_compile`. Untrusted names and values (keys, headers, bodies)
// must come out as literals / identifiers, never as code.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPython, pyBytes, pyIdent, pyStr, TODO_MARK } from "../../src/replay/python.ts";
import { run } from "../../src/cli/main.ts";
import { buildBundle, tmp } from "./_analyze.ts";
import { PYTHON3, pyCompile } from "./_python.ts";
import { buildReplayBundle } from "./_replay.ts";

let root = "";
let bundle = "";

beforeAll(async () => {
  root = tmp("tabcap-replay-py-");
  bundle = join(root, "b");
  await buildReplayBundle(bundle);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FILES = ["client.py", "conftest.py", "test_replay.py"];

describe("generated package", () => {
  test("client.py snapshot; files; every Python file compiles", () => {
    const out = join(root, "py");
    const r = exportPython({ bundle, out, chain: false }); // 0.3 behaviour (--no-chain); chain mode: replay-chain.test.ts
    expect(r.files).toEqual([
      "README.md",
      "client.py",
      "conftest.py",
      "fixtures/get_api_feed.json",
      "fixtures/get_api_items.json",
      "fixtures/get_api_sign.json",
      "fixtures/get_root.txt",
      "fixtures/index.json",
      "fixtures/post_api_login.json",
      "fixtures/post_api_search.json",
      "fixtures/post_api_upload.json",
      "pyproject.toml",
      "test_replay.py",
    ]);
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).toMatchSnapshot();
    expect(pyCompile(FILES.map((f) => join(out, f)))).toBeNull();
  });

  test("functions: arguments for varying values, timestamps optional, TODO for signatures and unrecorded bodies", () => {
    const r = exportPython({ bundle, out: join(root, "py2"), chain: false });
    const fn = (n: string) => r.functions.find((f) => f.name === n);
    expect(fn("get_api_items")?.args).toEqual(["page"]);
    expect(fn("get_api_feed")?.args).toEqual([]);
    expect(fn("post_api_search")?.args).toEqual(["page", "q", "t"]);
    expect(fn("get_api_sign")?.todo).toBe("query sig looks like a signature");
    expect(fn("post_api_upload")?.todo).toContain("request body was not recorded");
    expect(r.functions.map((f) => f.name)).not.toContain("get_img_logo_png");
    const client = readFileSync(join(root, "py2", "client.py"), "utf8");
    expect(client).toContain(`raise NotImplementedError("${TODO_MARK} (query sig looks like a signature)")`);
    // the recorded signature value is not baked into the client
    const sign = r.functions.find((f) => f.name === "get_api_sign");
    expect(sign).toBeDefined();
    const index: unknown = JSON.parse(readFileSync(join(root, "py2", "fixtures", "index.json"), "utf8"));
    expect(index).toMatchObject({ session: "replay-demo" });
    expect(client).not.toMatch(/sig=[0-9a-f]{64}/);
  });

  test("--include / --exclude", () => {
    const only = exportPython({ bundle, out: join(root, "py3"), include: "/api/items,/api/feed" });
    expect(only.functions.map((f) => f.name)).toEqual(["get_api_items", "get_api_feed"]);
    const without = exportPython({ bundle, out: join(root, "py4"), exclude: "/api/**,/go" });
    expect(without.functions.map((f) => f.name)).toEqual(["get_root"]);
    expect(() => exportPython({ bundle, out: join(root, "py5"), include: "/nothing" })).toThrow(/no request/);
  });

  test("hostile names and values stay data", async () => {
    const evil = 'x"""\n__import__("os").system("echo pwned")\n#';
    const b = await buildBundle(join(root, "evil"), { name: evil, created: 1760600000000, seed: 9 }, async (bb) => {
      for (const [i, q] of ["one", "two"].entries()) {
        await bb.request({
          url: `http://127.0.0.1:4310/api/${encodeURIComponent('a"b')}/x?${encodeURIComponent(evil)}=${q}&k=${encodeURIComponent(evil)}`,
          method: "POST",
          mime: "application/json",
          body: JSON.stringify({ [evil]: { "class": [1, null, " \\"] }, "def": i }),
          postData: JSON.stringify({ [evil]: q, "lambda": { "if": i, "None": true }, nested: [[[{ z: "\ud800" }]]] }),
          reqHeaders: { "content-type": "application/json", [`x-${"h".repeat(3)}`]: evil.replace(/\n/g, " "), "x-n": `${i}` },
          ts: 1760600000100 + i,
        });
      }
    });
    const out = join(root, "evil-py");
    const r = exportPython({ bundle: b, out });
    expect(pyCompile(FILES.map((f) => join(out, f)))).toBeNull();
    const client = readFileSync(join(out, "client.py"), "utf8");
    expect(client).not.toContain('\n__import__("os")');
    expect(r.functions.every((f) => /^[a-z_][a-z0-9_]*$/.test(f.name))).toBe(true);
    expect(r.functions[0]?.args.every((a) => /^[a-z_][a-z0-9_]*$/.test(a))).toBe(true);
  });

  test("CLI: -o required; envelope lists functions", async () => {
    expect((await run(["replay", "export-python", bundle])).code).toBe(2);
    const r = await run(["replay", "export-python", bundle, "-o", join(root, "cli-py"), "--include", "/api/items"]);
    expect(r.code).toBe(0);
    expect(r.envelope).toMatchObject({ ok: true, data: { functions: [{ name: "get_api_items", method: "GET", samples: 2 }] } });
  });
});

describe("literals", () => {
  const samples = ["", "plain", 'q"uote', "back\\slash", "new\nline\r\t", "  \u0085﻿", "\u0000\u001f\u007f", "中文✓😀", "\ud800 lone", "\udc00", "'''\"\"\"", "\\N{BULLET}", "{x}", "%s"];

  test.skipIf(PYTHON3 === null)("pyStr / pyBytes round-trip through Python exactly", () => {
    const file = join(root, "lit.py");
    const bytes = [new Uint8Array([0, 1, 0x22, 0x5c, 0x7f, 0x80, 0xff, 0x41]), new TextEncoder().encode('b"\\x')];
    writeFileSync(
      file,
      [
        "import json, sys",
        `S = [${samples.map(pyStr).join(", ")}]`,
        `B = [${bytes.map(pyBytes).join(", ")}]`,
        // surrogates cannot be UTF-8 encoded: print code points
        "print(json.dumps({'s': [[ord(c) for c in s] for s in S], 'b': [list(b) for b in B]}))",
      ].join("\n") + "\n",
    );
    const py = PYTHON3 ?? "python3";
    const r = Bun.spawnSync([py, "-I", file], { stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    const got: unknown = JSON.parse(r.stdout.toString());
    const codeUnits = (s: string) => {
      // Python keeps a surrogate pair as one code point; a lone surrogate as itself
      const out: number[] = [];
      for (const c of s) out.push(c.codePointAt(0) ?? 0);
      return out;
    };
    expect(got).toEqual({ s: samples.map(codeUnits), b: bytes.map((b) => [...b]) });
  });

  test("identifiers", () => {
    expect(pyIdent("x-client-build")).toBe("x_client_build");
    expect(pyIdent("$.items[0].q")).toBe("items_0_q");
    expect(pyIdent("class")).toBe("class_");
    expect(pyIdent("1st")).toBe("p_1st");
    expect(pyIdent("中文")).toBe("x");
    expect(pyIdent("GET_/api/{n}/x")).toBe("get_api_n_x");
  });
});
