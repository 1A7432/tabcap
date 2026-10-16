// `tabcap mcp --print-config <host>`: where and how each MCP host registers a
// stdio server. Every entry was checked against the host's official
// configuration page on 2026-10-16 (WebFetch); the URLs are in `docs` below.
// `verified: false` marks an entry the current official page did not confirm
// (【待验】 in the docs).
//
//   claude-code     https://code.claude.com/docs/en/mcp
//                   `claude mcp add [options] <name> -- <command> [args...]`;
//                   scopes local (default) / project (.mcp.json) / user; an
//                   entry without `type` is a stdio server.
//   cursor          https://cursor.com/docs/context/mcp
//                   ~/.cursor/mcp.json (global), .cursor/mcp.json (project);
//                   stdio fields type "stdio", command, args, env.
//   codex           https://developers.openai.com/codex/mcp
//                   (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
//                   ~/.codex/config.toml (or .codex/config.toml in a trusted
//                   project), table [mcp_servers.<name>] with command, args;
//                   tool_timeout_sec defaults to 60; `codex mcp add <name> -- <command>`.
//   gemini-cli      https://geminicli.com/docs/tools/mcp-server/
//                   ~/.gemini/settings.json (user), .gemini/settings.json
//                   (project, the default scope of `gemini mcp add`);
//                   `gemini mcp add [options] <name> <commandOrUrl> [args...]`;
//                   no underscores in server names; stdio servers connect in
//                   trusted folders only.
//   windsurf        https://docs.windsurf.com/windsurf/cascade/mcp
//                   redirects (307) to https://docs.devin.ai/desktop/cascade/mcp,
//                   which names the product Devin Desktop and the file
//                   ~/.config/devin/mcp_config.json; not confirmed for
//                   Windsurf itself → verified: false.
//   claude-desktop  https://modelcontextprotocol.io/docs/develop/connect-local-servers
//                   ~/Library/Application Support/Claude/claude_desktop_config.json
//                   (macOS), %APPDATA%\Claude\claude_desktop_config.json (Windows);
//                   mcpServers.<name>.command / args; restart the app after editing.

import { TabcapError } from "../shared/envelope.ts";

export const MCP_HOSTS = ["claude-code", "cursor", "codex", "gemini-cli", "windsurf", "claude-desktop"] as const;
export type McpHost = (typeof MCP_HOSTS)[number];

export type HostConfig = {
  host: McpHost;
  /** Config files, most common first. */
  files: { scope: string; path: string }[];
  /** `json`: `config` is the object to merge into the file; `toml`: `config` is the text to add to it. */
  format: "json" | "toml";
  config: Record<string, unknown> | string;
  /** The host's own command that registers the server, when it has one. */
  command: string | null;
  docs: string[];
  /** The official page confirmed file and format on 2026-10-16. */
  verified: boolean;
  notes: string[];
};

const SERVER = { command: "tabcap", args: ["mcp"] };
const PATH_NOTE = "`command` is looked up on the PATH the host itself was started with; if the host does not find tabcap, put its absolute path (`command -v tabcap`) there.";

const isHost = (h: string): h is McpHost => MCP_HOSTS.some((x) => x === h);

export function hostConfig(host: string): HostConfig {
  if (!isHost(host)) throw new TabcapError("usage", `unknown MCP host: ${host}`, `Use one of: ${MCP_HOSTS.join(", ")}.`);
  switch (host) {
    case "claude-code":
      return {
        host,
        files: [{ scope: "project (claude mcp add --scope project)", path: ".mcp.json" }],
        format: "json",
        config: { mcpServers: { tabcap: { ...SERVER } } },
        command: "claude mcp add tabcap -- tabcap mcp",
        docs: ["https://code.claude.com/docs/en/mcp"],
        verified: true,
        notes: ["The command registers the server for you in the current project (scope local); add --scope user for every project, or --scope project to write .mcp.json.", PATH_NOTE],
      };
    case "cursor":
      return {
        host,
        files: [
          { scope: "global", path: "~/.cursor/mcp.json" },
          { scope: "project", path: ".cursor/mcp.json" },
        ],
        format: "json",
        config: { mcpServers: { tabcap: { type: "stdio", ...SERVER } } },
        command: null,
        docs: ["https://cursor.com/docs/context/mcp"],
        verified: true,
        notes: [PATH_NOTE],
      };
    case "codex":
      return {
        host,
        files: [
          { scope: "user", path: "~/.codex/config.toml" },
          { scope: "project (trusted projects only)", path: ".codex/config.toml" },
        ],
        format: "toml",
        config: '[mcp_servers.tabcap]\ncommand = "tabcap"\nargs = ["mcp"]\n',
        command: "codex mcp add tabcap -- tabcap mcp",
        docs: ["https://developers.openai.com/codex/mcp", "https://learn.chatgpt.com/docs/extend/mcp?surface=cli"],
        verified: true,
        notes: ["tool_timeout_sec defaults to 60: keep tabcap_handoff_wait timeoutSeconds below it, or raise it in the [mcp_servers.tabcap] table.", PATH_NOTE],
      };
    case "gemini-cli":
      return {
        host,
        files: [
          { scope: "user (gemini mcp add -s user)", path: "~/.gemini/settings.json" },
          { scope: "project (the default of gemini mcp add)", path: ".gemini/settings.json" },
        ],
        format: "json",
        config: { mcpServers: { tabcap: { ...SERVER } } },
        command: "gemini mcp add tabcap tabcap mcp",
        docs: ["https://geminicli.com/docs/tools/mcp-server/"],
        verified: true,
        notes: ["Gemini CLI connects stdio servers only in trusted folders (`gemini trust`).", PATH_NOTE],
      };
    case "windsurf":
      return {
        host,
        files: [
          { scope: "macOS / Linux", path: "~/.config/devin/mcp_config.json" },
          { scope: "Windows", path: "%APPDATA%\\devin\\mcp_config.json" },
        ],
        format: "json",
        config: { mcpServers: { tabcap: { ...SERVER } } },
        command: null,
        docs: ["https://docs.windsurf.com/windsurf/cascade/mcp", "https://docs.devin.ai/desktop/cascade/mcp"],
        verified: false,
        notes: ["Unverified: Windsurf's MCP page now redirects to Devin Desktop's, which gives the paths above; an older Windsurf release may read a different mcp_config.json.", PATH_NOTE],
      };
    case "claude-desktop":
      return {
        host,
        files: [
          { scope: "macOS", path: "~/Library/Application Support/Claude/claude_desktop_config.json" },
          { scope: "Windows", path: "%APPDATA%\\Claude\\claude_desktop_config.json" },
        ],
        format: "json",
        config: { mcpServers: { tabcap: { ...SERVER } } },
        command: null,
        docs: ["https://modelcontextprotocol.io/docs/develop/connect-local-servers"],
        verified: true,
        notes: ["Quit and restart Claude Desktop after editing the file.", PATH_NOTE],
      };
  }
}
