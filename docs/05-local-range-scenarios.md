# 本地靶场场景清单（草案，待审）

2026-10-15。对应 `03` §10 第 5 条。靶场是**唯一**的端到端测试对象：所有验收、演示、合规说明都对着它跑，不碰第三方站点。每个场景演示一种通用模式，页面不模仿任何真实站点的品牌或界面。

标注：**P1** 阶段 1 必须过；**P1\*** 阶段 1 实现但允许「待验」（依赖 `chrome.debugger` 的能力，先量再说）；**P2** 阶段 2 才验收，场景现在定下来，服务端可以先写。

## 1. 靶场本身

- 目录 `range/`，一个 TypeScript 进程，`tabcap range serve` 起两个源：**A** `http://127.0.0.1:4310`（主）、**B** `http://localhost:4311`（跨源用；host 和端口都不同）。
- **确定性**：所有数据由种子生成（`?seed=`，默认 1），同一种子同一输出；时间戳类字段除外，但标明。
- **日志即 oracle**：服务端把每次响应记进日志 `GET /__range/journal?run=<runId>` → `[{ts, method, url, status, bodySha256, size, scenario, note}]`；`POST /__range/reset?run=<runId>` 清零。页面从 URL 的 `?run=` 带上 runId，所有请求透传它。验收 2 的「证据包里都在」就是和这份日志比对。
- 每个场景一个目录：`range/scenarios/sNN-<name>/`，含 `README.md`（模式、要证明什么、人工走法）、`page.html`、`api.ts`、`expected.json`（该场景的期望值：命中的接口、参数分类、应缺正文的原因）。`expected.json` 是**场景定义的一部分**，由写场景的人写，不由 AI 为了让测试通过去改。
- 服务端在响应头加 `x-range-scenario`、`x-range-body-sha256`，方便人肉核对。
- 一键自检：`tabcap range selftest` 不用浏览器，用 `fetch` 把每个场景的 API 走一遍，对照 `expected.json`，保证靶场自己没坏。

## 2. 场景

### s01 plain-json（P1）

- 页面 `fetch('/api/items?page=1')`，渲染列表；目标文字是某条 `title`。
- 证明：基础录制；`find` 命中并给出 JSON 路径。
- expected：`find "<title>"` → `[{request: "GET /api/items?page=1", path: "$.items[2].title", decode: []}]`。

### s02 multipage-nav-race（P1，验收 2 核心）

- 页面 A 加载后发 3 个请求：`/api/fast`（立即回）、`/api/slow`（服务端延迟 800 ms）、点击「下一页」时在 click 处理器里 `fetch('/api/before-leave', {method:'POST'})` 然后**立刻** `location.href='/s02/b'`。页面 B `XHR /api/b-data`，再有链接到 C（整页跳转），C 发 `/api/c-data`。
- 证明：跳转前的请求正文不丢（`before-leave` 必须有正文，这要求 `04` §5.2 第 8 条的 Fetch 拦截默认开）；被导航取消的 `slow` 记为 `outcome:"incomplete", bodyMissing.reason:"navigated"`，不是悄悄消失（【实测】spike 2：取消的请求不发 `loadingFailed`）；三页请求各自挂在正确的 `nav` 纪元。
- expected：`journal ⊆ bundle`（按 method+url+bodySha256），例外清单 `[{url:"/api/slow", allow:"incomplete-navigated"}, {url:"/api/medium", allow:"incomplete-navigated"}]`；`nav` 事件 3 条（`navigation`）。
- 这也是 `04` §5.2 第 8 条「跳转竞态」的测量场景：报告漏取率，目标 0。临时版的 spike 2 结果：Network 急取对 finished 的请求 0 漏，`before-leave` 100% 丢；Fetch 拦截 100% 救回。

### s03 spa-routes（P1）

- 单页：`#/list` → `#/detail/7` → `pushState('/s03/app/settings')` → 后退 → 前进；每个路由各发一个 XHR。
- 证明：`history` 类 `nav` 事件、`back_forward` 识别、请求归属纪元。
- expected：`nav` 序列 `[navigation, history×3, back_forward×2]`，每个路由请求的 `nav` 指向对应纪元。

### s04 encodings（P1，验收 3 正例）

同一段目标文字 `「靶场 s04 目标文本 ✓」`（含中文、全角、emoji）通过 12 条通道返回，页面全部渲染出来：

| 通道 | 服务端做法 | `find` 应报的解码链 |
|---|---|---|
| a plain | `application/json` 明文 | `[]` |
| b gzip-wire | `content-encoding: gzip` | `[]`（CDP 已解；导入 HAR 时为 `["gzip"]`） |
| c br-wire | `content-encoding: br` | 同上 `["br"]` |
| d base64-field | `{"data":"<base64(json)>"}` | `["base64","json"]` |
| e base64-gzip-field | `{"data":"<base64(gzip(json))>"}` | `["base64","gzip","json"]` |
| f unicode-escape | JSON 里 `靶场…` | `["json-unescape"]` |
| g nested-json-string | `{"payload":"{\"title\":\"…\"}"}` | `["json-string","json"]` |
| h form-urlencoded | 响应 `application/x-www-form-urlencoded` | `["urldecode"]` |
| i html-entities | HTML 片段 `&#x9776;&#22330;…` / `&amp;` | `["html-entities"]` |
| j jsonp | `cb({...})` | `["jsonp","json"]` |
| k sse | `text/event-stream` 三条 `data:` | `["sse"]` |
| l ndjson-chunked | chunked 传输、每行一个 JSON | `["ndjson"]` |

- 证明：`find` 对每条通道都命中并正确报解码链；输出里列出「搜了多少个正文、跳过了哪些（二进制/超限）、用了哪些解码器」。
- expected：12 条全命中；另有一条**阴性对照**：搜一段不存在的文字 → 0 命中、**不**提示加密（页面没有高熵正文时）。
- 配套 HAR 夹具：`fixtures/har/s04-devtools.har`（人用 DevTools 对此场景导出一次）、`fixtures/har/s04-gzip-raw.har`（脚本合成：正文仍是压缩字节 + base64），导入后 `find` 结果与自录一致。

内嵌状态步骤（0.4-H，作者 10-16 定；靶场场景见 §5 s41）：HTML 文档里的内嵌状态是解码链的三个内置步骤，`find` / `where` / `deps` 共用，不走适配器的 `decode` 钩子；页面脚本一律不执行，只做有上限的文本扫描。步骤名是契约的一部分：

| 步骤 | 识别 | 节点地址与路径 | 上限与失败 |
|---|---|---|---|
| `script-json` | `<script type="application/json">`、`<script type="application/ld+json">`（含 Next.js `<script id="__NEXT_DATA__" type="application/json">`） | `script[<n>]`，n 是这类 script 在文档里的序号（解不开的也占号）；其下接 `.$` 再接 JSON 路径：`script[0].$.props.pageProps.rows[0].amount`，非标识符键照 `find` 的写法加引号：`script[1].$["@graph"][0].sku`。`find` 的命中带 `node`（地址、`id`、`type`） | 单个 > 4 MiB（UTF-8 字节）不解，记 `truncated`；JSON 坏记 `unparsed` |
| `inline-assign` | 无 `src`、JavaScript 类型的内联脚本里，**顶层**（不在任何括号内）的 `window.X = <字面量>`、`var\|let\|const X = <字面量>`；字面量是对象或数组，按 JSON 或宽松超集解析（无引号的标识符键、单引号字符串、尾随逗号、`undefined` → null），且语句在字面量后结束 | `assign[<X>]`（不带 `window.`），其下直接接 JSON 路径：`assign[__STATE__].rows[0].amount`；同名赋值两次地址相同 | 每文档 ≤ 64 个（第 65 个起记 `truncated`）、每个字面量 ≤ 1 MiB（超出记 `truncated`）；解析失败记 `unparsed` 并引用前 80 字符。函数调用、表达式、模板字符串、函数体内的赋值都不解 |
| `viewstate` | `type=hidden` 的 `__VIEWSTATE`、`__VIEWSTATEGENERATOR`、`__EVENTVALIDATION`、JSF `javax.faces.ViewState` | `viewstate[<name>]` 是表单里的原值（`deps` 用它对回 POST 的同值字段）；base64 解开后是 `{bytes:{length, sha256}, strings:[…]}`：`viewstate[__VIEWSTATE].strings[0]` | 每字段 ≤ 2 MiB（超出只搜原值，记 `truncated`）；不是 base64 记 `unparsed`，原值照搜。**不做** .NET LOS / Java 序列化对象图解码 |

- `strings`：≥ 4 个可打印 ASCII 字节（0x20–0x7e）的串，加 ≥ 4 个可打印 UTF-16LE 码元的串（两种字节对齐都扫；可打印 = ASCII、Latin-1、希腊 / 西里尔、常用标点、CJK 符号与假名、CJK 统一汉字、谚文、全角；非 ASCII 码元低字节不为 0；一串里超过一半的码元不能是「两个字节都是可打印 ASCII」，否则那是按错宽度读的 ASCII 文本），按起始字节排序、去重，每字段最多 10000 个（超出记 `truncated`）。所以 3 个字的 `条目甲` 单独存在时不成串，要带前缀（s41 用 `user:条目甲`）。
- 解开的节点「认领」它的文本（script 正文、字面量、input 的 value）：文档其余部分照常按字面量匹配，同一个值在表格单元格里还会单独报一次（链 `[]`、无路径）。节点里没命中、但认领的原文里有字面量命中时，退回整篇文档的字面量命中，不丢结果。
- script JSON 与字面量里的值要解转义才对得上原文时，链末尾加 `json-unescape`（与 s04 f 同一规则）；JSON 字符串里再套 JSON 照常加 `json-string`、`json`。
- 没解开的节点（`unparsed` / `truncated`）列在 `find` 输出的 `searched.embedded`（`ref`、地址、状态、说明）。

### s05 encrypted（P1，验收 3 反例；P3 trace 对象）

- 先 `GET /api/key` 拿 AES-GCM 密钥，再 `GET /api/secret`（密文，base64），页面 JS 解密后渲染目标文字。
- 证明：`find` 无命中时给出可执行的提示：「N 个响应疑似加密或二进制（高熵），候选 r-…；建议追踪模式」，并列出候选。
- expected：命中 0；`hints.suspectEncrypted` 包含 `/api/secret`；不包含 `/api/key`（它是明文 JSON）。

### s06 diff-params（P1，验收 4）

- 搜索页：`GET /api/search?q=<输入>&page=<n>&client=web&v=3&sid=<cookie sid>&t=<epoch ms>&nonce=<随机>&sig=<hmac(q,page,t,nonce)>`，另带头 `x-client-build: 2026.10`。
- 走法：同一 session 录两次（q、page 不同）；再在**只清靶场源 cookie** 的新 session 录第三次（不能动工作 Chrome 其它站的 cookie，见 `06` §4）。
- expected：

| 位置 | 参数 | 类别 |
|---|---|---|
| query | `client`, `v` | 常量 |
| header | `x-client-build` | 常量 |
| query | `sid` | 会话值（同 session 相同，跨 session 不同） |
| query | `t` | 时间戳（单调、与事件 `ts` 相差 < 5 s） |
| query | `q`, `page`, `nonce`, `sig` | 变化值 |

- P2 扩展：`deps` 应指出 `sid` 来自 `set-cookie`，`sig` 与 `q/page/t/nonce` 同变。

### s07 token-chain（P1 录制；P2 deps）

- 登录表单（假账号 `demo/demo`）→ `POST /api/login` 返回 `set-cookie: sid=…` 和正文 `{csrf:"…"}` → 页面随后 `POST /api/data`，带头 `x-csrf` 和 cookie。`?expire=1` 让服务端在第 3 次请求后判 session 过期返回 401。
- 走法：AI 经 CLI `session start --site range-demo`，用 `fill --secret range-demo.password` 登录（凭据在本地库，模型不见明文），再取数据。同一会话再次对登录表单 `fill --secret` 必须被拦下并要求 `--confirm`（最小 guard）。
- 证明：ExtraInfo 的 cookie / set-cookie 都录到；`state` cookies 快照在 nav 边界更新；凭据不泄漏；P2：`deps` 画出 `csrf` 链；`handoff` 处理 401。
- expected：`r(login).response.headers["set-cookie"]` 非空；`r(data).request.headers.cookie` 含 `sid`；`state` 事件 ≥ 2 条且最后一条含 `sid`；`action.value` 为 `<secret:range-demo.password>`；填完密码后 `evaluate` 读密码框 `value` 和 `snapshot` 的输出里只有 `<secret:range-demo.password>`；守护进程日志与 CLI 输出 grep 不到密码明文（登录 POST 正文里的明文是事实，允许存在，导出脱敏后必须消失）；第二次登录尝试返回 `guard.login-limit` 错误且 journal 无新增；manifest 的 `session.site` 为 `range-demo`。

### s08 popup-login（P1；`direct` 模式弹窗自动挂接已【实测】）

- 按钮 `window.open('/s08/popup')`（同源版）和 `window.open('http://localhost:4311/s08/popup')`（跨源版）；弹窗请求 `/api/popup-token`，`postMessage` 回主页，主页再 `fetch('/api/after-popup')`。
- 证明：弹窗自动挂进同一份包（新 `tab` 事件，`reason:"popup"`）；`close_session` 不关弹窗（借用语义）。【实测 10-15 spike 1：守护进程对每个挂上的会话发 `Runtime.runIfWaitingForDebugger` 后，弹窗 60–85 ms 内挂上并导航到 `/popup`；不发则 opener 卡在 `window.open` 里。`ext` 模式经 `chrome.debugger` 的支持阶段 2 再验】
- expected：`/api/popup-token` 在包里，`tab` ≠ 主页标签；`/api/after-popup` 在主页标签。

### s09 cross-origin-iframe（P1；`direct` 模式自动挂接已【实测】）

- A 页嵌 B 源 iframe，iframe 内 `fetch('http://localhost:4311/api/iframe-data')`，目标文字只出现在 iframe 里。
- 证明：OOPIF 自动挂接，请求带 `cdp.sessionId` 与 frame；`find` 命中。【实测 10-15 spike 1：`localhost:4411` 的 iframe 作为页面会话的子会话挂上，其 `/api/iframe` 请求落在子会话】
- expected：命中 `/api/iframe-data`；该 `request.cdp.sessionId` 非空。

### s10 service-worker（P1；`direct` 模式自动挂接已【实测】）

- 注册 SW：`/api/sw-cached` 由 SW 从 Cache 回；`/api/sw-proxied` 由 SW `fetch` 后改写再回。
- 证明：`fromServiceWorker:true` 正确；SW 自己发出的 `fetch` 录到（SW 目标挂接）。【实测 10-15 spike 1：SW 目标自动挂上，其 `/api/sw-origin` 请求录到；经 SW 代理的 fetch 正常返回】
- expected：两条页面请求 `fromServiceWorker:true`；另有一条 `type:"fetch"` 来自 SW 目标。

### s11 websocket（P1）

- 页面开 `ws://127.0.0.1:4310/ws/echo`，发 2 条文本、1 条二进制；服务端回显并额外推送一条含目标文字的 JSON。
- 证明：握手 `request` + 4 收 3 发的 `ws` 帧；`find` 命中 ws 帧并标 `kind:"ws"`。
- expected：`ws` 事件 7 条；`find` 命中 `{ws:"r-<握手>", frame:<seq>}`。

### s12 big-and-binary（P1）

- `/api/big-5mb`（5 MB JSON）、`/api/huge-40mb`（超上限）、`/img/logo.png`（请求两次）、`/api/blob.pb`（固定字节的 protobuf 样式二进制）。
- 证明：大正文完整、哈希等于日志；超限写 `too-large`；PNG `base64:true` 且字节等于源文件；两次请求同一 blob（去重）。
- expected：`big-5mb` 哈希相等；`huge-40mb` `bodyMissing.reason:"too-large"`；`logo.png` 两条 `request` 指向同一 `sha256`；`blob.pb` 字节相等。

### s13 redirect-304-204（P1）

- `/go` → 302 → 302 → `/final`；`/etag` 第二次带 `if-none-match` 得 304；`/empty` 返回 204；`HEAD /head`。
- 证明：`redirect.from` 链正确；`bodyMissing.reason` 分别为 `redirect` / `not-modified` / `no-content`，不是笼统的失败。
- expected：`/final` 的 `redirect.from` 指向第二跳，第二跳指向 `/go`；三种 reason 各至少一条。

### s14 human-recorder（P2；探路由 AI 做，人工操作录制只服务于人介入的时刻）

- 表单：文本框、密码框、下拉、复选、回车提交、按钮点击、`target=_blank` 链接。
- 走法：自动化版用 CDP `Input.*` 发真实输入（`isTrusted=true`）；人工版由人亲手走一遍（`06` 人工清单）。
- 证明：`action` 事件齐全；密码值为 `<masked>`；每步有 before/after 截图；`_blank` 新标签挂进包。
- expected：`action` 序列 `[fill, fill(masked), select, click(checkbox), key(Enter), click]`；无任何 `value` 等于密码明文（grep 整个包）。

### s15 verify-wall（P1 验收最小交接与最小 guard；完整 guard P2）

- `/api/limited` 第 6 次起返回 403 + 「请完成验证」HTML；页面出现验证框，人点「我是人」后 `/api/verified` 解锁。
- P1 证明：AI 收到 403 验证页后停下，CLI 返回 `{state:"waiting", reason:"verify-page", screenshot:"…", next:"…"}`，在人说「继续」前不再对该源发请求；人点完后 `tabcap handoff continue`，之后的请求齐全。
- P2 证明：预算、熔断、探测模式。
- expected：停下前对 `/api/limited` 的请求恰好 6 条；`waiting` 期间 journal 无新增；继续后 `/api/verified` 与后续请求在包里。

### s16 session-expiry（P2）

- s07 的 `?expire=1` 变体：复现客户端用过期 cookie 重放 → 401 → 工具识别为「会话过期」而不是「接口变了」。

## 3. 夹具（提交到仓库）

| 路径 | 来源 | 用途 |
|---|---|---|
| `fixtures/bundles/sNN/` | 用我们的录制器对靶场录一次，手工检查后提交 | `find` / `diff` / 导出的离线单元测试 |
| `fixtures/har/s04-devtools.har` | 人用 Chrome DevTools 对 s04 导出 | HAR 导入 + `find` 一致性 |
| `fixtures/har/s04-gzip-raw.har` | 脚本合成 | 导入时的解压路径 |
| `fixtures/har/roundtrip-*.har` | 由测试自动生成，不提交 | 往返性质 |

夹具数据全是靶场合成的，不含真实账号，不需要脱敏；但 `fixtures/` 仍跑一遍脱敏规则作为规则本身的测试。

## 4. 人工清单（人确认）

自动化覆盖不了的，写成清单，由人走一遍并在 NOTES 记【人确认】：

1. AI 用 secret 登录 s07 再走 s02，人只旁观；事后请求齐全、`actor` 全是 `ai`。再走 s15：AI 撞上验证框停下，在终端说明并给截图路径，人在浏览器里点「我是人」，告诉 AI 继续，之后的请求齐全（P1 最小交接，已采纳）。
2. （`ext` 模式，阶段 2）点横幅的「取消」：工具报 `detached`，**不**自动重挂；下一条命令再挂等于再问一次。
3. 人在别的应用里打字时跑 20 条 AI 操作：Chrome 不来前台，当前标签不变。
4. 一天 soak：`tabcap soak` 每 60 秒一条操作，跑 8 小时；记录 attach / detach 次数、错误、是否出现任何弹框（预期 0；`direct` 模式独立 profile 不弹「允许远程调试」【推断，待验：spike 1】）。
5. s08 登录弹窗在 `close_session` 后仍然开着。

## 5. 真实站点试用后补的场景（10-15，均 P1，先写定义，靶场落地时实现）

### s17 popup-focus
- 页面按钮 `window.open` 开独立窗口（带 features），服务端返回带目标文字的页面。
- 证明：弹窗自动挂接且 owned；弹窗打开前后 macOS 前台应用不变（`osascript` 读最前应用）；`--tab t2` 能对弹窗 snapshot / click；`session stop` 关掉弹窗。

### s18 vue-rerender-stale-ref
- 表格由脚本每 2 秒整体重渲染（节点替换而非复用）。
- 证明：旧 ref 的节点脱离 DOM 后 `click` 报 `stale-ref`，不报假成功；重新 snapshot 后新 ref 可点。

### s19 custom-checkbox
- Element UI 风格的复选框：真实 `<input type=checkbox>` 隐藏，可见的是带 `cursor:pointer` 和 click 监听的 `<span>`；还有一个 `<div role=none>` 做的按钮。
- 证明：snapshot 给可点的非语义元素 ref（`DOMDebugger.getEventListeners` / `cursor:pointer`）；`find 记住密码` 返回可点元素而不是外层 form；可点的排在不可点的前面。

### s20 port-scan-noise
- 页面加载后向 `127.0.0.1:9432`–`9489` 发 60 个必然失败的请求，另有 10 张 `data:` 图片。
- 证明：`net list` 默认隐藏 failed 与 `data:`，显示 `total` 与 `hidden` 计数，`--failed` 能调出；分页 `--limit/--offset` 不静默截断。

### s21 aes-json
- `/api/key` 明文返回密钥，`/api/secret` 返回 AES-GCM 密文 JSON，页面解密后渲染（与 s05 同构，用真实站点里见到的字段形状：`{code:0, data:"<base64 密文>"}`）。
- 证明：`find` 0 命中并把 `/api/secret` 列进 `suspectEncrypted`；`net show` 能看到请求头里的签名类字段。

### s40 locale-numbers（P1，验收：`where` 对回同一 JSON 值）
- 列表页：同一份 `GET /api/rows` 返回 `[{id, amount, qty, date, code, dir}]`（`amount` 为浮点、`date` 为 `YYYY-MM-DD`、`code` 为 `100101`、`dir` 为 `1`/`-1`）。页面按 `?locale=` 用五种方式渲染同一数据：`en-US`（`1,234.56`）、`de-DE`（`1.234,56`）、`fr-FR`（窄空格千分位）、`en-IN`（`1,23,456.00`）、`accounting`（负数 `(1,234.56)` 与尾随负号 `1234.56-`）；`date` 渲染为 `2026-09` / `202609` / `09/2026`；`code` 渲染为带点 `1001.01`；`dir` 渲染为 `DR`/`CR`。另一列用全角数字与 `&nbsp;` 填充。
- 走法：`net start` → 依次导航五个 locale → `snapshot` 取每格 ref → 对每格 `where <ref>`；再 `where "1.234,56"`（文字入参）。
- expected：每个 `where` 的首个候选都是 `r(rows)` 的 `$[i].amount|qty|date|code|dir` 同一路径；`normalized` 字段给出归一化后的值与所用规则名（`thousands-sep` / `decimal-comma` / `accounting-negative` / `trailing-minus` / `fullwidth` / `nbsp` / `date-yyyymm` / `dotted-code` / `dr-cr`）；DD/MM 与 MM/DD 歧义的格子只有当同页另一个值能消歧时才给候选，否则返回 `ambiguous` 并列出两种解释；文字入参命中与 ref 入参一致。

### s41 embedded-state（P1，0.4-H：内嵌状态解码器）
- 页面 `/s41`（`test/e2e/site.ts` 的 `startEmbeddedSite`，所有值在源码里手写）：服务端渲染 HTML，同一份行数据 `[{"id":4201,"amount":1234.56,"code":"100101"},{"id":4202,"amount":56.78,"code":"200202"}]` 出现在四处：(a) `<script id="__NEXT_DATA__" type="application/json">` 的 `props.pageProps.rows`；(b) `<script type="application/ld+json">`，`@graph` 里一个 `Product`，`sku` 等于 code `100101`，`offers.price` 为 `19.99`；(c) 内联脚本 `window.__STATE__ = {user:{id:4201,name:'条目甲'},rows:[…同上…],};`（故意用无引号键、单引号、尾随逗号）；(d) 表单里的 `__VIEWSTATE`，base64 载荷是手写字节：一段假头、ASCII 串 `VIEWSTATE-TOKEN-7f3a9c`、UTF-16LE 串 `user:条目甲`（逐码元写出），另有 `__VIEWSTATEGENERATOR`（`CA0B0334`）与 `__EVENTVALIDATION`。表格列 amount / code / name，显示纯字符串 `1234.56` / `100101` / `条目甲`（不加千分位：`find` 不做数字归一化，加了就搜不到单元格）。按钮的脚本从解开的 `__VIEWSTATE` 里截出 token，`POST /api/s41/submit`（form-urlencoded：`__VIEWSTATE`、`token`）；token 原文不在页面文字里，站点日志记下收到的两个值。
- 走法：`net start` → 导航 `/s41` → `snapshot` → `where <amount 单元格的 ref>` → 点 submit → `net wait --url /api/s41/submit` → `net stop` → `analyze find "1234.56"`、`find "100101"`、`find "VIEWSTATE-TOKEN-7f3a9c"`、`find "条目甲"` → `analyze deps`。
- expected（文档响应记作 r(doc)，命中按此顺序）：
  - `find "1234.56"`：r(doc) 3 处——`script[0].$.props.pageProps.rows[0].amount`（链 `["script-json"]`，`node` 带 `id:"__NEXT_DATA__"`、`type:"application/json"`）、`assign[__STATE__].rows[0].amount`（`["inline-assign"]`）、HTML 单元格（链 `[]`、`path:null`）。
  - `find "100101"`：同上再加 `script[1].$["@graph"][0].sku`（排在 script[0] 之后、assign 之前，共 4 处）。
  - `find "VIEWSTATE-TOKEN-7f3a9c"`：r(doc) 的 `viewstate[__VIEWSTATE].strings[0]`（`["viewstate"]`），外加 POST 请求正文里的原文（`request-body`，链 `[]`）。
  - `find "条目甲"`：`assign[__STATE__].user.name`、`viewstate[__VIEWSTATE].strings[1]`（串是 `user:条目甲`）、HTML 单元格。
  - `where <amount 单元格>`：`normalized` 为 `[{1234.56, []}, {123456, [dotted-code]}]`；候选依次为 r(doc) 的 script 路径、assign 路径（都 `exact`、score 1）、单元格选择器 `form > table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)`（0.4-C 排序：JSON 类在 HTML 文本节点前）。
  - `deps`：POST 的 body `__VIEWSTATE` 主来源 `{kind:"response", request:r(doc), path:"viewstate[__VIEWSTATE]", decode:["viewstate"], match:"exact"}`；body `token` 主来源同一请求的 `viewstate[__VIEWSTATE].strings[0]`（同样 `["viewstate"]`、`exact`）。

## 6. 输入保真（作者定 10-15；提案 `docs/10`，0.3-E 落地）

### s46 input-fidelity（P1；`--trusted` 的拟真点击与逐键输入）
- 页面：`fixtures/probe/input-probe.html`，由作者的本地探针 `/tmp/tabcap-probe/probe.html` 升格；e2e 站点（`test/e2e/site.ts` 的 `startProbeSite`）在 `/probe` 原样提供，页面把自己的事件报告 POST 到同源 `/report`（不再写死端口）。捕获阶段在 `window` 上记录 pointer / mouse / keyboard / beforeinput / textInput / input / composition / focus 的全部字段，键盘事件补 `keyCode` / `charCode` / `which` / `repeat` / `location` 与 `shiftKey` / `ctrlKey` / `altKey` / `metaKey`；一个 `#target`（260×90，含边框 262×92）和一个 `#field`。原探针的指纹与 CDP 探针两段不在场景范围内，删去。页面只记录，不改变点击或按键的行为。
- oracle：`fixtures/probe/oracle/playwright-<Playwright 版本>-cft-<Chrome 版本>-<模式>.json`，由 `scripts/probe-oracle.mjs` 在本机对该页生成（无头、Chrome for Testing 固定版本；Playwright 不是本仓库依赖，用 `--playwright` 指向本地已有安装；不进任何测试运行），人工检查后提交。模式：`click`（`page.click`）、`js_click`（`evaluate(el.click())`）、`type`（`page.type("#field", "aB3 中")`）、`fill`。【实测 10-15，Playwright 1.64.1、CfT 155.0.8059.79】`type` 打 `'B'` 时没有 Shift 按键，键盘事件 `shiftKey:false`、`keyCode:66`（提案里的【待验】由此定）。真人手点、手打的节奏 oracle（A7.9，L3）待作者补。
- 证明（按作者 10-15 的决定修订）：默认 `click` 仍是 DOM 点击，只有 1 个不可信 `click`，输出标 `eventShape:"incomplete"` 与「incomplete event sequence」；`click --trusted` 在 pointerdown 前有移动路径，终点与目标中心差 ≤ 1 px，全部可信，落在目标上那一段（折叠路径上的重复 move 对之后）与 Playwright 导出同构；`type --trusted` 的逐键序列与 Playwright `type()` 导出逐字段相同；`type`（默认）/ `--insert` 与 Playwright `fill()` 导出相同并标残缺；隐藏标签上 `--trusted` 不挂起：确认已绘制就走完整路径，确认不了就降到 DOM 点击并标 `degraded:"not-painted"`，绝不发 `mouseMoved`。
- expected（全部从 oracle 导出派生，不手写；D7：不要求与 Playwright 严格同形，节奏字段只列不比）：
  - click 结构：`clickSegment`（最后一个落在 `#target` 上的 `pointerover` 到 `click`）折叠后等于 Playwright `click` 导出的类型序列 `pointerover > mouseover > pointermove > mousemove > pointerdown > mousedown > pointerup > mouseup > click`；`pointerdown` / `pointerup` / `click` 的 `button` / `buttons` / `pressure` / `pointerType` / `isPrimary` / `width` / `height` / `detail` 等于导出值（pointerdown `pressure` 0.5、`buttons` 1）；到 click 为止全部 `isTrusted`。
  - 路径：pointerdown 前 pointermove ≥ 1 条，最后一条与 pointerdown 的 `clientX/Y` 差 ≤ 1 px，与页面量得的 `#target` 中心差 ≤ 1 px；点数、时长、按压间隔在 `docs/07` §1.1 的范围内（范围本身待 A7.9 真人 oracle 复核）。
  - `type --trusted "aB3 中"`：从第一个 `keydown` 起，除 `seq` / `timeStamp` / `dt` / `screenX` / `screenY` 外逐字段等于 Playwright `type` 导出；`'中'` 只有 beforeinput / textInput / input。
  - `type --insert` 与默认 `type`：同上逐字段等于 Playwright `fill` 导出；输出 `eventShape:"insert"`、警告含「incomplete event sequence」。
  - 默认 `click`：只有 1 个 `click`，`isTrusted:false`、`detail:0`、坐标 0,0（同 `js_click` 导出）；输出 `level:1`、`eventShape:"incomplete"`。
