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
- `--user-data-dir=<profile>`、`--remote-debugging-pipe`（备选 `--remote-debugging-port=0` + 读 `DevToolsActivePort`）、`--load-extension=<ui ext>`、`--no-first-run`、`--no-default-browser-check`。
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
- 此结果同时回答了私有笔记里的待验项「焦点模拟是否让 `document.hasFocus()` 变真」：是。
- 弹窗拦截的识别：`userGesture:false` 时 `window.open` 返回 null、不建目标，但 host 会收到 `Page.windowOpen {userGesture:false}`，守护进程可据此报「弹窗被拦截」并给下一步。
- **可信点击（作者定 10-15；提案 `docs/10`，0.3-E）**：默认 `click` 仍是第一级 DOM 点击，输出 `eventShape:"incomplete"` 与「incomplete event sequence」警告。`click --trusted` = 第二级：焦点仿真 → 滚入视口 → **rAF 绘制确认**（页面里 `requestAnimationFrame` 在 1 s 内回调且 `visibilityState` 为 `visible`）→ 终点遮挡检查 → `mouseMoved` 路径（起点是本标签上次可信鼠标事件的位置，新标签或新文档为 0,0；直线 + minimum-jerk，时长 100–400 ms 均匀随机，约 60 点/秒、至少 3 点，终点精确等于目标；±0.4 px 散布默认关；`button:"none"`、`buttons:0`；每条单独 1 s 超时）→ `mousePressed {button:"left", buttons:1, clickCount:1, force:0.5}` → 50–140 ms → `mouseReleased`。pointer / mouse 两族事件全部由 Chrome 合成，不手写 DOM 事件。确认不了已绘制时绝不发 `mouseMoved`（spike 1g：未绘制的隐藏标签上永不返回），降到第一级并标 `degraded:"not-painted"`。某条 move 超时报 `move-timeout`，不按下、不重试；任何失败都不自动重试。随机数可注入（测试用固定种子），CLI 不暴露种子。【实测 10-15，CfT 155：`force:0.5` 让 pointerdown 的 `pressure` 为 0.5，与 Playwright 导出一致；`navigate --new-tab` 开出的后台标签（点击前 `visibilityState:"hidden"`；是否从未绘制过属【推断】），开仿真后 rAF 按时回调、按下时 `visibilityState:"visible"`、`hasFocus:true`，走完整路径约 0.85 s，命令结束后回到 hidden。降级路径目前只由假 CDP 覆盖（L0），真实浏览器里还没遇到过确认不了绘制的标签】
- **逐键输入（作者定 10-15）**：默认 `type` 与 `--insert` 仍是一次 `Input.insertText`，输出 `eventShape:"insert"` 与「incomplete event sequence」警告。`type --trusted`：US 布局里有键位的字符逐个 `Input.dispatchKeyEvent`（`keyDown` 带 `text` / `unmodifiedText`、`modifiers:0` → `keyUp`），由 Chrome 合成 keydown / keypress / beforeinput / textInput / input / keyup；没有键位的字符（中文、emoji、`\t`）逐字 `Input.insertText`；`--delay <ms>` 是两个字符之间的间隔，默认 0。要开焦点仿真。【实测 10-15：s46 上 `type --trusted "aB3 中"` 与 Playwright `type()` 导出逐字段相同（大写不发 Shift，`shiftKey:false`）】真人节奏的下限等作者的 L3 导出（`06` A7.9）再定。
- **Linux 后台标签的帧（0.3-G 之后，修 CI 不稳）**：【实测 Chromium 155 linux-arm64 / Xvfb，容器内】后台标签开焦点仿真后 `visible`、rAF 起初 17 ms；一旦出过几帧有变化的画面（聚焦输入框、打字、动画），rAF 间隔变成 1017 ms，每条 `mouseMoved` 要等下一帧才回（约 0.6–1 s），可信点击撞上每条 1 s 的超时（`move-timeout`）。仿真关了再开、`setDeviceMetricsOverride` 都不恢复；一次 `Page.captureScreenshot` 恢复到下几帧变化为止（动画页上立刻又慢）；`Page.startScreencast` 期间稳定 17 ms（不 ack 帧也一样），停掉后几帧内又慢。前台标签不受影响。【推断】Aura 上后台标签的 surface 不在窗口的合成树里，没人绘制它的帧，viz 对「出帧却没被绘制」的客户端限到每秒 1 帧；macOS 每个视图有自己的合成器，所以本机 81/81。做法：rAF 绘制确认改为同时量 3 个帧间隔，任一超过 100 ms（或不来）算「帧慢」；`visible` 且帧慢时开一个 32×32、quality 1 的 screencast，再确认一次，全速则保持到松开之后再停，输出带 `paint: {raf, frameMs, visibility, held:"screencast"}`；screencast 也救不回来就停掉、照旧走（可能 `move-timeout`）。`hidden` 的标签不碰，照旧降级。
- **第一级的定位**：`el.click()` 是默认点击、也是 `--trusted` 确认不了绘制时的降级路径，输出必带 `eventShape:"incomplete"`。

### 1.2 启动参数表（抄自 Playwright `chromiumSwitches.ts`，Apache-2.0，保留 NOTICE；10-15 作者定）

来源：`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`（main，2026-10-15 读取）。我们的取舍按用途分组；标「待验」的由 spike 1g / 实现时确认。

| 组 | 参数 | 取舍 |
|---|---|---|
| 压外连 | `--disable-background-networking` `--disable-component-update` `--disable-sync` `--metrics-recording-only` `--no-service-autorun` `--disable-field-trial-config` `--disable-client-side-phishing-detection` `--disable-breakpad` `--disable-default-apps` `--disable-component-extensions-with-background-pages` `--disable-features=OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,Translate,MediaRouter,DialMediaRouteProvider,GlobalMediaControls,LensOverlay,HttpsUpgrades` | 全部采用。spike 1 看到的 GCM 外连在这组之下是否消失【待验】 |
| 钥匙串 / 密码库 | `--use-mock-keychain`（macOS）`--password-store=basic`（Linux） | 采用，已定 |
| 后台标签不节流 | `--disable-background-timer-throttling` `--disable-renderer-backgrounding` `--disable-backgrounding-occluded-windows` | 采用。这是 spike 1g「隐藏标签定时器节流」的已知解法，和焦点模拟配合用 |
| 不打扰 | `--no-first-run` `--no-default-browser-check` `--disable-search-engine-choice-screen` `--disable-infobars`（隐藏 Chrome for Testing 自己的信息栏）`--disable-prompt-on-repost` `--disable-hang-monitor` `--disable-popup-blocking` | 采用。弹窗拦截关掉：登录弹窗是真实场景，`Page.windowOpen` 照样记录；要不要默认关【待定，倾向关】 |
| 录制相关 | `--disable-back-forward-cache`（bfcache 会让后退 / 前进不走网络、事件不完整）`--disable-features=PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose` `--enable-features=CDPScreenshotNewSurface`（隐藏标签截图）`--allow-pre-commit-input` `--disable-ipc-flooding-protection` `--force-color-profile=srgb` `--export-tagged-pdf` | 采用；`CDPScreenshotNewSurface` 对后台标签截图的效果【待验】 |
| 不要 | `--disable-extensions`（我们要装 UI 扩展）`--unsafely-disable-devtools-self-xss-warnings` `--disable-stack-profiler`（Windows 专用）`--disable-dev-shm-usage`（Linux 容器）以及所有 `edge` / `ms` 前缀的 Edge 专用项 | 不采用 |

注意：不传 `--enable-automation`；【实测 10-15 探针页】以 `--remote-debugging-pipe` 启动时 `navigator.webdriver` 仍为 true，Playwright 同样如此，原因未查【推断：管道连接即视为自动化】。参数表以代码里的常量为准，本表只是取舍记录。

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
6. 生产模式默认跟随系统代理，`tabcap browser start --proxy system|none|<url>` 和配置项可切换（10-15 作者定）；0.4-D 起账号绑了代理池里的代理时，`direct` 模式给它单独一个 browser context（`Target.createBrowserContext {proxyServer:"host:port", proxyBypassList, disposeOnDetach:false}`），Chrome 只拿到 `host:port`，代理认证由守护进程经 `Fetch.authRequired` 应答；绑 `system` / `none` 的账号仍用浏览器自己的 context 与上面的启动参数【实测 spike 10-16：context 级代理生效；本机代理要在 bypass 里写 `<-loopback>`，否则 loopback 静默直连】；Chrome 自身的后台外连（GCM、组件更新等）用 Playwright 的默认启动参数表压到最少（Apache-2.0，抄并保留 NOTICE）；端到端测试再叠加黑洞代理。

## 5. 信号探针页（0.4-G）

`src/fingerprint/probe.html` 是 tabcap 自己的页面，不属于靶场：自包含（CSP `default-src 'none'`，不加载任何外部资源），在页面自己的 world 里读一张固定字段表（名字沿用追踪模式 `signals.ts` 的 IDL 写法；canvas / audio 只留字节的 sha256，其余值 JSON 超过 1 KB 也只留 sha256），只读、不写 cookie / storage、什么都不改。它由两处提供，都只听 127.0.0.1：`tabcap fingerprint serve`（命令行本地，不要守护进程）给用户自己的日常浏览器手动打开，页面上「Save as reference」把字段表 POST 到 `/ref/<name>`，写成 `$TABCAP_HOME/config/fingerprint/refs/<name>.json`（文件 0600、目录 0700，仅 POSIX 检查）；`tabcap fingerprint probe` 由守护进程临时起在端口 0，在会话里开一个后台标签加载它、等页面自己的 `POST /probe`、关标签，录制中时写一条 `state` env 事件（`04` §4.3）。参照值只来自用户在自己浏览器里手动保存的这一份，从不经 CDP 采集，也不进仓库和文档；`probe --ref` / `diff` 只把本浏览器的值和参照值逐字段并排、给 `same` / `differs` / `missing`（本浏览器缺、参照里有）/ `extra`（本浏览器有、参照里缺），不打分、不给任何改值的建议。POST 要求本次启动的 token、`content-type: application/json`、本端口的 Host，带 Origin 时须同源。
