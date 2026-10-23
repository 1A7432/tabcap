# tabcap

[English](README.md) | 中文

**给 AI agent 用的浏览器：不占你的屏幕，全程录下，该交给人的时候交给人。**

tabcap 给 agent 一份自己的 Chrome，在后台标签里干活，不抢你的前台。每个请求连正文一起录下。碰到登录、验证码或要人拿主意的地方，会话交还给你，agent 等着。录下来的东西可以搜索、对比、回放，也能生成代码。

它只做一件事：搞清楚一个站点的流量是怎么回事，好让你的爬虫复现。它不是无人值守的采集平台。

状态：0.8.1，alpha。macOS arm64 日常在用；Linux x64 与 Windows x64 在 CI 上跑，有已知缺口；Linux arm64 只编译过、没运行过。Apache-2.0。

## 为什么做它

多数 agent 浏览器的出发点是「给 agent 一个干净隔离的浏览器，让它自己跑」。真实的采集工作不是这样：你得先登录、把流程走一遍；agent 会卡在验证页上；总得有人确认「数据在这个请求里，那个参数是签名」。

tabcap 就是这个循环的工作台：agent 探路、重复；你给凭据、过验证、核结论；全程录下来，每条结论事后都能回放核对。

## 安装

- **npm**（任何平台，Node 18 以上）：`npm install -g tabcap`。对应平台的二进制作为可选依赖一起装；每个版本都由 CI 发布、带 provenance。之后升级：`tabcap update`。
- **Homebrew**（macOS arm64、Linux x64 与 arm64）：`brew install 1A7432/tabcap/tabcap`。formula 随每个版本自动更新；之后升级：`tabcap update`（它跑 `brew upgrade tabcap`）。
- **Release 包**：从 [release 页](https://github.com/1A7432/tabcap/releases)下载 `tabcap-v<版本>-darwin-arm64.tar.gz`、`-linux-x64.tar.gz`、`-linux-arm64.tar.gz` 或 `-windows-x64.zip`（校验值在 `SHA256SUMS`），解开，把 `tabcap`（Windows 上是 `tabcap.exe`）放进 `PATH`。macOS 上用浏览器下载的，先跑一次 `xattr -d com.apple.quarantine tabcap`。
- **从源码编**：需要 Bun 1.4.3 以上（CI 用 `.bun-version` 里的版本）和 Zig 0.16.0，先 `bun install && bun scripts/native.ts build`（编出 tabcap 内嵌的 wire 组件），再 `bun run build`。

然后 `tabcap setup` 把 Chrome for Testing（约 180 MB）下载到 `~/.cache/tabcap`，别的都不用。

**带命令沙箱的 agent**（Cursor 的 Auto-review 运行模式、Codex 的 `workspace-write`、开了 `/sandbox` 的 Claude Code、带 `--sandbox` 的 Gemini CLI）：Chrome 在它们的沙箱里建不起自己的沙箱，`tabcap browser start` 会直接报出来。让 tabcap 在沙箱外跑：把 `tabcap` 加进宿主的 allowlist 或排除命令，或者接成 MCP 服务器（`tabcap mcp --print-config <宿主>`；Claude Code 和 Codex 在沙箱外启动 MCP 服务器，Gemini CLI 在沙箱内）。不要用 `--no-sandbox`。

## 快速开始

**1. 装浏览器，启动。**

```sh
tabcap setup                                 # 下载 Chrome for Testing 到 ~/.cache/tabcap，不问任何问题
tabcap daemon start && tabcap browser start  # 守护进程和它自己的 Chrome，独立 profile
```

**2. 打开页面，看一眼。**

```sh
tabcap navigate https://example.com         # 在后台标签打开，等到就绪
tabcap snapshot --interactive               # 页面控件树，带 ref（e12）
tabcap click e12                            # 按 ref 点击，等导航稳定
tabcap fill e7 alice                        # 密码框的值在所有输出里都是 <masked>
tabcap screenshot                           # 存一张 PNG，打印路径
```

**3. 录下页面调了什么。**

```sh
tabcap net start                            # 录请求、正文、WebSocket 帧、控制台
tabcap click e9
tabcap net list --resource-types xhr,fetch  # 接口调用，按时间先后
tabcap net body r-11                        # 一条响应正文
tabcap net stop                             # 录制是 ~/.local/share/tabcap 下的一个证据包
tabcap daemon stop
```

每条命令在 stdout 打印一个 JSON 信封：`{"ok":true,"data":…}` 或 `{"ok":false,"error":{"code","message","next"}}`。失败了就照 `next` 做。`tabcap --help` 按组列出命令，`tabcap <命令> --help` 看选项和例子。

**交给 agent。** skill 在 `skills/tabcap/`（`SKILL.md` 加 `references/`，没有脚本）。Claude Code 拷到 `~/.claude/skills/tabcap/`（它也认 `~/.agents/skills/tabcap/`），Hermes Agent 等宿主拷进各自的 skills 目录。只认 MCP 的宿主：`claude mcp add tabcap -- tabcap mcp`；`tabcap mcp --print-config <宿主>` 打印 Cursor、Codex、Gemini CLI、Windsurf（没验证过）、Claude Desktop 的配置条目。然后对 agent 说：「用 tabcap 打开这个页面，看它调了哪些接口」。`tabcap guide` 列出 agent 可以照着走的任务配方（初次查看、爬虫经已登录标签、加密站点、离线回放、带验证的登录）；`tabcap status` 一屏看全当前状态和冲突。

## 它做什么

- **从不占你的屏幕。** 标签在后台打开；需要焦点的输入，在一条命令的时长里用 Chrome 的焦点仿真；抢走前台的弹窗会被交还；只有显式的 `tab select --bring-to-front` 会把标签提到前面。
- **把流量录成证据。** `net start` 把请求、响应正文、WebSocket 帧、控制台输出和命令时间线写进一个证据包。可以导出成 HAR（默认打码），也可以导入别处录的 HAR；录制中就能用 `net list`、`net show`、`net body`、`net wait` 读。
- **凭据不经过模型。** 站点、账号、密码存在本地库里（`tabcap site add`，在提示符下输入或用管道喂）。agent 只写引用（`fill e6 --secret example.password`）；所有输出、日志和证据包事件里，已知的秘密值一律替换成 `<secret:…>`。
- **交还给人，不硬闯。** 每个站点每个会话只试一次登录。撞上验证页，会话进入 `waiting` 并附截图，直到你在浏览器里处理完、跑 `tabcap handoff continue`。你自己在 agent 的标签里点击、打字或滚动也一样：tabcap 察觉到是人在操作，agent 就等着，直到你说做完了。也可以由 agent 事先设好条件（登录后的网址、登录才会设的 cookie），条件成立时交接自动结束（`tabcap handoff wait --until-url`）。tabcap 不带任何验证码或挑战的解法；插件接口可以加载你自己写的处理程序。
- **让你的爬虫经已登录的标签发请求。** `tabcap fetch <url>` 由页面自己发请求（带它的 cookie，受它的 CORS 规则），录下并打标，并发也不会混。同一主机按间隔排队（默认 3 秒，没有跳过的开关）；`status>=400`、`json:$.code!=0` 这类停手规则一命中就停下该站点，直到 `tabcap guard resume`。Python 爬虫可以经守护进程的套接字做同样的事。
- **录完离线干活。** `analyze find` 和 `where` 把页面上显示的一个值追到携带它的响应，解码和归一化都算在内。`analyze deps` 与 `analyze chain` 指出每个请求输入从哪来、复现它需要哪些请求。`analyze diff` 跨多次录制给参数分类；`analyze shape` 与 `schema-diff` 描述端点的形状和漂移。`replay export-python` 把一条链生成为带测试的 httpx 客户端；`replay serve` 用证据包应答；`replay check` 把一次真实运行逐字段比对；`bundle export fixtures` 给你已有的测试框架写夹具，一条交换一个。
- **加密正文用你自己的代码读。** 解码插件是你自己的一个进程（一行一个 JSON，密钥留在它自己的配置里），把编码或加密的正文变成明文视图，`find`、`where`、`deps`、`replay check` 都读它。页面自己在 JS 里解密的站点，`trace start --decode` 观察页面交给 `JSON.parse` 的明文，归到对应的响应，并标出关联是强是弱。
- **会话交给脚本。** `session export --for requests|httpx|playwright` 把 cookie、页面真正发过的认证头和本地存储写进一个 0600 文件，量交给你自己的脚本去跑。
- **说清楚什么是测出来的。** 请求输入只认精确匹配，其余标 `computed-in-page`。诊断探针（本浏览器呈现的信号；生成的客户端的 TLS、HTTP/2、头顺序对照浏览器）只说哪一层不同，不说站点为什么拒绝、也不说怎么改。

## 命令

命令分组；`tabcap help <组>` 列一组，比如 `tabcap help network`。标了*实验*的组在版本之间可能变、可能坏；其余是日常在用、端到端套件覆盖的。

| 组 | 命令 |
|---|---|
| 从这里开始 | `guide`（任务配方：命令顺序、为什么、坑）、`status`（一屏看全，含冲突和下一步） |
| 生命周期 | `setup`、`update`、`daemon start/stop/status`、`browser start/stop/status`、`mcp` |
| 站点、会话、标签 | `site`、`account`、`proxy`（*实验*）、`session start/stop/list/export`、`tab list/select/new/close` |
| 页面 | `navigate`、`go`、`reload`、`snapshot`、`outline`、`find`、`wait`、`html` |
| 输入 | `click`、`hover`、`fill`、`type`、`press-key`、`upload`、`dialog` |
| 页面工具 | `evaluate`、`screenshot`、`resize`、`emulate`、`permission grant/deny/reset`、`console list/show` |
| 网络 | `net start/stop/list/show/body/grep/wait`、`fetch`、`where`、`recon`（*实验*） |
| 交接 | `handoff status/continue`、`guard resume`、`plugin init/list/enable/disable` |
| 离线 | `bundle export/import/redact/info/decode`、`analyze find/diff/deps/chain/shape/schema-diff/recon`、`replay serve/check/session/export-python`、`schema` |
| 诊断（*实验*） | `trace`、`fingerprint`、`wire` |

每个选项的完整参考在 [`skills/tabcap/references/commands.md`](skills/tabcap/references/commands.md)；`tabcap schema --json` 是机器可读版。命令名和参数名在重合处对齐 Chrome DevTools MCP（`press-key`、`tab list`、`console list`、`--page-size` …）。

## 和同类工具的区别

有几类工具把录到的浏览器流量变成 agent 能调用的东西：Integuru 让 LLM 从 HAR 建请求依赖图、生成 Python；agent-browser 的 derive-client skill 让 agent 读 HAR 写客户端；Unbrowse 把站点的一方请求编译成托管的 MCP 工具；Playwright `routeFromHAR` 与 VCR.py 在测试里回放录制。tabcap 在录制本身上干活，每个请求输入都确定性地追来源，并且把人留在循环里。

| | tabcap | Integuru | derive-client | Unbrowse | HAR 回放¹ |
|---|---|---|---|---|---|
| 录下浏览器会话 | ✓ | ✓ | ✓ | ✓（它的云浏览器） | ✓（Playwright） |
| 请求输入追到来源 | ✓ 精确匹配 | LLM 推断 | LLM 推断 | – | – |
| 生成新客户端 | ✓（httpx） | ✓（Python） | ✓ | MCP 工具 | – |
| 给已有代码喂录到的响应 | ✓（`replay serve`） | – | – | – | ✓（测试内） |
| 对服务端逐字段回放比对 | ✓ | – | agent 比对响应形状 | ✓（托管） | – |
| 多层 / 跨源 iframe | ✓ | – | 部分² | – | – |
| 加密正文 | 标出；解码插件 | – | – | – | – |
| 登录 / 验证交给人 | ✓ | 录制前 | 录制前 | ✓ | – |
| 线上请求按站点限速 | ✓ | – | 文字建议 | – | – |
| MCP | ✓ | – | ✓（agent-browser） | ✓ | – |
| 在哪跑 | 本机 | 本机 + OpenAI API | 本机 | 托管 | 本机 |

✓：产品自己的文档写明，或在 tabcap 的本地测试页上复现。LLM 推断：文档把这一步交给 LLM 或 agent。–：按读到的公开文档没有描述，不表示它做不到。¹ Playwright `routeFromHAR`、VCR.py。² agent-browser 在本地测试页上：跨源帧进得去，第 3 层帧用试过的命令进不去；它的 HAR 里没有那个帧的文档，跨源帧也没有正文。来源与复现：[docs/12](docs/12-comparison.md)，2026-10-16 读取。

## 边界

- 不是无人值守的采集平台，也不是云浏览器。
- 类签名参数和加密正文不复现：生成的客户端把它们标成 TODO，这些请求留在真实浏览器会话里。
- 用来分析和调试你自己在有权使用的站点上的会话，并遵守站点条款和你所在地的法律；它是分析工具，不是绕过站点保护的手段。本仓库的测试只对本地页面跑。
- 凭据库是明文，靠文件权限保护（0700 目录里的 0600 文件，和 `~/.netrc` 一样）；能用测试账号就用测试账号。

## 平台

| | 状态 | 说明 |
|---|---|---|
| macOS arm64 | 日常在用；端到端全套 | 弹窗的前台交还用 osascript |
| Linux x64 | CI；端到端在 Xvfb 下跑 | Chrome 沙箱需要非特权 user namespace（Ubuntu 23.10 起：`sysctl kernel.apparmor_restrict_unprivileged_userns=0`）；后台标签的帧被限速时，`click --trusted` 和 `hover` 在鼠标移动期间开一个很小的 screencast |
| Windows x64 | CI；单测，端到端部分 | 守护进程监听 127.0.0.1 的随机端口，每次启动换令牌（`daemon.json`）；开第一个标签时出现一个普通的 Chrome 窗口，没有前台交还；不做 POSIX 权限检查 |
| Linux arm64 | 交叉编译，没运行过 | |

文件：`~/.config/tabcap/`（配置、凭据库、插件、socket、日志）、`~/.cache/tabcap/`（浏览器）、`~/.local/share/tabcap/`（截图、证据包）。Linux 认 `XDG_*`；Windows 上三者都在 `%LOCALAPPDATA%\tabcap\` 下。设 `TABCAP_HOME` 可整体搬到一个目录。

渠道：npm（`tabcap` 加每个平台一个包，推 `v*` tag 由 CI 发布）、Homebrew tap [`1A7432/homebrew-tabcap`](https://github.com/1A7432/homebrew-tabcap)（每个发布的 release 由 CI 用 `packaging/homebrew/` 的模板渲染 formula 推过去）和 release 包；Scoop 清单在 `packaging/scoop/`，还没有 bucket。

## 文档

- [`skills/tabcap/`](skills/tabcap/)：agent skill，`SKILL.md` 和录制、搜索、分析、回放、池、MCP、追踪的参考。
- [`docs/`](docs/)：证据包格式（`04`）、本地测试页（`05`）、验收测试（`06`）、架构与 CDP 笔记（`07`）、实施计划（`08`）、侦查（`09`）、输入保真（`10`）、线路层指纹组件（`11`）、同类工具对照（`12`）、代理与互操作（`13`）、防护家族与来源（`14`）、开放待验清单（`15`）。
- [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md)：按版本的变更。
- 参与开发：`AGENTS.md`（AI 协作规则）、`NOTES.md`（每格三行，最后一条是下一步的入口）、`docs/03`（定位与路线）。`bun test test/unit` 跑离线测试，`bun run test:e2e` 需要一份 Chrome for Testing。

## 许可

Apache-2.0。派生自 Apache-2.0 代码的部分见 `NOTICE`。
