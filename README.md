# tabcap

English | [中文](README.zh-CN.md)

**A browser for AI agents that stays out of your way, records everything, and hands over to you when it should.**

tabcap gives an agent its own Chrome, in background tabs that never take your screen. Every request is recorded with its body. When a login, a captcha or a judgement call comes up, the session is handed to you and the agent waits. Afterwards the recording is something you can search, diff, replay and turn into code.

It is built for one job: working out how a site's traffic works so that your scraper can reproduce it. It is not an unattended scraping platform.

Status: 0.8.1, alpha. Used daily on macOS arm64; Linux x64 and Windows x64 run in CI with known gaps; Linux arm64 is built but untested. Apache-2.0.

## Why

Most agent browsers start from "give the agent a clean, isolated browser and let it run". Real data-collection work does not look like that. You log in and walk the flow first. The agent gets stuck on a verification page. Somebody has to confirm that *this* request carries the data and *that* parameter is a signature.

tabcap is the workbench for that loop. The agent explores and repeats; you provide the credentials, pass the checks and confirm the conclusions; everything is recorded, so each conclusion can be replayed and checked later.

## Install

- **npm** (any platform, Node 18 or newer): `npm install -g tabcap`. The binary for your platform comes as an optional dependency; every release is published from CI with provenance. Later: `tabcap update`.
- **Homebrew** (macOS arm64, Linux x64 and arm64): `brew install 1A7432/tabcap/tabcap`. The formula follows every release; later: `tabcap update` (it runs `brew upgrade tabcap`).
- **Release packages**: `tabcap-v<version>-darwin-arm64.tar.gz`, `-linux-x64.tar.gz`, `-linux-arm64.tar.gz` or `-windows-x64.zip` from the [release page](https://github.com/1A7432/tabcap/releases), checksums in `SHA256SUMS`; unpack and put `tabcap` (`tabcap.exe` on Windows) on your `PATH`. On macOS, after a browser download, run `xattr -d com.apple.quarantine tabcap` once.
- **From source**: Bun 1.4.3 or newer (CI uses the version in `.bun-version`) and Zig 0.16.0; `bun install && bun scripts/native.ts build` (the wire component tabcap embeds), then `bun run build`.

Then `tabcap setup` downloads Chrome for Testing (about 180 MB) into `~/.cache/tabcap`; nothing else is needed.

**Agents with a command sandbox** (Cursor's Auto-review run mode, Codex's `workspace-write`, Claude Code with `/sandbox`, Gemini CLI with `--sandbox`): Chrome cannot create its own sandbox inside theirs, and `tabcap browser start` says so. Let tabcap run outside it: put `tabcap` on the host's allowlist or excluded commands, or connect it as an MCP server (`tabcap mcp --print-config <host>`; Claude Code and Codex start MCP servers outside their sandbox, Gemini CLI inside it). Never `--no-sandbox`.

## Quick start

**1. Get a browser and start.**

```sh
tabcap setup                                 # downloads Chrome for Testing into ~/.cache/tabcap, asks nothing
tabcap daemon start && tabcap browser start  # the daemon and its own Chrome, separate profile
```

**2. Open a page and look around.**

```sh
tabcap navigate https://example.com         # opens in a background tab and waits until ready
tabcap snapshot --interactive               # the page's controls as a tree with refs (e12)
tabcap click e12                            # click by ref; waits for the navigation to settle
tabcap fill e7 alice                        # password fields show <masked> in every output
tabcap screenshot                           # saves a PNG and prints its path
```

**3. Record what the page calls.**

```sh
tabcap net start                            # records requests, bodies, WebSocket frames, console
tabcap click e9
tabcap net list --resource-types xhr,fetch  # the API calls, oldest first
tabcap net body r-11                        # one response body
tabcap net stop                             # the recording is a bundle under ~/.local/share/tabcap
tabcap daemon stop
```

Every command prints one JSON envelope on stdout: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","next"}}`. When a command fails, do what `next` says. `tabcap --help` lists the commands by group; `tabcap <command> --help` shows the options and an example.

**Give it to an agent.** The skill lives in `skills/tabcap/` (`SKILL.md` plus `references/`, no scripts). Copy it to `~/.claude/skills/tabcap/` for Claude Code (it also reads `~/.agents/skills/tabcap/`), or into the skills directory of Hermes Agent or another host. For hosts that speak MCP instead: `claude mcp add tabcap -- tabcap mcp`; `tabcap mcp --print-config <host>` prints the entry for Cursor, Codex, Gemini CLI, Windsurf (untested) and Claude Desktop. Then ask the agent: "open this page with tabcap and show me which APIs it calls". `tabcap guide` lists the task recipes an agent can follow (first look, scraping through the logged-in tab, encrypted sites, offline replay, login with a challenge); `tabcap status` shows everything that is going on and what is in conflict.

## What it does

- **Never takes your screen.** Tabs open in the background. Input that needs focus uses Chrome's focus emulation for the length of one command. A popup that grabs the foreground is handed back. Only an explicit `tab select --bring-to-front` brings a tab forward.
- **Records traffic as evidence.** `net start` writes requests, response bodies, WebSocket frames, console output and the command timeline into a bundle. Export it as HAR (redacted by default), import a HAR recorded elsewhere, or read it while it records with `net list`, `net show`, `net body` and `net wait`.
- **Keeps credentials away from the model.** Sites, accounts and passwords live in a local store (`tabcap site add`, typed at a prompt or piped in). The agent writes references only (`fill e6 --secret example.password`), and every known secret value is replaced with `<secret:…>` in all output, logs and bundle events.
- **Hands over instead of pushing through.** One login attempt per site and session. A verification page puts the session into `waiting` with a screenshot until you finish in the browser and run `tabcap handoff continue`. The same happens when you click, type or scroll in the agent's tab yourself: tabcap notices your input and the agent waits until you say you are done. Or the agent sets a condition beforehand (the URL after login, a cookie the login sets) and the handoff ends by itself once it becomes true (`tabcap handoff wait --until-url`). tabcap ships no captcha or challenge solvers; a plugin interface loads handlers you write yourself.
- **Lets your scraper send through the logged-in tab.** `tabcap fetch <url>` sends a request from the page itself, with its cookies and its CORS rules, records it and tags it so that concurrent requests never mix. Requests to one host are paced (3 s by default, no flag to skip it). Stop rules such as `status>=400` or `json:$.code!=0` stop the site until `tabcap guard resume`. A Python scraper can do the same over the daemon's socket.
- **Works offline from the recording.** `analyze find` and `where` trace a value the page shows back to the response that carries it, through decoders and normalisation. `analyze deps` and `analyze chain` show where each request input came from and which requests a reproduction needs. `analyze diff` classifies parameters across recordings; `analyze shape` and `schema-diff` describe endpoint shapes and their drift. `replay export-python` turns a chain into an httpx client with tests; `replay serve` answers from a bundle; `replay check` compares a live run field by field; `bundle export fixtures` writes one fixture per exchange for the test harness you already have.
- **Reads encrypted bodies through your own code.** A decode plugin is a process of yours speaking JSON lines, with its keys in its own config; it turns encoded or encrypted bodies into plaintext views that `find`, `where`, `deps` and `replay check` read. When the page itself decrypts in JS, `trace start --decode` observes what the page hands to `JSON.parse` and files that plaintext against its response, marking the link as strong or weak.
- **Hands the session to a script.** `session export --for requests|httpx|playwright` writes the cookies, the auth headers the page actually sent and the local storage to a 0600 file, so your own script does the volume.
- **Says what it measured.** Request inputs are traced by exact match only; anything else is marked `computed-in-page`. The diagnostic probes (the signals this browser presents; the TLS, HTTP/2 and header order of a generated client against the browser's) say which layer differs, never why a site refused you or how to change a value.

## Commands

The commands come in groups; `tabcap help <group>` lists one, for example `tabcap help network`. The groups marked *experimental* may change or break between releases; the rest is used daily and covered by the end-to-end suite.

| Group | Commands |
|---|---|
| Start here | `guide` (task recipes: the commands in order, why, the pitfalls), `status` (everything in one answer, with conflicts and what to do) |
| Lifecycle | `setup`, `update`, `daemon start/stop/status`, `browser start/stop/status`, `mcp` |
| Sites, sessions, tabs | `site`, `account`, `proxy` (*experimental*), `session start/stop/list/export`, `tab list/select/new/close` |
| Page | `navigate`, `go`, `reload`, `snapshot`, `outline`, `find`, `wait`, `html` |
| Input | `click`, `hover`, `fill`, `type`, `press-key`, `upload`, `dialog` |
| Page tools | `evaluate`, `screenshot`, `resize`, `emulate`, `console list/show` |
| Network | `net start/stop/list/show/body/grep/wait`, `fetch`, `where`, `recon` (*experimental*) |
| Handoff | `handoff status/continue`, `guard resume`, `plugin init/list/enable/disable` |
| Offline | `bundle export/import/redact/info/decode`, `analyze find/diff/deps/chain/shape/schema-diff/recon`, `replay serve/check/session/export-python`, `schema` |
| Diagnostics (*experimental*) | `trace`, `fingerprint`, `wire` |

The full reference with every option is [`skills/tabcap/references/commands.md`](skills/tabcap/references/commands.md); `tabcap schema --json` is the machine-readable form. Where the two overlap, names follow Chrome DevTools MCP (`press-key`, `tab list`, `console list`, `--page-size` …).

## How it compares

Several tools turn recorded browser traffic into something an agent can call: Integuru has an LLM build a request dependency graph from a HAR and generate Python; agent-browser's derive-client skill has the agent read a HAR and write a client; Unbrowse compiles a site's first-party requests into hosted MCP tools; Playwright `routeFromHAR` and VCR.py replay recordings inside tests. tabcap works on the recording itself, traces every request input deterministically, and keeps the human in the loop.

| | tabcap | Integuru | derive-client | Unbrowse | HAR replay¹ |
|---|---|---|---|---|---|
| Records the browser session | ✓ | ✓ | ✓ | ✓ (its cloud browser) | ✓ (Playwright) |
| Request inputs traced to their source | ✓ exact match | LLM-inferred | LLM-inferred | – | – |
| Generates a new client | ✓ (httpx) | ✓ (Python) | ✓ | MCP tools | – |
| Serves recorded responses to existing code | ✓ (`replay serve`) | – | – | – | ✓ (in tests) |
| Replay check against the server, field by field | ✓ | – | the agent compares shapes | ✓ (hosted) | – |
| Nested / cross-origin iframes | ✓ | – | partial² | – | – |
| Encrypted bodies | flagged; decode plugins | – | – | – | – |
| Login / verification handed to the human | ✓ | before recording | before recording | ✓ | – |
| Live requests paced per site | ✓ | – | advised | – | – |
| MCP | ✓ | – | ✓ (agent-browser) | ✓ | – |
| Runs | locally | locally + OpenAI API | locally | hosted | locally |

✓: in the product's own docs, or reproduced on tabcap's local test pages. LLM-inferred: the docs give that step to an LLM or to the agent. –: not described in the public docs as read; not a claim that it cannot. ¹ Playwright `routeFromHAR`, VCR.py. ² agent-browser on the local test pages: the cross-origin frame was reachable, the depth-3 frame was not with the commands tried, and its HAR lacked that frame's document and the bodies of the cross-origin frames. Sources and reproduction: [docs/12](docs/12-comparison.md), read on 2026-10-16.

## Boundaries

- Not an unattended scraping platform and not a cloud browser.
- Signature-like parameters and encrypted bodies are not reproduced. Generated clients mark them as TODOs; those requests stay in the real browser session.
- Meant for analysing and debugging your own sessions on sites you are allowed to use, within the site's terms and the law that applies to you; it is an analysis tool, not a way around a site's protections. The repository's tests run only against local pages.
- The credential store is plain text protected by file permissions (a 0600 file in a 0700 directory, like `~/.netrc`). Prefer test accounts.

## Platforms

| | Status | Notes |
|---|---|---|
| macOS arm64 | used daily; the full end-to-end suite | popup foreground hand-back uses osascript |
| Linux x64 | CI; end-to-end under Xvfb | Chrome's sandbox needs unprivileged user namespaces (Ubuntu 23.10 and later: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`); on a throttled background tab, `click --trusted` and `hover` hold a tiny screencast while the mouse moves |
| Windows x64 | CI; unit tests, end-to-end in part | the daemon listens on 127.0.0.1 with a random port and a per-start token in `daemon.json`; a normal Chrome window appears with the first tab and there is no foreground hand-back; no POSIX permission checks |
| Linux arm64 | cross-compiled, never run | |

Files: `~/.config/tabcap/` (config, credential store, plugins, socket, log), `~/.cache/tabcap/` (the browser), `~/.local/share/tabcap/` (screenshots, bundles). `XDG_*` is honoured on Linux; on Windows all three live under `%LOCALAPPDATA%\tabcap\`. `TABCAP_HOME` moves everything into one directory.

Channels: npm (`tabcap` plus one package per platform, published from CI on a `v*` tag), the Homebrew tap [`1A7432/homebrew-tabcap`](https://github.com/1A7432/homebrew-tabcap) (CI pushes the formula, rendered from `packaging/homebrew/`, for every published release) and the release packages; a Scoop manifest is under `packaging/scoop/`, no bucket yet.

## Documentation

- [`skills/tabcap/`](skills/tabcap/): the agent skill, `SKILL.md` and references for recording, search, analysis, replay, pools, MCP and tracing.
- [`docs/`](docs/) (Chinese): the evidence bundle format (`04`), the local test pages (`05`), acceptance tests (`06`), architecture and CDP notes (`07`), implementation plan (`08`), recon (`09`), input fidelity (`10`), the wire fingerprint component (`11`), the comparison with similar tools (`12`), proxies and interop (`13`), protection families and their sources (`14`), the open verifications and inferences still to check (`15`).
- [`CHANGELOG.md`](CHANGELOG.md): changes per release.
- Contributing: `AGENTS.md` (rules for AI collaborators), `NOTES.md` (one entry per unit of work; the last one is where the next starts), `docs/03` (thesis and roadmap). `bun test test/unit` runs the offline tests; `bun run test:e2e` needs a Chrome for Testing.

## License

Apache-2.0. `NOTICE` lists the Apache-2.0 code this project derives from.
