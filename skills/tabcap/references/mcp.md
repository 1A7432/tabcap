# tabcap over MCP

For hosts that speak the Model Context Protocol instead of running commands (Cursor, Codex, Gemini CLI, Windsurf, Claude Desktop; Claude Code works either way), `tabcap mcp` serves tabcap as MCP tools on stdin / stdout and returns the same JSON envelopes as the CLI.

- Default tool set: 24 core tools (sessions, navigate, snapshot, outline, click, fill, type, press-key, hover, wait, screenshot, evaluate, net start / stop / list / show / body, status, handoff continue) plus `tabcap_handoff_wait` (polls the handoff for up to 300 s), `tabcap_run` (`{argv}`: any other command, same validation) and `tabcap_help` (`{command?}`: the help of one command on demand; `{guide?}`: the task guides of `tabcap guide`, `""` lists them, an id gives one). `tabcap mcp --all-tools` exposes one tool per command instead (about 58 KB of definitions; use only when the host can afford it).
- `waiting` (handoff) is never blocking: the envelope comes back with the `waiting` error and its `next`; call `tabcap_handoff_wait` or ask the human.
- Not exposed as tools: `site add`, `account add`, `proxy add` (they read a password from stdin, which is the MCP channel — the human runs them in a shell), the three foreground servers (`replay serve`, `wire serve`, `fingerprint serve`) and `mcp` itself.
- Host config: `tabcap mcp --print-config <claude-code|cursor|codex|gemini-cli|windsurf|claude-desktop>` prints the file, the entry and the host's own add command (Claude Code: `claude mcp add tabcap -- tabcap mcp`).
- The output filters (`--select`, `--grep`, `--fields`) and `--full` are ordinary arguments, so they work through `tabcap_run` too.
