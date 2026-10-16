# tabcap

[English](README.md) | 中文

人机共驾的采集工作台（自用、准备开源）：程序员和 AI 共用同一个已登录的真实浏览器，AI 探路、放大，卡住或拿不准就交还给人，人给凭据、过验证、核结论；全程录下证据，每个结论都能回放验证。起点是把扩展式浏览器桥（挂 debugger、不弹框、不抢焦点）和 agent-browser（完整 CLI、抓包、HAR）的长处合起来。

状态（2026-10-16）：0.3.0（alpha）。macOS arm64 日常使用、测试全过；Linux x64 与 Windows x64 在 CI 上跑，有已知缺口（见下方「平台」）；Linux arm64 只编译、未运行；Bun + TypeScript、Apache-2.0、守护进程直连自管的 Chrome for Testing（扩展通道阶段 2）。规范在 `docs/04`–`10`。

## 快速开始

`tabcap` 是给 AI agent 用的专属浏览器：守护进程自己管一份 Chrome for Testing（独立 profile），后台标签操作、不抢前台，页面读成带 ref 的无障碍树，网络请求连正文录进证据包。各平台测到什么程度见下方「平台」。0.1.0 曾以 `bbl` 为名发布；环境变量只认 `TABCAP_*`（0.2.x 对旧 `BBL_*` 的回退已在 0.3 删除）。

1. **拿二进制**：从 release 下载对应平台的包（`tabcap-v<版本>-darwin-arm64.tar.gz`、`-linux-x64.tar.gz`、`-linux-arm64.tar.gz` 或 `-windows-x64.zip`，可用 `SHA256SUMS` 核对），解开后把 `tabcap`（Windows 上是 `tabcap.exe`）放进 `PATH`（macOS 上浏览器下载的要先 `xattr -d com.apple.quarantine tabcap`）；或者在本仓库 `bun install && bun run build` 自己编。
2. **装浏览器**：`tabcap setup`。从 Chrome for Testing 官方 JSON 下载 Stable 到 `~/.cache/tabcap/chrome/<版本>/`，写 `~/.config/tabcap/config.json`；不交互，可重复跑。已有 Chrome for Testing 的话用 `tabcap setup --executable-path <二进制路径>`。
3. **启动**：`tabcap daemon start && tabcap browser start`。要求浏览器只连本机时加 `--proxy none`；默认跟随系统代理。

**agent 宿主**：skill 在 `skills/tabcap/`（agentskills.io 格式：`SKILL.md` + `references/commands.md`，不含任何脚本）。Claude Code 拷到 `~/.claude/skills/tabcap/`；Claude Code 与 DeepSeek harness 也认 `~/.agents/skills/tabcap/`；Hermes Agent 拷进它的 skills 目录。之后直接让 agent「用 tabcap 打开某页、看它调了哪些接口」。

**其它 agent / 直接用命令行**：每条命令在 stdout 打印一个 JSON 信封，`{"ok":true,"data":…}` 或 `{"ok":false,"error":{"code","message","next"}}`，失败时照 `next` 做。

```sh
tabcap navigate http://127.0.0.1:8080/      # 后台标签打开并等就绪
tabcap snapshot --interactive               # 控件树，带 ref（e12）
tabcap click e12                            # DOM 点击，等导航与 DOM 稳定后返回；--trusted 走真实鼠标事件
tabcap fill e7 alice                        # 填输入框；密码框的值在所有输出里都是 <masked>
tabcap net start; tabcap click e9; tabcap net list --resource-types xhr,fetch; tabcap net body r-11
tabcap screenshot                           # 只回图片路径
tabcap --help                               # 全部命令；tabcap <命令> --help 看选项和例子
tabcap daemon stop                          # 关浏览器、收尾录制、退出
```

命令名与参数名对齐 Chrome DevTools MCP（`press-key`、`tab list` / `tab select`、`console list` / `console show`、`--page-size` / `--page-idx`、`--file-path` …），0.3 的旧名已在 0.4 删除。命令一览（`--session`、`--timeout` 省略；`tabcap <命令> --help` 看全部选项和例子，`skills/tabcap/references/commands.md` 是完整参考，`tabcap schema --json` 是机器可读版）：

<!-- BEGIN GENERATED: commands (from src/cli/commands.ts; run `bun run gen:docs`) -->
| 命令 | 作用 |
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
| `tabcap proxy add <name> --url <scheme://host:port> [--user username] [--password-stdin] [--bypass list]` | add a proxy to the local store (state.db, 0600) for the account pool; for the human: the password is typed at a prompt or piped, never passed as an argument, and never shown in tabcap output |
| `tabcap proxy list` | stored proxies: name, scheme, host:port, user, hasAuth, bypass, state, last check (never the password) |
| `tabcap proxy remove <name>` | delete a proxy no account is bound to |
| `tabcap proxy check <name> [--url url]` | one health check through the proxy: unknown → up on success; 3 failures in a row → down (rechecked after 1 / 5 / 15 min) |
| `tabcap proxy set-state <name> active\|disabled` | disable a proxy by hand (skipped by allocation and rotation, never checked) or set it active again (back to unknown until the next check) |
| `tabcap account add <site> --user <username> [--password-stdin] [--totp-stdin]` | add another account to a stored site (for the human, not the AI: the password is typed at a prompt or piped, never an argument, never shown); a duplicate <site>.<user> is refused |
| `tabcap account remove <account>` | delete a stored account with its saved cookies and counters; refused while a session uses it |
| `tabcap account bind <account> --proxy <name\|system\|none>` | bind a stored account (<site>.<user>) to a proxy, or to the browser's own network (system / none) |
| `tabcap account list [--site site]` | stored accounts: state (active / cooling / needs-human / disabled), coolUntil, proxy, lastUsedAt (never passwords) |
| `tabcap account set-state <account> active\|disabled` | set an account active (also clears cooling and needs-human) or disabled (never allocated) |
| `tabcap session start <name> [--site site] [--account user\|auto]` | create a session (navigate also creates it); --site binds a stored site → entryUrl, the secret references, account and proxy (names only) |
| `tabcap session stop <name>` | close the session's own tabs (never tabs it did not open) and finish its recording |
| `tabcap session list` | list sessions |
| `tabcap navigate <url> [--tab t2] [--new-tab] [--no-wait]` | load a URL in the session's tab (opens a background tab if needed), wait until ready and the DOM is quiet → tab, url, title, readyState, nav |
| `tabcap tab list` | list the session's tabs (never other tabs): tab id, url, title, owned, popup opener, current |
| `tabcap tab select <tab> [--bring-to-front]` | make one of the session's tabs (e.g. a popup) its current tab for later commands; never brings it to the front unless --bring-to-front |
| `tabcap tab new <url> [--background] [--no-wait]` | open a new tab in the session, load a URL and make it the current tab (same as navigate --new-tab) |
| `tabcap tab close <tab>` | close one of the session's tabs |
| `tabcap go back\|forward [--tab t2] [--no-wait]` | history back / forward, waits until ready and the DOM is quiet |
| `tabcap reload [--tab t2] [--ignore-cache] [--no-wait]` | reload the current tab, waits until ready and the DOM is quiet |
| `tabcap snapshot [--tab t2] [--interactive] [--verbose] [--max-chars n] [--file-path path] [--frames] [--frame f2/f1]` | accessibility tree as indented text, one element per line: role "name" [ref] flags (e.g. `- button "Save" [e12] disabled`); refs are for click / fill and expire when the document changes; starts with the overlay header (overlays / detected / frames, counts toward --max-chars); child frames are header lines until --frames / --frame |
| `tabcap outline [--tab t2] [--max-chars n]` | page map head: tab line, overlays (dialogs, masks, iframe layers, timeout prompts, consent banners, with close-button refs; also inside frames), detected (adapters, with confidence), frames (path, url, same-origin / cross-origin, depth, title), popups; read-only, never closes anything |
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
| `tabcap net list [--filter s] [--host s] [--status code] [--method M] [--resource-types xhr,fetch] [--tab t2] [--since c-12] [--failed] [--no-failed] [--all] [--page-size n] [--page-idx n] [--kind http\|ws]` | recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, size, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); 100 per page unless --page-size (0: everything) (--kind ws: WebSocket frames r-12:34) |
| `tabcap net body <id> [--out path]` | a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline) |
| `tabcap net show <id>` | one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame |
| `tabcap console list [--tab t2] [--types error,warn] [--level level] [--page-size n] [--page-idx n] [--limit n] [--include-stack-traces] [--clear]` | the tab's console, oldest first (last 500 messages, kept even when not recording): msgid, type, level, source, text (4 KB max), url:line:col |
| `tabcap console show <msgid> [--tab t2]` | one console message by msgid (from console list): text, arguments, location, stack trace |
| `tabcap wait [--tab t2] [--text text]... [--selector css] [--url s] [--idle [ms]] [--fn js]` | wait for one condition on the current tab; returns what matched, or error timeout naming what is still outstanding |
| `tabcap net wait --url <s> [--method M] [--tab t2] [--since c-12\|start] [--fresh]` | wait until a matching request finished with its body stored (needs net start). Counts requests since the start of the last action command (navigate, tab new, click, hover, fill, type, press-key, upload, go, reload, evaluate) → id, status, body path |
| `tabcap where <query> [--as ref\|text] [--top n] [--text] [--write-findings]` | which recorded response carries a value the page shows (a snapshot ref's visible text, or a text): JSON paths through analyze find's decode chain, then HTML text nodes (selectors), matched exactly or after normalisation (thousands / decimal separators, accounting negatives, full-width, nbsp, YYYY-MM dates, dotted codes, DR / CR); searches only the session's recording and sends no request |
| `tabcap recon [--text]` | recon dossier v0 of the session's recording and current page: tech stack (adapter detect results, header / session-cookie hints), data channels (method, path template, type, body class) with the share of the page's visible text found in recorded responses, cookie classification (origin, lifetime, flags, role, requiredBy from analyze deps), protection identification (guard detections, response signals; identification only). Writes exports/dossier.json (schema tabcap-dossier/0) and exports/dossier.md into the bundle; sends no request |
| `tabcap handoff status` | is the session handed to the human? state running \| waiting \| resumed, reason, screenshot, handler answers |
| `tabcap handoff continue` | end a waiting state after the human finished in the browser (run it only when they say so) |
| `tabcap trace start [--apis file] [--stack n] [--first-n n] [--max-hits n]` | trace mode for the session (every tab, frame and worker, now and later): records which page scripts read which browser signals (navigator, screen, time zone, canvas, WebGL …) via debugger breakpoints into `signal` events; read-only, changes nothing in the page, but scripts run slower and the timing is observable |
| `tabcap trace stop` | end trace mode: breakpoints removed, debugger off, open documents written to the recording |
| `tabcap trace status` | trace mode state: on \| paused (handoff) \| off, active APIs, names skipped in this browser, per-document read counts |
| `tabcap trace list [--api name] [--script url] [--text]` | API × script table of the signal reads in the session's recording (open documents included): read counts, caller line:col (1-based), documents, truncated, value recorded |
| `tabcap fingerprint probe [--ref name] [--text]` | the values this browser presents for a fixed signal list (navigator, UA client hints, screen, time zone, canvas / audio hashes, WebGL, voices, fonts, permissions, media queries): the probe page in a new background tab, closed afterwards; while recording, a `state` env event in the bundle. Read-only |
| `tabcap plugin list` | challenge handlers installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, hooks, enabled, errors |
| `tabcap plugin enable <name>` | let the guard ask this handler before handing a challenge to the human |
| `tabcap plugin disable <name>` | stop asking this handler |
| `tabcap bundle export har <bundle> [--out file] [--tab t1] [--types xhr,fetch] [--embed-events] [--no-redact]` | export a bundle as HAR 1.2 (redacted by default) |
| `tabcap bundle import har <file> -o <bundle>` | import a HAR (DevTools, Charles, mitmproxy …) as a bundle, so analyze works on it |
| `tabcap bundle redact <in> <out>` | write a redacted copy of a bundle (the original is never changed) |
| `tabcap bundle info <bundle>` | bundle summary: counts, event kinds, finished or not, issues |
| `tabcap analyze find <bundle> <text> [--ignore-case] [--text] [--save]` | which request / WebSocket frame / console line carries this text, through a bounded decode chain (base64, gzip / br, urldecode, JSON, html entities …); 0 hits come with hints |
| `tabcap analyze diff <bundle1> <bundle2> [<bundles>] [--text] [--save]` | compare recordings of the same action: which parameters are constant, per session, timestamps or varying |
| `tabcap analyze deps <bundle> [--session name] [--request r-N] [--text] [--write-findings]` | value-flow dependency graph: for every request input (query, body leaves, x-* / authorization headers, cookies) its source in earlier events (set-cookie, response body path, recorded fill / type, earlier request, constant, timestamp), else computed-in-page / unrecorded; exact matches only, never guessed |
| `tabcap analyze chain <bundle> [--request r-N] [--session name] [--text]` | the requests needed to reproduce one request, from the deps graph, in recording order: what each step provides to later ones and what it still needs from the caller (computed-in-page, unrecorded, user input) |
| `tabcap analyze recon <bundle> [--text]` | the recon dossier offline (as `tabcap recon`), with the bundle's last recorded document standing in for the page (its HTML text, no adapter detection); writes exports/dossier.json and exports/dossier.md |
| `tabcap replay serve <bundle> [--port port] [--host host] [--strict h1,h2] [--match-cookies] [--json] [--once seconds]` | serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256; repeated matches cycle in recorded order (header x-tabcap-replay: r-N;n=k); no match → 404 with the nearest recordings and what differs |
| `tabcap replay session [<bundle>] --out <file> [--site site]` | write the recording's cookies (latest state snapshot), or with --site and no bundle the store's saved session, as a Playwright storageState file, mode 0600; it holds live session cookies, values are never printed |
| `tabcap replay export-python <bundle> --out <dir> [--include glob,glob] [--exclude glob,glob] [--chain] [--no-chain] [--proxy-env file]` | generate an httpx client (one function per request group, TypedDict responses), fixtures and a pytest suite that runs against replay serve; with the chain, computed-in-page inputs are TODO parameters and verify() replays the chain; otherwise signature-like parameters and encrypted bodies become NotImplementedError TODOs |
| `tabcap replay check <bundle> [--against url] [--live] [--rate n] [--site site] [--filter glob,glob] [--headers h1,h2] [--with-cookies] [--json]` | send every recorded request again and compare status, headers and body field by field with the recording; exit 1 on any difference |
| `tabcap wire serve [--port port] [--capture-dir dir]` | local TLS echo on 127.0.0.1 until Ctrl-C (prints {url, port, caPath} first): answers every request with the wire report of its own connection (TLS ClientHello, JA3 / JA4, HTTP/2 settings and frames, header order) as JSON; trust it with the CA from `tabcap wire ca-path` |
| `tabcap wire version` | version, path and sha256 of the native wire component (extracted from the tabcap binary into the cache on first use) |
| `tabcap wire ca-path` | path of the wire echo's CA certificate (a test CA for 127.0.0.1 only), for clients that verify TLS |
| `tabcap wire profile [--samples n] [--port port]` | capture the browser baseline: a background tab of the session (the Chrome for Testing tabcap launched, its own flags) ignores certificate errors for itself only, navigates to the local echo and runs a page fetch, N times each; writes the wire profile (navigation and fetch header orders, TLS from all samples, CfT version and the launch flags' sha256) to the cache and prints it |
| `tabcap wire probe --client <dir> [--port port] [--samples n] [--text]` | compare the generated Python client with the browser baseline on the local echo: `uv run client.py wire-report` sends one GET to 127.0.0.1, then per layer (tls, h2, headers) same / differs / missing with the differing fields, and the checks against the profile; diagnostic only (says which layer differs, not why a site refused anything); with a recording open, one finding per differing layer |
| `tabcap fingerprint serve [--port port] [--once] [--force]` | serve the signal probe page on 127.0.0.1 for your own browser: open the printed URL by hand and press Save as reference (written to config/fingerprint/refs/<name>.json, 0600); Ctrl-C to stop |
| `tabcap fingerprint ref list` | saved references: name, savedAt, userAgent, file |
| `tabcap fingerprint ref show <name>` | one saved reference with all its fields |
| `tabcap fingerprint ref remove <name>` | delete a saved reference |
| `tabcap fingerprint diff <bundle> --ref <name> [--text]` | the last `state` env event of a bundle (from `fingerprint probe`) against a saved reference, offline: the same output as `fingerprint probe --ref` |
| `tabcap schema [--json]` | this command table as JSON: names, arguments, flags with types and defaults, help, examples |
<!-- END GENERATED: commands -->

**站点与账号库**：`tabcap site add <名> --url <入口> --user <账号>` 在提示符下输入密码（或 `--password-stdin` 从管道读），存进 `~/.config/tabcap/state.db`。这是**明文**库，保护程度和 `~/.netrc` 一样（macOS / Linux 上文件 0600、目录 0700，权限更宽时守护进程拒绝启动；Windows 上沿用 `%LOCALAPPDATA%` 的用户默认 ACL），能用测试账号就别用主账号。AI 只看得到站点名、入口、账号名，命令里只写引用 `tabcap fill <ref> --secret <名>.password`；守护进程把所有输出、日志、证据包事件里的已知密码替换成 `<secret:<名>.password>`，只有登录请求本身的正文原样进包，导出 HAR 时会被打码。同一会话第二次用密码登录会被拦下（`guard.login-limit`），撞上验证页时会话进入 `waiting`、交给人处理。

**平台**（GitHub Actions runner，2026-10-16，Chrome for Testing 155）：

| 平台 | 包 | 单元测试、类型检查 | 端到端 | 已知缺口 |
|---|---|---|---|---|
| macOS arm64 | `.tar.gz` | 通过（CI，macOS 14） | 81 / 81（本机；CI 不跑） | 无已知 |
| Linux x64 | `.tar.gz` | 通过（CI，Ubuntu） | 81 / 81（CI，Ubuntu + Xvfb，连续 2 次） | 后台标签上的 `click --trusted` / `hover` 在标签帧被限速时，鼠标移动期间开一个极小的 screencast（输出里标 `paint.held`）；Chrome 沙箱需要非特权 user namespace（CI 关掉了 Ubuntu 24.04 的 AppArmor 限制） |
| Windows x64 | `.zip` | 通过（CI） | 63 / 81（CI，非必过项） | 12 个用例没真正跑到（所在套件第一条就检查 Unix socket）；POSIX 权限检查不适用；`resize 900 700` 得到 693 px 高的页面 |
| Linux arm64 | `.tar.gz` | — | — | 交叉编译，从未运行 |

Windows：守护进程监听 127.0.0.1 的随机端口，每次启动换新令牌（写在 `daemon.json`）；浏览器走 `--remote-debugging-pipe`；开第一个标签前没有窗口，之后出现一个普通的 Chrome 窗口（Windows 上没有前台归还）。Linux：Ubuntu 23.10 起 Chrome 沙箱需要非特权 user namespace，CI 用 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` 打开（桌面环境没测过）。

**即将提供**：Homebrew、npm（`tabcap` 包，每个平台一个可选依赖）、Scoop。模板在 `packaging/`，还没有发布到任何仓库。从源码：Bun 1.4+，`bun install` 后 `bun run build`（本机）或 `bun run build:<平台>`（`darwin-arm64`、`linux-x64`、`linux-arm64`、`windows-x64`），`bun run release` 一次构建并打包四个平台。

文件位置：`~/.config/tabcap/`（socket、日志、profile、配置、`state.db`、`plugins/`、`fingerprint/refs/`）、`~/.cache/tabcap/`（浏览器）、`~/.local/share/tabcap/`（截图、证据包）；Linux 认 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`；Windows 上三者是 `%LOCALAPPDATA%\tabcap\config`、`\cache`、`\data`，文件沿用用户目录的默认 ACL（tabcap 不另设 ACL；没有 socket，`config\daemon.json` 里是端口和令牌）。设 `TABCAP_HOME` 可整体搬到一个目录。

## 从哪开始

1. `NOTES.md`：每格三行，最新一条是下一步入口。
2. `docs/03-product-thesis-and-roadmap.md`：定位、核心工作流、模块、路线与验收标准、待定决策。**以这份为准。**
3. `docs/01-background-and-options.md`：起因、两边痛点、已有同类项目、最初的方案 A/B/C/D。
4. `docs/04`–`07`：证据包规范 v0、本地靶场场景、阶段 1 验收测试计划、bridge 架构与 CDP 兼容端点（草案）。
5. `AGENTS.md`：本目录的 AI 协作规则。

## 目录

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | 本目录的 AI 协作规则 |
| `docs/` | 背景与方案、规范草案 |

## 版权边界

闭源工具只借思路，不复制其代码。要抄代码就抄 Apache-2.0 的 Playwright `cdpRelay.ts` 或 agent-browser-stealth，并保留其 NOTICE。
