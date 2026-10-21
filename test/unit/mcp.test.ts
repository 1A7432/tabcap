// 0.5-A `tabcap mcp`. Oracles: the MCP spec, revision 2025-11-25
// (basic/transports#stdio: one JSON-RPC message per line; basic/lifecycle:
// version negotiation; server/tools: tools/list, tools/call, isError, the
// -32602 unknown-tool error), JSON-RPC 2.0 (-32700 / -32600 / -32601), the CLI's
// own parser (parseCommand / matchCommand) for the argv a tool call produces,
// and the hosts' official configuration pages (src/mcp/hosts.ts header). The
// tool names and one inputSchema are pinned by snapshot: an intended change to
// the tool surface updates it.

import { describe, expect, test } from "bun:test";
import { COMMANDS, helpFor, matchCommand, parseCommand, specOf } from "../../src/cli/commands.ts";
import { run } from "../../src/cli/main.ts";
import { fail, ok, type Envelope } from "../../src/shared/envelope.ts";
import { isRecord } from "../../src/shared/json.ts";
import { MCP_HOSTS } from "../../src/mcp/hosts.ts";
import { LATEST_PROTOCOL_VERSION, LineFramer, McpServer, PROTOCOL_VERSIONS, type JsonRpcResponse } from "../../src/mcp/server.ts";
import { CORE, EXCLUDED, HANDOFF_WAIT, HELP, RUN, argvFor, buildTools, callTool, type RunOptions, type Tool } from "../../src/mcp/tools.ts";

type Call = { argv: string[]; opts: RunOptions };

/** A run() stand-in: records calls, answers from a queue (the last answer repeats). */
function fakeRun(answers: Envelope<unknown>[]) {
  const calls: Call[] = [];
  const fn = async (argv: string[], opts: RunOptions): Promise<Envelope<unknown>> => {
    calls.push({ argv, opts });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a === undefined) throw new Error("no answer queued");
    return a;
  };
  return { fn, calls };
}


/** The --all-tools set (one tool per command) and the default core set. */
const TOOLS = buildTools("all");
const CORE_TOOLS = buildTools();
const tool = (name: string): Tool => {
  const t = TOOLS.find((x) => x.def.name === name) ?? CORE_TOOLS.find((x) => x.def.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

function server(answers: Envelope<unknown>[] = [ok({})]) {
  const r = fakeRun(answers);
  return { s: new McpServer({ run: r.fn }), calls: r.calls };
}

const errOf = (r: JsonRpcResponse | null) => (r !== null && "error" in r ? r.error : null);
const resOf = (r: JsonRpcResponse | null): Record<string, unknown> => (r !== null && "result" in r && isRecord(r.result) ? r.result : {});
const line = (o: unknown) => JSON.stringify(o);

describe("stdio framing (newline-delimited JSON-RPC)", () => {
  test("a message split across chunks comes out once it is complete", () => {
    const f = new LineFramer();
    expect(f.push('{"jsonrpc":"2.0","id":1,')).toEqual([]);
    expect(f.push('"method":"ping"}\n{"jsonrpc"')).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    expect(f.push(':"2.0","id":2,"method":"ping"}\n')).toEqual(['{"jsonrpc":"2.0","id":2,"method":"ping"}']);
  });

  test("several messages in one chunk, CRLF line ends, the last line without a newline at end of input", () => {
    const f = new LineFramer();
    expect(f.push("a\nb\r\nc\n")).toEqual(["a", "b", "c"]);
    expect(f.push("d")).toEqual([]);
    expect(f.end()).toBe("d");
    expect(f.end()).toBeNull();
  });

  test("an over-long line is dropped (reported once as null) and the next line is read normally", () => {
    const f = new LineFramer(8);
    expect(f.push("x".repeat(20))).toEqual([null]);
    expect(f.push("yyy")).toEqual([]);
    expect(f.push("yyy\nok\n")).toEqual(["ok"]);
    expect(f.push("123456789\n")).toEqual([null]);
  });
});

describe("JSON-RPC errors and lifecycle (MCP 2025-11-25)", () => {
  test("invalid JSON → -32700 with id null; a batch or a non-request → -32600; unknown method → -32601 with the id", async () => {
    const { s } = server();
    expect(await s.handleLine("{not json")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(errOf(await s.handleLine(null))?.code).toBe(-32700);
    expect(errOf(await s.handleLine("[]"))?.code).toBe(-32600);
    expect(errOf(await s.handleLine(line([{ jsonrpc: "2.0", id: 1, method: "ping" }])))?.code).toBe(-32600);
    expect(await s.handleLine(line({ jsonrpc: "1.0", id: 3, method: "ping" }))).toMatchObject({ id: 3, error: { code: -32600 } });
    expect(await s.handleLine(line({ jsonrpc: "2.0", id: 4, method: "resources/list" }))).toMatchObject({ id: 4, error: { code: -32601 } });
    // 2026-07-28 clients probe with server/discover; method-not-found makes them fall back to initialize.
    expect(await s.handleLine(line({ jsonrpc: "2.0", id: "d", method: "server/discover" }))).toMatchObject({ id: "d", error: { code: -32601 } });
    expect(await s.handleLine(line({ jsonrpc: "2.0", id: 5, method: "ping", params: [1] }))).toMatchObject({ id: 5, error: { code: -32602 } });
  });

  test("notifications, client responses and blank lines get no answer; ping answers {}", async () => {
    const { s } = server();
    expect(await s.handleLine(line({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(await s.handleLine(line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }))).toBeNull();
    expect(await s.handleLine(line({ jsonrpc: "2.0", id: 9, result: {} }))).toBeNull();
    expect(await s.handleLine("   ")).toBeNull();
    expect(await s.handleLine(line({ jsonrpc: "2.0", id: "p", method: "ping" }))).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("initialize: a supported version is echoed, any other gets the latest; tools capability and serverInfo", async () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    for (const v of PROTOCOL_VERSIONS) {
      const { s } = server();
      const r = resOf(await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
      expect(r["protocolVersion"]).toBe(v);
      expect(s.protocolVersion).toBe(v);
    }
    const { s } = server();
    const r = resOf(await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {} } }));
    expect(r["protocolVersion"]).toBe("2025-11-25");
    expect(r["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect(r["serverInfo"]).toMatchObject({ name: "tabcap" });
    expect(errOf(await s.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }))?.code).toBe(-32602);
  });

  test("tools/call protocol errors: unknown tool, name missing, arguments not an object → -32602", async () => {
    const { s, calls } = server();
    expect(await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabcap_mcp" } })).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: tabcap_mcp" } });
    expect(errOf(await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }))?.code).toBe(-32602);
    expect(errOf(await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tabcap_snapshot", arguments: ["x"] } }))?.code).toBe(-32602);
    expect(calls).toEqual([]);
  });
});

describe("tools/list: the default core set", () => {
  test("the listed commands, then tabcap_handoff_wait, tabcap_run, tabcap_help (snapshot); the server lists it by default", async () => {
    const names = CORE_TOOLS.map((t) => t.def.name);
    expect(names).toMatchSnapshot();
    // the coordinator's list (2026-10-16): session start/stop/list, navigate, snapshot, outline, click, fill, type,
    // press-key, hover, wait, screenshot, evaluate, net start/stop/list/show/body, handoff status/continue;
    // 0.7-B: status in place of handoff status
    expect(Object.keys(CORE).sort()).toEqual(
      ["click", "evaluate", "fill", "handoff continue", "status", "hover", "navigate", "net body", "net list", "net show", "net start", "net stop", "outline", "press-key", "screenshot", "session list", "session start", "session stop", "snapshot", "type", "wait"].sort(),
    );
    expect(names.slice(-3)).toEqual([HANDOFF_WAIT, RUN, HELP]);
    const { s } = server();
    const listed = resOf(await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))["tools"];
    expect(Array.isArray(listed) ? listed.map((t) => (isRecord(t) ? t["name"] : null)) : null).toEqual(names);
  });

  test("one-line descriptions of at most 120 characters, properties without descriptions; the same argv as the full tool", () => {
    for (const t of CORE_TOOLS) {
      expect(t.def.description.length).toBeLessThanOrEqual(120);
      expect(t.def.description).not.toContain("\n");
      for (const p of Object.values(t.def.inputSchema.properties)) expect(p.description).toBeUndefined();
      if (t.command === null) continue;
      const full = TOOLS.find((x) => x.def.name === t.def.name);
      expect(t.def.inputSchema.required).toEqual(full?.def.inputSchema.required);
      expect(full?.bindings).toEqual(t.bindings);
    }
    console.log(`[mcp] tools/list: core ${CORE_TOOLS.length} tools, ${JSON.stringify(CORE_TOOLS.map((t) => t.def)).length} B; all ${TOOLS.length} tools, ${JSON.stringify(TOOLS.map((t) => t.def)).length} B`);
  });

  test("initialize instructions point to tabcap_help / tabcap_run in the core set only", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } };
    const core = resOf(await server().s.handle(init));
    expect(String(core["instructions"])).toContain("tabcap_run");
    const all = resOf(await new McpServer({ run: fakeRun([ok({})]).fn }, TOOLS).handle(init));
    expect(String(all["instructions"])).not.toContain("tabcap_run");
  });
});

describe("tabcap_run and tabcap_help", () => {
  test("tabcap_run passes the argv to run() as is (a leading \"tabcap\" dropped) and returns its envelope", async () => {
    const env = ok({ nodes: 3 });
    const r = fakeRun([env]);
    expect(await callTool(tool(RUN), { argv: ["analyze", "deps", "./b", "--request", "r-4"] }, r.fn)).toEqual(env);
    expect(await callTool(tool(RUN), { argv: ["tabcap", "schema"] }, r.fn)).toEqual(env);
    expect(r.calls).toEqual([
      { argv: ["analyze", "deps", "./b", "--request", "r-4"], opts: {} },
      { argv: ["schema"], opts: {} },
    ]);
  });

  test("tabcap_run refuses what would block or read the stdio channel, and malformed argv", async () => {
    for (const argv of [["mcp"], ["daemon", "run"], ["site", "add", "example", "--url", "http://127.0.0.1/", "--user", "alice"], ["proxy", "add", "p1"], ["account", "add", "example"], ["wire", "serve"], ["replay", "serve", "./b"], ["fingerprint", "serve"]]) {
      const r = fakeRun([ok({})]);
      const env = await callTool(tool(RUN), { argv }, r.fn);
      expect(env).toMatchObject({ ok: false, error: { code: "usage" } });
      if (env.ok) throw new Error("expected failure");
      expect(env.error.message).toContain("is not available over MCP");
      expect(r.calls).toEqual([]);
    }
    for (const args of [{}, { argv: "net list" }, { argv: [] }, { argv: ["net", 1] }, { argv: ["net", "list"], x: 1 }]) {
      const r = fakeRun([ok({})]);
      expect(await callTool(tool(RUN), args, r.fn)).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(r.calls).toEqual([]);
    }
  });

  test("browser start's custom Chrome args and executable are for the human: not in the schema, refused by tabcap_run (review 10-21)", async () => {
    const props = Object.keys(tool("tabcap_browser_start").def.inputSchema.properties);
    for (const p of ["chromeArg", "dropChromeArg", "executablePath"]) expect(props).not.toContain(p);
    for (const p of ["proxy", "webdriver", "foreground"]) expect(props).toContain(p);
    expect(() => argvFor(tool("tabcap_browser_start"), { chromeArg: ["--no-sandbox"] })).toThrow("unknown argument chromeArg");
    for (const argv of [
      ["browser", "start", "--chrome-arg=--no-sandbox"],
      ["browser", "start", "--proxy", "none", "--chrome-arg", "--disable-web-security"],
      ["browser", "start", "--drop-chrome-arg", "--disable-sync"],
      ["tabcap", "browser", "start", "--executable-path", "/tmp/chrome"],
      ["browser", "start", "--executable-path=/tmp/chrome"],
    ]) {
      const r = fakeRun([ok({})]);
      const env = await callTool(tool(RUN), { argv }, r.fn);
      if (env.ok) throw new Error(`expected a refusal for ${argv.join(" ")}`);
      expect(env.error.code).toBe("usage");
      expect(env.error.message).toContain("for the human: pass them in a shell, or put them in config.json chrome.args");
      expect(r.calls).toEqual([]);
    }
    const r = fakeRun([ok({})]);
    expect((await callTool(tool(RUN), { argv: ["browser", "start", "--proxy", "none", "--webdriver", "visible"] }, r.fn)).ok).toBe(true);
    expect(r.calls).toEqual([{ argv: ["browser", "start", "--proxy", "none", "--webdriver", "visible"], opts: {} }]);
  });

  test("tabcap_help without a command: every command with its usage and the tool that runs it", async () => {
    const env = await callTool(tool(HELP), {}, fakeRun([ok({})]).fn);
    if (!env.ok || !isRecord(env.data) || !Array.isArray(env.data["commands"])) throw new Error(JSON.stringify(env));
    const rows = env.data["commands"].filter(isRecord);
    expect(rows.length).toBe(COMMANDS.filter((c) => c.internal !== true).length);
    expect(rows.find((x) => x["name"] === "navigate")).toMatchObject({ via: "tabcap_navigate" });
    expect(rows.find((x) => x["name"] === "analyze deps")).toMatchObject({ via: "tabcap_run", usage: expect.stringContaining("tabcap analyze deps <bundle>") });
    expect(rows.find((x) => x["name"] === "schema")).toMatchObject({ via: "tabcap_run" });
    expect(rows.find((x) => x["name"] === "site add")).toMatchObject({ via: null });
  });

  test("tabcap_help {command}: the --help text and the schema entry; tool names work too; unknown → usage", async () => {
    for (const q of ["net list", "tabcap net list", "tabcap_net_list"]) {
      const env = await callTool(tool(HELP), { command: q }, fakeRun([ok({})]).fn);
      expect(env).toMatchObject({ ok: true, data: { name: "net list", via: "tabcap_net_list", help: helpFor(specOf("net list")), schema: { name: "net list" } } });
    }
    expect(await callTool(tool(HELP), { command: "net lst" }, fakeRun([ok({})]).fn)).toMatchObject({ ok: false, error: { code: "usage", message: "unknown command: net lst" } });
    expect(await callTool(tool(HELP), { command: 3 }, fakeRun([ok({})]).fn)).toMatchObject({ ok: false, error: { code: "usage" } });
  });
});

describe("tools/list --all-tools: generated from the command table", () => {
  test("tool names (snapshot) follow the spec's name rules and are unique", () => {
    for (const set of [TOOLS, CORE_TOOLS]) {
      const names = set.map((t) => t.def.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
    expect(TOOLS.map((t) => t.def.name)).toMatchSnapshot();
  });

  test("one tool per command except the listed exclusions, plus tabcap_handoff_wait", () => {
    expect(Object.keys(EXCLUDED).sort()).toEqual(["account add", "bundle prune", "daemon run", "fingerprint serve", "handoff wait", "mcp", "proxy add", "replay serve", "schema", "site add", "update", "wire serve"]);
    for (const k of Object.keys(EXCLUDED)) expect(specOf(k).path.join(" ")).toBe(k);
    const expected = COMMANDS.filter((c) => EXCLUDED[c.path.join(" ")] === undefined).map((c) => `tabcap_${c.path.join("_")}`);
    expect(TOOLS.map((t) => t.def.name)).toEqual([...expected, HANDOFF_WAIT]);
    expect(TOOLS.every((t) => t.def.name !== "tabcap_mcp" && t.def.name !== "tabcap_schema" && t.def.name !== "tabcap_daemon_run")).toBe(true);
  });

  test("navigate's inputSchema (snapshot)", () => {
    expect(tool("tabcap_navigate").def).toMatchSnapshot();
  });

  test("every daemon command tool has session and timeout; no print-format (--text / --json) property; objects are closed", () => {
    for (const t of [...TOOLS, ...CORE_TOOLS]) {
      const s = t.def.inputSchema;
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      if (t.command?.action !== undefined) {
        expect(s.properties["session"]?.type).toBe("string");
        expect(s.properties["timeout"]?.type).toBe("number");
      }
      // Print-format flags are `--text` / `--json` with keys text / json; `html --text` (key textContent) is data and stays.
      const printFormat = new Set((t.command?.flags ?? []).filter((f) => f.kind === "bool" && ((f.flag === "--text" && f.key === "text") || (f.flag === "--json" && f.key === "json"))).map((f) => f.flag));
      expect(t.bindings.some((b) => b.to === "flag" && b.type === "boolean" && printFormat.has(b.flag))).toBe(false);
      if (t.def.name !== "tabcap_html") expect(t.bindings.some((b) => b.to === "flag" && b.type === "boolean" && (b.flag === "--text" || b.flag === "--json"))).toBe(false);
      // `fetch --json <text>` (0.6-A) is the request body, data like `html --text`; every other `json` would be the print format.
      if (t.def.name !== "tabcap_fetch") expect(Object.keys(s.properties)).not.toContain("json");
    }
    expect(tool("tabcap_fetch").def.inputSchema.properties["json"]?.type).toBe("string");
    expect(tool("tabcap_html").def.inputSchema.properties["text"]?.type).toBe("boolean");
    // analyze find's text is its positional; dialog's --text is a value (the prompt answer), not a print format
    expect(tool("tabcap_dialog").def.inputSchema.properties["text"]?.type).toBe("string");
    expect(tool("tabcap_analyze_find").def.inputSchema.required).toEqual(["bundle", "text"]);
    expect(tool("tabcap_go").def.inputSchema.properties["direction"]).toMatchObject({ type: "string", enum: ["back", "forward"] });
    expect(tool("tabcap_wait").def.inputSchema.properties["text"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(tool("tabcap_upload").def.inputSchema.properties["files"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(tool("tabcap_analyze_diff").def.inputSchema.properties["bundles"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(tool("tabcap_upload").def.inputSchema.required).toEqual(["ref", "files"]);
    expect(tool("tabcap_net_wait").def.inputSchema.required).toEqual(["url"]);
  });
});

describe("tool arguments → the CLI's argv", () => {
  test("navigate: flags as --flag=value, the positional last; the CLI parser reads back the same arguments", () => {
    const t = tool("tabcap_navigate");
    const { argv, opts } = argvFor(t, { url: "http://127.0.0.1:1/?a=b", newTab: true, noWait: false, timeout: 5000, session: "s" });
    expect(argv).toEqual(["navigate", "--session=s", "--timeout=5000", "--new-tab", "http://127.0.0.1:1/?a=b"]);
    expect(opts).toEqual({});
    const p = parseCommand(specOf("navigate"), argv.slice(1));
    expect(p.session).toBe("s");
    expect(p.args).toEqual({ url: "http://127.0.0.1:1/?a=b", newTab: true, timeoutMs: 5000 });
  });

  test("repeatable, optional-number, list and dash-leading values", () => {
    expect(argvFor(tool("tabcap_wait"), { text: ["a", "b=c"], idle: 800 }).argv).toEqual(["wait", "--text=a", "--text=b=c", "--idle=800"]);
    expect(parseCommand(specOf("wait"), ["--text=a", "--text=b=c", "--idle=800"]).args).toEqual({ text: ["a", "b=c"], idle: 800 });
    expect(argvFor(tool("tabcap_upload"), { ref: "e2", files: ["a.txt", "b.txt"] }).argv).toEqual(["upload", "e2", "a.txt", "b.txt"]);
    const fill = argvFor(tool("tabcap_fill"), { ref: "e1", text: "--help" }).argv;
    expect(fill).toEqual(["fill", "--", "e1", "--help"]);
    expect(parseCommand(specOf("fill"), fill.slice(1)).args).toEqual({ ref: "e1", text: "--help" });
    expect(argvFor(tool("tabcap_analyze_diff"), { bundle1: "a", bundle2: "b", bundles: ["c", "d e"] }).argv).toEqual(["analyze", "diff", "a", "b", "c", "d e"]);
  });

  test("session / timeout of a daemon command without those flags go to the run options", () => {
    expect(argvFor(tool("tabcap_tab_list"), { session: "s", timeout: 5000 })).toEqual({ argv: ["tab", "list", "--session=s"], opts: { timeoutMs: 5000 } });
    expect(argvFor(tool("tabcap_browser_start"), { session: "s", proxy: "none" })).toEqual({ argv: ["browser", "start", "--proxy=none"], opts: { session: "s" } });
  });

  test("every tool's argv dispatches to its own command", () => {
    // run() picks the longest command path among the words, so a positional can never extend a command path into another one
    for (const a of COMMANDS) for (const b of COMMANDS) if (a !== b && b.path.length > a.path.length) expect(a.path.every((w, i) => b.path[i] === w)).toBe(false);
    for (const t of TOOLS) {
      if (t.command === null) continue;
      const args: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(t.def.inputSchema.properties)) {
        if (!(t.def.inputSchema.required ?? []).includes(k)) continue;
        args[k] = s.type === "array" ? ["v1"] : s.enum !== undefined ? s.enum[0] : s.type === "number" ? 1 : s.type === "boolean" ? true : "v";
      }
      const { argv } = argvFor(t, args);
      expect(matchCommand(argv.filter((a) => !a.startsWith("-")))).toBe(t.command);
    }
  });

  test("arguments that do not fit the schema are a usage envelope (a tool result), the command is not run", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["tabcap_snapshot", { bogus: 1 }, "unknown argument bogus"],
      ["tabcap_snapshot", { maxChars: "10" }, "maxChars must be a number"],
      ["tabcap_snapshot", { interactive: "yes" }, "interactive must be a boolean"],
      ["tabcap_resize", { width: "900" }, "missing height"],
      ["tabcap_resize", { width: 900, height: "700" }, "width must be a string"],
      ["tabcap_go", { direction: "up" }, "direction must be one of back, forward"],
      ["tabcap_wait", { text: "a" }, "text must be an array of strings"],
      ["tabcap_upload", { ref: "e1", files: [] }, "files needs at least one value"],
      ["tabcap_tab_list", { timeout: "5" }, "timeout must be a number"],
    ];
    for (const [name, args, message] of cases) {
      const r = fakeRun([ok({})]);
      const env = await callTool(tool(name), args, r.fn);
      expect(env).toMatchObject({ ok: false, error: { code: "usage", message } });
      expect(r.calls).toEqual([]);
    }
  });
});

describe("tools/call: the envelope as one text item, isError when ok is false", () => {
  const call = async (env: Envelope<unknown>, name = "tabcap_snapshot", args: Record<string, unknown> = {}) => {
    const { s, calls } = server([env]);
    const r = resOf(await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
    return { r, calls };
  };

  test("ok envelope", async () => {
    const env = ok({ tab: "t1", text: "line 1\nline 2" });
    const { r, calls } = await call(env, "tabcap_snapshot", { interactive: true });
    expect(r).toEqual({ content: [{ type: "text", text: JSON.stringify(env, null, 2) }], isError: false });
    expect(calls).toEqual([{ argv: ["snapshot", "--interactive"], opts: {} }]);
  });

  test("error envelope", async () => {
    const env = fail("stale-ref", "ref e4 expired", "run snapshot again");
    const { r } = await call(env, "tabcap_click", { ref: "e4" });
    expect(r["isError"]).toBe(true);
    expect(JSON.parse(String((r["content"] as { text: string }[])[0]?.text))).toEqual(env);
  });

  test("waiting comes back at once with its next (no blocking): one run, isError", async () => {
    const env = fail("waiting", 'session "default" is waiting for the human: captcha at http://127.0.0.1/ (HTTP 200)', "Ask the human …, then run `tabcap handoff continue`", { state: "waiting", reason: "captcha" });
    const { r, calls } = await call(env, "tabcap_navigate", { url: "http://127.0.0.1/" });
    expect(calls.length).toBe(1);
    expect(r["isError"]).toBe(true);
    expect(JSON.parse(String((r["content"] as { text: string }[])[0]?.text))).toEqual(env);
  });
});

describe("tabcap_handoff_wait (one `handoff wait`, the daemon waits)", () => {
  test("arguments → argv: timeoutSeconds as --timeout ms (at least 100), session, the until* conditions in flag order", async () => {
    const r = fakeRun([ok({ session: "s", state: "resumed", by: "condition" })]);
    const env = await callTool(tool(HANDOFF_WAIT), { session: "s", timeoutSeconds: 60, untilCookie: "sid", untilUrl: "/home" }, r.fn);
    expect(env).toEqual(ok({ session: "s", state: "resumed", by: "condition" }));
    expect(r.calls).toEqual([{ argv: ["handoff", "wait", "--timeout=60000", "--session=s", "--until-url=/home", "--until-cookie=sid"], opts: {} }]);
    const d = fakeRun([ok({ session: "default", state: "running", handoff: null })]);
    await callTool(tool(HANDOFF_WAIT), {}, d.fn);
    await callTool(tool(HANDOFF_WAIT), { timeoutSeconds: 0, untilText: "Welcome", untilSelector: "#me" }, d.fn);
    expect(d.calls.map((c) => c.argv)).toEqual([
      ["handoff", "wait", "--timeout=30000"],
      ["handoff", "wait", "--timeout=100", "--until-text=Welcome", "--until-selector=#me"],
    ]);
  });

  test("the daemon's answer comes back as is (waiting on timeout, not-running …)", async () => {
    const waiting = fail("waiting", 'session "s" still waits for the user after 2500 ms', "Run `tabcap handoff wait` again (over MCP: tabcap_handoff_wait) …", { state: "waiting", waitedMs: 2500 });
    expect(await callTool(tool(HANDOFF_WAIT), { session: "s", timeoutSeconds: 2.5 }, fakeRun([waiting]).fn)).toEqual(waiting);
    const down = fail("not-running", "the tabcap daemon is not running", "Run `tabcap daemon start`.");
    expect(await callTool(tool(HANDOFF_WAIT), { timeoutSeconds: 5 }, fakeRun([down]).fn)).toEqual(down);
  });

  test("bad arguments are usage before anything runs; the schema lists the until* strings", async () => {
    for (const args of [{ timeoutSeconds: 301 }, { timeoutSeconds: -1 }, { timeoutSeconds: "10" }, { untilUrl: 3 }, { until: "/x" }, { session: 1 }]) {
      const r = fakeRun([ok({})]);
      expect(await callTool(tool(HANDOFF_WAIT), args, r.fn)).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(r.calls).toEqual([]);
    }
    const props = tool(HANDOFF_WAIT).def.inputSchema.properties;
    expect(props["timeoutSeconds"]).toMatchObject({ type: "number", minimum: 0, maximum: 300 });
    for (const k of ["untilUrl", "untilText", "untilSelector", "untilCookie"]) expect(props[k]).toEqual({ type: "string" });
  });
});

describe("tabcap mcp --print-config <host>", () => {
  const JSON_HOSTS = ["claude-code", "cursor", "gemini-cli", "windsurf", "claude-desktop"];

  test("every host: files, docs, the server entry; claude-code's command is `claude mcp add tabcap -- tabcap mcp`", async () => {
    expect([...MCP_HOSTS]).toEqual(["claude-code", "cursor", "codex", "gemini-cli", "windsurf", "claude-desktop"]);
    for (const host of MCP_HOSTS) {
      const r = await run(["mcp", "--print-config", host]);
      expect(r.code).toBe(0);
      if (!r.envelope.ok) throw new Error(JSON.stringify(r.envelope));
      const d = r.envelope.data;
      if (!isRecord(d)) throw new Error("no data");
      expect(d["host"]).toBe(host);
      expect(Array.isArray(d["files"]) && d["files"].length > 0).toBe(true);
      expect(Array.isArray(d["docs"]) && d["docs"].every((u) => typeof u === "string" && u.startsWith("https://"))).toBe(true);
      expect(d["verified"]).toBe(host !== "windsurf");
      if (JSON_HOSTS.includes(host)) {
        expect(d["format"]).toBe("json");
        expect(d["config"]).toMatchObject({ mcpServers: { tabcap: { command: "tabcap", args: ["mcp"] } } });
      }
    }
    const cc = await run(["mcp", "--print-config", "claude-code"]);
    expect(cc.envelope).toMatchObject({ ok: true, data: { command: "claude mcp add tabcap -- tabcap mcp", config: { mcpServers: { tabcap: { command: "tabcap", args: ["mcp"] } } } } });
    const cursor = await run(["mcp", "--print-config", "cursor"]);
    expect(cursor.envelope).toMatchObject({ ok: true, data: { files: [{ path: "~/.cursor/mcp.json" }, { path: ".cursor/mcp.json" }], config: { mcpServers: { tabcap: { type: "stdio" } } } } });
    const codex = await run(["mcp", "--print-config", "codex"]);
    expect(codex.envelope).toMatchObject({ ok: true, data: { format: "toml", config: '[mcp_servers.tabcap]\ncommand = "tabcap"\nargs = ["mcp"]\n', command: "codex mcp add tabcap -- tabcap mcp", files: [{ path: "~/.codex/config.toml" }, { path: ".codex/config.toml" }] } });
    const gemini = await run(["mcp", "--print-config", "gemini-cli"]);
    expect(gemini.envelope).toMatchObject({ ok: true, data: { files: [{ path: "~/.gemini/settings.json" }, { path: ".gemini/settings.json" }] } });
    const desktop = await run(["mcp", "--print-config", "claude-desktop"]);
    expect(desktop.envelope).toMatchObject({ ok: true, data: { files: [{ path: "~/Library/Application Support/Claude/claude_desktop_config.json" }, { path: "%APPDATA%\\Claude\\claude_desktop_config.json" }] } });
  });

  test("an unknown host or a missing value is a usage error; the flag's help lists the hosts", async () => {
    const bad = await run(["mcp", "--print-config", "vim"]);
    expect(bad.code).toBe(2);
    expect(bad.envelope).toMatchObject({ ok: false, error: { code: "usage", message: "unknown MCP host: vim" } });
    expect((await run(["mcp", "--print-config"])).envelope).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(specOf("mcp").flags[0]?.help).toContain(MCP_HOSTS.join(" | "));
  });
});
