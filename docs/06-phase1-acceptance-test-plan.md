# 阶段 1 验收 → 可执行测试计划（草案，待审）

2026-10-15。把 `03` §7 阶段 1 的 5 条验收逐条翻成测试：每条写**测什么、oracle 从哪来、怎么跑、通过的定义、剩下哪些只能人确认**。格式依据 `04`，场景依据 `05`。

已定：运行时 Bun，测试跑 `bun test`；命令行用 `tabcap`（起初的占位符 `bbl` 已在定名后替换）。探路由 AI 做，人只在验证码或需要人点的时刻介入。

## 1. 四层测试

| 层 | 名字 | 需要什么 | 跑多久 | 命令 |
|---|---|---|---|---|
| L0 | 单元 + 夹具 | 无；离线、确定性 | < 10 s | `bun test` |
| L1 | 靶场自检 | 靶场进程；不要浏览器 | < 10 s | `tabcap range selftest` |
| L2 | 端到端 | `tabcap setup` 装好的 Chrome for Testing + 守护进程 + 靶场 | < 3 min | `bun run test:e2e` |
| L3 | 人工清单 | 人 | 一天 soak | `05` §4，结果记 NOTES |

`bun run verify` 依次跑 L0、L1、L2，最后打印验收矩阵（A1–A6 × 通过 / 失败 / 待验 / 人确认），任一 **P1** 失败则退出码非零；**P1\*** 场景失败只标「待验」，不算失败但必须出现在表里，不能静默变绿。

L2 一律通过**命令行 JSON 信封**驱动，不调内部函数：测试同时是 CLI 契约的测试。

## 2. 规则

- **expected 来自 oracle**：靶场日志（`/__range/journal`）、各场景 `expected.json`、DevTools 导出的 HAR、HAR 1.2 规范。AI 不为让测试通过改 expected；改 expected 要在 NOTES 写理由，人确认。
- **证据要新**：L2 每次从零录；夹具包过期（格式升级）就重录，不手改。
- **只碰本机**：L2 只访问 `127.0.0.1:4310` / `localhost:4311`；清 cookie 只清这两个源（`Network.deleteCookies` 按域），绝不 `Storage.clearDataForOrigin` 以外的清法，绝不碰工作 Chrome 其它站点的状态。
- **凭据不泄漏**：每个 L2 场景结束后，用本地库里每个密码值 grep 证据包（登录 POST 正文除外）、守护进程日志、CLI 全部输出，命中即失败；脱敏导出后的 HAR 连 POST 正文也不能命中。
- **浏览器零外连**：L2 启动浏览器时加黑洞代理 `--proxy-server=127.0.0.1:1 --proxy-bypass-list="127.0.0.1;localhost"`，Chrome 自身的 GCM / 组件更新等后台请求全部截断，避免 L2 夹带意外外连、干扰断言【实测 spike 2：带这两个参数本地页 130 轮全部正常加载；外连是否被完全截断未抓包验证，待验】。
- **与其它调试类扩展共存**：`direct` 模式用自己的 Chrome for Testing，与用户 Chrome 里的扩展无关；阶段 2 的 `ext` 模式下 `chrome.debugger` 一个标签只能有一个客户端，只挂自己开的标签，跑 soak 前关掉其它挂 debugger 的扩展的会话【推断，待验】。

## 3. 逐条验收

### A1 「不弹框、不抢焦点」

| 测试 | 层 | 做法 | 通过 |
|---|---|---|---|
| A1.1 零点击可用 | L2 | 在空缓存目录下 `tabcap setup` 非交互跑通（无 TTY 提问）；`tabcap browser start` 后 `/status` 显示 `transport:"direct"`、浏览器版本、profile 路径；CDP 端口只绑回环（`lsof` 检查）；整个 L2 运行期间守护进程审计日志里 `Target.activateTarget`、`Page.bringToFront` 的调用次数为 0 | 四项全真 |
| A1.2 焦点不动 | L2（macOS） | 测试先把终端置前，`osascript` 每 200 ms 读一次最前应用；期间经 CLI 跑 20 条操作（新开标签导航、snapshot、click、fill、screenshot、关标签）；同时经扩展读 `chrome.tabs.query({active:true})` | 最前应用始终是终端；Chrome 活动标签 id 不变 |
| A1.3 信息栏 | L3 | 人看启动后的窗口 | 无任何授权弹框；记录出现了哪些信息栏（是否有「正在被调试」类提示由 spike 1 实测） |
| A1.4 一天 soak | L3 | `tabcap soak --hours 8 --every 60s`，记 attach / detach / 错误 | 弹框 0 次、非预期 detach 0 次、焦点被抢 0 次（人记） |

A1 的「连续一天」只能人确认；自动化部分保证机制正确。

### A2 「跨页流程，正文都在，包括跳转前的请求」

| 测试 | 层 | 场景 | 通过 |
|---|---|---|---|
| A2.1 跳转竞态 | L2 | s02 | 日志里每条 xhr / fetch / document 在包里都有 `request`，且 `bodySha256` 相等；例外只允许 `expected.exceptions`（`/api/slow` 可为 `failed-canceled`）；漏取率打印出来，目标 0 |
| A2.2 SPA 纪元 | L2 | s03 | `nav` 序列与 expected 相等；每个请求的 `nav` 指向正确纪元 |
| A2.3 缺正文有原因 | L2 | s13 | `redirect` / `not-modified` / `no-content` 各至少一条；没有 `bodyMissing:null` 却无 `body` 的记录 |
| A2.4 大与二进制 | L2 | s12 | 5 MB 哈希相等；40 MB 为 `too-large`；PNG 字节相等且两次同 blob |
| A2.5 子目标 | L2（P1\*） | s08 / s09 / s10 | 各自 expected；失败标「待验」，并把 `chrome.debugger` 的原话写进报告 |
| A2.6 未收尾 | L2 | s02 在 `slow` 未回时 `session stop` | 存在 `outcome:"incomplete"` 的记录，`reason:"stopped"` |
| A2.7 AI 探路 | L2 | AI 经 CLI 用 secret 登录 s07，再走 s02 | 同 A2.1；`actor` 全为 `ai`；凭据不泄漏检查通过 |
| A2.8 人介入 | L3 | s15：AI 撞上验证框停下，人点，AI 继续 | 终端有原因说明与截图路径；继续后请求齐全（P1 最小交接） |
| A2.9 输出替换 | L2 | s07 填完密码后 `evaluate` 读密码框 `value`，再 `snapshot` | 两者输出里只有 `<secret:range-demo.password>`，没有明文 |

oracle：靶场日志。比对键 = `method + url(去掉 run 参数) + bodySha256`。

### A3 「`find` 命中，含 gzip / br / base64，搜不到提示可能加密」

| 测试 | 层 | 输入 | 通过 |
|---|---|---|---|
| A3.1 十二通道 | L0（夹具包）+ L2（现录） | s04 目标文字 | 12 条全命中，解码链与 expected 相等 |
| A3.2 HAR 导入 | L0 | `fixtures/har/s04-devtools.har`、`s04-gzip-raw.har` 导入后 `find` | 命中集合与 A3.1 相同（导入的 b / c 解码链为 `["gzip"]` / `["br"]`） |
| A3.3 阴性对照 | L0 | 不存在的文字 | 0 命中；输出含「搜了 N 个正文、跳过 M 个（原因）」；**无**加密提示 |
| A3.4 加密提示 | L0 + L2 | s05 目标文字 | 0 命中；`hints.suspectEncrypted` 含 `/api/secret`，不含 `/api/key` |
| A3.5 WebSocket | L2 | s11 目标文字 | 命中 `ws` 帧 |
| A3.6 主文档 | L0 | s01 页面标题文字 | 命中 `type:"document"` 的请求 |

oracle：各场景 `expected.json`。`find` 输出形状本身也冻结成快照测试（`--json`），改形状要改快照并说明。

### A4 「同一流程录两次，`diff` 分出常量 / 会话值 / 时间戳 / 变化值」

| 测试 | 层 | 做法 | 通过 |
|---|---|---|---|
| A4.1 同 session 两次 | L2 | s06 录两次（q、page 不同），`tabcap analyze diff b1 b2` | 常量 `client, v, x-client-build`；时间戳 `t`；变化 `q, page, nonce, sig`；`sid` 此时标「常量或会话值（需跨 session 样本）」 |
| A4.2 跨 session 第三次 | L2 | 只清靶场源 cookie，再录一次，三包 diff | `sid` → 会话值 |
| A4.3 夹具版 | L0 | `fixtures/bundles/s06-run{1,2,3}` | 与 A4.1 / A4.2 相同 |
| A4.4 位置覆盖 | L0 | 合成包：参数分别在 query、JSON body、form body、header、cookie | 每个位置都被分类 |

oracle：s06 `expected.json` 的分类表。输出形状冻结成快照。

### A5 「靶场阶段 1 场景一条命令全跑」

| 测试 | 通过 |
|---|---|
| `bun run verify` | 打印矩阵；P1 全绿；P1\* 列「待验」及原因；总时长 < 4 min；退出码 0 |
| 幂等 | 连跑两次结果相同；第二次不残留上一次的标签（`close_session` 后靶场标签为 0） |

### A6 「撞上验证页停下交人；登录只试一次」（`03` §7 第 6 条）

| 测试 | 层 | 场景 | 通过 |
|---|---|---|---|
| A6.1 验证页停下 | L2 | s15 | 第 6 次请求得 403 后，CLI 返回 `state:"waiting"`、`reason:"verify-page"`、截图路径；之后 10 秒 journal 无新增；`tabcap handoff continue` 后 `/api/verified` 与后续请求在包里 |
| A6.2 登录限次 | L2 | s07 | 同一会话第二次对登录表单 `fill --secret` 返回 `guard.login-limit`，journal 无新增；带 `--confirm` 才放行 |
| A6.3 提示可执行 | L2 | s15 | `waiting` 的 JSON 里 `next` 写明「complete the verification in the browser, then run `tabcap handoff continue`」（0.4 改为英文，作者定）；扩展角标同时变色（人工核对） |
| A6.4 人点完继续 | L3 | s15 | 人在浏览器点「我是人」，AI 继续，请求齐全 |

oracle：靶场日志与 s15 / s07 的 `expected.json`。

### A7 「输入保真」（作者定 10-15；提案 `docs/10` §7，按作者决定修订；0.3-E 落地）

作者决定：默认 `click` 仍是 DOM 点击（标「incomplete event sequence」），`--trusted` 打开整套可信输入（移动路径、按下抬起间隔、逐键打字）；`type --delay` 默认 0；散布默认关；不暴露随机种子；不要求与 Playwright 严格同形，形状以本地探针 oracle 为准（D7）。场景 `05` s46，oracle 是 `fixtures/probe/oracle/` 的 Playwright 导出。L2 在 `test/e2e/v03e.e2e.test.ts`，L0 在 `test/unit/input-fidelity.test.ts` 与 `test/unit/eventshape.test.ts`。

| 测试 | 层 | 做法 | 通过 |
|---|---|---|---|
| A7.1 可信点击形状 | L2 | s46，`tabcap click <ref> --trusted`，读页面报告 | pointerdown 前 pointermove ≥ 1 条，最后一条与 pointerdown、与页面量得的目标中心都差 ≤ 1 px；到 click 为止全部 `isTrusted`；落在目标上那一段折叠后的类型序列等于 Playwright `click` 导出；pointerdown / pointerup / click 的按钮、`pressure`、`pointerType` 等字段等于导出值 |
| A7.2 路径参数 | L0 | 纯函数 `planClick(from, to, rng)` 用固定种子跑 1000 次 | 点率 ≥ 25/s、至少 3 点；时长 ∈ [100, 400] ms；终点精确；不开散布时全部点在直线上，开散布时中间点偏离直线 ≤ 0.4 px；按压间隔 ∈ [50, 140] ms；同种子同结果 |
| A7.3 隐藏标签不挂起 | L2 + L0 | L2：`navigate --new-tab` 开后台标签（`visibilityState:"hidden"`）后立即 `click --trusted`；L0：假 CDP 让 rAF 永不回调 / 页面一直 hidden | L2：命令在超时内返回，送达（完整形状）或标 `degraded:"not-painted"`，之后页面回到 hidden；L0：一条 `Input.dispatchMouseEvent` 都没发，改走 DOM 点击，仿真关闭 |
| A7.4 DOM 点击标记 | L2 | s46，默认 `click`；以及 A7.3 的降级 | `level:1`、`eventShape:"incomplete"`、警告含「incomplete event sequence」；页面报告只有 1 个不可信 click，与 Playwright `js_click` 导出同 |
| A7.5 逐键输入 | L2 | `click --trusted` 字段 → `type "aB3 中" --trusted`；另跑 `--insert` 与默认 `type` | 从第一个 keydown 起逐字段等于 Playwright `type` 导出（除 `seq` / `timeStamp` / `dt` / `screenX` / `screenY`）；`--insert` 与默认等于 Playwright `fill` 导出并标残缺；`--trusted --insert`、无 `--trusted` 的 `--delay` 报 `usage` |
| A7.6 逐字段 diff 报告 | L2 | 测试把 tabcap 与 Playwright 导出逐事件、逐字段比对，打印到测试输出 | 结构字段按 A7.1 / A7.5 断言；节奏字段（timeStamp、move 条数、路径时长、按压间隔、`movementX/Y`）只列出，不断言相等；`screenX/Y` 剔除 |
| A7.7 不重试 | L0 | 假 CDP：第 2 条 `mouseMoved` 超时；探针未送达 | `move-timeout`：只发了 2 条 move，没有按下，不再发；`not-delivered`：按下、抬起各 1 次，`next` 写明 tabcap 没有重试 |
| A7.8 不回退 | L0 + L2 | 全量 `bun test test/unit` 与 `bun run test:e2e` | 全绿；默认点击未变，既有用例不需改成别的路径 |
| A7.9 真人节奏 oracle | L3 | 作者在 s46 页面手点 10 次、手打一次 `aB3 中`，导出提交为 `fixtures/probe/oracle/human-*.json` | 作者确认；`07` §1.1 的时长、点率、按压间隔范围与 `type --delay` 的下限按它复核【人确认，待作者】 |
| A7.10 秘密值不进日志 | L2 | s07 登录页，`type --trusted` 逐键打用户名和密码后登录 | 守护进程日志、全部 CLI 输出、证据包（登录 POST 那条请求事件与其 raw 行除外）grep 不到密码明文，按顺序拼接所有单字符 JSON 字符串也拼不出密码 |

oracle：s46 页面的事件报告、`fixtures/probe/oracle/` 的 Playwright 导出；A7.9 要作者的手工导出。

## 4. 端到端夹具与前置（一次性，人做）

1. `tabcap setup`：下载 Chrome for Testing 到缓存目录、建 profile、UI 扩展随启动参数自动装。不需要进 `chrome://extensions`。
2. `tabcap daemon start` 并 `tabcap browser start`，确认 `/status` 看到 `transport:"direct"` 和浏览器版本。
3. `tabcap range serve` 起靶场；`tabcap range selftest` 绿。
4. 用 DevTools 对 s04 导出一次 HAR 放进 `fixtures/har/s04-devtools.har`。
5. `tabcap site add range-demo --url http://127.0.0.1:4310/s07 --user demo --password-stdin` 把靶场假账号录进本地库；库文件不进仓库。
6. L2 每个场景的流程：`range reset(run)` → `session start --name range-sNN` → 按 `expected.steps` 经 CLI 操作（新后台标签）→ `session stop` → 读包 → 比对 → `close_session`。

## 5. 不在阶段 1 测的

`handoff` 的协议化状态机、浏览器侧提示与人接管识别，`guard`、`replay`、`deps`、`trace`、MCP、Firefox；s16 只写场景不验收。P1 只保留「AI 停下 + 终端说明 + 截图」这一档最小交接和「登录限次 + 验证页停下」这一档最小 guard（A2.8、A6）。人接管识别（`03` §10 第 2 条）是 P2 的第一个实验。

## 6. 先做的两个 spike（写代码前的最小实验，各半天以内）

这两件事决定 `04` §5.2 的取法和 `05` 的 P1\* 能不能升 P1，建议作为第一格，比写守护进程更早：

1. **专属浏览器直连**：下载 Chrome for Testing（mac-arm64），带独立 `--user-data-dir`、`--remote-debugging-port=0` 启动，从 `DevToolsActivePort` 读端口，直连 CDP。验证四件事，10-15 已全部【实测】完成，结论在 `07` §1.1：唯一的弹框是 macOS 钥匙串提示，`--use-mock-keychain` 消除；`--load-extension` 生效；弹窗 / 跨源 iframe / Service Worker 都能自动挂上，弹窗要求对每个会话发 `Runtime.runIfWaitingForDebugger`；`--remote-debugging-pipe` 可用。附带发现：Chrome 自身会外连 Google（GCM），后台标签收不到 CDP 输入。原来的 `chrome.debugger` 自动挂接实验推到阶段 2 做 `ext` 时再做。
2. **跳转竞态**：已【实测】，结论在 `04` §5.2 第 8 条：急取对 finished 的请求 0 漏；点击处理器里发出再立刻跳转的请求 Network 路径 100% 丢，且不发 `loadingFailed`；Fetch 拦截 100% 救回，每请求 +1.5–2 ms。

3. **spike 1g 后台标签输入**：已【实测】，结论在 `07` §1.1「后台标签与焦点阶梯」：焦点仿真 + CDP 输入在后台标签里可信且不抢前台，代价是页面变 visible 并全速渲染；`el.focus()` + `Input.insertText` 不需仿真；`bringToFront` 和 Chrome 启动本身都会抢 macOS 前台。

三个 spike 的代码不进主仓库，结果写进 NOTES 和 `04`、`07` 的对应条目。
