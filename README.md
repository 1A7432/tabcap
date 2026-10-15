# tabcap

English | [中文](README.zh-CN.md)

A browser for AI agents that works next to you instead of taking over your screen: background tabs in a dedicated Chrome, pages read as accessibility trees with refs, every request recorded with its body, and a hand-off to the human whenever a login, a captcha or a judgement call needs one. Built for capturing and analysing web traffic, not for unattended automation.

Status: 0.3.0 in development (alpha). Tested on macOS arm64 only. Apache-2.0.

## Quick start

`tabcap` is a command-line tool plus a background daemon that owns its own Chrome for Testing (a separate profile). The agent works in background tabs that never take the macOS foreground; pages come back as accessibility trees with refs (`e12`) to click and fill; network requests are recorded with their bodies into an evidence bundle. 0.1.0 was released under the name `bbl`; only `TABCAP_*` environment variables are read.

1. **Get the binary**: download `tabcap-darwin-arm64` from the release, rename it to `tabcap` and put it on your `PATH` (after a browser download run `xattr -d com.apple.quarantine tabcap` first); or build it from this repository with `bun install && bun run build:darwin-arm64`.
2. **Get the browser**: `tabcap setup` downloads Chrome for Testing (Stable) from the official JSON endpoints into `~/.cache/tabcap/chrome/<version>/` and writes `~/.config/tabcap/config.json`. It never asks questions and can be run again. With a Chrome for Testing you already have: `tabcap setup --executable-path <binary>`.
3. **Start**: `tabcap daemon start && tabcap browser start`. Add `--proxy none` to keep the browser on 127.0.0.1 / localhost only; by default it follows the system proxy.

**Agent hosts**: the skill is `skills/tabcap/` (agentskills.io layout: `SKILL.md` plus `references/commands.md`, no scripts). For Claude Code copy it to `~/.claude/skills/tabcap/`; Claude Code and the DeepSeek harness also read `~/.agents/skills/tabcap/`; for Hermes Agent copy it into its skills directory. Then ask the agent to "open this page with tabcap and show me which APIs it calls".

**Other agents, or by hand**: every command prints one JSON envelope on stdout, `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","next"}}`; on failure do what `next` says.

```sh
tabcap navigate http://127.0.0.1:8080/      # open in a background tab and wait until ready
tabcap snapshot --interactive               # the controls, with refs (e12)
tabcap click e12                            # DOM click; returns after the navigation and DOM settle; --trusted for real mouse events
tabcap fill e7 alice                        # fill a field; password values are <masked> in every output
tabcap net start; tabcap click e9; tabcap net list --resource-types xhr,fetch; tabcap net body r-11
tabcap screenshot                           # returns the image path only
tabcap --help                               # every command; tabcap <command> --help for options and an example
tabcap daemon stop                          # close the browser, finish recordings, exit
```

Command and option names follow Chrome DevTools MCP (`press-key`, `tab list` / `tab select`, `console list` / `console show`, `--page-size` / `--page-idx`, `--file-path` …); the old names keep working until 0.4. Commands (`--session` and `--timeout` left out; `tabcap <command> --help` shows every option, `skills/tabcap/references/commands.md` is the full reference, `tabcap schema --json` the machine-readable one):

<!-- BEGIN GENERATED: commands (from src/cli/commands.ts; run `bun run gen:docs`) -->
| Command | What it does |
|---|---|
| `tabcap setup [--executable-path path] [--platform platform]` | download Chrome for Testing (Stable) into the cache and record it in config.json |
| `tabcap daemon start` | start the background daemon |
| `tabcap daemon stop` | stop the daemon (closes the browser, finishes recordings) |
| `tabcap daemon status` | daemon and browser status, open recordings |
| `tabcap browser start [--proxy mode] [--foreground] [--executable-path path]` | launch the dedicated Chrome for Testing (own profile, CDP over a pipe) |
| `tabcap browser stop` | close the browser (recordings are finished first) |
| `tabcap browser status` | browser status |
| `tabcap site add <name> --url <entry> --user <username> [--domains a,b] [--notes text] [--password-stdin]` | add a site and its account to the local store (state.db, 0600); for the human, not the AI: the password is typed at a prompt or piped, never passed as an argument |
| `tabcap site list` | stored sites: name, entry URL, domains, usernames and the secret references to use (never secret values) |
| `tabcap site remove <name>` | delete a site with its accounts and guard counters from the store |
| `tabcap session start <name> [--site site]` | create a session (navigate also creates it); --site binds a stored site → entryUrl and the secret references |
| `tabcap session stop <name>` | close the session's own tabs (never tabs it did not open) and finish its recording |
| `tabcap session list` | list sessions |
| `tabcap navigate <url> [--tab t2] [--new-tab] [--no-wait]` | load a URL in the session's tab (opens a background tab if needed), wait until ready and the DOM is quiet → tab, url, title, readyState, nav |
| `tabcap tab list` | list the session's tabs (never other tabs): tab id, url, title, owned, popup opener, current |
| `tabcap tab select <tab> [--bring-to-front]` | make one of the session's tabs (e.g. a popup) its current tab for later commands; never brings it to the front unless --bring-to-front |
| `tabcap tab new <url> [--background] [--no-wait]` | open a new tab in the session, load a URL and make it the current tab (same as navigate --new-tab) |
| `tabcap tab close <tab>` | close one of the session's tabs |
| `tabcap go back\|forward [--tab t2] [--no-wait]` | history back / forward, waits until ready and the DOM is quiet |
| `tabcap reload [--tab t2] [--ignore-cache] [--no-wait]` | reload the current tab, waits until ready and the DOM is quiet |
| `tabcap snapshot [--tab t2] [--interactive] [--verbose] [--max-chars n] [--file-path path]` | accessibility tree as indented text, one element per line: role "name" [ref] flags (e.g. `- button "Save" [e12] disabled`); refs are for click / fill and expire when the document changes; starts with the overlay header (遮挡 / 识别到, counts toward --max-chars) |
| `tabcap outline [--tab t2] [--max-chars n]` | page map head: tab line, 遮挡 (overlays: dialogs, masks, iframe layers, timeout prompts, consent banners, with close-button refs), 识别到 (adapters detected, with confidence), 新窗口 (popups); read-only, never closes anything |
| `tabcap find <text> [--tab t2]` | search the accessibility tree (name, value, description); up to 20 hits with refs, clickable ones first |
| `tabcap click <ref> [--tab t2] [--trusted] [--dbl-click] [--no-wait] [--snapshot]` | click an element by ref (default: DOM el.click(), eventShape incomplete), then wait for a navigation it starts and for the DOM to settle; fails with `covered` when an overlay is in front (its close-button refs are in the error; tabcap never closes it) |
| `tabcap hover <ref> [--tab t2] [--no-wait] [--snapshot]` | move the mouse over an element by ref (trusted input via focus emulation: a mouse path ending on its centre; menus and tooltips open as for a real pointer); needs a painted tab |
| `tabcap fill <ref> [<text>] [--tab t2] [--trusted] [--secret site.field] [--confirm] [--no-wait] [--snapshot]` | set a text field's value, React-safe (password values are masked everywhere); --secret fills from the store, one password fill per site per session (guard.login-limit) |
| `tabcap type <text> [--tab t2] [--trusted] [--delay ms] [--insert] [--submit-key key] [--no-wait] [--snapshot]` | type into the element that has focus now (focus it first with click or fill). Default / --insert: one insertText, no key events (eventShape insert); --trusted: per-key events |
| `tabcap press-key <key> [--tab t2] [--no-wait] [--snapshot]` | press a key or a combination on the focused element: Enter, Tab, Escape, ArrowDown, a, Shift+Tab, Control+a, Control+Shift+R … (modifiers: Control, Shift, Alt, Meta) |
| `tabcap upload <ref> <files>... [--tab t2] [--snapshot]` | put local files into a file input by ref (DOM.setFileInputFiles); for an element that opens a file chooser instead, it is clicked and the chooser answered |
| `tabcap evaluate [<expression>] [--tab t2] [--await] [--function js] [--args json]` | run JavaScript in the page (an expression, or --function with --args) and return a JSON value (truncated at 60000 chars) |
| `tabcap screenshot [--tab t2] [--file-path path] [--full-page] [--format png\|jpeg\|webp] [--quality 0-100] [--ref e12]` | save an image of the tab, the full page or one element (works on background tabs) → path, width, height (never the image itself) |
| `tabcap resize <width> <height> [--tab t2]` | resize the tab's window so the page gets this content size in CSS px (other tabs in the same window change too) |
| `tabcap emulate [--tab t2] [--viewport WxHxDPR] [--user-agent ua] [--color-scheme dark\|light\|auto] [--network-conditions preset] [--cpu-throttling-rate n] [--geolocation lat,lon]` | emulate a device on the tab: viewport, user agent, colour scheme, network and CPU throttling, geolocation. Each call replaces all earlier settings of the tab: a setting left out is cleared |
| `tabcap dialog status\|accept\|dismiss [--tab t2] [--text text]` | status \| accept \| dismiss the JavaScript dialog blocking the tab (while one is open other commands fail with code dialog) |
| `tabcap net start` | record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle under ~/.local/share/tabcap/bundles/ |
| `tabcap net stop` | finish the recording (bundle manifest gets `finished`) |
| `tabcap net list [--filter s] [--host s] [--status code] [--method M] [--resource-types xhr,fetch] [--tab t2] [--since c-12] [--failed] [--no-failed] [--all] [--page-size n] [--page-idx n] [--kind http\|ws]` | recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, size, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); paged only when asked (--kind ws: WebSocket frames r-12:34) |
| `tabcap net body <id> [--out path]` | a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline) |
| `tabcap net show <id>` | one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame |
| `tabcap console list [--tab t2] [--types error,warn] [--level level] [--page-size n] [--page-idx n] [--limit n] [--include-stack-traces] [--clear]` | the tab's console, oldest first (last 500 messages, kept even when not recording): msgid, type, level, source, text (4 KB max), url:line:col |
| `tabcap console show <msgid> [--tab t2]` | one console message by msgid (from console list): text, arguments, location, stack trace |
| `tabcap wait [--tab t2] [--text text]... [--selector css] [--url s] [--idle [ms]] [--fn js]` | wait for one condition on the current tab; returns what matched, or error timeout naming what is still outstanding |
| `tabcap net wait --url <s> [--method M] [--tab t2] [--since c-12\|start] [--fresh]` | wait until a matching request finished with its body stored (needs net start). Counts requests since the start of the last action command (navigate, tab new, click, hover, fill, type, press-key, upload, go, reload, evaluate) → id, status, body path |
| `tabcap handoff status` | is the session handed to the human? state running \| waiting \| resumed, reason, screenshot, handler answers |
| `tabcap handoff continue` | end a waiting state after the human finished in the browser (run it only when they say so) |
| `tabcap plugin list` | challenge handlers installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, hooks, enabled, errors |
| `tabcap plugin enable <name>` | let the guard ask this handler before handing a challenge to the human |
| `tabcap plugin disable <name>` | stop asking this handler |
| `tabcap bundle export har <bundle> [--out file] [--tab t1] [--types xhr,fetch] [--embed-events] [--no-redact]` | export a bundle as HAR 1.2 (redacted by default) |
| `tabcap bundle import har <file> -o <bundle>` | import a HAR (DevTools, Charles, mitmproxy …) as a bundle, so analyze works on it |
| `tabcap bundle redact <in> <out>` | write a redacted copy of a bundle (the original is never changed) |
| `tabcap bundle info <bundle>` | bundle summary: counts, event kinds, finished or not, issues |
| `tabcap analyze find <bundle> <text> [--ignore-case] [--text] [--save]` | which request / WebSocket frame / console line carries this text, through a bounded decode chain (base64, gzip / br, urldecode, JSON, html entities …); 0 hits come with hints |
| `tabcap analyze diff <bundle1> <bundle2> [<bundles>] [--text] [--save]` | compare recordings of the same action: which parameters are constant, per session, timestamps or varying |
| `tabcap replay serve <bundle> [--port port] [--host host] [--strict h1,h2] [--match-cookies] [--json] [--once seconds]` | serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256; repeated matches cycle in recorded order (header x-tabcap-replay: r-N;n=k); no match → 404 with the nearest recordings and what differs |
| `tabcap replay session [<bundle>] --out <file> [--site site]` | write the recording's cookies (latest state snapshot), or with --site and no bundle the store's saved session, as a Playwright storageState file, mode 0600; it holds live session cookies, values are never printed |
| `tabcap replay export-python <bundle> --out <dir> [--include glob,glob] [--exclude glob,glob]` | generate an httpx client (one function per request group, TypedDict responses), fixtures and a pytest suite that runs against replay serve; signature-like parameters and encrypted bodies become NotImplementedError TODOs |
| `tabcap replay check <bundle> [--against url] [--live] [--rate n] [--site site] [--filter glob,glob] [--headers h1,h2] [--with-cookies] [--json]` | send every recorded request again and compare status, headers and body field by field with the recording; exit 1 on any difference |
| `tabcap schema [--json]` | this command table as JSON: names, arguments, flags with types and defaults, help, examples |

Deprecated aliases (removed in 0.4): `tabs` → `tab list`, `tab use` → `tab select`, `press` → `press-key`, `console` → `console list`
<!-- END GENERATED: commands -->

## What it is

Most agent browsers start from "give the agent a clean, isolated browser and let it run on its own". Real data-collection work does not look like that: you log in and walk the flow first, the agent gets stuck on verification pages, and somebody has to confirm that "this request carries the data and that parameter is a signature". tabcap is the workbench for that loop: the agent explores and repeats, the human provides credentials, passes challenges and confirms conclusions, and everything is recorded so that each conclusion can be replayed and checked.

## Five things it does differently

1. **It never takes your screen.** Tabs open in the background; input that needs focus uses Chrome's focus emulation for the length of one command; focus-stealing CDP calls are refused (only `tab select --bring-to-front`, asked for explicitly, brings a tab forward), and a popup that grabs the macOS foreground is handed back.
2. **It records the traffic as evidence.** `net start` writes requests, response bodies, WebSocket frames, console output and the command timeline into a bundle that exports to HAR (redacted by default); `net list`, `net show`, `net body` and `net wait` read it while it records.
3. **Credentials never reach the model.** Sites and passwords live in a local store the human fills in; the agent only writes references (`fill e6 --secret shop.password`), and every known secret value is replaced with `<secret:…>` in all output, logs and bundle events.
4. **It hands over instead of pushing through.** One login attempt per site and session; a verification page puts the session into `waiting` with a screenshot until the human finishes and runs `tabcap handoff continue`. tabcap ships no captcha or challenge solvers.
5. **It works offline from what it recorded.** `analyze find` locates where a value came from through decode chains, `analyze diff` classifies parameters across recordings, `replay serve` answers from a bundle, `replay check` compares a live or replayed run field by field, and `replay export-python` writes a client scaffold with tests.

## Boundaries

- Not an unattended scraping platform and not a cloud browser.
- No captcha, slider, SMS or 2FA solving, no bypassing of bot protection; challenges go to the human. The plugin directory only offers an interface for the user's own handlers.
- Signature-like parameters and encrypted bodies are not reproduced: generated clients mark them as TODOs, and those requests stay in the real browser session.
- Meant for analysing and debugging your own sessions on sites you are allowed to use; the repository's tests run only against local pages.
- The credential store is plain text protected by file permissions (0600 file in a 0700 directory, like `~/.netrc`); prefer test accounts.

## Install

- **Binary**: see Quick start. Only `darwin-arm64` is built and tested today; Linux x64 and Windows x64 are planned.
- **From source**: Bun 1.4 or newer, `bun install`, then `bun run build` (this machine) or `bun run build:darwin-arm64`; `bun test test/unit` runs the offline tests.
- **Files**: `~/.config/tabcap/` (socket, log, profile, config, `state.db`, `plugins/`), `~/.cache/tabcap/` (the browser), `~/.local/share/tabcap/` (screenshots, bundles). `TABCAP_HOME` moves all of them into one directory.

## Credentials store

`tabcap site add <name> --url <entry> --user <account>` asks for the password at a prompt (or reads it from a pipe with `--password-stdin`) and keeps it in `~/.config/tabcap/state.db`. The daemon refuses to start when the file or directory permissions are wider than 0600 / 0700. The agent sees site names, entry URLs and account names only. Only the login request itself keeps the real value in the bundle, and HAR export redacts it.

## Documentation

`docs/` holds the specifications and design notes (in Chinese): the evidence bundle format (`04`), the local test range (`05`), acceptance tests (`06`), architecture and CDP compatibility (`07`), the implementation plan and the naming table (`08`). `CHANGELOG.md` lists changes per release.
