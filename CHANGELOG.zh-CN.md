# 更新记录

[English](CHANGELOG.md) | 中文

## 未发布

- **帧路径 ref（0.4-I）**：`snapshot` 与 `outline` 的头里列出所有子帧（iframe、`frameset` 的 `frame`，跨源的也算），每帧一行 `f2/f1  <url>  same-origin|cross-origin  depth 2  "<标题>"`，按深度缩进；`f<n>` 的 `n` 是该帧在父文档子帧里按文档顺序的序号（从 1 起），同源 / 跨源相对父帧。JSON 多一个 `frames` 列表。没有子帧的页面输出与以前相同。
- **`snapshot --frames`** 展开每个帧的树，**`snapshot --frame f2/f1`** 只展开该帧及其后代（根文档只在头里）。帧里的元素是**帧路径 ref**：`f<n>/e<m>`，嵌套 `f<n>/f<k>/e<m>`；`--max-chars` 按帧算，超出的帧末尾一行 `(truncated)`。
- **所有带 ref 的命令都认帧 ref**：`click`（含 `--trusted`）、`fill`（含 `--trusted`）、`hover`、`upload`、`where`、`screenshot --ref`、`evaluate --function … --args '[{"ref":"f2/e7"}]'`（函数在那个帧的 window 里跑）。同源帧经标签会话解析，OOPIF 经它自己的会话；可信鼠标输入仍发给标签，坐标按帧的偏移链平移，先在帧里、再在每层的所有者元素处做遮挡检查。帧导航后它的 ref 失效（`stale-ref` 说明是哪一帧）；帧路径写错时告诉你这个编号对应哪个 ref。对帧 ref 的动作输出带 `frame`（也进 `cmd` 结束事件的 `outputSummary`）。
- **帧里的遮挡**：遮挡头也看子帧（标 `in f2`）；带 iframe 的遮挡（iframe 弹层）把 iframe 里的关闭按钮连同帧路径 ref 列进 `close`，可以直接 `click` 关掉。对帧 ref 的 `click` / `fill`，上层文档的遮挡盖住这个帧时也报 `covered`。
- `type` 顺着焦点进帧（同源在页面里，跨源经该帧会话）判断是不是密码框，帧里的密码同样脱敏。
- 靶场加 docs/05 s22 frames（frameset、跨源 iframe 嵌同源帧、关闭按钮在跨源 iframe 里的 iframe 弹层）。

- **侦查档案 v0（0.4-J）`tabcap recon [--text]`** 与离线的 **`tabcap analyze recon <包> [--text]`**（离线时用包里最后一份录到的文档代替页面）：对会话的录制和当前页面写一份档案进证据包，`exports/dossier.json`（schema `tabcap-dossier/0`）与 `exports/dossier.md`（0600，每次覆写）；命令输出两个路径、简短摘要和 `receipt: {dossier: "exports/dossier.json"}`，`cmd` 结束事件的 `outputSummary.receipt` 里也有。不发任何请求。只答四问：
  - **技术栈**：当前页面上每个适配器的 `detect` 结果，加一张 17 条的固定标记表（响应头 `server`、`x-powered-by`、`x-aspnet-version`、`x-aspnetmvc-version`、`x-generator`、`x-runtime`、`x-nextjs-cache`；会话 cookie 名 `JSESSIONID`、`ASP.NET_SessionId`、`PHPSESSID`、`laravel_session`、`csrftoken`、`_<app>_session`、`connect.sid` 等），头的值照录、cookie 只记名字，标【推断】，不猜版本。
  - **数据通道与覆盖率**：请求按方法、路径模板（数字、uuid、长十六进制段写成 `{id}`）、资源类型、正文类别（`json | html | fragment | text | binary | ws | sse`）分组，列条数、首条 `r-N`、状态码、`unreadByPage`、用到的解码步骤和各自承载的页面词数；覆盖率是页面可见文字的词（≥ 4 字符，数字 ≥ 4 位）用 `analyze find` 的精确匹配在录到的响应和收到的 WebSocket 帧里找到的比例，另列至多 20 个没找到的词。
  - **cookie 分类**：按名字列来源（`r-N` 的 `set-cookie`、录制开始时已有、未录到）、有效期、标志、按名字表给的用途（`session`、`csrf`、`consent`、`analytics`、`load-balancer`、`unknown`；【推断】）和 `analyze deps` 给出的 `requiredBy`（分级同 deps）；名字像 csrf 的请求头和字段也列出，来源取 deps。
  - **防护识别**：guard 的挑战识别（类型、`r-N`、交给人的内容）和响应信号（HTML 403、429、`retry-after`、限流头、四个 bot 管理头名），只记名字，【推断】。只识别，不给任何绕过提示。

- **线路层 probe（0.4-W2）`tabcap wire probe --client <export-python 目录> [--port <p>] [--samples <n>] [--text]`**：生成的 Python 客户端和 tabcap 启动的 Chrome for Testing 相比，哪一层网络特征不同，在 127.0.0.1 的本机 TLS echo 上测。客户端新增的 `uv run client.py wire-report --url … --ca … --out …` 发一次 GET（用它自己的 `Session()`，echo 的 CA 经 `SSL_CERT_FILE` 传入，回环地址不走代理）；组件的 `check` 与 `diff` 拿它和浏览器基准比。输出 schema `tabcap-wire/0`：`browser{version, flagsHash, profile, cached}`、`client{library, version}`、`layers[{layer: tls|h2|headers, verdict: same|differs|missing, fields[{field, browser, client}]}]`、`checks[{code, status, message}]`、`labels`（只有一边恢复了 TLS 会话时出 `psk`）与固定的 `note`；`--text` 打表。会话在录制时，四份文档（浏览器报告、客户端报告、check、diff）存 blob，每个不同的层写一条 `finding`（`tool: "wire"`，grade `实测`）。只诊断：说哪层不同，不说站点为什么拒绝，不给改值的办法。
- **`tabcap wire profile [--samples 3] [--port <p>]`**：浏览器基准。在会话里开一个后台标签（tabcap 启动的 CfT，用 tabcap 自己的启动参数），只对这个标签忽略证书错误（`Security.setIgnoreCertificateErrors`），导航到 `https://localhost:<p>/` 再在页面里 `fetch("/fetch")`，各 N 次，然后关掉。组件的 `profile` 把导航与 fetch 分成两种头顺序角色（`http.roles`）；tabcap 加 `tabcap` 段（CfT 版本、本机路径换成记号的启动参数及其 sha256、样本数）。写到 `cache/wire/profiles/cft-<版本>-<os>-<arch>.json`（报告在 `.samples/`），版本与参数哈希不变时 `wire probe` 复用。CfT 155.0.8059.79 的 macOS arm64 画像入库为 `native/wireprint/corpus/chrome/155/macos-arm64/155.0.8059.79.json`；CI 的 e2e 作业把各自采到的上传为 `wire-profile-<os>` 产物。
- **`tabcap wire serve [--port <p>] [--capture-dir <目录>]`**、**`wire version`**、**`wire ca-path`**：单独起 echo（先打印 `{url, port, caPath}`，Ctrl-C 前对每个请求回它自己那条连接的 JSON 报告）、组件的版本 / 路径 / sha256、echo 的测试 CA（`src/wire/certs/`：CA + leaf，SAN 为 localhost、127.0.0.1、probe.test，带 Authority Key Identifier；私钥故意公开，只给 127.0.0.1 用）。
- **echo**（`src/wire/echo.ts`）：`Bun.listen` 前端记录每条连接到 ClientHello 完整为止的字节，整条流原样转给内部 `node:tls`（ALPN h2、http/1.1；不发会话票据：`SSL_OP_NO_TICKET`、`sessionTimeout: 0`，实测 Chrome 因此不带 pre_shared_key）；h2 到首个 HEADERS 块、或 HTTP/1.1 请求头，交给组件的 `report`。
- **组件嵌进 tabcap**：`bun scripts/native.ts build` 交叉编译 `native/dist/<目标>/wireprint[.exe]`（aarch64-macos、x86_64-linux-gnu、aarch64-linux-gnu、x86_64-windows-gnu；ReleaseSafe、strip 后 0.55 / 0.70 / 0.57 / 0.97 MB）；`scripts/release.ts` 在 `bun build --compile` 前先编这四个，四个都嵌进去（tabcap 二进制大约增加 2.8 MB）。运行时把本机那个解到 `cache/native/wireprint-<sha256>/`（0700 / 0755），每次 spawn 前核对 sha256；源码运行用 `native/dist/`，没有就用 Zig 0.16.0 现编。发布工作流装 Zig；CI 的 native 作业编四个并跑本机那个，e2e 作业编本机目标。
- **生成的客户端**：`client.py` 只有一个 `__main__`，子命令 `verify`（动作链模式，用法不变）与 `wire-report`。
- **`native/wireprint` 的变化**（docs/11）：新增 `report --client-hello <文件> [--h2 <文件> | --h1 <文件>] [--alpn] [--sni] [--peer]`（一条连接的报告，即 `profile` / `check` / `diff` 读的形状；也解析 HTTP/1.1 请求头）。退出码：0 成功，1 用法或输入错误（消息在 stderr，stdout 为空），3 `check` 判 INCONSISTENT（JSON 照常在 stdout）；`check` 改为输出 JSON。`profile` 写 `extension_order: randomized | fixed | unknown`（参与判断的样本少于 2 个时为 unknown，此时 `extension_order_randomized` 为 null），`check` 遇 unknown 不判 T4；新增 `--server` / `--server-host-os`。`diff` 对两份报告先归一化（去 GREASE、用扩展集合代替被打乱的顺序、PSK 有无记为 `psk` 标签、每连接的值列进 `ignored`；`--raw` 不归一化），新增 `--json`；SETTINGS 二元组整体比较。删除 OpenSSL 版 `serve`、`openssl` 构建选项、`tools/serve-smoke.sh` 与 `tools/capture.sh`；新增 `-Dstrip`；三个系统跑同一套测试。语料只收 `tabcap wire profile` 采的 Chrome for Testing 画像。

- **信号探针（0.4-G）`tabcap fingerprint probe [--ref <名>] [--text]`**：本浏览器对一张固定字段表（49 个）呈现的值：navigator、UA client hints 及文档列出的高熵 hint、screen、devicePixelRatio、时区、canvas 与 audio 渲染（只留字节的 sha256）、WebGL 参数与扩展、语音列表、30 个常见字体族的 `document.fonts.check`、通知 / 定位权限状态、配色与减弱动效媒体查询。字段名沿用追踪模式信号表的 IDL 写法。tabcap 在 127.0.0.1（端口 0）起自己的自包含探针页，在会话里开一个后台标签加载，用完关掉，会话的当前标签不变；会话在录制时往证据包写一条 `state` 事件 `{what:"env", source:"fingerprint-probe", fields}`。默认输出 JSON 信封（schema `tabcap-fingerprint/0`：`browser`、`ref`、`fields:[{name, value, ref, verdict}]`、`summary`），`--text` 打表。
- **参照值只来自你自己的采集**：`tabcap fingerprint serve [--port <p>] [--once] [--force]` 在 127.0.0.1 上给你自己的浏览器提供探针页，手动打开打印出的地址、点「Save as reference」，写成 `config/fingerprint/refs/<名>.json`（文件 0600、目录 0700；名字 `[a-z0-9-]{1,40}`；同名已存在时不加 `--force` 拒绝）。`fingerprint ref list | show <名> | remove <名>`。不经 CDP 采集，tabcap 不带任何参照值。
- **`--ref <名>`** 加参照列与逐字段结论：`same`、`differs`、`missing`（本浏览器缺、参照里有）、`extra`（本浏览器有、参照里缺）；哈希按字符串比，数组按顺序比。**`tabcap fingerprint diff <包> --ref <名>`** 离线拿包里最后一条 `state` env 事件同样比。
- 只读分析：探针页只读（不写 cookie、不写 storage），输出是字段表，不打分，不给任何改值的建议。会话交给人处理期间 `fingerprint probe` 与 `tab new` 一样等待。
- 结论方向（0.4-G2）：`missing` 改为本浏览器缺、参照里有的字段，`extra` 改为本浏览器有、参照里缺的字段（0.4-G 初版方向相反）。

- **代理池（0.4-D）**：`tabcap proxy add <名> --url <scheme://host:port> [--user <用户>] [--password-stdin] [--bypass "<列表>"]`（密码只从 stdin 或提示符读；`socks5://` / `socks4://` 带用户名一律 `unsupported`，Chrome 只支持无认证 SOCKS）、`proxy list`（名字、scheme、host:port、用户、hasAuth、bypass、状态、上次检查，不列密码）、`proxy remove`、`proxy check <名> [--url <地址>]`。健康检查只打你给的地址（`--url` 或 `config.json` 的 `pool.health.url`），都没有时什么都不连、状态记 `unchecked`。状态：成功一次 `unknown` → `up`，连续 3 次失败 `down`，之后按 1 / 5 / 15 分钟重查，成功一次回 `up`。
- **账号绑代理**：`tabcap account bind <站点>.<用户> --proxy <名>|system|none`、`account list [--site]`（状态、coolUntil、代理、lastUsedAt）、`account set-state <站点>.<用户> active|disabled`。账号状态：`active`；guard 熔断后 `cooling` 30 分钟（交人照常）；24 小时内 2 次登录失败（`--confirm` 放行的密码重试算一次失败）转 `needs-human`，只有 `handoff continue` 或 `account set-state … active` 能清；`disabled`。
- **`tabcap account add <站点> --user <用户> [--password-stdin] [--totp-stdin]`** 给已有站点加第二个（第三个……）账号，`--account auto` 的 `round-robin` / `lru` 才有得选。密码只从提示符或 stdin 读，不走参数，输出里没有；`<站点>.<用户>` 重复报 `conflict`。带 `--totp-stdin`（须同时 `--password-stdin`）时 stdin 两行：密码、TOTP 种子。`account remove <站点>.<用户>` 是它的逆操作（同时清掉已存 cookie 与计数），守护进程里有会话正在用该账号时拒绝。
- **`tabcap proxy set-state <名> active|disabled`** 手动停用代理（分配与轮换跳过、不做检查）或重新启用（回到 `unknown`，失败计数清零，等下一次检查）。输出 `{proxy, from, state}`。
- **`session start <名> --site <站点> [--account <用户>|auto]`**：`auto` 按 `config.json` 的 `pool.strategy`（`fixed` / `round-robin` / `lru`）选。输出与证据包 manifest（`session.proxy`）只记账号名和代理名。绑了代理的账号在 `direct` 模式下有自己的 browser context（Chrome 只拿到 `host:port`），开会话时恢复保存的 cookie，每次 cookie 快照、`session stop` 和守护进程关浏览器前回写。一个池账号同时只开一个会话。
- **代理认证**由守护进程在浏览器会话上经 `Fetch.authRequired` 应答；开着时每条命令输出带 `fetchAuth: "on"`。代理密码、`user:pass@host:port`、`base64(user:pass)`（Chrome 把 `Proxy-Authorization` 报进 `raw/cdp.jsonl`）在所有输出、守护进程日志和证据包里都显示为 `<secret:proxy.<名>>`。
- **出口策略与预算**（`config.json` 的 `pool`）：`egress: {mode: "fixed"|"rotate", rotateOn: "per-session"|"every:<N>requests"|"every:<T>min"}`（是否轮换在开会话时决定）；每账号每小时请求预算 `budget.requestsPerHour` 可选、默认不设，用满后操作页面的命令返回 `guard.budget` 到下一个小时。`guard` 事件的 `budget` 与 `breaker` 开始实际写出（docs/04 §4.2）。
- **下游**：生成的 Python 客户端读 `TABCAP_PROXY_URL`；`replay export-python --proxy-env <文件>` 把证据包账号的代理 URL 写进去（0600，不打印）；`replay check --live` 走同一个代理。
- Chrome for Testing 启动参数加 `--disable-features=…,PreconnectToSearch`：带代理的 context 否则每次导航都经代理发 `CONNECT www.google.com:443`。
- 新错误码 `guard.budget`、`ext.no-context`（ext 模式给不了绑代理账号独立 context，改用 direct）。本地库迁移到第 3 版（只加不改）。

- **`tabcap analyze deps <包> [--session 名] [--request r-N] [--text] [--write-findings]`**：确定性的值流依赖图（schema `tabcap-deps/0`）。对每个请求的每个输入（query 参数、表单与 JSON 正文叶子、`x-*` / `authorization` 头、按名的 cookie），列出在更早事件里找到的来源，按优先级：更早响应的 `set-cookie`、更早响应正文里的值（经 `analyze find` 解码链的 JSON 路径，或 HTML / 文本里的整词）、录到的 `fill` / `type` 值、更早请求发过的同名同值参数、常量、时间戳（`analyze diff` 的分类）。只做精确匹配（去首尾空白，query / 表单值 URL 解码）；来源必须早于这个值第一次被发出。找不到来源的输入标 `computed-in-page`（带 diff 的提示和与它同变的输入），cookie 标 `unrecorded`。`--secret` 填的值只会匹配它的 `<secret:…>` 占位符，输出里不含任何值。与 `find` / `diff` 一样默认输出一个 JSON 信封（`--text` 出文本报告）；证据包只读，`--write-findings` 才追加 `finding` 事件（`tool: "deps"`，从包里重读核对过的精确来源为 `实测`，其余 `推断`）。
- **`tabcap analyze chain <包> [--request r-N] [--session 名] [--text]`**（schema `tabcap-chain/0`）：重现某个请求（默认：最后一个有数据的 xhr / fetch / document 请求）需要的请求，按录制顺序，每步写明给后面提供什么、还要调用方给什么；`todo` 列出 `computed-in-page` / `unrecorded` 输入。
- **`replay export-python` 按动作链生成**（依赖图里有请求取用了更早响应的值时默认开启；`--chain` 强制开，`--no-chain` 与 0.3 输出相同，「变更」里的 uv 打包除外）：来自前一步回复的值成为参数，`computed-in-page` 输入成为默认值 `TODO` 的参数（注释写明提示和同变输入），名字像密码、token 的输入（与 `bundle redact` 同一规则）不写进任何文件；`client.py` 带 `verify()`：`uv run client.py verify --base-url <地址>` 逐步重放动作链，每步按 `replay check` 的比法和录制比，打印 pass / fail 表，有失败退出码非 0。录到的期望值在 `verify_expected.json`（0600；秘密是 `<secret:…>`，运行时从 `TABCAP_SECRET_*` 取；附脱敏副本说明）。调用方在可选的 `todo_inputs.py` 里填 TODO，生成的 README 写明流程。
- 生成的文档保留离线命令自己的 `--session`（只有守护进程共用的 `--session` / `--timeout` 不进用法行）。
- **追踪模式：哪些页面脚本读了哪些浏览器信号（0.4-F）**：`tabcap trace start [--apis <文件>] [--stack 8] [--first-n 20] [--max-hits 500]`、`trace stop`、`trace status`、`trace list [--api <名>] [--script <url>] [--text]`。按会话、显式开启：开了之后会话现有和以后的标签、iframe（含跨进程的）和专用 Worker 都追踪，直到 `trace stop` 或 `session stop`。只读：用调试器断点（`Debugger.setBreakpointOnFunctionCall`，在文档第一条脚本执行前的 `scriptFirstStatement` 暂停里装好）记下哪个脚本哪一行读了哪个 API，页面里不注入、不包装、不改任何东西。断点会让脚本变慢、时间可被察觉——`trace start` 与 `trace status` 的输出写明，开着时每条命令的输出带 `"trace":"on"`。
- 证据包新增事件 **`signal`**（docs/04 §4.1）：每个 (文档, api, 调用位置) 一条，带 `count`、`firstMono` / `lastMono`、每个 (api, 调用位置) 前 `--first-n` 条事件带最多 `--stack` 帧的栈、某 API 在一个文档里命中满 `--max-hits` 次后 `truncated: true`（该文档的这个断点随即撤掉），以及每个文档每个 API 在 tabcap 隔离世界里读一次的 `value`（≤ 1 KB 内联，否则 blob；cookie、storage、表单值写 `"<not-recorded>"`；秘密值替换）。tabcap `evaluate` 引起的读取标 `caller.kind: "tabcap"`。canvas、WebGL 错误、音频上下文的 instrumentation 事件记为 `access: "event"` 的 `signal`。
- `manifest.mode.trace` 为 `false` 或追踪设置（`mechanism`、`apis` = 当前信号表的 sha256、`stack`、`firstN`、`maxHits`）；`manifest.traceWindows` 列出每个追踪窗口开、关时写的 `note` 事件。
- 内置信号表覆盖 navigator、screen、时区、canvas、WebGL、语音列表、字体检查（只有名字；`$TABCAP_HOME/config/signals.json` 或 `--apis` 可替换：最多 500 个名字的 JSON 数组）。浏览器里没有的名字跳过并在 `trace status` 列出；Chrome for Testing 155 上是 `Window.prototype.devicePixelRatio`（全局对象自有的访问器，不在原型链上）。
- 会话等人处理（`waiting`）期间追踪跳过所有调试暂停（`Debugger.setSkipAllPauses`），输出 `"trace":"paused"`；`handoff continue` 恢复。两者都记 `note` 事件。
- 已知盲区：导航开始之后旧文档里的读取记不到；Service Worker 与 Shared Worker 不追踪。

### 页面上的值从哪来（0.4-C）

- **`tabcap where <ref|文字> [--as ref|text] [--top 5] [--text] [--write-findings]`**（schema `tabcap-where/0`）：页面上显示的一个值来自哪个录到的响应。会话的标签页有当前快照时，`e12` 这样的输入是 ref，取该元素的可见文字；其它输入按原样搜（`--as` 可强制）。候选来自三处：经 `analyze find` 解码链的 JSON 值（路径与步骤名和 `find` 一致）、其它文本正文的整段文字、HTML 响应的文本节点（指向响应源码的标签路径选择器）；JSON 候选排在 HTML 候选前。`match` 为 `exact`（去首尾空白后相等，score 1）或 `normalized`（score = 1 / (1 + 用到的规则数)）；同分时更早的请求在前。只读本会话的录制（正在写的包，`net stop` 后是最后一个包），不发任何请求。默认输出 JSON 信封；`--text` 出文本报告；`--write-findings` 追加 `finding` 事件（`tool: "where"`，精确匹配 `实测`，归一化匹配 `推断`）。
- **值归一化**（表驱动，列出所有合理解释及所用规则名，规则少的在前）：`trim`、`nbsp`、`html-entity`、`js-escape`、`fullwidth`、`thousands-sep`（`,` `.` `'` 空格，印度分组 `1,23,456`）、`decimal-comma`、`accounting-negative`（`(1,234.56)`）、`trailing-minus`（`1234.56-`）、`trailing-zeros`、`date-yyyymm`（`2026-09` / `202609` / `09/2026`；完整日期 `20260915` / `15/09/2026` / `09/15/2026`）、`dotted-code`（`1001.01` ↔ `100101`）、`dr-cr`、`empty-zero-null`。两段都 ≤ 12 的 `a/b/YYYY` 日期，只有同页另一个日期能证明日月顺序时才给候选，否则 `ambiguous` 列出两种读法（reason `ambiguous-date`）。只归一到空 / `-` / `—` / `null` / `0` 的查询返回 reason `too-common`。
- 非 UTF-8 的正文按声明的字符集解码（响应的 charset、content-type，否则 HTML `<meta charset>`），例如 GBK；不认识的字符集在无其它命中时给 reason `unsupported-charset`。
- 端到端测试加入靶场场景 s40 locale-numbers（同一份 `/api/rows` 的 en-US、de-DE、fr-FR、en-IN、会计格式五种渲染）。

### HTML 页面里的内嵌状态（0.4-H）

- **解码链新增三个步骤**，解 HTML 文档里携带的状态，`analyze find`、`where`、`analyze deps` 共用（不执行页面脚本，只做有上限的文本扫描）：
  - `script-json`：`<script type="application/json">` 与 `application/ld+json`（含 Next.js `__NEXT_DATA__`），节点地址 `script[<n>]`（n 是这类 script 的文档序号），路径接着写 `script[0].$.props.pageProps.rows[0].amount`。单个超过 4 MiB 不解（`truncated`）；JSON 坏了记 `unparsed`。
  - `inline-assign`：内联脚本里顶层的 `window.X = <字面量>` / `var|let|const X = <字面量>`，字面量是对象或数组，按 JSON 或宽松超集解析（无引号的标识符键、单引号字符串、尾随逗号、`undefined` 当 null），节点地址 `assign[X]`，路径如 `assign[__STATE__].rows[0].amount`。函数调用、表达式、模板字符串、函数体内的赋值不解。每文档最多 64 个、每个字面量最多 1 MiB；解析失败记 `unparsed` 并引用前 80 个字符。
  - `viewstate`：隐藏字段 `__VIEWSTATE`、`__VIEWSTATEGENERATOR`、`__EVENTVALIDATION`、`javax.faces.ViewState`，节点 `viewstate[<name>]` 是表单里的原值（`deps` 因此能把 POST 出去的 viewstate 对回携带它的页面），base64 解开后（每字段最多 2 MiB）是 `{bytes: {length, sha256}, strings}`，`strings` 为至少 4 个字符的可打印 ASCII 串与 UTF-16LE 串，按顺序、去重。不做 .NET LOS / Java 对象图解码。
- 解开的节点认领它的原文，文档其余部分照常按字面量匹配，所以同一个值既在脚本里又显示在表格单元格里时，每处各报一次。`find` 落在节点里的命中带 `node`（步骤、地址、script 的 `id` / `type`）；没解开的节点列在 `searched.embedded`。`where` 把内嵌状态候选和 JSON 候选排在一起，排在页面自身的文本节点前面。
- 端到端测试加入靶场场景 s41 embedded-state。

### 删除

- 删除 0.3 的全部弃用别名，不保留兼容：命令 `tabs`（用 `tab list`）、`tab use`（`tab select`）、`press`（`press-key`）、裸 `console`（`console list`）；参数 `net list --type`（`--resource-types`）、`--limit`（`--page-size`）、`--offset`（`--page-idx`），`screenshot --out`（`--file-path`）、`--full`（`--full-page`）；`net list` 输出字段 `offset`、`limit`、`nextOffset`；`--help` 与生成文档里的「deprecated」行；`tabcap schema --json` 的 `deprecatedFor` / `deprecatedAliases` / `deprecated` 字段。旧名现在报普通的 `unknown command` / `unknown option` 用法错误。`console list --limit`（最后 N 条）和 `dialog --prompt-text`（`--text` 的普通别名）保留。

### 变更

- `net list` 与 `console list` 默认分页：不给分页参数时返回第 0 页、每页 100（还有更多时带 `nextPageIdx`）；`--page-size 0` 返回全部（原来的默认行为）。`--page-size 0` 同时给大于 0 的 `--page-idx` 报用法错误。
- 会话等待人接手（hand-off）期间，`resize` 和 `emulate` 与其它作用于页面的命令一样返回 `waiting` 错误。
- 输出全部改为英文：`waiting` 错误的 `next`（"complete the verification in the browser, then run `tabcap handoff continue`"）、DOM 点击与 `type --insert` 的 `incomplete event sequence: …` 警告、`bundle is not finished: …` 警告与 `analyze find` / `diff` 文本报告里的 `(unfinished)`、snapshot / outline 头部（`overlays` / `detected` / `popups`，遮挡行改英文，名字用 ASCII 引号）、`covered` 错误、`replay export-python` 生成包的 README（模板与动作链一节）。只有证据等级（`实测` / `推断` / `待验` / `人确认`，证据包格式里的值）保持不变。
- 脱敏规则 `default@2`（`bundle redact`、HAR 导出，以及 `replay export-python`、`analyze deps` 共用的敏感名规则）：`pass`、`pwd` 作为名字的一段时算敏感（`pass`、`user_pass`、`userPass`、`login-pwd`、`Pwd2`；`bypass`、`passport`、`compass`、`passenger` 不算）；原有子串（`passw`、`token` …）照旧。脱敏副本记 `"rules": "default@2"`。修复 `replay export-python --no-chain` 把名为 `pass` 的登录字段的录制值写进 `client.py`。
- `--help`、生成的命令参考、SKILL.md 与 README 里的示例站点名改为 `example`（原为 `shop`）。
- 生成的客户端用 `uv run` 运行：`uv run client.py verify --base-url <地址>`、`TABCAP_REPLAY=<地址> uv run --group test pytest`（[uv](https://docs.astral.sh/uv/) 首次运行时按 `pyproject.toml` 建 `.venv/`；README、`client.py` 头部注释与 SKILL.md 都这样写，不再出现 `pip install` 或 `python client.py`）。`pyproject.toml` 依赖 `httpx[http2]`，客户端用 `httpx.Client(http2=True)`（只在 TLS 协商出 HTTP/2 时用；明文 `http://`，例如 `replay serve`，仍是 HTTP/1.x）；pytest 从 `test` extra 移到 PEP 735 的 `test` dependency group；输出目录没有 `.gitignore` 时写一个（`.venv/`、`__pycache__/`）。测试与 CI 用 uv：所有 Python 运行都经 uv 离线进行，每个生成包各自一个 `.venv`；CI 每个 job 预热 uv 缓存，在 CI 里缺 uv 或缓存时 Python 测试失败而不是跳过。

### 修复

- `emulate --network-conditions` 在未录制的会话上也真正限速：Chrome 只在 Network 域开启时施加节流，所以模拟了网络预设的标签会保持 Network 开启，直到之后的 `emulate` 清除它；`wait --idle` 与 `net stop` 不再在底下把它关掉。靶场实测：「Slow 3G」下 300 KB 的 fetch 约 8 s（按预设 50000 B/s 算下界 6 s），修复前不录制时只要 1 ms；`wait --idle` 与 `net stop` 之后仍然限速。

### 原生线路层指纹组件（0.4-W1）

- **`native/wireprint/`**（Zig 0.16.0，与仓库其余部分同为 Apache-2.0）：线路层指纹工具作为原生组件并入本仓库。读 pcap、原始 TLS record 与 HTTP/2 客户端流，算 ClientHello 全字段、JA3、JA4（`_r` / `_o` / `_ro`）、HTTP/2 的 SETTINGS / WINDOW_UPDATE / 伪头顺序、HPACK 解码后的头与 Akamai 串，另有画像组装、跨层一致性检查与按层分组的 diff。`bun run test:native` 跑它的离线测试（`zig build test -Dopenssl=false`），`bun run fmt:native` 格式化；CI 在 Linux、Windows、macOS 上构建，并交叉编译 darwin-arm64、linux-x64、linux-arm64、windows-x64（暂不进发布包）。只构建 `-Dopenssl=false`：原来的 `serve` 回显服务器留在源码里但不编译。JA4H / JA4T 代码与 `-Dja4plus` 选项在并入前删除。浏览器画像（`corpus/`）今后只来自 tabcap 集成的 Chrome for Testing 版本。第三方声明（JA3、JA4、RFC 7541 表）见 NOTICE。

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
