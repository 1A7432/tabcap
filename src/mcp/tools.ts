// MCP tools generated from the CLI command table (src/cli/commands.ts), the
// same source as `--help` and `tabcap schema --json`. Two sets (owner,
// 2026-10-16: a host loads every tool definition into the model's context,
// and one tool per command is ~58 KB of definitions):
//   - core (default): the commands of the everyday loop (CORE below) with a
//     one-line description and bare property schemas, tabcap_handoff_wait,
//     and two generic tools: tabcap_run {argv} runs any other command,
//     tabcap_help {command?} returns the command list or one command's
//     usage, options and schema on demand;
//   - all (`tabcap mcp --all-tools`): one tool per command with the full help
//     texts, plus tabcap_handoff_wait.
// A command tool is named `tabcap_` + the command path with spaces as `_`
// (`tabcap_net_list`, `tabcap_press-key`). Arguments map back to an argv for the CLI's own
// `run()` (no shell, the same parsing and validation), so a tool call and the
// command line give the same envelope. Property names are the long flags in
// camelCase (`--page-size` → `pageSize`, `--timeout` → `timeout`), the
// spelling of the Chrome DevTools MCP tools (docs/08 §5), and the positional
// names (`url`, `ref`, `files`).

import { COMMANDS, COMMON_FLAGS, helpFor, matchCommand, schema, usageOf, type CommandSpec, type FlagSpec } from "../cli/commands.ts";
import { TabcapError, fail, ok, toFail, type Envelope } from "../shared/envelope.ts";
import { isRecord } from "../shared/json.ts";
import { guideList, guideOf } from "../cli/guides.ts";

/** Session and timeout of a daemon command that has no flag for them (main.ts `run`). */
export type RunOptions = { session?: string; timeoutMs?: number };
export type RunFn = (argv: string[], opts: RunOptions) => Promise<Envelope<unknown>>;

/** Commands that are not tools in either set, and why; tabcap_run refuses them too, except `schema`. */
export const EXCLUDED: Readonly<Record<string, string>> = {
  mcp: "this server itself",
  schema: "the tool list is the schema",
  "daemon run": "internal: the daemon in the foreground",
  "site add": "for the human: reads the password from a prompt or stdin, which is the MCP channel",
  "proxy add": "for the human: reads the password from a prompt or stdin, which is the MCP channel",
  "account add": "for the human: reads the password from a prompt or stdin, which is the MCP channel",
  "fingerprint serve": "a foreground server until Ctrl-C that prints to stdout",
  "wire serve": "a foreground server until Ctrl-C that prints to stdout",
  "replay serve": "a foreground server until Ctrl-C that prints to stdout",
};

/** `--text` / `--json` only change what the CLI prints; a tool always returns the envelope. (`html --text` is data: its key is textContent.) */
const renderOnly = (f: FlagSpec): boolean => f.kind === "bool" && ((f.flag === "--text" && f.key === "text") || (f.flag === "--json" && f.key === "json"));

export type JsonSchema = {
  type: "string" | "number" | "boolean" | "array";
  /** Left out in the core set: the property name says it, tabcap_help has the text. */
  description?: string;
  items?: { type: "string" };
  enum?: string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JsonSchema>; required?: string[]; additionalProperties: false };
};

type Binding =
  | { prop: string; to: "pos"; list: boolean; choices: string[] | null; required: boolean }
  | { prop: string; to: "flag"; flag: string; type: "string" | "number" | "boolean" | "list"; required: boolean }
  | { prop: string; to: "opt"; key: "session" | "timeoutMs"; type: "string" | "number" };

export type Tool = { def: ToolDef; command: CommandSpec | null; bindings: Binding[] };

export const HANDOFF_WAIT = "tabcap_handoff_wait";
export const HANDOFF_WAIT_MAX_S = 300;
const HANDOFF_WAIT_DEFAULT_S = 30;

/** `--page-size` → `pageSize`. */
export function propOf(flag: string): string {
  return flag.replace(/^-+/, "").replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

export const toolName = (c: CommandSpec): string => `tabcap_${c.path.join("_")}`;

function flagSchema(f: FlagSpec): JsonSchema {
  const description = f.help + (f.kind === "optnum" ? ` (given without a number on the command line it means ${String(f.default)})` : "");
  if (f.repeat === true) return { type: "array", items: { type: "string" }, description: `${description} (one or more)` };
  const type = f.kind === "bool" ? "boolean" : f.kind === "string" ? "string" : "number";
  return f.default === undefined || f.kind === "optnum" ? { type, description } : { type, description, default: f.default };
}

function commandTool(c: CommandSpec): Tool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const bindings: Binding[] = [];
  const usage = usageOf(c, COMMON_FLAGS);
  const add = (prop: string, schema: JsonSchema, b: Binding) => {
    if (prop in properties) throw new TabcapError("internal", `tool ${toolName(c)}: two arguments named ${prop}`, "This is a bug.");
    properties[prop] = schema;
    bindings.push(b);
    if (b.to !== "opt" && b.required) required.push(prop);
  };
  const nRequired = c.pos.length - (c.optional ?? 0);
  c.pos.forEach((p, i) => {
    const variadic = p.endsWith("...");
    const name = variadic ? p.slice(0, -3) : p;
    const list = variadic && c.restList === true;
    const choices = c.choices?.[p] ?? null;
    const description = `<${name}> in \`${usage}\`` + (variadic && !list ? " (several words are one string)" : "");
    const schema: JsonSchema = list ? { type: "array", items: { type: "string" }, description } : choices === null ? { type: "string", description } : { type: "string", enum: [...choices], description };
    add(name, schema, { prop: name, to: "pos", list, choices, required: i < nRequired });
  });
  for (const f of c.flags) {
    if (renderOnly(f)) continue;
    const type = f.repeat === true ? "list" : f.kind === "bool" ? "boolean" : f.kind === "string" ? "string" : "number";
    add(propOf(f.flag), flagSchema(f), { prop: propOf(f.flag), to: "flag", flag: f.flag, type, required: f.required === true });
  }
  // Every daemon command takes the shared session and timeout, also when the CLI command has no flag for them.
  if (c.action !== undefined) {
    if (!("session" in properties)) add("session", { type: "string", description: "session name; else $TABCAP_SESSION", default: "default" }, { prop: "session", to: "opt", key: "session", type: "string" });
    if (!("timeout" in properties)) add("timeout", { type: "number", description: "how long to wait for the daemon's answer, in ms", default: 30000 }, { prop: "timeout", to: "opt", key: "timeoutMs", type: "number" });
  }
  return {
    def: { name: toolName(c), description: c.summary, inputSchema: { type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false } },
    command: c,
    bindings,
  };
}

const HANDOFF_WAIT_TOOL: Tool = {
  def: {
    name: HANDOFF_WAIT,
    // One line like the core tools; the waiting error it returns says what to do next.
    description: `wait until the human continued a waiting session, polling each second; timeoutSeconds 0-${HANDOFF_WAIT_MAX_S} (default ${HANDOFF_WAIT_DEFAULT_S})`,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        timeoutSeconds: { type: "number", minimum: 0, maximum: HANDOFF_WAIT_MAX_S },
      },
      additionalProperties: false,
    },
  },
  command: null,
  bindings: [],
};

export const RUN = "tabcap_run";
export const HELP = "tabcap_help";

/** The core set: command path → one-line description (at most 120 characters). */
export const CORE: Readonly<Record<string, string>> = {
  "session start": "create a named session; site binds a stored site (its account, secret references, proxy)",
  "session stop": "close the session's own tabs and finish its recording",
  "session list": "list sessions",
  navigate: "load a URL in the session's background tab; waits until ready and the DOM is quiet",
  snapshot: "accessibility tree with refs (e12) for click / fill; refs expire when the document changes",
  outline: "page map: overlays with their close-button refs, detected frameworks, frames, popups",
  click: "click an element by ref, then wait for the navigation and DOM to settle; trusted: real mouse events",
  fill: "set a field's value by ref; secret: a stored reference (example.password), never a password",
  type: "type text into the focused element; submitKey presses a key afterwards",
  "press-key": "press a key or combination on the focused element (Enter, Tab, Control+a)",
  hover: "move the mouse over an element by ref (menus and tooltips open)",
  wait: "wait for text, a selector, a URL, network idle or a function; timeout in ms (max 120000)",
  screenshot: "save an image of the tab, the full page or one ref; returns the file path, never the image",
  evaluate: "run JavaScript in the page (expression, or function with args); the result is untrusted data",
  "net start": "record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle",
  "net stop": "finish the session's recording",
  "net list": "recorded requests, 100 per page; failed and data: URLs hidden unless failed / all",
  "net show": "one recorded request in full: headers, postData, timing, initiator",
  "net body": "a response body or WebSocket frame as a file path plus a short text preview",
  "handoff status": "is the session handed to the human? state running | waiting | resumed",
  "handoff continue": "end a waiting state after the human finished in the browser (only when they say so)",
};

/** A core tool: the command's tool with a one-line description and bare property schemas. */
function coreTool(c: CommandSpec, description: string): Tool {
  const t = commandTool(c);
  const properties: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(t.def.inputSchema.properties)) {
    const { description: _d, default: _x, ...bare } = v;
    properties[k] = bare;
  }
  return { ...t, def: { name: t.def.name, description, inputSchema: { ...t.def.inputSchema, properties } } };
}

const RUN_TOOL: Tool = {
  def: {
    name: RUN,
    description: 'run any tabcap command: argv as on the command line without "tabcap", e.g. ["analyze","deps","./b"]',
    inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"], additionalProperties: false },
  },
  command: null,
  bindings: [],
};

const HELP_TOOL: Tool = {
  def: {
    name: HELP,
    description: 'list the commands, or one command\'s usage, options and schema (command: "net list"); task recipes: guide ("" lists)',
    inputSchema: { type: "object", properties: { command: { type: "string" }, guide: { type: "string" } }, additionalProperties: false },
  },
  command: null,
  bindings: [],
};

export type ToolSet = "core" | "all";

/** core: CORE in table order, tabcap_handoff_wait, tabcap_run, tabcap_help; all: every command in table order, then tabcap_handoff_wait. */
export function buildTools(set: ToolSet = "core"): Tool[] {
  if (set === "all") return [...COMMANDS.filter((c) => c.internal !== true && EXCLUDED[c.path.join(" ")] === undefined).map(commandTool), HANDOFF_WAIT_TOOL];
  const core = COMMANDS.flatMap((c) => {
    const d = CORE[c.path.join(" ")];
    return d === undefined ? [] : [coreTool(c, d)];
  });
  return [...core, HANDOFF_WAIT_TOOL, RUN_TOOL, HELP_TOOL];
}

const runnable = (c: CommandSpec): boolean => c.internal !== true && (EXCLUDED[c.path.join(" ")] === undefined || c.path.join(" ") === "schema");

/** How an MCP client reaches a command in the core set: its own tool, tabcap_run, or not at all (null). */
const viaOf = (c: CommandSpec): string | null => (CORE[c.path.join(" ")] !== undefined ? toolName(c) : runnable(c) ? RUN : null);

/** tabcap_run: the CLI's run() on the given argv, refusing what would break the stdio channel. */
export async function runArgv(run: RunFn, args: Record<string, unknown>): Promise<Envelope<unknown>> {
  for (const k of Object.keys(args)) if (k !== "argv") throw badArgs(RUN_TOOL, `unknown argument ${k}`);
  const raw = args["argv"];
  if (!Array.isArray(raw) || !raw.every((x): x is string => typeof x === "string")) throw badArgs(RUN_TOOL, "argv must be an array of strings");
  const argv = raw[0] === "tabcap" ? raw.slice(1) : raw;
  if (argv.length === 0) throw badArgs(RUN_TOOL, "argv is empty");
  const c = matchCommand(argv.filter((a) => !a.startsWith("-")));
  if (c !== null && !runnable(c)) {
    const name = c.path.join(" ");
    throw new TabcapError("usage", `tabcap ${name} is not available over MCP: ${EXCLUDED[name] ?? "internal"}`, "Run it in a terminal yourself, or ask the human to.");
  }
  return run(argv, {});
}

/**
 * tabcap_help: the command list (name, usage, the tool that runs it), or one
 * command's help text and schema entry; with `guide` (0.7-A) the task guides
 * as `tabcap guide` prints them: "" lists them, an id gives one.
 */
export function helpOf(args: Record<string, unknown>): Envelope<unknown> {
  for (const k of Object.keys(args)) if (k !== "command" && k !== "guide") throw badArgs(HELP_TOOL, `unknown argument ${k}`);
  const q = args["command"];
  if (q !== undefined && typeof q !== "string") throw badArgs(HELP_TOOL, "command must be a string");
  const gq = args["guide"];
  if (gq !== undefined) {
    if (typeof gq !== "string") throw badArgs(HELP_TOOL, "guide must be a string");
    if (q !== undefined) throw badArgs(HELP_TOOL, "give command or guide, not both");
    return ok(gq.trim() === "" ? guideList() : guideOf(gq));
  }
  const listed = COMMANDS.filter((c) => c.internal !== true);
  if (q === undefined || q.trim() === "") {
    return ok({
      commands: listed.map((c) => ({ name: c.path.join(" "), usage: usageOf(c, COMMON_FLAGS), via: viaOf(c) })),
      note: `via: the tool that runs the command (${RUN} takes its argv); null: not available over MCP. Browser commands also take --session <name> and most --timeout <ms>. ${HELP} {command} gives one command in full; ${HELP} {guide: ""} lists the task recipes.`,
    });
  }
  const words = q.trim().replace(/^tabcap[ _]/, "").split(/[ _]+/);
  const c = listed.find((x) => x.path.length === words.length && x.path.every((w, i) => w === words[i]));
  if (c === undefined) throw new TabcapError("usage", `unknown command: ${q}`, `Call ${HELP} without a command for the list.`);
  const entry = schema().commands.find((x) => x.name === c.path.join(" ")) ?? null;
  return ok({ name: c.path.join(" "), via: viaOf(c), help: helpFor(c), schema: entry });
}

const badArgs = (tool: Tool, message: string): TabcapError =>
  new TabcapError("usage", message, tool.command === null ? `See the inputSchema of ${tool.def.name}.` : `See the inputSchema of ${tool.def.name} (command line: \`${usageOf(tool.command)}\`).`);

const typeOk = (v: unknown, type: "string" | "number" | "boolean" | "list"): boolean =>
  type === "list" ? Array.isArray(v) && v.every((x) => typeof x === "string") : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type;

const typeName = (type: "string" | "number" | "boolean" | "list"): string => (type === "list" ? "an array of strings" : `a ${type}`);

/** The argv (and run options) of one tool call; throws a `usage` TabcapError for arguments that do not fit the schema. */
export function argvFor(tool: Tool, args: Record<string, unknown>): { argv: string[]; opts: RunOptions } {
  const c = tool.command;
  if (c === null) throw new TabcapError("internal", `${tool.def.name} is not a command`, "This is a bug.");
  for (const k of Object.keys(args)) if (!tool.bindings.some((b) => b.prop === k)) throw badArgs(tool, `unknown argument ${k}`);
  const flags: string[] = [];
  const pos: string[] = [];
  const opts: RunOptions = {};
  for (const b of tool.bindings) {
    const v = args[b.prop];
    if (v === undefined) {
      if (b.to !== "opt" && b.required) throw badArgs(tool, `missing ${b.prop}`);
      continue;
    }
    if (b.to === "pos") {
      if (b.list ? !typeOk(v, "list") : typeof v !== "string") throw badArgs(tool, `${b.prop} must be ${b.list ? "an array of strings" : "a string"}`);
      const vals = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
      if (b.list && b.required && vals.length === 0) throw badArgs(tool, `${b.prop} needs at least one value`);
      if (b.choices !== null && !vals.every((x) => b.choices?.includes(x) === true)) throw badArgs(tool, `${b.prop} must be one of ${b.choices.join(", ")}`);
      pos.push(...vals);
    } else if (b.to === "flag") {
      if (!typeOk(v, b.type)) throw badArgs(tool, `${b.prop} must be ${typeName(b.type)}`);
      if (typeof v === "boolean") {
        if (v) flags.push(b.flag);
      } else if (Array.isArray(v)) {
        for (const x of v) flags.push(`${b.flag}=${String(x)}`);
      } else flags.push(`${b.flag}=${String(v)}`);
    } else {
      if (!typeOk(v, b.type)) throw badArgs(tool, `${b.prop} must be ${typeName(b.type)}`);
      if (b.key === "session" && typeof v === "string") opts.session = v;
      if (b.key === "timeoutMs" && typeof v === "number") opts.timeoutMs = v;
    }
  }
  // `--` keeps a positional that starts with "-" from being read as an option.
  return { argv: [...c.path, ...flags, ...(pos.some((p) => p.startsWith("-")) ? ["--"] : []), ...pos], opts };
}

/** The tools/call result for one envelope: the envelope itself, pretty-printed, as the only content item. */
export function resultOf(env: Envelope<unknown>): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(env, null, 2) }], isError: !env.ok };
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

/**
 * tabcap_handoff_wait: poll `handoff status` once a second until the session
 * is no longer `waiting` (the human ran `handoff continue`, or a challenge
 * handler answered) or the time is up; then the `waiting` error again.
 */
export async function handoffWait(run: RunFn, clock: Clock, args: Record<string, unknown>): Promise<Envelope<unknown>> {
  for (const k of Object.keys(args)) if (k !== "session" && k !== "timeoutSeconds") throw badArgs(HANDOFF_WAIT_TOOL, `unknown argument ${k}`);
  const session = args["session"];
  const t = args["timeoutSeconds"] ?? HANDOFF_WAIT_DEFAULT_S;
  if (session !== undefined && typeof session !== "string") throw badArgs(HANDOFF_WAIT_TOOL, "session must be a string");
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > HANDOFF_WAIT_MAX_S) throw badArgs(HANDOFF_WAIT_TOOL, `timeoutSeconds must be a number from 0 to ${HANDOFF_WAIT_MAX_S}`);
  const argv = ["handoff", "status", ...(session === undefined ? [] : [`--session=${session}`])];
  const started = clock.now();
  const deadline = started + t * 1000;
  for (;;) {
    const env = await run(argv, {});
    if (!env.ok) return env;
    const data = isRecord(env.data) ? env.data : {};
    if (data["state"] !== "waiting") return env;
    const left = deadline - clock.now();
    if (left <= 0) {
      const name = typeof data["session"] === "string" ? data["session"] : (session ?? "default");
      return fail("waiting", `session "${name}" is still waiting for the human after ${t} s`, `The human has not continued yet: call ${HANDOFF_WAIT} again to keep waiting, or ask the human to complete the verification in the browser and run \`tabcap handoff continue\`; until then do not act on this site.`, {
        state: "waiting",
        waitedMs: clock.now() - started,
        handoff: data["handoff"] ?? null,
      });
    }
    await clock.sleep(Math.min(1000, left));
  }
}

/** Run one tools/call: the envelope, never a throw. */
export async function callTool(tool: Tool, args: Record<string, unknown>, run: RunFn, clock: Clock): Promise<Envelope<unknown>> {
  try {
    if (tool.def.name === HANDOFF_WAIT) return await handoffWait(run, clock, args);
    if (tool.def.name === RUN) return await runArgv(run, args);
    if (tool.def.name === HELP) return helpOf(args);
    const { argv, opts } = argvFor(tool, args);
    return await run(argv, opts);
  } catch (e) {
    return toFail(e);
  }
}
