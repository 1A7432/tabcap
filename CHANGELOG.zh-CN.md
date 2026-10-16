# 更新记录

[English](CHANGELOG.md) | 中文

## 未发布（0.4-A）

- **`tabcap analyze deps <包> [--session 名] [--request r-N] [--text] [--write-findings]`**：确定性的值流依赖图（schema `tabcap-deps/0`）。对每个请求的每个输入（query 参数、表单与 JSON 正文叶子、`x-*` / `authorization` 头、按名的 cookie），列出在更早事件里找到的来源，按优先级：更早响应的 `set-cookie`、更早响应正文里的值（经 `analyze find` 解码链的 JSON 路径，或 HTML / 文本里的整词）、录到的 `fill` / `type` 值、更早请求发过的同名同值参数、常量、时间戳（`analyze diff` 的分类）。只做精确匹配（去首尾空白，query / 表单值 URL 解码）；来源必须早于这个值第一次被发出。找不到来源的输入标 `computed-in-page`（带 diff 的提示和与它同变的输入），cookie 标 `unrecorded`。`--secret` 填的值只会匹配它的 `<secret:…>` 占位符，输出里不含任何值。与 `find` / `diff` 一样默认输出一个 JSON 信封（`--text` 出文本报告）；证据包只读，`--write-findings` 才追加 `finding` 事件（`tool: "deps"`，从包里重读核对过的精确来源为 `实测`，其余 `推断`）。
- **`tabcap analyze chain <包> [--request r-N] [--session 名] [--text]`**（schema `tabcap-chain/0`）：重现某个请求（默认：最后一个有数据的 xhr / fetch / document 请求）需要的请求，按录制顺序，每步写明给后面提供什么、还要调用方给什么；`todo` 列出 `computed-in-page` / `unrecorded` 输入。
- **`replay export-python` 按动作链生成**（依赖图里有请求取用了更早响应的值时默认开启；`--chain` 强制开，`--no-chain` 与 0.3 输出逐字节相同）：来自前一步回复的值成为参数，`computed-in-page` 输入成为默认值 `TODO` 的参数（注释写明提示和同变输入），名字像密码、token 的输入（与 `bundle redact` 同一规则）不写进任何文件；`client.py` 带 `verify()`：`python client.py verify --base-url <地址>` 逐步重放动作链，每步按 `replay check` 的比法和录制比，打印 pass / fail 表，有失败退出码非 0。录到的期望值在 `verify_expected.json`（0600；秘密是 `<secret:…>`，运行时从 `TABCAP_SECRET_*` 取；附脱敏副本说明）。调用方在可选的 `todo_inputs.py` 里填 TODO，生成的 README 写明流程。
- 生成的文档保留离线命令自己的 `--session`（只有守护进程共用的 `--session` / `--timeout` 不进用法行）。

### 删除

- 删除 0.3 的全部弃用别名，不保留兼容：命令 `tabs`（用 `tab list`）、`tab use`（`tab select`）、`press`（`press-key`）、裸 `console`（`console list`）；参数 `net list --type`（`--resource-types`）、`--limit`（`--page-size`）、`--offset`（`--page-idx`），`screenshot --out`（`--file-path`）、`--full`（`--full-page`）；`net list` 输出字段 `offset`、`limit`、`nextOffset`；`--help` 与生成文档里的「deprecated」行；`tabcap schema --json` 的 `deprecatedFor` / `deprecatedAliases` / `deprecated` 字段。旧名现在报普通的 `unknown command` / `unknown option` 用法错误。`console list --limit`（最后 N 条）和 `dialog --prompt-text`（`--text` 的普通别名）保留。

### 变更

- `net list` 与 `console list` 默认分页：不给分页参数时返回第 0 页、每页 100（还有更多时带 `nextPageIdx`）；`--page-size 0` 返回全部（原来的默认行为）。`--page-size 0` 同时给大于 0 的 `--page-idx` 报用法错误。
- 会话等待人接手（hand-off）期间，`resize` 和 `emulate` 与其它作用于页面的命令一样返回 `waiting` 错误。
- 输出全部改为英文：`waiting` 错误的 `next`（"complete the verification in the browser, then run `tabcap handoff continue`"）、DOM 点击与 `type --insert` 的 `incomplete event sequence: …` 警告、`bundle is not finished: …` 警告与 `analyze find` / `diff` 文本报告里的 `(unfinished)`、snapshot / outline 头部（`overlays` / `detected` / `popups`，遮挡行改英文，名字用 ASCII 引号）、`covered` 错误、`replay export-python` 生成包的 README（模板与动作链一节）。只有证据等级（`实测` / `推断` / `待验` / `人确认`，证据包格式里的值）保持不变。
- 脱敏规则 `default@2`（`bundle redact`、HAR 导出，以及 `replay export-python`、`analyze deps` 共用的敏感名规则）：`pass`、`pwd` 作为名字的一段时算敏感（`pass`、`user_pass`、`userPass`、`login-pwd`、`Pwd2`；`bypass`、`passport`、`compass`、`passenger` 不算）；原有子串（`passw`、`token` …）照旧。脱敏副本记 `"rules": "default@2"`。修复 `replay export-python --no-chain` 把名为 `pass` 的登录字段的录制值写进 `client.py`。
- `--help`、生成的命令参考、SKILL.md 与 README 里的示例站点名改为 `example`（原为 `shop`）。

## 0.3.0（2026-10-16）

- **命令名对齐 Chrome DevTools MCP**（docs/08 §5）：`press` → `press-key`，`tabs` / `tab use` → `tab list` / `tab select`，`console` → `console list`（新增 `--types`、`--page-size`、`--page-idx`、`--include-stack-traces`，`--level`、`--limit` 保留）与 `console show <msgid>`；`net list --type / --limit / --offset` → `--resource-types / --page-size / --page-idx`（页码语义，`nextPageIdx`；不给分页参数时返回全部匹配，给了默认每页 100；默认仍藏失败与 `data:`，`--all` 全列）；`screenshot --out / --full` → `--file-path / --full-page`，新增 `--format png|jpeg|webp`、`--quality`、`--ref`；`snapshot` 新增 `--verbose`、`--file-path`；`type --submit-key`；`click --dbl-click`；`dialog --prompt-text`；`wait --text` 可重复（任一命中），并在所有帧里找；`evaluate --function` / `--args`；`reload --ignore-cache`。旧名保留到 0.4，`--help` 标为弃用；`net list` 输出仍带旧的 `offset` / `limit` / `nextOffset` 字段一版。
- **新命令**：`tab new <url> [--background]`（默认后台）；`tab select --bring-to-front`（焦点阶梯第三级，明确要求时才拉前台并在输出里说明）；`hover <ref>`（可信鼠标路径，标签不绘制时报新错误码 `not-painted`）；`resize <宽> <高>`；`upload <ref> <文件…>`（`DOM.setFileInputFiles`，按钮打开文件框时拦截并回答）；`emulate`（视口、UA、配色、网络与 CPU 节流、地理位置；每次调用替换之前全部设置）。
- **动作后等待**：`click`、`hover`、`fill`、`type`、`press-key`、`navigate`、`tab new`、`go`、`reload` 返回前等动作引起的导航完成，再等 DOM 100 ms 无变化（各 3 s 上限，随节流放大）；输出 `wait` 字段；`--no-wait` 跳过。交互命令加 `--snapshot` 顺手带回新快照。录制时命令窗口相应变长。
- **借用 chrome-devtools-mcp（Apache-2.0，Google）**：分页函数与「Showing a-b of n (Page x of y).」文案、网络列表 URL 截断 255 与正文预览 10000 字、快照行格式（状态写成裸词 `checked focused`、其它属性 `attr="value"`，ref 仍是 `[e12]`）、emulate 参数集与语义；网络预设取自 Puppeteer。见 NOTICE。
- **skill 改为 agentskills.io 布局**：`skills/tabcap/SKILL.md`（英文，name 与目录同名，description 触发词前置、≤ 400 字，`compatibility` 写明需另装 tabcap 与 Chrome for Testing）+ 生成的 `references/commands.md`；单测里有本地校验器（`scripts/validate-skill.ts`，代替无法离线安装的 `skills-ref validate`）。
- **英文优先**：README、SKILL.md、CHANGELOG、`--help` 以英文为主，中文版并行（`README.zh-CN.md`、本文件）。

- **站点与账号库**：`tabcap site add <名> --url <入口> --user <账号> [--domains a,b]`，密码在提示符下输入或 `--password-stdin` 从管道读，不接受命令行参数；`tabcap site list` 只列站点名、入口、域名、账号名和引用，不列密码；`tabcap site remove`。库是 `~/.config/tabcap/state.db`（bun:sqlite，明文，文件 0600、目录 0700，权限更宽时守护进程拒绝启动）。
- **用引用填凭据**：`tabcap fill <ref> --secret <站点>.password|username`，由守护进程取值填入。库里的密码在所有命令输出、守护进程日志、`snapshot` / `evaluate` 结果和证据包的 `cmd` 事件里都显示为 `<secret:<站点>.password>`；只有登录请求本身的正文原样进包，HAR 导出和 `bundle redact` 会把它打码。`tabcap session start <名> --site <站点>` 把站点绑到会话，证据包 manifest 记 `session.site` / `session.account`。
- **登录限次**：同一会话对同一站点第二次 `fill --secret …password` 返回 `guard.login-limit`，不碰页面；`--confirm` 放行。每次判定写一条 `guard` 事件。
- **撞上验证页交给人**：录制中某个接口或页面返回 HTML 的 403 时，会话进入 `waiting`（带原因和截图路径），之后操作页面的命令都返回 `waiting`，直到人处理完、执行 `tabcap handoff continue`；`tabcap handoff status` 查看状态。证据包里有 `guard`（breaker）与 `handoff`（waiting / resumed）事件。目前只认这一种挑战，且要在 `net start` 录制时才生效。
- **外部处理程序接口**：`~/.config/tabcap/plugins/<名>/manifest.json` 描述一个独立进程的处理程序（stdin / stdout 各一个 JSON，任何语言都行），`tabcap plugin list | enable | disable`。撞上挑战时先问已启用的处理程序，给出答案就恢复会话并把答案交给 AI，否则交给人；每次调用作为一对 `cmd` 事件（actor `system`，输入输出已替换秘密值）进包。tabcap 本身不带任何处理程序。
- 新错误码 `waiting`、`guard.login-limit`；错误信封可以带额外字段（`waiting` 带 `state`、`reason`、`screenshot`）。
- **离线回放服务器**：`tabcap replay serve <包> [--port 4500]` 只监听本机回环，按「方法 + 路径 + 排序后的 query + 请求体 sha256」匹配，吐出录到的状态码、响应头（去掉逐跳头、`content-length`、`content-encoding`，`set-cookie` 原样）和正文；同一个键录了几次就按录制顺序轮流给（分页式），响应头 `x-tabcap-replay: r-12;n=2` 说明给的是哪条；没取到正文的给录到的状态码和空正文，并带 `x-tabcap-replay-missing`；同源的 `location` 改成路径，跳转留在回放服务器上。匹配不上返回 404，JSON 里列出最接近的至多 3 条录制和哪几部分对不上。`--strict <头>` 把指定请求头也算进匹配，`--match-cookies` 把 cookie 也算进去。
- **逐项比对**：`tabcap replay check <包> --against <地址>` 把录到的请求重发一遍，比状态码、选定的响应头和正文（JSON 逐路径、文本全等、二进制比哈希），打印对比表（`--json` 出信封），有差异退出码 1。默认只允许本机回环；非回环要 `--live`，且要求库里有这个站点、域名对得上，按站点计数，默认每 2 秒最多 1 个请求（`--rate` 调整）。
- **导出会话**：`tabcap replay session <包> -o storage-state.json` 把包里最近一次 cookie 快照写成 Playwright storageState 格式（包里没有时可用 `--site` 取库里存的会话），文件 0600，输出里不显示 cookie 值。
- **生成 Python 客户端**：`tabcap replay export-python <包> -o <目录>` 生成 httpx 客户端（每个请求组一个函数，常量写死，会话值从 storageState 取，时间戳调用时生成，每次都变的参数作为函数参数，响应字段写成 `TypedDict`）、fixtures、对着 `replay serve` 跑的 pytest 和中文 README。签名类参数、加密请求体不还原，对应函数抛 `NotImplementedError`（标 `TODO: computed in the page; see docs/03 §6`）。
- **cookie 快照进包**：录制时每个标签在 `net start`、每次页面导航（`navigation` 类）和 `net stop` 各写一条 `state` 事件（`what: "cookies"`，正文是 CDP `Network.getCookies` 原样数组，存成 blob，事件里只有 `origin`、`count`、`reason`），`tabcap replay session <包>` 在真实录制上可用了。
- **站点会话存库**：用 `--site` 开的会话在 `tabcap session stop` 和 `tabcap handoff continue` 时把该站点的 cookie 存进本地库（`sessions` 表），输出只给条数；`tabcap replay session --site <站点> -o …` 不要包也能导出。库里存的 cookie 值（8 个字符以上）和密码一样，在所有输出里替换成 `<secret:<站点>.cookie.<名>>`。
- **回放按主机区分**：包里录了不止一个主机时，`replay serve` 的匹配键加上主机：请求的 `Host` 头写成录到的某个主机（如 `curl -H 'Host: api.example.test' …`）就只匹配那个主机的录制；其他 `Host` 照旧按方法、路径、query、请求体匹配。`--json` 的 `match.host` 和 `routes[].host` 说明是否启用。
- **修复截图与收尾顺序**：后台标签刚渲染完新内容时 Chrome 偶尔对截图直接回「Unable to capture screenshot」，验证墙的 `waiting` 截图因此为空（0.3-A 以来端到端 s15 的偶发失败）；现在这种情况改用焦点仿真截图（与截到纯色图时相同）。录制停止或导航时一并收尾的未完成请求按开始顺序写入证据包（此前并行写，顺序可能颠倒）。
- **修复**：请求 `timing.responseStart` 改取 CDP ResourceTiming（与 `end` 同一时钟），不再晚于 `end`；`bundle export har` 写出的 HAR 与 salt 文件改为 0600；`tabcap type` 在焦点元素已被移除或重渲染（焦点落回 `<body>`）时返回 `stale-ref`，不再静默什么都没输入。
- **不再认 `BBL_*` 环境变量**：0.2.x 对旧名的回退删除，只认 `TABCAP_HOME`、`TABCAP_CHROME`、`TABCAP_SESSION`、`TABCAP_LOG` 等 `TABCAP_*`。
- 证据包读取时保留请求的 `postDataMissing`；本地库升到 schema 2（`guard_counters` 加请求计数，供 `replay check --live` 限速）。
- **可信点击**：`tabcap click <ref> --trusted` 现在像真人一样点：开焦点仿真、确认标签在绘制后，鼠标沿一条 100–400 ms 的路径移到元素中心（终点精确），按下，停 50–140 ms，抬起；pointer / mouse 两族事件由 Chrome 生成，全部 `isTrusted:true`，按下时 `pressure` 0.5。输出新增 `eventShape:"full"`、`trajectory`（起点、终点、点数、时长）、`pressGapMs`。标签确认不了在绘制（隐藏且不出帧）时不发任何鼠标移动，改用 DOM 点击并标 `degraded:"not-painted"`；某次移动无响应报新错误码 `move-timeout`，不按下。任何失败都不自动重试，`not-delivered` 的提示不再建议「再试一次」。
- **默认点击不变，但标明残缺**：不带 `--trusted` 的 `click` 仍是 DOM `el.click()`，输出新增 `eventShape:"incomplete"` 和「事件序残缺」警告（只有一个 `isTrusted:false` 的 `click`，没有 pointer / mouse 事件）。
- **逐键输入**：`tabcap type <文字> --trusted` 每个字符按一次键（keydown、keypress、beforeinput、input、keyup，全部可信），美式键盘上没有的字符（中文、emoji）逐字插入；`--delay <毫秒>` 设字符间隔，默认 0。默认的 `type` 和新的 `--insert` 仍是一次插入整段，输出 `eventShape:"insert"` 和「事件序残缺」警告。
- **页面不读的响应也能及时看到**：页面拿到响应却从不读正文时，Chrome 不发完成事件，以前要到 `net stop` 才写进证据包；现在响应到达 1 秒后若已经拦截到完整正文，就写成 `finished`，带 `unreadByPage: true`、`bodySource: "fetch"`、没有结束时间，录制中 `net list` / `net show` / `net wait` 和 guard 都能看到。
- **Linux x64 与 Windows x64 代码路径**（macOS 行为不变）。Linux：默认目录遵循 XDG（`$XDG_CONFIG_HOME/tabcap`、`$XDG_CACHE_HOME/tabcap`、`$XDG_DATA_HOME/tabcap`；未设置时仍是 `~/.config` / `~/.cache` / `~/.local/share`），`tabcap setup` 用 `unzip` 解压，没有 `unzip` 时用 `bsdtar`。Windows：全部放在 `%LOCALAPPDATA%\tabcap\{config,cache,data}`；守护进程监听 127.0.0.1 的随机端口，每次启动生成新的 bearer 令牌，端口与令牌写进 `config\daemon.json`，CLI 从这里读（令牌不进日志、不进命令行、不出现在 `daemon status` 里；不带令牌的请求回 401）；`tabcap setup` 下载 `win64` 版，用 PowerShell `Expand-Archive` 解压，并读二进制的版本资源核对（Windows 上 `chrome.exe --version` 不输出任何东西）；本地库与插件目录在 Windows 上不做权限检查（没有 POSIX 权限位，文件沿用 `%LOCALAPPDATA%` 的用户默认 ACL）；前台归还（macOS 的 `osascript`）跳过并记一行日志。
- **Linux：后台标签上的可信输入、导航时的 cookie 快照**。Linux 上被焦点仿真变成 visible 的后台标签没有任何东西绘制它，出过几帧有变化的画面后 Chrome 只给它每秒 1 帧，`click --trusted` / `hover` 的鼠标移动因此超时（`move-timeout`）。绘制检查现在同时量帧率；帧慢时开一个极小的 screencast，从第一条移动之前保持到松开之后，输出里标明（`paint: {frameMs, held: "screencast"}`）。macOS 的标签全速出帧，不受影响。`nav` 的 cookie 快照改为带提交的 URL 调 `Network.getCookies`：不带 `urls` 时 Chrome 可能按还没记下新 URL 的框架树作答，返回空。
- `tabcap daemon status` 新增 `listener`（`unix` 或 `tcp`），Windows 上另有 `port`、`socket` 为 null。`tabcap setup --platform` 接受 `win64`。
- **二进制与发布包**：`bun run release` 用 Bun 交叉编译出 `tabcap-darwin-arm64`、`tabcap-linux-x64`、`tabcap-linux-arm64`、`tabcap-windows-x64.exe`，各打成 `tabcap-v<版本>-<平台>.tar.gz`（Windows 为 `.zip`），内含二进制、skill、`README.md` 与 `README.zh-CN.md`（只含快速开始）、`LICENSE`、`NOTICE`；每个包一个 `.sha256`，另有一份 `SHA256SUMS`。
- **CI**（GitHub Actions）：Linux、Windows、macOS 上跑单元测试、类型检查、skill 校验；Linux（Xvfb）与 Windows 上跑端到端测试，Chrome for Testing 由 `tabcap setup` 下载并按版本缓存；打 `v*` 标签时在对应 runner 上构建四个包（linux-arm64 为交叉编译）并建草稿 release，从不自动发布。
- **打包模板**放在 `packaging/`（不发布到任何地方）：Homebrew formula（macOS arm64）、npm 包装包（每个平台一个可选依赖，启动垫片不带安装脚本）、Scoop 清单。
- 仓库在所有系统上都以 LF 换行检出（`.gitattributes`）；夹具与生成文档按字节比对。

## 0.2.0（2026-10-15）

- **改名**：`bbl` 改叫 `tabcap`。二进制、skill（`skill/tabcap/`）、默认目录（`~/.config/tabcap`、`~/.cache/tabcap`、`~/.local/share/tabcap`）、环境变量（`TABCAP_HOME`、`TABCAP_CHROME`、`TABCAP_SESSION`、`TABCAP_LOG`）都用新名。0.2.x 仍认旧的 `BBL_*` 环境变量，0.3 删除。旧目录不自动迁移：重跑一次 `tabcap setup`，或者把 `~/.config/bbl` 等改名。
- **等待**：`tabcap wait --text | --selector | --url | --idle | --fn` 等页面条件；`tabcap net wait --url` 等某个接口带正文回来。超时的报错写明还差什么。
- **控制台**：`tabcap console` 看标签页的 console 和未捕获异常（带短栈），不录制也保留最近 500 条。
- **录制**：WebSocket 帧进包（`net list --kind ws`、`net body r-12:34`）；console 进包；每条命令记成开始 / 结束一对事件；没收到响应的请求 `status` 记 null。
- **离线分析**：`tabcap analyze find <包> <文字>` 找文字出现在哪个请求、帧或控制台行，自动走 base64、gzip、URL 编码、JSON 转义等解码链，找不到时列出疑似加密的响应（熵阈值按长度分档）；`tabcap analyze diff <包1> <包2>` 对比几次录制里的参数：常量、会话值、时间戳、每次都变。`--save` 把结论写回包里。
- **命令表导出**：`tabcap schema --json` 输出全部命令、参数、选项的类型和默认值、说明和例子，方便接到别的 agent 或工具。
- HAR 导出不含 `cmd`、`console` 事件，在 `dropped` 里列出数目。

试用反馈修复（同属 0.2.0）：

- **弹窗不再抢前台**：页面 `window.open` 开出的窗口或前台标签会让 Chrome 跑到 macOS 最前面，tabcap 发现后把前台还给原来的应用（`tabcap browser status` 的 `popupFocus` 有计数）。你本人正在用这个浏览器时不会去抢。
- **能操作弹窗**：弹窗出现在 `tabcap tabs` 里（`reason: popup`、`opener`），opener 是本会话自己开的标签时弹窗也归本会话所有，`session stop` 会一并关掉。所有针对标签的命令都能加 `--tab t2`；`tabcap tab use t2` 切换当前标签。
- **不再假成功**：元素被页面重渲染替换后，旧 ref 的 `click` / `fill` 报 `stale-ref`（提示重新 snapshot），不再报「点了」却什么也没发生。
- **`tabcap net show <id>`**：一个请求的全部细节——请求头、请求体（超过 2 KB 给文件路径加前 2 KB）、响应头、正文路径、耗时、发起位置 `url:行:列`、所属导航和标签、结果；`r-12:34` 显示一个 WebSocket 帧。
- **`net list` 不再被噪音淹没**：默认隐藏失败请求（例如页面扫端口）和 `data:` 地址，但一定给出 `total`、`shown`、`hidden: {failed, data}` 计数；`--failed` 只看失败的，`--all` 全看；新增 `--host`、`--status 4xx`、`--method`、`--tab`、`--since c-12`、`--limit`（默认 100）、`--offset` 分页。
- **`net wait` 回看到上一个动作**：从最近一条动作命令（navigate / click / fill / type / press / go / reload / evaluate）开始算，`click → wait --text → net wait` 不再超时；`--since start` 看整个录制，`--fresh` 只等新的；超时提示里列出更早已完成的匹配。录制时动作命令返回自己的 `cmd` 编号。
- **`find` 先给可点的**：可点击的命中排在前面；自定义复选框、`div role=none` 按钮这类控件，`find` 会找到真正带点击监听或手形光标的元素，点它的 `clickable` ref 即可。
- **`evaluate` 返回 Promise 时**报 `needs-await`（提示加 `--await`），不再返回 `{}`。
- `tabcap net list --help` 这类两级帮助、`tabcap net --help` 列子命令；新增 `tabcap --version`。
- `tabcap setup` 会清掉上次中断留下的半截下载，下载失败也不留临时目录。
- 证据包文件权限收紧为仅本人可读（文件 0600、目录 0700）；事件的 `actor` 默认记为 `ai`，不再把导航之后页面自己发的请求记成 `human`。

## 0.1.0（2026-10-15）

以 `bbl` 为名首发，只测过 macOS arm64。守护进程自己管一份 Chrome for Testing（独立 profile），后台标签操作、不抢前台；`navigate`、`snapshot`（带 ref 的无障碍树）、`find`、`click`、`fill`、`type`、`press`、`evaluate`、`screenshot`、`dialog`、会话与标签管理；`net start | stop | list | body` 把网络请求连正文录进包；`bundle export har | import har | redact | info`；Claude Code skill。
