# 证据包规范 v0（草案，待审）

2026-10-15。对应 `03` §5 `bundle` 模块与 §10 第 1 条。本文定义**录制器写什么、分析命令读什么、怎么和 HAR 互转**。先定格式再写代码；格式一旦有样例文件，样例就是测试的 oracle。

标注：【实测】跑过；【推断】间接推出；【待验】没验证；**P1** 阶段 1 实现；**P2** 阶段 2 才实现，但 v0 先把 kind 占住，避免以后改格式。

工具名未定，命令行示例一律用占位符 `bbl`，格式标识用中性的 `evidence-bundle/0`，改名时只换字符串。

已定（10-15 第二轮）：运行时 Bun、许可证 Apache-2.0、本 lab 另立 `AGENTS.md`；**探路由 AI 做**，作者给凭据，人只在验证码、二次验证、需要人点的时刻介入（影响 §4.1 `action`、§8.1、`05` s14、`06` A2.7）。

## 1. 设计目标

1. **只追加**：事件流一行一条，录到一半进程死了，前面的都在；读者容忍最后一行截断。
2. **能 grep**：`events.jsonl` 用 `grep`/`jq` 就能查，不装工具也能看。
3. **正文急取、去重、只回路径**：请求完成时立刻拷正文，按 SHA-256 存 `blobs/`；事件里只放引用和大小。取不到就写原因，不留空白。
4. **一条命令出 HAR，外部 HAR 也能进来**：DevTools / Charles / mitmproxy 的包导入后，`find`、`diff` 照样能跑；丢了什么字段要列出来。
5. **脱敏在导出时做**：本地原包不脱敏（分析要用真值），导出默认打码，同一个秘密打成同一个占位符，`diff`、`deps` 在打码包上仍成立。
6. **id 稳定**：同一份包里 `r-57` 永远指同一个请求；AI 在对话里引用的 id 隔天还能用。
7. **谁做的说清楚**：每条事件带 `actor`（human / ai / system），人探路和 AI 放大录进同一条时间线。

## 2. 目录结构

```
<bundle>/                         目录名建议 <YYYYMMDD-HHMMSS>-<session>
  manifest.json                   清单；录制中每 5 秒覆写一次，结束时写 finished
  events.jsonl                    事件流，append-only，seq 单调递增
  blobs/sha256/<xx>/<64 位十六进制>  正文、截图、cookie 快照等所有大块内容；无扩展名；xx = 哈希前两位
  raw/cdp.jsonl                   可选：原始 CDP 事件（Network / Page 域原样）；用于复核录制器本身
  exports/                        导出产物（HAR、脱敏副本）；不参与分析
```

- 包完整的判定：`manifest.json` 有 `finished`。没有就是录制中或异常中断，分析命令照样读，但在输出里标明（警告 `bundle is not finished: …`，文本报告里 `(unfinished)`）。
- `blobs/` 写法：先写临时文件，`fsync`，再 `rename` 到哈希名；同内容只存一份。
- `raw/` 默认开（lab 阶段要靠它查录制器漏没漏），以后再议默认关。（已定 a）

## 3. 事件信封

每行一个 JSON 对象，公共字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `seq` | int | 从 1 起，守护进程收到时分配，**全包唯一的排序依据** |
| `ts` | number | 墙钟，epoch 毫秒；来自 CDP `wallTime` 的事件用它换算，其它用守护进程时钟 |
| `mono` | number \| null | CDP 单调时钟（毫秒）；算时长只用它，不用 `ts` |
| `kind` | string | 见 §4 |
| `actor` | `"human"` \| `"ai"` \| `"system"` | 谁引起的。P1 规则：落在某条 AI 命令的执行窗口内 → `ai`，否则 `human`；守护进程自己的动作 → `system`。更精确的识别是 P2（`03` §10 第 2 条）【推断，待验】 |
| `tab` | string \| null | 包内标签 id，`t1`、`t2`…，按挂接顺序分配；与 Chrome 的 tabId 的对应关系在 `tab` 事件和 manifest 里 |
| `cmd` | string \| null | 引起本事件的 AI 命令 id（`c-<seq>`），没有则 null |

读者规则：不认识的 `kind` 跳过；不认识的字段原样保留并透传。

## 4. 事件种类

### 4.1 P1 必做

**`session`**：`{phase:"start"|"stop", name, mode:{capture:"passive"|"active"|"mixed", trace:false, raw:true}}`。`stop` 时把还没完成的请求按 §5.4 收尾。`stop` 的 `mode.trace` 等于 manifest 的 `mode.trace`（0.4-F：`false` 或追踪设置对象，见 §7）。

**`tab`**：`{phase:"open"|"attach"|"detach"|"close"|"replace", tab, chromeTabId, owned:bool, url, title, reason}`。
`reason` 取值：`"ai-opened"`、`"borrowed"`、`"user-cancelled-debugging"`、`"closed"`、`"crashed"`、`"popup"`。
子目标（跨源 iframe、Service Worker、worker）也用 `tab` 事件记：`{phase:"attach", tab:"t1", target:{id:"g3", type:"iframe"|"service_worker"|"worker", url, sessionId}}`，`tab` 仍是宿主标签。【实测 10-15 spike 1：`direct` 模式下 OOPIF 与 Service Worker 自动挂接成功，各自的 `Network.requestWillBeSent` 落在子会话上；弹窗见 NOTES；`ext` 模式的 `chrome.debugger` 支持阶段 2 再验】

**`nav`**：`{tab, frame:"root"|<frameId>, nav:"n-<seq>", url, from, type:"navigation"|"history"|"reload"|"back_forward", loaderId, loadEvent:{domContentLoaded:mono, load:mono}|null}`。
`nav` 字段是**导航纪元**：之后该标签的请求都带同一个 `nav`，直到下一次 `nav` 事件。`history` 覆盖 `pushState` / `replaceState` / hash 变化，靠 `Page.navigatedWithinDocument`。

**`request`**：一次 HTTP 交换一条，**在 `loadingFinished` / `loadingFailed` 时写**，字段见 §5。

**`ws`**：`{tab, ws:"r-<握手请求 seq>", phase:"frame"|"close"|"error", direction:"send"|"recv", opcode:1|2, payload:{inline:string}|{blob:"sha256:…", size}, reason}`。握手本身是一条 `type:"websocket"` 的 `request`。

**`cmd`**：两条（§14 裁决）：开始 `{id:"c-<seq>", phase:"start", actor:"ai", argv:[...]|null, input:{...}}`，结束 `{phase:"end", ref:"c-<seq>", ok:bool, error, durationMs, outputSummary}`。每次 CLI / skill / MCP 调用一对，是「AI 操作窗口」的依据；窗口内事件的 `cmd` 字段引用开始那条的 id。

**`console`**（0.2 新增）：`{tab, level:"log"|"info"|"warn"|"error"|"debug", source:"console"|"exception"|"network"|"security"|"other", text, args:[...截断后的参数摘要], url, line, col, stack:string|null}`。来自 `Runtime.consoleAPICalled`、`Runtime.exceptionThrown`、`Log.entryAdded`；单条 `text` 超过 4 KB 截断并标 `truncated:true`。站点在签名校验失败、接口异常时常把线索吐在这里，`find` 也搜它。

**`action`**：`{tab, op, target, value, phase:"done"|"failed", error, shots:{before:"sha256:…", after:"sha256:…"}, nav, trusted:bool}`。
- `op`：`click` / `fill` / `key` / `select` / `scroll` / `navigate` / `upload` / `dialog` / `evaluate`。
- `target`：`{ref, role, name, selector, rect:[x,y,w,h], frame}`，有什么填什么；`selector` 只是给人看的定位提示，不是重放契约。
- `value`：`fill`/`key` 的文本；`type=password`、`autocomplete` 含 `cc-`/`one-time-code` 的字段一律写 `"<masked>"`，录制时就不落盘。经 §8.1 的 secret 引用填入的，写 `"<secret:<name>>"`。
- 人的操作（`actor:"human"`）：探路由 AI 做之后，人只在验证码、二次验证、需要人点的时刻介入。这些时刻的人工操作由隔离世界里的被动监听器记（只记 pointer click、input 的 change/失焦提交、Enter/Tab），不改页面行为；**P2 实现**，P1 只记介入前后的截图和 `nav`。P2 做时只在 `handoff` 进入「人在操作」状态期间武装监听器，其余时间不挂。（已定 b）

**`screenshot`**：`{tab, blob:"sha256:…", format:"png"|"jpeg", width, height, scale, reason:"nav"|"action"|"manual"|"interval"|"handoff", nav}`。

**`state`**：`{tab, what:"cookies"|"localStorage"|"sessionStorage", origin, blob:"sha256:…", count, reason:"session-start"|"nav"|"session-stop"|"manual"}`。
内容：cookies 用 CDP `Network.getCookies` 的原样数组；storage 用 `[[key,value],…]`。P1 只做 cookies、只在 session 起止和每次 `navigation` 类 nav 时取。

**`finding`**：`{actor:"ai"|"human", tool:"find"|"diff"|"deps"|"trace"|"where"|"manual", grade:"实测"|"推断"|"待验"|"人确认", claim, evidence:[{request:"r-57", path:"$.items[3].title"}|{ws:"r-12", frame:seq}|{blob}], input, output}`。
分析命令默认不写入；加 `--save` 才追加；`grade` 只有人能标 `人确认`（P2 的 `confirm` 事件会生成它）。

**`note`**：`{actor, text, refs:[…]}`。人或 AI 的旁注。

**`signal`**（0.4-F 追踪模式，10-16 作者定）：`{tab, frame, nav, api:"Navigator.prototype.userAgent", access:"get"|"call", args:<≤256 B summary, after secret substitution>, caller:{kind:"page"|"tabcap", url, scriptId, line, col}, stack:[≤stack frames of {url,line,col}], count, firstMono, lastMono, truncated?:true, value?}`。
- 只读、只记：页面里什么都不改（不注入脚本、不包 getter、不改值），输出里也不给改值的建议。机制是 Debugger 断点（`Debugger.setBreakpointOnFunctionCall` + `EventBreakpoints` 的 `scriptFirstStatement`），见 `07` §1.1。
- 聚合：每个 (文档, api, 调用位置) 一条；调用位置是栈顶帧（原生 getter / 函数没有自己的帧）。文档结束（执行上下文销毁、导航、标签关闭）、`trace stop`、录制停止时写入；还开着的文档 `trace list` 也列出（标 pending，未写入包）。录制停止而追踪仍开时，已见的读数先写进这份包，之后从 0 重新计数。
- `value` 每个文档每个 API 在隔离世界读一次：≤1 KB 内联，否则 blob；canvas / audio 数据只记 `sha256:…`；`document.cookie`、storage 和表单值写 `"<not-recorded>"`；所有文本过守护进程的秘密值替换。只在 window realm、且有无参数无副作用读法时读（navigator / screen 的 getter、`Intl.DateTimeFormat().resolvedOptions()`、`new Date().getTimezoneOffset()`）；要接收者或参数的（canvas、WebGL、字体、权限）和会让页面开始做事的（`getVoices` 会加载语音并触发 `voiceschanged`）没有 `value`；worker 里不读。
- 限流：`firstN`（默认 20）——同一 (api, 调用位置 url:line:col) 在一次追踪里只有前 N 条事件带栈，之后的事件 `stack:[]`、只计数；`maxHits`（默认 500）——同一 API 在同一文档里命中满 maxHits 次后，该文档的这个断点撤掉，之后的读取不计，该 (文档, api) 的事件都带 `truncated:true`。断点按渲染进程共享，撤掉后同进程的同源 frame 也不再记这个 API，直到下一个文档。`performance.now`、`Date.now`、`Math.random` 不在默认表里。
- `caller.kind:"tabcap"`：栈里有 tabcap `evaluate` 进行中在该目标上编译的脚本。tabcap 自己读值在隔离世界里做；V8 内建函数（`Date`、`Intl`）的断点跨上下文共享、隔离世界里也会停，这类暂停和栈里有隔离世界脚本的暂停都不记。
- `access:"event"`：instrumentation 断点也记成 `signal`，`api` 为 `instrumentation:<名>`，`args` 为暂停 `data` 去掉 `eventName` 后的摘要。名字只有 spike 实测会触发的 `canvasContextCreated`、`webglErrorFired`、`audioContextCreated`、`audioContextClosed`（`protocol.json` 不列这些名字，写错也返回成功，代码里集中在一个常量并注明）。`maxHits` 对 event 只停止计数，不撤 instrumentation 断点。
- `line` / `col` 是 CDP 原值（从 0 起）；`trace list` 显示从 1 起（同 §17 `net show`）。`firstMono` / `lastMono` 是 CDP 单调时钟（毫秒），由守护进程收到暂停的时刻按带 `timestamp` 的 CDP 事件校准估算，无法校准时为 null；信封 `mono` 等于 `firstMono`。
- worker 里 `Navigator.prototype.*` 解析为 `WorkerNavigator.prototype.*`，`api` 写实际装断点的名字。
- grade：`signal` 事件是【实测】。
- 已知盲区（spike Q7）：导航开始之后旧文档里的读取记不到（旧文档不再暂停）；Service Worker / Shared Worker 0.4 不覆盖；交接等人期间（`Debugger.setSkipAllPauses`）不记，期间新加载的文档在 `handoff continue` 时补装断点。

### 4.2 P2 预留（v0 只占 kind，不实现）

- **`handoff`**：`{state:"waiting"|"human-active"|"resumed", reason, question, timeoutMs, answerRef}`。
- **`confirm`**：`{question, options, answer, by:"human", refs, producesFinding:"<seq>"}`。
- **`guard`**：`{event:"budget"|"breaker"|"probe", site, account, detail}`。0.4-D 起 `budget` 与 `breaker` 实际写出（`probe` 仍只占位）：配置了每小时请求预算（`config.json` `pool.budget.requestsPerHour`）时，账号用满预算写 `budget`（`detail.rule:"requests-per-hour"`）；账号 24 h 内第 2 次登录失败转 `needs-human` 时写 `budget`（`detail.rule:"failed-logins"`）；熔断时写 `breaker`，会话绑了账号时 `detail.coolUntil` 是冷却结束时刻。

### 4.3 `sample` 挑战样本包（`03` §5 新增模块，P2/P3，先占位）

样本包不是新格式，是证据包的一个 **profile**：`manifest.mode.sample = true` 时录制器额外做——

- `type:"script"` 和 `document` 的正文不受 §5.2 第 4 条的大小上限约束；内联脚本随主文档正文一起在。加载顺序就是 `seq`。
- `state` 新增 `what:"env"`：在隔离世界读 `navigator` / `screen` / 时区 / 语言 / UA 等**只读**属性的快照（不改页面，不注 hook）。
- 挑战相关的 cookie / storage 变化：在每条 `document` / `script` 请求完成后多取一次 `state`，让「哪段脚本跑完后多了哪个 cookie」能从时间线上读出来。
- `manifest.sample`：`{challengeRequests:["r-…"], scripts:[{request:"r-…", sha256, inline:false}], env:"<state seq>"}` 索引，由录制器在 `session stop` 时生成。

工具只录不析（`03` §6）；分析是作者自己的研究（作者自己的离线分析项目等），拿样本离线做。（已定 h：作为 profile，不另立格式）

## 5. `request` 事件

### 5.1 字段

```jsonc
{
  "seq": 57, "ts": 1760500123456.7, "mono": 88123.45, "kind": "request",
  "actor": "human", "tab": "t1", "cmd": null, "nav": "n-41",
  "id": "r-57",                                   // 固定等于 "r-" + seq
  "cdp": { "requestId": "1A2B.33", "loaderId": "…", "frameId": "…", "sessionId": null },
  "type": "xhr",                                  // CDP ResourceType 小写：document / xhr / fetch / script / stylesheet / image / font / media / websocket / eventsource / manifest / other
  "method": "GET", "url": "http://127.0.0.1:4310/api/items?page=2", "urlFragment": null,
  "initiator": { "type": "script", "url": "http://127.0.0.1:4310/app.js", "line": 120, "col": 33, "stack": null },   // stack 只在追踪模式有
  "request": {
    "headers": { "accept": "application/json", "cookie": "sid=…" },     // 键小写；同名多值用数组；去掉 ":" 开头的伪头
    "headersSource": "merged",                    // event / wire / merged：wire 来自 *ExtraInfo
    "postData": null                              // 或 {"inline": "..."} 或 {"blob": "sha256:…", "size": 123}
  },
  "response": {
    "status": 200, "statusText": "OK",
    "headers": { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] },
    "headersSource": "merged",
    "mimeType": "application/json", "charset": "utf-8",
    "protocol": "h2", "remote": { "ip": "127.0.0.1", "port": 4310 },
    "fromCache": false, "fromServiceWorker": false, "fromPrefetch": false,
    "body": { "blob": "sha256:…", "size": 4096, "base64": false, "wireEncoding": "gzip", "truncated": false },
    "bodyMissing": null                           // 或 {"reason": "...", "detail": "CDP 原文"}
  },
  "redirect": null,                               // 或 {"from": "r-56"}
  "timing": { "start": 88120.1, "responseStart": 88122.0, "end": 88123.4, "cdp": { /* Network.ResourceTiming 原样 */ } },
  "outcome": "finished",                          // finished / failed / incomplete
  "error": null                                   // 或 {"text": "net::ERR_ABORTED", "canceled": true, "blockedReason": null}
}
```

### 5.2 正文的取法（录制器的硬规则）

1. `Network.enable` 时把缓冲加大（建议 `maxTotalBufferSize` 256 MB、`maxResourceBufferSize` 64 MB、`maxPostDataSize` 1 MB）。`direct` 模式是标准 CDP 参数；【待验：`ext` 路径下是否生效；具体取值靠 s12 量】。
2. 收到 `loadingFinished` **立刻** `Network.getResponseBody`，拿到就写 blob，再写 `request` 事件。不等 `detail`，不等 `stop`。这是和「正文懒取」相反的选择：懒取在 `stop` 或跳转后会丢正文（`01` §2 对照表）。
3. CDP 返回的正文已经解掉了传输层压缩（gzip / br）；`base64Encoded=true` 时先解码再存，**blob 里永远是真实字节**。`wireEncoding` 记线上的 `content-encoding`，给 HAR 导出和 `find` 的解码链用。
4. 单个正文超过上限（32 MB，已定 c）不取，`bodyMissing.reason = "too-large"`。
5. 取不到按原因归类：`redirect`（3xx 无正文）、`not-modified`（304）、`no-content`（204 / HEAD）、`navigated`（跳转后 Chrome 已释放）、`evicted`（缓冲满被逐出）、`detached`（用户取消调试或标签关闭）、`stopped`（session 已停）、`failed`（`loadingFailed`）、`unsupported`（CDP 不支持的类型，如部分流式）。`detail` 放 CDP 原话。【实测 10-15 spike 2】被导航取消的请求**不会**收到 `loadingFailed`，只停在 `requestWillBeSent` 或 `responseReceived`；取不到时 CDP 只有一句 `No resource with given identifier found`，`navigated` 与 `evicted` 要靠时间线区分：取正文之前主框架已提交新导航就是 `navigated`，否则 `evicted`。
6. `document` 类型也取正文（主文档 HTML），`find` 要搜它。
7. 流式响应（SSE、chunked NDJSON）在 `loadingFinished` 时取完整正文；页面卸载时这些请求不会收到 `loadingFailed`（【实测】spike 2），按 §5.4 的「导航提交即收尾」规则写成 `incomplete` / `navigated`，已到达的部分在 Network 路径下取不到。
8. 跳转竞态【实测 10-15 spike 2，本机回环、4 KB 正文、Chrome 155】：
   - 急取对「导航触发前 ≥1 ms 就 `loadingFinished`」的请求 0 漏（50 轮 300/300，哈希全对）；在导航触发后约 2 ms 内才 finished 的，正文已释放（随机抖动批 medium 3/38 失败）；在导航开始后才收完响应的（点击处理器里发出再立刻跳转的 `before-leave`），**既没有 `loadingFinished` 也没有 `loadingFailed`**，Network 路径下 50/50 全丢。
   - `Fetch.enable {requestStage:"Response"}` + `Fetch.getResponseBody` + `continueResponse` 能把以上两类全部救回（10 + 20 轮 `before-leave` 30/30），每请求多 1.5–2 ms（p50），暂停最长 34 ms；请求在暂停期间被取消时 `continueResponse` 报 `Invalid InterceptionId.`，正文此前已取到，要容忍。Fetch 会先缓冲完整正文再交给页面，所以不能拦 `eventsource` / `websocket` / `media`；大正文的代价未测。
   - **已定（10-15 作者）**：默认开 Fetch 拦截，但只拦 `XHR`、`Fetch`、`Document` 三类资源，其余走急取；`session start --capture=light` 关掉拦截。理由是 `03` §7 验收 2 明确要求「跳转前的页面发出的请求」正文在，而这正是 Network 路径 100% 丢的那一类。
9. 页面从不读取的响应体（作者定 10-15，0.3-E 实现）：页面拿到响应却不读正文时，Chrome 不发 `loadingFinished`，旧做法只能在 stop 时收尾成 `incomplete`，录制中 `net list` / `net wait` / guard 都看不到它【实测 0.3-C：s15 的 `/api/limited`】。现在：`responseReceived` 之后 **1 s** 仍没有 `loadingFinished` / `loadingFailed`，而 Fetch 拦截已取得完整正文的，立即写成 `outcome:"finished"`、`timing.end:null`（没有完成时刻）、`bodySource:"fetch"`、`unreadByPage:true`，正文照常进 blob；`net list` 的行带 `unreadByPage:true`，`net show` 同样显示。只查一次：1 s 时 Fetch 还没有正文（非 XHR / Fetch / Document 类型、正文没取到）的，仍按 §5.4 在导航提交或 stop 时收尾。已写出的请求之后再来的 `loadingFinished` 忽略，不重写。HAR 导出照既有规则处理 `finished`（`time` 因 `end` 为 null 记 -1），没有另改。

### 5.3 请求体

`requestWillBeSent` 带 `postData` 就内联（≤ 64 KB），否则 `Network.getRequestPostData` 取后存 blob；取不到写 `postDataMissing`。表单、JSON、multipart 都存原样字节，解析留给分析命令。

### 5.4 未完成的请求

`session stop` 时还没 `loadingFinished` 的请求，各写一条 `outcome:"incomplete"` 的 `request`，有什么写什么；`bodyMissing.reason = "stopped"`。**主框架导航提交时同样收尾**：旧文档上所有未结束的请求写成 `incomplete`、`reason = "navigated"`，因为被导航取消的请求不会再有任何事件（【实测】spike 2）。不丢。

## 6. id 与时间

| 东西 | 形式 | 规则 |
|---|---|---|
| 标签 | `t1`、`t2` | 包内按挂接顺序 |
| 导航纪元 | `n-<seq>` | 等于那条 `nav` 事件的 seq |
| 请求 | `r-<seq>` | 等于那条 `request` 事件的 seq；`ws` 帧用握手请求的 id |
| 命令 | `c-<seq>` | 等于那条 `cmd` 事件的 seq |
| blob | `sha256:<64 hex>` | 内容哈希，小写 |
| 快照 ref | `e12` | 来自 snapshot，**不跨包、不持久**，只在 `action.target` 里做记录 |

时间：跨标签排序只信 `seq`；时长只用 `mono`；`ts` 给人看和给 HAR 的 `startedDateTime` 用。

## 7. manifest.json

```jsonc
{
  "format": "evidence-bundle/0",
  "id": "01JA…",                                   // ULID
  "created": 1760500000000, "finished": 1760500900000,   // finished 缺失 = 未收尾
  "producer": { "tool": "tabcap", "version": "0.1.0", "daemon": "0.1.0", "extension": "0.1.0",
                "browser": { "name": "Chrome", "version": "155.0.8059.41", "userAgent": "…" }, "platform": "darwin-arm64" },
  "session": { "name": "range-s02", "site": "range-demo", "account": "demo", "proxy": "p1",   // 只记站点名、账号名和代理名（或 system / none），与本地库靠站点名关联
               "tabs": [ { "tab": "t1", "chromeTabId": 1234, "owned": true, "firstUrl": "…" } ] },
  "mode": { "capture": "mixed", "trace": false, "raw": true, "humanRecorder": true },
  // 0.4-F：开过追踪模式的包 "trace" 为 {"mechanism": ["fn-breakpoint", "instrumentation"], "apis": "sha256:<of the active signals.json>", "stack": 8, "firstN": 20, "maxHits": 500}（最后一次 trace start 的设置）
  // "traceWindows": [ { "fromSeq": 120, "toSeq": 388 } ],  // 每个开 / 关窗口一条，两端是开、关时写的 note 事件的 seq；开着时 toSeq 为 null；没开过追踪则无此字段
  "counts": { "events": 412, "requests": 97, "bodies": 91, "blobBytes": 18234567,
              "bodyMissing": { "redirect": 3, "not-modified": 2, "navigated": 1 } },
  "redaction": null,                               // 导出副本里是 {"rules": "default@1", "applied": 1760500950000, "salt": "<仅本地副本保留>"}
  "imported": null,                                // 或 {"from": "har", "creator": {"name": "WebInspector", "version": "537.36"}, "lossy": ["initiator", "timing.cdp"]}
  "notes": ""
}
```

## 8. 脱敏（导出时）

- 触发：`tabcap bundle export har` 默认开，`--no-redact` 关；`tabcap bundle redact <in> <out>` 生成脱敏副本。原包永不原地改。
- 规则来源：`redaction.json`（可改），默认规则：
  - 请求/响应头：`cookie`、`set-cookie`、`authorization`、`proxy-authorization`、`x-api-key`，以及名字含 `token` / `secret` / `session` / `auth` 的头。
  - query、表单、JSON 字段：名字含 `(token|secret|passw|session|sid|auth|api[-_]?key)`，或有一段正好是 `pass` / `pwd`（按非字母数字、驼峰、字母数字交界切段：`user_pass`、`userPass`、`login-pwd`、`Pwd2` 算，`bypass`、`passport`、`compass`、`passenger` 不算；规则 `default@2`，0.4 作者定）。
  - 值模式：18 位身份证、11 位手机号、邮箱、JWT（`xxx.yyy.zzz` 且 base64url）。
  - `state` 事件（cookies / storage）整体打码。
- 占位符：`«r:<类别>:<sha256(salt+值) 前 8 位>»`。同一个值在整包里映射到同一个占位符，所以 `diff` 的「会话值 / 常量」分类在脱敏副本上不变。salt 只存在本地原包的 `exports/<name>.salt`，不进副本。
- 脱敏后 `manifest.redaction` 记规则版本和时间；正文 blob 被改写的，哈希按新内容重算，`counts` 重算。
- **打码不等于安全**：响应正文里的自由文本（地址、姓名）靠规则抓不全，导出给别人前人要再看一眼。这句写进 README。

### 8.1 凭据：模型不见明文

探路由 AI 做，就要把作者给的登录信息交给工具而不是交给模型。凭据住在工具的本地库（`03` §5 `store`）：

- **载体**：`bun:sqlite` 单文件 `~/.config/tabcap/state.db`（定名后换目录名），权限 0600，守护进程启动时检查权限，不对就拒跑。明文存，暂不接系统钥匙串；README 写清楚这是 `~/.netrc` 一级的保护，能用测试账号就别用主账号。库永远不在仓库里、不在证据包目录里。零安装：SQLite 随 Bun 运行时和编译产物一起带【实测】。
- **表**：`sites`（名字、入口网址、域名列表、备注）、`accounts`（站点、用户名、密码、可选 TOTP 种子，默认空；0.4-D 加 `proxy`、`state`、`cool_until`、`last_used_at`、`fail_streak`）、`login_recipes`（P2）、`sessions`（P2：最近会话 cookie、保存时间、最后验证时间）、`guard_counters`（0.4-D 加账号维度）、`bundles`（证据包索引）、`proxies`（0.4-D：代理名、scheme、host、port、用户名、密码、bypass 与健康状态）。
- **录入只手动**：`tabcap site add example --url … --user …`，密码交互输入或 `--password-stdin`，不走命令行参数；扩展表单从当前标签预填入口网址（P2）。不在人手动登录时自动抓密码。
- **AI 看到的**：`tabcap site list` 给站点名、入口网址、账号名（不打码）。命令只写引用：`tabcap session start --site example`、`tabcap fill <ref> --secret example.password`。守护进程取值填入页面。
- **输出替换**：守护进程对所有 CLI 输出、日志、`snapshot` / `evaluate` / `read_page` 的文本结果，把库里已知的秘密值替换成 `<secret:example.password>`；`cmd.input`、`action.value` 里也只有引用。AI 即使故意 `evaluate` 读密码框，拿到的也是占位符。截图里密码框本来就是圆点。
- 页面把密码回显到请求里（登录 POST 的表单体）时，正文原样进包，这是事实不能改；导出时 §8 的规则按名字和值两路打码，值的来源包括库里的密码。本地原包默认 `0700` 且不进仓库。
- **代理凭据**（0.4-D）：代理密码只走 `--password-stdin` 或交互提示；替换表里每个代理有三种写法：密码本身、`user:pass@host:port`、`base64(user:pass)`（Chrome 把 `Proxy-Authorization: Basic …` 报在 `Network.requestWillBeSentExtraInfo` 里，录制器会写进 `raw/cdp.jsonl`），一律替换成 `<secret:proxy.<name>>`。录制器写 `raw/cdp.jsonl` 与 `events.jsonl` 时只替换代理凭据（站点密码仍按上一条原样留在登录请求里）。Chrome 只拿到 `host:port`，认证由守护进程在浏览器会话上用 `Fetch.enable {handleAuthRequests:true}` → `Fetch.authRequired` → `Fetch.continueWithAuth` 应答；这是插桩，开着时每条命令输出带 `fetchAuth:"on"`。
- manifest 记 `session.site`、`session.account`、`session.proxy`（0.4-D，名字），证据包与库之间只靠站点名关联。
- 验证：`06` §2 的「凭据不泄漏」检查、A2.9。

## 9. 与 HAR 互转

### 9.1 导出 `tabcap bundle export har <bundle> [--tab t1] [--types xhr,fetch,document] [--embed-events]`

| HAR 1.2 | 来源 |
|---|---|
| `log.creator` | `producer.tool` / `version` |
| `log.browser` | `producer.browser` |
| `log.pages[]` | `nav` 事件（只取 `frame:"root"` 且 `type:"navigation"\|"reload"\|"back_forward"`）；`id` = `n-<seq>`；`pageTimings` 从 `loadEvent`，没有填 `-1` |
| `log.entries[]` | `request` 事件（`outcome` 为 `finished` / `failed`，`incomplete` 默认不导出）；`pageref` = `nav` |
| `entry.startedDateTime` | `ts` → ISO 8601 |
| `entry.time` | `timing.end - timing.start` |
| `entry.request.headers/queryString/cookies/postData` | 从 `request.headers`、URL、`postData` 展开；`cookies` 从 `cookie` 头拆 |
| `entry.response.content` | `{size, mimeType, text, encoding:"base64"(二进制时), compression}`；`text` 是解压后的正文，和 DevTools 一致 |
| `entry.response.redirectURL` | 从 `location` 头 |
| `entry.cache` | `{}`；`fromCache` 写到 `_fromCache` |
| `entry.timings` | 从 `timing.cdp` 映射 `blocked/dns/connect/ssl/send/wait/receive`，缺的填 `-1` |
| `entry._webSocketMessages` | `ws` 事件，形状与 Chrome DevTools 相同：`{type:"send"\|"receive", time, opcode, data}` |
| 自定义字段（`_` 前缀，HAR 允许） | `_seq` `_id` `_tab` `_actor` `_cmd` `_nav` `_resourceType` `_initiator` `_bodyMissing` `_fromServiceWorker` `_protocol` |
| `log._events`（仅 `--embed-events`） | 整条 `events.jsonl` 原样数组，使「我们的包 → HAR → 我们的包」无损 |

默认丢弃并在命令输出里列出：`action`、`screenshot`、`state`、`finding`、`note`、`cmd`（除非 `--embed-events`）。

### 9.2 导入 `tabcap bundle import har <file> -o <bundle>`

- `entries` 按 `startedDateTime` 排序后分配 `seq`；`pages` → `nav`；`_webSocketMessages` → `ws`；有 `log._events` 就整体恢复。
- 正文：`content.text` 存在时，`encoding:"base64"` 先解码；若 `content-encoding` 头存在且字节像压缩流（gzip 魔数 / 尝试 br 解码成功），解压后存、`wireEncoding` 记原值；解不开就原样存并 `bodyMissing:null`、`body.decodeFailed:true`，让 `find` 的解码链再试。
- `manifest.imported` 记来源与 `lossy` 列表；`actor` 一律 `"human"`（外部包无法区分），`tab` 一律 `t1`。
- 验收用的来源：Chrome DevTools 导出、我们自己导出（往返）、mitmproxy `hardump`（若本机有）。Charles 没有样本就不承诺。

### 9.3 往返性质（写成测试）

1. 我们的包 → HAR（`--embed-events`）→ 包：`events.jsonl` 逐行相等（允许 `seq` 重编、浮点时间 1 ms 内）。
2. 我们的包 → HAR（默认）→ 包：每条 `request` 的 `method/url/status/headers/body 哈希` 相等。
3. DevTools 对靶场同一流程导出的 HAR → 包：`find` 命中集合与我们自己录的包相同。

## 10. 兼容与演进

- `format` 的主版本不同就拒读；同主版本内只加可选字段和新 `kind`。
- v0 → v1 的触发：P2 实现 `handoff` / `confirm` 时，或正文取法改成 `Fetch` 拦截时。
- 任何改动同步改 `fixtures/bundles/` 里的样例和 `06` 的测试。

## 11. 示意样例（合成的，以采集为准）

```
{"seq":1,"ts":1760500000000,"mono":null,"kind":"session","actor":"system","tab":null,"cmd":null,"phase":"start","name":"range-s02","mode":{"capture":"mixed","trace":false,"raw":true}}
{"seq":2,"ts":1760500000100,"mono":null,"kind":"tab","actor":"system","tab":"t1","cmd":null,"phase":"attach","chromeTabId":1234,"owned":true,"url":"http://127.0.0.1:4310/s02/a","reason":"borrowed"}
{"seq":3,"ts":1760500000150,"mono":88000.0,"kind":"nav","actor":"human","tab":"t1","cmd":null,"frame":"root","nav":"n-3","url":"http://127.0.0.1:4310/s02/a","from":null,"type":"navigation","loaderId":"L1","loadEvent":null}
{"seq":4,"ts":1760500000900,"mono":88750.2,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-4","type":"xhr","method":"GET","url":"http://127.0.0.1:4310/api/fast", "...":"…","outcome":"finished"}
{"seq":5,"ts":1760500001200,"mono":null,"kind":"action","actor":"human","tab":"t1","cmd":null,"op":"click","target":{"role":"link","name":"下一页","selector":"a#next"},"value":null,"phase":"done","trusted":true,"nav":"n-3"}
{"seq":6,"ts":1760500001210,"mono":89060.0,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-6","type":"fetch","method":"POST","url":"http://127.0.0.1:4310/api/before-leave","...":"…","outcome":"finished"}
{"seq":7,"ts":1760500001300,"mono":89150.0,"kind":"nav","actor":"human","tab":"t1","cmd":null,"frame":"root","nav":"n-7","url":"http://127.0.0.1:4310/s02/b","from":"http://127.0.0.1:4310/s02/a","type":"navigation","loaderId":"L2","loadEvent":null}
{"seq":8,"ts":1760500001350,"mono":89200.0,"kind":"request","actor":"human","tab":"t1","cmd":null,"nav":"n-3","id":"r-8","type":"xhr","method":"GET","url":"http://127.0.0.1:4310/api/slow","...":"…","outcome":"failed","error":{"text":"net::ERR_ABORTED","canceled":true}}
```

## 12. 决定记录（10-15 第二轮，作者：都按建议）

- **a** `raw/cdp.jsonl` 默认开。
- **b** 人工操作录制 P2；只在「人在操作」状态期间武装。
- **c** 单正文上限 32 MB。
- **d** `request` 一条写在完成时，靠 `raw/` 兜底。
- **e** 头用键小写的对象，多值数组。
- **f** `finding` 进 `events.jsonl`。
- **g** 定名后再改格式标识。
- **h** `sample` 是证据包 profile，不另立格式。
- **i** 凭据住工具本地库（`bun:sqlite`，`~/.config/<名>/state.db`，0600），账号名不打码，守护进程做输出替换，暂不接钥匙串（10-15 第四轮改，原 `secrets.toml` 方案作废）。

## 13. 格 1 裁决（10-15，针对实现时发现的歧义）

改规范、代码后续跟上的四条：
1. **HAR `pageref`**：`history` 类纪元里的请求，`pageref` 指向其前最近一个 root 的 `navigation` / `reload` / `back_forward` 纪元（即 HAR 真有的 page），不再指向 history 纪元本身。
2. **HAR `startedDateTime`**：用请求开始时刻，即 `ts - (mono - timing.start)`；`request` 事件的 `ts` 是完成时刻，不能直接当开始时间。
3. **HAR `timings`**：`blocked / dns / connect / ssl` 未知填 `-1`；`send / wait / receive` 按 HAR 1.2 必须 ≥ 0，未知填 `0`；`entry.time` 未知填 `-1`。
4. **导入已解压但仍带 `content-encoding` 头的正文**（DevTools 导出常见）：解压失败且字节是合法 UTF-8 文本时视为「已解压」，不标 `decodeFailed`，`wireEncoding` 仍记头里的原值；只有解压失败且像二进制时才标 `decodeFailed: true`。

按实现定案的：§7 示例里副本 manifest 不带 salt（§8 为准，§7 注释作废）；`body.base64` 表示「二进制正文，HAR 里用 base64」；HAR 无正文时按状态码推原因，其余 `unsupported` 并写 `detail`；导入时 `headersSource:"event"`、状态 0 视为失败、忽略 HAR 自带的 `_actor` / `_tab`；`_events` 恢复保留原 `seq`，lossy 列出 `blobs` 与 `manifest`；`counts.bodies` 为带正文 blob 的请求数、`blobBytes` 为去重后总字节；脱敏占位符的类别按值类型（jwt / email / cnid / mobile / secret）而不是按位置，保证同值同占位符；cookie 逐值打码保留名字，authorization 保留方案名；脱敏副本不含 `raw/` 与 `exports/`；`ws` 只有 `frame` 进 `_webSocketMessages`；`dropped` 列出所有未进 HAR 的 kind；`events.jsonl` 只在关闭时 fsync（进程崩溃不丢，断电可能丢最后 100 ms）。可编辑的 `redaction.json` 与 `knownSecrets` 接 `store` 留到后续格。

## 14. 格 3 裁决（10-15）

- **文档响应扣留（采纳）**：只靠 Fetch 拦截，点击处理器里发出再立刻跳转的请求 6 次丢 4 次，因为 `requestPaused` 和新文档提交在同一毫秒【实测】。录制器对主框架文档的响应最多扣留 50 ms，等旧文档里尚未取到正文的 XHR / fetch 取完再放行，之后 10/10 救回。代价是这种情况下导航最多慢 50 ms；`net start` 的输出注明拦截已开。§5.2 第 8 条以此为准。
- **没收到任何响应就被导航打断的请求**（代码待改）：`response` 仍为对象，`status: null`、`headers: {}`、`body: null`、`bodyMissing: {reason: "navigated"}`，不再允许 `response: null`。
- **Fetch 救回但 Network 未给响应的请求**（采纳实现）：`outcome: "incomplete"`，`response` 用 Fetch 拿到的状态行和头并标 `fromFetch: true`，另加 `bodySource: "fetch"`。
- **`cmd` 事件**（代码待改）：改为两条，命令开始时写 `{kind:"cmd", id:"c-<seq>", phase:"start", argv, input}`，结束时写 `{kind:"cmd", phase:"end", ref:"c-<seq>", ok, error, durationMs, outputSummary}`；命令窗口内的事件 `cmd` 字段引用开始那条的 id。
- **`nav` 编号**（代码待改）：`navigate` 在录制中时返回包内的 `n-<seq>`，未录制时返回 null；守护进程不再维护另一套全局编号。
- 其余按实现定案：录制开始时标签已在某页则补写 `initial: true` 的 nav；`navigate` 对不存在的会话自动建会话；`raw/cdp.jsonl` 默认开；密码遮罩最小版（已知值在信封和 `cmd` 事件里替换，登录 POST 体原样进包）。

## 15. 0.2 裁决（10-15，A 录制侧 / B 分析侧）

按实现定案：
- **ws 帧 id**：`r-<握手 seq>:<帧 seq>`，`net body` 与 `finding.evidence` 的 `{ws, frame}` 都用它。控制帧（opcode 非 1 / 2）只进 `raw/`，不写 `ws` 事件；`close` / `error` 事件不带 direction / opcode / payload。内联的二进制帧 `inline` 存 CDP 的 base64 原样（与 HAR `_webSocketMessages` 一致），blob 一律存真实字节。
- **console**：行列号从 1 起；`--level X` 表示该级及更严重；`ts` 取 `Runtime.Timestamp`；4 KB 按 UTF-8 字节截断；只有异常带 stack。
- **`cmd` 对**：`fill` / `type` 的 `argv` 与 `input.text` 放在 end 事件（密码判定要等工具看过字段，避免密码进包）；`net start` 自己的 start 事件补写在工具执行后；录制被命令停止时由录制器在 session stop 前写 end；start 事件的 `cmd` 等于自身 id。
- **`response` 永不为 null**：失败、stopped、detached 同样写 `{status:null, headers:{}, body:null, bodyMissing:{reason}}`。
- **`diff` 的 `constant-or-session`**：同一 session 内的常量，若参数在 cookie 里、或取值等于同包某个 ≥ 8 字符的 cookie / set-cookie 值、或形似 token（≥ 16 字符且字母数字混合），记为 `constant-or-session`；是否单 session 按分组内样本判断。session 身份取 `manifest.session.name`，空则取 manifest id。
- **时间戳窗口**：分类器用 ±5 min；`05` s06 写的「< 5 s」是靶场数据自身的性质，不是分类阈值。
- **导入包的解码链**：`manifest.imported` 存在时，`wireEncoding` 作为链前缀（DevTools 已解压的正文也一样）；自录的包链为 `[]`。
- **`find --save` 的 grade**：有命中记「实测」，0 命中记「推断」，actor 固定 `ai`；未收尾的包拒绝 `--save`。
- **`finding.evidence`** 的联合类型加 `{console: seq}`。
- **looks-signature** 按字面：hex 或 base64 字符集且长度 32 / 40 / 64 / 128，与 looks-random 互斥。

代码待改（排进 0.2-C）：
1. `types.ts` 的 `CmdEvent` 改为 start / end 两种形状；`reader.ts` 不再把 `status:null` 读成 0；HAR 导出对 `cmd` 对与 `console` 的处理（列入 dropped）。
2. 熵阈值按长度分档：≥ 1 KiB 用 7.3 bit/字节，256 B 到 1 KiB 用 7.0，低于 256 B 不判。
3. `finding.evidence` 类型补 `{console}`。

## 16. 0.2-D 裁决（10-15，来自真实站点试用报告）

- **`actor` 的默认值**：`direct` 模式下人只在交接时刻介入，所以一切事件默认 `actor:"ai"`；只有 `handoff` 进入「人在操作」状态期间才标 `human`。此前「命令窗口外即 human」的规则作废，它把 AI `navigate` 带出的后续请求错标成了 human。`ext` 模式接管用户自己的 Chrome 时再引入时间窗判定。
- **`net wait` 的回看窗口**：默认回看到最近一条**动作类**命令（navigate / click / fill / type / press / go / reload / evaluate）的开始时刻，跳过只读命令（wait / snapshot / find / screenshot / console / net list / tabs）；另加 `--since <c-id>|start` 指定起点、`--fresh` 只等新的。超时的 `next` 要列出「更早已完成的匹配」。
- **包内文件权限**：`events.jsonl`、`manifest.json`、`blobs/` 一律 0600，目录 0700，与 `raw/` 一致。
- **弹窗归属**：opener 是本会话 owned 标签的弹窗也算 owned；`session stop` 关掉它们；借来的仍不关。

## 17. 0.2-D 裁决（10-15）

按实现定案：`net list --failed` 表示只看失败项，`--all` 看全部，默认隐藏失败与 `data:`；`--since c-N` 与 `net wait` 回看都以请求写入包的时刻为基准；录制中动作命令的输出带 `cmd` 字段；新增错误码 `needs-await`；`net list` / `console list` 从最早开始分页：不给分页参数时返回第 0 页、每页 100（还有下一页时带 `nextPageIdx`），`--page-size 0` 返回全部（0.4 作者定）；`net show` 的 initiator 行列号从 1 起，包内保持 CDP 原始从 0 起，script 类发起者从调用栈顶帧补 url / 行 / 列；`find.ref` 仍是最近带 ref 的祖先，该点的是 `clickable`；还前台的判据是「每条命令结束后读到的最前应用」。
代码待改：`timing.responseStart` 可能晚于 `end`（两个时间戳来源不同），录制器统一到 CDP 单调时钟；HAR 导出文件改 0600；`type` 对当前焦点元素补 `isConnected` 检查。

## 18. 0.3-A 裁决（10-15）

作者定：外部处理程序给出答案后会话直接恢复，答案作为不可信数据交给 AI；每次调用进证据包并计入该站点 guard 计数，按站点配置「处理后仍需人确认」留待后续。
按实现定案：登录尝试在 `fill --secret ...password` 时计数、按会话实例计、`--confirm` 的那次也计；`waiting` 用失败信封（`ok:false`，退出码 1），命令执行期间撞上则本条直接返回 `waiting` 并把原结果放 `error.result`；只拦 AI 的操作命令，不拦页面自己的请求；`raw/cdp.jsonl` 里同一登录 POST 的原始行是明文的第二处，与 `raw/` 的 0600 一致；`session stop` 不清 `waiting`，只有 `handoff continue` 清；处理程序命令组叫 `plugin`，启用列表 `plugins/enabled.json`，目录组或他人可写则拒用；密码少于 3 字符不做替换，`site add` 对少于 8 字符的密码告警；站点名 `[A-Za-z0-9_-]{1,64}`；识别规则目前只有「录制中的 HTML 403」，其余形态按范围规则等靶场场景。

## 19. 0.3-C 裁决（10-15）

按实现定案：`state` 快照在录制开始、每次根框架 `navigation` 提交、录制结束各一条（`reload` / `back_forward` 不取；`about:blank` 也写，origin 为 null）；先 `net start` 后 `navigate` 的会话第一条就是 nav 那条；`store.sessions` 只在 `session stop` 与人执行 `handoff continue` 时写，处理程序自动恢复不写；库中 ≥ 8 字符的 cookie 值视为秘密，替换成 `<secret:站点.cookie.名>`；`responseStart` 取 ResourceTiming 的 `receiveHeadersEnd` 并夹在 `[start, end]`，旧包不回填；`type` 在焦点回到不可编辑的 `<body>` 时也报 `stale-ref`；salt 文件 0600；截图失败或纯色时走焦点仿真重截，`screenshot` 命令同样适用，页面会短暂变 visible。
待作者定：页面从不读取响应体的请求（Chrome 不发 `loadingFinished`）目前只能在 stop 时收尾为 `incomplete`，录制中对 `net list` / `net wait` / guard 不可见。提案：`responseReceived` 后 1 s 仍无 `loadingFinished` 且 Fetch 已取得全文，则写成 `outcome:"finished"`、`end:null`、`bodySource:"fetch"`、`unreadByPage:true`。
作者定（10-15）：照提案采纳，已并入 §5.2 第 9 条，0.3-E 实现。

## 20. 0.3-E 裁决（10-15）

按实现定案：`--trusted` 的降级只有「确认不了绘制」一种，元素无盒子仍报 `page`；散布只有代码开关；`type --trusted` 不做绘制确认，只靠每条 5 s 超时；`--delay` 指两个字符之间的间隔；默认 `type` 与 `--insert` 都标 `eventShape:"insert"`；`unreadByPage` 只在 1 s 时查一次；这类 `finished` 请求进 HAR 时 `time` 为 -1（HAR 1.2 未规定负值，沿用现有约定）；升格的探针页去掉了指纹与 CDP 探针段，只保留输入事件记录。

## 21. 0.4-F 按实现定案（10-16，待作者审）

追踪模式实现时按字面解的几处：`trace start` 不要求在录制，未录制时只在内存里计数（`trace status` 可见），`signal` 只写进正在录的包，输出带 warning；`net start` 时追踪已开则这份包从此开一个窗口；`firstN` 按 (api, 调用位置 url:line:col) 跨文档计「带栈的事件」条数（不是每文档每次命中）；一条事件只有一个 `stack`（首次命中的栈）；`get` / `call` 的 `args` 为 null（函数调用断点的暂停里拿不到原生函数的实参），只有 `event` 有 `args`；worker 不读 `value`；`window.devicePixelRatio` 在 CfT 155 上是全局对象自有的访问器、原型链上没有，按「else skip and say so」跳过，`trace status` 的 `skipped` 写明原因；窗口两端用 `note` 事件的 seq；`trace list` 的 `--api` 精确匹配、`--script` 子串匹配；`trace start` 自己的输出带那句提示（即「trace start 之后的第一条输出」），`trace status` 也带。
