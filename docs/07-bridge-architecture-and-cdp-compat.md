# bridge 架构与 CDP 兼容中继（草案，待审）

2026-10-15。回答 `03` §8 第 4 条「中继是否兼容标准 CDP」，并定下扩展与守护进程的职责划分。参照：Playwright MCP Bridge 的 `cdpRelay.ts`（Apache-2.0，可抄）、DrissionPage（自定义非商业许可，**只借思路不抄代码**）、一款闭源扩展式工具（私有笔记，只借思路）。

标注：【实测】跑过或读过源码；【推断】间接推出；【待验】没验证。

## 1. 薄扩展、厚守护进程

两条传输层，同一个接口（10-15 第五轮定，`direct` 默认且先做）：

- **`direct`**：`setup` 下载 Chrome for Testing，独立 `--user-data-dir`，优先 `--remote-debugging-pipe`（【实测 10-15】Bun 下经 `node:child_process` 的 5 项 stdio 可用，`Browser.getVersion` 经管道返回；`--remote-debugging-port=0` 作备选），守护进程直连 Chrome 自己的 CDP 端点。`Target.setAutoAttach` 原生可用【实测：OOPIF、Service Worker】。扩展只剩人那一面的 UI，由 `--load-extension` 自动装【实测：Chrome for Testing 155 认这个参数】。
- **`ext`**（阶段 2）：接管用户自己的 Chrome，Chrome 137+ 品牌版不认 `--load-extension`【实测：Chromium Extensions 公告】，扩展从 Chrome Web Store 装；扩展同时充当 CDP 管道。下表是 `ext` 模式下扩展的职责。

守护进程里的一切（会话、焦点阶梯、对话框锁、录制器、分析、兼容端点）与传输层无关。

| 谁 | 只做这些 |
|---|---|
| 扩展（MV3 service worker） | 按标签 `chrome.debugger.attach/detach`；`sendCommand` 与 `onEvent` 原样转发，带 `sessionId`（Chrome 125 起 `DebuggerSession.sessionId`【推断，待验：spike 1】）；子目标自动挂接（`Target.setAutoAttach`，flatten）；`chrome.tabs` / `tabGroups` / favicon 角标 / 横条等「只有扩展能做」的事；期望状态同步（`storage` + `alarms`，私有笔记）；P2 的人工操作录制 content script |
| 守护进程（Bun） | 会话与 owned / borrowed；焦点阶梯；对话框页锁；每标签队列与命令级超时；录制器（所有 CDP 事件都经过这里 → 证据包）；分析；CLI / HTTP / skill；secrets；guard；handoff；**CDP 兼容端点** |

为什么薄扩展：未打包扩展每次改都要去 `chrome://extensions` 重载，守护进程只是个进程；所有 CDP 事件只经过一处，录制器和分析在同一进程；兼容端点几乎免费（§2）；与 Playwright 的做法一致，可直接抄。代价是每条命令多一跳本机 WebSocket【推断：亚毫秒】。

### 1.1 `direct` 模式的启动与挂接协议（10-15 spike 1，Chrome for Testing 155，全部【实测】除非另注）

启动参数：
- `--user-data-dir=<profile>`、`--remote-debugging-pipe`（备选 `--remote-debugging-port=0` + 读 `DevToolsActivePort`）、`--load-extension=<ui ext>`（只在有 UI 扩展时传：`TABCAP_EXTENSION_DIR`，或源码根目录的 `extension/` 里有 `manifest.json`，见 `src/daemon/tools/browser.ts`；仓库里目前没有扩展，所以实际不传，见下文）、`--no-first-run`、`--no-default-browser-check`。
- macOS 固定加 **`--use-mock-keychain`**。否则每次启动都会弹 macOS 钥匙串对话框「Chrome for Testing 想要使用 Chromium Safe Storage」，在人点掉之前第一次导航一个请求都发不出去（实测卡 17.5 s，正好是弹窗到点击的间隔）；点「始终允许」也靠不住，CfT 是 ad-hoc 签名，ACL 绑代码哈希，换版本大概率再弹【推断】。代价：profile 里的 cookie 用固定密钥加密，保护退到文件权限，与 `store` 的定位一致。
- **`--disable-features=…,PreconnectToSearch`**（0.4-D 起所有模式都加）【实测 spike 10-16，netlog】：带自己代理的 browser context 每次新开标签 / 每次导航都经该 context 的代理发 `CONNECT www.google.com:443`（对默认搜索引擎的 preconnect，与扩展无关）；单独关 `PreconnectToSearch` 就消失，关 `SearchEnginePreconnector` / `SearchEnginePreconnector2` / `LoadingPredictorUseOptimizationGuide` / `NavigationPredictor` 都无效。【实测 0.4-D e2e】加上之后两个池代理的日志里 CONNECT 为 0。
- Chrome 自己会向 Google 发 GCM 注册请求，`--disable-background-networking` 挡不住，并且会走系统代理。端到端测试要用黑洞代理 `--proxy-server=127.0.0.1:1 --proxy-bypass-list="127.0.0.1;localhost"` 把外连全部截断【待验】；生产模式要不要跟随系统代理是作者的决定（见 §4 第 6 条）。

管道断开与 browser context（spike 10-16，CfT 155）：
- 【实测】管道（写端）一断，500 ms 内**所有**标签都被关（默认 context 的、`disposeOnDetach:false` 的 context 的都算），Chrome 进程**不退出**（观察 20 s）。所以池账号 context 的 cookie 必须在管道还通时取（`Storage.getCookies {browserContextId}`）；`Target.disposeBrowserContext` 之后 cookie 也取不到了。守护进程停浏览器前先回写（0.4-D）。
- 【实测】以后 UI 扩展要在新建的 context 里运行，不能用 `--load-extension`（新 context 里没有 content script），要在启动后发 `Extensions.loadUnpacked {path, enableInIncognito:true}`：之后默认 context、之后新建的和之前已建好的 context 里都运行。仓库里目前没有扩展。

挂接协议：
- 浏览器级 `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}`；每收到 `Target.attachedToTarget`，先 `Runtime.enable`、`Page.enable`（录制时再 `Network.enable`），然后**必须**发 `Runtime.runIfWaitingForDebugger`。
- 原因：Chrome 155 即使 `waitForDebuggerOnStart:false`，`window.open` 开出的弹窗仍被挂起直到收到 `runIfWaitingForDebugger`，而且 attach 事件里报的 `waitingForDebugger:false` 是假的，不能信这个字段。不发，opener 的 `window.open` 调用永远不返回（evaluate 超时），弹窗停在 `about:blank`。
- 子目标（OOPIF、Service Worker、弹窗）都经此挂上；跨站 iframe 和 SW 的 Network 事件落在各自子会话。
- 【实测 10-16 spike「页面脚本读了哪些信号」】`Target.setAutoAttach {waitForDebuggerOnStart:true}` 之后用 `Target.createTarget {url}` 直接带 URL 开的新标签，attach 事件报 `waitingForDebugger:true`，但页面脚本在我们发 `runIfWaitingForDebugger` 之前就已执行（`DOMContentLoaded` 早于 `Debugger.enable` 返回）。要在第一行脚本前装东西，先开 `about:blank` 再 `Page.navigate`（tabcap 的 `createTab` 就是这样）；OOPIF 和 Worker 在等待调试器时确实停着。

追踪模式（0.4-F，Debugger 断点，只读）：
- 【实测 spike】`Debugger.paused` 的 `callFrames[].url` 在 CfT 155 上是空串（字段已废弃）；脚本 URL 要用 `callFrames[].location.scriptId` 去查 `Debugger.scriptParsed` 的 `url`。
- 【实测 spike，0.4-F e2e 复测】装断点用 `EventBreakpoints.setInstrumentationBreakpoint {eventName:"scriptFirstStatement"}`：它的暂停（`reason:"EventListener"`，`data.eventName:"instrumentation:scriptFirstStatement"`）里命令照常响应，`Debugger.evaluateOnCallFrame` 取各 API 的 getter / 函数，再 `Debugger.setBreakpointOnFunctionCall`，然后 resume；新文档（顶层、同源 iframe、OOPIF）的第一条语句前就装好，页面零注入。不要用 `Debugger.setInstrumentationBreakpoint beforeScriptExecution`：它的暂停里除 resume 外的命令都卡到 resume 之后。Worker 在等待调试器时 `Runtime.evaluate` 取 `WorkerNavigator.prototype.*` 并装好再放行。
- isolated world 里读 Blink 的 getter（如 `navigator.userAgent`）不会命中主世界的断点【实测 spike】；但在 isolated world 里读 `new Date().getTimezoneOffset()` 的值后，表里多出一条脚本 URL 为空的 `Date.prototype.getTimezoneOffset` 读取，丢弃栈里有 isolated world 脚本或追踪自身求值脚本的暂停后消失【实测 0.4-F e2e】。原因是 V8 内建函数的断点跨上下文共享【推断】。

观察模式 sink 断点（0.6-L / 0.6-L2，spike-06l exp1–exp5 + spike-06l2 E1–E10 + e2e v06l，CfT 155）：
- 【实测 exp4】`Debugger.setBreakpointOnFunctionCall` 的暂停里 `data:null`、没有被调函数的帧（栈里只有 caller，`arguments` 是 caller 自己的）：**暂停里读不到被调实参**。0.6-L2 的明文主通道是 condition 里的 log-point（下面一条），作用域 walk 只做密文归属和守卫失败时的回退。
- 【实测 spike-06l2 E6 / E7】condition 里的 `arguments` 是被调方的。`console.dirxml(nonce, arguments[0])` 在同一次 parse 的 `Debugger.paused` 之前到达 `Runtime.consoleAPICalled`（严格有序）。页面把 `console.dirxml` 换成匿名函数时 `name !== "dirxml"`，守卫失败、condition 退成普通暂停，**不调用页面函数**。20 MiB 实参经 log-point 完整到达（约 0.3 s）。
- 【实测 spike-06l2】页面侧 500 次 1 KB `JSON.parse`：不设断点 0.2 ms；只有 length condition 9 ms；log-point 26 ms；暂停后立即恢复（不含 walk）107 ms。表格密集或 WebSocket 高频 parse 的页面会明显变慢，也改变时序——诊断可接受，录完就关。
- 【实测 v06l e2e】JS 内建函数的断点**跨 realm 不共享**：装在 about:blank realm 的 `JSON.parse` 断点拦不住新文档 realm 的调用（与上面「跨上下文共享」相对——共享只发生在同一个 V8 context 的多个 world 之间）；所以每个 realm 都要在自己的 `scriptFirstStatement` 暂停里装（0.4-F 的安装通道），同进程重复装报 "already exists"、容忍。
- 【实测 exp2】断点开销由 condition 兜底：heavy 页 2000 次短 `JSON.parse`，无 condition 中位 +837 ms，带 `length >= 32` condition 中位 +15 ms；s59 整页加载到 12 行（一次解密），unarmed 中位 11.5 ms、armed（带 condition、无 walk）约 19–21 ms；walk 本身（4 帧×每 scope `getProperties` ≈ 一打 CDP 往返）在 0.6-L2 有 log-point 明文时不再复制字节缓冲，只哈希作用域字符串。
- 【实测 v06l e2e】页面可以在一个微任务串里跑完 fetch→解密→`JSON.parse`，而 arm 由录制 index 推送驱动、晚几毫秒：观察模式把这种情况 walk 的结果先暂存 10 s（≤8 个），arm 一到补判。arm 也可能落在一次 walk 的 CDP 往返之间，所以「当时有无嫌疑」要在 walk 之后读（0.6-L2 第二轮修正；读在之前时同一守护进程连跑 8 个变体有 2 个零行【实测】）。
- 【实测 v06l e2e，0.6-L2 第二轮】暂停帧的 scope 链能看到外层函数里被内层闭包引用的变量：s59 worker 的 `onmessage` 箭头函数暂停时，`Runtime.getProperties` 在它的 closure scope 里读到 `s59Worker` 的参数 `data`（Promise executor 用了它，所以它在 context 里）；`Object` 类的局部对象往下读一层能拿到 `env.data`。只在栈上、没被闭包引用的变量不会出现在内层函数的 scope 链里——s59 deferred 的定时器回调就够不着密文。

帧与帧路径 ref（0.4-I，spike 10-16 无头 CfT 155 + e2e v04i 有头后台标签，docs/05 s22）：
- 【实测 spike】标签会话的 `Page.getFrameTree` 只列根帧和同进程的子帧（`frameset` 的 `frame`、同源 iframe）；OOPIF 不在里面（`main` 的 `childFrames` 为空）。每个 OOPIF 是自动挂上的 `iframe` 目标，它会话里的 `Page.getFrameTree` 从它自己开始，`parentId` 是装它的那个帧，下面列它同进程的后代（s22 的 `/s22/table`）。
- 【实测 spike】`Accessibility.getFullAXTree` 不带 `frameId` 只给根帧，iframe 是没有子节点的 `Iframe` 节点；带 `frameId`、发到拥有该帧文档的会话上，给那个帧的树（同进程子帧走标签会话；OOPIF 里的同进程帧走 OOPIF 会话）。
- 【实测 spike】`iframe` / `frame` 元素的 `DOM.describeNode` 带 `frameId`（OOPIF 也有，只是没有 `contentDocument`）；`DOM.getFrameOwner {frameId}` 发到父帧的会话上给出所有者元素。帧编号按父文档里 `iframe, frame` 的文档顺序取（tabcap 在隔离世界里 `querySelectorAll`）。
- 【实测 spike】backendNodeId 只在一个渲染进程内唯一：OOPIF 里一个格子的 backendNodeId 拿到标签会话上 `DOM.resolveNode`，解析成了根文档里另一个节点（`<title>`）。所以帧 ref 绑定它的会话、frameId 与 loaderId，帧导航后 ref 失效。
- 【实测 spike】`DOM.getBoxModel` 的坐标属于发命令那个会话的本地根视口：同进程帧经标签会话量出来已经是顶层坐标（`main` 里的 `h1` x=332 = `frame` 内容盒 324 + 页边距 8）；OOPIF 会话量的是 OOPIF 自己的视口，要加所有者元素内容盒左上角（s22 窗口 1280 宽：`iframe#search` 334, 79.5）；OOPIF 里的同进程帧（`/s22/table`）也在 OOPIF 的空间里（格子 21, 88，表格 iframe 所有者 10, 51）。
- 【实测 spike + e2e】`Input.dispatchMouseEvent` 发到**标签会话**、用平移后的顶层坐标，可信的 pointermove / pointerdown / pointerup / click 落到 OOPIF 里的按钮上；页面自己记的 `clientX/Y` 与它自己的 `getBoundingClientRect` 中心差 ≤ 1 px（e2e v04i：`click --trusted` 进 `f2/f1`，`hover` 进 OOPIF 里的同进程帧 `f2/f1/f1`）。发到 OOPIF 会话上的 `Input.dispatchMouseEvent` 也返回成功，tabcap 不用它。
- 【实测 spike + e2e】OOPIF 里的输入框 `focus()` 之后（标签会话开焦点仿真），标签会话上的 `Input.insertText` 与 `Input.dispatchKeyEvent` 都进了这个输入框；所以 `fill --trusted`、`type`、`press-key` 照旧走标签会话。焦点在跨源帧里时，标签会话的 `document.activeElement` 是那个 `iframe`（`contentDocument` 为 null），`type` 顺着 frameId 到该帧会话里再看焦点元素是不是密码框。
- 【实测 spike】`frameset` 文档没有 `body`（`document.body` 是 `FRAMESET`），它的无障碍树只有 RootWebArea 加两个 `Iframe` 叶子；`frame` 与 iframe 一样有自己的帧、自己的树。
- 【推断】平移只加所有者内容盒的左上角，iframe 上的 CSS transform / 缩放没有算进去；【待验】OOPIF 里点按钮打开文件选择框时 `Page.fileChooserOpened` 落在哪个会话（`upload` 对帧 ref 在该帧会话上拦截），`DOM.setFileInputFiles` 发到 OOPIF 会话没有量过。

「页面就绪」的判定：
- 不能只等 `Page.frameNavigated`（新建目标的首次导航经常收不到）或 `Page.loadEventFired`（可能在 `Page.enable` 之前就触发而丢失）。
- 等主文档的 `Runtime.executionContextCreated`（`isDefault` 且 `origin` 等于目标 URL 的 origin；`Runtime.enable` 会补发已有的 context），再 evaluate 一次 `location.href` 与 `document.readyState` 作最终确认。同标签内的 `Page.navigate` 事件完整，用它返回的 `loaderId` 对应。
- 去掉钥匙串因素后，首次导航在 100 ms 内；`background:true/false`、是否 auto-attach 都不影响导航耗时。

后台标签与焦点阶梯（10-15 spike 1g，全部【实测】，每步独立新标签）：
- `background:true` 的标签基线：`hidden`、`hasFocus:false`、定时器 1 Hz、rAF 0。没开焦点仿真时 CDP 鼠标事件不生效，而且对从未绘制过的隐藏标签发 `Input.dispatchMouseEvent {type:"mouseMoved"}` **永远不返回**，每条命令必须带超时。`Page.startScreencast` 不能替代仿真，隐藏标签 3 s 内 0 帧。
- **第一级**：`Runtime.evaluate` 调 `el.click()`。不抢焦点、不改可见性，但只触发 `click`、`isTrusted:false`、没有 pointer 事件；带 `userGesture:true` 可让 `userActivation.isActive` 为 true。填表用 `el.focus()` + `Input.insertText` 不需要仿真即可（`beforeinput` / `input` 可信）；`Input.dispatchKeyEvent` 必须开仿真。
- **第二级**：`Emulation.setFocusEmulationEnabled {enabled:true}`，然后 CDP `Input.*`。`hasFocus` 变 true，点击的 pointerdown / mousedown / pointerup / mouseup / click 全部 `isTrusted:true`，按键可用；macOS 前台应用不变、标签不被激活、窗口不动。代价：页面变成 `visible`，定时器 10 Hz、rAF 120 Hz 全速跑，页面能察觉 `visibilitychange`。做完立即关闭；关闭后 `hasFocus` 不回落。
- **第三级**：`Page.bringToFront` 会把 Chrome 抢到 macOS 前台并激活标签，只在人要接手时用。
- 以上三级作为焦点阶梯采纳（10-15 作者定），接受第二级让页面短暂变 visible 的代价；`Target.activateTarget` 与 `Page.bringToFront` 在 AI 命令路径上一律改写成第二级。唯一例外：显式 `tab select --bring-to-front`（第三级，输出标明）。
- 启动本身会抢前台：Chrome 进程起来时 macOS 前台从终端变成 Chrome。【实测 格 3】加 `--no-startup-window` 后启动和第一次 `createTarget` 开窗都不抢前台，已设为默认；`osascript activate` 归还作兜底（单次可能失败，最多重试 4 次）。守护进程被 SIGKILL 时管道断开，Chrome 自行退出。隐藏标签截图靠 `CDPScreenshotNewSurface` 直接非空白，不需要焦点仿真【实测】。
- 前台交还按 **bundle identifier** 激活（`tell application id "<bundleId>" to activate`），没有 bundle id 才退回应用名：System Events 的进程名可能和应用名不同（Firefox Developer Edition 的进程名是 `firefox`，`tell application "firefox" to activate` 报 -1728，交还永远不成功）。【实测 2026-10-17，作者的 Mac，前台是 Firefox Developer Edition 时 v02d s17 失败；修复后在 Firefox Developer Edition 前台下的复测【待验】】一次 osascript 同时读进程名、bundle id、unix id；端到端的前台断言按 pid 比（`browser status` 的 `pid`），不按名字，免得并行的另一个 Chrome for Testing 干扰。
- 此结果同时回答了私有笔记里的待验项「焦点模拟是否让 `document.hasFocus()` 变真」：是。
- 弹窗拦截的识别：`userGesture:false` 时 `window.open` 返回 null、不建目标，但 host 会收到 `Page.windowOpen {userGesture:false}`，守护进程可据此报「弹窗被拦截」并给下一步。
- **可信点击（作者定 10-15；提案 `docs/10`，0.3-E）**：默认 `click` 仍是第一级 DOM 点击，输出 `eventShape:"incomplete"` 与「incomplete event sequence」警告。`click --trusted` = 第二级：焦点仿真 → 滚入视口 → **rAF 绘制确认**（页面里 `requestAnimationFrame` 在 1 s 内回调且 `visibilityState` 为 `visible`）→ 终点遮挡检查 → `mouseMoved` 路径（起点是本标签上次可信鼠标事件的位置，新标签或新文档为 0,0；直线 + minimum-jerk，时长 100–400 ms 均匀随机，约 60 点/秒、至少 3 点，终点精确等于目标；±0.4 px 散布默认关；`button:"none"`、`buttons:0`；每条单独 1 s 超时）→ `mousePressed {button:"left", buttons:1, clickCount:1, force:0.5}` → 50–140 ms → `mouseReleased`。pointer / mouse 两族事件全部由 Chrome 合成，不手写 DOM 事件。确认不了已绘制时绝不发 `mouseMoved`（spike 1g：未绘制的隐藏标签上永不返回），降到第一级并标 `degraded:"not-painted"`。某条 move 超时报 `move-timeout`，不按下、不重试；任何失败都不自动重试。随机数可注入（测试用固定种子），CLI 不暴露种子。【实测 10-15，CfT 155：`force:0.5` 让 pointerdown 的 `pressure` 为 0.5，与 Playwright 导出一致；`navigate --new-tab` 开出的后台标签（点击前 `visibilityState:"hidden"`；是否从未绘制过属【推断】），开仿真后 rAF 按时回调、按下时 `visibilityState:"visible"`、`hasFocus:true`，走完整路径约 0.85 s，命令结束后回到 hidden。降级路径目前只由假 CDP 覆盖（L0），真实浏览器里还没遇到过确认不了绘制的标签】
- **逐键输入（作者定 10-15）**：默认 `type` 与 `--insert` 仍是一次 `Input.insertText`，输出 `eventShape:"insert"` 与「incomplete event sequence」警告。`type --trusted`：US 布局里有键位的字符逐个 `Input.dispatchKeyEvent`（`keyDown` 带 `text` / `unmodifiedText`、`modifiers:0` → `keyUp`），由 Chrome 合成 keydown / keypress / beforeinput / textInput / input / keyup；没有键位的字符（中文、emoji、`\t`）逐字 `Input.insertText`；`--delay <ms>` 是两个字符之间的间隔，默认 0。要开焦点仿真。【实测 10-15：s46 上 `type --trusted "aB3 中"` 与 Playwright `type()` 导出逐字段相同（大写不发 Shift，`shiftKey:false`）】真人节奏的下限等作者的 L3 导出（`06` A7.9）再定。
- **Linux 后台标签的帧（0.3-G 之后，修 CI 不稳）**：【实测 Chromium 155 linux-arm64 / Xvfb，容器内】后台标签开焦点仿真后 `visible`、rAF 起初 17 ms；一旦出过几帧有变化的画面（聚焦输入框、打字、动画），rAF 间隔变成 1017 ms，每条 `mouseMoved` 要等下一帧才回（约 0.6–1 s），可信点击撞上每条 1 s 的超时（`move-timeout`）。仿真关了再开、`setDeviceMetricsOverride` 都不恢复；一次 `Page.captureScreenshot` 恢复到下几帧变化为止（动画页上立刻又慢）；`Page.startScreencast` 期间稳定 17 ms（不 ack 帧也一样），停掉后几帧内又慢。前台标签不受影响。【推断】Aura 上后台标签的 surface 不在窗口的合成树里，没人绘制它的帧，viz 对「出帧却没被绘制」的客户端限到每秒 1 帧；macOS 每个视图有自己的合成器，所以本机 81/81。做法：rAF 绘制确认改为同时量 3 个帧间隔，任一超过 100 ms（或不来）算「帧慢」；`visible` 且帧慢时开一个 32×32、quality 1 的 screencast，再确认（10-20 起：最多 3 s 内每隔 250 ms 再查，直到某次全速；CI run 39398756001 上开 screencast 后紧接的一次 1 s 内没出帧，可信点击降成了 DOM 点击【实测】），全速则保持到松开之后再停，输出带 `paint: {raf, frameMs, visibility, held:"screencast"}`；screencast 也救不回来就停掉、照旧走（可能 `move-timeout`）。`hidden` 的标签不碰，照旧降级。
- **第一级的定位**：`el.click()` 是默认点击、也是 `--trusted` 确认不了绘制时的降级路径，输出必带 `eventShape:"incomplete"`。
- **点击落点（0.6-J，作者定 10-16；docs/04 §29）**：第一级与第二级之前都先只读地判定落点：目标或往上 3 层祖先有 click / mousedown / pointerdown / touchstart 监听器就点目标；否则后代（深度 ≤ 4、≤ 64 个）里恰好一个在监听或带框架标记就落到它上面（第一级对它 `el.click()`，第二级的指针终点是它的中心），好几个就照旧点目标并列出候选。【实测 spike 10-16，CfT 155】`DOMDebugger.getEventListeners` 只报 objectId 所属世界的监听器：隔离世界的对象对有主世界监听器的节点返回空表，所以监听器经主世界对象读（`DOM.resolveNode` 不带 context，不跑页面脚本），标记与文字在隔离世界里读；`depth: n` 够到往下 n − 1 层（往下 4 层的监听器要 `depth: 5`）。
- **人接管监听器（0.7.1-A，`04` §37）**：spike-071a（CfT 155.0.8059.79，macOS arm64，tabcap 自己的 `DirectTransport` + `Tabs.createTab` 开的后台标签，隔离世界里的监听器把 `pointerdown` / `pointermove` / `pointerup` / `mousedown` / `click` / `keydown` / `keyup` / `wheel` / `touchstart` / `focus` / `blur` / `scroll` / `input` / `beforeinput` 连同 `isTrusted` 都报回来，页面每 200 ms 合成一轮 `pointerdown` / `keydown` / `wheel` + `el.click()`）：
  - 【实测】`Runtime.addBinding {executionContextName:<世界名>}` 加 `Page.addScriptToEvaluateOnNewDocument {worldName, runImmediately:true}`：页面主世界里 `typeof window.<绑定名>` 加载时与之后都是 `"undefined"`；之后的文档（`Page.navigate`、`Page.reload`）和同源 iframe 里监听器都在（iframe 里的点击由 iframe 自己的监听器报）。
  - 【实测】页面自己合成的事件（`dispatchEvent(new PointerEvent / KeyboardEvent / WheelEvent)`、`el.click()`、带 `userGesture:true` 的 `Runtime.evaluate` 里的 `el.click()`）全部 `isTrusted:false`。
  - 【实测】tabcap 经 CDP 发的输入在隔离世界里全部 `isTrusted:true`：`Input.dispatchMouseEvent` 的按下 / 抬起给 `pointerdown` / `mousedown` / `pointerup` / `click`，`mouseMoved` 只给 `pointermove`，`mouseWheel` 给 `wheel` 与 `scroll`，`Input.dispatchKeyEvent` 给 `keydown` / `beforeinput` / `input` / `keyup`，`Input.insertText` 只给 `beforeinput` / `input`（没有 `keydown`）。所以排除 tabcap 自己的输入必须靠命令窗口，`isTrusted` 不够。
  - 【实测】到达时序（守护进程收到 `Runtime.bindingCalled` 的时刻减去最后一条 CDP 答复的时刻）：`pointerdown` −4 ms、`keydown` −3 ms（答复之前就到）；`wheel` +5 ms（`mouseWheel` 的答复比事件早回）。所以窗口在答复后再留 500 ms。
  - 【实测】`Emulation.setFocusEmulationEnabled` 开 / 关只给 `focus` / `blur`（可信），没有指针、按键、滚轮事件。`Page.bringToFront`（只有 `tab select --bring-to-front` 走得到）之后约 58 ms 来一条可信的 `pointermove`，没有 `pointerdown` / `keydown` / `wheel`；`Page.reload` 后也有一条可信 `pointermove`。只看 `pointermove` 的话这两处都会误报，所以监听器不看鼠标移动（人只移动鼠标也因此不算）。
  - 【实测】`el.focus()` / `window.scrollBy` 经 `Runtime.evaluate` 给可信的 `focus` / `blur` / `scroll`，不在监听的四种里。
  - 【实测 e2e v071a，实现用的世界名 `tabcap-takeover`】s62 上 tabcap 自己的 `click --trusted`、`click --trusted`（文本框）、`type --trusted ab`、`press-key Enter`、`hover` 都以可信事件到了页面（页面自己的记录是 `btn:true`、三条 `key:true`），会话仍是 `running`；页面同时合成了约 25 轮不可信事件，也不触发。测试专用注入（绕过窗口的一次 CDP 按下）在 3 s 内让会话进 `waiting`（`human-takeover`）；`handoff.detectTakeover:false` 时同一注入（按下与 Shift）不触发。第一版测试里，离第一次约 250 ms 的第二次注入按下没有报上来（包里没有它的 `action`，守护进程日志里也没有「忽略」），判断是页面侧 250 ms 合并吞掉的【推断】，按设计；隔 400 ms 后连跑 3 次都在。
  - 【待验】真人的 OS 输入：真鼠标、键盘、触控板的事件是否同样可信、时延多少；拖动视口滚动条与元素滚动条有没有 `pointerdown`；浏览器自动填充、密码管理器、输入法组合、Chrome 自己的快捷键（⌘L、⌘T）会不会在页面里出 `keydown`；页面自己的脚本有没有办法造出可信事件（规范上没有，未量）。跨进程 iframe（OOPIF）没装监听器，里面的输入不覆盖。
  - 【实测 2026-10-18，作者的 Mac，CfT 155，作者授权的真实使用而非测试】作者在 tabcap 自己的 CfT 窗口里登录 npmjs.com 配 trusted publisher 时，真鼠标点 Cloudflare 的验证框和 npm 的「Use security key」按钮都被监听器收到可信 `pointerdown`，会话随即 `waiting`（`reason: human-takeover`），后续 `navigate` 按设计拒绝，`handoff continue` 后恢复；驱动脚本因此要在人点过之后、下一次动页面之前先 `handoff continue`。键盘时延、滚动条、自动填充、输入法、Chrome 快捷键仍未量。

### 1.2 启动参数表（抄自 Playwright `chromiumSwitches.ts`，Apache-2.0，保留 NOTICE；10-15 作者定）

来源：`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`（main，2026-10-15 读取）。我们的取舍按用途分组；标「待验」的由 spike 1g / 实现时确认。

| 组 | 参数 | 取舍 |
|---|---|---|
| 压外连 | `--disable-background-networking` `--disable-component-update` `--disable-sync` `--metrics-recording-only` `--no-service-autorun` `--disable-field-trial-config` `--disable-client-side-phishing-detection` `--disable-breakpad` `--disable-default-apps` `--disable-component-extensions-with-background-pages` `--disable-features=OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,Translate,MediaRouter,DialMediaRouteProvider,GlobalMediaControls,LensOverlay,HttpsUpgrades` | 全部采用。spike 1 看到的 GCM 外连在这组之下是否消失【待验】 |
| 钥匙串 / 密码库 | `--use-mock-keychain`（macOS）`--password-store=basic`（Linux） | 采用，已定 |
| 后台标签不节流 | `--disable-background-timer-throttling` `--disable-renderer-backgrounding` `--disable-backgrounding-occluded-windows` | 采用。这是 spike 1g「隐藏标签定时器节流」的已知解法，和焦点模拟配合用 |
| 不打扰 | `--no-first-run` `--no-default-browser-check` `--disable-search-engine-choice-screen` `--disable-infobars`（隐藏 Chrome for Testing 自己的信息栏）`--disable-prompt-on-repost` `--disable-hang-monitor` `--disable-popup-blocking` | 采用。弹窗拦截关掉：登录弹窗是真实场景，`Page.windowOpen` 照样记录；要不要默认关【待定，倾向关】 |
| 录制相关 | `--disable-back-forward-cache`（bfcache 会让后退 / 前进不走网络、事件不完整）`--disable-features=PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose` `--enable-features=CDPScreenshotNewSurface`（隐藏标签截图）`--allow-pre-commit-input` `--disable-ipc-flooding-protection` `--force-color-profile=srgb` `--export-tagged-pdf` | 采用；`CDPScreenshotNewSurface` 对后台标签截图的效果【待验】 |
| 隐藏 webdriver | `--disable-blink-features=AutomationControlled` | 10-20 作者定：默认采用，`--webdriver visible` 时不传（`04` §40）。不在 Playwright 的表里 |
| 用户自定义 | `browser start --chrome-arg` / `--drop-chrome-arg`，`config.json` `chrome.args` / `chrome.dropArgs` | 10-21 作者定：只拒绝会让 tabcap 失灵的几项，逗号列表开关合并而不覆盖，实际命令行进回答与 manifest（`04` §42） |
| 不要 | `--disable-extensions`（我们要装 UI 扩展）`--unsafely-disable-devtools-self-xss-warnings` `--disable-stack-profiler`（Windows 专用）`--disable-dev-shm-usage`（Linux 容器）以及所有 `edge` / `ms` 前缀的 Edge 专用项 | 不采用 |

注意：不传 `--enable-automation`；【实测 10-15 探针页】只以 `--remote-debugging-pipe` 启动时 `navigator.webdriver` 仍为 true，Playwright 同样如此【推断：管道连接即视为自动化】。【实测 10-20，CfT 155.0.8059.84】加上 `--disable-blink-features=AutomationControlled` 后，pipe 与 port 两种连接下主文档与 iframe 里都是 false，视口高度与不加时相同（727 / 814），没有多出信息栏；专用 worker 里 `navigator.webdriver` 加不加都是 `undefined`（`WorkerNavigator` 没有这个属性）。参数表以代码里的常量为准，本表只是取舍记录。

扩展 ↔ 守护进程的信封（回环、单控制者、来源校验，沿用私有笔记）：

```
→ {"id":1,"type":"cdp","tab":1234,"sessionId":null,"method":"Network.enable","params":{…}}
← {"id":1,"result":{…}} | {"id":1,"error":{"message":"…"}}
← {"type":"event","tab":1234,"sessionId":"…","method":"Network.loadingFinished","params":{…}}
→ {"id":2,"type":"tabs","op":"create"|"close"|"group"|"query"|"mark","args":{…}}
→ {"id":3,"type":"attach"|"detach","tab":1234}
← {"type":"tab-event","event":"created"|"removed"|"replaced"|"detached","tab":1234,"detail":{…}}
```

## 2. CDP 兼容端点：外部工具要什么

### 2.1 DrissionPage 实际用到的（【实测】读 master 源码，2026-10-15）

- 探活：`GET /json/version`，只看有没有 `webSocketDebuggerUrl`；`Chromium.__init__` 要求它以 `browser` 结尾，否则用 `Target.getTargets` / `Target.getBrowserContexts` 猜 id。
- 只开**一条** `ws://<addr>/devtools/browser/<id>`；标签都走 `Target.attachToTarget(flatten=True)` 的 `sessionId`，**不**连 `/devtools/page/<id>`。
- 浏览器级方法：`Target.setDiscoverTargets`、`getTargets`、`getTargetInfo`、`createTarget`、`closeTarget`、`activateTarget`、`attachToTarget`、`detachFromTarget`、`createBrowserContext`；事件 `Target.targetCreated / targetDestroyed / detachedFromTarget`；`Browser.getVersion`、`Browser.close`、`Browser.setDownloadBehavior`、`Browser.getHistograms`；`Storage.getCookies`、`Storage.clearCookies`；`Network.clearBrowserCache`；`GET /json` 列标签。
- 标签级：`Emulation.setFocusEmulationEnabled(true)`（与 DrissionPage 和一款闭源扩展式工具同一招，三方印证）、`Page.*`、`Runtime.*`、`DOM.*`、`Input.*`、`Network.*`。
- 抓包：`Network.loadingFinished` 即 `Network.getResponseBody`（和 `04` §5.2 同一选择）；另有浏览器级 `Fetch.requestPaused → Fetch.getResponseBody → Fetch.continueResponse` 的拦截版。后者就是 `04` §5.2 第 8 条的备选方案，证明可行。

Playwright `connectOverCDP`、puppeteer `connect`、agent-browser `--cdp` 也是「`/json/version` + 浏览器级 WS + flatten」模型，只是方法集略有出入（agent-browser-stealth 踩过 `Browser.getVersion` 的坑，`01` §4）。

### 2.2 端点表

默认**不开**；`tabcap cdp serve --port <p>` 才开，只绑回环。

| 面 | 做法 |
|---|---|
| `GET /json/version` | 本地应答：`Browser`、`Protocol-Version`、`User-Agent`（从任一标签 `Browser.getVersion` 缓存）、`webSocketDebuggerUrl: ws://127.0.0.1:<p>/devtools/browser/<id>` |
| `GET /json`、`/json/list` | 只列**本兼容会话**的标签（owned + 显式 attach 的），不列用户其它标签 |
| `GET /json/new?url`、`/json/activate/<id>`、`/json/close/<id>` | 分别映射到后台新标签、焦点阶梯、只关 owned |
| `ws /devtools/browser/<id>` | 一条连接一个会话；client 的 `sessionId` ↔（标签，Chrome 子会话）映射在守护进程 |
| `ws /devtools/page/<id>` | 一期不做；需要时再加（puppeteer 老版本用） |

浏览器级方法分四类：

| 类 | 方法 |
|---|---|
| **本地应答** | `Browser.getVersion`、`Target.getTargets`（只回会话内）、`Target.getTargetInfo`、`Target.setDiscoverTargets`（之后把 `chrome.tabs` 事件翻成 `targetCreated/Destroyed`，只限会话内）、`Browser.getHistograms`（回空）、`Storage.getCookies`（经 `chrome.cookies`，**只回会话标签涉及的域**，已定） |
| **改写** | `Target.createTarget` → 后台新标签进会话组；`Target.closeTarget` → 只关 owned，借来的回错误；`Target.activateTarget` / `Page.bringToFront` → 焦点阶梯（§1.1），永不拉窗口；`Target.attachToTarget(flatten)` → 扩展 attach + 分配 `sessionId`；`Target.detachFromTarget` → 对应 detach |
| **转发** | 带 `sessionId` 的一切标签级方法 → 扩展 → `chrome.debugger.sendCommand` |
| **拒绝**（错误文案写明替代） | `Browser.close`、`Storage.clearCookies`、`Network.clearBrowserCache`（账号保护）、`Target.createBrowserContext`（扩展造不出隔离上下文，v0 不做）、`Browser.setDownloadBehavior`（v0 回成功但不生效并记警告，已定） |

`direct` 模式下兼容端点是对 Chrome 自己端点的带过滤直通：只保留拒绝清单、改写项和「只暴露会话内标签」，其余原样转发。

录制器顺带生效：经兼容端点发的命令和收到的事件照样进证据包，`actor:"ai"`、`cmd` 为 `cdp:<client>`；`cdp` 透传同样留痕（私有笔记）。

### 2.3 放在哪一期

建议阶段 2 末或阶段 3：阶段 1 把 §1 的分层做对，兼容端点只是守护进程多一个监听器。

验收（到时候写进 `06` 的同类文档）：
1. 自动：用 Playwright `connectOverCDP`（Apache-2.0）开 s01、读页面、抓 `/api/items`；再用一个 40 行的原始 CDP 客户端复现 DrissionPage 的握手序列（`/json/version` → 浏览器 WS → `setDiscoverTargets` → `createTarget` → `attachToTarget(flatten)` → `Network.enable`），断言每步成功且 `Target.activateTarget` 不把 Chrome 拉到前台。
2. 人工：作者用 DrissionPage `Chromium('127.0.0.1:<p>')` 跑一遍 s01 + `listen`。DrissionPage 的许可是非商业自定义条款，所以它**不进仓库依赖**，只在作者本机做人工核对。

## 3. 从 DrissionPage 借的产品思路（不抄代码）

- **d / s 两模式切换**：浏览器模式探路，切到 requests 会话模式复用同一份 cookie 重放。对应我们的 `replay`：从证据包 `state` 的 cookies 生成 Python 客户端会话，不用人手抄。
- **`listen` 的人体工学**：`listen.start(targets)` → 触发 → `listen.wait()` / `listen.steps()` 拿到带正文的包。对应 CLI：`tabcap net wait --url /api/x --timeout 10`、`tabcap net steps`，给 AI 一个「等那个接口回来」的原语，比 `list` + `detail` 省两步。
- **浏览器级 `Fetch` 拦截抓包**：跳转竞态的备选实现，已知有人在生产用。
- **连已有浏览器只看 `/json/version`**：兼容端点的最低门槛就这一条。

## 4. 决定记录（10-15 第二轮，作者：都按建议）

1. 兼容端点放阶段 3。
2. `Target.getTargets` / `/json` 只暴露会话内标签；用户的其它标签对外部工具不可见。
3. `Storage.getCookies` 只回会话涉及的域。
4. `Browser.setDownloadBehavior` 回成功但不生效，记警告。
5. `ws /devtools/page/<id>` 先不做。
6. 生产模式默认跟随系统代理，`tabcap browser start --proxy system|none|<url>` 和配置项可切换（10-15 作者定）；0.4-D 起账号绑了代理池里的代理时，`direct` 模式给它单独一个 browser context（`Target.createBrowserContext {proxyServer:"host:port", proxyBypassList, disposeOnDetach:false}`），Chrome 只拿到 `host:port`，代理认证由守护进程经 `Fetch.authRequired` 应答【实测 spike 10-16：context 级代理生效；本机代理要在 bypass 里写 `<-loopback>`，否则 loopback 静默直连】；0.6-N 起（作者 10-16 定）`browser start --proxy <url>` 一并传 `--proxy-bypass-list=<-loopback>`，没有自带 bypass 列表的池代理 context 也带 `proxyBypassList: "<-loopback>"`（`--proxy system|none` 不变），所以代理看得到 127.0.0.1 / localhost / [::1] 的流量；守护进程自己的 CDP 连接是管道 / 本地套接字，不经过浏览器的网络栈，不受影响；0.6-D 起（作者 10-16 定）每个绑了账号的会话都有自己的 browser context，绑 `system` / `none`（或没绑）的账号的 context 不带 `proxyServer`，【推断】走浏览器启动参数里的代理设置（只有非 loopback 地址才看得出差别，本仓库只发 127.0.0.1，【待验】），cookie 照池账号的办法恢复与回写；只有不带账号的会话用默认 context；Chrome 自身的后台外连（GCM、组件更新等）用 Playwright 的默认启动参数表压到最少（Apache-2.0，抄并保留 NOTICE）；端到端测试再叠加黑洞代理。

## 5. 信号探针页（0.4-G）

`src/fingerprint/probe.html` 是 tabcap 自己的页面，不属于靶场：自包含（CSP `default-src 'none'`，不加载任何外部资源），在页面自己的 world 里读一张固定字段表（名字沿用追踪模式 `signals.ts` 的 IDL 写法；canvas / audio 只留字节的 sha256，其余值 JSON 超过 1 KB 也只留 sha256），只读、不写 cookie / storage、什么都不改。它由两处提供，都只听 127.0.0.1：`tabcap fingerprint serve`（命令行本地，不要守护进程）给用户自己的日常浏览器手动打开，页面上「Save as reference」把字段表 POST 到 `/ref/<name>`，写成 `$TABCAP_HOME/config/fingerprint/refs/<name>.json`（文件 0600、目录 0700，仅 POSIX 检查）；`tabcap fingerprint probe` 由守护进程临时起在端口 0，在会话里开一个后台标签加载它、等页面自己的 `POST /probe`、关标签，录制中时写一条 `state` env 事件（`04` §4.3）。参照值只来自用户在自己浏览器里手动保存的这一份，从不经 CDP 采集，也不进仓库和文档；`probe --ref` / `diff` 只把本浏览器的值和参照值逐字段并排、给 `same` / `differs` / `missing`（本浏览器缺、参照里有）/ `extra`（本浏览器有、参照里缺），不打分、不给任何改值的建议。POST 要求本次启动的 token、`content-type: application/json`、本端口的 Host，带 Origin 时须同源。

## 6. 线路层 echo、浏览器基准与 probe（0.4-W2）

`src/wire/`，只听、只连 127.0.0.1。TLS 在 Bun 里终结，指纹由原生组件 `native/wireprint/` 算（规范 `11`）。

**echo（`src/wire/echo.ts`，`tabcap wire serve` / `wire profile` / `wire probe` 各起一个）**

- 前端 `Bun.listen`（端口默认 0）：每条连接按 record 长度累积到 ClientHello 完整为止（可以跨 record），记下这些原始字节，整条流原样转发给内部的 `node:tls` 服务器（另一个 127.0.0.1 端口），回程原样转回。两边按 relay socket 的本地端口（= TLS 侧的 `remotePort`）配对；TLS 侧可能晚于前端关闭才报告，配对保留 10 s【实测 spike：180 条连接 0 条配不上；relay 与 OpenSSL 直连两边的 ClientHello 除 random / session_id 外逐字段相同】。
- TLS 侧：`ALPNProtocols: ["h2","http/1.1"]`；`secureOptions: SSL_OP_NO_TICKET`、`sessionTimeout: 0`，不发会话票据。【实测：`openssl s_client` 对默认配置收到 NewSessionTicket，对此配置收不到；CfT 155 按 tabcap 参数 3 次导航 + 3 次 fetch，6 份报告都不带 `pre_shared_key`（0029）】。所以基准里没有恢复连接这一类；万一客户端仍带 PSK，报告的 `echo.psk` 为 true，`diff` 把它当标签 `psk` 单列，画像按 `session.resumed_ja4` 另记。
- 握手后读明文：ALPN 为 h2 → 前言 + 帧到首个带 END_HEADERS 的 HEADERS（含 CONTINUATION）；http/1.1 或没有 ALPN → 到空行为止的请求头。原始字节写临时文件交给 `wireprint report --client-hello … --h2|--h1 … --alpn … --sni … --peer …`；echo 再补 TLS 侧看到的 version / cipher / session_reused，顶层加 `role`（`/` navigation、`/fetch` fetch、`/client` client，其余 other）与 `echo{conn, path, role, alpn, sni, psk, sessionReused, protocol, receivedAt}`。报告留在内存（环形 64 份），`--capture-dir` 时连同原始字节落盘，并作为响应体回给客户端：h2 是手写的 SETTINGS、SETTINGS ACK、HEADERS（`:status` 等四个字面量头，never-indexed、无 Huffman）、DATA（≤16384 一帧）、GOAWAY；h1 是带 `connection: close` 的 200。回完就关，下一个请求必然是新连接、新 ClientHello。
- 证书：`src/wire/certs/` 的测试 CA + leaf（SAN `localhost`、`127.0.0.1`、`probe.test`，带 Authority Key Identifier——Python 3.13 严格校验与 rustls 都要）。私钥公开、故意入库，只给 127.0.0.1 用；CA 私钥没保存。客户端用 `tabcap wire ca-path`（写在缓存目录）。浏览器不装 CA。

**原生组件的调用（`src/wire/native.ts`）**

编译版 tabcap 用 `with { type: "file" }` 嵌入四个目标的二进制（`src/wire/embedded.ts`，约 2.8 MB），按本机选一个，首次用时解到 `<cache>/native/wireprint-<sha256>/wireprint[.exe]`（目录 0700、文件 0755，先写临时名再 rename）；每次 spawn 前核对文件 sha256，不符就重解。源码运行用 `native/dist/<目标>/`，没有就用 Zig 现编（`bun scripts/native.ts build --host`）。一律 argv 调用，不经 shell；退出码 1 → `bad-input`，3 只在 `check` 时接受，其它非零 → `internal`。

从源码编出 tabcap 二进制因此要 Zig 0.16.0（与 Bun 1.4 以上并列为前置条件）：先 `bun scripts/native.ts build` 编出四个目标的 `native/dist/<目标>/wireprint[.exe]`，再 `bun run build`。`bun run build*` 第一步跑 `scripts/prebuild.ts`，四个文件缺任何一个就退出 1，只打一句「the wire component is not built: install Zig 0.16.0 and run `bun scripts/native.ts build` first (release and npm packages include it)」加一行缺了哪些，不再落到 bun 的 `Could not resolve "../../native/dist/…"`（0.7-G）。只用发布包或 npm 包的人不需要 Zig，组件已经嵌在二进制里。

**浏览器基准（`tabcap wire profile`）**

- 基准是 tabcap 启动的那个 Chrome for Testing、用 tabcap 自己的启动参数（`launcher.ts` 的 `buildArgs`），不另起裸 Chrome：只加 `--disable-field-trial-config` 一项就会让 ClientHello 少扩展 `12e0`、`accept-language` 换位置【实测 spike §2.4】。画像记 CfT 版本与参数的 sha256（参数里的本机路径换成 `<profile>` / `<extension>`），缓存按「版本 + 参数哈希」复用。
- 在当前会话开一个后台标签，只对这个标签发 `Security.setIgnoreCertificateErrors {ignore:true}`；导航到 `https://localhost:<port>/?sample=i`，再在页面里 `fetch("/fetch?sample=i")`，各 N 次（默认 3），关标签、把会话的当前标签还原。用 `localhost` 而不是 IP 字面量：IP 不带 SNI，JA4 第 4 位不同【实测 spike】。CDP 方式忽略证书时 Chrome 每次导航前会先中止几次握手（`certificate_unknown`），这些连接没有请求、不出报告【实测：一次 3+3 采集 22 条连接、13 次 tlsClientError、6 份报告】。
- 组件 `profile` 把 6 份报告组成画像：TLS 取全部样本，导航与 fetch 两种头顺序分进 `http.roles`；tabcap 再加顶层 `tabcap` 段。写到 `<cache>/wire/profiles/cft-<version>-<os>-<arch>.json`，报告在同名 `.samples/`。入库的只有 tabcap 采的 CfT 画像（`native/wireprint/corpus/chrome/<major>/<os>-<arch>/<version>.json`）；作者个人浏览器的画像不进仓库。

**probe（`tabcap wire probe --client <dir>`）**

基准（缓存命中就复用），然后在客户端目录跑 `uv run client.py wire-report --url https://localhost:<port>/client --ca <ca> --out <file>`（环境里去掉 `TABCAP_PROXY_URL`，`NO_PROXY` 加上 localhost / 127.0.0.1 / ::1：那次 GET 只到本机；uv 装包仍可走代理）。生成的客户端用自己原样的 `Session()`（HTTP/2、超时、不跟随跳转）发一次 GET，CA 经 `SSL_CERT_FILE` 交给 httpx（等同 `verify=<ca>`，不改 `Session` 的构造）。然后组件 `check --claim <画像> <客户端报告>` 与 `diff --json <一次浏览器导航报告> <客户端报告>`，按 `tls` / `h2`（`http2.*`）/ `headers`（`http.*`）三层给 `same` / `differs` / `missing`。只诊断：说哪层、哪些字段不同，不说原因、不给改值建议；输出固定带一句 note。会话正在录制时四份文档存 blob、每个不同的层一条 `finding`（`04` §4.1 `tool:"wire"`）。

## 7. MCP 服务（0.5-A）

`tabcap mcp`（`src/mcp/`）是 CLI 的另一张脸，不经守护进程新开接口：传输是 stdio 上手写的 JSON-RPC 2.0（零运行时依赖），每行一条消息、stdout 只出 MCP 消息、日志只进 stderr、stdin 关闭后等进行中的调用答完即退出；实现 MCP 2025-11-25 的 initialize 生命周期（客户端要的版本在 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 之内就照回，否则回 2025-11-25；2026-07-28 的 `server/discover` 回 -32601，双时代客户端据此退回 initialize）。工具由命令注册表（`src/cli/commands.ts`）生成，名字 `tabcap_` + 命令路径（空格换 `_`），`inputSchema` 来自位置参数（`choices` → `enum`，`restList` → 字符串数组）与长 flag（camelCase，`--page-size` → `pageSize`；可重复的 → 字符串数组），只改打印形式的 `--text` / `--json` 不进表（工具总是返回信封），守护进程命令都带 `session`、`timeout`。**两种工具集**（作者 10-16 定，理由是上下文开销：宿主把全部工具定义塞进模型上下文，每条命令一个工具约 58 KB【实测：83 个工具的 `tools/list` 定义 57807 B】；10-21（0.8.1）是 95 个工具、84392 B【实测：`test/unit/mcp.test.ts` 打印】）：默认是核心集，`session start / stop / list`、`navigate`、`snapshot`、`outline`、`click`、`fill`、`type`、`press-key`、`hover`、`wait`、`screenshot`、`evaluate`、`net start / stop / list / show / body`、`handoff status / continue` 各一个工具（0.7-B 起 `status` 替下 `handoff status`，`04` §35），说明一行（≤ 120 字符）、属性不带说明和默认值，加 `tabcap_handoff_wait`、`tabcap_run {argv}`（任意命令，argv 同命令行，不含 `tabcap`）、`tabcap_help {command?}`（不给命令时列全部命令的用法与该走哪个工具，给了返回该命令的 `--help` 文本与 schema 条目），共 24 个、8479 B【实测】（0.7-B 后 9047 B【实测】，10-21（0.8.1）9243 B【实测】）；`--all-tools` 是每条命令一个工具、带完整帮助文本，加 `tabcap_handoff_wait`。两种都不进表、`tabcap_run` 也拒绝的：`mcp`、`daemon run`、读口令的 `site add` / `proxy add` / `account add`（stdin 就是 MCP 通道）、三个前台服务器 `fingerprint serve` / `wire serve` / `replay serve`（往 stdout 打印、Ctrl-C 才停）和 `handoff wait`（0.7.5-B 起；用 `tabcap_handoff_wait`）；`schema` 不单列工具，但 `tabcap_run` 可以跑。`tools/call` 把参数按 schema 校验后拼成 argv（`--flag=value`，位置参数以 `-` 开头时前面加 `--`；`tabcap_run` 直接用给的 argv），在进程内调 CLI 的 `run()`——与命令行同一条解析、校验、打码路径——把信封原样（缩进 JSON）作为唯一一个 text 内容返回，`ok:false` 时 `isError: true`。交接不阻塞：撞上验证页的命令立刻带着 `waiting` 错误和它的 `next` 返回；`tabcap_handoff_wait {session, timeoutSeconds 0–300（默认 30）, untilUrl, untilText, untilSelector, untilCookie}` 在进程内跑一次 `handoff wait`，由守护进程等（0.7.5-B 起；之前是每秒查一次 `handoff status`）：`timeoutSeconds` 换成毫秒的 `--timeout`（至少 100 ms），`until*` 换成对应的 `--until-*`（`04` §39）。人一继续（或处理器答复，或某个 until 条件在交接开始后变真）就返回，到时仍在等则再返回一次 `waiting`，宿主的工具超时短也能用（分几次调）。`--print-config <宿主>` 给 claude-code、cursor、codex、gemini-cli、windsurf、claude-desktop 的配置文件位置与条目（2026-10-16 对照各家官方文档；windsurf 的官方页已跳到 Devin Desktop，【待验】）。

## 8. `tabcap fetch`：标记、剥离与 `POST /fetch`（0.6-A）

字段、限速、停手规则见 `04` §26；这里是机制。spike 2026-10-16（Chrome for Testing 155，本机两个 127.0.0.1 端口的服务，全部【实测】除非另注）：

- **发出**：每条请求一段脚本，在标签主帧新建的隔离世界（`Page.createIsolatedWorld {worldName:"tabcap-fetch"}`）里 `Runtime.compileScript {persistScript:true}` 后 `Runtime.runScript {awaitPromise:true, returnByValue:true}`。脚本是一个按请求唯一命名的函数（`__tabcap_fetch_<8 位 hex>_<K>`），函数体里同步调 `fetch(url, {credentials:"include", …})` 并读完正文（让录制器收到 `loadingFinished`），只把状态等元数据按值返回；正文从录下的 blob 取，不经 CDP 传两遍。页面脚本看不到这段脚本，请求本身却是页面的：服务器收到页面的 cookie（`sid=…`）、`sec-fetch-site: same-origin`、`referer` 为当前页；跨源时带 `origin`，CORS 规则照页面的来。
- **同源：标记头 + Request 阶段剥离**：脚本给请求加 `x-tabcap-fetch: c-N:f-K`。命令只在这期间把该标签的 `Fetch.enable` 模式加上 `{urlPattern:"*", resourceType:"Fetch", requestStage:"Request"}`（引用计数，最后一条结束即恢复录制器原来的三条 Response 阶段模式）。录制器在 `Fetch.requestPaused`（无 `responseStatusCode`，即 Request 阶段）里读到标记就 `Fetch.continueRequest {headers: 原请求头去掉标记}`，没有标记的原样继续。顺序：`Network.requestWillBeSent`（请求头里有标记，录制器据此归属）→ `Fetch.requestPaused`（Request 阶段，有标记）→ `Network.requestWillBeSentExtraInfo`（真正上线的请求头，**没有**标记，cookie 照带）→ `Fetch.requestPaused`（Response 阶段）。服务器访问日志里没有这个头；包里 `request.headers` 也去掉了它（`raw/cdp.jsonl` 原样保留 `requestWillBeSent` 里页面那一侧的样子）。同源请求加自定义头不触发预检。这段时间里页面自己的 fetch() 也在 Request 阶段停一下、原样继续，`net start` 的 `instrumentation` 说明写了这一点。
- **跨源：发起栈兜底**：跨源时自定义头会逼出 CORS 预检，所以不加标记、也不开 Request 阶段。`requestWillBeSent.initiator` 是 `{type:"script", stack:{callFrames:[{functionName:"__tabcap_fetch_…", scriptId:<compileScript 给的 id>, url:""}]}}`；录制器按「函数名与 scriptId 都对上、同一 CDP 会话」归属（也看 `stack.parent`）。预检（`initiator.type:"preflight"`）按它的 `initiator.requestId` 跟主请求走；重定向跳沿用同一个 `fetchId`。
- **CORS 拦截**：没有 `Access-Control-Allow-Origin` 时，`fetch()` 在页面里以 `TypeError: Failed to fetch` 失败，控制台出现 `Access to fetch at '<url>' from origin '<origin>' has been blocked by CORS policy: …`，`Network.loadingFailed` 带 `corsErrorStatus:{corsError:"MissingAllowOriginHeader"}`；请求本身照样到了服务器（带 cookie）并被录下（`outcome:"failed"`），命令回 `fetch.blocked` 并附那句控制台原文。
- **`POST /fetch`**：守护进程原有监听上的第三条路由（另两条是 `POST /command`、`GET /status`），鉴权不另做：POSIX 上就是那个 0600 套接字，Windows 上是回环端口 + `daemon.json` 里每次启动的 bearer token。请求体换成 `action:"fetch"` 走 `handleCommand` 同一条路（命令窗口、`waiting` 与预算拦截、秘密值替换都一样）。Python 侧 `_tabcap_fetch.py`（`replay export-python` 一并生成）：读 `<config>/daemon.json`，Unix 上 `httpx.HTTPTransport(uds=socket)`，Windows 上 `http://127.0.0.1:<port>` 加 `authorization: Bearer <token>`，`fetch(url, …) → (status, headers, bytes)`，停手时抛 `Stopped`。Windows 路径【待验】（只在 macOS 上跑过）。

## 9. 解码插件进程（0.6-B）

守护进程为每个启用的解码插件最多开一个长驻子进程（`src/daemon/hooks/decode.ts` 的 `DecodeHost`），各录制共用；协议是 stdin / stdout 上的 JSON 行（`04` §28）。调用排队、一次一个、每次硬超时；超时、崩溃、坏行都杀掉进程，下次用到再起；同一录制里 3 次失败就在这次录制里停用该插件并写 `note`。录制器在取到正文之后、写 `request` 事件之前同步等插件回答，所以有插件匹配的请求事件会晚写出这么久（超时上限为清单的 `timeoutMs`）；页面不受影响（Fetch 拦截照常在取到正文时放行）。插件进程只拿到最小环境（无 `TABCAP_*`），stderr 丢弃；`daemon stop` 时全部杀掉。`bundle decode`、`replay check` 在 CLI 进程里各起自己的一套，运行结束即关。

## 10. 按资源类型取正文与站点停手规则（0.6-I）

字段与语义见 `04` §5.2 规则 10、§18 后的 0.6-I 段；这里是机制。

- **正文模式**：`Recorder` 构造时带 `bodies`（`net start --bodies`，否则 `config.json` `record.bodies`），写进 manifest `record.bodies`。`loadingFinished` 后判定 `keepsBody(模式, 类型)`（`src/shared/bodies.ts`，纯函数表）：不存的不发 `Network.getResponseBody`，直接写事件，`response.body:{skipped:"resource-type"}`。Fetch 拦截的三类（XHR / Fetch / Document）在 `api` / `api+script` 下都存，只有 `none` 会把 Fetch 已取到的正文丢掉（拦截照开，保证规则 9 与跳转救回的时序不变）。
- **站点规则**：`Guard.watch` 订阅录制器的 `onIndexed`（现在带上写出的事件，用于取 `charset`）；先查 HTML 403 挑战，不是挑战再查站点规则。规则来自 `src/daemon/siterules.ts`：按 `config.json` 的 mtime / 大小缓存解析结果，URL → 库站点用 `tabcap fetch` 的 `siteOf`。正文从录制包的 blob 读（守护进程依赖 `readBlob`）。命中时同步写入两张表（会话的 `waiting` handoff、站点的停止表，与 0.6-A 的 `fetch-stop` 同一张，多一个 `reason`），再异步截图、写 `handoff` 事件；`consecutiveNon200` 的计数按到达时间（事件的 `timing.end`）插入一个有序窗口，而不是按写出顺序累加；拦截路径复用 `BLOCKED_WHILE_WAITING`，`waitingError` 对 `stop-rule` 给 `guard.stopped`。`fetch --stop-on` 在发出前向 guard 登记 `fetchId`，guard 对这条响应跳过站点 `stopOn`。
