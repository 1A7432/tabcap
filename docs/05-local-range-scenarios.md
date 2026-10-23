# 本地靶场场景清单（作者 2026-10-21 签收；之后的改动按 AGENTS.md 先提案）

2026-10-15。对应 `03` §10 第 5 条。靶场是**唯一**的端到端测试对象：所有验收、演示、合规说明都对着它跑，不碰第三方站点。每个场景演示一种通用模式，页面不模仿任何真实站点的品牌或界面。

标注：**P1** 阶段 1 必须过；**P1\*** 阶段 1 实现但允许「待验」（依赖 `chrome.debugger` 的能力，先量再说）；**P2** 阶段 2 才验收，场景现在定下来，服务端可以先写。

## 1. 靶场本身

- **现状**：靶场是 `test/e2e/site.ts`，一组 `startXxxSite()` 函数，各自用 `Bun.serve` 在 `127.0.0.1` 的随机端口起一个站点；跨源场景再起一个服务，用 `http://localhost:<端口>` 当 B 源（与 `127.0.0.1` 不同站点）。由各 e2e 文件（`test/e2e/*.e2e.test.ts`）在进程内启动、用完即停，`bun run test:e2e` 一条命令跑全部；默认的 `bun test` 不碰它。
- **oracle**：每个站点记下自己发出的正文（`served`：路径 → 正文字节的 sha256）和收到的请求（`hits`，或站点自己的日志字段），测试拿证据包与它比对；期望值写成 `site.ts` 里的字面量（如 `S22_*`）和本文各场景的 expected，由写场景的人写，不由 AI 为了让测试通过去改。
- 场景编号 → `site.ts` 的站点与路由 → e2e 文件的对照见 §20 场景索引。
- 原计划（10-15）的 `range/` 目录与 `tabcap range serve`（固定端口 `127.0.0.1:4310` / `localhost:4311`）、种子生成的数据、`/__range/journal` 日志与 `reset`、每场景一个目录加 `expected.json`、`x-range-*` 响应头、`tabcap range selftest`（L1）都没有实现，不排期（`06` §1）。

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
- 0.6-E（10-16 作者定）：`q`、`page` 是调用方自己选的（导航 URL 里来），`deps` 记为 `caller-input`（页面加载的文档请求上；搜索请求从它带过来，类为 `request`）；`analyze chain` 把它们列在 `inputs`，`todo` 里只剩 `sig`、`nonce` 这类。
- 0.6-G 加的列表接口（`analyze shape` / `schema-diff`，`04` §32）：`GET /api/list` 回 `{code, total, items:[{id, title, price:"12.50", status, created}]}`（4 条，`status` 三条 `active`、一条 `sold`）；变体 `GET /api/list?v=2` 把 `title` 改名 `name`、`price` 改成 JSON 数字、每条加 `currency`，其余不变。走法：两个会话各录一次「打开 `/s06`（页面自己的 `/api/search`）→ `tabcap fetch /api/list`」，第二次换成 `?v=2`，再离线比较。expected（`test/e2e/site.ts` 的 `LIST_DRIFT`）：`GET /api/list` 为 `drift`，added `$.items[].name:string`、`$.items[].currency:string`、`query:v:string(int)`（变体靠 query 选），removed `$.items[].title:string`，changed `$.items[].price` `string(float)` → `number(float)`；`GET /api/search` 为 `same`；退出码 1；输出里没有任何正文值。

### s07 token-chain（P1 录制；P2 deps）

- 登录表单（假账号 `demo/demo`）→ `POST /api/login` 返回 `set-cookie: sid=…` 和正文 `{csrf:"…"}` → 页面随后 `POST /api/data`，带头 `x-csrf` 和 cookie。`?expire=1` 让服务端在第 3 次请求后判 session 过期返回 401。
- 走法：AI 经 CLI `session start --site range-demo`，用 `fill --secret range-demo.password` 登录（凭据在本地库，模型不见明文），再取数据。同一会话再次对登录表单 `fill --secret` 必须被拦下并要求 `--confirm`（最小 guard）。
- 证明：ExtraInfo 的 cookie / set-cookie 都录到；`state` cookies 快照在 nav 边界更新；凭据不泄漏；P2：`deps` 画出 `csrf` 链；`handoff` 处理 401。
- expected：`r(login).response.headers["set-cookie"]` 非空；`r(data).request.headers.cookie` 含 `sid`；`state` 事件 ≥ 2 条且最后一条含 `sid`；`action.value` 为 `<secret:range-demo.password>`；填完密码后 `evaluate` 读密码框 `value` 和 `snapshot` 的输出里只有 `<secret:range-demo.password>`；守护进程日志与 CLI 输出 grep 不到密码明文（登录 POST 正文里的明文是事实，允许存在，导出脱敏后必须消失）；第二次登录尝试返回 `guard.login-limit` 错误且 journal 无新增；manifest 的 `session.site` 为 `range-demo`。
- 0.6-E 实时输出打码（token 变体 `/s07/login?token=1`，`test/e2e/v06e.e2e.test.ts`）：`net show <data>` 的 `x-csrf` 是 `<redacted:x-csrf>`（10-21 起敏感头判定合一，`docs/04` §8；之前等于靶场发的 csrf），`authorization` 是 `<redacted:authorization>`，`cookie` 是 `sid=<redacted:sid>`；`net show <login>` 的 URL 是 `…/api/login?token=<redacted:token>`，`set-cookie` 是 `sid=<redacted:sid>; Path=/; HttpOnly; SameSite=Lax`，postData 是 `user=demo-user&password=<secret:range-demo.password>`；`net list`、`net body`、`recon`（答案与 `dossier.json`）里登录页 URL 的 `token=<redacted:token>`；加 `--reveal` 回到 `Bearer <token>`、`sid=<sid>`、靶场发的 csrf、`token=1`（密码仍是 `<secret:…>`）；证据包里是原值。

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

### s22 frames（P1；0.4-I，帧路径 ref，作者定 10-16）
- 页面（`test/e2e/site.ts` 的 `startFrameSite`，两个源：A `127.0.0.1`、B `localhost`，不同站点所以 B 的 iframe 都是 OOPIF）：`/s22` 是 `frameset`，两个同源 `frame`：`menu`（三个链接「栏目一 / 栏目二 / 栏目三」，`target=main`）与 `main`；`main` 里先是 B 源 iframe（`/s22/form`：`input#q`「关键词」、`button#go`「查询」，点击后 `fetch('/s22/search?q=…')` 并把回答写进页面；表单下面再嵌一个与它同源（B）的 iframe `/s22/table`，`<table>` 两行 `S22-0001 甲方案` / `S22-0002 乙方案`），再是一个 layer.js 式的 iframe 弹层（`main` 里固定定位的 div，标题「消息提示」，里面是 B 源 iframe `/s22/modal`，关闭按钮 `aria-label=关闭`、文字 `×` 在 iframe 里，点击后 `postMessage` 让 `main` 移除弹层）。所有期望文字都是 `site.ts` 的字面量（`S22_*`）。
- ref 语法：根文档 `e<m>`；帧里的元素 `f<n>/e<m>`，嵌套 `f<n>/f<k>/e<m>`。`n` 是该帧在父文档的子帧里按文档顺序的序号（从 1 起；同源 iframe、OOPIF、`frameset` 的 `frame` 一起数），在快照那一刻定；帧路径到 CDP frameId / 会话的映射随快照一代保存，ref 随快照一起失效（docs/08 §5）。同源 / 跨源相对父帧。
- 走法：`net start` → `navigate /s22` → `snapshot`（只有帧头）→ `snapshot --frames` → `fill f2/f1/e<q> "abc"` → `click f2/f1/e<go>` → `snapshot --frame f2/f1/f1` → `where f2/f1/f1/e<格>` → 用遮挡头给的 ref 关掉 iframe 弹层。
- expected：帧头列出 `f1`（menu，same-origin，depth 1）、`f2`（main，same-origin，depth 1）、`f2/f1`（cross-origin，depth 2）、`f2/f1/f1`（same-origin，depth 3），另有弹层的 `f2/f2`（cross-origin，depth 2）；默认 `snapshot` 不出任何帧里的元素行；`--frames` 在 `f2/f1/…` 下列出表单元素、在 `f2/f1/f1/…` 下列出表格格子（文字取自 site.ts）；`fill` + `click` 产生一条从跨源帧发出的录制请求 `GET /s22/search?q=abc`（B 服务端日志有这条；`cdp.sessionId` 是子会话），这次动作的帧路径为 `f2/f1`（见 docs/04 §23）；`where` 对格子找到帧文档 `/s22/table` 的响应；弹层的关闭 ref 形如 `f2/f2/e<n>`，`click` 它之后弹层消失（下一次 `snapshot` 头为 `overlays  none`）。

- 0.6-D：`find <文字>` 也搜帧。`find S22-0002` 的第一个命中带 `frame:"f2/f1/f1"` 与 `f2/f1/f1/e<n>` 的 ref，`find 栏目二` 的命中 `frame:"f1"`、`clickable` 为 `f1/e<n>`，点它后 A 服务端日志有 `GET /s22/main?p=2`；输出 `frames` 为 5。

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

### s42 decode-plugins（P1，0.6-B：解码插件）
- 页面 `/s42`（`test/e2e/site.ts` 的 `startDecodeSite`，明文全部手写为 `S42_*`）：`/s42/api/*` 的响应正文是「UTF-8 JSON 逐字节 XOR 密钥 `S42_KEY` 再 base64」，`content-type: text/plain`，带 `x-enc: xor`。页面先 `GET /s42/api/token`（`{"token":"S42-TOKEN-5e1f9a3c7b2d4e60","ttl":600}`），再带 `x-auth: <token>` `GET /s42/api/items`（两行商品，`name` 为 `甲号商品` / `乙号商品`），在页面里解码后渲染表格；按钮 order 发 `POST /s42/api/order`，正文同样编码（明文 `{"token":…,"item":"S42-ITEM-0001","qty":2}`，带 `x-enc: xor`、`x-auth`），回答 `{"ok":true,"order":"S42-ORDER-0077"}`，页面显示 `ordered S42-ORDER-0077`。站点日志记下解出的 POST 明文。
- 插件：`test/e2e/plugins/xor-decode/`（Bun 脚本，密钥在它自己的 `config.json`；`match` 为 host `127.0.0.1`、path `/s42/api/*`、`text/plain`、两个方向；只解带 `x-enc: xor` 的一侧）。
- 走法：装插件到测试 `TABCAP_HOME` → `plugin enable` → `net start` → 导航 `/s42` → `where <甲号商品 格子>` → 点 order → `net stop` → `analyze find <token>` → `analyze deps` → `net body`（默认 / `--raw`）→ 停用插件再录一遍 → `bundle decode --plugin xor-decode`。
- expected：token / items / order 的响应与 order 的请求体各带 `decoded`（`by:"xor-decode"`、`version:"1"`、`mime:"application/json"`、`ok:true`，blob 内容等于手写明文），文档没有；`where` 候选 `{request:r(items), path:"$.items[0].name", chain:["plugin:xor-decode"], match:"exact", score:1}`；`find <token>` 命中 r(token) 的 `$.token` 与 r(order) 请求体的 `$.token`，链都是 `["plugin:xor-decode"]`；`deps` 里 r(order) 的 body `$.token` 与 header `x-auth` 主来源都是 `{kind:"response", request:r(token), path:"$.token", decode:["plugin:xor-decode"], match:"exact"}`（不再是更早请求的同名头），body `$.item` 来自 r(items) 的 `$.items[0].id`；`net body r(items)` 默认 `view:"decoded"` 给明文，`--raw` 给密文；停用后录的包没有视图、`find <token>` 0 命中，`bundle decode` 之后 2 个视图（token、items），id 与 seq 不变，`find` 命中 r(token)。

## 6. 输入保真（作者定 10-15；提案 `docs/10`，0.3-E 落地）

### s46 input-fidelity（P1；`--trusted` 的拟真点击与逐键输入）
- 页面：`fixtures/probe/input-probe.html`，由作者的本地探针 `/tmp/tabcap-probe/probe.html` 升格；e2e 站点（`test/e2e/site.ts` 的 `startProbeSite`）在 `/probe` 原样提供，页面把自己的事件报告 POST 到同源 `/report`（不再写死端口）。捕获阶段在 `window` 上记录 pointer / mouse / keyboard / beforeinput / textInput / input / composition / focus 的全部字段，键盘事件补 `keyCode` / `charCode` / `which` / `repeat` / `location` 与 `shiftKey` / `ctrlKey` / `altKey` / `metaKey`；一个 `#target`（260×90，含边框 262×92）和一个 `#field`。原探针的指纹与 CDP 探针两段不在场景范围内，删去。页面只记录，不改变点击或按键的行为。0.7.3 追加：`/link` 是带站内链接 `#next → /second` 与普通按钮 `#plain` 的小页面，`/second` 是链接落点。
- oracle：`fixtures/probe/oracle/playwright-<Playwright 版本>-cft-<Chrome 版本>-<模式>.json`，由 `scripts/probe-oracle.mjs` 在本机对该页生成（无头、Chrome for Testing 固定版本；Playwright 不是本仓库依赖，用 `--playwright` 指向本地已有安装；不进任何测试运行），人工检查后提交。模式：`click`（`page.click`）、`js_click`（`evaluate(el.click())`）、`type`（`page.type("#field", "aB3 中")`）、`fill`。【实测 10-15，Playwright 1.64.1、CfT 155.0.8059.79】`type` 打 `'B'` 时没有 Shift 按键，键盘事件 `shiftKey:false`、`keyCode:66`（提案里的【待验】由此定）。真人手点、手打的节奏 oracle（A7.9，L3）待作者补。
- oracle：`fixtures/probe/oracle/playwright-<Playwright 版本>-cft-<Chrome 版本>-<模式>.json`，由 `scripts/probe-oracle.mjs` 在本机对该页生成（无头、Chrome for Testing 固定版本；Playwright 不是本仓库依赖，用 `--playwright` 指向本地已有安装；不进任何测试运行），人工检查后提交。模式：`click`（`page.click`）、`js_click`（`evaluate(el.click())`）、`type`（`page.type("#field", "aB3 中")`）、`fill`。【实测 10-15，Playwright 1.64.1、CfT 155.0.8059.79】`type` 打 `'B'` 时没有 Shift 按键，键盘事件 `shiftKey:false`、`keyCode:66`（提案里的【待验】由此定）。真人手点、手打的节奏 oracle（A7.9，L3）待作者补。
- 证明（按作者 10-15 的决定修订）：默认 `click` 仍是 DOM 点击，只有 1 个不可信 `click`，输出标 `eventShape:"incomplete"` 与「incomplete event sequence」；`click --trusted` 在 pointerdown 前有移动路径，终点与目标中心差 ≤ 1 px，全部可信，落在目标上那一段（折叠路径上的重复 move 对之后）与 Playwright 导出同构；`type --trusted` 的逐键序列与 Playwright `type()` 导出逐字段相同；`type`（默认）/ `--insert` 与 Playwright `fill()` 导出相同并标残缺；隐藏标签上 `--trusted` 不挂起：确认已绘制就走完整路径，确认不了就降到 DOM 点击并标 `degraded:"not-painted"`，绝不发 `mouseMoved`。
- expected（全部从 oracle 导出派生，不手写；D7：不要求与 Playwright 严格同形，节奏字段只列不比）：
  - click 结构：`clickSegment`（最后一个落在 `#target` 上的 `pointerover` 到 `click`）折叠后等于 Playwright `click` 导出的类型序列 `pointerover > mouseover > pointermove > mousemove > pointerdown > mousedown > pointerup > mouseup > click`；`pointerdown` / `pointerup` / `click` 的 `button` / `buttons` / `pressure` / `pointerType` / `isPrimary` / `width` / `height` / `detail` 等于导出值（pointerdown `pressure` 0.5、`buttons` 1）；到 click 为止全部 `isTrusted`。
  - 路径：pointerdown 前 pointermove ≥ 1 条，最后一条与 pointerdown 的 `clientX/Y` 差 ≤ 1 px，与页面量得的 `#target` 中心差 ≤ 1 px；点数、时长、按压间隔在 `docs/07` §1.1 的范围内（范围本身待 A7.9 真人 oracle 复核）。
  - `type --trusted "aB3 中"`：从第一个 `keydown` 起，除 `seq` / `timeStamp` / `dt` / `screenX` / `screenY` 外逐字段等于 Playwright `type` 导出；`'中'` 只有 beforeinput / textInput / input。
  - `type --insert` 与默认 `type`：同上逐字段等于 Playwright `fill` 导出；输出 `eventShape:"insert"`、警告含「incomplete event sequence」。
  - 默认 `click`：只有 1 个 `click`，`isTrusted:false`、`detail:0`、坐标 0,0（同 `js_click` 导出）；输出 `level:1`、`eventShape:"incomplete"`。
  - `click --trusted /link 的 #next`（0.7.3）：成功（不再报 `cdp` / `not-delivered`），`eventShape:"full"`、`delivered` 二选一（导航在探针回读前提交 → `{pointerdown:"unknown",mousedown:"unknown",reason:"navigated"}`；回读先到 → `{pointerdown:true,mousedown:true}`；【实测 CI ubuntu 8b388c5】两种都出现过）、`effect:"navigation"`，`url` 为 `/second`；`--no-wait` 同样成功、`delivered.reason:"navigated"`、不报 `effect`，`url` 仍是 `/second`；`--trusted --dbl-click` 点 `#plain` 不受影响：`delivered` 里的两个值都是 `true`、`url` 仍是 `/link`。

## 7. 0.6-D 真实项目试用后补的场景（10-16，均 P1；s23–s29 已被 docs/09 的规划占用，从 s47 编起）

### s47 hidden-controls（P1；0.6-D，DOM 支撑的 ref）
- 页面 `/s47`（`test/e2e/site.ts` 的 `startDaemonFixSite`）：`aria-hidden=true` 的容器里有 `input#s47-user.el-input__inner`、`input#s47-pass.el-input__inner`（password）、无名字的 `button#s47-go.el-button`、`input#s47-file.el-upload__input`（file）、`div#s47-hover.s47-hover`（120×30）；容器外的 `p#s47-out` 由页面写下按钮收到的值，`window.__s23` 记下 hover（`isTrusted`）与上传的文件名。
- 走法：`snapshot --css '#s47-user, #s47-pass, #s47-go, #s47-file, #s47-hover'` → `fill` 两个输入框、`type -- -t`（以 `-` 开头的文字放在 `--` 之后：作者 2026-10-22 定的单横线规则，`04` §2.1）、`click` 按钮 → `html --attrs` → `screenshot --ref` → `hover` → `upload` → `reload` 后旧 ref。
- expected：五个都是 `(no accessible node) <…> [e<n>]`，`search.noAccessible` 与 `domRefs` 都是 5，完整快照里没有这些 ref；`#s47-out` 为 `user=s47-user-7f-t;pass=15`（`S47_*` 字面量）；截图宽高 = 120×30 × 页面自己的 `devicePixelRatio`；`__s23.hover` 为 true，`__s23.file` 为上传文件名；`reload` 后旧 ref 是 `stale-ref`。

### s48 click-effects（P1；0.6-D，点击效果）
- 页面 `/s48`：子菜单标题 `#s48-sub` 与表格格子 `#s48-cell` 的 click 处理只认 `isTrusted`；`#s48-count` 改计数（DOM 变动）；`#s48-link` 到 `/s48/next`（导航）；`#s48-ping` 只发 `fetch('/s48/ping')`（请求，不改 DOM）。
- expected（不录制）：DOM `click` 子菜单与格子都是 `effect:"none"`、`note` 提 `--trusted`、退出码 0，子菜单仍 `display:none`、格子文字不变；计数 `dom`、ping `request`（服务端日志多一条 `GET /s48/ping`）、链接 `navigation`；`click --trusted` 子菜单后它展开（`display:block`），输出没有 `effect`；`--no-wait` 不报 `effect`。

### s49 post-redirect（P1；0.6-D，重定向链上的请求体）
- 页面 `/s49`：表单 `POST /s49/submit`（`user` / `note` 两个字段，`note` 含中文与 `&` `=`）→ 302 → `GET /s49/done`；按钮 `fetch POST /s49/api`（JSON）→ 302 → `GET /s49/api/done`（JSON `{done:"s49-api-done"}`）。服务端 `posts` 记下收到的原样请求体（oracle）。
- expected：包里两条 POST 的 `response.status` 是 302、`request.postData` 等于 `{inline: <服务端收到的正文>}`；跳到的 GET 的 `redirect.from` 指向那条 POST。

### s50 image-captcha（P1；0.6-D，图片验证码提示）
- 页面 `/s50`：登录表单（用户名、密码、`input#s50-code name=verifyCode`、`img#s50-img.captcha-img alt=验证码`，100×40、登录按钮）；`/s50/plain` 是去掉验证码的同一表单。
- expected：`snapshot` 与 `outline` 头有 `challenge  image-captcha img [e<i>] → input [e<j>]; read the image (screenshot --ref e<i>) or hand over …`，`e<i>` 是 `#s50-img`、`e<j>` 是 `#s50-code`（`html --attrs` 对得上），`screenshot --ref e<i>` 可用；对该表单的 `fill`（用户名、验证码）与 `click`（登录）输出带 `challenge: {kind:"image-captcha", image:e<i>, input:e<j>}`；`handoff status` 不是 `waiting`；`/s50/plain` 头里没有 `challenge` 行、`fill` 不带 `challenge`；录制里 `/s50` 只有一条 `guard` `{event:"challenge"}`，`detail` 为 `{kind:"image-captcha", advisory:true, image, input, url}`。

### s51 account-contexts（P1；0.6-D，一账号一浏览器上下文；用 0.4-D 的 `startPoolSite`）
- 站点 `example`（入口 `/pool/me`）有 alice、bob 两个账号，都不绑代理。`/pool/set?v=` 种 cookie `pool_sid`，`/pool/me` 回显收到的 Cookie 头；服务端 `hits` 记每个请求的 Cookie 头（oracle）。
- expected：`session start d6a --account alice` 回 `browserContext:"own"`、`cookiesRestored:0`，没有 `fetchAuth`；alice 种的 cookie 只出现在 alice 的请求里，bob 的会话（`own`）与不带账号的会话（无 `browserContext`）请求 `/pool/me` 时 Cookie 头为空；`session stop d6a` 回 `browserContext:"disposed"` 并存下 cookie，新会话 `--account alice` 的 `cookiesRestored ≥ 1`，请求带回 `pool_sid=alice-d6-0001`；`--account auto` 也是 `own`。

### s52 frame-dates（P1；0.6-D，`where` 读帧里的页面文字）
- 页面 `/s52`：根文档 `p#s52-date` 写 `03/04/2026`（日月顺序不定），iframe `/s52/frame` 写 `截止 25/04/2026`（日 > 12，只能是 DD/MM）。
- expected：录制中 `where <#s52-date 的 ref>` 没有 `ambiguous`，`normalized` 含 `2026-04-03`、不含 `2026-03-04`。

## 8. 0.6-J 点击落点（10-16，P1）

### s56 click-landing（P1；0.6-J，点击落到真正监听的元素上）
- 页面 `/s56`（`test/e2e/site.ts` 的 `startClickTargetSite`），三个控件照作者真实项目里的三种库写法：`#s56-lay`（layui：`role=button`、300 px 宽，自己没有监听器；处理程序按属性挂在内层 `span#s56-lay-span[lay-event]` 上，60 px，靠左）；`#s56-menu`（antd / Element UI：`role=menuitem`，处理程序委托在往上第四层的 `#s56-app`，只在事件目标落在 `cursor:pointer` 的子元素 `span#s56-menu-title.s56-title`（80 px，靠左）里时反应）；`#s56-trust`（`role=button`，处理程序在自己身上、只认 `isTrusted`）。每次处理程序真正跑了，页面往 `window.__s56` 记一条 `<控件>:<isTrusted>`。
- expected：`snapshot --interactive` 里 `#s56-lay`、`#s56-menu` 两行带 `landing="child"`，`#s56-trust` 不带；默认快照里没有 `landing=`。DOM `click` `#s56-lay` → `effect:"dom"`、`target` 为 `{ref, landedOn:{tag:"span", text:"编辑", selector:"#s56-lay-span"}, reason:"descendant-listener"}`，`__s56` 为 `["lay:false"]`；`#s56-menu` 同理（`text:"菜单项"`、`selector:"#s56-menu-title"`），`__s56` 加一条 `menu:false`。DOM `click` `#s56-trust` → 退出码 0、`effect:"none"`、`note` 提 `--trusted`，没有 `target` / `candidates`，`__s56` 为空；`click --trusted` 之后为 `["trust:true"]`。`click --trusted` `#s56-lay` → 输出带同样的 `target`，`__s56` 为 `["lay:true"]`，`at` 落在页面自己量的 `#s56-lay-span` 的 `getBoundingClientRect` 里（按钮中心在 150 px 处，span 在 0–60 px）。

## 9. 0.6-E 分析与输出脱敏（10-16 作者定；s53 编号由主循环定）

### s53 token-bearer（P1；0.6-E，`analyze deps` 认出带 `Bearer ` 前缀的头）
- 页面 `/s53/`（`test/e2e/site.ts` 的 `startTokenSite`）：加载时 `POST /api/s53/token`（表单 `client=web`），服务端回 `{access_token, token_type:"Bearer", expires_in:3600}`（`access_token` 是新的无横线 UUID，记进 `tokens`）；页面再 `GET /api/s53/me`，头 `Authorization: Bearer <access_token>`，服务端只对自己发过的 token 回 200 `{name:"demo-user"}`，每次收到的 Authorization 记进 `meAuth`（oracle）。
- expected：录一次后 `tokens` 一个、`meAuth` 等于 `["Bearer " + 它]`；`analyze deps` 里 `/api/s53/me` 的 `header authorization` 类为 `response`，`primary` 是 `{kind:"response", request:<token 请求>, path:"$.access_token", decode:[], match:"exact", prefix:"Bearer "}`；`analyze chain` 两步（token → me）；`replay export-python` 生成的 `client.py` 发 `"Bearer " + authorization`，用它对靶场本身先调 token 再调 me 回 200，靶场第二次收到的 Authorization 是 `"Bearer " + 第二个 token`。

## 10. 0.6-I 按资源类型取正文与站点停手规则（10-16，均 P1）

### s54 big-script（P1；0.6-I，`--bodies api` 与 `all` 的包大小差）
- 页面 `/s54`（`test/e2e/site.ts` 的 `startBodiesSite`）：一个 1.5 MiB 的脚本 `/s54/big.js`、样式表 `/s54/site.css`、1×1 图片 `/s54/logo.png`，页面脚本 `fetch("/s54/api")` 后把 `rows` 写进 `#s54-out`（`s54-a,s54-b`）；`served` 记每个正文发出的字节数（oracle）。
- 走法：同一会话先 `net start --bodies all` 录一遍、`net stop`，再 `net start --bodies api` 录一遍。
- expected：两个 manifest 的 `record.bodies` 分别是 `all` / `api`；`counts.blobBytes` 之差等于 `served` 里脚本 + 样式表 + 图片的字节数之和；`api` 包里这三条 `request` 的 `response.status` 为 200、`body` 为 `{skipped:"resource-type"}`、`bodyMissing` 为 null，文档与 `/s54/api` 有 blob；`net body <脚本 id>` 回 `not-found`（`bodies:"api"`、`next` 提 `--bodies api+script`）；`net list` 里带 `bodySkipped` 的恰是 image / script / stylesheet。

### s55 site-stop（P1；0.6-I，站点规则在第三个连续非 200 上命中）
- 页面 `/s55`：按钮「加载」每点一次 `fetch("/s55/api")` 并读正文，把 `n<序号>=<状态>` 写进 `#s55-out`；`/s55/api` 按到达顺序回 200、500、500、500，之后 200；`api` 记每次回了什么（oracle）。配置 `sites.example.guard.consecutiveNon200: 3`，站点 `example` 入口 `/s55`。
- 走法：录制中点两次（200、500），`tabcap fetch /s55/api`（500），再点一次（500，连续第三个非 2xx）→ `handoff status` → 再点、再 `fetch` → `handoff continue` → `fetch`。
- expected：`handoff status` 为 `waiting`、`reason:"stop-rule"`、`rule:"consecutiveNon200:3"`、`request` 是第四条 `/s55/api`、截图文件存在；之后的 `click` 与 `fetch` 都是 `guard.stopped`，靶场没有收到第五条；`handoff continue` 回 `fetchResumed:["example"]`，下一条 `fetch` 拿到 200；包里 `guard` 事件依次是 `breaker` 与 `resume`（都是 `stop-rule`、同一 `request`），`handoff` 依次是 `waiting` 与 `resumed`。

## 11. 0.6-L 页面内解码·观察模式（10-16，P1）

### s59 in-page-decode（P1；0.6-L / 0.6-L2 / 0.6-Q / 0.6-W，`trace start --decode` 观察 `JSON.parse`）
- 页面 `/s59`（`test/e2e/site.ts` 的 `startInPageDecodeSite`）：`/api/enc` 应 `{"code":0,"data":"<base64>"}`——12 行 JSON（`S59_PLAIN`）默认按 `S59_XOR_KEY` 逐字节 XOR，`?mode=webcrypto` 时 AES-128-GCM（`data` = base64(iv‖密文‖tag)）；`?mode=worker` 把 XOR 放进 dedicated worker、主线程 `JSON.parse(e.data)`；`?mode=axios` 在 `transformResponse` 里先 parse 信封再 parse 明文；`?mode=inline` 是 `JSON.parse(decrypt(env.data))` 临时值；`?mode=bare` 的 `/api/enc?mode=bare` 整段 body 是一条 base64（无信封）；`?mode=big` 明文约 1.2 MiB（`S59_BIG_MARKER`，不渲染 pad）；`?mode=deferred` 解密后把明文放进脚本级数组，由一个只有自己一帧的定时器回调 `s59ParseLater` 再 `JSON.parse`——解析帧里够不到任何密文或原文（weak 的 oracle，0.6-L2 第二轮）。页面 fetch、自己解密、`JSON.parse` 明文、渲染表格（big 不渲染），再 fetch `/api/plain`（明文 JSON，同样过 `JSON.parse`）当对照组。`?mode=webcrypto&two=1` 并发 `slot=1` / `slot=2` 两个加密响应（密钥同、IV 不同：`slot=2` 是 `S59_PLAIN2`），各自解密各自 `JSON.parse`，渲染 24 行。任何 raw `/api/enc` 正文中都没有明文值。
- expected：xor、webcrypto、two=1、axios、inline、worker、bare、deferred 都落 `by:"page"` 的 sidecar 行——`version "observe/0"`、request 归到各自的 r-N、blob 打开是 `S59_PLAIN`（slot=2 `S59_PLAIN2`）。`evidence.link` 与 `match` 读页面源码定：xor / axios / inline / worker 的解析帧够得着信封的 `data` 叶子（xor 的 `s59Xor(data)`；axios 的 `s59Axios` 里有 `env` 和原文 `text`；inline 的 `s59Enc` 块里有 `env`，往下一层是 `data`；worker 的 `onmessage` 箭头函数闭包里有 `s59Worker` 的 `data`）→ `link:"strong"`、`match` = sha256(`data`)；webcrypto / two 同理是各自的 `data`；bare 是 sha256(裸 token)；deferred 够不着 → `link:"weak"`、`match:null`、settle 500 ms 后写入，`trace stop` 的 `rows.weak` = 1，`find S59-0001` 的 hit 带 `"link":"weak"`。`/api/plain` 与信封那次 parse 不落行。webcrypto 的 `evidenceHits` ≥ 2。`find <S59-0001>` 一条 hit，`decode` 链是 `["page"]`。big：blob 打开是 `s59BigPlain()`（> 1 MiB），`find S59-BIG-0001` 命中 `page`。不开 `--decode` 零 sidecar。`--decode` 时 `trace start` 的 `requested` 为 0、`active` 为空，`trace status` 的 `instrumentation` 为空、各 target `breakpoints` 为 0；`--decode --apis <file>` 报 `usage`。先打开页面、再 `trace start --decode`、再 `net start`，由页面自己的定时器重跑 `s59Main("xor")`：照样落一行 strong。Worker 回对象（结构化克隆、主线程不再 parse）没有对应 e2e，仍【待验】。
- 0.6-Q 变体（`site.ts` 字面量；作者 10-17 brief F，起因是隔壁项目真实站点 A 的召回 11%，见 docs/04 §33 0.6-Q）：`?mode=mime` 的 `/api/enc?mode=mime` 应 `S59_ENC_MIME`——`data` 是 `S59_PLAIN` 的 XOR base64 按 MIME 方式每 76 字符插一个 `\r\n`，页面 `env.data.replace(/\s+/g, "")` 去空白后再 XOR 解密、`JSON.parse`；`?mode=noise` 先把 `S59_NOISE_LOCAL`（≥1 KB 的用户信息 JSON）写进本源 localStorage，并发取 `mode=noise&slot=1` / `slot=2`（`S59_ENC_NOISE1/2`，明文 `S59_NOISE_PLAIN1/2` 各约 70 字节），两个响应都到手后等 400 ms，在一个够不到任何密文的函数 `s59NoiseUser` 里 `JSON.parse(localStorage.getItem(…))`，再逐个解密；`?mode=race` 并发取 `mode=race&slot=1/2/3`（`S59_ENC_RACE1/2` 是 40 行的 `S59_RACE_PLAIN1/2`，slot 3 是 `S59_ENC_XOR`），每个信封在 fetch 链里文本一到就 `JSON.parse`（可能早于 tabcap 索引该响应），全部到齐后再逐个解密。
- expected（0.6-Q）：mime 一条 strong 行，request 是那条 `/api/enc?mode=mime`，blob 是 `S59_PLAIN`，`evidence.match` = sha256(去空白后的 `data`，即 `S59_ENC_XOR` 的 `data`)、`evidence.matchForm` = `"stripped"`；同一请求的 `net body` 默认与 `--decoded` 在录制中和 `net stop` 后都答 `view:"decoded"`、`decoded.by:"page"`、`decoded.link:"strong"`、预览是 `S59_PLAIN`，`--raw` 是 `S59_ENC_MIME`；`/api/plain` 的 `net body --decoded` 报 `not-found`，`next` 不提 `--decode`（不加 `--decode` 录的 `/api/enc` 则提）。noise 恰两行、各自 strong 归到 slot 1 / slot 2、blob 是 `S59_NOISE_PLAIN1/2`；没有一行是 `S59_NOISE_LOCAL`；`rows` = attributed 2、weak 0、unattributed 0；`drops.noFit` ≥ 1（`S59_NOISE_LOCAL` 的 UTF-8 字节数大于两个嫌疑的上限 floor(len(data) × 3 / 4)）——0.6-W 起改为 `drops.orphan` ≥ 1、`drops.noFit` = 0：那次 parse 先等 grace，期间两个嫌疑都被各自的 strong 行认领，`trace stop` 强制判定时已没有在场嫌疑（作者 10-17 定的计数规则，见 docs/04 §33 0.6-W）。race 恰三条 strong 行、各自归到 slot 1/2/3、blob 是 `S59_RACE_PLAIN1/2` 与 `S59_PLAIN`；没有任何一行（含 `request:null`）的 blob 等于三个信封之一；`rows` = attributed 3、weak 0、unattributed 0。
- 0.6-W 变体（`site.ts` 字面量；作者 10-17 定 A，起因是隔壁项目的 XHR 复刻页 0/40 strong，见 docs/04 §33 0.6-W）：`?mode=xhr` 用 `XMLHttpRequest` 取 `/api/enc?mode=xhr`（正文 `S59_ENC_XOR`），在 `onload` 里先 `JSON.parse(x.responseText)` 信封、再 `s59Xor(env.data)`（`JSON.parse` 明文，帧里有 `data`）——`onload` 早于 tabcap 索引这条响应；`&linger=N`（N ≤ 3）先逐个 `fetch` `/api/enc?mode=linger&slot=1..N`（`S59_ENC_LINGER[0..2]`，明文 `S59_LINGER_PLAINS` 各 20 行，都比 `S59_PLAIN` 长，所以每个 linger 嫌疑都装得下 xhr 的明文、留在候选里）并读完 `text()`、从不 parse，等 300 ms（三个都已武装）再发那条 XHR。之后照常取 `/api/plain` 对照。
- expected（0.6-W，`--decode`）：xhr 与 xhr&linger=3 都恰好一条行：request 是 `/api/enc?mode=xhr` 那条、blob 是 `S59_PLAIN`、`evidence.link:"strong"`、`match` = sha256(`S59_ENC_XOR` 的 `data`)；linger 三条没有行；没有 `request:null` 行；`trace stop` 的 `rows` = attributed 1、weak 0、unattributed 0。xhr&linger=3 在同一用例里连跑三轮（三个会话）。这是 grace 竞态的回归测试：修前【实测 10-17】唯一一行是 `request:null`、`candidates` = 三个 linger 请求。

## 12. 0.6-P fetch 的 credentials 与 session export 的 origin（10-17，P1）

### s60 fetch-credentials（P1；0.6-P，`tabcap fetch --credentials`、`session export --origin`）
- 靶场（`test/e2e/site.ts` 的 `startCredSite`）：127.0.0.1 上两个端口，A 是页面源、B 是 API 源（不同源、同站，B 的 cookie 会随 A 页面的带凭据请求发出）。B 的端点：`/s60/api/wild` 回 `Access-Control-Allow-Origin: *`、不带 `Access-Control-Allow-Credentials`，正文 `S60_WILD`（`{"code":0,"endpoint":"wild","from":"s60-b"}`）；`/s60/api/double` 回 `ACAO: <A>` 加两次 `Access-Control-Allow-Credentials: true`（线上是 `true, true`），正文 `S60_DOUBLE`；`/s60/api/private` 回 `ACAO: <A>` + `ACAC: true`，带 cookie `s60b=S60_COOKIE`（`s60b-session-91f2`）时 200 `S60_PRIVATE`（`{"code":0,"endpoint":"private","user":"s60-user"}`），否则 401 `S60_NEED_COOKIE`（`{"code":401,"error":"no s60b cookie"}`）；`/s60/api/login` 设 `s60b` cookie（`HttpOnly; SameSite=Lax`，`ACAO: <A>` + `ACAC: true`）；`/s60/api/me` 回 `ACAO: *`（预检允许 `authorization`），正文 `S60_ME`（`{"code":0,"me":"s60-me-ok"}`）。页面 `A/s60` 先 `fetch(B/s60/api/login, {method:"POST", credentials:"include"})`，再 `fetch(B/s60/api/me, {headers:{Authorization:"Bearer " + S60_TOKEN}, credentials:"omit"})`（`S60_TOKEN` = `s60-bearer-4c1d9e7a`），把 `me` 写进 `#s60-out`。访问日志记每个请求的头（oracle：哪条带了 cookie）。
- 走法：`config.json` `fetch.minIntervalMs: 0`；`session start` → `net start` → 导航 `A/s60` → 等 `s60-me-ok`。然后依次：`fetch B/s60/api/wild`（默认 include）、`--credentials omit`；`fetch B/s60/api/double`；`fetch B/s60/api/private`、`--credentials omit`；`fetch --batch <3 行> --credentials omit`（wild 无字段、private 写 `include`、private 无字段）；`POST /fetch` 带 `credentials:"omit"` / `"include"` / `"none"`；标签仍在 A 上时 `session export --for requests --origin <B>`、`--origin <B 的 host:port>`、不给 `--origin`；最后 `net stop` 读包。
- expected：wild include → `fetch.blocked`，`credentials:"include"`，`reason` 含 "must not be the wildcard '*' when the request's credentials mode is 'include'"，`next` 含 `--credentials omit`、"no cookies are sent"、"Origin / Referer"；该请求照样到了 B 且带 `s60b`（CORS 拦的是读，不是发）。wild omit → 200、正文 `S60_WILD`，B 收到的这条没有 cookie。double include → `fetch.blocked`，`reason` 含 "'Access-Control-Allow-Credentials' header in the response is 'true, true' which must be 'true'"，`next` 含 `--credentials omit`。private include → 200 `S60_PRIVATE`（带 cookie），omit → 401 `S60_NEED_COOKIE`（不带）。batch 三行依次 200 `S60_WILD`、200 `S60_PRIVATE`、401 `S60_NEED_COOKIE`，两条 private 的 cookie 依次有、无。`POST /fetch`：omit 200 `S60_WILD`；include `fetch.blocked`，`next` 含 `"credentials": "omit"`；`"none"` → `usage`。包里：每个带 `fetchId` 的 `request` 事件 `fetchCredentials` 等于那次所用模式（页面自己的请求没有该字段）；`cmd` 开始事件的 `input.credentials` 按命令顺序为 include、omit、include、include、omit、omit、include、none，batch 那条 `input.batch` = `{requests:3, credentials:{omit:2, include:1}}`。`session export --origin <B>`：`origin` = B，`headers` = `["authorization"]`，`source.headers` = `{request:<页面发往 B/s60/api/me 的那条 GET 的 r-N>, origin:B, auto:false}`，`source.storage` = A；文件 `headers` = `{authorization:"Bearer s60-bearer-4c1d9e7a"}`，`cookies` 里有 `["s60b", S60_COOKIE]`；输出里不出现 token 与 cookie 值。裸 host 同结果。不给 `--origin`：`origin` = A，`source.headers` = `{origin:B, auto:true}`，`headers` = `["authorization"]`，`note` 含 `source.headers.auto`，文件 `headersFrom` 同。

## 13. 0.7.1-A 人接管识别（10-17，P1）

### s62 human-takeover（P1；0.7.1-A，隔离世界的被动输入监听器，`04` §37）
- 页面 `/s62`（`test/e2e/site.ts` 的 `startTakeoverSite`）：按钮 `#s62-btn`（文字 `S62_BTN`，点击把 `"btn:" + isTrusted` 追加进 `window.__s62`）、文本框 `#s62-in`（`keydown` 把 `"key:" + isTrusted` 追加进 `window.__s62`）、按钮 `#s62-ping`（文字 `S62_PING`，点击 `fetch("/s62/ping")` 并读正文，服务器记一次）、一个 300 行的长列表（页面能滚）。页面脚本加载后每 200 ms 在按钮上合成一轮不可信事件：`dispatchEvent` 的 `pointerdown`、`keydown`、`wheel`、`touchstart`（`new Event`）和 `el.click()`，轮数记在 `window.__s62synth`（后台标签里定时器约 1 Hz，所以实际轮数少于 5/s）。
- 走法与 expected（`test/e2e/v071a.e2e.test.ts`；守护进程以 `TABCAP_E2E_HUMAN=1` 启动）：
  1. **tabcap 自己的输入不触发**：`session start a` → `net start` → `navigate /s62` → 等 1.5 s（页面合成事件已跑过几轮）→ `click <S62_BTN> --trusted` → `click <文本框> --trusted` → `type --trusted ab` → `press-key Enter` → `hover <S62_BTN>` → 等 1 s。expected：`handoff status` 为 `running`、`handoff:null`；`window.__s62` 含 `"btn:true"` 与 `"key:true"`（tabcap 的输入确实以可信事件到了页面）；`window.__s62synth` ≥ 1；`status` 里会话 `a` 为 `running`。
  2. **命令窗口之外的一次可信输入触发**：经守护进程 socket `POST /command {action:"e2e.human-input", session:"a"}`（视口 (4, 4) 的按下 / 抬起）。expected：3 s 内 `handoff status` = `waiting`，`handoff.reason:"human-takeover"`、`handoff.input.event:"pointerdown"`、`screenshot:null`；`click <S62_BTN>` 回 `{ok:false, code:"waiting", reason:"human-takeover"}`；`snapshot` 照常并带 `handoff.reason:"human-takeover"`；`status --text` 含 `WAITING human-takeover`，`status` 的顶层 `next` 含 `tabcap handoff continue --session a`。隔 400 ms（页面侧同种事件 250 ms 内只报一次）再注入一次按在 `S62_PING` 上的按下 / 抬起（等人期间：只记录、不再触发），服务器收到一次 `/s62/ping`，等 `net list`（只读，等人期间照常）里出现它。`handoff continue` → `state:"resumed"`；`click <S62_PING> --trusted` 成功，服务器收到第二次 `/s62/ping`；`net stop`。包里：恰一条 `handoff {state:"waiting", reason:"human-takeover", input:{event:"pointerdown"}, request:null, screenshot:null}`（`actor:"system"`），之后一条 `handoff {state:"resumed", by:"human"}`；`action {op:"input", event:"pointerdown"}` 恰两条，都是 `actor:"human"`、`cmd:null`、`trusted:true`、`value:null`；第一次 `/s62/ping` 的 `request` 事件 `actor:"human"`，第二次 `actor:"ai"`；其他 `actor:"human"` 的事件只能出现在 waiting 与 resumed 两条 `handoff` 之间；`manifest.mode.humanRecorder:true`。
  3. **关掉开关不触发**：另一个 `TABCAP_HOME`，`config.json` `{"handoff":{"detectTakeover":false}}`，同样启动、`net start`、`navigate /s62`、注入一次。expected：等 1.5 s 后 `handoff status` 仍是 `running`；包的 `manifest.mode.humanRecorder:false`，没有 `handoff` 与 `action` 事件。
- 不在靶场里的【待验】：真人的 OS 输入（鼠标、键盘、触控板、拖滚动条、自动填充、输入法），见 `04` §37 末条。

## 14. 0.7.3-A 外部评测五条（10-18，P1 / P2 / P3）

### s63 overlay-wrapper（P1；无 role 的全屏 mask 包着对话框）
- 页面 `/ov/wrapped`（`test/e2e/site.ts` 的 `startOverlaySite`）：`#buy`（Buy now）在遮罩下面；`#mask` 是 `position:fixed;inset:0`、背景 `rgba(0,0,0,.4)` 的全屏层，里面 `#dialog` 是 340 px 宽、白底、有边框和阴影的块，含按钮 `#accept`（文字 Accept、class `close`）；点 Accept 后 `#mask` 隐藏。同站的 `/ov/shell`（铺满视口的应用根容器，文字多、没有遮罩背景、没有样式化内块）仍是反例。
- 走法：`navigate /ov/wrapped` → `snapshot --interactive` → 读 overlays 与 close ref → 普通 `click <#buy 的 ref>` → `click <Accept 的 ref>` → 普通与 `--trusted` 各点一次 `#buy`。
- expected：`snapshot --interactive` 的 `overlays` 恰一条 `o1`，`kind:"dialog"`、`coverage:100`、`modal:true`，`evidence` 含 `"full-viewport wrapper"` 与 `"buttons in an inner block"`，`close` 的 ref 就是 `find "Accept"` 给的那个；树的首行以 `overlays  o1 dialog` 开头。普通 `click` `#buy` 回 `ok:false`、`code:"covered"`、`error.overlay.kind:"dialog"`，`next` 含那个 close ref，`window.__hits.buy` 仍未定义（没有穿透）。点 Accept 后 `outline` 的 `overlays` 为空；随后普通 `click #buy` 与 `click #buy --trusted` 都成功（`overlayCheck:"clear"` / `trusted:true`、`delivered.pointerdown:true`），页面 `__hits.buy` 为 2。`/ov/shell` 仍 `overlays:[]`。
- 阈值（与 `docs/10` 0.7.3 节一致）：固定层覆盖 ≥ 90% 视口；内块是容器而非控件本身、至少 160 × 60 px、面积 ≤ 60% 视口；内块不透明背景 alpha ≥ 0.5 或有可见边框 / 阴影；内块含按钮或表单控件；层自身文字 ≤ 500 字。普通固定页头 / 底栏面积小，不是候选。

## 15. 0.7.5 列表结束与交接按条件结束（10-20，P1）

### s64 list-end（P1；0.7.5-A，`04` §38）
- 页面 `/s64`（`test/e2e/site.ts` 的 `startHandoffSite`）：按钮「下一页」（`#s64-next`）每点一次 `fetch("/s64/api?page=<n>")`（n 从 1 起递增）并读正文，把 `p<n>=<code>` 写进 `#s64-out`。`/s64/api?page=N`：N 为 1–3 回 HTTP 200 `{"code":0,"items":[…]}`，N ≥ 4 回 HTTP 200 `{"code":203,"msg":"no more"}`，`page=bad` 回 HTTP 200 `{"code":500,"msg":"boom"}`；服务器按到达顺序记每次的 `page` 与回了什么（oracle）。配置 `fetch.minIntervalMs: 0`；`sites.example.guard: {stopOn:["json:$.code!=0"], endOn:["json:$.code=203"]}`（作者真实场景的写法；站点级规则对页面文档也求值，0.7.5 前非 JSON 正文算「无值」≠ 0，`navigate /s64` 即 `guard.stopped`【实测：第一版 s64】，0.7.5 起 `json:` 规则只评判 JSON 正文，`04` §26）；站点 `example` 入口 `/s64`。
- 走法：`net start` → `navigate /s64` → `fetch /s64/api?page=1`、`=2`、`=3`、`=4` → `fetch ?page=1` → 点「下一页」四次（页面自己的请求，第 4 次是 203）→ `handoff status` → `fetch ?page=bad` → `guard resume --site example` → `fetch ?page=bad --end-on 'json:$.code=500'` → `net stop`。
- expected：前三个 `fetch` 成功、没有 `end`；`page=4` 的 `fetch` 成功，`end.rule:"json:$.code=203"`、`end.detail` 含 `$.code is 203`，没有 `stopped`；之后 `fetch ?page=1` 成功（站点没停）；四次点击都成功、`#s64-out` 最后是 `p4=203`、`handoff status` 为 `running`；`page=bad` 回 `fetch.stopped`（`reason:"stop-rule"`、`rule:"json:$.code!=0"`，结束规则不挡真正的错误）；`guard resume` 后带 `--end-on 'json:$.code=500'` 的 `page=bad` 成功、`end.rule:"json:$.code=500"`。服务器收到的顺序与上面一致。包里 `guard` `end` 恰三条（`fetch` 的 page=4、点击的 page=4、带 `--end-on` 的 page=bad，`request` 各不相同），`breaker` 与 `resume` 各一条（`stop-rule`）。

### s65 login-done（P1；0.7.5-B，`04` §39）
- 页面 `/s65/login?k=<键>[&stay=1]`（同一个 `startHandoffSite`）：文字 `S65_LOGIN_PAGE`；按钮 `#s65-go`（文字 `S65_GO`）固定在视口左上角 `0,0` 起 240 × 80 px，所以 `e2e.human-input` 在 (4, 4) 的按下正好按在它上面。点它：没有 `stay=1` 时 1500 ms 后跳到 `/s65/done?k=<键>`；`stay=1` 时什么都不做。`/s65/done?k=<键>` 回 302、`Set-Cookie: s65_<键>=1; Path=/`、`Location: /s65/home?k=<键>`；`/s65/home` 显示 `S65_WELCOME`。服务器记每次 `/s65/done`（oracle）。
- 走法与 expected（`test/e2e/v075b.e2e.test.ts`；守护进程以 `TABCAP_E2E_HUMAN=1` 启动）：
  1. **URL 条件**：`net start` → `navigate /s65/login?k=a` → `e2e.human-input`（按在 `S65_GO` 上）→ `handoff status` 为 `waiting`、`human-takeover` → 立刻 `handoff wait --until-url /s65/home --timeout 15000`。expected：回 `state:"resumed"`、`by:"condition"`、`condition:{kind:"url", value:"/s65/home"}`；之后 `snapshot` 不带 `handoff`、`click` 可用；服务器收到一次 `/s65/done?k=a`。
  2. **cookie 条件，人先做完**：`navigate /s65/login?k=b` → `e2e.human-input` → 等 4 s（跳转已完成，标签在 `/s65/home?k=b`）→ `handoff wait --until-cookie s65_b --timeout 5000`。expected：立刻回 `by:"condition"`、`condition:{kind:"cookie", value:"s65_b"}`（交接开始时的基线里没有这个名字）；回答与 `handoff` 事件里都不出现 cookie 值（录制本身照 `04` §4.1 记下响应头与 cookie 快照，那是录制的事，不是这条命令的输出）。
  3. **一开始就成立**：`navigate /s65/login?k=c&stay=1` → `e2e.human-input` → `handoff wait --until-text S65_LOGIN_PAGE --timeout 10000`。expected：1 s 内回 `ok:false`、`code:"waiting"`，`message` 含 `already`，会话仍 `waiting`。
  4. **人从别处继续**：接 3，后台跑 `handoff wait --until-url /never --timeout 15000`，1 s 后 `handoff continue`。expected：后台那条回 `state:"resumed"`、`by:"human"`。
  - 包里（`net stop` 后）：`handoff` 的 `resumed` 依次是 `by:"condition"`（`condition.kind:"url"`）、`by:"condition"`（`condition.kind:"cookie"`）、`by:"human"`。
- 不在靶场里的【待验】：真人登录、跨域单点登录的 cookie（`04` §39 末条）。

## 16. 0.7.6-A 默认隐藏 webdriver（10-20，P1）

### s66 webdriver（P1；0.7.6-A，`04` §40）
- 页面 `/s66`（`test/e2e/site.ts` 的 `startWebdriverSite`）：脚本加载时把 `navigator.webdriver` 和 `Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get` 是否原生（`toString()` 含 `[native code]`）用 `fetch("/s66/report?where=main&...")` 报给服务器；页面里一个 `<iframe src="/s66/frame">`，同样报 `where=frame`。服务器按到达顺序记每份报告（oracle）。
- 走法与 expected（`test/e2e/v076a.e2e.test.ts`）：
  1. **默认**：`browser start --proxy none` → `session start a` → `navigate /s66` → 等两份报告。expected：`browser start` 回答 `webdriver:"hidden"`；服务器记到 `main` 与 `frame` 各一份，都是 `webdriver=false`、`native=true`；`status` 的 `browser.webdriver` 为 `"hidden"`；`net start` / `net stop` 包住这次导航的包 `manifest.producer.browser.webdriver` 为 `"hidden"`。
  2. **关掉**：另一个 `TABCAP_HOME`，`browser start --proxy none --webdriver visible` → 同样导航。expected：回答 `webdriver:"visible"`，两份报告都是 `webdriver=true`（pipe 下 Chrome 自己的值，`07` §1.2）、`native=true`。
  3. **配置**：第三个 `TABCAP_HOME`，`config.json` `{"webdriver":"visible"}`，`browser start --proxy none`（不带 `--webdriver`）。expected：回答 `webdriver:"visible"`；`config.json` `{"webdriver":"sometimes"}` 时 `browser start` 回 `usage`，浏览器没有起来。
- 不在靶场里的【待验】：`ext` 模式（作者自己的 Chrome）的值。

## 17. 0.8-A 防护家族识别（10-20，P1）

共同点（`test/e2e/site.ts` 的 `startProtectionSite`，`test/e2e/v08a.e2e.test.ts`）：页面与桩脚本都是我们自己写的，只放名字（cookie 名、主机名、全局变量名、类名），不放任何厂商代码。厂商主机写成 `http://<厂商主机>:<靶场端口>/…`，浏览器以 `--proxy <fwdproxy>` 启动，`test/e2e/fwdproxy.ts` 把它们转到本机靶场（CONNECT 照旧拒绝，什么都不出本机）。每个场景页也放在自己的假主机上（`dd.range.test`、`ak.range.test` …），各页 cookie 互不串。oracle：靶场按顺序记下每个请求的路径与 Host 头（`hits`），加上每页埋下的东西；家族名与分数由 `docs/14` 的规则文件推出。

### s67 passive（P1；L1，实时与录制）
- 页面：`/s67/datadome` 下发 `datadome=<32 位>` 并加载 `http://js.datadome.co:<端口>/tags.js`（桩：`window.ddjskey="k"`）；`/s67/akamai` 下发 `_abck=<32 位大写 hex>~0~…` 与 `bm_sz`；`/s67/recaptcha` 有 `<div class="g-recaptcha" data-sitekey="x">` 并加载 `http://www.google.com:<端口>/recaptcha/api.js`（桩：`window.grecaptcha`）；`/s67/none` 只下发 `TS01ab12cd=1` 并请求 `/cdn-cgi/trace`。
- 走法与 expected：
  1. **不录制**：依次 `navigate` none / datadome / akamai / recaptcha。none 的回答**没有** `protection`；其余分别是 `[{DataDome, 100}]`、`[{Akamai Bot Manager, 100}]`、`[{Google reCAPTCHA, 100}]`；随后 `snapshot` 同样带 reCAPTCHA，`status` 的会话 `protection` 为 `["Google reCAPTCHA"]`；`hits` 里有 Host 为 `js.datadome.co` 的 `/tags.js` 与 `www.google.com` 的 `/recaptcha/api.js`（桩确实经代理以厂商主机到达）。
  2. **录制**：`net start` → `navigate` datadome（另一个主机）→ `net stop`。包里恰一条 `protection` 事件，`detections` 为 `[datadome 100]`；`analyze recon <包>` 的 `summary.protection` 含 `DataDome (anti-bot, 100)`，`dossier.json` 有 `"source": "family"`；dossier 与 `protection` 事件里都搜不到那个 cookie 值。

### s68 page（P1；L2）
- 页面 `/s68`：`<div class="cf-turnstile">`、`<iframe src="http://geo.captcha-delivery.com:<端口>/x">`，同源桩脚本设 `window.initGeetest4=function(){}`、`window._dx={Captcha(){}}`，并用 `Object.defineProperty(window, "ddjskey", {get(){ fetch("/s68/getter-ran"); … }})` 埋一个会自报的 getter。
- expected：`navigate` 回答的 `protection` 恰为极验 GeeTest v4、顶象、Cloudflare Turnstile、DataDome 四家（DataDome 90：iframe 规则；`ddjskey` 是访问器，只算存在），靶场**收不到** `/s68/getter-ran`（L2 读描述符，从不调用 getter）。

### s69 trace（P1；L3）
- 页面 `/s69` 加载 `http://h.online-metrix.net:<端口>/fp/tags.js`（桩：canvas `toDataURL` 与 `getImageData`、WebGL `getParameter`、读 `navigator.hardwareConcurrency`，最后 `window.__s69="done"`）。
- 走法：`net start` → `trace start` → `navigate /s69` → 等 `__s69` → `trace stop` → `net stop` → `analyze recon <包>`。
- expected：`dossier.json` 的 `fingerprinting` 含 `fp-canvas`、`fp-webgl`、`fp-hardware`，每项 `attributedTo:"threatmetrix"`，`callers[0].url` 含 `h.online-metrix.net`。

### s70 challenge（P1；guard + 家族）
- 页面 `/s70/cf` 回 403 HTML 并下发 `__cf_bm`；`/s70/jsl` 第一次回 521 并下发 `__jsluid_h`、页面脚本设 `__jsl_clearance` 后 `location.reload()`，带了该 cookie 再请求回 200。
- 走法与 expected：`net start` → `navigate /s70/cf`：guard 进入 `verify-page` 交接（录到 403 HTML），`handoff status` 的 `handoff.protection` 为 `["Cloudflare Bot Management"]`（交接截图那一步在标签的轮次里补做探测，回答等它），`next` 以 `This is Cloudflare Bot Management (identified, not bypassed; a human handles it). ` 开头；`handoff continue` → `net stop` 后，包里 `handoff {state:"waiting"}` 事件带同样的 `protection`。另一个会话 `navigate /s70/jsl`：回答 `protection` 含「知道创宇 加速乐」（cookie 名规则）。
- 不在靶场里的【待验】：真实站点上的命中与误报（`docs/14`）。实时探测不读响应头与状态码（`04` §41.3），521 / 412 这类挑战页规则只在 `recon` 里生效。

## 18. 0.8.1-A 自定义 Chrome 启动参数（10-21，P1）

### s71 chrome-args（P1；0.8.1-A，`04` §42）
- 页面 `/s71`（`test/e2e/site.ts` 的 `startChromeArgsSite`）：脚本加载时把 `navigator.userAgent` 与 `navigator.webdriver` 用 `fetch("/s71/report?ua=…&webdriver=…")` 报给服务器；服务器连同这次请求的 `User-Agent` 头按到达顺序记下（oracle）。
- 走法与 expected（`test/e2e/v081a.e2e.test.ts`）：
  1. **加与合并**：`browser start --proxy none --chrome-arg --user-agent=TabcapS71/1.0 --chrome-arg --disable-features=TabcapS71Probe` → `session start a` → `net start` → `navigate /s71` → 等一份报告 → `net stop`。expected：回答 `extraArgs` 为这两项、`dropArgs` 与 `dropArgsUnmatched` 为空；`args` 里恰好一条 `--disable-features=`，同时含 `PreconnectToSearch` 与 `TabcapS71Probe`，含 `--user-agent=TabcapS71/1.0`；服务器记到的 `User-Agent` 头与 `navigator.userAgent` 都是 `TabcapS71/1.0`，`webdriver=false`；`status` 的 `browser.extraArgs` 为这两项；包的 `manifest.producer.browser.args` 含 `--user-agent=TabcapS71/1.0` 与 `--user-data-dir=<profile>`、不含本机 profile 路径，`extraArgs` 为这两项。再跑一次不带参数的 `browser start`：`alreadyRunning:true`，带 `note`。
  2. **删（配置）**：另一个 `TABCAP_HOME`，`config.json` `{"chrome":{"dropArgs":["--disable-blink-features","--disable-features=PreconnectToSearch","--tabcap-s71-absent"]}}`，`browser start --proxy none`。expected：回答 `webdriver:"visible"`、`dropArgs` 为这三项、`dropArgsUnmatched` 为 `["--tabcap-s71-absent"]`；`args` 里没有 `--disable-blink-features`，`--disable-features=` 还在、含 `Translate`、不含 `PreconnectToSearch`；导航 `/s71` 后报告 `webdriver=true`。
  3. **拒绝**：各自 `browser start --proxy none` 加 `--chrome-arg --user-data-dir=<临时目录>`、`--chrome-arg --proxy-server=http://127.0.0.1:9`、`--chrome-arg about:blank`、`--drop-chrome-arg --remote-debugging-port` 之一：都回 `usage`，`browser status` 为 `running:false`。`config.json` `{"chrome":{"args":"--x"}}` 回 `bad-input`，消息含 `chrome.args`。
- 不在靶场里的【待验】：作者真实使用里要加的那几个参数本身的效果（靶场只证明参数到了 Chrome 并按规则合并）。

## 19. 0.9 DrissionPage 5.0 对照后的四项（10-23，P1）

四个场景的 oracle 都是靶场服务器自己记下的东西（发出的状态码、字节、分段时刻、文件哈希）与页面自己的记录，不来自 tabcap 的输出。

### s72 nav-status（P1；0.9-A，`04` §45）
- 页面（`test/e2e/site.ts` 的 `startNavStatusSite`，两个源 A、B）：`/s72/ok` 200、`/s72/missing` 404、`/s72/boom` 500、`/s72/partial` 203、`/s72/moved` 302 → `/s72/missing`、`/s72/away` 302 → B 的 `/s72/ok`（跨源）、`/s72/js` 200 但脚本 `location.replace('/s72/missing')`（页面还挂着一张 2 s 才回的图 `/hold`，旧文档在替换提交前不会 `complete`，答复的就一定是 404 那份文档而不是靠时序；`/hold` 不在 `/s72/` 下，不进 oracle）、`/s72/empty` 204，`/s72/` 下其余路径 404，`/s72/forge` 见第 5 步。服务器按到达顺序记下每个请求的路径与它回的状态码（oracle）。
- 走法与 expected（`test/e2e/v09a.e2e.test.ts`），不开录制：
  1. 依次 `navigate` 到 ok / missing / boom / partial / moved / away / js：回答 `status` 依次为 200、404、500、203、404、200、404，每个都等于服务器为该次导航最后一跳记下的状态码；`url` 是最后一跳的 URL。
  2. 在 missing 上 `navigate …/s72/missing#x`（同文档）：`status` 404；`evaluate "history.pushState({}, '', '/s72/pushed')"` 后 `reload`：重新加载的是 `/s72/pushed`（靶场对未知路径回 404），`status` 404；`navigate /s72/ok` 再 `go back`：`status` 404。
  3. `navigate /s72/empty`：照旧回 `page` 错误（`net::ERR_ABORTED`），不带 `status`；之后 `tab list` 显示标签仍在上一页。
  4. `tab new <A>/s72/boom`：回答 `status` 500。`navigate about:blank`：`status` 为 `null`。
  5. 页面改写主世界的 `performance.getEntriesByType`（`/s72/forge` 页面让它返回 `responseStatus: 299`，服务器实际回 200）：`status` 仍是 200（隔离世界里读）。

### s73 permissions（P1；0.9-B，`04` §46）
- 页面（`startPermissionSite`，两个源 A、B）：`/s73` 提供 `window.s73State()`，在页面自己的世界里对 geolocation、notifications、clipboard-read、camera、midi 调 `navigator.permissions.query`，返回状态表（oracle 是页面自己看到的状态）；`/s73/geo` 提供 `window.s73Geo()`：`getCurrentPosition` 的结果，外加 4 s 的外层超时（超时回 `{hung:true}`）。
- 走法与 expected（`test/e2e/v09b.e2e.test.ts`）：
  1. 会话 a 打开 A 的 `/s73`：初始全是 `prompt`。`permission grant geolocation notifications`：回答 `origin` 是 A、`names` 两个、`context:"default"`、`shared:true`、带 geolocation 的 `note`；页面状态 geolocation、notifications 为 `granted`，其余 `prompt`。同一默认 context 里另开 B 的 `/s73`：全是 `prompt`。
  2. `permission deny geolocation`：A 上 `denied`；`permission reset geolocation`：A 上回到 `prompt`，notifications 仍 `granted`。
  3. `permission grant push`：成功（tabcap 带了 `userVisibleOnly`）。`permission grant geolocaton`：`usage`，信息含 Chrome 原话，`next` 提到 `geolocation`。`permission grant notifications geolocaton`：`usage`，`error.result.applied` 是 `["notifications"]`。
  4. 在 about:blank 上 `permission grant camera`：`usage`；`--origin <B>/any/path?q=1` 时回答 `origin` 是 B 的 origin。`--origin file:///tmp` 回 `usage`。
  5. 池账号会话（`session start --site`，有自己的 context）打开 A 的 `/s73`，`permission grant midi`：回答 `context:"session"`、`shared:false`；这个会话里 midi `granted`，会话 a 的 A 页面 midi 仍 `prompt`。
  6. 定位：会话 a 在 A 的 `/s73/geo` 上 `emulate --geolocation 31.23,121.47`、`permission grant geolocation`，然后 `click --trusted` 一个按钮（它的处理函数调 `s73Geo()` 并把结果写进 `#out`；焦点仿真在这条命令期间开着）：`#out` 里是坐标 31.23；不开焦点仿真直接 `evaluate --await "s73Geo()"`：`{hung:true}`（与 `note` 说的一致）。
  7. `browser stop` 后再 `browser start`，A 的 `/s73`：全是 `prompt`。

### s74 sse-stream（P1；0.9-C，`04` §47）
- 页面（`startStreamSite`）：`/s74` 提供三个页面函数：`s74Fetch(path, q)` 用 `fetch()` POST、`ReadableStream` reader 逐段读，记下每段到达的页面时刻与长度；`s74Xhr(path, q)` 用 XHR 的 `onprogress` 记；`s74Es(path, q)` 用 `EventSource`，收到 `done` 事件后 `close()`，记下每条消息的类型、`lastEventId`、data 与时刻。服务器路由：`/s74/sse`（`text/event-stream`，参数 `n` 条、`gap` 毫秒、`crlf=1` 用 CRLF；内容依次是一条注释、一条 `retry: 100000`、n 条消息（每第 3 条是 `event: a`、`id`、两行 `data`，其余是 `id` 加一行 JSON delta 含中文），最后 `event: done` / `data: [DONE]`）、`/s74/cut`（同样的流，发到一半时重置连接）、`/s74/ndjson`（`application/x-ndjson`，n 行）、`/s74/es`（同 `/s74/sse`，给 EventSource 用的 GET）。服务器记下每次请求每段发出的时刻与字节、结束方式（`done` / `cut` / 客户端走了）与全部字节的 sha256（oracle）。
- 走法与 expected（`test/e2e/v09c.e2e.test.ts`）：
  1. **不缓冲**：`net start` 后 `evaluate --await "s74Fetch('/s74/sse','n=6&gap=200')"`：页面收到的段数 ≥ 服务器发出段数 − 1，第一段到达早于服务器发最后一段的时刻（录制不再把流攒到结束才交给页面）。`s74Xhr` 同样（`onprogress` 次数 ≥ 段数 − 1）。`s74Es('/s74/es', …)`：各条消息的到达时刻不全相同，间隔与 `gap` 同量级。
  2. **正文**：`net list` 里三条请求 `outcome:"finished"`，`net body` 文件的 sha256 等于服务器记下的；CRLF 版同样。
  3. **`sse` 事件**：`net list --kind sse` 对 fetch 那条请求列出 n + 1 条消息（含 `done`），每条的 `event`、`lastEventId`、data 与服务器发出的内容按规范解析的结果一致（类型 `message` / `a` / `done`，多行 data 用 LF 连接，注释与 `retry` 行不成消息，`done` 的 `lastEventId` 沿用前一个 id）；EventSource 那条的每条 `sse` 事件与页面 `s74Es` 记下的（类型、`lastEventId`、data）逐条相等，也与录制原始流里 Chrome 的 `Network.eventSourceMessageReceived` 逐条相等。`at` 单调不减，相邻两条之差与 `gap` 同量级（不是全部相同）。`net show r-N`（fetch 那条）带 `sse.messages` 等于 n + 1。
  4. **断流**：`s74Fetch('/s74/cut','n=6&gap=200')`：页面报网络错误；`net list --failed` 里这条 `outcome:"failed"`、`partial:true`，正文字节是页面收到的那部分（长度等于页面收到的字节数，且是服务器所发字节的前缀）；`sse` 事件只有已完整的那几条。
  5. **导航打断**：发起一条 `n=20&gap=200` 的流，900 ms 后 `navigate` 到别的页：这条请求 `outcome:"incomplete"`、`partial:true`，正文是服务器所发字节的前缀且非空。
  6. **ndjson**：`s74Fetch('/s74/ndjson','n=6&gap=200')` 逐段到达（同第 1 条判据），正文 sha256 对，没有 `sse` 事件。
  7. **普通请求不受影响**：同一录制里一个普通 JSON `fetch` 的正文照常由 Fetch 拦截路径取到（`bodySource` 不变）。
- 不在靶场里的【待验】：真实 LLM 站的流式类型（`04` §47）。

### s75 downloads（P1；0.9-D，`04` §48）
- 页面（`startDownloadSite`）：`/s75` 有四个触发：附件链接（`/s75/file`，`Content-Disposition: attachment; filename="s75-<tag>.txt"`）、`a[download]`（同源纯文本 `/s75/plain`）、blob URL、`data:` URL；`/s75/big?mb=<n>` 是带 `Content-Length` 的慢速大附件；`/s75/nav` 是导航即下载的附件；`/s75/plain` 本身是普通文本。服务器记下每个附件发出的字节与 sha256（blob / data 的内容由页面脚本写死，sha256 写在测试里）。
- 走法与 expected（`test/e2e/v09d.e2e.test.ts`）：
  1. **不录制时**：`navigate /s75`，`click` 附件链接：回答 `downloads[0]` 为 `state:"canceled", reason:"not-recording"`，带 `next`；暂存目录与包里都没有文件；本机 `~/Downloads` 里没有名字含本次 `<tag>` 的文件（只读检查）。
  2. **录制中**：`net start`，依次 `click` 四个触发（默认 DOM 点击，不带用户手势），`download wait` 四次：四个都是 `completed`，`file` 存在、sha256 等于服务器 / 测试记下的，`download list` 四条、`tab` 是这个标签；`download` 事件 `cmd` 是触发它的那条 `click` 的窗口。
  3. **导航即下载**：`navigate /s75/nav`：回答 `ok`，`download.state:"in-progress"`（或已完成），带 `note`；标签仍在 `/s75`；随后 `download wait` 得到它，sha256 对。不录制时同一步回 `download.state:"canceled", reason:"not-recording"` 与 `next`。
  4. **超限**：测试把上限换小——这一步靠单测（200 MiB 太大，e2e 不下这么大的文件）：e2e 只验 `/s75/big?mb=8` 在录制中正常 `completed`、sha256 对。
  5. **池账号 context**：`session start --site` 的会话录制中点附件：`completed`（证明新 context 也设了行为）。
  6. **`net stop` 时还在下**：`/s75/big?mb=64`（慢速）开始后立刻 `net stop`：包里这条 `download` 为 `canceled`、`reason:"stopped"`，没有文件。
  7. **`bundle redact`**：副本里没有 `downloads/`，`download` 事件 `file:null`、`redacted:true`。
- 不在靶场里的【待验】：网络中断的下载 CDP 是否报 `canceled`（`04` §48 的推断）。

## 20. 场景索引

10-21 建。场景编号 → 实现它的 `test/e2e/site.ts` 站点函数与主要路由 → 跑它的 e2e 文件。e2e 与单测两列是 grep 出来的：在 `test/e2e/*.e2e.test.ts`、`test/unit/*.ts` 里搜编号（前后不接字母数字，如 `s07`、`/s22/`、`S40_`），列出提到它的文件（省略目录与 `.e2e.test.ts` / `.test.ts` 后缀）；没有文件写编号的三个场景按路由搜（标「按路由」）。单测 `test/unit/scenario-index.test.ts` 读这张表：每个 `### sNN` 都要有一行，状态不是「未落地」「仅对照靶场」的，编号必须能在 `site.ts` 或某个测试文件里搜到；「未落地」的在 `site.ts` 里搜不到（落地了就要回来改表）；「仅对照靶场」的在 `docs/compare/range.ts` 里搜得到。

状态：**已落地** = `site.ts` 有这个场景的路由并有 e2e；**近似** = `site.ts` 里是等价页（注释写 `sNN-like`），路径、端口或数据与本文的描述不完全一样；**仅单测** = 没有靶场路由，只在单测里用合成包覆盖；**仅对照靶场** = 只在 `docs/compare/range.ts` 里有；**未落地** = 没有路由，也没有测试。

| 编号 | 名称 | 状态 | `site.ts` 站点与路由 | e2e（提到编号的文件） | 单测（提到编号的文件） |
|---|---|---|---|---|---|
| s01 | plain-json | 近似 | `startSite`：`/` 的列表 XHR `/api/items` | v03b | — |
| s02 | multipage-nav-race | 近似 | `startSite`：点击里 `POST /api/before-leave` 后立刻跳 `/two` | v03b | _fixtures、deps |
| s03 | spa-routes | 未落地 | — | — | — |
| s04 | encodings | 仅单测 | —（`test/unit/find.test.ts` 用合成包覆盖 12 条通道） | —（v04h 只在注释里引用 s04 的解码链写法） | embedded、find |
| s05 | encrypted | 仅单测 | —（`test/unit/find.test.ts` 的 s05-like 合成包） | — | find |
| s06 | diff-params | 近似 | `startSearchSite`：`/s06`、`/api/search` | v03b、v04a、v04j、v06c、v06g、v06h | deps、diff、har-mitmproxy、recon、shape |
| s07 | token-chain | 近似 | `startGuardSite`：`/s07/login`、`/api/login`、`/api/data` | v03a、v03c、v03e、v04a、v04j、v05c、v06a、v06c、v06e、v06f、v06h、v06r、v07b | _deps、har-mitmproxy、liveredact、session-export、state |
| s08 | popup-login | 未落地 | — | — | — |
| s09 | cross-origin-iframe | 未落地 | —（跨源 iframe 的挂接由 s22 覆盖） | — | — |
| s10 | service-worker | 未落地 | — | — | — |
| s11 | websocket | 近似 | `startLabSite`：`/ws-page`、`/ws` | v02（按路由 `/ws-page`） | — |
| s12 | big-and-binary | 未落地 | — | — | — |
| s13 | redirect-304-204 | 未落地 | —（POST 跟 302 由 s49 覆盖） | — | — |
| s14 | human-recorder | 未落地 | —（P2；人接管识别见 s62） | — | — |
| s15 | verify-wall | 近似 | `startGuardSite`：`/s15/`、`/api/limited`、`/api/verified` | v03a、v03e、v04j、v07b | daemon-helpers、flake-s15、guard、hooks |
| s16 | session-expiry | 未落地 | —（P2） | — | — |
| s17 | popup-focus | 已落地 | `startFieldSite`：`/popup`、`/popup-target` | v02d | front |
| s18 | vue-rerender-stale-ref | 已落地 | `startFieldSite`：`/rerender` | v02d | stale-find |
| s19 | custom-checkbox | 已落地 | `startFieldSite`：`/checkbox` | v02d | stale-find |
| s20 | port-scan-noise | 已落地 | `startFieldSite`：`/noise` | v02d、v05c | netquery |
| s21 | aes-json | 仅对照靶场 | 不在 `site.ts`；`docs/compare/range.ts` 为 `12` 的对照跑实现了 `/s21`、`/api/key`、`/api/secret`，不进测试 | — | — |
| s22 | frames | 已落地 | `startFrameSite`：`/s22`、`/s22/{menu,main,form,table,modal,search}` | v04i、v05f、v06d | frames、overlay |
| s40 | locale-numbers | 已落地 | `startLocaleSite`：`/s40`、`/api/rows` | v04c、v05f | normalize、where |
| s41 | embedded-state | 已落地 | `startEmbeddedSite`：`/s41` | v04h | embedded |
| s42 | decode-plugins | 已落地 | `startDecodeSite`：`/s42`、`/s42/api/{token,items,order}` | v06b、v06c | _decode、decode-plugins、decode-python、decode-views、fixtures-export、observe06l、plugin-init、replay-chain、replay-rules、shape |
| s46 | input-fidelity | 已落地 | `startProbeSite`：`/probe`、`/report` | v03e | eventshape、input-fidelity |
| s47 | hidden-controls | 已落地 | `startDaemonFixSite`：`/s47` | v06d | — |
| s48 | click-effects | 已落地 | `startDaemonFixSite`：`/s48`、`/s48/next`、`/s48/ping` | v06d | — |
| s49 | post-redirect | 已落地 | `startDaemonFixSite`：`/s49`、`/s49/submit`、`/s49/done`、`/s49/api`、`/s49/api/done` | v06d | post-redirect |
| s50 | image-captcha | 已落地 | `startDaemonFixSite`：`/s50`、`/s50/plain`、`/s50/captcha.png` | v06d | — |
| s51 | account-contexts | 已落地 | `startPoolSite`：`/pool/set`、`/pool/me` | v06d（按路由 `/pool/me`） | — |
| s52 | frame-dates | 已落地 | `startDaemonFixSite`：`/s52`、`/s52/frame` | v06d | — |
| s53 | token-bearer | 已落地 | `startTokenSite`：`/s53/`、`/api/s53/token`、`/api/s53/me` | v04a | _deps |
| s54 | big-script | 已落地 | `startBodiesSite`：`/s54`、`/s54/{big.js,site.css,logo.png,api}` | v06i | bodies06i |
| s55 | site-stop | 已落地 | `startBodiesSite`：`/s55`、`/s55/api` | v06i | — |
| s56 | click-landing | 已落地 | `startClickTargetSite`：`/s56` | v06j | ci-flakes |
| s59 | in-page-decode | 已落地 | `startInPageDecodeSite`：`/s59`、`/s59/worker.js` | v06l | observe06l |
| s60 | fetch-credentials | 已落地 | `startCredSite`：`/s60`、`/s60/api/{wild,double,private,login,me}` | v06p | fetch06a、session-export |
| s62 | human-takeover | 已落地 | `startTakeoverSite`：`/s62`、`/s62/ping` | v071a | takeover071a |
| s63 | overlay-wrapper | 已落地 | `startOverlaySite`：`/ov/wrapped`（反例 `/ov/shell`） | v03d（按路由 `/ov/wrapped`） | — |
| s64 | list-end | 已落地 | `startHandoffSite`：`/s64`、`/s64/api` | v075a | — |
| s65 | login-done | 已落地 | `startHandoffSite`：`/s65/login`、`/s65/done`、`/s65/home` | v075b | handoffwait075b |
| s66 | webdriver | 已落地 | `startWebdriverSite`：`/s66`、`/s66/frame`、`/s66/report` | v076a | — |
| s67 | passive | 已落地 | `startProtectionSite`：`/s67/{datadome,akamai,recaptcha,none}` | v08a | — |
| s68 | page | 已落地 | `startProtectionSite`：`/s68`、`/s68/stub.js`、`/s68/getter-ran` | v08a | — |
| s69 | trace | 已落地 | `startProtectionSite`：`/s69` | v08a | — |
| s70 | challenge | 已落地 | `startProtectionSite`：`/s70/cf`、`/s70/jsl` | v08a | — |
| s71 | chrome-args | 已落地 | `startChromeArgsSite`：`/s71`、`/s71/report` | v081a | — |
| s72 | nav-status | 已落地 | `startNavStatusSite`：`/s72/{ok,missing,boom,partial,moved,away,js,empty,forge}`（其余 `/s72/` 路径 404） | v09a | nav-status |
| s73 | permissions | 未落地 | — | — | — |
| s74 | sse-stream | 未落地 | — | — | — |
| s75 | downloads | 未落地 | — | — | — |

空号：
- s23–s39、s43–s45：`09` §12 的规划编号，本文不用（0.6-D 起本文从 s47 编，见 §7）。其中 s24 / s36 / s45 的遮挡页在 `site.ts` 的 `startOverlaySite`（`/ov/*`，0.3-D）里，按 `09` 的编号写在注释里，不是本文的场景。
- s57、s58：`09` §12 的规划编号（10-21 由 `09` 原来的 s41 chart-instance、s42 report-viewer 改号而来，那两个号与本文已落地的 s41、s42 撞了）。
- s61：没有用过（docs、NOTES、代码里都搜不到）。
- s76 起：未分配。
