// `tabcap plugin init --kind decode [<dir>] [--name <n>] [--force]` (0.7-D):
// write the decode plugin template (templates/plugins/decode-python/) into a
// directory, so an agent does not need to know where an install put the
// template. The five files are embedded into the binary at build time
// (`with { type: "text" }`), so this works for the release archive, the npm
// package and a source checkout alike; templates/ stays the source and
// test/unit/plugin-init.test.ts asserts the embedded texts equal the files.
//
// Plugins are only discovered as real directories named after the plugin
// under <config>/plugins/ (hooks/plugins.ts listPlugins), so with --name
// alone the plugin is written there; a <dir> elsewhere works too, and the
// answer then says to move it before `tabcap plugin enable`.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TabcapError } from "../shared/envelope.ts";
import { isRecord, tryParseJson } from "../shared/json.ts";
import { PLUGIN_NAME, pluginsDir } from "../daemon/hooks/plugins.ts";
import CONFIG_EXAMPLE_RAW from "../../templates/plugins/decode-python/config.example.json" with { type: "text" };
import MANIFEST_RAW from "../../templates/plugins/decode-python/manifest.json" with { type: "text" };
import PLUGIN_PY from "../../templates/plugins/decode-python/plugin.py" with { type: "text" };
import PYPROJECT from "../../templates/plugins/decode-python/pyproject.toml" with { type: "text" };
import RUNNER_PY from "../../templates/plugins/decode-python/runner.py" with { type: "text" };

/** Plugin kinds `plugin init` has a template for (no challenge-handler template exists). */
export const INIT_KINDS = ["decode"] as const;
/** The template's own name in its manifest.json, replaced by the plugin's name. */
const TEMPLATE_NAME = "decode-python";

/**
 * TypeScript types a `.json` import as the parsed value even under
 * `with { type: "text" }`; Bun hands over the text. Checked, not cast.
 */
function textOf(v: unknown, file: string): string {
  if (typeof v !== "string") throw new TabcapError("internal", `embedded template ${file} is not text`, "This is a bug: rebuild tabcap.");
  return v;
}

/** The decode template's files as shipped in templates/plugins/decode-python/, by file name. */
export const DECODE_TEMPLATE: Readonly<Record<string, string>> = {
  "config.example.json": textOf(CONFIG_EXAMPLE_RAW, "config.example.json"),
  "manifest.json": textOf(MANIFEST_RAW, "manifest.json"),
  "plugin.py": PLUGIN_PY,
  "pyproject.toml": PYPROJECT,
  "runner.py": RUNNER_PY,
};

/** manifest.json of the template with `name` set; the rest of the text stays as shipped. */
export function manifestFor(name: string): string {
  const text = DECODE_TEMPLATE["manifest.json"] ?? "";
  const out = text.replace(`"name": ${JSON.stringify(TEMPLATE_NAME)}`, `"name": ${JSON.stringify(name)}`);
  const parsed = tryParseJson(out);
  if (!isRecord(parsed) || parsed["name"] !== name) throw new TabcapError("internal", "the embedded manifest.json did not take the plugin name", "This is a bug: rebuild tabcap.");
  return out;
}

export type PluginInitResult = {
  name: string;
  kind: "decode";
  dir: string;
  /** True when `dir` is <config>/plugins/<name>, where `plugin list` / `plugin enable` find it. */
  installed: boolean;
  /** Files written by this run (relative to `dir`). */
  files: string[];
  /** Files that existed and were left alone (config.json is never overwritten). */
  kept: string[];
  next: string;
};

/**
 * Write the template. `args`: kind (required, "decode"), dir (optional
 * positional, relative to `cwd`), name, force. Without `dir` the plugin goes to
 * <configDir>/plugins/<name>/; without --name the name is the directory's basename.
 */
export function pluginInit(configDir: string, args: Record<string, unknown>, cwd: string): PluginInitResult {
  const kind = args["kind"];
  if (kind !== "decode") {
    throw new TabcapError(
      "usage",
      `--kind ${typeof kind === "string" ? JSON.stringify(kind) : "is missing"}: plugin init has a template only for ${INIT_KINDS.join(", ")}`,
      "Pass --kind decode (challenge handlers have no template: write their manifest.json by hand, docs/04 §18).",
    );
  }
  const rawDir = typeof args["dir"] === "string" && args["dir"] !== "" ? args["dir"] : null;
  const rawName = typeof args["name"] === "string" && args["name"] !== "" ? args["name"] : null;
  const root = pluginsDir(configDir);
  if (rawDir === null && rawName === null) throw new TabcapError("usage", "plugin init needs a directory or --name", `Pass --name <name> to write it to ${join(root, "<name>")}, or a directory.`);
  const dir = rawDir === null ? join(root, rawName ?? "") : resolve(cwd, rawDir);
  const name = rawName ?? basename(dir);
  if (!PLUGIN_NAME.test(name)) {
    throw new TabcapError(
      "usage",
      `plugin name ${JSON.stringify(name)} is not valid: lowercase letters, digits, '_' or '-', starting with a letter or digit (max 64)`,
      rawName === null ? "Pass --name <name>, or a directory whose name is valid." : "Pick another --name.",
    );
  }
  const installed = resolve(dir) === resolve(root, name);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new TabcapError("conflict", `${dir} exists and is not a directory`, "Pick another directory.");
    const entries = readdirSync(dir);
    if (entries.length > 0 && args["force"] !== true) {
      throw new TabcapError(
        "conflict",
        `${dir} is not empty (${entries.length} entries)`,
        "Pick an empty or new directory, or pass --force to rewrite the template files (config.json is never overwritten; other files are left alone).",
      );
    }
  } else {
    // 0700 like the plugins directory itself: a plugin directory others can write to is refused (hooks/plugins.ts).
    if (installed) mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const files: string[] = [];
  const kept: string[] = [];
  for (const [file, text] of Object.entries(DECODE_TEMPLATE)) {
    writeFileSync(join(dir, file), file === "manifest.json" ? manifestFor(name) : text);
    files.push(file);
  }
  // The plugin's own config (its keys): created from the example only when absent, never overwritten, 0600.
  const config = join(dir, "config.json");
  if (existsSync(config)) kept.push("config.json");
  else {
    writeFileSync(config, DECODE_TEMPLATE["config.example.json"] ?? "", { flag: "wx", mode: 0o600 });
    files.push("config.json");
  }
  files.sort();
  const edit = `edit plugin.py (decode()), config.json (its key) and manifest.json "match" (the template matches the test range's 127.0.0.1 /s42/api/*)`;
  const enable = `run \`tabcap plugin enable ${name}\` (\`tabcap plugin list\` shows errors; the command is \`uv run\`, without uv set manifest.json "command" to ["python3", "runner.py"])`;
  const next = installed
    ? `1) ${edit}; 2) ${enable}.`
    : `1) ${edit}; 2) move this directory to ${join(root, name)} (tabcap loads plugins only from there, as a real directory, not a symlink), then ${enable}.`;
  return { name, kind: "decode", dir, installed, files, kept, next };
}
